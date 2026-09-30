#!/bin/sh
# Run the Software Factory operator surface inside the deployed container.
#
# Same shape and the same reason as `fleet.sh`: `flyctl ssh console -C` opens a
# session in `/`, and the CLI resolves paths relative to the repository root.
set -e
cd "$(dirname "$0")/.."
# One pooler client, like every other wrapper here (§39): every command is
# sequential, and a statement inside a transaction goes to that transaction's
# own client rather than back to the pool. This read two until 2026-09-23, and
# its reads then failed four times running on a pooler connection timeout
# while the one-client goals read beside them succeeded.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
# With one client, a command that asks several reads at once queues them behind
# each other, and on a slow database the default ten-second wait turned every
# `factory line` into a pool timeout (2026-09-30, "1/1 in use, 4 waiting") while
# the Brain beside it was working. A longer wait is patience, not more load.
export BRAIN_DATABASE_CONNECT_TIMEOUT_MS="${BRAIN_DATABASE_CONNECT_TIMEOUT_MS:-60000}"
exec node --import tsx scripts/factory.ts "$@"
