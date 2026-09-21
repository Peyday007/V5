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

# Which container this came out of.
#
# `labor-report.sh`'s reason, and it applies to every operator read: a report
# out of a container says nothing about *which* container unless the container
# says which commit it was built from, and the deployment system's label is a
# claim about what it asked for rather than a reading of what is serving.
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"

exec node --import tsx scripts/cash-report.ts "$@"
