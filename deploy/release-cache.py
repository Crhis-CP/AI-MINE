"""Remove only known program-bundle files for releases outside the live rollback window."""
import argparse
import json
import re
import sys
from pathlib import Path

FILES = {"release-manifest.json", "verify-receipt.json", "image.tar.gz", "source.tar.gz"}


def protected_history(ops, sha):
    """Read the live version and two distinct rollback identities from successful release evidence."""
    history = {}
    prefix = sha[:12]
    first = True
    seen = set()
    while len(set(history.values())) < 3 and prefix not in seen:
        seen.add(prefix)
        good = []
        for journal in ops.glob(f"release-{prefix}-*.json"):
            row = json.loads(journal.read_text())
            if row.get("phase") == "deployed_origin_verified" and re.fullmatch(prefix + "[a-f0-9]{28}", row.get("sha", "")):
                good.append(row)
        if len(good) != 1 or (first and good[0]["sha"] != sha):
            break
        first = False
        backup = Path(good[0]["backup"])
        try:
            image = (backup / "candidate-image.txt").read_text().strip()
            old = (backup / "previous-image.txt").read_text().strip()
            prior = json.loads((backup / "previous-health.json").read_text())
        except FileNotFoundError:
            break
        if not all(re.fullmatch("sha256:[a-f0-9]{64}", x) for x in (image, old)) or prior.get("ok") is not True or prior.get("db") != "ok":
            break
        if prefix in history and history[prefix] != image:
            return {}
        history[prefix] = image
        prefix = prior.get("release", "")
        if not re.fullmatch("[a-f0-9]{12}", prefix) or prefix in seen:
            break
        history[prefix] = old
    return history


def remove_bundle(directory, sha, local):
    if not re.fullmatch("[a-f0-9]{40}", sha) or not directory.is_dir() or directory.is_symlink():
        return
    top = {"files", "proof.json", "transfer.stats"} if local else {"files", "previous", "basis"}
    top.add("channel-release.json")
    if {p.name for p in directory.iterdir()} != top or any(p.is_symlink() for p in directory.iterdir()):
        return
    files = directory / "files"
    if not files.is_dir() or {p.name for p in files.iterdir()} != FILES or any(p.is_symlink() or not p.is_file() for p in files.iterdir()):
        return
    if json.loads((files / "release-manifest.json").read_text())["source"]["sha"] != sha:
        return
    regular = top - {"files", "basis"}
    if not all((directory / n).is_file() for n in regular):
        return
    if not local and (not (directory / "basis").is_dir() or any((directory / "basis").iterdir())):
        return
    for name in FILES:
        (files / name).unlink()
    files.rmdir()
    for name in regular:
        (directory / name).unlink()
    if not local:
        (directory / "basis").rmdir()
    directory.rmdir()


def clean(root, sha, history, local):
    prefix = "" if local else "channel-"
    current = root / (prefix + sha)
    if current.is_symlink() or not current.is_dir() or sha[:12] not in history:
        return
    marker = {"sha": sha, "image": history[sha[:12]]}
    record = current / "channel-release.json"
    if not record.exists():
        with record.open("x") as out:
            json.dump(marker, out)
    if record.is_symlink() or json.loads(record.read_text()) != marker:
        raise ValueError("Inconsistent channel completion record")
    if len(set(history.values())) < 3:
        return
    for folder in root.glob(prefix + "*"):
        old = folder.name.removeprefix(prefix)
        if not re.fullmatch("[a-f0-9]{40}", old) or old[:12] in history or folder.is_symlink() or not folder.is_dir():
            continue
        record = folder / "channel-release.json"
        if not record.is_file() or record.is_symlink():
            continue
        receipt = json.loads(record.read_text())
        if receipt.get("sha") == old and re.fullmatch("sha256:[a-f0-9]{64}", receipt.get("image", "")) and receipt["image"] not in history.values():
            remove_bundle(folder, old, local)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("sha")
    parser.add_argument("--ops", type=Path)
    args = parser.parse_args()
    if not re.fullmatch("[a-f0-9]{40}", args.sha):
        parser.error("A full release SHA is required")
    history = protected_history(args.ops, args.sha) if args.ops else json.load(sys.stdin)
    clean(args.root, args.sha, history, not args.ops)
    if args.ops:
        print(json.dumps(history))
