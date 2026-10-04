#!/usr/bin/env bash
# Behaviour baseline (handoff docs/04-architecture/04-aihot-adoption.md 7.3), captured on a clean
# checkout so a structural change can prove "no behaviour change" by diffing two baselines:
#   scripts/baseline/run.sh <out-dir>
#   diff -r <baseline-a> <baseline-b>
# Needs: DATABASE_URL naming a throwaway *_ci or *_test database (it is dropped and recreated),
# pg_dump on PATH, dependencies installed. No outside network, no model calls, nothing collected.
set -euo pipefail

out="${1:?usage: scripts/baseline/run.sh <out-dir>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
mkdir -p "$out/outputs"
out="$(cd "$out" && pwd)"

db_name="$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
case "$db_name" in
  *_ci|*_test) ;;
  *) echo "refusing to run: DATABASE_URL must name a *_ci or *_test database (got \"$db_name\")" >&2; exit 2 ;;
esac
admin_url="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";process.stdout.write(u.toString())')"

export SITE_URL="${SITE_URL:-http://127.0.0.1:3000}"
export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3001}"
export PRIVATE_API_BASE_URL="${PRIVATE_API_BASE_URL:-http://127.0.0.1:3002}"
export PUBLIC_RATE_LIMIT_SECRET="${PUBLIC_RATE_LIMIT_SECRET:-baseline-public-secret-0123456789abcdef}"
export SESSION_SECRET="${SESSION_SECRET:-baseline-session-secret-0123456789abcdef}"
export IMG_PROXY_SIGN_SECRET="${IMG_PROXY_SIGN_SECRET:-baseline-img-secret-0123456789abcdef}"

# Test results only (names, outcome, totals) without timings, so two runs of the same code compare equal.
strip_timings() { grep -E '^(✔|✖|﹣|ℹ) ' | sed -E -e 's/ \([0-9.]+m?s\)$//' -e '/^ℹ duration_ms/d'; }

echo "== fresh database $db_name"
psql "$admin_url" -qX -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$db_name\"" -c "CREATE DATABASE \"$db_name\""
node scripts/migrate.ts > "$out/migrate.txt"
node scripts/seed.ts --topics-only >> "$out/migrate.txt"

echo "== schema"
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" \
  | grep -v -E '^(-- Dumped (from|by)|\\restrict |\\unrestrict )' > "$out/schema.sql"

echo "== routes, queues, schedules"
node scripts/baseline/capture.ts "$out" > /dev/null

echo "== built site: machine outputs, smoke, MCP check"
pnpm --filter @amp/web build > /dev/null
# The site runs with collection and model calls off; the tests below use their own local stubs.
node scripts/verify/site-process.ts validate
pids=()
cleanup_site() {
  if [ "${#pids[@]}" -gt 0 ]; then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
    pids=()
  fi
}
trap cleanup_site EXIT
for role in public-api private-api web; do
  node scripts/verify/site-process.ts "$role" > "$out/.$role.log" 2>&1 &
  pids+=("$!")
done
for _ in $(seq 1 60); do
  curl -fsS --max-time 1 -o /dev/null "$SITE_URL/api/health" 2>/dev/null && curl -fsS --max-time 1 -o /dev/null "$PRIVATE_API_BASE_URL/api/health" 2>/dev/null && break
  sleep 1
done
node scripts/verify/api-split.ts "$SITE_URL" "$API_BASE_URL" "$PRIVATE_API_BASE_URL" > "$out/api-split.txt" 2>&1
for p in /openapi-v1.json /llms.txt /robots.txt /manifest.webmanifest; do
  curl -fsS "$SITE_URL$p" -o "$out/outputs/$(basename "$p")"
done
(cd "$out/outputs" && sha256sum -- * > ../outputs.sha256)
set +e
node scripts/smoke.ts --base "$SITE_URL" > "$out/smoke.txt" 2>&1
echo "exit $?" >> "$out/smoke.txt"
node scripts/mcp-check.ts "$SITE_URL/api/mcp" 2>&1 | grep -v -E '^\s+at |^Node\.js v|file://|^\s*\^\s*$|^\s+return ' > "$out/mcp-check.txt"
echo "exit ${PIPESTATUS[0]}" >> "$out/mcp-check.txt"
set -e
cleanup_site
trap - EXIT
rm -f "$out/.public-api.log" "$out/.private-api.log" "$out/.web.log"

echo "== tests"
set +e
env -i PATH="$PATH" HOME="$HOME" TZ="${TZ:-UTC}" node --test apps/web/tests/*.test.ts 2>&1 | strip_timings > "$out/tests-web.txt"
echo "exit ${PIPESTATUS[0]}" >> "$out/tests-web.txt"
node scripts/verify/test-files.ts 2>&1 | strip_timings > "$out/tests-backend.txt"
echo "exit ${PIPESTATUS[0]}" >> "$out/tests-backend.txt"
set -e

grep -h '^exit ' "$out"/smoke.txt "$out"/mcp-check.txt "$out"/tests-web.txt "$out"/tests-backend.txt | paste -sd' ' | sed 's/^/results: smoke, mcp-check, web tests, backend tests -> /'
echo "baseline written to $out"
