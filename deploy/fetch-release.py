#!/usr/bin/env python3
"""Download the four files for an exact successful push of main; validate GitHub's archive digest first."""
import argparse
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from release_artifact import FILES, file_info, require, verify_bundle

REPO = "Crhis-CP/AI-MINE"


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", "repos/" + REPO + "/" + path]))


def unpack(path, dest, checksum):
    require("sha256:" + file_info(path)["sha256"] == checksum, "GitHub artifact digest mismatch")
    names = [*FILES.values(), "release-manifest.json"]
    with zipfile.ZipFile(path) as package:
        require(sorted(package.namelist()) == sorted(names), "Expected exactly the four release files")
        for name in names:
            with package.open(name) as source, (dest / name).open("xb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)


def fetch(sha, directory):
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "Expected a full commit SHA")
    tree = api("git/commits/" + sha)["tree"]["sha"]
    runs = api("actions/workflows/verify.yml/runs?event=push&branch=main&status=success&head_sha=" + sha)
    run = next((r for r in runs["workflow_runs"] if r["head_sha"] == sha and r["head_branch"] == "main"
                and r["event"] == "push" and r["conclusion"] == "success" and r["head_repository"]["full_name"] == REPO), None)
    require(run is not None, "No successful full main verification for this SHA")
    name = f"verified-release-{sha}-attempt-{run['run_attempt']}"
    entries = api(f"actions/runs/{run['id']}/artifacts")["artifacts"]
    matches = [item for item in entries if item["name"] == name and not item["expired"]]
    require(len(matches) == 1, "Exact successful run artifact missing, expired or ambiguous")
    item = matches[0]
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=directory.parent) as temporary:
        tmp = Path(temporary)
        archive = tmp / "download.zip"
        with archive.open("xb") as f:
            subprocess.run(["gh", "api", f"repos/{REPO}/actions/artifacts/{item['id']}/zip"], stdout=f, check=True)
        files = tmp / "files"
        files.mkdir()
        unpack(archive, files, item["digest"])
        checksum = file_info(files / "release-manifest.json")["sha256"]
        manifest = verify_bundle(files, sha, tree, checksum)
        require(manifest["workflow"] == {"repository": REPO, "run_id": str(run["id"]), "run_attempt": str(run["run_attempt"])},
                "Manifest workflow does not match GitHub")
        if directory.exists():
            verify_bundle(directory, sha, tree, checksum)
        else:
            files.rename(directory)
    return {"sha": sha, "tree": tree, "manifest_sha256": checksum, "source_sha256": manifest["source"]["sha256"], "run": run["html_url"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(fetch(args.sha, args.directory)))
