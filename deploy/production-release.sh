#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
RELEASE_SHA=${1:?exact verified SHA required}
RELEASE_ARCHIVE=${2:?archive path required}
RELEASE_ARCHIVE_HASH=${3:?archive hash required}
[[ $RELEASE_SHA =~ ^[0-9a-f]{40}$ && $RELEASE_ARCHIVE_HASH =~ ^[0-9a-f]{64}$ ]]
RELEASE_ID=${RELEASE_SHA:0:12}
RELEASE_ROOT=/opt/aimine
RELEASE_BACKUP=/opt/aimine-backup/release-$RELEASE_ID
RELEASE_STAGE=/opt/aimine-release-stage/$RELEASE_ID
RELEASE_JOURNAL=$RELEASE_ROOT/.ops/release-$RELEASE_ID.json
RELEASE_IMAGE=amp-release:$RELEASE_ID
RELEASE_OLD_IMAGE=
RELEASE_OLD_TAG=
RELEASE_OLD_VERSION=
RELEASE_STOPPED=0
RELEASE_SWITCHED=0
RELEASE_CADDY_CHANGED=0
RELEASE_CURRENT_APIS=()
RELEASE_OLD_APIS=()
RELEASE_PHASE=preflight
[[ -f $RELEASE_ROOT/.ops/release.lock && ! -L $RELEASE_ROOT/.ops/release.lock ]]
exec 9>>"$RELEASE_ROOT/.ops/release.lock"
flock -w 5 9
cd "$RELEASE_ROOT"
[[ ! -e $RELEASE_BACKUP && ! -e $RELEASE_STAGE ]]
printf '%s  %s\n' "$RELEASE_ARCHIVE_HASH" "$RELEASE_ARCHIVE" | sha256sum -c -
mkdir -p "$RELEASE_BACKUP" "$RELEASE_STAGE"
phase() {
  RELEASE_PHASE=$1
  python3 - "$RELEASE_JOURNAL" "$RELEASE_SHA" "$RELEASE_PHASE" "$RELEASE_IMAGE" "$RELEASE_BACKUP" <<'PYJ'
import json,os,sys,datetime
p,sha,phase,image,backup=sys.argv[1:]
x={'sha':sha,'phase':phase,'image':image,'backup':backup,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with open(p+'.tmp','w') as f:json.dump(x,f)
os.replace(p+'.tmp',p)
print(json.dumps(x),flush=True)
PYJ
}
dc() { docker compose --project-name amp --env-file "$RELEASE_ROOT/.env" -f "$RELEASE_ROOT/docker-compose.yml" "$@"; }
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
assert key in {'APP_IMAGE','AMP_RELEASE'}
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
  set_value APP_IMAGE "$RELEASE_OLD_TAG"
  set_value AMP_RELEASE "$RELEASE_OLD_VERSION"
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
      docker start amp-worker-1 && health "$RELEASE_OLD_VERSION" && phase failed_previous_running
    else phase failed_before_switch
    fi
  fi
  exit "$result"
}
trap on_exit EXIT
phase backup
read_api_topology
RELEASE_OLD_APIS=("${RELEASE_CURRENT_APIS[@]}")
printf '%s\n' "${RELEASE_OLD_APIS[@]}" > "$RELEASE_BACKUP/previous-api-services.txt"
curl -fsS --max-time 5 -H 'Host: aiminingpolicy.com' http://127.0.0.1:3000/api/health > "$RELEASE_BACKUP/previous-health.json"
RELEASE_OLD_VERSION=$(python3 - "$RELEASE_BACKUP/previous-health.json" <<'PYP'
import json,sys,re
x=json.load(open(sys.argv[1]));assert x.get('ok') is True and x.get('db')=='ok' and re.fullmatch('[a-f0-9]{7,40}',x.get('release',''));print(x['release'])
PYP
)
RELEASE_OLD_IMAGE=$(docker inspect --format '{{.Image}}' amp-web-1)
for role in "${RELEASE_OLD_APIS[@]}" web worker; do
  [[ $(docker inspect --format '{{.Image}} {{.State.Running}}' "amp-$role-1") == "$RELEASE_OLD_IMAGE true" ]]
  docker exec "amp-$role-1" sh -c '
    set -- apps packages industry scripts assets reference database deploy node_modules package.json
    for extra in site modules package-lock.json .npmrc pnpm-lock.yaml pnpm-workspace.yaml; do
      if [ -e "/app/$extra" ]; then set -- "$@" "$extra"; fi
    done
    exec tar -czf - -C /app "$@"
  ' > "$RELEASE_BACKUP/$role-program.tar.gz"
  tar -tzf "$RELEASE_BACKUP/$role-program.tar.gz" >/dev/null
 done
