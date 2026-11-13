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
# Lowest CPU priority. This runs beside the live server on a shared-cpu-2x
# machine, and compiling the factory's module graph through tsx took the CPU
# from it: on 2026-11-11 every Factory release pass (19:02:55, 19:08:55) was
# followed by the health check failing (19:04:57, 19:09:40), and the deploy's
# after-restart verification timed out three times running. The server keeps
# its requests; the operator command waits for idle CPU instead.
exec nice -n 19 node --import tsx scripts/factory.ts "$@"
