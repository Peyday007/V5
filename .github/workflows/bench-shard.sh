#!/usr/bin/env bash
# One shard of the CI bench (bench.yml): check out SHA beside this checkout, score it
# with this checkout's harness (`bench/` and `scripts/bench.ts`), and write the shard's
# result JSON to OUT. Public cases only: no `--cases`, so no hidden case is ever read.
#
#   .github/workflows/bench-shard.sh SHA SHARD OUT LABEL
set -euo pipefail
sha="$1" shard="$2" out="$3" label="$4"
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || { echo "::error::not a commit: $sha"; exit 1; }
printf '%s' "$shard" | grep -Eq '^[0-9]+$' || { echo "::error::not a shard: $shard"; exit 1; }
here="$PWD"
tree="$RUNNER_TEMP/tree-$label"
git fetch --quiet --no-tags origin "$sha"
git worktree add --quiet --detach "$tree" "$sha"
# The same harness and cases on both sides; on a push the copy changes nothing.
rm -rf "$tree/bench" && cp -R "$here/bench" "$tree/bench" && cp "$here/scripts/bench.ts" "$tree/scripts/bench.ts"
cd "$tree"
started=$(date +%s)
npm ci --no-audit --no-fund --loglevel=error
installed=$(date +%s)
mkdir -p "$(dirname "$out")"
# A runner has nothing else to do: one case process per core.
npx tsx scripts/bench.ts --suite "${SUITE:-planningReliability}" --shard "$shard/${SHARDS:-4}" --workers "$(nproc)" \
  --out "$out" --ref "$label/${sha:0:12}/shard-$shard" --quiet
echo "$label shard $shard/${SHARDS:-4} @ ${sha:0:12}: npm ci $((installed - started)) s, bench $(( $(date +%s) - installed )) s"
