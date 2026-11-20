#!/usr/bin/env python3
"""Server-side preparation and validation of a resumable rsync into a candidate-only directory."""
import argparse
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from release_artifact import FILES, encode_image, file_info, require, verify_bundle
from release_capacity import DISK_FLOOR

ROOT = Path("/opt/aimine")
STAGE = Path("/opt/aimine-release-stage")


def active_release():
    cmd = ["docker", "exec", "amp-web-1", "node", "-e",
           "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(d=>{if(!d.ok||d.db!=='ok')process.exit(1);console.log(d.release)})"]
    release = subprocess.check_output(cmd, text=True, timeout=30).strip()
    require(re.fullmatch("[a-f0-9]{12}", release), "Cannot identify the healthy current release")
    return release


def basis_for(active, explicit):
    candidates = [explicit] if explicit else [p.parent for mask in ("channel-*/files/release-manifest.json", "*/release-manifest.json") for p in STAGE.glob(mask)]
    for folder in candidates:
        if folder and folder.is_dir() and not folder.is_symlink() and (folder / "release-manifest.json").is_file():
            manifest = json.loads((folder / "release-manifest.json").read_text())
            if manifest["source"]["sha"][:12] == active:
                require(file_info(folder / FILES["image"])["sha256"] == manifest["image"]["sha256"], "Current image archive checksum mismatch")
                return folder, manifest["image"]
    raise ValueError("Current verified bundle missing; supply its existing directory with AIMINE_BASIS_DIR")


def prepare(directory, active, args):
    prior, image = basis_for(active, args.basis)
    source = prior / FILES["image"]
    payload = directory / "files"
    basis = directory / "basis"
    previous = directory / "previous"
    directory.mkdir(mode=0o700, exist_ok=True)
    require(not directory.is_symlink() and not payload.is_symlink() and not basis.is_symlink(), "Invalid staging directory")
    if previous.exists():
        require(previous.read_text() == active, "Running release changed since preparation")
    else:
        with previous.open("x") as out:
            out.write(active)
    for part in (basis, payload):
        part.mkdir(mode=0o700, exist_ok=True)
    archived = basis / FILES["image"]
    temp_bytes = 0 if archived.exists() else image["tar_bytes"]
    require(shutil.disk_usage(directory).free >= DISK_FLOOR + 2 * args.bytes + temp_bytes, "Insufficient space for delta and reserve")
    if not archived.exists():
        if image.get("encoding") == "gzip-per-member-v1":
            os.link(source, archived)
        else:
            with tempfile.NamedTemporaryFile(dir=basis) as out:
                encode_image(lambda: gzip.open(source, "rb"), out, image["tar_bytes"])
                out.flush()
                os.link(out.name, archived)
    print("Delta basis verified for " + active)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["prepare", "verify"])
    parser.add_argument("sha")
    parser.add_argument("tree")
    parser.add_argument("manifest")
    parser.add_argument("bytes", type=int)
    parser.add_argument("--basis", type=Path)
    args = parser.parse_args()
    require(all(re.fullmatch("[a-f0-9]{40}", x) for x in (args.sha, args.tree))
            and re.fullmatch("[a-f0-9]{64}", args.manifest) and args.bytes > 0, "Invalid release identities")
    stage = STAGE / ("channel-" + args.sha)
    with os.fdopen(os.open(ROOT / ".ops/release.lock", os.O_RDWR | os.O_NOFOLLOW), "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        active = active_release()
        require(active != args.sha[:12], "Requested release is already active")
        if args.phase == "prepare":
            prepare(stage, active, args)
        else:
            require((stage / "previous").read_text() == active, "Running release changed during transfer")
            verify_bundle(stage / "files", args.sha, args.tree, args.manifest)
            require(shutil.disk_usage(stage).free >= DISK_FLOOR, "Disk reserve below 7.5 GiB")
            # Only the working copy created by prepare; the active bundle remains untouched.
            (stage / "basis" / FILES["image"]).unlink(missing_ok=True)
            print("Verified all four transferred release files")


if __name__ == "__main__":
    main()
