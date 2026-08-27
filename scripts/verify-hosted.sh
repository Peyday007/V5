#!/bin/sh
# Run the hosted verification inside the deployed container.
#
# This exists for one unglamorous reason: `flyctl ssh console -C` opens a
# session in `/`, and `node --import tsx` resolves `tsx` relative to the working
# directory, so the obvious one-liner fails with a module-resolution error that
# looks nothing like its cause. Quoting a `cd` into the remote command means
# nesting quotes through YAML, flyctl and a remote shell, and each of those
# splits arguments slightly differently.
#
# A file takes no quotes at all. The remote command is three plain words.
#
# Usage:  sh /app/scripts/verify-hosted.sh https://your-brain.fly.dev
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/verify-hosted.ts "$@"
