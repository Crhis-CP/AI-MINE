#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
RELEASE_SHA=${1:?exact verified SHA required}
RELEASE_ARCHIVE=${2:?archive path required}
RELEASE_ARCHIVE_HASH=${3:?archive hash required}
RELEASE_BUNDLE=${4:?verified artifact directory required}
RELEASE_MANIFEST_HASH=${5:?independently checked manifest hash required}
RELEASE_TREE=${6:?verified source tree required}
[[ $RELEASE_SHA =~ ^[0-9a-f]{40}$ && $RELEASE_ARCHIVE_HASH =~ ^[0-9a-f]{64}$ && $RELEASE_MANIFEST_HASH =~ ^[0-9a-f]{64}$ && $RELEASE_TREE =~ ^[0-9a-f]{40}$ ]]
RELEASE_TOOLS=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RELEASE_ID=${RELEASE_SHA:0:12}
RELEASE_ATTEMPT=$(date -u +%Y%m%dT%H%M%S%N)
RELEASE_ROOT=/opt/aimine
RELEASE_BACKUP=/opt/aimine-backup/release-$RELEASE_ID-$RELEASE_ATTEMPT
RELEASE_STAGE=/opt/aimine-release-stage/$RELEASE_ID-$RELEASE_ATTEMPT
RELEASE_JOURNAL=$RELEASE_ROOT/.ops/release-$RELEASE_ID-$RELEASE_ATTEMPT.json
RELEASE_PREVIOUS_HEALTH=$RELEASE_ROOT/.ops/previous-health-$RELEASE_ID-$RELEASE_ATTEMPT.json
RELEASE_IMAGE=amp-release:$RELEASE_ID
RELEASE_OLD_IMAGE=
RELEASE_OLD_TAG=
RELEASE_OLD_VERSION=
RELEASE_STOPPED=0
RELEASE_SWITCHED=0
RELEASE_CADDY_CHANGED=0
RELEASE_MONITOR=
RELEASE_QUALITY_GATE=$RELEASE_ROOT/.ops/release-quality-gate.json
RELEASE_CURRENT_APIS=()
RELEASE_OLD_APIS=()
RELEASE_PHASE=preflight
[[ -f $RELEASE_ROOT/.ops/release.lock && ! -L $RELEASE_ROOT/.ops/release.lock ]]
exec 9>>"$RELEASE_ROOT/.ops/release.lock"
flock -w 5 9
cd "$RELEASE_ROOT"
[[ ! -e $RELEASE_BACKUP && ! -e $RELEASE_STAGE ]]
printf '%s  %s\n' "$RELEASE_ARCHIVE_HASH" "$RELEASE_ARCHIVE" | sha256sum -c -
python3 -B "$RELEASE_TOOLS/release_artifact.py" verify --directory "$RELEASE_BUNDLE" --sha "$RELEASE_SHA" --tree "$RELEASE_TREE" --manifest-sha256 "$RELEASE_MANIFEST_HASH"
cmp "$RELEASE_ARCHIVE" "$RELEASE_BUNDLE/source.tar.gz"
python3 -B "$RELEASE_TOOLS/prepare_capacity.py" --root "$RELEASE_ROOT" --backup-root /opt/aimine-backup --lock-fd 9 --apply \
  --record "$RELEASE_ROOT/.ops/capacity-preparation-$RELEASE_ID-$RELEASE_ATTEMPT.json"
