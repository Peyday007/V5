#!/bin/sh
# Run the chain reader inside the deployed container.
#
# `flyctl ssh console -C` opens a session in `/`, and `node --import tsx`
# resolves `tsx` relative to the working directory — so the obvious one-liner
# fails with a module-resolution error that looks nothing like its cause. Same
# reason `step10.sh` and `verify-hosted.sh` exist.
#
# Usage:  sh /app/scripts/chain-watch.sh [rcv_…]
set -e
cd "$(dirname "$0")/.."
CHAIN_CONVERSATION="${1:-}"
export CHAIN_CONVERSATION
exec node --import tsx scripts/chain-watch.ts
