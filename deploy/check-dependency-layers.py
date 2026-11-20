#!/usr/bin/env python3
"""Compare dependency layers, or all layers other than source and web output, from independent CI builds."""
import argparse
import json
import subprocess
from pathlib import Path

DEPENDENCIES = "COPY --from=production-dependencies --chown=node:node /app /app"
SOURCE = "COPY --chown=node:node . ."
WEB_BUILD = "COPY --from=build --chown=node:node /app/apps/web/build /app/apps/web/build"


def layers(manifest):
    sha = manifest["source"]["sha"]

    def source(path):
        return subprocess.check_output(["git", "--no-replace-objects", "show", f"{sha}:{path}"])

    runtime = source("Dockerfile").decode().split("FROM base\n")[-1].splitlines()
    changes = [s for s in runtime if s.startswith(("COPY ", "ADD ", "RUN "))]
    ids = manifest["image"]["rootfs_layers"]
    if len(ids) < len(changes) or any(changes.count(s) != 1 for s in (DEPENDENCIES, SOURCE, WEB_BUILD)):
        raise ValueError("Unrecognized runtime layer layout")
    start = len(ids) - len(changes)
    app = {start + changes.index(name) for name in (SOURCE, WEB_BUILD)}
    stable = {i: value for i, value in enumerate(ids) if i not in app}
    return source("package-lock.json"), ids[start + changes.index(DEPENDENCIES)], stable


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--all-stable", action="store_true", help="also compare the base image, installed tools and runtime directories")
    p.add_argument("manifests", nargs=2, type=Path)
    args = p.parse_args()
    first, second = (json.loads(f.read_text()) for f in args.manifests)
    if first["workflow"] == second["workflow"]:
        p.error("Two independent CI builds are required")
    left, right = layers(first), layers(second)
    print("first", left[1], "second", right[1])
    if left[:2] != right[:2]:
        p.error("Lockfile bytes or production dependency layer digest differ")
    print("Same lockfile and production dependency layer")
    if args.all_stable:
        if left[2] != right[2]:
            mismatch = [i for i in sorted(left[2].keys() | right[2].keys()) if left[2].get(i) != right[2].get(i)]
            p.error(f"Stable layer digest or position differs at {mismatch}")
        print(f"All {len(left[2])} stable layers match, excluding only the source and web build layers")
