#!/bin/sh
# Run the social commerce kernel's operator surface inside the deployed container.
# Same reason as admin.sh, fleet.sh, capability.sh and manufacturing.sh:
# `flyctl ssh console -C` opens a session in `/`, and every path this script
# resolves is relative to the application.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/commerce.ts "$@"
