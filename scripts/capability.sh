#!/bin/sh
# Run the capability kernel's operator surface inside the deployed container.
# Same reason as admin.sh and fleet.sh: `flyctl ssh console -C` opens a session
# in `/`, and every path this script resolves is relative to the application.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/capability.ts "$@"
