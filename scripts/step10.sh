#!/bin/sh
# Run the Step 10 acceptance harness inside the deployed container.
#
# Exists for the same unglamorous reason `verify-hosted.sh` does: `flyctl ssh
# console -C` opens a session in `/`, and `node --import tsx` resolves `tsx`
# relative to the working directory, so the obvious one-liner fails with a
# module-resolution error that looks nothing like its cause.
#
# Usage:  sh /app/scripts/step10.sh report
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/step10.ts "$@"
