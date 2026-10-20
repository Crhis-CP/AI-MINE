#!/usr/bin/env python3
"""Prepare a constrained release without deleting images, database recovery points or business files."""
import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess

FLOOR = 4 * 1024**3


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def identity(path):
    item = path.lstat()
    return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
            stat.S_IMODE(item.st_mode), item.st_uid, item.st_gid)


def program_plan(root):
    groups, read_bytes = {}, 0
    for directory in sorted(root.iterdir()):
        if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r"release-[a-f0-9]{12}(?:-[A-Za-z0-9]+)?", directory.name):
            continue
        for path in sorted(directory.glob("*-program.tar.gz")):
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 256 * 1024**2:
                continue
            read_bytes += info.st_size
            if read_bytes > 8 * 1024**3:
                raise ValueError("Program hashing bound exceeded")
            observed = identity(path)
            sha = digest(path)
            if identity(path) != observed:
                raise ValueError("Program archive changed during inspection")
            key = (sha, info.st_dev, info.st_size, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
            groups.setdefault(key, []).append((path, observed, info.st_blocks * 512))
    aliases, reclaimable = [], 0
    for key, entries in groups.items():
        first, observed, _ = entries[0]
        seen = {observed[:2]}
        for target, target_observed, blocks in entries[1:]:
            if target_observed[:2] == observed[:2]:
                continue
            aliases.append({"source": str(first), "target": str(target), "sha256": key[0],
                            "source_identity": list(observed), "target_identity": list(target_observed)})
            if target_observed[:2] not in seen:
                seen.add(target_observed[:2])
                reclaimable += blocks
    return {"read_bytes": read_bytes, "reclaimable_bytes": reclaimable, "aliases": aliases}


def compact(plan):
    changed = []
    for entry in plan["aliases"]:
        source, target = Path(entry["source"]), Path(entry["target"])
        if identity(source) != tuple(entry["source_identity"]) or identity(target) != tuple(entry["target_identity"]):
            raise ValueError("Archive identity changed before compaction")
        if digest(source) != entry["sha256"] or digest(target) != entry["sha256"]:
            raise ValueError("Archive bytes changed before compaction")
        temporary = target.with_name(target.name + f".compact-{os.getpid()}")
        try:
            os.link(source, temporary, follow_symlinks=False)
            if identity(temporary)[:2] != tuple(entry["source_identity"][:2]):
                raise ValueError("Archive link identity changed")
            os.replace(temporary, target)
            if digest(target) != entry["sha256"]:
                raise ValueError("Archive digest changed after compaction")
            changed.append(str(target))
        finally:
            temporary.unlink(missing_ok=True)
    return changed


def command(*args):
    return subprocess.check_output(args, text=True, timeout=180).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--record", type=Path, required=True)
    parser.add_argument("--lock-fd", type=int, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    lock = args.root / ".ops/release.lock"
    if lock.is_symlink() or os.fstat(args.lock_fd).st_ino != lock.stat().st_ino or os.fstat(args.lock_fd).st_dev != lock.stat().st_dev:
        raise ValueError("The existing release lock must be inherited")
    fcntl.flock(args.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    spec = importlib.util.spec_from_file_location("retention", Path(__file__).with_name("release-retention.py"))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    result = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "applied": False,
              "before_available_bytes": os.statvfs(args.root).f_bavail * os.statvfs(args.root).f_frsize}
    try:
        if result["before_available_bytes"] >= FLOOR:
            result["status"] = "already_sufficient"
        else:
            release = policy.health()
            backups, blocked = policy.backup_references(args.backup_root)
            if blocked:
                raise ValueError("Recovery references are incomplete")
            containers = command("docker", "ps", "-aq").split()
            images = set(command("docker", "inspect", "--format", "{{.Image}}", *containers).split()) if containers else set()
            images.update(backups.values())
            for image in images:
                if command("docker", "image", "inspect", "--format", "{{.Id}}", image) != image:
                    raise ValueError("A referenced recovery image is unavailable")
            result["programs"] = program_plan(args.backup_root)
            result["protected_images"] = sorted(images)
            if args.apply:
                result["compacted"] = compact(result["programs"])
                result["cache"] = command("docker", "builder", "prune", "--all", "--force",
                                          "--filter", "until=24h", "--keep-storage", "512MB")[-2000:]
                for image in images:
                    if command("docker", "image", "inspect", "--format", "{{.Id}}", image) != image:
                        raise ValueError("Referenced image changed during preparation")
                if policy.health() != release:
                    raise ValueError("Running release changed during preparation")
                result["applied"] = True
            result["status"] = "prepared" if args.apply else "planned"
        result["after_available_bytes"] = os.statvfs(args.root).f_bavail * os.statvfs(args.root).f_frsize
        result["released_bytes"] = result["after_available_bytes"] - result["before_available_bytes"]
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        with args.record.open("x") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
    print(json.dumps({key: value for key, value in result.items() if key != "programs"}, indent=2))


if __name__ == "__main__":
    main()
