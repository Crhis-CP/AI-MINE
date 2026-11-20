#!/usr/bin/env bash
# Run from the operator checkout only after Owner approval.
set -Eeuo pipefail
umask 077
export LC_ALL=C
here=$(cd -- "$(dirname -- "$0")" && pwd)
sha=${1:-}
[[ $# == 1 && $sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Usage: release-one.sh FULL_COMMIT_SHA' >&2; exit 2; }
host=${AIMINE_SSH:?set the production SSH alias}
[[ $host =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]] || exit 2
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
remote() { ssh "${ssh_opts[@]}" -- "$host" "$@"; }
rsync_bin=${AIMINE_RSYNC:-rsync}
limit=${AIMINE_BWLIMIT:-2000}
[[ $limit =~ ^[1-9][0-9]{0,3}$ ]] && (( limit <= 2000 )) || { echo 'Expected 1–2000 KiB/s' >&2; exit 2; }
base=${AIMINE_PUBLIC_URL:-https://aiminingpolicy.com}
[[ $base =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || exit 2
root=/opt/aimine-release-stage
slot=$root/channel-$sha
local_dir=${AIMINE_RELEASE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/aimine-release}/$sha
mkdir -p "$local_dir"
start=$SECONDS
phase=preview
trap 'printf "Release stopped in %s (exit %s)\n" "$phase" "$?" >&2' ERR
remote 'set -eu; ids=$(docker ps -aq --filter label=com.docker.compose.project=amp-preview --filter label=com.docker.compose.service=reader); if [ -n "$ids" ]; then docker rm -f $ids; fi'
phase=fetch
python3 -B "$here/fetch-release.py" "$sha" "$local_dir/files" > "$local_dir/proof.json"
read -r tree manifest source bytes < <(python3 - "$local_dir" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); proof=json.loads((p/'proof.json').read_text())
print(proof['tree'], proof['manifest_sha256'], proof['source_sha256'], sum(f.stat().st_size for f in (p/'files').iterdir()))
PY
)
phase=transfer
tools=$(remote "umask 077; mktemp -d $root/channel-tools.XXXXXXXX")
[[ $tools =~ ^/opt/aimine-release-stage/channel-tools\.[a-zA-Z0-9]+$ ]] || exit 1
scp -q "${ssh_opts[@]}" "$here"/{release-transfer.py,release_artifact.py,release_capacity.py} "$host:$tools/"
args=("$sha" "$tree" "$manifest" "$bytes")
if [[ -n ${AIMINE_BASIS_DIR:-} ]]; then
  [[ $AIMINE_BASIS_DIR =~ ^/opt/[A-Za-z0-9_./-]+$ && $AIMINE_BASIS_DIR != *..* ]] || exit 2
  args+=(--basis "$AIMINE_BASIS_DIR")
fi
remote "python3 -B $tools/release-transfer.py prepare ${args[*]}"
"$rsync_bin" --checksum --no-whole-file --copy-dest="$slot/basis" --partial-dir=.rsync-partial \
  --timeout=120 --bwlimit="$limit" --stats --rsync-path='flock -n /opt/aimine/.ops/release.lock rsync' \
  -e "ssh ${ssh_opts[*]}" -- "$local_dir/files/"{image.tar.gz,source.tar.gz,verify-receipt.json,release-manifest.json} "$host:$slot/files/" | tee "$local_dir/transfer.stats"
sent=$(awk '/^Total bytes sent:/ {gsub(",", "", $4); print $4}' "$local_dir/transfer.stats")
[[ $sent =~ ^[0-9]+$ ]] || { echo 'Missing rsync transfer count' >&2; exit 1; }
remote "python3 -B $tools/release-transfer.py verify ${args[*]}"
phase=deployment
remote "bash -s -- $slot $sha $source $manifest $tree $tools" <<'REMOTE'
set -Eeuo pipefail
slot=$1; sha=$2; source=$3; manifest=$4; tree=$5; tools=$6
exec 8>>/opt/aimine/.ops/release-channel.lock
flock -n 8
ids=$(docker ps -aq --filter label=com.docker.compose.project=amp-preview --filter label=com.docker.compose.service=reader)
if [[ -n $ids ]]; then docker rm -f $ids; fi
if compgen -G "/opt/aimine/.ops/release-${sha:0:12}-*.json" >/dev/null; then
  echo 'A deployment journal for this SHA already exists; inspect it before another release' >&2
  exit 1
fi
printf '%s  %s\n' "$source" "$slot/files/source.tar.gz" | sha256sum --check --status
tar -xzf "$slot/files/source.tar.gz" -C "$tools" --strip-components=1
bash "$tools/deploy/production-release.sh" "$sha" "$slot/files/source.tar.gz" "$source" "$slot/files" "$manifest" "$tree"
REMOTE
phase=public-check
version=$(curl -fsS --max-time 30 "$base/api/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] is True and d["db"]=="ok"; print(d["release"])')
[[ $version == "${sha:0:12}" ]] || { echo 'Public version differs from the release' >&2; exit 1; }
remote "docker exec amp-web-1 node scripts/smoke.ts --base $base --private-base http://127.0.0.1:3000"
if [[ -n ${AIMINE_RELEASE_CHECK:-} ]]; then "$AIMINE_RELEASE_CHECK" "$sha" "$base"; fi
free=$(remote "python3 -c 'import os; s=os.statvfs(\"/opt/aimine\"); print(s.f_bavail*s.f_frsize)'")
[[ $free =~ ^[0-9]+$ ]] && (( free >= 8053063680 )) || { echo 'Release disk below 7.5 GiB' >&2; exit 1; }
printf '已发布 %s，公网版本与冒烟核对通过。\n%s\n传输 %s 字节，历时 %s 秒，发布后可用 %s 字节；下一步由 Owner 核对读者效果。\n' \
  "$version" "${AIMINE_READER_CHANGE:-读者变化见本次发布说明。}" "$sent" "$((SECONDS - start))" "$free"
