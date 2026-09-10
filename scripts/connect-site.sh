#!/bin/sh
# Run the connected-site preparation inside the deployed container.
#
# Same reason `authorize-gap-policy.sh` exists: `flyctl ssh console -C` opens a
# session in `/`, and `node --import tsx` resolves `tsx` relative to the working
# directory. A file takes no quotes at all, so the remote command stays plain
# words rather than nesting quotes through YAML, flyctl and a remote shell.
#
# Usage:  sh /app/scripts/connect-site.sh --project prj_xxx --admin someone@example.com
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/connect-site.ts "$@"
