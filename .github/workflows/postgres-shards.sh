#!/usr/bin/env bash
#
# Proves the Postgres suite's shards ran the whole suite: every test file vitest
# would run was run by exactly one shard, and no shard ran a file the whole
# suite does not hold.
#
# Sharding is what made the gate fit inside a release cycle, and it is also the
# one change that could quietly shrink it: a file in no shard is a file nobody
# ran, and every shard would still report success. So this does not trust
# `--shard` to partition. It compares what each shard's JSON report says it
# actually ran against the list of the whole suite.
#
# Why reports rather than `vitest list --shard`: in vitest 2.1 `list` ignores
# `--shard` and prints every file for every shard — measured, 312 of 312 four
# times. A check built on it fails every run, and one that tolerated it would
# prove nothing. What a shard ran is the evidence.
#
# An empty listing is a failure, never a match: two empty lists are equal, and a
# check that passes because vitest could not start is no check at all.
#
# Usage:
#   postgres-shards.sh all <out>                  the whole suite, one file per line
#   postgres-shards.sh ran <report.json> <out>    the files one shard's report ran
#   postgres-shards.sh check <all> <ran>...       exit 0 iff the ran lists partition all
set -uo pipefail

nonempty() {
  if [ ! -s "$1" ]; then
    echo "::error::$2"
    exit 1
  fi
}

case "${1:-}" in
  all)
    out="${2:?output file}"
    # `vitest list --filesOnly` runs no test and prints paths relative to the root.
    npx vitest list --filesOnly | sed 's/\r$//' | grep -E '\.test\.tsx?$' | sort -u > "$out" \
      || { echo "::error::vitest could not list the suite."; exit 1; }
    nonempty "$out" "vitest listed no test files; a partition of nothing proves nothing."
    echo "the whole suite: $(wc -l < "$out") file(s)"
    ;;
  ran)
    report="${2:?a vitest JSON report}"; out="${3:?output file}"
    if [ ! -s "$report" ]; then
      echo "::error::No JSON report at $report: this shard did not finish, so nothing says what it ran."
      exit 1
    fi
    node -e '
      const path = require("node:path");
      const r = require(path.resolve(process.argv[1]));
      const files = (r.testResults || []).map((t) => path.relative(process.cwd(), t.name).split(path.sep).join("/"));
      process.stdout.write(files.sort().join("\n") + (files.length ? "\n" : ""));
    ' "$report" > "$out" || { echo "::error::The report at $report could not be read."; exit 1; }
    nonempty "$out" "The report at $report ran no test files."
    echo "this shard ran $(wc -l < "$out") file(s)"
    ;;
  check)
    all="${2:?the whole-suite list}"; shift 2
    [ "$#" -ge 1 ] || { echo "::error::No shard lists to check."; exit 1; }
    nonempty "$all" "The whole-suite list is empty."
    union=$(mktemp); trap 'rm -f "$union"' EXIT
    for list in "$@"; do
      nonempty "$list" "Shard list $list is empty."
      echo "$list: $(wc -l < "$list") file(s)"
      cat "$list" >> "$union"
    done
    dupes=$(sort "$union" | uniq -d)
    if [ -n "$dupes" ]; then
      echo "::error::These test files ran in more than one shard:"
      echo "$dupes"
      exit 1
    fi
    if ! d=$(diff <(sort "$union") <(sort "$all")); then
      echo "::error::The shards did not run the whole suite ('<' ran but is not in the suite, '>' ran in no shard):"
      echo "$d"
      exit 1
    fi
    echo "POSTGRES-SHARDS: PARTITION $(wc -l < "$all") file(s) across $# shard(s), each exactly once"
    ;;
  *)
    echo "usage: postgres-shards.sh all <out> | ran <report.json> <out> | check <all> <ran>..." >&2
    exit 2
    ;;
esac
