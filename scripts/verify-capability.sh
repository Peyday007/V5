#!/bin/sh
# Judge one packet against the capability contract, inside the deployed container.
#
# Same shape and same reason as `packet-report.sh`: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# Read-only. It prints a pass/fail line per clause and exits non-zero if any
# clause failed, so a workflow can gate on it without a person reading it.
#
# Usage:  sh /app/scripts/verify-capability.sh --orchestration orc_xxx
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/verify-research-capability.ts "$@"
