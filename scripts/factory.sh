#!/bin/sh
# Run the Software Factory operator surface inside the deployed container.
#
# Same shape and the same reason as `fleet.sh`: `flyctl ssh console -C` opens a
# session in `/`, and the CLI resolves paths relative to the repository root.
set -e
cd "$(dirname "$0")/.."
# Two connections, because this runs *beside* the server that is already holding
# most of the pooler's allowance. The hosted pooler caps a session-mode client at
# fifteen, the server takes what it needs, and a CLI that opened a default-sized
# pool of its own got FATAL (EMAXCONNSESSION) — a read refused for asking too
# much rather than for anything about the data. `verify-hosted.ts` does the same
# for the same reason.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-2}"
exec node --import tsx scripts/factory.ts "$@"
