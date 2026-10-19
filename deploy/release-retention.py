#!/usr/bin/env python3
"""Dedicated AI-MINE host: retain releases, prune only unused build cache. Dry-run by default."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request
from release_changelog import retry_pending

APP_NAMES = {"/amp-web-1", "/amp-public-api-1", "/amp-private-api-1", "/amp-worker-1"}
UNIFIED_APP_NAMES = {"/amp-web-1", "/amp-api-1", "/amp-worker-1"}
REPOS = {"amp-app", "amp-release", "amp-rollback", "amp-retained"}
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
SOCKET = "unix:///var/run/docker.sock"


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


def current_release(containers, now):
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
        if not item or not item["running"] or now - stamp(item["started"]) < 600:
            raise RuntimeError("Services have not been running steadily for ten minutes; keep everything")
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


def backup_references(root):
    """Read image identity metadata only; a release directory contains its predecessor."""
    root = Path(root)
    references, blocked = {}, []
    if root.is_symlink() or not root.is_dir():
        return references, ["Backup directory unavailable; recovery references unknown"]
    for directory in sorted(root.iterdir()):
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
    resolved = {}
    for image in set(references.values()):
        try:
            canonical = docker("image", "inspect", "--format", "{{.Id}}", image)
            if not IMAGE_ID.fullmatch(canonical):
                raise RuntimeError("Invalid canonical image identity")
            resolved[image] = canonical
        except (subprocess.CalledProcessError, RuntimeError):
            blocked.append(f"Backup image cannot be resolved: {image}")
    return {path: resolved.get(image, image) for path, image in references.items()}, blocked


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
    protected |= {key for key, x in images.items() if "amp-app:latest" in (x["tags"] or [])}
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


def execute(args):
    now = time.time()
    state_path = Path(args.state_dir) / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    containers, images = inventory()
    managed = provenance(images, state.get("managed_images", {}))
    backups, blocked = backup_references(args.backup_dir)
    result = plan(containers, images, state.get("history", []), args.seed, now, managed, backups.values())
    result["backup_references"] = backups
    result["release"] = health()
    if blocked:
        print(json.dumps({"status": "blocked", "reasons": blocked, **result}), flush=True)
        raise RuntimeError("Backup image references must be resolved before cleanup")
    if args.apply:
        retry_pending("/opt/aimine", result["release"])
    quality_pending = quality_blockers(result["release"])
    if quality_pending:
        print(json.dumps({"status": "blocked", "reasons": quality_pending, **result}), flush=True)
        return
    if args.automatic and state.get("history", [None])[0] == result["current"] and now - state.get("cleaned_at", 0) < 86400 and managed == state.get("managed_images", {}):
        print(json.dumps({"status": "unchanged", "release": result["release"]}))
        return
    result["before_used_bytes"] = shutil.disk_usage("/").used
    print(json.dumps({"mode": "apply" if args.apply else "dry-run", **result}), flush=True)
    if not args.apply:
        return
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Persist the newly observed healthy release BEFORE removing any older release.
    for image in result["history"]:
        docker("image", "tag", image, "amp-retained:" + image[7:19])
    save(state_path, {**state, "history": result["history"], "managed_images": managed, "cleaned_at": 0})
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
        with open("/opt/aimine/.ops/release.lock", "a") as lock:
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
