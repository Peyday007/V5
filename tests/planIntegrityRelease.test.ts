/**
 * Every release has its live plans checked, and the check cannot quietly fall
 * out of the release (owner, 2026-11-19: "add end-to-end acceptance checks to
 * the existing release process, using real planning outputs and evidence …
 * preserve these checks across future releases so previously corrected
 * failures cannot silently return").
 *
 * The check itself is `goals.sh check` (scripts/goals.ts), which reads every
 * active cash goal's plan on production and refuses on any plan-integrity
 * violation (server/domain/planIntegrity.ts). This file holds the wiring: both
 * kinds of Deploy reach it, and it stays read-only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the release checks the plans it released', () => {
  it('runs the check after a Deploy a person dispatched (workflow_run)', () => {
    const goals = read('.github/workflows/goals.yml');
    expect(goals).toMatch(/^  workflow_run:\n    workflows: \[Deploy\]\n    types: \[completed\]/m);
    // Only a successful release on the canonical branch has plans to check.
    expect(goals).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(goals).toContain(`github.event.workflow_run.head_branch == '${read('.github/CANONICAL_BRANCH').trim()}'`);
    // With no dispatch inputs the command is the check, never anything that changes state.
    expect(goals).toContain("G_COMMAND: ${{ inputs.command || 'check' }}");
  });

  it('runs the check after a Deploy the bot dispatched (hand-off)', () => {
    const deploy = read('.github/workflows/deploy.yml');
    const handOff = deploy.slice(deploy.indexOf('\n  hand-off:'));
    expect(handOff).toMatch(/gh workflow run goals\.yml [^\n]*-f command=check/);
    expect(handOff).toContain("if: ${{ needs.deploy.result == 'success' }}");
  });

  it('keeps the check read-only: no administrator, and its verdict is a printed line', () => {
    const goals = read('.github/workflows/goals.yml');
    expect(goals).toMatch(/\|plan\|check\|/);
    expect(goals).toContain('[ "$G_COMMAND" != check ]');
    expect(goals).toContain("grep -q '^GOALS: OK' goals.txt");
  });

  it('ends the check process once its verdict is printed, so a pass is never reported as a timeout', () => {
    // 2026-11-19 22:22: GOALS: OK printed, then background work held the process to the 30-minute step timeout.
    const script = read('scripts/goals.ts');
    const body = script.slice(script.indexOf('async function check()'), script.indexOf('async function construct()'));
    const ok = body.lastIndexOf("console.log('GOALS: OK')");
    expect(ok).toBeGreaterThan(0);
    expect(body.slice(ok)).toMatch(/process\.exit\(0\)/);
  });

  it('reads each goal in its own child process, killed at its bound, so one blocked read cannot time the whole check out', () => {
    // 2026-11-20 (check 44718014146): one goal's read held the event loop for twenty minutes; no in-process timer could fire.
    const script = read('scripts/goals.ts');
    const body = script.slice(script.indexOf('async function check()'), script.indexOf('async function construct()'));
    expect(body).toMatch(/BRAIN_CHECK_CHILD/);
    expect(body).toMatch(/checkInChild\(goalId/);
    // The kill is scripts/boundedChild.ts's, shared with `plan` (tests/boundedChild.test.ts runs it against real children).
    expect(body).toMatch(/runBoundedChild\(/);
    expect(read('scripts/boundedChild.ts')).toMatch(/child\.kill\('SIGKILL'\)/);
    expect(body).toMatch(/ERROR the plan read did not finish within/);
  });

  it('reads `goals plan` in a bounded child too, and ends it once its verdict is printed', () => {
    // 2026-11-21 (run 44935606985): goal C's read printed GOALS: OK at 18:29:39 and held the step to its 30-minute timeout.
    const script = read('scripts/goals.ts');
    const body = script.slice(script.indexOf('async function plan()'), script.indexOf('async function check()'));
    expect(body).toMatch(/BRAIN_PLAN_CHILD/);
    expect(body).toMatch(/runBoundedChild\(/);
    const ok = body.lastIndexOf("console.log('GOALS: OK')");
    expect(ok).toBeGreaterThan(0);
    expect(body.slice(ok)).toMatch(/process\.exit\(0\)/);
  });
});
