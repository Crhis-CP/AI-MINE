"""Prepare the model vault once during a locked release. Never print secret values."""
import base64
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path

KEY = "MODEL_REGISTRY_ENCRYPTION_KEY"
LINE = re.compile(r"^\s*(?:export\s+)?" + KEY + r"\s*=(.*)$")


def read_key(text):
    values = [m.group(1).strip() for line in text.splitlines() if (m := LINE.match(line))]
    if len(values) > 1:
        raise ValueError("Duplicate model vault configuration")
    if not values or not values[0]:
        return None
    value = values[0]
    if value[0:1] in ("'", '"'):
        quoted = re.fullmatch(r"(['\"])(.*?)\1(?:\s*#.*)?", value)
        if not quoted:
            raise ValueError("Invalid quoted model vault configuration")
        value = quoted.group(2)
    else:
        value = value.split("#", 1)[0].strip()
    if not value:
        return None
    try:
        decoded = base64.b64decode(value, validate=True)
        if len(decoded) != 32 or base64.b64encode(decoded).decode() != value:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("Invalid model vault configuration; existing keys are never replaced") from None
    return value


def save_key(path, text, value):
    stat = path.stat()
    lines = [line for line in text.splitlines() if not LINE.match(line)]
    fd, temporary = tempfile.mkstemp(prefix=".model-vault-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        if hasattr(os, "fchown"):
            os.fchown(fd, stat.st_uid, stat.st_gid)
        with os.fdopen(fd, "w") as target:
            fd = None
            target.write("\n".join([*lines, KEY + "=" + value]) + "\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if fd is not None:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


def ensure_vault(environment, rollback_environment, existing_connections):
    paths = [Path(environment), Path(rollback_environment)]
    if existing_connections < 0 or any(p.is_symlink() or not p.is_file() for p in paths):
        raise ValueError("Model vault requires regular environment files and a valid connection count")
    texts = [p.read_text() for p in paths]
    keys = [read_key(text) for text in texts]
    present = {key for key in keys if key}
    if len(present) > 1:
        raise ValueError("Live and rollback model vault keys differ; rotation is not allowed here")
    if not present and existing_connections:
        raise ValueError("Stored model connections exist without their vault key; restore the original key")
    value = next(iter(present)) if present else base64.b64encode(secrets.token_bytes(32)).decode()
    # Preserve decryptability before activating the new environment, including a program rollback.
    for index in (1, 0):
        if keys[index] is None:
            save_key(paths[index], texts[index], value)
    return "ready"


if __name__ == "__main__":
    if os.environ.get("AMP_RELEASE_LOCK_HELD") != "1":
        sys.exit("Model vault setup requires the production release lock")
    try:
        state = ensure_vault(sys.argv[1], sys.argv[2], int(sys.argv[3]))
    except ValueError as error:
        sys.exit(str(error))
    except (OSError, IndexError):
        sys.exit("Model vault setup failed; environment files and existing records must be checked without replacing a key")
    print("Model credential storage: " + state)
