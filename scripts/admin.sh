#!/bin/sh
# Run the terminal administration surface inside the deployed container.
# Same reason as fleet.sh: `flyctl ssh console -C` opens a session in `/`.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/admin.ts "$@"
