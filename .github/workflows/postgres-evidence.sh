#!/usr/bin/env bash
#
# Whether the commit being deployed has completed Postgres evidence (FAC-7).
#
# ---------------------------------------------------------------------------
# Why
# ---------------------------------------------------------------------------
#
# `postgres-suite.yml` cancelled in progress on the canonical branch, so a run
# was cancelled whenever another merge landed — 92 of 200 runs — and 4fcb143,
# b2e2589, 8cc6fab and 4bff1c2 were released with no completed Postgres run at
# all. Deploy's own test job is SQLite only, so nothing refused them.
#
# What counts, and nothing else:
#
#   * a `Postgres suite` run whose head is **this commit** that concluded
#     success; or
#   * a commit status `brain/postgres-suite` = success **on this commit**,
#     posted by `factory-release` only when the tree it merged is the tree its
#     gate ran the whole Postgres suite on.
#
# A descendant passing says nothing about this checkout, and a cancelled,
# skipped or failed run is not evidence. A failure on this commit fails. When
# there is no run and no status — a merge made by a workflow token raises no
# push event — one run is dispatched, on the canonical branch, which is this
# commit as long as this deploy is not superseded; it is never dispatched twice.
#
# Exit 0 PASS, 1 FAIL or no evidence by the deadline, 3 superseded.
#
# Usage: postgres-evidence.sh <commit-sha> [deadline-seconds]
set -uo pipefail

sha="${1:?the commit being deployed}"
deadline=$(( $(date +%s) + ${2:-9000} ))
interval="${EVIDENCE_POLL_SECONDS:-60}"
repo="${GITHUB_REPOSITORY:?}"
canonical=$(tr -d '[:space:]' < .github/CANONICAL_BRANCH)
ref="${GITHUB_REF_NAME:-$canonical}"
dispatched=no
started=$(date +%s)

verdict() {
  # Every run of the suite on this exact commit; the newest decides.
  local runs
  runs=$(gh api "repos/$repo/actions/workflows/postgres-suite.yml/runs?head_sha=$sha&per_page=20" \
    --jq '[.workflow_runs[] | {status, conclusion, id}]' 2>/dev/null) || { echo UNREADABLE; return; }
  if printf '%s' "$runs" | jq -e 'any(.[]; .status == "completed" and .conclusion == "success")' >/dev/null; then
    echo PASS; return
  fi
  local status
  status=$(gh api "repos/$repo/commits/$sha/status" \
    --jq '[.statuses[] | select(.context == "brain/postgres-suite")][0].state // ""' 2>/dev/null || true)
  if [ "$status" = "success" ]; then echo PASS; return; fi
  if printf '%s' "$runs" | jq -e 'any(.[]; .status != "completed")' >/dev/null; then echo PENDING; return; fi
  if printf '%s' "$runs" | jq -e 'any(.[]; .status == "completed" and .conclusion == "failure")' >/dev/null; then
    echo FAIL; return
  fi
  if [ "$status" = "failure" ] || [ "$status" = "error" ]; then echo FAIL; return; fi
  echo NONE
}

while :; do
  # Freshness is canonical-guard.sh's question, asked of the one file.
  "$(dirname "$0")/canonical-guard.sh" "$ref" "$sha" "while waiting for Postgres evidence" > "${RUNNER_TEMP:-/tmp}/guard.txt" 2>&1
  if [ $? = 3 ]; then
    cat "${RUNNER_TEMP:-/tmp}/guard.txt"
    echo "POSTGRES-EVIDENCE: SUPERSEDED"
    exit 3
  fi
  v=$(verdict)
  echo "reading: $v"
  case "$v" in
    PASS) echo "POSTGRES-EVIDENCE: PASS $sha"; exit 0 ;;
    FAIL) echo "::error::The whole suite against Postgres failed on $sha. It is not deployed."; echo "POSTGRES-EVIDENCE: FAIL $sha"; exit 1 ;;
    NONE)
      # Give a push-triggered run a few minutes to appear before asking for one.
      if [ "$dispatched" = no ] && [ $(( $(date +%s) - started )) -ge "${DISPATCH_AFTER_SECONDS:-300}" ]; then
        echo "No Postgres run and no attested status exist for $sha; dispatching one on $canonical."
        gh workflow run postgres-suite.yml -R "$repo" --ref "$canonical" -f reason="evidence for Deploy of $sha" \
          || echo "::warning::The Postgres suite could not be dispatched; waiting for any other evidence."
        dispatched=yes
      fi ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::No completed Postgres evidence for $sha by the deadline (last reading: $v). Nothing is deployed without it."
    echo "POSTGRES-EVIDENCE: NONE $sha"
    exit 1
  fi
  sleep "$interval"
done
