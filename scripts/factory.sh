#!/bin/sh
# Run the Software Factory operator surface inside the deployed container.
#
# Same shape and the same reason as `fleet.sh`: `flyctl ssh console -C` opens a
# session in `/`, and the CLI resolves paths relative to the repository root.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/factory.ts "$@"
