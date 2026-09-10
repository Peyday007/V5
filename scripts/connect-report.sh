#!/bin/sh
# Read the connector's rows inside the deployed container.
# Usage:  sh /app/scripts/connect-report.sh --project prj_xxx
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/connect-report.ts "$@"
