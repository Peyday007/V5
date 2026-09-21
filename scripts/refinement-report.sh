#!/bin/sh
# Print where every deep dive spent its time, inside the deployed container.
#
# Same shape as `cash-report.sh`, and the same reason: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# Usage:  sh /app/scripts/refinement-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."
# One connection, because this is a read beside a running app.
#
# The Supabase pooler has a shared fifteen-client limit and the app holds
# clients while it works, so a report that opens several at once loses to one
# that opens a single client — measured in production on `cash-report.sh`,
# which printed a whole sprint and then died on its last query with
# `EMAXCONNSESSION ... pool_size: 15`. A reading nobody can take while the
# thing it reads is working is not a reading.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

# Which container this came out of.
#
# A report out of a container says nothing about *which* container unless the
# container says which commit it was built from, and the deployment system's
# own label is a claim about what it asked for rather than a reading of what
# is serving.
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"

exec node --import tsx scripts/refinement-report.ts "$@"
