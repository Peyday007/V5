#!/bin/sh
# Read what each repaired surface says, inside the deployed container.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/closeout-verify.ts "$@"
