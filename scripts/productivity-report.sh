#!/bin/sh
# Print what the research fleet finished, by account, before and after a
# moment, from the authoritative rows inside the deployed container.
#
# Same shape as `labor-report.sh`: `flyctl ssh console -C` opens a session in
# `/`, so the script cds to the app first, takes one pooler connection because
# it is a read beside a running app, and prints the running artifact's own
# revision before anything else.
#
# Usage:  sh /app/scripts/productivity-report.sh [--hours 6] [--split ISO] [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/productivity-report.ts "$@"
