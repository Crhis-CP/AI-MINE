"""Exercise the release script's topology selection without Docker or production state."""
import os
from pathlib import Path
import re
import subprocess
import unittest

SCRIPT = Path(__file__).with_name("production-release.sh").read_text()
SELECT = re.search(r"read_api_topology\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
STOP = re.search(r"stop_api_containers\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)


class TopologyTests(unittest.TestCase):
    def select(self, services):
        command = 'set -e\ndc() { printf "%s\\n" "$FIXTURE_SERVICES"; }\n' + SELECT + '\nread_api_topology\nprintf "%s\\n" "${RELEASE_CURRENT_APIS[@]}"'
        return subprocess.run(["bash", "-c", command], env={"PATH": os.defpath, "FIXTURE_SERVICES": services}, capture_output=True, text=True)

    def test_accepts_complete_legacy_and_unified_topologies(self):
        for services, expected in [("db\napi\nworker\nweb", ["api"]), ("setup\npublic-api\nprivate-api\nworker\nweb", ["public-api", "private-api"])]:
            with self.subTest(services=services):
                result = self.select(services)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), expected)

    def test_incomplete_or_mixed_topology_never_selects_any_service(self):
        for services in ["web\nworker", "public-api", "private-api", "api\npublic-api", "api\nprivate-api", "api\npublic-api\nprivate-api"]:
            with self.subTest(services=services):
                result = self.select(services)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("release stopped", result.stderr)

    def test_compose_error_does_not_select_a_partial_topology(self):
        result = subprocess.run(["bash", "-c", 'set -e\ndc() { printf "api\\n"; return 1; }\n' + SELECT + '\nread_api_topology'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_rollback_inventory_failure_stops_before_any_container_change(self):
        result = subprocess.run(["bash", "-c", 'set -e\ndocker() { [[ $1 == ps ]] && return 1; echo unexpected >&2; }\n' + STOP + '\nstop_api_containers'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")

    def test_rollback_environment_write_failure_never_activates_a_container(self):
        restore = re.search(r"restore\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
        for key in ["APP_IMAGE", "AMP_RELEASE"]:
            command = '''set -e
phase() { :; }
dc() { [[ $1 == stop ]] || printf 'unexpected activation'; }
stop_api_containers() { :; }
cp() { :; }; mkdir() { :; }; tar() { :; }; rsync() { :; }
set_value() { [[ $1 != "$FIXTURE_FAIL" ]]; }
''' + restore + '\nrestore || exit $?'
            environment = {"PATH": os.defpath, "FIXTURE_FAIL": key, "RELEASE_BACKUP": "/synthetic/backup", "RELEASE_ROOT": "/synthetic/root", "RELEASE_OLD_TAG": "synthetic", "RELEASE_OLD_VERSION": "1234567"}
            result = subprocess.run(["bash", "-c", command], env=environment, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("unexpected activation", result.stdout)

    def test_rollback_only_stops_known_application_containers_and_propagates_failure(self):
        for fail in ["", "amp-api-1"]:
            command = r'''set -e
 docker() {
   if [[ $1 == ps ]]; then printf "amp-api-1\namp-web-1\namp-db-1\n"; return; fi
   printf "%s\n" "$*" >&2
   [[ $4 != "$FIXTURE_FAIL" ]]
 }
''' + STOP + "\nstop_api_containers"
            result = subprocess.run(["bash", "-c", command], env={"PATH": os.defpath, "FIXTURE_FAIL": fail}, capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, not fail)
            self.assertIn("stop -t 15 amp-api-1", result.stderr)
            self.assertNotIn("amp-db-1", result.stderr)
            self.assertNotIn("amp-worker-1", result.stderr)
            if not fail: self.assertIn("stop -t 15 amp-web-1", result.stderr)


if __name__ == "__main__":
    unittest.main()