persistent_bytes() {
  docker exec amp-worker-1 node --input-type=module -e '
    import {lstat,readdir} from "node:fs/promises";
    import path from "node:path";
    async function size(file) {
      const item=await lstat(file);
      if(item.isDirectory()) { let n=1024; for(const name of await readdir(file))n+=await size(path.join(file,name)); return n; }
      return item.size+1024;
    }
    let n=0;
    for(const file of ["/data/uploads","/data/site/release-notes.json","/data/site/release-notes.json.announcements.json"]) {
      try { n+=await size(file); } catch(error) { if(error.code!=="ENOENT")throw error; }
    }
    console.log(n);
  '
}
RELEASE_PERSISTENT_BYTES=$(persistent_bytes)
[[ $RELEASE_PERSISTENT_BYTES =~ ^[0-9]+$ ]]
# Resource checks run while the old worker is still running. Failure only leaves the evidence receipt.
python3 -B "$RELEASE_TOOLS/release_capacity.py" preflight --root "$RELEASE_ROOT" --backup-root /opt/aimine-backup --manifest "$RELEASE_BUNDLE/release-manifest.json" --persistent-bytes "$RELEASE_PERSISTENT_BYTES" --record "$RELEASE_ROOT/.ops/preflight-$RELEASE_ID-before-import-$RELEASE_ATTEMPT.json"
phase() {
  RELEASE_PHASE=$1
  python3 - "$RELEASE_JOURNAL" "$RELEASE_SHA" "$RELEASE_PHASE" "$RELEASE_IMAGE" "$RELEASE_BACKUP" <<'PYJ'
import json,os,sys,datetime
p,sha,phase,image,backup=sys.argv[1:]
x={'sha':sha,'phase':phase,'image':image,'backup':backup,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(p+'.tmp','w') as f:json.dump(x,f)
os.replace(p+'.tmp',p)
with open(p+'.jsonl','a') as f:f.write(json.dumps(x)+'\n')
print(json.dumps(x),flush=True)
PYJ
}
dc() { docker compose --project-name amp --env-file "$RELEASE_ROOT/.env" -f "$RELEASE_ROOT/docker-compose.yml" "$@"; }
require_monitor() {
  for attempt in $(seq 1 20); do
    kill -0 "$RELEASE_MONITOR" 2>/dev/null || return 1
    [[ -s $RELEASE_BACKUP/resource-samples.jsonl ]] && return 0
    sleep 0.1
  done
  printf '%s\n' 'Release resource sampling did not start' >&2
  return 1
}
reuse_identical_program() {
  local first=$1 archive=$2
  if [[ $first != "$archive" ]] && cmp -s "$first" "$archive"; then
    # Keep every role path; only a newly created, byte-identical duplicate becomes a hard link.
    ln "$first" "$archive.link"
    mv "$archive.link" "$archive"
  fi
}
# Read names only; never render interpolated Compose configuration or secrets.
read_api_topology() {
  local configured service single=0 public=0 private=0
  configured=$(dc config --services) || return 1
  while IFS= read -r service; do
    case "$service" in
      api) single=1 ;;
      public-api) public=1 ;;
      private-api) private=1 ;;
    esac
  done <<< "$configured"
  if [[ $single == 1 && $public == 0 && $private == 0 ]]; then
    RELEASE_CURRENT_APIS=(api)
  elif [[ $single == 0 && $public == 1 && $private == 1 ]]; then
    RELEASE_CURRENT_APIS=(public-api private-api)
  else
    printf '%s\n' 'Incomplete or mixed API topology; release stopped' >&2
    return 1
  fi
}
stop_api_containers() {
  local role containers
  containers=$(docker ps -a --format '{{.Names}}') || return 1
  for role in api public-api private-api web; do
    if [[ $'\n'"$containers"$'\n' == *$'\n'"amp-$role-1"$'\n'* ]]; then
      docker stop -t 15 "amp-$role-1" >/dev/null || return 1
    fi
  done
}
set_value() {
  python3 - "$RELEASE_ROOT/.env" "$1" "$2" <<'PYE'
import os,sys
from pathlib import Path
p=Path(sys.argv[1]); key,value=sys.argv[2:]
assert key in {'APP_IMAGE','AMP_RELEASE','DB_BACKUP_LOCAL_ENABLED'}
stat=p.stat(); lines=p.read_text().splitlines(); lines=[s for s in lines if not s.startswith(key+'=')]
t=p.with_name(p.name+'.release-tmp');t.write_text('\n'.join([*lines,key+'='+value])+'\n')
os.chmod(t,stat.st_mode & 0o777);os.chown(t,stat.st_uid,stat.st_gid);os.replace(t,p)
PYE
}
health() {
  local expected=$1
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 3 -H 'Host: aiminingpolicy.com' http://127.0.0.1:3000/api/health > "$RELEASE_BACKUP/health.json"; then
      if python3 - "$RELEASE_BACKUP/health.json" "$expected" <<'PYH'
import json,sys
x=json.load(open(sys.argv[1]));assert x.get('ok') is True and x.get('db')=='ok' and x.get('release')==sys.argv[2]
PYH
      then return 0; fi
    fi
    sleep 2
  done
  return 1
}
restore() {
  phase rollback
  dc stop -t 480 worker || return 1
  stop_api_containers || return 1
  cp -p "$RELEASE_BACKUP/environment" "$RELEASE_ROOT/.env" || return 1
  mkdir -p "$RELEASE_BACKUP/restore-source"
  tar -xzf "$RELEASE_BACKUP/host-program.tar.gz" -C "$RELEASE_BACKUP/restore-source" || return 1
  rsync -a --delete --exclude='.env*' --exclude=.ops --exclude=.data --exclude=.git --exclude=.credentials --exclude=node_modules "$RELEASE_BACKUP/restore-source/" "$RELEASE_ROOT/" || return 1
  set_value APP_IMAGE "$RELEASE_OLD_TAG" || return 1
  set_value AMP_RELEASE "$RELEASE_OLD_VERSION" || return 1
  export APP_IMAGE=$RELEASE_OLD_TAG AMP_RELEASE=$RELEASE_OLD_VERSION
  dc up --no-start --no-deps --no-build --pull never --force-recreate "${RELEASE_OLD_APIS[@]}" web worker || return 1
  for role in "${RELEASE_OLD_APIS[@]}" web worker; do
    gzip -dc "$RELEASE_BACKUP/$role-program.tar.gz" | docker cp -a - "amp-$role-1:/app/" || return 1
  done
  for role in "${RELEASE_OLD_APIS[@]}" web; do docker start "amp-$role-1" || return 1; done
  health "$RELEASE_OLD_VERSION" || return 1
  docker start amp-worker-1 || return 1
  if [[ $RELEASE_CADDY_CHANGED == 1 ]]; then dc --profile https up -d --no-deps --no-build --pull never --force-recreate caddy || return 1; fi
  phase recovered_previous_version
}
on_exit() {
  local result=$?
  trap - EXIT
  if [[ $result != 0 ]]; then
    set +e
    if [[ $RELEASE_SWITCHED == 1 ]]; then
      restore || phase recovery_failed
    elif [[ $RELEASE_STOPPED == 1 ]]; then
      if docker start amp-worker-1 && health "$RELEASE_OLD_VERSION"; then
        phase failed_previous_running
      else phase recovery_failed
      fi
    else phase failed_before_switch
    fi
    if [[ $RELEASE_PHASE != recovery_failed && -f "$RELEASE_BACKUP/previous-quality-gate.json" ]]; then
      cp -p "$RELEASE_BACKUP/previous-quality-gate.json" "$RELEASE_QUALITY_GATE"
    fi
  fi
  if [[ -n $RELEASE_MONITOR ]]; then kill "$RELEASE_MONITOR" 2>/dev/null || true; wait "$RELEASE_MONITOR" 2>/dev/null || true; fi
  exit "$result"
}
trap on_exit EXIT
phase observe_previous
read_api_topology
RELEASE_OLD_APIS=("${RELEASE_CURRENT_APIS[@]}")
curl -fsS --max-time 5 -H 'Host: aiminingpolicy.com' http://127.0.0.1:3000/api/health > "$RELEASE_PREVIOUS_HEALTH"
RELEASE_OLD_VERSION=$(python3 - "$RELEASE_PREVIOUS_HEALTH" <<'PYP'
import json,sys,re
x=json.load(open(sys.argv[1]));assert x.get('ok') is True and x.get('db')=='ok' and re.fullmatch('[a-f0-9]{7,40}',x.get('release',''));print(x['release'])
PYP
)
RELEASE_OLD_IMAGE=$(docker image inspect --format '{{.Id}}' "$(docker inspect --format '{{.Image}}' amp-web-1)")
[[ $RELEASE_OLD_IMAGE =~ ^sha256:[0-9a-f]{64}$ ]]
for role in "${RELEASE_OLD_APIS[@]}" web worker; do
  [[ $(docker inspect --format '{{.State.Running}}' "amp-$role-1") == true ]]
  [[ $(docker image inspect --format '{{.Id}}' "$(docker inspect --format '{{.Image}}' "amp-$role-1")") == "$RELEASE_OLD_IMAGE" ]]
