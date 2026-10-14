#!/bin/sh
# Starts the Forge bridge on 127.0.0.1:${FORGE_BRIDGE_PORT:-8765}.
set -e
cd "$(dirname "$0")"
FORGE_JAR="${FORGE_JAR:-$(cat ../forge/FORGE_JAR 2>/dev/null)}"
FORGE_ASSETS_DIR="${FORGE_ASSETS_DIR:-$(cat ../forge/FORGE_ASSETS_DIR 2>/dev/null)}"
FORGE_REVISION="${FORGE_REVISION:-$(cat ../forge/FORGE_REVISION 2>/dev/null)}"
HOME_DIR="${TUTOR_DATA_DIR:-../data}/forge-home"
mkdir -p "$HOME_DIR"
export FORGE_REVISION
exec java -Xmx${FORGE_BRIDGE_HEAP:-3g} -Djava.awt.headless=true -Duser.home="$(cd "$HOME_DIR" && pwd)" \
  -Dforge.assets="$FORGE_ASSETS_DIR" -cp "build/classes:$FORGE_JAR" tutor.bridge.BridgeServer
