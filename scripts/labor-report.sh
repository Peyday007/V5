#!/bin/sh
# Print one project's labor map from the authoritative rows, inside the
# deployed container.
#
# Same shape as `cash-report.sh`, and the same reason: `flyctl ssh console -C`
# opens a session in `/`, so the script has to cd to the app before
# `node --import tsx` can resolve anything.
#
# It prints the running artifact's own `BRAIN_REVISION` first. That is not
# decoration: a report read out of a container says nothing about *which*
# container unless the container says which commit it was built from, and the
# deployment system's own label is a claim about what it asked for rather than
# a reading of what is serving.
#
# Usage:  sh /app/scripts/labor-report.sh [--project prj_xxx]
set -e
cd "$(dirname "$0")/.."

# One connection, because this is a read beside a running app.
#
# Measured in production rather than reasoned about: with the Supabase pooler
# at its shared 15-client limit, `cash-report` succeeded at 00:40 and this
# script failed at 00:41 on the same Brain, in the same minute, with
# `EMAXCONNSESSION`. The difference is not the pooler's state — it is that
# `laborSnapshot` fires seven reads through `Promise.all`, so a pool of two
# opens two pooler clients at once, and a script needing one got in where a
# script needing two did not.
#
# A pool of one makes those seven sequential. It costs a report a second and
# buys the ability to be read at all while the pooler is tight, which is
# exactly when somebody wants to read it. An operator report beside a running
# app should take the smallest footprint on a shared limit it can.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/labor-report.ts "$@"
