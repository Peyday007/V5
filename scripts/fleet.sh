#!/bin/sh
# Run the Step 11 fleet operator surface inside the deployed container.
# Same reason as step10.sh: `flyctl ssh console -C` opens a session in `/`.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/fleet.ts "$@"
