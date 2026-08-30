#!/bin/sh
# Run the gap-policy authorization inside the deployed container.
#
# Same reason `verify-hosted.sh` exists: `flyctl ssh console -C` opens a session
# in `/`, and `node --import tsx` resolves `tsx` relative to the working
# directory. A file takes no quotes at all, so the remote command stays plain
# words rather than nesting quotes through YAML, flyctl and a remote shell.
#
# Usage:  sh /app/scripts/authorize-gap-policy.sh --orchestration orc_xxx --admin someone@example.com
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/authorize-gap-policy.ts "$@"
