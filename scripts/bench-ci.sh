#!/usr/bin/env bash
# Run the planning bench on GitHub runners (.github/workflows/bench.yml) instead of
# this machine, and wait for its verdict.
#
#   scripts/bench-ci.sh REF [BASE] [--no-wait]
#
# REF is the branch, tag or commit to bench; BASE what to diff it against (default:
# the canonical branch). The workflow runs from REF when REF is a branch that has
# bench.yml, else from the canonical branch. Prints the run's URL, then — unless
# --no-wait — its conclusion and wall time; exits 0 only on a passing verdict.
# Level A/B developmental evidence: it never gates or stands in for Deploy.
set -euo pipefail
ref="${1:?usage: scripts/bench-ci.sh REF [BASE] [--no-wait]}"
base="${2:-}"
[ "$base" = --no-wait ] && base=""
wait=1
for a in "$@"; do [ "$a" = --no-wait ] && wait=0; done
repo="${BENCH_REPO:-$(git remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##; s#^.*/git/##')}"
canonical=$(cat "$(git rev-parse --show-toplevel)/.github/CANONICAL_BRANCH")
# The workflow file must exist on the ref it is dispatched on.
has_bench() { gh api "repos/$repo/contents/.github/workflows/bench.yml?ref=$1" --silent 2>/dev/null && gh api "repos/$repo/branches/$1" --silent 2>/dev/null; }
# REF itself, else the canonical branch, else this checkout's branch (before bench.yml is merged).
on="${BENCH_WORKFLOW_REF:-}"
if [ -z "$on" ]; then
  for candidate in "$ref" "$canonical" "$(git rev-parse --abbrev-ref HEAD)"; do
    if has_bench "$candidate"; then on="$candidate"; break; fi
  done
fi
[ -n "$on" ] || { echo "no branch with bench.yml to dispatch from; set BENCH_WORKFLOW_REF" >&2; exit 1; }
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh api -X POST "repos/$repo/actions/workflows/bench.yml/dispatches" -f ref="$on" -f "inputs[ref]=$ref" -f "inputs[base]=$base"
run=""
for _ in $(seq 1 30); do
  run=$(gh api "repos/$repo/actions/workflows/bench.yml/runs?event=workflow_dispatch&created=%3E%3D$since&per_page=5" --jq '.workflow_runs[0].id // empty')
  [ -n "$run" ] && break
  sleep 4
done
[ -n "$run" ] || { echo "dispatched, but no run appeared" >&2; exit 1; }
echo "bench run $run: https://github.com/$repo/actions/runs/$run"
[ "$wait" = 1 ] || exit 0
while :; do
  read -r status conclusion created updated < <(gh api "repos/$repo/actions/runs/$run" --jq '[.status, (.conclusion // "-"), .created_at, .updated_at] | @tsv')
  [ "$status" = completed ] && break
  sleep 20
done
secs=$(( $(date -d "$updated" +%s) - $(date -d "$created" +%s) ))
echo "bench run $run: $conclusion in ${secs} s"
[ "$conclusion" = success ]
