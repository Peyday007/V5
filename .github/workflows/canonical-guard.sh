#!/usr/bin/env bash
#
# The canonical-branch guard, in one file, asked twice.
#
# ---------------------------------------------------------------------------
# Why it is asked twice
# ---------------------------------------------------------------------------
#
# `deploy.yml`'s first job refuses a ref that is not the canonical branch, and
# refuses the canonical branch when the checkout is not its current tip. Both
# are right, and both were evaluated **once**, at the start of a run whose
# build and test gate takes ten minutes or more.
#
# So a deploy could go stale while it ran. Measured: a run dispatched at 04:27
# passed this guard legitimately — `production` genuinely was its SHA at
# 05:13:37 — and released that tree at about 05:30, six minutes after a
# fast-forward had moved the branch two commits on. Nothing was wrong with the
# ref and nothing was re-run; the checkout simply became behind while the job
# was in flight. That is §28's rollback reached by timing rather than by a
# stale dispatch, and a guard that asks before the build cannot see it.
#
# It is therefore asked again immediately before `flyctl deploy`, which is the
# instant the answer actually has to be true. One file rather than two copies,
# because a rule applied by one of two readers is worse than none — and these
# two would drift in the direction nobody notices, since the early one fails
# loudly on every branch and the late one fires only in a race.
#
# ---------------------------------------------------------------------------
# Why it compares the tip rather than counting commits
# ---------------------------------------------------------------------------
#
# `git rev-list --count HEAD..origin/<canonical>` needs history, and the deploy
# job checks out one commit. `git ls-remote` needs none, works identically in
# both jobs, and answers the stronger question: whether the ref *still names
# this tree*. Behind is refused, and so is a branch that was rewound — which
# §28 forbids anyway, and which a commit count silently passes.
#
# ---------------------------------------------------------------------------
# Where this file may live
# ---------------------------------------------------------------------------
#
# Inside `.github/workflows/`, deliberately. That directory is in the Software
# Factory's `forbiddenPaths`, as a directory rather than a filename, because
# §28's own lesson is that a second workflow is how a guard gets bypassed. A
# guard *script* the deploy sources is the same bypass one step along, so it
# lives where a campaign cannot own it. GitHub reads only `.yml`/`.yaml` here
# as workflows and ignores everything else.
#
# Usage: canonical-guard.sh <ref-name> <commit-sha> <when>
set -euo pipefail

ref="${1:?the ref name this run is on}"
sha="${2:?the commit this run is deploying}"
when="${3:-at the start of this run}"

canonical=$(tr -d '[:space:]' < .github/CANONICAL_BRANCH)
echo "canonical branch: $canonical"
echo "this ref:         $ref"
echo "this commit:      $sha"
echo "asked:            $when"

if [ "$ref" != "$canonical" ]; then
  echo "::error::Production deploys only from '$canonical'. This is '$ref'. Merge into $canonical and deploy that — a feature branch deploying directly is how an older tree overwrites a newer one."
  exit 1
fi

tip=$(git ls-remote origin "refs/heads/$canonical" | cut -f1)
if [ -z "$tip" ]; then
  echo "::error::Could not read origin/$canonical to check this checkout is still its tip. Refusing rather than guessing: a deploy that cannot prove which tree it is shipping is the one that rolls production back."
  exit 1
fi
echo "origin/$canonical: $tip"

if [ "$tip" != "$sha" ]; then
  echo "::error::origin/$canonical is now $tip, and this run is deploying $sha. Deploying it would put production back to a tree the branch has moved past. Re-dispatch against the current tip."
  exit 1
fi

echo "on $canonical, and still its tip. Proceeding."