done
# Record the verified predecessor before importing a candidate. Each attempt keeps
# its own evidence, so a failed import neither loses references nor prevents a retry.
mkdir -p "$RELEASE_BACKUP" "$RELEASE_STAGE"
printf '%s\n' "$RELEASE_OLD_IMAGE" > "$RELEASE_BACKUP/previous-image.txt"
printf '%s\n' "${RELEASE_OLD_APIS[@]}" > "$RELEASE_BACKUP/previous-api-services.txt"
cp -p "$RELEASE_PREVIOUS_HEALTH" "$RELEASE_BACKUP/previous-health.json"
python3 -B "$RELEASE_TOOLS/release_capacity.py" monitor --root "$RELEASE_ROOT" --output "$RELEASE_BACKUP/resource-samples.jsonl" --parent "$$" 9>&- &
RELEASE_MONITOR=$!
require_monitor
phase import_verified_image
tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_STAGE" --strip-components=1
docker image load --input "$RELEASE_BUNDLE/image.tar.gz"
RELEASE_CANDIDATE_IMAGE=$(python3 -B "$RELEASE_TOOLS/release_artifact.py" loaded --directory "$RELEASE_BUNDLE" --manifest-sha256 "$RELEASE_MANIFEST_HASH")
docker image tag "$RELEASE_CANDIDATE_IMAGE" "$RELEASE_IMAGE"
printf '%s\n' "$RELEASE_CANDIDATE_IMAGE" > "$RELEASE_BACKUP/candidate-image.txt"
# Loading and unpacking are complete before the database recovery point and worker pause.
phase backup
for role in "${RELEASE_OLD_APIS[@]}" web worker; do
  [[ $(docker inspect --format '{{.State.Running}}' "amp-$role-1") == true ]]
  [[ $(docker image inspect --format '{{.Id}}' "$(docker inspect --format '{{.Image}}' "amp-$role-1")") == "$RELEASE_OLD_IMAGE" ]]
  docker exec "amp-$role-1" sh -c '
    set -- apps packages industry scripts assets reference database deploy node_modules package.json
    for extra in site modules package-lock.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml; do
      if [ -e "/app/$extra" ]; then set -- "$@" "$extra"; fi
    done
    exec tar -czf - -C /app "$@"
  ' > "$RELEASE_BACKUP/$role-program.tar.gz"
  tar -tzf "$RELEASE_BACKUP/$role-program.tar.gz" >/dev/null
  reuse_identical_program "$RELEASE_BACKUP/${RELEASE_OLD_APIS[0]}-program.tar.gz" "$RELEASE_BACKUP/$role-program.tar.gz"
 done
