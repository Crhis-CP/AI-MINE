"""Retry the current healthy release's pending reader note while holding release.lock."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess


def save_pending(root, sha, published_at):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid release identity")
    dt.datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    target = Path(root) / ".ops/changelog-pending.json"
    if target.exists():
        old = json.loads(target.read_text())
        if old["sha"] != sha:
            raise RuntimeError("Previous release note must be registered before switching")
        return
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps({"sha": sha, "published_at": published_at}) + "\n")
    os.replace(temp, target)


def retry_pending(root, release, runner=subprocess.run):
    target = Path(root) / ".ops/changelog-pending.json"
    if not target.exists():
        return True
    try:
        note = json.loads(target.read_text())
        sha = note["sha"]
        if not re.fullmatch(r"[a-f0-9]{40}", sha) or not re.fullmatch(r"[a-f0-9]{12,40}", release or "") or not sha.startswith(release):
            raise ValueError("Pending note does not match running release")
        dt.datetime.fromisoformat(note["published_at"].replace("Z", "+00:00"))
        result = runner(["docker", "exec", "-e", "AMP_RELEASE_LOCK_HELD=1", "amp-worker-1", "node", "scripts/register-release-notes.ts", sha, note["published_at"]], capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError("Reader-note registration failed")
        target.unlink()
        print(json.dumps({"changelog": "registered", "release": release}), flush=True)
        return True
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"changelog": "pending", "reason": str(error)}), flush=True)
        return False
