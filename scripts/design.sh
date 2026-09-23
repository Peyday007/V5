#!/bin/sh
# Run the design kernel's operator surface inside the deployed container.
# Same reason as admin.sh, fleet.sh and capability.sh: `flyctl ssh console -C`
# opens a session in `/`, and every path this script resolves is relative to the
# application.
#
# Rendering is deliberately not reachable this way and would not work if it
# were: `cycle`, `resume` and `render` need a headless browser and a running
# product, and the deployed image has neither. What this shim carries is the
# half that reads rows — the report, the surfaces, the findings, the expansion
# loop, and `route`, which offers a landed change to the classifier.
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

exec node --import tsx scripts/design.ts "$@"
