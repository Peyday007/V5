/**
 * The release workflow's own reading of a diff (CLAUDE.md §58).
 *
 * Reads changed paths, one per line, on stdin — the workflow produces them with
 * `git diff --name-only` between the canonical branch and the pull request's
 * head — and prints one verdict line the workflow greps for:
 *
 *   RELEASE-ELIGIBILITY: ELIGIBLE <n> file(s)
 *   RELEASE-ELIGIBILITY: MANUAL <reasons>
 *
 * The workflow runs this file from the **canonical branch's** checkout, never
 * from the pull request's, so a change cannot rewrite the rule it is judged by;
 * and this file is itself in the DEPLOYMENT_CONTROLS class, so a change to it
 * is manual by its own reading.
 */
import { readFileSync } from 'node:fs';
import { classifyRelease, describeReleaseReason } from '../server/services/factory/releaseEligibility.ts';

const input = readFileSync(0, 'utf8');
const paths = input.split('\n').map((line) => line.trim()).filter(Boolean);
const verdict = classifyRelease(paths);
for (const reason of verdict.reasons) process.stdout.write(`  ${describeReleaseReason(reason)}\n`);
if (verdict.eligible) {
  process.stdout.write(`RELEASE-ELIGIBILITY: ELIGIBLE ${verdict.paths.length} file(s)\n`);
} else {
  const classes = verdict.classes.length > 0 ? ` classes=${verdict.classes.join(',')}` : '';
  process.stdout.write(`RELEASE-ELIGIBILITY: MANUAL ${verdict.reasons.length} reason(s)${classes}\n`);
}
