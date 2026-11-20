#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
root=${AIMINE_ROOT:-/opt/aimine}
case ${1:-} in
  up)
    [[ $# == 2 || $# == 3 ]] || exit 2
    hours=${3:-2}
    [[ $hours =~ ^([1-9]|1[0-9]|2[0-4])$ ]] || { echo 'Hours must be 1–24' >&2; exit 2; }
    exec 8>>"$root/.ops/release-channel.lock"
    flock -n 8 || { echo 'Release in progress' >&2; exit 1; }
    exec 9<"$root/.ops/release.lock"
    flock -n 9 || { echo 'Release in progress' >&2; exit 1; }
    awk '/^MemAvailable:/ {ok=$2 >= 1048576} END {exit !ok}' /proc/meminfo || { echo 'Less than 1 GiB available' >&2; exit 1; }
    [[ $2 =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'A full immutable image ID is required' >&2; exit 2; }
    image=$(docker image inspect --format '{{.Id}}' -- "$2")
    [[ $image == "$2" ]] || { echo 'Local image ID differs from the requested ID' >&2; exit 1; }
    PREVIEW_IMAGE_HEX=${image#sha256:}
    PREVIEW_EXPIRES=$(( $(date +%s) + hours * 3600 ))
    export PREVIEW_IMAGE_HEX PREVIEW_EXPIRES
    compose=(docker compose --project-name amp-preview --env-file "$root/.env" -f compose.yml)
    cleanup_failed_start() {
      code=$?
      trap - EXIT
      "${compose[@]}" down || echo 'Failed to close the preview project' >&2
      exit "$code"
    }
    trap cleanup_failed_start EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    "${compose[@]}" up -d --no-build --pull never --wait
    trap - EXIT INT TERM
    ;;
  down|status)
    # Inspect by project labels. Neither command needs credentials or a candidate image.
    id=$(docker ps -aq --filter label=com.docker.compose.project=amp-preview --filter label=com.docker.compose.service=reader)
    if [[ -z $id ]]; then echo 'Preview off'; exit 0; fi
    [[ $id != *$'\n'* ]] || { echo 'Ambiguous preview containers' >&2; exit 1; }
    if [[ $1 == down ]]; then docker rm -f "$id" >/dev/null; echo 'Preview off'; exit 0; fi
    if [[ $(docker inspect --format '{{.State.Running}}' "$id") != true ]]; then echo 'Preview off'; exit 0; fi
    deadline=$(docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "PREVIEW_EXPIRES"}}{{index (split . "=") 1}}{{end}}{{end}}' "$id")
    reader=$(docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "READER_IMPL"}}{{index (split . "=") 1}}{{end}}{{end}}' "$id")
    echo "Preview running, reader=${reader:-image-default}, $((deadline - $(date +%s))) seconds remaining"
    ;;
  *) echo 'Usage: preview.sh up IMAGE [HOURS] | down | status' >&2; exit 2 ;;
esac
