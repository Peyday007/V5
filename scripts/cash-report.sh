#!/bin/sh
# Print a Cash sprint's authoritative rows inside the deployed container.
#
# Same shape as `packet-report.sh`, and the same reason: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# Usage:  sh /app/scripts/cash-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/cash-report.ts "$@"