RELEASE_OLD_TAG=amp-retained:${RELEASE_OLD_IMAGE:7:12}
docker image inspect --format '{{.Id}}' "$RELEASE_OLD_IMAGE" >/dev/null
docker image tag "$RELEASE_OLD_IMAGE" "$RELEASE_OLD_TAG"
cp -p .env "$RELEASE_BACKUP/environment"
tar --exclude='.env*' --exclude=.ops --exclude=.data --exclude=.git --exclude=.credentials --exclude=node_modules -czf "$RELEASE_BACKUP/host-program.tar.gz" -C "$RELEASE_ROOT" .
tar -tzf "$RELEASE_BACKUP/host-program.tar.gz" >/dev/null
if [[ -f $RELEASE_QUALITY_GATE ]]; then cp -p "$RELEASE_QUALITY_GATE" "$RELEASE_BACKUP/previous-quality-gate.json"; fi
python3 - "$RELEASE_QUALITY_GATE" "$RELEASE_SHA" <<'PYQ'
import datetime,json,os,sys
p,sha=sys.argv[1:]
with open(p+'.tmp','w') as f:json.dump({'sha':sha,'status':'pending','at':datetime.datetime.now(datetime.timezone.utc).isoformat()},f)
os.replace(p+'.tmp',p)
PYQ
# Install the quality-aware guard before any failure can leave a new release
# running under the old timer's health-only cleanup rules. Business rollback
# deliberately keeps this conservative guard.
install -m 0644 "$RELEASE_STAGE/deploy/recovery_bindings.py" /usr/local/lib/aimine-maintenance/recovery_bindings.py
install -m 0644 "$RELEASE_STAGE/deploy/release_changelog.py" /usr/local/lib/aimine-maintenance/release_changelog.py
install -m 0755 "$RELEASE_STAGE/deploy/release-retention.py" /usr/local/lib/aimine-maintenance/release-retention.py
# Finish any older healthy version's note before changing its running code.
if [[ -f "$RELEASE_ROOT/.ops/changelog-pending.json" ]]; then
  python3 - "$RELEASE_ROOT" "$RELEASE_OLD_VERSION" <<'PYN'
