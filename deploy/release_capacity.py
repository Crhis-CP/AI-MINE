#!/usr/bin/env python3
"""Read-only release admission estimates and one-second resource observations."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import time

GIB = 1024 ** 3
DISK_FLOOR = 4 * GIB
RESERVE = GIB


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def filesystem(path):
    stat, space = path.stat(), os.statvfs(path)
    return {"path": str(path), "device": str(stat.st_dev), "total_bytes": space.f_blocks * space.f_frsize,
            "free_bytes": space.f_bfree * space.f_frsize, "available_bytes": space.f_bavail * space.f_frsize,
            "inodes_total": space.f_files, "inodes_available": space.f_favail}


def memory_available():
    match = re.search(r"^MemAvailable:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M)
    if not match:
        raise ValueError("MemAvailable unavailable")
    return int(match[1]) * 1024


def latest_backup(root):
    candidates = []
    for directory in root.iterdir():
        if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r"release-[a-f0-9]{12}(?:-[0-9]{8}T[0-9]{15})?", directory.name):
            continue
        dump, hashes = directory / "database.dump", directory / "backup-sha256.txt"
        if all(path.is_file() and not path.is_symlink() and path.stat().st_size for path in (dump, hashes)):
            candidates.append(dump)
    if not candidates:
        raise ValueError("No completed release backup size sample; capacity remains unknown")
    dump = max(candidates, key=lambda path: path.stat().st_mtime_ns)
    programs = [path for path in dump.parent.glob("*-program.tar.gz") if path.is_file() and not path.is_symlink()]
    if not programs:
        raise ValueError("Previous program archive sizes unavailable")
    unique = {(path.stat().st_dev, path.stat().st_ino): path.stat() for path in programs}
    return {"path": str(dump.parent), "dump_bytes": dump.stat().st_size,
            "persistent_bytes": (dump.parent / "persistent-files.tar.gz").stat().st_size if (dump.parent / "persistent-files.tar.gz").is_file() else 0,
            "dump_modified_at": dt.datetime.fromtimestamp(dump.stat().st_mtime, dt.timezone.utc).isoformat(),
            "program_named_bytes": sum(path.stat().st_size for path in programs),
            "program_unique_allocated_bytes": sum(stat.st_blocks * 512 for stat in unique.values()),
            "basis": "Previous completed files provide size estimates, not a new dump bound or restore proof"}


def evaluate(manifest, previous, observed, phase):
    image, source = manifest["image"], manifest["source"]
    values = [image[key] for key in ("tar_bytes", "layer_blob_bytes", "layer_tar_bytes")] + [source["tar_bytes"], previous["dump_bytes"], previous["program_named_bytes"]]
    if any(type(value) is not int or value <= 0 for value in values):
        raise ValueError("Positive measured artifact and backup sizes required")
    root_device, backup_device = (observed[key]["device"] for key in ("root", "backup"))
    # No shared-layer discount is claimed. Docker import needs live measurements;
    # these alternative layout estimates are not added together as observed usage.
    retained_image = image["layer_blob_bytes"] + image["layer_tar_bytes"]
    dump, program = ((previous[key] * 5 + 3) // 4 for key in ("dump_bytes", "program_named_bytes"))
    if type(previous.get("persistent_bytes", 0)) is not int or previous.get("persistent_bytes", 0) < 0:
        raise ValueError("Nonnegative measured persistent size required")
    persistent = (previous.get("persistent_bytes", 0) * 5 + 3) // 4
    stages = {}

    def stage(name, contributions):
        totals = {}
        for device, size in contributions:
            totals[device] = totals.get(device, 0) + size
        stages[name] = totals

    if phase == "before_import":
        stage("image_import", [(root_device, source["tar_bytes"] + max(image["tar_bytes"], retained_image))])
        stage("backup_and_source_stage", [(root_device, retained_image + 2 * source["tar_bytes"]), (backup_device, dump + program + persistent)])
    else:
        stage("database_and_source_switch", [(backup_device, dump + persistent), (root_device, source["tar_bytes"])])
    devices = {}
    for sample in (observed["root"], observed["backup"]):
        item = devices.setdefault(sample["device"], {**sample, "paths": []})
        item["paths"].append(sample["path"])
        item["available_bytes"] = min(item["available_bytes"], sample["available_bytes"])
        item["inodes_available"] = min(item["inodes_available"], sample["inodes_available"])
    checks = [{"name": "memory_available", "actual": observed["memory_available_bytes"], "required": GIB,
               "passed": observed["memory_available_bytes"] >= GIB}]
    for device, sample in devices.items():
        peak = max(stage.get(device, 0) for stage in stages.values())
        floor = DISK_FLOOR if phase == "before_import" and device == root_device else 0
        required = max(floor, peak + RESERVE)
        sample.update({"estimated_peak_additional_bytes": peak, "reserve_bytes": RESERVE, "required_available_bytes": required})
        inode_floor = max(1024, sample["inodes_total"] // 100)
        checks.extend([{"name": "disk_available", "device": device, "actual": sample["available_bytes"], "required": required,
                        "passed": sample["available_bytes"] >= required},
                       {"name": "inodes_available", "device": device, "actual": sample["inodes_available"], "required": inode_floor,
                        "passed": sample["inodes_available"] >= inode_floor}])
    return {"passed": all(check["passed"] for check in checks), "checks": checks, "filesystems": list(devices.values()),
            "stage_estimates": stages, "dump_estimate_bytes": dump, "program_estimate_bytes": program, "persistent_estimate_bytes": persistent,
            "assumptions": ["Docker and release source staging use the observed root filesystem",
                            "Previous compressed dump and named program sizes receive 25% planning allowance; this is not a measured growth rate",
                            "Source staging and its possible target copy are budgeted together before import",
                            "Input gzip files are already on disk; shared layers are not claimed as additional measured usage",
                            "Before-backup sampling occurs after image import, staging extraction and program archives; only the new dump and possible target source copy remain",
                            "One GiB remains outside the estimated peak; estimates cannot prove actual Docker, WAL or future dump peaks"]}


def preflight(root, backup_root, manifest_file, record, phase, persistent_bytes=0):
    result = {"version": 1, "kind": "release_preflight", "at": now(), "phase": phase, "passed": False,
              "command": {"root": str(root), "backup_root": str(backup_root), "manifest": str(manifest_file)}}
    try:
        raw = manifest_file.read_bytes()
        manifest = json.loads(raw)
        result["input"] = {"manifest_sha256": hashlib.sha256(raw).hexdigest(), "sha": manifest["source"]["sha"], "tree": manifest["source"]["tree"]}
        result["observed"] = {"root": filesystem(root), "backup": filesystem(backup_root), "memory_available_bytes": memory_available()}
        result["previous_backup"] = latest_backup(backup_root)
        result["previous_backup"]["persistent_bytes"] = max(persistent_bytes, result["previous_backup"]["persistent_bytes"])
        result.update(evaluate(manifest, result["previous_backup"], result["observed"], phase))
    except (OSError, ValueError, KeyError, TypeError) as error:
        result["error"] = str(error)
    with record.open("x") as output:
        os.chmod(record, 0o600)
        output.write(json.dumps(result, indent=2) + "\n")
    return result


def monitor(root, output, parent):
    if parent <= 1:
        raise ValueError("Release parent PID required")
    identity = Path(f"/proc/{parent}/stat")
    started = identity.read_text().rsplit(")", 1)[1].split()[19]
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with output.open("x", buffering=1) as stream:
        os.chmod(output, 0o600)
        while running:
            try:
                if identity.read_text().rsplit(")", 1)[1].split()[19] != started:
                    break
            except FileNotFoundError:
                break
            stream.write(json.dumps({"at": now(), "filesystem": filesystem(root), "memory_available_bytes": memory_available()}) + "\n")
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    before = commands.add_parser("preflight")
    before.add_argument("--root", type=Path, required=True)
    before.add_argument("--backup-root", type=Path, required=True)
    before.add_argument("--manifest", type=Path, required=True)
    before.add_argument("--record", type=Path, required=True)
    before.add_argument("--phase", choices=["before_import", "before_backup"], default="before_import")
    before.add_argument("--persistent-bytes", type=int, default=0)
    watch = commands.add_parser("monitor")
    watch.add_argument("--root", type=Path, required=True)
    watch.add_argument("--output", type=Path, required=True)
    watch.add_argument("--parent", type=int, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "monitor":
        monitor(args.root, args.output, args.parent)
        return 0
    result = preflight(args.root, args.backup_root, args.manifest, args.record, args.phase, args.persistent_bytes)
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
