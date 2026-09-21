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
# One pooler client, by default.
#
# This runs *beside* a running app against a Supabase pooler with a shared
# fifteen-client limit, and the app already holds up to ten. Without this the
# adapter takes its own default of ten, and the reading dies with
# `(EMAXCONNSESSION) ... limited to pool_size: 15` at whichever statement
# happened to be running — which is to say, exactly when somebody wants it.
#
# Safe at one because every operator script here is sequential: none of them
# fans out over the database, and a statement inside a transaction goes to that
# transaction's own pinned client rather than back to the pool. A caller that
# genuinely needs more may still say so, which is what the default form is for.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

exec node --import tsx scripts/verify-research-capability.ts "$@"
