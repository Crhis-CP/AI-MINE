"""Exercise the release script's topology selection without Docker or production state."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("production-release.sh").read_text()
SELECT = re.search(r"read_api_topology\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
STOP = re.search(r"stop_api_containers\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)


class TopologyTests(unittest.TestCase):
    def test_release_checks_never_use_a_hardcoded_host_port(self):
        self.assertNotIn("127.0.0.1:3000", SCRIPT)

    def test_health_retries_a_temporarily_unavailable_port_mapping(self):
        resolver = re.search(r"web_origin\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
        health = re.search(r"health\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
        with tempfile.TemporaryDirectory() as folder:
            command = r'''set -e
dc() {
  printf 'port\n' >> "$RELEASE_BACKUP/attempts"
  [[ $(wc -l < "$RELEASE_BACKUP/attempts") -gt 1 ]] || return 1
  printf '127.0.0.1:43123\n'
}
sleep() { [[ $1 == 2 ]]; printf 'sleep\n' >> "$RELEASE_BACKUP/waits"; }
curl() {
  [[ "$*" == *"http://127.0.0.1:43123/api/health" ]] || return 1
  printf '{"ok":true,"db":"ok","release":"1234567"}\n'
}
''' + resolver + '\n' + health + '\nhealth 1234567'
            result = subprocess.run(["bash", "-c", command],
                env={"PATH": os.environ["PATH"], "RELEASE_BACKUP": folder, "AIMINE_HOST": "synthetic.invalid"},
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((Path(folder) / "attempts").read_text().splitlines(), ["port", "port"])
            self.assertEqual((Path(folder) / "waits").read_text().splitlines(), ["sleep"])

    def test_web_origin_uses_the_actual_single_loopback_mapping(self):
        resolver = re.search(r"web_origin\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
        for address, expected in [("127.0.0.1:3000", "http://127.0.0.1:3000"), ("127.0.0.1:43123", "http://127.0.0.1:43123"),
                                  ("", None), ("127.0.0.1:0", None), ("127.0.0.1:65536", None), ("0.0.0.0:3000", None),
                                  ("127.0.0.1:3000\n127.0.0.1:43123", None)]:
            with self.subTest(address=address):
                command = 'set -e\ndc() { [[ "$*" == "port web 3000" ]] || return 1; printf "%s" "$MAPPING"; }\n' + resolver + '\nweb_origin'
                result = subprocess.run(["bash", "-c", command], env={"PATH": os.defpath, "MAPPING": address}, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, expected is not None)
                self.assertEqual(result.stdout.strip(), expected or "")

    def test_maintenance_units_are_installed_without_starting_cleanup(self):
        section = SCRIPT[SCRIPT.index('install -m 0644 "$RELEASE_STAGE/deploy/recovery_bindings.py"'):SCRIPT.index('# Finish any older healthy')]
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / "bin"; binary.mkdir()
            for name in ["install", "systemctl"]:
                p = binary / name; p.write_text('#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "$CALLS"\n'); p.chmod(0o755)
            calls = Path(folder) / "calls"
            p = binary / "cmp"
            p.write_text('#!/bin/sh\ncase " $CHANGED_UNITS " in *" ${2##*.} "*) exit 1;; *) exit 0;; esac\n')
            p.chmod(0o755)
            for changed in ["", "service", "timer", "service timer"]:
                with self.subTest(changed=changed):
                    calls.write_text("")
                    result = subprocess.run(["bash", "-c", "set -e\n" + section], env={"PATH": str(binary) + ":" + os.defpath, "RELEASE_STAGE": "/synthetic", "CALLS": str(calls), "CHANGED_UNITS": changed}, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    commands = calls.read_text().splitlines()
                    for unit in ["service", "timer"]:
                        self.assertEqual(f"install -m 0644 /synthetic/deploy/aimine-release-retention.{unit} /etc/systemd/system/aimine-release-retention.{unit}" in commands, unit in changed.split())
                    self.assertEqual([c for c in commands if c.startswith("systemctl ")], ["systemctl daemon-reload"] if changed else [])
        service = Path(__file__).with_name("aimine-release-retention.service").read_text()
        self.assertIn("EnvironmentFile=-/etc/aimine/release.env", service)

    def select(self, services):
        command = 'set -e\ndc() { printf "%s\\n" "$FIXTURE_SERVICES"; }\n' + SELECT + '\nread_api_topology\nprintf "%s\\n" "${RELEASE_CURRENT_APIS[@]}"'
        return subprocess.run(["bash", "-c", command], env={"PATH": os.defpath, "FIXTURE_SERVICES": services}, capture_output=True, text=True)

    def test_local_backup_upgrade_default_preserves_explicit_owner_choice(self):
        setter = re.search(r"set_value\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
        enable = re.search(r"if ! grep -Eq .*?DB_BACKUP_LOCAL_ENABLED.*?; fi", SCRIPT).group(0)
        for existing in [None, "DB_BACKUP_LOCAL_ENABLED=false", "DB_BACKUP_LOCAL_ENABLED=true", "export DB_BACKUP_LOCAL_ENABLED=false", " DB_BACKUP_LOCAL_ENABLED = false"]:
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as folder:
                environment_file = Path(folder) / ".env"
                before = "UNCHANGED=synthetic\n" + ("" if existing is None else f"{existing}\n")
                environment_file.write_text(before)
                environment_file.chmod(0o600)
                result = subprocess.run(["bash", "-c", "set -e\n" + setter + "\n" + enable],
                    env={"PATH": os.environ["PATH"], "RELEASE_ROOT": folder}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(environment_file.read_text(), before if existing else before + "DB_BACKUP_LOCAL_ENABLED=true\n")
                self.assertEqual(environment_file.stat().st_mode & 0o777, 0o600)

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
