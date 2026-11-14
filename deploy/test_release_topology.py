"""Exercise the release script's topology selection without Docker or production state."""
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import hashlib
import io
import json
import os
import tarfile
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("production-release.sh").read_text()
SELECT = re.search(r"read_api_topology\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)
STOP = re.search(r"stop_api_containers\(\) \{\n.*?\n\}", SCRIPT, re.S).group(0)


class TopologyTests(unittest.TestCase):
    _selection_snapshots = {}
    _selection_snapshot_lock = Lock()
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


    def test_selection_confirmation_argument_supports_score_standard_families(self):
        header = SCRIPT[:SCRIPT.index('RELEASE_TOOLS=')]
        families = ['selection-score', 'selection-score-global', 'selection-score-shared', 'selection-score-shared-standard', 'selection-score-global-shared-standard']
        for family in families:
            version = family + '@' + 'c' * 10 + '+weights@' + 'd' * 10
            result = subprocess.run(['bash', '-c', header, 'release', 'b' * 40, '/archive', 'c' * 64, '/bundle', 'd' * 64, 'e' * 40, '--selection-confirmed-version', version], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, family + ': ' + result.stderr)

    def selection_fixture(self, folder, present=True):
        base=Path(folder); root=base/'root'; backup=base/'backups'/('release-'+'b'*12+'-test'); stage=base/'stage'; binary=base/'bin'
        for path in [root/'.ops',root/'.data',root/'deploy',backup,stage/'deploy',binary]:path.mkdir(parents=True,exist_ok=True)
        old='selection-score-shared@'+'e'*10+'+weights@'+'f'*10; new='selection-score-global-shared-standard@'+'c'*10+'+weights@'+'d'*10
        image_old='sha256:'+'1'*64; image_new='sha256:'+'2'*64
        env_text='APP_IMAGE=amp-retained:'+'1'*12+'\nAMP_RELEASE='+'a'*12+'\nUNRELATED=synthetic-never-print\n'+('SELECTION_CONFIRMED_VERSION='+old+'\n' if present else '')
        (root/'.env').write_text(env_text); (root/'.env').chmod(0o600); (backup/'environment').write_text(env_text); (backup/'environment').chmod(0o600)
        (root/'.ops/release.lock').touch(); (root/'.data/keep').write_text('persistent data')
        for directory in [root,stage]:
            (directory/'docker-compose.yml').write_text('synthetic compose')
            (directory/'deploy/Caddyfile').write_text('synthetic caddy')
        payloads={}
        for role in ['api','web','worker','host']:
            file=backup/(role+'-program.tar.gz')
            with tarfile.open(file,'w:gz') as archive:
                for name,body in ([('./deploy/Caddyfile',b'synthetic caddy'),('./docker-compose.yml',b'synthetic compose')] if role=='host' else [('apps/code',b'old program')]):
                    item=tarfile.TarInfo(name); item.size=len(body); archive.addfile(item,io.BytesIO(body))
            payloads[file.name]=file
        (backup/'database.dump').write_bytes(b'synthetic database snapshot'); payloads['database.dump']=backup/'database.dump'
        (backup/'persistent-files.tar.gz').write_bytes(b'preserved unused snapshot'); payloads['persistent-files.tar.gz']=backup/'persistent-files.tar.gz'
        (backup/'persistent-files-list.txt').write_text('uploads\n'); (backup/'database-restore-list.txt').write_text('synthetic list\n')
        for name,value in [('previous-image.txt',image_old),('candidate-image.txt',image_new),('previous-api-services.txt','api')]: (backup/name).write_text(value+'\n')
        for name,release in [('previous-health.json','a'*12),('health.json','b'*12)]: (backup/name).write_text(json.dumps({'ok':True,'db':'ok','release':release}))
        (backup/'backup-sha256.txt').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+str(file)+'\n' for file in payloads.values()))
        point={'version':1,'previous_release':'a'*12,'previous_image':image_old,'attempted_release':'b'*40,'at':'2026-11-13T00:00:00Z','files':[{'file':name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()} for name,file in payloads.items()]}
        (backup/'recovery-point.json').write_text(json.dumps(point)); (backup/'previous-quality-gate.json').write_text('{"status":"pending","previous":true}')
        (root/'.ops/release-quality-gate.json').write_text('{"status":"pending","candidate":true}')
        expected={'old':old,'new':new,'present':present,'old_image':image_old,'new_image':image_new}; (base/'expected.json').write_text(json.dumps(expected))
        runtime={name:{'present':present,'value':old if present else None} for name in ['api','worker']}
        (base/'state.json').write_text(json.dumps({'image':image_old,'release':'a'*12,'runtime':runtime}))
        (base/'state-old.json').write_bytes((base/'state.json').read_bytes())
        (base/'state-new.json').write_text(json.dumps({'image':image_new,'release':'b'*12,'runtime':{name:{'present':True,'value':new} for name in runtime}}))
        for name,value in {'old-value':old,'new-value':new,'old-image':image_old,'new-image':image_new,'image':image_old,'release':'a'*12,'has-old':'1' if present else '0'}.items(): (base/name).write_text(value)
        (base/'runtime-old.json').write_text(json.dumps({'present':present,'value':old if present else None}))
        (base/'runtime-new.json').write_text(json.dumps({'present':True,'value':new}))
        (base/'runtime.json').write_bytes((base/'runtime-old.json').read_bytes())
        docker=r"""#!/bin/bash
set -euo pipefail
base=$FIXTURE
if [[ $1 == --host ]]; then shift 2; fi
printf '%s\n' "$*" >> "$base/calls"
case $1 in
 image) if [[ $* == *amp-retained:* && -e $base/bad-old-tag ]]; then cat "$base/new-image"; else cat "$base/old-image"; fi ;;
 inspect) printf '%s\n' "$(<"$base/image")" ;;
 exec) [[ $2 == amp-api-1 || $2 == amp-worker-1 ]]; [[ $* == *'const k="SELECTION_CONFIRMED_VERSION"'* ]]; cat "$base/runtime.json" ;;
 run)
  [[ $* == *'--network none'* && $* == *'--read-only'* && $* == *'MODEL_CALLS_ENABLED=false'* && $* == *'AMP_CREDENTIALS_DIR='* && $* == *'scoreConfirmationVersion(layout,ruleset)'* && $* == *'scoringConfirmed(true,process.env.SELECTION_CONFIRMED_VERSION)'* && $* == *'--entrypoint node sha256:222222'* ]] || exit 2
  [[ $* != *--env-file* && $* != *--volume* && $* != *--mount* && $* != *synthetic-never-print* ]] || exit 2
  [[ ! -e $base/probe-unavailable ]] || exit 1
  layout=shared; ruleset=global; version=$(<"$base/new-value")
  if [[ $* == *'SELECTION_RULESET=classic'* ]]; then ruleset=classic; version=selection-score-shared-standard@cccccccccc+weights@dddddddddd; fi
  if [[ $* == *'ANALYSIS_PROMPT_LAYOUT=separate'* ]]; then
   layout=separate; version=selection-score-global@0000000000+weights@dddddddddd
   if [[ $ruleset == classic ]]; then version=selection-score@0000000000+weights@dddddddddd; fi
  fi
  confirmed=true
  if [[ $* != *"SELECTION_CONFIRMED_VERSION=$version"* || -e $base/probe-gate-false ]]; then confirmed=false; fi
  if [[ -e $base/probe-wrong-ruleset ]]; then ruleset=classic; fi
  printf '{"layout":"%s","ruleset":"%s","defaultRuleset":"global","confirmation":"%s","score":"different-full-step","confirmed":%s}\n' "$layout" "$ruleset" "$version" "$confirmed" ;;

 rm) [[ $* == *amp-score-probe-bbbbbbbbbbbb-test* ]] || exit 2 ;;
 ps) printf 'amp-api-1\namp-web-1\namp-worker-1\namp-db-1\namp-caddy-1\n' ;;
 cp) cat >/dev/null ;;
 start|stop) : ;;
 compose)
  mode=
  for arg in "$@"; do case $arg in config|port|stop|up) mode=$arg; break ;; esac; done
  case $mode in
   config) printf 'db\napi\nweb\nworker\n' ;;
   port) printf '127.0.0.1:43123\n' ;;
   stop) : ;;
   up)
    text=$(<"$base/root/.env"); old=$(<"$base/old-value"); new=$(<"$base/new-value")
    if [[ $text == *'APP_IMAGE=amp-retained:'* ]]; then
     if [[ $(<"$base/has-old") == 1 ]]; then [[ $text == *"SELECTION_CONFIRMED_VERSION=$old"$'\n'* ]] || exit 2; else [[ $text != *SELECTION_CONFIRMED_VERSION* ]] || exit 2; fi
     [[ $text == *"AMP_RELEASE=aaaaaaaaaaaa"* && $text != *"$new"* ]] || exit 2
     if [[ ${FIXTURE_FAIL_CREATE:-0} == 1 ]]; then exit 1; fi
     kind=old; printf '%s' "$(<"$base/old-image")" > "$base/image"; printf 'aaaaaaaaaaaa' > "$base/release"
    else
     [[ $text == *"SELECTION_CONFIRMED_VERSION=$new"$'\n'* ]] || exit 2; kind=new
     printf '%s' "$(<"$base/new-image")" > "$base/image"; printf 'bbbbbbbbbbbb' > "$base/release"
    fi
    /bin/cp "$base/state-$kind.json" "$base/state.json"; /bin/cp "$base/runtime-$kind.json" "$base/runtime.json"
    if [[ $kind == old && ${FIXTURE_WRONG_IMAGE:-0} == 1 ]]; then /bin/cp "$base/new-image" "$base/image"; fi
    ;;
   *) exit 2 ;;
  esac ;;
 *) exit 2 ;;
esac
"""
        curl=r"""#!/bin/bash
printf '{"ok":true,"db":"ok","release":"%s"}\n' "$(<"$FIXTURE/release")"
"""
        for name,body in [('docker',docker),('timeout','#!/bin/sh\nshift\nexec "$@"\n'),('flock','#!/bin/sh\n[ "${FIXTURE_LOCK_FAIL:-0}" != 1 ]\n'),('curl',curl)]:
            file=binary/name; file.write_text(body); file.chmod(0o755)
        # The maintenance validator deliberately sanitizes Docker's environment; keep that guard in production.
        (base/'sitecustomize.py').write_text("import os,sys\nif len(sys.argv)>1 and sys.argv[1].endswith('/deploy'):\n import subprocess\n original=subprocess.check_output\n def call(args,*a,**kw):\n  if args[0]=='docker' and '--host' in args:\n   args=[os.environ['FIXTURE']+'/bin/docker',*args[1:]];kw['env']={**kw.get('env',os.environ),'FIXTURE':os.environ['FIXTURE']}\n  return original(args,*a,**kw)\n subprocess.check_output=call\n")
        env={'PATH':str(binary)+':'+os.environ['PATH'],'FIXTURE':str(base),'PYTHONPATH':str(base),'AIMINE_ROOT':str(root),'AIMINE_BACKUP_ROOT':str(backup.parent),'AIMINE_STAGE_ROOT':str(base/'stages'),'AIMINE_HOST':'synthetic.invalid','RELEASE_ROOT':str(root),'RELEASE_BACKUP':str(backup),'RELEASE_STAGE':str(stage),'RELEASE_SHA':'b'*40,'RELEASE_ID':'b'*12,'RELEASE_ATTEMPT':'test','RELEASE_CANDIDATE_IMAGE':image_new,'RELEASE_IMAGE':'amp-release:'+'b'*12,'RELEASE_OLD_TAG':'amp-retained:'+'1'*12,'RELEASE_OLD_IMAGE':image_old,'RELEASE_OLD_VERSION':'a'*12,'RELEASE_JOURNAL':str(root/'.ops/forward.json'),'RELEASE_QUALITY_GATE':str(root/'.ops/release-quality-gate.json'),'RELEASE_SELECTION_CONFIRMED_VERSION':new,'RELEASE_SWITCHED':'0','RELEASE_STOPPED':'0','RELEASE_CADDY_CHANGED':'0','RELEASE_MONITOR':''}
        functions='\n'.join(re.search(re.escape(name)+r"\(\) \{(?:[^\n]*\}|\n.*?\n\})",SCRIPT,re.S).group(0) for name in ['phase','dc','read_api_topology','stop_api_containers','set_value','selection_state','candidate_selection','web_origin','health','restore','on_exit'])
        prefix='set -Eeuo pipefail\n'+functions+'\nRELEASE_CURRENT_APIS=(api); RELEASE_OLD_APIS=(api)\n'
        # Capture each deterministic key state once; every scenario still has independent mutable files/processes.
        key=(present,old,new)
        with self._selection_snapshot_lock:
            if key not in self._selection_snapshots:
                capture=subprocess.run(['bash','-c',prefix+'selection_state capture'],env=env,capture_output=True,text=True,timeout=10)
                self.assertEqual(capture.returncode,0,capture.stderr)
                self.assertNotIn('synthetic-never-print',capture.stdout+capture.stderr)
                self._selection_snapshots[key]=capture.stdout
        point['selection_confirmation']=json.loads(self._selection_snapshots[key]); (backup/'recovery-point.json').write_text(json.dumps(point))
        return base,root,backup,env,prefix

    def selection_cases(self, cases, run):
        # Each case has independent files/processes; retain every case within the existing aggregate deadline.
        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs=[(case,pool.submit(run,case)) for case in cases]
            for case,job in jobs:
                with self.subTest(case=case):job.result()


    def selection_lifecycle_case(self,case):
        switch=SCRIPT[SCRIPT.index('phase prepare_switch\n'):SCRIPT.index('phase migrate\n')]
        present,phase=case
        with tempfile.TemporaryDirectory() as folder:
            base,root,backup,env,prefix=self.selection_fixture(folder,present)
            command=prefix+'trap on_exit EXIT\n'+switch
            if phase!='before_activation':command+='\ndc up -d --force-recreate api web worker\n'
            command+='\nexit 1' if phase!='after_success' else '\ntrap - EXIT\n'
            result=subprocess.run(['bash','-c',command],env=env,capture_output=True,text=True,timeout=15)
            if phase=='after_success':
                self.assertEqual(result.returncode,0,result.stderr)
                original_health=(backup/'health.json').read_text()
                result=subprocess.run(['bash',str(Path(__file__).with_name('production-release.sh')),'--recover','b'*40,str(backup)],env=env,capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(json.loads((backup/'recovery-point.json').read_text())['selection_recovery']['forward_health_utf8'],original_health)
            else:self.assertEqual(result.returncode,1,result.stderr)
            text=(root/'.env').read_text();self.assertEqual('SELECTION_CONFIRMED_VERSION=' in text,present)
            self.assertNotIn(env['RELEASE_SELECTION_CONFIRMED_VERSION'],text)
            self.assertEqual(json.loads((base/'state.json').read_text())['image'],'sha256:'+'1'*64)
            self.assertEqual((root/'.data/keep').read_text(),'persistent data')
            self.assertEqual((backup/'database.dump').read_bytes(),b'synthetic database snapshot')
            self.assertTrue(json.loads((root/'.ops/release-quality-gate.json').read_text())['previous'])
            self.assertNotIn('synthetic-never-print',result.stdout+result.stderr)
            self.assertEqual((root/'.env').stat().st_mode & 0o777,0o600)
            calls=[shlex.split(line) for line in (base/'calls').read_text().splitlines()]
            self.assertFalse(any(call[0]=='stop' and 'amp-db-1' in call for call in calls))

    def selection_guard_case(self,kind):
        with tempfile.TemporaryDirectory() as folder:
            base,root,backup,env,prefix=self.selection_fixture(folder)
            state=json.loads((base/'state.json').read_text());state['image']='sha256:'+'2'*64;state['release']='b'*12;state['runtime']={name:{'present':True,'value':env['RELEASE_SELECTION_CONFIRMED_VERSION']} for name in ['api','worker']};(base/'state.json').write_text(json.dumps(state))
            (base/'image').write_text('sha256:'+'2'*64); (base/'release').write_text('b'*12); (base/'runtime.json').write_bytes((base/'runtime-new.json').read_bytes())
            if kind=='lock':env['FIXTURE_LOCK_FAIL']='1'
            if kind=='tag':(base/'bad-old-tag').touch()
            if kind=='intent':(root/'.ops'/('score-recovery-'+'b'*12+'.intent.json')).write_text('{}')
            before=(root/'.env').read_bytes();(base/'calls').write_text('')
            result=subprocess.run(['bash',str(Path(__file__).with_name('production-release.sh')),'--recover',('c' if kind=='candidate' else 'b')*40,str(backup)],env=env,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0);self.assertEqual((root/'.env').read_bytes(),before)
            calls=[shlex.split(line) for line in (base/'calls').read_text().splitlines()]
            self.assertFalse(any(call[0] in ['stop','start','cp'] or (call[0]=='compose' and any(x in call for x in ['stop','up','run'])) for call in calls))

    def selection_original_case(self,present):
        switch=SCRIPT[SCRIPT.index('phase prepare_switch\n'):SCRIPT.index('phase migrate\n')]
        with tempfile.TemporaryDirectory() as folder:
            base,root,backup,env,prefix=self.selection_fixture(folder,present);env['RELEASE_SELECTION_CONFIRMED_VERSION']=''
            before=(root/'.env').read_text();result=subprocess.run(['bash','-c',prefix+self.candidate_check_call()+switch],env=env,capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual([line for line in (root/'.env').read_text().splitlines() if 'SELECTION_CONFIRMED_VERSION' in line],[line for line in before.splitlines() if 'SELECTION_CONFIRMED_VERSION' in line])
            (backup/'environment').write_text(before+'export SELECTION_CONFIRMED_VERSION=duplicate\nSELECTION_CONFIRMED_VERSION=again\n')
            result=subprocess.run(['bash','-c',prefix+'selection_state capture'],env=env,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0);self.assertNotIn('synthetic-never-print',result.stdout+result.stderr)

    def selection_partial_case(self,failure):
        switch=SCRIPT[SCRIPT.index('phase prepare_switch\n'):SCRIPT.index('phase migrate\n')]
        with tempfile.TemporaryDirectory() as folder:
            base,root,backup,env,prefix=self.selection_fixture(folder)
            result=subprocess.run(['bash','-c',prefix+switch+'\ndc up -d --force-recreate api web worker'],env=env,capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr); (base/'calls').write_text('')
            if failure=='backup': (backup/'environment').write_text((backup/'environment').read_text().replace('e'*10,'0'*10))
            elif failure=='environment':
                command=base/'bin/cp'; command.write_text("#!/usr/bin/env python3\nimport os,sys\nif any(a.endswith('/environment') for a in sys.argv[1:]):sys.exit(1)\nos.execv('/bin/cp',['cp',*sys.argv[1:]])\n"); command.chmod(0o755)
            elif failure=='image':env['FIXTURE_WRONG_IMAGE']='1'
            else:env['FIXTURE_FAIL_CREATE']='1'
            result=subprocess.run(['bash',str(Path(__file__).with_name('production-release.sh')),'--recover','b'*40,str(backup)],env=env,capture_output=True,text=True,timeout=15)
            self.assertNotEqual(result.returncode,0)
            calls=[shlex.split(line) for line in (base/'calls').read_text().splitlines()]
            self.assertFalse(any(call[0]=='start' for call in calls))
            records=[json.loads(file.read_text()) for file in (root/'.ops').glob('recovery-*.json')]
            self.assertEqual([x['phase'] for x in records],[] if failure=='backup' else ['recovery_failed'])
            self.assertTrue(json.loads((root/'.ops/release-quality-gate.json').read_text())['candidate'])
            self.assertNotIn('synthetic-never-print',result.stdout+result.stderr)


    def candidate_check_call(self):
        call='if [[ -n $RELEASE_SELECTION_CONFIRMED_VERSION ]]; then candidate_selection || exit 1; fi\n'
        self.assertLess(SCRIPT.index(call),SCRIPT.index('phase backup\n'))
        return call

    def selection_candidate_case(self,kind):
        with tempfile.TemporaryDirectory() as folder:
            base,root,backup,env,prefix=self.selection_fixture(folder)
            (Path(env['RELEASE_STAGE'])/'docker-compose.yml').write_text('x-app: &app\n  env_file: .env\nservices:\n  worker:\n    <<: *app\n')
            if kind=='wrong':env['RELEASE_SELECTION_CONFIRMED_VERSION']='selection-score-shared@'+'e'*10+'+weights@'+'f'*10
            for case,marker in [('unavailable','probe-unavailable'),('gate_false','probe-gate-false'),('ruleset_mismatch','probe-wrong-ruleset')]:
                if kind==case:(base/marker).touch()
            if kind in ['separate','global_separate_correct']:(root/'.env').write_text((root/'.env').read_text()+'ANALYSIS_PROMPT_LAYOUT=separate\n')
            if kind=='classic_correct':(root/'.env').write_text((root/'.env').read_text()+'SELECTION_RULESET=classic\n')
            if kind in ['classic_correct','global_separate_correct']:
                version=('selection-score-shared-standard@'+'c'*10 if kind=='classic_correct' else 'selection-score-global@'+'0'*10)+'+weights@'+'d'*10
                env['RELEASE_SELECTION_CONFIRMED_VERSION']=version;(base/'new-value').write_text(version)
                (base/'runtime-new.json').write_text(json.dumps({'present':True,'value':version}))
                state=json.loads((base/'state-new.json').read_text());state['runtime']={name:{'present':True,'value':version} for name in state['runtime']};(base/'state-new.json').write_text(json.dumps(state))
            success=kind in ['correct','classic_correct','global_separate_correct']
            before=(root/'.env').read_bytes();(base/'calls').write_text('')
            switch=SCRIPT[SCRIPT.index('phase prepare_switch\n'):SCRIPT.index('phase migrate\n')]
            result=subprocess.run(['bash','-c',prefix+self.candidate_check_call()+switch+'\ndc up -d --force-recreate api web worker'],env=env,capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode==0,success,result.stderr)
            calls=[shlex.split(line) for line in (base/'calls').read_text().splitlines()]
            self.assertFalse(any(call[0]=='stop' or (call[0]=='compose' and 'stop' in call) for call in calls))
            self.assertTrue(any(call[0]=='run' for call in calls))
            if kind in ['wrong','separate']:self.assertIn('Candidate scoring recipe differs',result.stderr)
            if kind=='gate_false':self.assertIn('production scoring gate is not confirmed',result.stderr)
            if kind=='ruleset_mismatch':self.assertIn('Candidate ruleset differs',result.stderr)
            if kind=='unavailable':self.assertTrue(any(call[0]=='rm' for call in calls))
            if not success:
                self.assertEqual((root/'.env').read_bytes(),before)
                self.assertEqual((base/'image').read_text(),'sha256:'+'1'*64)
                self.assertFalse(any(call[0]=='compose' and 'up' in call for call in calls))
            else:
                self.assertEqual((base/'image').read_text(),'sha256:'+'2'*64)
                self.assertEqual('SELECTION_RULESET=' in (root/'.env').read_text(),kind=='classic_correct')
            self.assertNotIn('synthetic-never-print',result.stdout+result.stderr)

    def test_selection_confirmation_lifecycle_and_failures(self):
        paths={'original':self.selection_original_case,'guard':self.selection_guard_case,'lifecycle':self.selection_lifecycle_case,'partial':self.selection_partial_case,'candidate':self.selection_candidate_case}
        cases=[('original',present) for present in [False,True]]
        cases += [('guard',kind) for kind in ['candidate','lock','intent','tag']]
        cases += [('lifecycle',(present,phase)) for present in [False,True] for phase in ['before_activation','after_activation','after_success']]
        cases += [('partial',kind) for kind in ['backup','environment','container','image']]
        cases += [('candidate',kind) for kind in ['wrong','correct','unavailable','separate','gate_false','ruleset_mismatch','classic_correct','global_separate_correct']]
        self.selection_cases(cases,lambda case:paths[case[0]](case[1]))


if __name__ == "__main__":
    unittest.main()
