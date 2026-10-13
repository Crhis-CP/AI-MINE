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
    apps = [x for x in containers if x["name"] in APP_NAMES]
    if {x["name"] for x in apps} != APP_NAMES or len({x["image"] for x in apps}) != 1:
        raise RuntimeError("Application services missing or on mixed images; keep everything")
    for service in [*APP_NAMES, "/amp-db-1", "/amp-caddy-1"]:
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


def plan(containers, images, previous, seeds, now):
    current = current_release(containers, now)
    history = list(dict.fromkeys([current, *previous, *seeds]))[:3]
    if len(history) < 2 or any(not IMAGE_ID.fullmatch(x) or x not in images for x in history):
        raise RuntimeError("Current and rollback images must exist before cleanup")
    protected = set(history) | {x["image"] for x in containers}
    protected |= {key for key, x in images.items() if "amp-app:latest" in (x["tags"] or [])}
    candidates = []
    for key, item in images.items():
        tags = item["tags"] or []
        managed = tags and all(t.split(":", 1)[0] in REPOS for t in tags)
        if managed and key not in protected and now - stamp(item["created"]) >= 86400:
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
    result = plan(containers, images, state.get("history", []), args.seed, now)
    result["release"] = health()
    if args.apply:
        retry_pending("/opt/aimine", result["release"])
    if args.automatic and state.get("history", [None])[0] == result["current"] and now - state.get("cleaned_at", 0) < 86400:
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
    save(state_path, {**state, "history": result["history"]})
    failures = []
    removed = []
    for item in result["candidates"]:
        live, fresh_images = inventory()
        fresh = plan(live, fresh_images, result["history"], [], time.time())
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
    # This command concerns BUILD CACHE ONLY. No image/system/container/volume prune.
    # Active cache and image layers still referenced by retained images remain protected by Docker.
    fresh, _ = inventory()
    if current_release(fresh, time.time()) != result["current"]:
        raise RuntimeError("Release changed before cache cleanup")
    cache = docker("builder", "prune", "--all", "--force", "--filter", "until=24h", "--keep-storage", "2GB")
    result.update(removed=removed, failures=failures, cache=cache[-2000:], after_used_bytes=shutil.disk_usage("/").used)
    fresh, final_images = inventory()
    if current_release(fresh, time.time()) != result["current"] or health() != result["release"]:
        raise RuntimeError("Post-cleanup service observation changed")
    if any(image not in final_images for image in result["history"]):
        raise RuntimeError("Retained image is missing")
    save(state_path.parent / "last-result.json", result)
    if failures:
        raise RuntimeError("Some old image tags could not be removed; retained for retry")
    save(state_path, {"history": result["history"], "cleaned_at": now})
    print(json.dumps({"status": "cleaned", **result}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--automatic", action="store_true")
    parser.add_argument("--seed", action="append", default=[], help="Initial exact rollback image ID (up to two)")
    parser.add_argument("--state-dir", default="/var/lib/aimine-maintenance")
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
