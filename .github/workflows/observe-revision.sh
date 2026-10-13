#!/usr/bin/env bash
#
# What is actually running, read from the machine rather than from an exit code.
#
# ---------------------------------------------------------------------------
# Why (INF-7)
# ---------------------------------------------------------------------------
#
# `flyctl deploy` exiting non-zero was read as "nothing was released", and the
# verdict printed "the app is still serving the previous version". Deploys 424,
# 453 and 454 said exactly that while processes on the new revisions were
# visible in the connection report — 4bff1c2 applied migration 106 at 16:21Z.
# On one machine a rolling update can leave the new image in place after the
# health-check wait gives up, and `server/bootRetry.ts` then brings it up
# minutes later. So `deployed/production` was not moved, the rollback guard
# compared against a stale tag, and `factory-release` read a false fact.
#
# An exit code is a fact about the CLI. What is running is a fact about the
# machine, and this asks the machine.
#
# ---------------------------------------------------------------------------
# Two facts, never one
# ---------------------------------------------------------------------------
#
# The revision is the image's own `BRAIN_REVISION`, read inside the machine.
# That establishes which image the machine holds, and nothing more: an image
# selected is not an image serving, so `/healthz` answering 200 from outside is
# the second fact. With both, the new revision is serving. Neither says its
# verification passed — that is the hosted verification's answer, and a deploy
# that failed never ran it.
#
#   NEW_SERVING       the machine holds this commit and the Brain answers
#   NEW_NOT_SERVING   the machine holds this commit and has not answered yet:
#                     an incomplete rollout, or a boot still retrying
#   PREVIOUS_SERVING  the machine holds the last released commit
#   OTHER             the machine holds some other commit, named
#   UNKNOWN           the machine could not be read; nothing is claimed,
#                     least of all "the previous version"
#
# Bounded: a boot whose cloud proof failed retries on a doubling wait capped at
# five minutes, so a new image is watched for up to the window before it is
# called NOT_SERVING. A machine holding the previous image does not become the
# new one by waiting, so two agreeing readings end it.
#
# It lives in `.github/workflows/` for canonical-guard.sh's reason: a campaign
# may not own what decides what a deploy reports.
#
# Usage: observe-revision.sh <intended-sha> <previously-released-sha|""> [window-seconds]
# Prints one line `DEPLOY-OUTCOME: <class> running=<sha|unknown> healthz=<code>`
# and, under GitHub Actions, writes `outcome` and `running` to $GITHUB_OUTPUT.
set -uo pipefail

intended="${1:?the commit this run deployed}"
previous="${2:-}"
window="${3:-900}"
app=$(grep -m1 '^app = ' fly.toml | cut -d'"' -f2)

read_revision() {
  timeout 90 flyctl ssh console --app "$app" -C "printenv BRAIN_REVISION" 2>/dev/null \
    | tr -d '\r' | grep -E '^[0-9a-f]{40}$' | tail -n 1
}

classify() {
  local running="$1" code="$2"
  if [ -z "$running" ]; then echo UNKNOWN; return; fi
  if [ "$running" = "$intended" ]; then
    if [ "$code" = "200" ]; then echo NEW_SERVING; else echo NEW_NOT_SERVING; fi
    return
  fi
  if [ -n "$previous" ] && [ "$running" = "$previous" ]; then echo PREVIOUS_SERVING; return; fi
  echo OTHER
}

deadline=$(( $(date +%s) + window ))
outcome=UNKNOWN
running=""
code=000
last=""
agreeing=0
while :; do
  running=$(read_revision || true)
  code=$(curl -s -o /dev/null -m 40 -w '%{http_code}' "https://$app.fly.dev/healthz" || true)
  outcome=$(classify "$running" "$code")
  echo "reading: running=${running:-unknown} healthz=${code:-000} -> $outcome"
  [ "$outcome" = "NEW_SERVING" ] && break
  if [ "$outcome" = "PREVIOUS_SERVING" ] || [ "$outcome" = "OTHER" ]; then
    if [ "$outcome:$running" = "$last" ]; then agreeing=$((agreeing + 1)); else agreeing=1; fi
    [ "$agreeing" -ge 2 ] && break
  fi
  last="$outcome:$running"
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "${OBSERVE_POLL_SECONDS:-30}"
done

echo "DEPLOY-OUTCOME: $outcome running=${running:-unknown} healthz=${code:-000}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "outcome=$outcome" >> "$GITHUB_OUTPUT"
  echo "running=${running:-unknown}" >> "$GITHUB_OUTPUT"
fi
