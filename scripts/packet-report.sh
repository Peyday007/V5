#!/bin/sh
# Print one packet's authoritative rows inside the deployed container.
#
# Same shape as `authorize-gap-policy.sh`, and the same reason: `flyctl ssh
# console -C` opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# Usage:  sh /app/scripts/packet-report.sh --orchestration orc_xxx
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/packet-report.ts "$@"
