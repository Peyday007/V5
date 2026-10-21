#!/bin/sh
# Run the commerce kernel's operator surface inside the deployed container
# (§73). Same reason as manufacturing.sh: `flyctl ssh console -C` opens a
# session in `/`, and every path this script resolves is relative to the app.
set -e
cd "$(dirname "$0")/.."

# One pooler client, for manufacturing.sh's measured reason: the pooler's
# fifteen clients are shared with the running app, and a reading with no
# setting takes ten. `${…:-1}` so a call site can still raise it.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

exec node --import tsx scripts/commerce.ts "$@"
