#!/bin/sh
# Run the gap-policy authorization inside the deployed container.
#
# Same reason `verify-hosted.sh` exists: `flyctl ssh console -C` opens a session
# in `/`, and `node --import tsx` resolves `tsx` relative to the working
# directory. A file takes no quotes at all, so the remote command stays plain
# words rather than nesting quotes through YAML, flyctl and a remote shell.
#
# Usage:  sh /app/scripts/authorize-gap-policy.sh --orchestration orc_xxx --admin someone@example.com
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

exec node --import tsx scripts/authorize-gap-policy.ts "$@"
