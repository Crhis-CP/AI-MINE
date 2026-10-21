#!/usr/bin/env python3
"""Dedicated AI-MINE host: retain releases, prune only unused build cache. Dry-run by default."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import urllib.request
from release_changelog import retry_pending
from recovery_bindings import RecoveryBindings

APP_NAMES = {"/amp-web-1", "/amp-public-api-1", "/amp-private-api-1", "/amp-worker-1"}
UNIFIED_APP_NAMES = {"/amp-web-1", "/amp-api-1", "/amp-worker-1"}
REPOS = {"amp-app", "amp-release", "amp-rollback", "amp-retained"}
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
SOCKET = "unix:///var/run/docker.sock"
OPS = Path("/opt/aimine/.ops")


def docker(*args):
    return subprocess.check_output(
        ["docker", "--host", SOCKET, *args], text=True, timeout=600,
        env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"},
    ).strip()


def stamp(value):
    # Docker emits nanoseconds; datetime accepts and truncates them to microseconds.
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def inventory():
    ids = docker("ps", "-aq").split()
    fmt = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"running":{{json .State.Running}},"started":{{json .State.StartedAt}}}'
    containers = [json.loads(x) for x in docker("inspect", "--format", fmt, *ids).splitlines()] if ids else []
    # Docker 29/containerd can expose a container's config digest while image ls uses
    # the manifest digest. Resolve through Docker before comparing retention identities.
    canonical = {value: docker("image", "inspect", "--format", "{{.Id}}", value) for value in {x["image"] for x in containers}}
    for item in containers:
        item["image"] = canonical[item["image"]]
    ids = sorted(set(docker("image", "ls", "-aq", "--no-trunc").split()) | {c["image"] for c in containers})
    fmt = '{"id":{{json .Id}},"created":{{json .Created}},"tags":{{json .RepoTags}}}'
    images = [json.loads(x) for x in docker("image", "inspect", "--format", fmt, *ids).splitlines()] if ids else []
    return containers, {x["id"]: x for x in images}


def current_release(containers, now, minimum_uptime=600):
    running = {x["name"] for x in containers if x["running"] and x["name"] in APP_NAMES | UNIFIED_APP_NAMES}
    if running == UNIFIED_APP_NAMES:
        expected = UNIFIED_APP_NAMES
    elif running == APP_NAMES:
        expected = APP_NAMES
    else:
        raise RuntimeError("Application topology incomplete or mixed; keep everything")
    apps = [x for x in containers if x["name"] in expected]
    if len({x["image"] for x in apps}) != 1:
        raise RuntimeError("Application services missing or on mixed images; keep everything")
    for service in [*expected, "/amp-db-1", "/amp-caddy-1"]:
        item = next((x for x in containers if x["name"] == service), None)
        if not item or not item["running"] or now - stamp(item["started"]) < minimum_uptime:
            raise RuntimeError("Services are not running steadily for the required interval; keep everything")
    return apps[0]["image"]


def health():
    request = urllib.request.Request("http://127.0.0.1:3000/api/health", headers={"Host": "aiminingpolicy.com"})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        data = json.loads(response.read(4096))
    if data.get("ok") is not True or data.get("db") != "ok":
        raise RuntimeError("Health check failed; keep everything")
    return data.get("release")


def managed_tags(tags):
    return isinstance(tags, list) and bool(tags) and all(isinstance(t, str) and t.split(":", 1)[0] in REPOS for t in tags)


def provenance(images, recorded):
    """Remember exact owned identities before untagging; never adopt arbitrary dangling images."""
    if not isinstance(recorded, dict) or any(not IMAGE_ID.fullmatch(key) or not managed_tags(tags) for key, tags in recorded.items()):
        raise RuntimeError("Invalid managed image provenance; keep everything")
    observed = dict(recorded)
    for key, item in images.items():
        if managed_tags(item["tags"]):
            observed[key] = sorted(set([*observed.get(key, []), *item["tags"]]))
    return observed


def program_references(directory):
    path = directory / "manifest.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("Program snapshot manifest unavailable")
    data = json.loads(path.read_text())
    identities = {key: data[key] for key in ["current_image", "runtime_manifest"]}
    if any(not IMAGE_ID.fullmatch(image) for image in identities.values()):
        raise ValueError("Program snapshot image identity invalid")
    # These checks establish the mapping only. The manifest's export_verified flag
    # is not an isolated restore receipt, and no backup payload is removed here.
    archive = directory / "current-image.oci.tar"
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size == 0:
        raise ValueError("Program snapshot runtime export unavailable")
    overlays = data["program_overlays"]
    names = {"/" + item["container"] for item in overlays}
    if names not in [APP_NAMES, UNIFIED_APP_NAMES] or len(overlays) != len(names):
        raise ValueError("Program snapshot overlay topology incomplete")
    for item in overlays:
        if item["archive"] != item["container"] + "-program.tar.gz" or not re.fullmatch("[0-9a-f]{64}", item["sha256"]):
            raise ValueError("Program snapshot overlay mapping invalid")
        archive = directory / item["archive"]
        if archive.is_symlink() or not archive.is_file() or not isinstance(item["bytes"], int) or item["bytes"] <= 0 or archive.stat().st_size != item["bytes"]:
            raise ValueError("Program snapshot overlay unavailable")
        identities[f"overlay/{item['archive']}"] = data["current_image"]
    return {f"{directory.name}/manifest.json#{key}": image for key, image in identities.items()}


def backup_references(root, excluded=()):
    """Read image identity metadata only; a release directory contains its predecessor."""
    root = Path(root)
    references, blocked = {}, []
    if root.is_symlink() or not root.is_dir():
        return references, ["Backup directory unavailable; recovery references unknown"]
    for directory in sorted(root.iterdir()):
        if directory.name in excluded:
            continue
        if not directory.is_dir() and not directory.is_symlink():
            continue
        if not directory.is_symlink() and directory.name.startswith("program-retention-"):
            try:
                references.update(program_references(directory))
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                blocked.append(f"Unmapped or incomplete program snapshot: {directory.name}")
            continue
        if directory.is_symlink() or not directory.name.startswith("release-"):
            blocked.append(f"Unmapped backup directory: {directory.name}")
            continue
        for name in ["previous-image.txt", "candidate-image.txt"]:
            path = directory / name
            if name == "candidate-image.txt" and not path.exists() and not path.is_symlink():
                continue  # A release can fail before it builds a candidate.
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 128:
                blocked.append(f"Missing or invalid image reference: {directory.name}/{name}")
                continue
            image = path.read_text().strip()
            if not IMAGE_ID.fullmatch(image):
                blocked.append(f"Invalid image identity: {directory.name}/{name}")
                continue
            references[str(path.relative_to(root))] = image
    resolved, direct = {}, {}
    recovery = RecoveryBindings(root, lambda image: docker("image", "inspect", "--format", "{{.Id}}", image))
    for reference, image in references.items():
        try:
            canonical = direct.get(image) or docker("image", "inspect", "--format", "{{.Id}}", image)
            if not IMAGE_ID.fullmatch(canonical):
                raise RuntimeError("Invalid canonical image identity")
            direct[image] = canonical
            resolved[reference] = canonical
        except (subprocess.CalledProcessError, RuntimeError):
            try:
                name = Path(reference).name
                if name == "previous-image.txt":
                    resolved[reference] = recovery.resolve(image, Path(reference).parent.name)
                elif name == "candidate-image.txt":
                    resolved[reference] = recovery.resolve_candidate(image)
                else:
                    raise ValueError("Program snapshots require their original OCI object")
            except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.CalledProcessError):
                blocked.append(f"Backup image cannot be resolved: {reference}: {image}")
    return {path: resolved.get(path, image) for path, image in references.items()}, blocked



def file_signature(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Non-regular recovery file: " + path.name)
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def completed_recovery(directory):
    """Only the existing successful release format; never inspect environment contents."""
    match = re.fullmatch(r"release-([a-f0-9]{12})(?:-[A-Za-z0-9]+)?", directory.name)
    if not match or directory.is_symlink() or not directory.is_dir():
        raise ValueError("Unmapped recovery directory")
    files = {p.name: file_signature(p) for p in directory.iterdir()}
    metadata_names = {"previous-image.txt", "candidate-image.txt", "previous-health.json", "health.json",
                      "backup-sha256.txt", "database-restore-list.txt", "previous-api-services.txt",
                      "disk-before.txt", "disk-after.txt", "previous-quality-gate.json", "recovery-point.json",
                      "persistent-files-list.txt", "resource-samples.jsonl"}
    metadata = {}
    for name in files.keys() & metadata_names:
        if files[name][2] > 16 * 1024 * 1024:
            raise ValueError("Recovery metadata too large: " + name)
        with os.fdopen(os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW), "r") as stream:
            metadata[name] = stream.read()
    previous, candidate = (metadata[name].strip() for name in ("previous-image.txt", "candidate-image.txt"))
    if not all(IMAGE_ID.fullmatch(value) for value in (previous, candidate)):
        raise ValueError("Invalid recovery image identity")
    old, healthy = (json.loads(metadata[name]) for name in ("previous-health.json", "health.json"))
    if any(x.get("ok") is not True or x.get("db") != "ok" for x in (old, healthy)) or healthy.get("release") != match[1]:
        raise ValueError("Release was not successfully observed; keep failed attempts")
    if not re.fullmatch(r"[a-f0-9]{7,40}", old.get("release", "")):
        raise ValueError("Predecessor release unavailable")
    programs = {name for name in files if name.endswith("-program.tar.gz")}
    roles = programs - {"host-program.tar.gz"}
    if roles not in [{"api-program.tar.gz", "web-program.tar.gz", "worker-program.tar.gz"},
                     {"public-api-program.tar.gz", "private-api-program.tar.gz", "web-program.tar.gz", "worker-program.tar.gz"}]:
        raise ValueError("Incomplete predecessor programs")
    payloads = programs | {"database.dump"}
    if "host-program.tar.gz" not in programs or not files.get("environment", [0, 0, 0])[2] or not metadata.get("database-restore-list.txt", "").strip():
        raise ValueError("Incomplete host/database recovery point")
    if "persistent-files.tar.gz" in files:
        payloads.add("persistent-files.tar.gz")
        if "persistent-files-list.txt" not in metadata:
            raise ValueError("Persistent file inventory missing")
    if files.keys() - payloads - metadata_names - {"environment", "environment-before-model-vault"}:
        raise ValueError("Unknown recovery contents; keep for review")
    hashes = {}
    for line in metadata["backup-sha256.txt"].splitlines():
        digest, filename = line.split("  ", 1)
        item = Path(filename)
        if item.parent != directory or item.name in hashes or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Unmapped or duplicate backup checksum")
        hashes[item.name] = digest
    if set(hashes) != payloads:
        raise ValueError("Backup checksum inventory incomplete")
    backup_time_ns, time_basis = files["database.dump"][3], "database.dump.mtime"
    if "recovery-point.json" in metadata:
        point = json.loads(metadata["recovery-point.json"])
        declared = point.get("files", [])
        if (point.get("version") != 1 or point.get("previous_image") != previous or
                point.get("previous_release") != old["release"] or
                not re.fullmatch(match[1] + r"[a-f0-9]{28}", point.get("attempted_release", "")) or
                "persistent-files.tar.gz" not in payloads or len(declared) != len(payloads) or
                {x["file"] for x in declared} != payloads or any(
                    x["sha256"] != hashes[x["file"]] or x["bytes"] != files[x["file"]][2] for x in declared)):
            raise ValueError("Recovery point/database/persistent files disagree")
        recorded_at = point.get("created_at", point.get("at"))
        if recorded_at is not None:
            if not isinstance(recorded_at, str):
                raise ValueError("Recovery timestamp is invalid")
            completed_at = dt.datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
            if completed_at.utcoffset() is None:
                raise ValueError("Recovery timestamp has no timezone")
            backup_time_ns, time_basis = int(completed_at.timestamp() * 1_000_000_000), "recovery-point.timestamp"
    for name in payloads:
        if not files.get(name, [0, 0, 0])[2]:
            raise ValueError("Empty recovery archive")
        with os.fdopen(os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != hashes[name]:
            raise ValueError("Recovery archive checksum mismatch: " + name)
    if files != {p.name: file_signature(p) for p in directory.iterdir()}:
        raise ValueError("Recovery point changed during validation")
    canonical = docker("image", "inspect", "--format", "{{.Id}}", previous)
    if not IMAGE_ID.fullmatch(canonical):
        raise ValueError("Predecessor image is not mapped")
    return {"directory": directory.name, "previous_image": previous, "resolved_previous_image": canonical,
            "candidate_image": candidate, "backup_time_ns": backup_time_ns, "backup_time_basis": time_basis,
            "files": files, "metadata": metadata}


def recovery_window(root, history):
    root = Path(root).absolute()
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Backup root unavailable")
    completed, uncertain = [], []
    names = sorted(p.name for p in root.iterdir())
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() and not directory.is_symlink():
            continue
        try:
            point = completed_recovery(directory)
            completed.append(point)
        except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
            uncertain.append({"directory": directory.name, "reason": str(error)})
    keep = []
    for image in history[1:]:
        matches = [point for point in completed if point["resolved_previous_image"] == image]
        if not matches:
            raise ValueError("Necessary rollback recovery point missing or incomplete: " + image)
        # Only compare dates after proving the same predecessor and complete matching recovery files.
        keep.append(max(matches, key=lambda point: (point["backup_time_ns"], point["files"]["database.dump"][3], point["directory"])))
    selected = {point["directory"] for point in keep}
    return {"root_entries": names, "keep": keep, "remove": [point for point in completed if point["directory"] not in selected],
            "retained_uncertain": uncertain}


def recheck_recovery_window(root, window):
    root = Path(root).absolute()
    if root.is_symlink() or sorted(p.name for p in root.iterdir()) != window["root_entries"]:
        raise RuntimeError("Recovery inventory changed; no backup removed")
    # Validate the entire planned set before the first deletion, including both required rollbacks.
    for point in [*window["keep"], *window["remove"]]:
        directory = root / point["directory"]
        if directory.is_symlink() or {p.name: file_signature(p) for p in directory.iterdir()} != point["files"]:
            raise RuntimeError("Recovery point changed; no backup removed")


def remove_expired_recovery(root, window, evidence_path):
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError("Safe directory removal is unavailable")
    recheck_recovery_window(root, window)
    evidence = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "plan": window, "removed": []}
    save(evidence_path, evidence)  # Metadata proof survives deletion; environment contents are never copied.
    for point in window["remove"]:
        try:
            shutil.rmtree(Path(root) / point["directory"])
        except OSError as error:
            evidence["failure"] = {"directory": point["directory"], "reason": str(error)}
            save(evidence_path, evidence)
            raise
        evidence["removed"].append(point["directory"])
        save(evidence_path, evidence)
    return evidence["removed"]

def quality_blockers(release, path="/opt/aimine/.ops/release-quality-gate.json"):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        return ["Quality acceptance record missing or invalid"]
    try:
        gate = json.loads(path.read_text())
        sha = gate.get("sha", "")
        if gate.get("status") != "accepted":
            return ["Current release quality acceptance is pending"]
        if not re.fullmatch("[0-9a-f]{40}", sha) or not isinstance(release, str) or not re.fullmatch("[0-9a-f]{7,40}", release) or not sha.startswith(release):
            return ["Quality acceptance does not match the running release"]
        stamp(gate["at"])
    except (ValueError, TypeError, AttributeError, KeyError):
        return ["Quality acceptance record invalid"]
    return []


def plan(containers, images, previous, seeds, now, managed=None, backup_images=()):
    current = current_release(containers, now)
    history = list(dict.fromkeys([current, *previous, *seeds]))[:3]
    if len(history) != 3 or any(not IMAGE_ID.fullmatch(x) or x not in images for x in history):
        raise RuntimeError("Current and two rollback images must exist before cleanup")
    protected = set(history) | {x["image"] for x in containers} | set(backup_images)
    candidates = []
    for key, item in images.items():
        tags = item["tags"] or []
        owned = managed_tags(tags) or (not tags and key in (managed or {}))
        if owned and key not in protected and now - stamp(item["created"]) >= 86400:
            candidates.append({"id": key, "tags": tags})
    return {"current": current, "history": history, "protected": sorted(protected), "candidates": candidates}


def save(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temp, path)


def observe_current(state_path, *, apply=False, expected_image=None, expected_release=None):
    """Record a healthy running identity; apply callers must hold the existing release lock.

    Observation does not grant cleanup: the plan still requires ten stable minutes, both
    rollback images and complete recovery points, and execute requires quality acceptance.
    """
    state_path = Path(state_path)
    if state_path.is_symlink() or (state_path.exists() and not state_path.is_file()):
        raise RuntimeError("Maintenance state is not a regular file")
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if not isinstance(state, dict):
        raise RuntimeError("Invalid maintenance state")
    previous = state.get("history", [])
    if not isinstance(previous, list) or any(not isinstance(value, str) or not IMAGE_ID.fullmatch(value) for value in previous):
        raise RuntimeError("Invalid observed release history")
    containers, images = inventory()
    current = current_release(containers, time.time(), minimum_uptime=0)
    release = health()
    if current not in images or not IMAGE_ID.fullmatch(current) or not isinstance(release, str) or not re.fullmatch(r"[a-f0-9]{7,40}", release):
        raise RuntimeError("Healthy running release identity unavailable")
    if (expected_image is not None and current != expected_image) or (expected_release is not None and release != expected_release):
        raise RuntimeError("Running predecessor changed before history observation")
    history = list(dict.fromkeys([current, *previous]))[:3]
    managed = provenance(images, state.get("managed_images", {}))
    observed = {**state, "history": history, "managed_images": managed}
    if history != previous or managed != state.get("managed_images", {}):
        observed["cleaned_at"] = 0
    if apply and observed != state:
        state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        save(state_path, observed)
    return observed, containers, images, release


def execute(args):
    now = time.time()
    state_path = Path(args.state_dir) / "state.json"
    state, containers, images, release = observe_current(state_path, apply=args.apply)
    managed = state["managed_images"]
    result = {"current": state["history"][0], "history": state["history"], "release": release}
    if args.apply:
        retry_pending("/opt/aimine", result["release"])
    quality_pending = quality_blockers(result["release"])
    if quality_pending:
        print(json.dumps({"status": "blocked", "reasons": quality_pending, **result}), flush=True)
        return
    result.update(plan(containers, images, state["history"], args.seed, now, managed))
    if args.automatic and state.get("history", [None])[0] == result["current"] and now - state.get("cleaned_at", 0) < 86400 and managed == state.get("managed_images", {}):
        print(json.dumps({"status": "unchanged", "release": result["release"]}))
        return
    window = recovery_window(args.backup_dir, result["history"])
    backups, blocked = backup_references(args.backup_dir, {point["directory"] for point in window["remove"]})
    if blocked:
        print(json.dumps({"status": "blocked", "reasons": blocked, "retained_uncertain": window["retained_uncertain"]}), flush=True)
        raise RuntimeError("Retained backup image references must be resolved before cleanup")
    result.update(plan(containers, images, state.get("history", []), args.seed, now, managed, backups.values()))
    result["backup_references"] = backups
    result["recovery_window"] = window
    result["before_used_bytes"] = shutil.disk_usage("/").used
    print(json.dumps({"mode": "apply" if args.apply else "dry-run", **result}), flush=True)
    if not args.apply:
        return
    # All destructive work starts only after a complete plan and a second live observation.
    fresh, fresh_images = inventory()
    if (current_release(fresh, time.time()) != result["current"] or health() != result["release"] or quality_blockers(result["release"]) or
            any(image not in fresh_images for image in {*result["history"], *backups.values()})):
        raise RuntimeError("Release/quality/recovery images changed before cleanup")
    recheck_recovery_window(args.backup_dir, window)
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Persist the newly observed healthy release BEFORE removing any older release.
    for image in result["history"]:
        docker("image", "tag", image, "amp-retained:" + image[7:19])
    save(state_path, {**state, "history": result["history"], "managed_images": managed, "cleaned_at": 0})
    evidence_path = OPS / ("backup-retention-" + str(time.time_ns()) + ".json") if window["remove"] else None
    result["removed_recovery_directories"] = remove_expired_recovery(args.backup_dir, window, evidence_path) if evidence_path else []
    result["recovery_evidence"] = str(evidence_path) if evidence_path else None
    failures = []
    removed = []
    for item in result["candidates"]:
        live, fresh_images = inventory()
        backups, blocked = backup_references(args.backup_dir)
        if blocked:
            raise RuntimeError("Backup image references changed during cleanup")
        fresh = plan(live, fresh_images, result["history"], [], time.time(), managed, backups.values())
        if fresh["current"] != result["current"]:
            raise RuntimeError("Release changed during cleanup; stopped without touching containers")
        if item["id"] not in {x["id"] for x in fresh["candidates"]}:
            continue
        for tag in item["tags"]:
            # Never remove a tag that was moved to a different staged release.
            if docker("image", "inspect", "--format", "{{.Id}}", tag) != item["id"]:
                raise RuntimeError("Image tag changed during cleanup")
            try:
                docker("image", "rm", "--no-prune", tag)
                removed.append(tag)
            except subprocess.CalledProcessError:
                failures.append(tag)
        # Removing a tag can leave an owned dangling object. Recheck its identity,
        # tags and references; Docker still refuses container/child references.
        live, fresh_images = inventory()
        backups, blocked = backup_references(args.backup_dir)
        if blocked:
            raise RuntimeError("Backup image references changed before owned image cleanup")
        fresh = plan(live, fresh_images, result["history"], [], time.time(), managed, backups.values())
        if fresh["current"] != result["current"]:
            raise RuntimeError("Release changed before owned image cleanup")
        if any(x["id"] == item["id"] and not x["tags"] for x in fresh["candidates"]):
            try:
                docker("image", "rm", "--no-prune", item["id"])
                removed.append(item["id"])
            except subprocess.CalledProcessError:
                failures.append(item["id"])
    # This command concerns BUILD CACHE ONLY. No image/system/container/volume prune.
    # Active cache and image layers still referenced by retained images remain protected by Docker.
    fresh, _ = inventory()
    _, blocked = backup_references(args.backup_dir)
    if blocked:
        raise RuntimeError("Backup image references changed before cache cleanup")
    if current_release(fresh, time.time()) != result["current"]:
        raise RuntimeError("Release changed before cache cleanup")
    cache = docker("builder", "prune", "--all", "--force", "--filter", "until=24h", "--keep-storage", "2GB")
    result.update(removed=removed, failures=failures, cache=cache[-2000:], after_used_bytes=shutil.disk_usage("/").used)
    fresh, final_images = inventory()
    if current_release(fresh, time.time()) != result["current"] or health() != result["release"]:
        raise RuntimeError("Post-cleanup service observation changed")
    if any(image not in final_images for image in result["history"]):
        raise RuntimeError("Retained image is missing")
    # A successful CLI response is not evidence that a manifest object disappeared.
    failures.extend(image for image in removed if IMAGE_ID.fullmatch(image) and image in final_images)
    save(state_path.parent / "last-result.json", result)
    if failures:
        raise RuntimeError("Some old image references could not be removed; retained for retry")
    save(state_path, {**state, "history": result["history"], "managed_images": managed, "cleaned_at": now})
    print(json.dumps({"status": "cleaned", **result}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--automatic", action="store_true")
    parser.add_argument("--seed", action="append", default=[], help="Initial exact rollback image ID (up to two)")
    parser.add_argument("--state-dir", default="/var/lib/aimine-maintenance")
    parser.add_argument("--backup-dir", default="/opt/aimine-backup")
    args = parser.parse_args()
    if args.apply:
        # Same lock used by production release operations. Never hold the app's database locks.
        with os.fdopen(os.open(OPS / "release.lock", os.O_RDWR | os.O_NOFOLLOW), "r+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('{"status":"deferred","reason":"release_lock_busy"}')
                return
            execute(args)
    else:
        execute(args)


if __name__ == "__main__":
    main()
