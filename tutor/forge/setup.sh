#!/bin/sh
# Fetches and builds the pinned Forge revision, then compiles the tutor bridge against it.
#
#   tutor/forge/setup.sh [FORGE_DIR]
#
# Forge is GPL-3.0 (https://github.com/Card-Forge/forge). It is built from source rather than
# vendored: the checkout stays outside this repository, and its location is recorded in the
# FORGE_* files next to this script so the bridge and server can find it.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REV="$(cat "$HERE/FORGE_REVISION")"
DIR="${1:-${FORGE_DIR:-$HERE/../../../forge-src/forge}}"
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

if [ ! -d "$DIR/.git" ]; then
  git -C "$DIR" init -q
  git -C "$DIR" remote add origin https://github.com/Card-Forge/forge.git
fi
if [ "$(git -C "$DIR" rev-parse HEAD 2>/dev/null)" != "$REV" ]; then
  echo "Fetching Forge $REV ..."
  git -C "$DIR" fetch -q --depth 1 origin "$REV"
  git -C "$DIR" checkout -q --detach FETCH_HEAD
fi

echo "Building Forge (forge-gui-desktop and its modules; tests skipped) ..."
(cd "$DIR" && mvn -B -q -T 4 -DskipTests -Dcheckstyle.skip -Dmaven.javadoc.skip=true -pl forge-gui-desktop -am install)

JAR="$(ls "$DIR"/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar | head -1)"
echo "$JAR" > "$HERE/FORGE_JAR"
echo "$DIR/forge-gui/" > "$HERE/FORGE_ASSETS_DIR"
"$HERE/../bridge/build.sh"
echo "Forge $REV ready: $JAR"
