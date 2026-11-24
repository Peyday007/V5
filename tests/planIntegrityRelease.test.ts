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
    const script = read('scripts/goalsCli.ts');
    const body = script.slice(script.indexOf('async function check()'), script.indexOf('async function construct()'));
    const ok = body.lastIndexOf("console.log('GOALS: OK')");
    expect(ok).toBeGreaterThan(0);
    expect(body.slice(ok)).toMatch(/process\.exit\(0\)/);
    // The parent that spawned the reads prints the verdict and ends too.
    const entry = read('scripts/goals.ts');
    expect(entry).toMatch(/command === 'check'\) return exitAfterFlush\(/);
    expect(entry.slice(entry.indexOf('function exitAfterFlush('))).toMatch(/process\.exit\(code\)/);
  });

  it('reads each goal in its own child process, killed at its bound, so one blocked read cannot time the whole check out', () => {
    // 2026-11-20 (check 44718014146): one goal's read held the event loop for twenty minutes; no in-process timer could fire.
    const script = read('scripts/goals.ts');
    const body = script.slice(script.indexOf('async function checkGoals('), script.indexOf('async function main()'));
    expect(body).toMatch(/BRAIN_CHECK_CHILD/);
    expect(body).toMatch(/checkInChild\(goalId/);
    // The kill is scripts/boundedChild.ts's, shared with `plan` (tests/boundedChild.test.ts runs it against real children).
    expect(body).toMatch(/runBoundedChild\(/);
    expect(read('scripts/boundedChild.ts')).toMatch(/child\.kill\('SIGKILL'\)/);
    expect(read('scripts/boundedChild.ts')).toMatch(/the plan read did not finish within/);
  });

  it('reads `goals plan` in a bounded child too, and ends it once its verdict is printed', () => {
    // 2026-11-21 (run 44935606985): goal C's read printed GOALS: OK at 18:29:39 and held the step to its 30-minute timeout.
    const entry = read('scripts/goals.ts');
    const parent = entry.slice(entry.indexOf('async function planGoal('), entry.indexOf('async function checkGoals('));
    expect(parent).toMatch(/BRAIN_PLAN_CHILD/);
    expect(parent).toMatch(/runBoundedChild\(/);
    const script = read('scripts/goalsCli.ts');
    const body = script.slice(script.indexOf('async function plan()'), script.indexOf('async function check()'));
    const ok = body.lastIndexOf("console.log('GOALS: OK')");
    expect(ok).toBeGreaterThan(0);
    expect(body.slice(ok)).toMatch(/process\.exit\(0\)/);
    // 2026-11-21 (run 44960240885): the plan was printed, then the search listing after it never
    // finished, so no verdict. The listing, and closing the pool, are waited on only for a bound.
    const listing = body.indexOf('finishesWithin(PLAN_LISTING_MS');
    expect(listing).toBeGreaterThan(0);
    expect(body.slice(listing, ok)).toContain('printSearching(reading)');
    expect(body.slice(0, listing)).not.toContain('await printSearching');
    expect(body.slice(ok)).toMatch(/finishesWithin\(2_000, \(\) => closeDatabase\(\)/);
  });

  it('bounds `goals plan` well inside its step: 20 minutes in the machine, and the SSH session on the runner', () => {
    // 2026-11-21 (run 44960240885): nothing reached the runner after 23:10, not even the parent's
    // 26-minute bound, and the step ran to its 30-minute timeout.
    expect(read('scripts/goals.ts')).toMatch(/export const PLAN_TOTAL_MS = 20 \* 60_000;/);
    const goals = read('.github/workflows/goals.yml');
    const run = goals.slice(goals.indexOf('- name: Run'), goals.indexOf('- name: Publish the output as annotations'));
    expect(run).toContain('timeout-minutes: 30');
    expect(run).toContain('session=27m');
    // The census is one bounded session; a plan or check runs detached on the machine and is polled.
    expect(run.match(/timeout -k 20s "\$session" flyctl ssh console/g)).toHaveLength(1);
    expect(run).toContain('ended=${PIPESTATUS[0]}');
    expect(run).toMatch(/grep -q '\^GOALS: ' goals\.txt \|\| echo "GOALS: FAILED/);
  });

  it('survives a dropped SSH session: the read runs detached and the runner polls its log to the verdict', () => {
    // 2026-11-23 (runs 45177420065, 45287862602): "remote command exited without exit status or
    // exit signal" mid-read, twice in a day, and each read ended with no verdict.
    const goals = read('.github/workflows/goals.yml');
    const run = goals.slice(goals.indexOf('- name: Run'), goals.indexOf('- name: Publish the output as annotations'));
    expect(run).toMatch(/nohup setsid env BRAIN_DATABASE_POOL_SIZE=1 sh \/app\/scripts\/goals\.sh \$args > \$log/);
    expect(run).toContain('deadline=$(( $(date +%s) + 27 * 60 ))');
    expect(run).toMatch(/timeout 90 flyctl ssh console --app "\$app" -C "cat \$log"/);
    expect(run).toContain("grep -q '^GOALS: ' goals.txt && break");
    expect(run).toContain('ended=124');
  });

  it('waits for the app to mark its boot derived-state rebuild finished before reading plans beside it', () => {
    // 2026-11-21 21:08:22Z: the app was OOM-killed while a check's reads ran beside its post-boot rebuild.
    const goals = read('.github/workflows/goals.yml');
    const wait = goals.slice(goals.indexOf("name: Wait for the Brain's boot rebuild"), goals.indexOf('- name: Run'));
    expect(wait).toContain("if: ${{ (inputs.command || 'check') == 'check' }}");
    expect(wait).toContain('/healthz');
    expect(wait).toContain('sh /app/scripts/goals.sh ready');
    expect(read('scripts/goals.sh')).toContain('brain-derived-state-rebuilt');
    // One sequential client waits only on its own query: a planner evaluation
    // holding the loop must not turn that into a pool refusal (check 45034423897).
    expect(read('scripts/goals.sh')).toContain('export BRAIN_DATABASE_CONNECT_TIMEOUT_MS="${BRAIN_DATABASE_CONNECT_TIMEOUT_MS:-120000}"');
    const rebuild = read('server/index.ts');
    const step = rebuild.slice(rebuild.indexOf("afterListenStep('rebuild derived state'"));
    expect(step.slice(0, step.indexOf('BOOT_GRACE_STAGGER_MS')).trimEnd()).toMatch(/markDerivedStateRebuilt\(\);\s*\}\);\s*\},$/);
  });
});
