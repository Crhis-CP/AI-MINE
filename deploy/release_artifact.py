#!/usr/bin/env python3
"""Export the exact image exercised by make verify; hashes bind bytes, not signatures."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import threading

ROOT = Path(__file__).resolve().parent.parent
SOCKET = "unix:///var/run/docker.sock"
FILES = {"source": "source.tar.gz", "image": "image.tar.gz", "receipt": "verify-receipt.json"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(stream):
    value, size = hashlib.sha256(), 0
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(block)
        size += len(block)
    return value.hexdigest(), size


def file_info(path):
    require(path.is_file() and not path.is_symlink(), f"Expected regular file: {path.name}")
    with path.open("rb") as stream:
        sha256, size = digest(stream)
    return {"file": path.name, "sha256": sha256, "bytes": size}


def command(args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=600).strip()


def image_info(image_id):
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id), "Immutable image ID required")
    require(not os.environ.get("DOCKER_HOST") or os.environ["DOCKER_HOST"] == SOCKET, "Only local Docker is allowed")
    require(os.environ.get("DOCKER_CONTEXT", "default") == "default", "Only local Docker is allowed")
    result = json.loads(command(["docker", "--host", SOCKET, "image", "inspect", image_id]))
    require(len(result) == 1 and re.fullmatch(r"sha256:[a-f0-9]{64}", result[0]["Id"]), "Loaded image identity unavailable")
    return result[0]


def validate_receipt(receipt, sha, tree, image_id=None):
    require(re.fullmatch(r"[a-f0-9]{40}", sha) and re.fullmatch(r"[a-f0-9]{40}", tree), "Exact source identities required")
    require(receipt.get("receipt_version") == 1 and receipt.get("command") == "make verify", "Unknown verify receipt")
    require(receipt.get("scope") == "full" and receipt.get("exit_status") == 0 and receipt.get("failed_stage") is None, "Full successful verification required")
    git = receipt.get("git", {})
    require(git.get("sha") == sha and git.get("tree") == tree, "Receipt source mismatch")
    require(git.get("tracked_and_untracked_clean_at_start") is True and git.get("tracked_and_untracked_clean_at_end") is True, "Clean verification required")
    stages = receipt.get("stages", [])
    require(stages and all(stage.get("status") == "pass" for stage in stages), "All verification stages must pass")
    require(any(stage.get("name") == "compose-smoke" for stage in stages), "Docker verification required")
    require(receipt.get("secret_scan") and receipt.get("audit"), "Supply-chain sections required")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", receipt.get("log_digest", "")), "Log digest required")
    rehearsal = receipt.get("local_rehearsal", {})
    normal = rehearsal.get("normalImage", "")
    require(rehearsal.get("accepted") is True and rehearsal.get("boundToInput") is True and rehearsal.get("source") == sha, "Bound recovery rehearsal required")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", normal) and (image_id is None or image_id == normal), "Receipt image mismatch")
    return normal


def archive_layers(path, image):
    """Measure saved layer encoding and expanded tar bytes without filesystem extraction."""
    with tarfile.open(path, "r:") as archive:
        entries = json.load(archive.extractfile("manifest.json"))
        require(len(entries) == 1, "Export must contain exactly one image")
        entry = entries[0]
        config = archive.extractfile(entry["Config"]).read()
        config_id = "sha256:" + hashlib.sha256(config).hexdigest()
        if config_id != image["Id"]:
            descriptor = archive.extractfile("blobs/sha256/" + image["Id"].removeprefix("sha256:")).read(1024 * 1024 + 1)
            require(len(descriptor) <= 1024 * 1024 and "sha256:" + hashlib.sha256(descriptor).hexdigest() == image["Id"], "Saved canonical image manifest mismatch")
            require(json.loads(descriptor).get("config", {}).get("digest") == config_id, "Saved canonical manifest config mismatch")
        diff_ids = json.loads(config)["rootfs"]["diff_ids"]
        require(diff_ids == image["RootFS"]["Layers"] and len(diff_ids) == len(entry["Layers"]), "Saved layer inventory mismatch")
        encoded = expanded = 0
        for name, expected in zip(entry["Layers"], diff_ids):
            member = archive.getmember(name)
            require(member.isfile(), "Saved layer must be a regular file")
            encoded += member.size
            with archive.extractfile(member) as stream:
                prefix = stream.read(4)
                stream.seek(0)
                require(prefix != b"\x28\xb5\x2f\xfd", "Unsupported zstd layer; expansion must be measured")
                decoded = gzip.GzipFile(fileobj=stream) if prefix[:2] == b"\x1f\x8b" else stream
                actual, size = digest(decoded)
                require("sha256:" + actual == expected, "Saved layer content mismatch")
                expanded += size
    return {"tar_bytes": path.stat().st_size, "layer_blob_bytes": encoded, "layer_tar_bytes": expanded,
            "config_id": config_id, "rootfs_layers": diff_ids}


def exported_config(image_id, config_id):
    """Docker 29 can return a manifest ID for a config alias. Read its actual config without a disk copy."""
    process = subprocess.Popen(["docker", "--host", SOCKET, "image", "save", image_id], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    timer = threading.Timer(120, process.kill)
    timer.start()
    manifest, config, config_name = None, None, None
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                if not member.isfile() or not (member.name.endswith(".json") or member.name.startswith("blobs/sha256/")):
                    continue
                if member.size > 1024 * 1024:
                    require(member.name != "manifest.json", "Oversized saved image manifest")
                    continue
                data = archive.extractfile(member).read()
                if member.name == "manifest.json":
                    require(manifest is None, "Duplicate saved image manifest")
                    manifest = json.loads(data)
                elif "sha256:" + hashlib.sha256(data).hexdigest() == config_id:
                    require(config is None, "Duplicate saved image config")
                    config, config_name = data, member.name
        # Continue consuming any tar padding so docker save can finish normally.
        while process.stdout.read(1024 * 1024):
            pass
        require(process.wait(timeout=10) == 0, "Docker config export failed")
        require(manifest and len(manifest) == 1 and config is not None and manifest[0]["Config"] == config_name, "Saved image does not reference the expected config")
        return config
    finally:
        timer.cancel()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)


def saved_oci_manifest(directory, expected):
    """Resolve only the unique manifest in the same byte-verified OCI image export."""
    path = directory / FILES["image"]
    require(expected.get("file") == FILES["image"] and path.is_file() and not path.is_symlink(), "Expected verified image archive")
    limit = 1024 * 1024
    media_type = "application/vnd.oci.image.manifest.v1+json"
    def unique(pairs):
        value = dict(pairs)
        require(len(value) == len(pairs), "Ambiguous OCI metadata fields")
        return value
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        before = os.fstat(stream.fileno())
        actual_hash, actual_size = digest(stream)
        require(actual_hash == expected.get("sha256") and actual_size == expected.get("bytes"), "Artifact bytes changed: image.tar.gz")
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r:gz") as archive:
            members = archive.getmembers()
            def metadata(name):
                matches = [member for member in members if member.name == name]
                require(len(matches) == 1 and matches[0].isfile() and 0 < matches[0].size <= limit,
                        "Missing, duplicate or unsafe OCI metadata: " + name)
                return archive.extractfile(matches[0]).read(limit + 1)
            index = json.loads(metadata("index.json"), object_pairs_hook=unique)
            require(isinstance(index, dict) and index.get("schemaVersion") == 2 and
                    index.get("mediaType", "application/vnd.oci.image.index.v1+json") == "application/vnd.oci.image.index.v1+json" and
                    isinstance(index.get("manifests"), list) and len(index["manifests"]) == 1,
                    "OCI export must contain exactly one manifest descriptor")
            descriptor = index["manifests"][0]
            require(isinstance(descriptor, dict) and descriptor.get("mediaType") == media_type and
                    isinstance(descriptor.get("digest"), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", descriptor["digest"]) and
                    type(descriptor.get("size")) is int and 0 < descriptor["size"] <= limit,
                    "Unsupported or nested OCI descriptor")
            raw = metadata("blobs/sha256/" + descriptor["digest"][7:])
            require(len(raw) == descriptor["size"] and "sha256:" + hashlib.sha256(raw).hexdigest() == descriptor["digest"],
                    "OCI manifest digest or size mismatch")
            manifest = json.loads(raw, object_pairs_hook=unique)
            require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 2 and manifest.get("mediaType") == media_type and
                    "manifests" not in manifest and isinstance(manifest.get("config"), dict) and
                    manifest["config"].get("digest") == expected["config_id"], "OCI manifest config mismatch")
            after = os.fstat(stream.fileno())
            require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "Image archive changed during inspection")
            return descriptor["digest"]


def loaded_image(directory, manifest_sha256):
    path = directory / "release-manifest.json"
    require(file_info(path)["sha256"] == manifest_sha256, "Manifest hash mismatch")
    manifest = json.loads(path.read_text())
    expected = manifest["image"]
    try:
        image = image_info(expected["config_id"])
    except subprocess.CalledProcessError:
        image = image_info(saved_oci_manifest(directory, expected))
    require(image["Os"] == expected["os"] and image["Architecture"] == expected["architecture"], "Loaded image platform mismatch")
    require(image["RootFS"]["Layers"] == expected["rootfs_layers"], "Loaded image layer inventory mismatch")
    if image["Id"] != expected["config_id"]:
        config = exported_config(image["Id"], expected["config_id"])
        require("sha256:" + hashlib.sha256(config).hexdigest() == expected["config_id"], "Loaded image config mismatch")
        require(json.loads(config)["rootfs"]["diff_ids"] == expected["rootfs_layers"], "Loaded config layer inventory mismatch")
    return image["Id"]


def verify_bundle(directory, sha, tree, manifest_sha256):
    require(re.fullmatch(r"[a-f0-9]{64}", manifest_sha256), "Externally checked manifest hash required")
    manifest_file = directory / "release-manifest.json"
    require(file_info(manifest_file)["sha256"] == manifest_sha256, "Manifest hash mismatch")
    manifest = json.loads(manifest_file.read_text())
    require(manifest.get("version") == 1, "Unknown artifact manifest")
    for key, name in FILES.items():
        require(manifest[key].get("file") == name, "Unexpected artifact path")
        actual = file_info(directory / name)
        require(all(manifest[key].get(field) == value for field, value in actual.items()), f"Artifact bytes changed: {name}")
    source, image = manifest["source"], manifest["image"]
    require(source.get("sha") == sha and source.get("tree") == tree, "Artifact source mismatch")
    require(image.get("os") == "linux" and image.get("architecture") in {"amd64", "arm64"}, "Unsupported artifact platform")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("config_id", "")), "Image config identity required")
    require(image.get("rootfs_layers") and all(re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in image["rootfs_layers"]), "Image layer identities required")
    require(all(type(image.get(key)) is int and image[key] > 0 for key in ("tar_bytes", "layer_blob_bytes", "layer_tar_bytes")), "Layer size evidence required")
    receipt = json.loads((directory / FILES["receipt"]).read_text())
    validate_receipt(receipt, sha, tree, image.get("id"))
    require(manifest["receipt"].get("log_digest") == receipt["log_digest"], "Receipt log digest mismatch")
    return manifest


def pack(directory, sha):
    tree = command(["git", "--no-replace-objects", "rev-parse", "HEAD^{tree}"])
    require(command(["git", "--no-replace-objects", "rev-parse", "HEAD"]) == sha, "Checkout commit mismatch")
    require(not command(["git", "status", "--porcelain", "--untracked-files=all"]), "Checkout must be clean")
    matches = [path for path in (ROOT / ".verify/receipts").glob("*.json") if json.loads(path.read_text()).get("git", {}).get("sha") == sha]
    require(len(matches) == 1, "Exactly one receipt for this commit is required")
    receipt = json.loads(matches[0].read_text())
    image_id = validate_receipt(receipt, sha, tree)
    require(file_info(ROOT / "package-lock.json")["sha256"] == receipt["git"].get("lockfile_sha256"), "Lockfile changed after verification")
    logs = hashlib.sha256()
    for index, stage in enumerate(receipt["stages"], 1):
        require(re.fullmatch(r"[a-z][a-z0-9-]*", stage["name"]), "Invalid verification stage")
        with (ROOT / ".verify/logs" / matches[0].stem / f"{index:02}-{stage['name']}.log").open("rb") as log:
            for block in iter(lambda: log.read(1024 * 1024), b""):
                logs.update(block)
    require("sha256:" + logs.hexdigest() == receipt["log_digest"], "Verification logs changed")
    image = image_info(image_id)
    require(image["Id"] == image_id, "Verified executor image identity changed")
    require(image.get("Os") == "linux" and image.get("Architecture") in {"amd64", "arm64"}, "Unsupported artifact platform")
    directory.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(matches[0], directory / FILES["receipt"])
    command(["git", "--no-replace-objects", "archive", "--format=tar.gz", f"--prefix=AI-MINE-{sha}/", "-o", str(directory / FILES["source"]), sha])
    saved = directory / "image-save.tar"
    try:
        command(["docker", "--host", SOCKET, "image", "save", "--output", str(saved), image_id])
        sizes = archive_layers(saved, image)
        with saved.open("rb") as source, (directory / FILES["image"]).open("xb") as target:
            with gzip.GzipFile(filename="", mode="wb", fileobj=target, compresslevel=1, mtime=0) as zipped:
                shutil.copyfileobj(source, zipped, 1024 * 1024)
    finally:
        saved.unlink(missing_ok=True)
    with gzip.open(directory / FILES["source"], "rb") as source:
        _, source_tar_bytes = digest(source)
    manifest = {
        "version": 1,
        "source": {"sha": sha, "tree": tree, "tar_bytes": source_tar_bytes, **file_info(directory / FILES["source"])},
        "image": {"id": image_id, "os": image["Os"], "architecture": image["Architecture"], **sizes, **file_info(directory / FILES["image"])},
        "receipt": {"log_digest": receipt["log_digest"], **file_info(directory / FILES["receipt"])},
        "workflow": {key: os.environ.get(env, "") for key, env in [("repository", "GITHUB_REPOSITORY"), ("run_id", "GITHUB_RUN_ID"), ("run_attempt", "GITHUB_RUN_ATTEMPT")]},
    }
    require(command(["git", "--no-replace-objects", "rev-parse", "HEAD^{tree}"]) == tree and not command(["git", "status", "--porcelain", "--untracked-files=all"]), "Checkout changed while exporting")
    manifest_file = directory / "release-manifest.json"
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n")
    manifest_hash = file_info(manifest_file)["sha256"]
    verify_bundle(directory, sha, tree, manifest_hash)
    return {"manifest_sha256": manifest_hash, "manifest": manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("pack", "verify"):
        child = commands.add_parser(name)
        child.add_argument("--directory", type=Path, required=True)
        child.add_argument("--sha", required=True)
        if name == "verify":
            child.add_argument("--tree", required=True)
            child.add_argument("--manifest-sha256", required=True)
    loaded = commands.add_parser("loaded")
    loaded.add_argument("--directory", type=Path, required=True)
    loaded.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    if args.command == "pack":
        result = pack(args.directory.resolve(), args.sha)
    elif args.command == "verify":
        result = verify_bundle(args.directory.resolve(), args.sha, args.tree, args.manifest_sha256)
    else:
        print(loaded_image(args.directory.resolve(), args.manifest_sha256))
        return
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
