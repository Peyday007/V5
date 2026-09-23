#!/bin/sh
# Print the decision brief for every recorded objective inside the deployed
# container. Read-only; see `scripts/decision-report.ts`.
#
# Usage:  sh /app/scripts/decision-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."

# One connection, because this is a read beside a running app (see
# `cash-report.sh` for the measured reason).
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

# Which container this came out of.
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"

exec node --import tsx scripts/decision-report.ts "$@"
