#!/bin/sh
# Compiles the bridge against the Forge build made by ../forge/setup.sh.
set -e
cd "$(dirname "$0")"
FORGE_JAR="${FORGE_JAR:-$(cat ../forge/FORGE_JAR 2>/dev/null)}"
[ -f "$FORGE_JAR" ] || { echo "Forge jar not found; run tutor/forge/setup.sh first" >&2; exit 1; }
rm -rf build/classes && mkdir -p build/classes
javac --release 17 -nowarn -encoding UTF-8 -d build/classes -cp "$FORGE_JAR" $(find src -name '*.java')
echo "bridge compiled -> bridge/build/classes"
