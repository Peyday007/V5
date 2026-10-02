#!/bin/sh
# Run the social commerce kernel's operator surface inside the deployed container.
# Same reason as admin.sh, fleet.sh, capability.sh and manufacturing.sh:
# `flyctl ssh console -C` opens a session in `/`, and every path this script
# resolves is relative to the application.
set -e
cd "$(dirname "$0")/.."

# One connection, for `labor-report.sh`'s measured reason: a kernel snapshot
# reads five tables through `Promise.all`, so a pool of two opens two Supabase
# pooler clients at once against a shared fifteen-client limit, and an operator
# command run beside a running app should take the smallest footprint on that
# limit it can. A pool of one makes the five sequential.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

# The running artifact's own commit, first, for `labor-report.sh`'s reason: a
# reading taken out of a container says nothing about *which* container unless
# the container says which commit it was built from, and the deployment
# system's label is a claim about what it asked for rather than a reading of
# what is serving.
echo "SERVING_REVISION ${BRAIN_REVISION:-<unstamped>}"
exec node --import tsx scripts/commerce.ts "$@"
