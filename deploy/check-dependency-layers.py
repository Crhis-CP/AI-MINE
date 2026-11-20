#!/usr/bin/env python3
"""Compare production dependency layers from two independent verified CI manifests."""
import argparse
import json
import subprocess
from pathlib import Path


def layer(manifest):
    sha = manifest["source"]["sha"]
    def source(path):
        return subprocess.check_output(["git", "--no-replace-objects", "show", f"{sha}:{path}"])
    instructions = source("Dockerfile").decode().split("FROM base\n")[-1].splitlines()
    layers = [s for s in instructions if s.startswith(("COPY ", "ADD ", "RUN "))]
    if not layers or layers.count("COPY --from=production-dependencies --chown=node:node /app /app") != 1:
        raise ValueError("Unrecognized runtime dependency COPY")
    slot = layers.index("COPY --from=production-dependencies --chown=node:node /app /app") - len(layers)
    return source("package-lock.json"), manifest["image"]["rootfs_layers"][slot]


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("manifests", nargs=2, type=Path)
    first, second = (json.loads(f.read_text()) for f in p.parse_args().manifests)
    if first["workflow"] == second["workflow"]:
        p.error("Two independent CI builds are required")
    left, right = layer(first), layer(second)
    print("first", left[1], "second", right[1])
    if left != right:
        p.error("Lockfile bytes or production dependency layer digest differ")
    print("Same lockfile and production dependency layer")
