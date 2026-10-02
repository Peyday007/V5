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

# One connection, because this is a read beside a running app.
#
# `labor-report.sh` carries this already and the reasoning is its own, measured
# in production: the Supabase pooler has a shared 15-client limit, and a script
# whose pool opens several clients at once loses to one that opens a single
# client. This script had no pool setting at all, so it took the default of ten
# — and on 2026-09-21 at 05:43, read beside a deploy's own verification, it
# printed the whole sprint and then died on its last query with
# `EMAXCONNSESSION ... pool_size: 15`.
#
# It is the dealflow kernel's only production reading, which makes it exactly
# the report somebody wants when the app is busy. A reading nobody can take
# while the thing it reads is working is not a reading.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
# With one client, the roadmap's bounded fan-out queues its reads behind each
# other, and the default ten-second wait turned that queue into a failure:
# 2026-10-01 15:45Z, "1/1 connection(s) in use, 2 caller(s) waiting" inside
# `cashRoadmap`, after the sprint and its authorization had already printed.
# `factory.sh` met the same shape on 2026-09-30 and took the same remedy. A
# longer wait is patience, not more load.
export BRAIN_DATABASE_CONNECT_TIMEOUT_MS="${BRAIN_DATABASE_CONNECT_TIMEOUT_MS:-60000}"

# Which container this came out of.
#
# `labor-report.sh`'s reason, and it applies to every operator read: a report
# out of a container says nothing about *which* container unless the container
# says which commit it was built from, and the deployment system's label is a
# claim about what it asked for rather than a reading of what is serving.
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"

exec node --import tsx scripts/cash-report.ts "$@"
