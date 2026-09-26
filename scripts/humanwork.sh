#!/bin/sh
# Work done through people, inside the deployed container. See scripts/humanwork.ts.
set -e
cd "$(dirname "$0")/.."
# One connection: a read or a single write beside a running app (§39, §45).
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/humanwork.ts "$@"
