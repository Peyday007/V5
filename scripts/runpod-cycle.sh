#!/bin/sh
# Prove the RunPod pod's automatic power in production: stop it, watch the
# running Brain start it again for waiting research, wait until vLLM answers.
# Changes the pod's power only, and always leaves the pod started.
#
# Usage:  sh /app/scripts/runpod-cycle.sh
set -e
cd "$(dirname "$0")/.."
# One connection: a read beside a running app (see labor-report.sh).
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
export BRAIN_DATABASE_CONNECT_TIMEOUT_MS="${BRAIN_DATABASE_CONNECT_TIMEOUT_MS:-60000}"
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec nice -n 19 node --import tsx scripts/runpod-cycle.ts "$@"
