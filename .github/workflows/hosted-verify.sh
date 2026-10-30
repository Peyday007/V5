#!/usr/bin/env bash
# One hosted-verification pass, bounded, and honest about why it stopped.
#
# Usage: hosted-verify.sh <--leave-beacon|--check-beacon> <output file>
#
# Two things went wrong at once from 2026-10-21 and every real deploy paid for
# both: about ninety minutes, then a red run.
#
#   * Nothing bounded the pass but the step's own 45-minute limit. A pass that
#     normally takes two to four minutes ran to it twice per deploy.
#   * On 2026-10-30 the production machine was OOM-killed three minutes into the
#     post-restart pass (`exit_code=137, oom_killed=true`, 05:07:53Z) and
#     `flyctl ssh console` never noticed the remote end was gone, so the step sat
#     for another forty-two minutes and then reported a timeout — about a pass
#     that had stopped existing.
#
# So the pass gets a wall-clock bound well inside the step's, and when it does
# not end in a verdict the machine's own event log is read for an OOM kill or a
# restart during the pass and named, because "the machine ran out of memory"
# and "a check failed" have different remedies.
set -uo pipefail

flag="${1:?--leave-beacon or --check-beacon}"
out="${2:?output file}"
# A normal pass is two to four minutes; the slowest single step (the judge
# audit) was measured at 1m42s after its repair. Twenty minutes is generous and
# still leaves the step room to publish what it found.
limit="${HOSTED_VERIFY_LIMIT_SECONDS:-1200}"

app=$(grep -m1 '^app = ' fly.toml | cut -d'"' -f2)
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

timeout --signal=TERM --kill-after=30 "$limit" \
  flyctl ssh console --app "$app" \
    -C "sh /app/scripts/verify-hosted.sh https://$app.fly.dev $flag" \
  2>&1 | tee "$out"
status=${PIPESTATUS[0]}

if [ "$status" = "124" ] || [ "$status" = "137" ]; then
  echo "HOSTED-VERIFY-GUARD: the pass did not finish inside ${limit}s and was stopped." | tee -a "$out"
fi

if grep -q '^HOSTED-VERIFICATION: PASS' "$out"; then
  exit 0
fi

# Why it stopped, from the machine rather than from the pass.
events=$(for id in $(flyctl status --app "$app" --json 2>/dev/null | jq -r '.Machines[]?.id' 2>/dev/null); do
  flyctl machine status "$id" --app "$app" --display-config=false 2>/dev/null
done)
oom=$(printf '%s\n' "$events" | grep 'oom_killed=true' | awk -v s="$started" '{ for (i = 1; i <= NF; i++) if ($i ~ /^20[0-9][0-9]-/ && $i >= s) { print; break } }')
restarted=$(printf '%s\n' "$events" | grep -E '│ *restart *│|[[:space:]]restart[[:space:]]' | awk -v s="$started" '{ for (i = 1; i <= NF; i++) if ($i ~ /^20[0-9][0-9]-/ && $i >= s) { print; break } }')
if [ -n "$oom" ]; then
  echo "HOSTED-VERIFY-GUARD: the production machine was OOM-killed during this pass:" | tee -a "$out"
  printf '%s\n' "$oom" | tee -a "$out"
  echo "::error::The production machine ran out of memory during the hosted verification (oom_killed=true). The Brain restarted; this is a capacity fault, not a failed check."
elif [ -n "$restarted" ]; then
  echo "HOSTED-VERIFY-GUARD: the production machine restarted during this pass:" | tee -a "$out"
  printf '%s\n' "$restarted" | tee -a "$out"
fi
exit 1
