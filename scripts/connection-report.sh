#!/bin/sh
# Print the connection system's state from the authoritative rows, inside the
# deployed container. Same shape as `labor-report.sh`: cd to the app, one pooler
# connection (a read beside a running app takes the smallest footprint on the
# shared session-mode limit it can), and the serving revision first.
#
# Usage:  sh /app/scripts/connection-report.sh [--hours 24]
set -e
cd "$(dirname "$0")/.."
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/connection-report.ts "$@"