import sys
sys.path.insert(0, sys.argv[1] + '/deploy')
from release_changelog import retry_pending
assert retry_pending(sys.argv[1],sys.argv[2]), 'Pending note must be resolved before switching'
PYN
fi
require_monitor
RELEASE_PERSISTENT_BYTES=$(persistent_bytes)
[[ $RELEASE_PERSISTENT_BYTES =~ ^[0-9]+$ ]]
python3 -B "$RELEASE_TOOLS/release_capacity.py" preflight --phase before_backup --root "$RELEASE_ROOT" --backup-root /opt/aimine-backup --manifest "$RELEASE_BUNDLE/release-manifest.json" --persistent-bytes "$RELEASE_PERSISTENT_BYTES" --record "$RELEASE_ROOT/.ops/preflight-$RELEASE_ID-before-backup-$RELEASE_ATTEMPT.json"
phase drain_worker
RELEASE_STOPPED=1
dc stop -t 480 worker
phase database_backup
docker exec amp-db-1 pg_dump -U amp -d amp -Fc > "$RELEASE_BACKUP/database.dump"
docker exec -i amp-db-1 pg_restore --list < "$RELEASE_BACKUP/database.dump" > "$RELEASE_BACKUP/database-restore-list.txt"
# Durable files are separate from programs and the database. Screenshots remain outside backups.
[[ $(docker inspect --format '{{.State.Running}}' amp-worker-1) == false ]]
RELEASE_DATA_VOLUME=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' amp-worker-1)
[[ $RELEASE_DATA_VOLUME =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
docker run --rm --pull never --network none --read-only --memory 128m --cpus 1 --mount "type=volume,source=$RELEASE_DATA_VOLUME,target=/data,readonly" --entrypoint sh "$RELEASE_OLD_IMAGE" -c '
  set --
  for item in uploads site/release-notes.json site/release-notes.json.announcements.json; do
    if [ -e "/data/$item" ]; then set -- "$@" "$item"; fi
  done
  if [ "$#" -eq 0 ]; then exec tar -czf - -T /dev/null; fi
  exec tar -czf - -C /data "$@"
' > "$RELEASE_BACKUP/persistent-files.tar.gz"
tar -tzf "$RELEASE_BACKUP/persistent-files.tar.gz" > "$RELEASE_BACKUP/persistent-files-list.txt"
sha256sum "$RELEASE_BACKUP/"*-program.tar.gz "$RELEASE_BACKUP/database.dump" "$RELEASE_BACKUP/persistent-files.tar.gz" > "$RELEASE_BACKUP/backup-sha256.txt"
# This manifest identifies the predecessor recovery point; the directory name identifies the attempted successor.
python3 - "$RELEASE_BACKUP" "$RELEASE_OLD_VERSION" "$RELEASE_OLD_IMAGE" "$RELEASE_SHA" <<'PYB'
import datetime,json,sys
from pathlib import Path
p=Path(sys.argv[1]);files=[]
hashes={Path(name).name:h for h,name in (line.split('  ',1) for line in (p/'backup-sha256.txt').read_text().splitlines())}
for f in sorted([*p.glob('*-program.tar.gz'),p/'database.dump',p/'persistent-files.tar.gz']):
    s=f.stat();files.append({'file':f.name,'sha256':hashes[f.name],'bytes':s.st_size,'allocated_bytes':s.st_blocks*512,'inode':s.st_ino,'links':s.st_nlink})
(p/'recovery-point.json').write_text(json.dumps({'version':1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previous_release':sys.argv[2],'previous_image':sys.argv[3],'attempted_release':sys.argv[4],'isolated_restore':'pending','files':files},indent=2)+'\n')
PYB
phase prepare_switch
RELEASE_SWITCHED=1
cmp -s "$RELEASE_ROOT/deploy/Caddyfile" "$RELEASE_STAGE/deploy/Caddyfile" || RELEASE_CADDY_CHANGED=1
rsync -a --delete --exclude='.env*' --exclude=.ops --exclude=.data --exclude=.git --exclude=.credentials --exclude=node_modules "$RELEASE_STAGE/" "$RELEASE_ROOT/"
read_api_topology
set_value APP_IMAGE "$RELEASE_IMAGE"
set_value AMP_RELEASE "$RELEASE_ID"
# This upgrade enables the requested daily local recovery point when no explicit Owner choice exists.
# Existing false/true values and any configured object store retain their meaning.
if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?DB_BACKUP_LOCAL_ENABLED[[:space:]]*=' "$RELEASE_ROOT/.env"; then set_value DB_BACKUP_LOCAL_ENABLED true; fi
export APP_IMAGE=$RELEASE_IMAGE AMP_RELEASE=$RELEASE_ID
phase migrate
# Existing source settings and permissions are retained; this run never executes seed or source repair.
dc run --rm --no-deps setup node scripts/migrate.ts
phase model_storage
# Stop previous API processes before changing credential storage or activating the new topology.
for role in "${RELEASE_OLD_APIS[@]}"; do docker stop -t 15 "amp-$role-1"; done
RELEASE_MODEL_CONNECTIONS=$(docker exec amp-db-1 psql -X -q -A -t -v ON_ERROR_STOP=1 -U amp -d amp -c 'SELECT count(*) FROM ai.model_connections')
cp -p "$RELEASE_BACKUP/environment" "$RELEASE_BACKUP/environment-before-model-vault"
AMP_RELEASE_LOCK_HELD=1 python3 deploy/ensure_model_vault.py "$RELEASE_ROOT/.env" "$RELEASE_BACKUP/environment" "$RELEASE_MODEL_CONNECTIONS"
# Apply the named Owner decision before any new worker can collect or call a model.
dc run --rm --no-deps -e AMP_RELEASE_LOCK_HELD=1 setup node scripts/apply-release-controls.ts
phase activate
dc up -d --no-deps --no-build --pull never --force-recreate "${RELEASE_CURRENT_APIS[@]}" web
health "$RELEASE_ID"
for page in / /all /policies /metals /feedback /privacy /api/site/content-version; do
  code=$(curl -sS -o /dev/null --max-time 15 -H 'Host: aiminingpolicy.com' -w '%{http_code}' "http://127.0.0.1:3000$page")
  [[ $code == 200 ]]
done
if [[ $RELEASE_CADDY_CHANGED == 1 ]]; then dc --profile https up -d --no-deps --no-build --pull never --force-recreate caddy; fi
dc up -d --no-deps --no-build --pull never --force-recreate worker
for role in "${RELEASE_CURRENT_APIS[@]}" web worker; do
  [[ $(docker inspect --format '{{.State.Running}}' "amp-$role-1") == true ]]
done
health "$RELEASE_ID"
systemctl is-active aimine-release-retention.timer
df -B1 / > "$RELEASE_BACKUP/disk-after.txt"
phase deployed_origin_verified
# From this point, missing observations or note-registration failures must not
# roll back a healthy website. They still fail completion and keep quality pending.
trap - EXIT
RELEASE_SAMPLING_OK=1
require_monitor || RELEASE_SAMPLING_OK=0
kill "$RELEASE_MONITOR" 2>/dev/null || RELEASE_SAMPLING_OK=0
wait "$RELEASE_MONITOR" 2>/dev/null || RELEASE_SAMPLING_OK=0
RELEASE_MONITOR=
if [[ $RELEASE_SAMPLING_OK != 1 ]]; then
  phase deployed_capacity_evidence_missing
  exit 1
fi
python3 - "$RELEASE_ROOT" "$RELEASE_SHA" <<'PYN'
import sys,datetime
sys.path.insert(0, sys.argv[1] + '/deploy')
from release_changelog import save_pending,retry_pending
save_pending(sys.argv[1],sys.argv[2],datetime.datetime.now(datetime.timezone.utc).isoformat())
retry_pending(sys.argv[1],sys.argv[2][:12])
PYN
# The shared lock is released only on process exit. The installed timer waits for ten steady minutes.
