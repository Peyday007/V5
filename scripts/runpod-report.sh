#!/bin/sh
# Free-lane research jobs by model over the last hours, read inside the container:
# whether the RunPod GPU (slot `runpod/...`) is doing research jobs. Read-only.
#
# Usage:  sh /app/scripts/runpod-report.sh [--hours 6]
set -e
cd "$(dirname "$0")/.."
# One connection: a read beside a running app (see labor-report.sh).
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
export BRAIN_DATABASE_CONNECT_TIMEOUT_MS="${BRAIN_DATABASE_CONNECT_TIMEOUT_MS:-60000}"
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/runpod-report.ts "$@"
