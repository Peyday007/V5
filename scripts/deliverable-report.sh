#!/bin/sh
# Print every deliverable, its versions, checks, review and delivery, inside
# the deployed container; with --verify, re-read and open each stored file.
#
# Same shape as `labor-report.sh`: cd to the app, one pooler client because
# this is a read beside a running app, and the serving revision first.
#
# Usage:  sh /app/scripts/deliverable-report.sh [--project prj_x] [--deliverable dlv_x] [--verify]
set -e
cd "$(dirname "$0")/.."
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/deliverable-report.ts "$@"
