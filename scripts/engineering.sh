#!/bin/sh
# Run the engineering connector's terminal surface inside the deployed
# container, so `report` reads production's own interventions and the MCP audit
# of who actually called the connector.
set -e
cd "$(dirname "$0")/.."
# One pooler client, like every other wrapper here (§39): every command is
# sequential.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"
exec node --import tsx scripts/engineering.ts "$@"