RELEASE_OLD_TAG=amp-retained:${RELEASE_OLD_IMAGE:7:12}
docker image inspect --format '{{.Id}}' "$RELEASE_OLD_IMAGE" >/dev/null
docker image tag "$RELEASE_OLD_IMAGE" "$RELEASE_OLD_TAG"
printf '%s\n' "$RELEASE_OLD_IMAGE" > "$RELEASE_BACKUP/previous-image.txt"
cp -p .env "$RELEASE_BACKUP/environment"
tar --exclude='.env*' --exclude=.ops --exclude=.data --exclude=.git --exclude=.credentials --exclude=node_modules -czf "$RELEASE_BACKUP/host-program.tar.gz" -C "$RELEASE_ROOT" .
tar -tzf "$RELEASE_BACKUP/host-program.tar.gz" >/dev/null
# Finish any older healthy version's note before changing its running code.
if [[ -f "$RELEASE_ROOT/.ops/changelog-pending.json" ]]; then
  python3 - "$RELEASE_ROOT" "$RELEASE_OLD_VERSION" <<'PYN'
import sys
sys.path.insert(0, sys.argv[1] + '/deploy')
from release_changelog import retry_pending
assert retry_pending(sys.argv[1],sys.argv[2]), 'Pending note must be resolved before switching'
PYN
fi
phase drain_worker
RELEASE_STOPPED=1
dc stop -t 480 worker
phase database_backup
docker exec amp-db-1 pg_dump -U amp -d amp -Fc > "$RELEASE_BACKUP/database.dump"
docker exec -i amp-db-1 pg_restore --list < "$RELEASE_BACKUP/database.dump" > "$RELEASE_BACKUP/database-restore-list.txt"
sha256sum "$RELEASE_BACKUP/"*-program.tar.gz "$RELEASE_BACKUP/database.dump" > "$RELEASE_BACKUP/backup-sha256.txt"
phase build
tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_STAGE" --strip-components=1
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com --tag "$RELEASE_IMAGE" "$RELEASE_STAGE"
docker image inspect --format '{{.Id}}' "$RELEASE_IMAGE" > "$RELEASE_BACKUP/candidate-image.txt"
phase prepare_switch
RELEASE_SWITCHED=1
cmp -s "$RELEASE_ROOT/deploy/Caddyfile" "$RELEASE_STAGE/deploy/Caddyfile" || RELEASE_CADDY_CHANGED=1
rsync -a --delete --exclude='.env*' --exclude=.ops --exclude=.data --exclude=.git --exclude=.credentials --exclude=node_modules "$RELEASE_STAGE/" "$RELEASE_ROOT/"
read_api_topology
set_value APP_IMAGE "$RELEASE_IMAGE"
set_value AMP_RELEASE "$RELEASE_ID"
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
# From this point, a note-registration failure must never roll back a healthy website.
trap - EXIT
python3 - "$RELEASE_ROOT" "$RELEASE_SHA" <<'PYN'
import sys,datetime
sys.path.insert(0, sys.argv[1] + '/deploy')
from release_changelog import save_pending,retry_pending
save_pending(sys.argv[1],sys.argv[2],datetime.datetime.now(datetime.timezone.utc).isoformat())
retry_pending(sys.argv[1],sys.argv[2][:12])
PYN
install -m 0755 deploy/release-retention.py /usr/local/lib/aimine-maintenance/release-retention.py
install -m 0644 deploy/release_changelog.py /usr/local/lib/aimine-maintenance/release_changelog.py
# The shared lock is released only on process exit. The installed timer waits for ten steady minutes.
