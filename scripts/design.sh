#!/bin/sh
# Run the design kernel's operator surface inside the deployed container.
# Same reason as admin.sh, fleet.sh and capability.sh: `flyctl ssh console -C`
# opens a session in `/`, and every path this script resolves is relative to the
# application.
#
# Rendering is deliberately not reachable this way and would not work if it
# were: `cycle`, `resume` and `render` need a headless browser and a running
# product, and the deployed image has neither. What this shim carries is the
# half that reads rows — the report, the surfaces, the findings, the expansion
# loop, and `route`, which offers a landed change to the classifier.
set -e
cd "$(dirname "$0")/.."
exec node --import tsx scripts/design.ts "$@"
