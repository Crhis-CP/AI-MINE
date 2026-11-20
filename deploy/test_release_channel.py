import gzip
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
        fixed = random.Random(731).randbytes(1024 * 1024)
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
            dst = root / "files"
            dst.mkdir()
            candidate = root / "candidate/image.tar.gz"
            args = [rsync, "--no-whole-file", "--checksum", "--partial-dir=.rsync-partial", "--stats",
                    "--copy-dest=" + str(root / "basis"), str(candidate), str(dst) + "/"]
            stats = subprocess.check_output(args, text=True, env={**os.environ, "LC_ALL": "C"})
            literal = next(line for line in stats.splitlines() if line.startswith("Literal data:"))
            self.assertLess(int(literal.split()[2].replace(",", "")), candidate.stat().st_size // 5)
            work = dst / ".rsync-partial"
            work.mkdir(exist_ok=True)
            (dst / candidate.name).rename(work / candidate.name)
            with (work / candidate.name).open("r+b") as out:
                out.truncate(candidate.stat().st_size // 2)
            subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
            self.assertEqual(file_info(candidate), file_info(dst / candidate.name))

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
