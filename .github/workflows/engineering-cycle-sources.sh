#!/usr/bin/env bash
# Collect the forge's record of one engineering-cycle window (§115) with `gh api`, as
# the one CycleSources JSON `npm run engineering -- cycle --stdin` reads — the same
# reads `fetchCycleSources` makes (server/services/engineering/cycle.ts), trimmed to
# the fields `domain/engineeringCycle.ts` uses so the payload is small enough to send.
#
#   .github/workflows/engineering-cycle-sources.sh REPO CANONICAL FROM TO > sources.json
#
# Needs GH_TOKEN (the workflow's own GITHUB_TOKEN). Reads only; writes stdout.
set -euo pipefail
repo="$1" canonical="$2" from="$3" to="$4"
printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || { echo "not owner/name: $repo" >&2; exit 1; }
printf '%s' "$canonical" | grep -Eq '^[A-Za-z0-9._/-]+$' || { echo "not a branch: $canonical" >&2; exit 1; }
for t in "$from" "$to"; do
  printf '%s' "$t" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' || { echo "not an ISO instant: $t" >&2; exit 1; }
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Workflow runs created since FROM, up to 20 pages of 100.
: > "$work/runs.jsonl"
for page in $(seq 1 20); do
  gh api "repos/$repo/actions/runs?per_page=100&page=$page&created=%3E%3D$from" \
    --jq '.workflow_runs[] | {id, name, event, status, conclusion, head_branch, head_sha, created_at, updated_at, run_attempt}' \
    > "$work/page.jsonl"
  cat "$work/page.jsonl" >> "$work/runs.jsonl"
  [ "$(wc -l < "$work/page.jsonl")" -lt 100 ] && break
done

# The jobs and steps of every completed Deploy run on the canonical branch.
echo '{}' > "$work/jobs.json"
for id in $(jq -r --arg b "$canonical" 'select(.name == "Deploy" and .head_branch == $b and .status == "completed") | .id' "$work/runs.jsonl"); do
  gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" \
    --jq '[.jobs[] | {name, conclusion, started_at, completed_at, steps: [(.steps // [])[] | {name, conclusion, started_at, completed_at}]}]' \
    > "$work/job.json"
  jq --arg id "$id" --slurpfile j "$work/job.json" '. + {($id): $j[0]}' "$work/jobs.json" > "$work/jobs.next" && mv "$work/jobs.next" "$work/jobs.json"
done

# Pull requests merged inside the window: closed, most recently updated first, up to 10 pages.
: > "$work/pulls.jsonl"
for page in $(seq 1 10); do
  gh api "repos/$repo/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=$page" > "$work/page.json"
  jq -c --arg from "$from" --arg to "$to" '.[] | select(.merged_at != null and .merged_at >= $from and .merged_at <= $to)
    | {number, created_at, merged_at, base: {ref: .base.ref}}' "$work/page.json" >> "$work/pulls.jsonl"
  # Sorted by update: once a page is entirely older than the window, nothing later is in it.
  if [ "$(jq length "$work/page.json")" -lt 100 ] || jq -e --arg from "$from" 'all(.[]; (.updated_at // "") < $from)' "$work/page.json" >/dev/null; then break; fi
done

# Each merged pull request's commits: the first commit's author date opens its cycle.
echo '{}' > "$work/commits.json"
for n in $(jq -r '.number' "$work/pulls.jsonl"); do
  if gh api "repos/$repo/pulls/$n/commits?per_page=100" \
    --jq '[.[] | {commit: {author: {date: .commit.author.date}, committer: {date: .commit.committer.date}}}]' > "$work/c.json" 2>/dev/null; then
    jq --arg n "$n" --slurpfile c "$work/c.json" '. + {($n): $c[0]}' "$work/commits.json" > "$work/commits.next" && mv "$work/commits.next" "$work/commits.json"
  fi
done

jq -n -c --arg repo "$repo" --arg b "$canonical" \
  --slurpfile runs "$work/runs.jsonl" --slurpfile pulls "$work/pulls.jsonl" \
  --slurpfile jobs "$work/jobs.json" --slurpfile commits "$work/commits.json" \
  '{repository: $repo, canonicalBranch: $b, runs: ($runs | unique_by(.id)), jobs: $jobs[0], pulls: ($pulls | unique_by(.number)), commits: $commits[0]}'
echo "collected $(wc -l < "$work/runs.jsonl") run(s), $(jq length "$work/jobs.json") Deploy run(s) with jobs, $(wc -l < "$work/pulls.jsonl") merged pull request(s)" >&2
