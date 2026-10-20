"""Verify explicit replacement recovery recipes; never claim the original image exists.

Create one RecoveryBindings per invocation, while holding the existing release lock.
The resolver must query Docker for the supplied immutable digest and return its ID.
No successful validation is persisted across invocations.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

IMAGE = re.compile(r"sha256:[a-f0-9]{64}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
ROLES = ({"api", "web", "worker"}, {"public-api", "private-api", "web", "worker"})


class RecoveryBindingError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise RecoveryBindingError(message)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_mode, info.st_uid, info.st_gid)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON field")
        result[key] = value
    return result


class RecoveryBindings:
    def __init__(self, backup_root, resolve_image):
        self.root = Path(backup_root).absolute()
        self.resolve_image = resolve_image
        self._verified = {}

    def _open(self, relative):
        require(isinstance(relative, str) and relative and "\\" not in relative,
                "Invalid recovery path")
        parts = relative.split("/")
        require(not PurePosixPath(relative).is_absolute() and
                all(part not in ("", ".", "..") for part in parts), "Recovery path escapes root")
        directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(self.root, directory)
        try:
            for part in parts[:-1]:
                child = os.open(part, directory, dir_fd=fd)
                os.close(fd)
                fd = child
            file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        finally:
            os.close(fd)
        if not stat.S_ISREG(os.fstat(file).st_mode):
            os.close(file)
            raise RecoveryBindingError("Recovery input is not a regular file")
        return os.fdopen(file, "rb")

    def _signature(self, relative):
        with self._open(relative) as stream:
            return identity(os.fstat(stream.fileno()))

    def _read(self, relative, limit=1024 * 1024):
        with self._open(relative) as stream:
            before = identity(os.fstat(stream.fileno()))
            require(before[2] <= limit, "Recovery metadata exceeds size limit")
            data = stream.read(limit + 1)
            require(identity(os.fstat(stream.fileno())) == before and len(data) <= limit,
                    "Recovery metadata changed during read")
        require(self._signature(relative) == before, "Recovery metadata path changed")
        return data, before

    def _json(self, relative):
        data, observed = self._read(relative)
        return json.loads(data, object_pairs_hook=unique_object), data, observed

    def _descriptor(self, value, expected_path=None):
        require(isinstance(value, dict) and set(value) == {"path", "sha256", "bytes"},
                "Invalid recovery input descriptor")
        require(isinstance(value["sha256"], str) and HASH.fullmatch(value["sha256"]),
                "Invalid recovery input hash")
        require(type(value["bytes"]) is int and value["bytes"] > 0, "Invalid recovery input size")
        require(expected_path is None or value["path"] == expected_path, "Recovery snapshot input mismatch")
        observed = self._signature(value["path"])
        require(observed[2] == value["bytes"], "Recovery input size changed")
        return observed

    def _hash(self, descriptor, observed):
        with self._open(descriptor["path"]) as stream:
            require(identity(os.fstat(stream.fileno())) == observed, "Recovery input changed before hashing")
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
            require(identity(os.fstat(stream.fileno())) == observed, "Recovery input changed during hashing")
        require(digest == descriptor["sha256"] and self._signature(descriptor["path"]) == observed,
                "Recovery input hash or path changed")

    def resolve(self, original_image, recovery_directory):
        try:
            return self._resolve(original_image, recovery_directory)
        except RecoveryBindingError:
            raise
        except (OSError, ValueError, TypeError, KeyError, UnicodeError):
            raise RecoveryBindingError("Recovery binding is unavailable or invalid") from None

    def _registry(self):
        registry, raw, registry_identity = self._json("recovery-bindings.json")
        require(isinstance(registry, dict) and type(registry.get("schema_version")) is int and
                registry["schema_version"] == 1 and isinstance(registry.get("bindings"), list) and
                len(registry["bindings"]) <= 256, "Unsupported recovery registry")
        keys = [(entry.get("original_image"), entry.get("recovery_directory"))
                for entry in registry["bindings"] if isinstance(entry, dict)]
        require(len(keys) == len(registry["bindings"]) and
                all(isinstance(image, str) and IMAGE.fullmatch(image) and isinstance(directory, str) and
                    re.fullmatch(r"release-[a-f0-9]{12}(?:-[A-Za-z0-9]+)?", directory) for image, directory in keys) and
                len(set(keys)) == len(keys), "Invalid or duplicate recovery snapshot bindings")
        return registry, raw, registry_identity

    def resolve_candidate(self, original_image):
        """Protect a candidate's dependencies; never certify its directory's database."""
        try:
            require(isinstance(original_image, str) and IMAGE.fullmatch(original_image), "Invalid original image")
            registry, raw, _ = self._registry()
            recipes = [entry for entry in registry["bindings"] if entry["original_image"] == original_image]
            require(recipes, "Missing explicit candidate recovery bindings")
            runtimes = {self.resolve(original_image, entry["recovery_directory"]) for entry in recipes}
            require(len(runtimes) == 1, "Candidate recovery runtimes disagree")
            require(self._read("recovery-bindings.json")[0] == raw, "Candidate recovery bindings changed")
            return runtimes.pop()
        except RecoveryBindingError:
            raise
        except (OSError, ValueError, TypeError, KeyError, UnicodeError):
            raise RecoveryBindingError("Candidate recovery bindings are unavailable or invalid") from None

    def _resolve(self, original_image, recovery_directory):
        require(isinstance(original_image, str) and IMAGE.fullmatch(original_image), "Invalid original image")
        registry, raw, registry_identity = self._registry()
        binding_key = (original_image, recovery_directory)
        matches = [entry for entry in registry["bindings"]
                   if (entry["original_image"], entry["recovery_directory"]) == binding_key]
        require(len(matches) == 1, "Missing explicit recovery binding")
        recipe = matches[0]
        require(recipe.get("kind") == "image_plus_program_overlays", "Unsupported recovery recipe")
        runtime = recipe.get("runtime_image")
        require(isinstance(runtime, str) and IMAGE.fullmatch(runtime) and runtime != original_image,
                "A distinct immutable recovery runtime is required")
        snapshot = recipe.get("recovery_directory")
        require(isinstance(snapshot, str) and
                re.fullmatch(r"release-[a-f0-9]{12}(?:-[A-Za-z0-9]+)?", snapshot), "Invalid recovery directory")
        predecessor_path = snapshot + "/previous-image.txt"
        predecessor, predecessor_identity = self._read(predecessor_path, 128)
        require(predecessor.decode().strip() == original_image, "Snapshot is not the original image's predecessor backup")
        programs = recipe.get("program_overlays")
        require(isinstance(programs, dict) and set(programs) in ROLES, "Incomplete recovery role set")
        database = recipe.get("database")
        descriptors = [database, *[programs[role] for role in sorted(programs)]]
        observed = [self._descriptor(database, snapshot + "/database.dump")]
        observed.extend(self._descriptor(programs[role], f"{snapshot}/{role}-program.tar.gz") for role in sorted(programs))
        evidence_file = recipe.get("restore_evidence")
        evidence_identity = self._descriptor(evidence_file)
        require(PurePosixPath(evidence_file["path"]).parent.as_posix() == snapshot and
                evidence_file["path"].endswith(".json"), "Restore evidence must belong to the recovery snapshot")
        evidence, evidence_bytes, read_identity = self._json(evidence_file["path"])
        require(read_identity == evidence_identity and hashlib.sha256(evidence_bytes).hexdigest() == evidence_file["sha256"],
                "Restore evidence changed")
        require(isinstance(evidence, dict) and type(evidence.get("schema_version")) is int and
                evidence["schema_version"] == 1 and evidence.get("kind") == "isolated_program_overlay_restore" and
                evidence.get("result") == "passed", "Unsupported or failed restore evidence")
        for field in ("original_image", "runtime_image", "recovery_directory"):
            require(evidence.get(field) == recipe[field], "Restore identity mismatch")
        require(evidence.get("inputs") == {"database": database, "program_overlays": programs}, "Restore input hashes mismatch")
        require(evidence.get("isolation") == {"network": "none"}, "Restore was not network isolated")
        checks = evidence.get("checks", {})
        require(isinstance(checks, dict) and all(checks.get(key) is True for key in
                ("database_restore", "database_read", "authentication")), "Necessary restore checks did not pass")
        started = checks.get("services_started")
        require(isinstance(started, list) and len(started) == len(programs) and
                all(isinstance(role, str) for role in started) and set(started) == set(programs), "Role startup evidence incomplete")
        completion = evidence.get("completed_at")
        require(isinstance(completion, str), "Missing restore completion time")
        completed = dt.datetime.fromisoformat(completion.replace("Z", "+00:00"))
        require(completed.utcoffset() == dt.timedelta(0) and completed <= dt.datetime.now(dt.timezone.utc),
                "Invalid restore completion time")
        token = (hashlib.sha256(raw).hexdigest(), tuple(observed), predecessor_identity, evidence_identity)
        if self._verified.get(binding_key) != token:
            for descriptor, signature in zip(descriptors, observed):
                self._hash(descriptor, signature)
        try:
            canonical = self.resolve_image(runtime)
        except Exception:
            raise RecoveryBindingError("Recovery runtime image is unavailable") from None
        require(isinstance(canonical, str) and IMAGE.fullmatch(canonical), "Invalid resolved recovery runtime")
        paths = ["recovery-bindings.json", predecessor_path, evidence_file["path"], *[d["path"] for d in descriptors]]
        signatures = [registry_identity, predecessor_identity, evidence_identity, *observed]
        require(all(self._signature(p) == s for p, s in zip(paths, signatures)), "Recovery inputs changed during validation")
        self._verified[binding_key] = token
        return canonical
