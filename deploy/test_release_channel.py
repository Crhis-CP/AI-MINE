import gzip
import json
import sys
import importlib.util
import io
import os
from pathlib import Path
import random
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from release_artifact import encode_image, file_info


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class ChannelTests(unittest.TestCase):
    def test_unchanged_layers_match_after_a_moved_member_and_interrupted_copy(self):
        # Use the installed GNU rsync on macOS; the Ubuntu runner already ships it on PATH.
        rsync = "/opt/homebrew/bin/rsync" if Path("/opt/homebrew/bin/rsync").exists() else "rsync"
        rng = random.Random(731)
        fixed = b"".join(rng.randbytes(n) * 15 for n in (1536, 227, 1250, 256, 1025) * 40)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for version, delta in [("basis", b"x"), ("candidate", b"new" * 2700)]:
                directory = root / version
                directory.mkdir()
                raw = directory / "image.tar"
                with tarfile.open(raw, "w") as archive:
                    for name, body in [("change", delta), ("fixed-production-layer", fixed)]:
                        header = tarfile.TarInfo(name)
                        header.size = len(body)
                        archive.addfile(header, io.BytesIO(body))
                with (directory / "image.tar.gz").open("xb") as out:
                    encode_image(lambda: raw.open("rb"), out, raw.stat().st_size)
                self.assertEqual(gzip.decompress((directory / "image.tar.gz").read_bytes()), raw.read_bytes())
                with (directory / "single.gz").open("wb") as target:
                    with gzip.GzipFile(filename="", mode="wb", fileobj=target, compresslevel=1, mtime=0) as zipped:
                        zipped.write(raw.read_bytes())
            dst = root / "files"
            dst.mkdir()
            candidate = root / "candidate/image.tar.gz"
            args = [rsync, "--no-whole-file", "--checksum", "--partial-dir=.rsync-partial", "--stats",
                    "--copy-dest=" + str(root / "basis"), str(candidate), str(dst) + "/"]
            stats = subprocess.check_output(args, text=True, env={**os.environ, "LC_ALL": "C"})
            literal = next(line for line in stats.splitlines() if line.startswith("Literal data:"))
            self.assertLess(int(literal.split()[2].replace(",", "")), candidate.stat().st_size // 5)
            single = candidate.with_name("single.gz")
            control = subprocess.check_output([*args[:-2], str(single), args[-1]], text=True, env={**os.environ, "LC_ALL": "C"})
            control_literal = next(line for line in control.splitlines() if line.startswith("Literal data:"))
            self.assertGreater(int(control_literal.split()[2].replace(",", "")), single.stat().st_size // 5)
            work = dst / ".rsync-partial"
            work.mkdir(exist_ok=True)
            (dst / candidate.name).rename(work / candidate.name)
            with (work / candidate.name).open("r+b") as out:
                out.truncate(candidate.stat().st_size // 2)
            subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
            self.assertEqual(file_info(candidate), file_info(dst / candidate.name))

    def test_wrapper_requires_and_forwards_scoring_confirmation(self):
        source = Path(__file__).with_name("release-one.sh").read_text()
        block = source[source.index("confirmation=${7:-}") :].split("\nREMOTE", 1)[0]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("live", "candidate"):
                directory = root / name / "industry"
                (directory / "prompts").mkdir(parents=True)
                (directory / "prompts/score").write_text("same")
                (directory / "selection.ts").write_text("same")
                layout = directory.parent / "packages/backend/src/editorial/analysis-layout.ts"
                layout.parent.mkdir(parents=True)
                layout.write_text("same")
            env = root / "live/.env"
            env.write_text("UNRELATED=fixture-only\n")
            (root / "candidate/selection_env.py").write_bytes(Path(__file__).with_name("selection_env.py").read_bytes())
            deploy = root / "candidate/deploy"; deploy.mkdir()
            (deploy / "production-release.sh").write_text('printf "%s\\n" "$@"')
            script = 'set -eu; sha=A; slot=B; source=C; manifest=D; tree=E; tools=$1\n' + block.replace("/opt/aimine/", str(root / "live") + "/")
            def run(*confirmation):
                return subprocess.run(["bash", "-c", script, "test", str(root / "candidate"), "2", "3", "4", "5", "6", *confirmation],
                                      capture_output=True, text=True)
            unchanged = run()
            self.assertEqual(unchanged.returncode, 0, unchanged.stderr)
            for changed in (root / "candidate/industry/prompts/score", root / "candidate/industry/selection.ts",
                            root / "candidate/packages/backend/src/editorial/analysis-layout.ts"):
                changed.write_text("changed")
                self.assertNotEqual(run().returncode, 0)
                result = run("fixture-version")
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout.splitlines()[-2:], ["--selection-confirmed-version", "fixture-version"])
                changed.write_text("same")
            live = "selection-score-shared@0123456789+weights@9876543210"
            env.write_text(f"export SELECTION_CONFIRMED_VERSION='{live}' # current policy\n")
            (root / "candidate/packages/backend/src/editorial/analysis-layout.ts").write_text("new recipe")
            inherited = run()
            self.assertEqual(inherited.returncode, 0, inherited.stderr)
            self.assertEqual(inherited.stdout.splitlines()[-2:], ["--selection-confirmed-version", live])
            self.assertEqual(run("explicit").stdout.splitlines()[-1], "explicit")
            for invalid in ("SELECTION_CONFIRMED_VERSION=x", f"SELECTION_CONFIRMED_VERSION={live}\nSELECTION_CONFIRMED_VERSION="):
                env.write_text(invalid)
                self.assertNotEqual(run().returncode, 0)

    def test_fetch_rejects_other_branches_events_repositories_and_artifact_names(self):
        f = module("fetch-release")
        sha = "a" * 40
        run = {"head_sha": sha, "head_branch": "main", "event": "push", "conclusion": "success",
               "head_repository": {"full_name": f.REPO}, "id": 1, "run_attempt": 1}
        artifact = {"name": f"verified-release-{sha}-attempt-1", "expired": False}
        for changes, entry in [({"head_branch": "other"}, artifact), ({"event": "pull_request"}, artifact),
                               ({"head_repository": {"full_name": "other/repo"}}, artifact), ({}, {**artifact, "name": "other"})]:
            with self.subTest(changes=changes, entry=entry), patch.object(f, "api", side_effect=[
                    {"tree": {"sha": "b" * 40}}, {"workflow_runs": [{**run, **changes}]}, {"artifacts": [entry]}]):
                with self.assertRaisesRegex(ValueError, "No successful|artifact missing"):
                    f.fetch(sha, Path("unused"))

    def test_transfer_preparation_verification_and_changed_running_release(self):
        t = module("release-transfer")
        old, new, tree, manifest = "a" * 12, "b" * 40, "c" * 40, "d" * 64
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            ops = root / ".ops"; ops.mkdir(); (ops / "release.lock").touch()
            basis = root / "active"; basis.mkdir()
            image = basis / "image.tar.gz"; image.write_bytes(b"verified basis")
            (basis / "release-manifest.json").write_text(json.dumps({"source": {"sha": old + "0" * 28},
                "image": {**file_info(image), "tar_bytes": 1024, "encoding": "gzip-per-member-v1"}}))
            stage = root / ("channel-" + new)
            with patch.object(t, "ROOT", root), patch.object(t, "STAGE", root), patch.object(t, "active_release", return_value=old) as active, \
                    patch.object(t, "DISK_FLOOR", 0), patch.object(t, "verify_bundle") as verify:
                def invoke(phase):
                    with patch.object(sys, "argv", ["transfer", phase, new, tree, manifest, "1024", "--basis", str(basis)]):
                        t.main()
                invoke("prepare")
                self.assertEqual((stage / "basis/image.tar.gz").read_bytes(), image.read_bytes())
                active.return_value = "e" * 12
                with self.assertRaisesRegex(ValueError, "changed during transfer"):
                    invoke("verify")
                verify.assert_not_called()
                active.return_value = old
                invoke("verify")
                verify.assert_called_once_with(stage / "files", new, tree, manifest)
                self.assertTrue(image.is_file())

    def test_cache_only_removes_completed_bundles_outside_three_distinct_versions(self):
        c = module("release-cache")
        shas = [str(n) * 40 for n in range(1, 6)]
        ids = ["sha256:" + str(n) * 64 for n in range(1, 6)]
        for local in (True, False):
            with tempfile.TemporaryDirectory() as d:
                root = Path(d); ops = root / "ops"; ops.mkdir()
                folders = []
                for i, (sha, image) in enumerate(zip(shas, ids)):
                    bundle = root / (("" if local else "channel-") + sha); folders.append(bundle)
                    files = bundle / "files"; files.mkdir(parents=True)
                    for name in c.FILES: (files / name).touch()
                    (files / "release-manifest.json").write_text(json.dumps({"source": {"sha": sha}}))
                    (bundle / "channel-release.json").write_text(json.dumps({"sha": sha, "image": image}))
                    if local:
                        (bundle / "proof.json").touch(); (bundle / "transfer.stats").touch()
                    else:
                        (bundle / "basis").mkdir(); (bundle / "previous").touch()
                    if i:
                        backup = ops / sha; backup.mkdir()
                        (backup / "previous-health.json").write_text(json.dumps({"release": shas[i-1][:12], "ok": True, "db": "ok"}))
                        (backup / "candidate-image.txt").write_text(image)
                        (backup / "previous-image.txt").write_text(ids[i-1])
                        (ops / f"release-{sha[:12]}-attempt.json").write_text(json.dumps({"sha": sha, "phase": "deployed_origin_verified", "backup": str(backup)}))
                (folders[0] / "unknown-file").touch()
                keep = c.protected_history(ops, shas[-1])
                self.assertEqual(keep, {sha[:12]: image for sha, image in zip(shas[2:], ids[2:])})
                c.clean(root, shas[-1], keep, local)
                self.assertEqual([f.exists() for f in folders], [True, False, True, True, True])

    def test_fetch_binds_four_names_to_independent_archive_digest(self):
        fetch = module("fetch-release")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            zipped = root / "files.zip"
            with zipfile.ZipFile(zipped, "w") as z:
                for name in (*fetch.FILES.values(), "release-manifest.json"):
                    z.writestr(name, b"test")
            out = root / "out"
            out.mkdir()
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                fetch.unpack(zipped, out, "sha256:" + "0" * 64)
            fetch.unpack(zipped, out, "sha256:" + file_info(zipped)["sha256"])
            self.assertEqual(len(list(out.iterdir())), 4)
