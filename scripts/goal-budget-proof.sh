#!/bin/sh
# The live GOAL_BUDGET proof, inside the deployed container. See
# scripts/goal-budget-proof.ts; reached by .github/workflows/goal-budget-proof.yml.
set -e
cd "$(dirname "$0")/.."
# One pooler client, by default: this runs beside the app against a shared
# fifteen-client pooler, and it is sequential.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

exec node --import tsx scripts/goal-budget-proof.ts "$@"
