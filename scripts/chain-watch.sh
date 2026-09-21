#!/bin/sh
# Run the chain reader inside the deployed container.
#
# `flyctl ssh console -C` opens a session in `/`, and `node --import tsx`
# resolves `tsx` relative to the working directory — so the obvious one-liner
# fails with a module-resolution error that looks nothing like its cause. Same
# reason `step10.sh` and `verify-hosted.sh` exist.
#
# Usage:  sh /app/scripts/chain-watch.sh [rcv_…]
set -e
cd "$(dirname "$0")/.."
CHAIN_CONVERSATION="${1:-}"
export CHAIN_CONVERSATION
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

exec node --import tsx scripts/chain-watch.ts
