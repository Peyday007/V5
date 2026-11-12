/**
 * AUTO-20-1, AUTO-20-2 and AUTO-20-4 are judged from the improvement loop's
 * rows: UNKNOWN until the rows show the behaviour, FAIL when a row contradicts
 * it, PASS when the rows demonstrate it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { decideCandidate, recordImprovementEvent, upsertCandidate } from '../server/repos/improvement.ts';
import { createUser } from '../server/repos/identity.ts';
import { approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import { run } from '../server/services/factory/git.ts';
import { ensureCampaign } from '../server/repos/factory.ts';
import { advanceRun, grantRelease, openRun } from '../server/repos/factoryRelease.ts';

let t: TestProject;
beforeEach(async () => {
  t = await freshProject();
});
afterEach(async () => {
  await teardown();
});

const OWNER = 'server/services/freeLane/worker.ts';

async function candidate(
  key: string,
  opts: { kind?: string; evidence?: Record<string, unknown>; attempt?: number; created?: string; decision?: 'KEPT' | 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED'; decided?: string } = {},
): Promise<string> {
  const { candidate: c } = await upsertCandidate({
    weaknessKey: key,
    kind: opts.kind ?? 'FREE_LANE_FAILURE',
    title: key,
    problem: 'p',
    metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
    downstreamMetric: null,
    ownerComponent: OWNER,
    frequency: 5,
    denominator: 10,
    scope: 'GENERAL',
    severity: 'MEDIUM',
    evidence: opts.evidence ?? {},
    attempt: opts.attempt ?? 1,
  });
  const created = opts.created ?? '2026-10-02T00:00:00.000Z';
  await getDb().run('UPDATE improvement_candidates SET created_at = ? WHERE id = ?', [created, c.id]);
  if (opts.decision) {
    await decideCandidate(c.id, opts.decision, 'test');
    await recordImprovementEvent({ candidateId: c.id, kind: 'DECIDED', detail: { decision: opts.decision }, at: opts.decided ?? created });
  }
  return c.id;
}

const origination = (family: string, extra: Record<string, unknown> = {}) => ({
  origination: { family, judgment: `${family} judged from the rows`, observed: ['row_1', 'row_2'], ...extra },
});

/** One capability-gap step, as the gap loop appends it: `provider` the step, `workload_class` the gap, `measures` {gap, step, detail}. */
async function step(gap: string, name: string, at: string, detail: Record<string, unknown>): Promise<void> {
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, provider, workload_class, outcome, reason, evidence_class, measures)
     VALUES (?, 'CAPABILITY_GAP_STEP', ?, ?, ?, 'RECORDED', ?, 'MEASURED', ?)`,
    [newId('bev'), at, name, gap, `${name} summary`, JSON.stringify({ gap, step: name, detail })],
  );
}

const CONTENT: Record<string, Record<string, unknown>> = {
  NOTICE: { observation: 'free-lane fragments fail the same way' },
  HYPOTHESIS: { cause: 'REASONING_DEFECT', basis: 'b', enables: 'fewer failures', measure: 'FREE_LANE_FRAGMENT_PASS_RATE', failureMode: 'the metric does not move' },
  SEARCH_EXISTING: { searched: ['method archive', 'system scan components'], archiveClaims: 0, existing: [], beforeAcquire: true },
  VALUE: { evaluated: true, chosen: 'FACTORY_CHANGE', ref: 'FACTORY_CHANGE', decision: 'FACTORY_CHANGE', alternatives: 'COMMISSION_RESEARCH: net 1' },
  ACQUIRE: { owner: 'Factory (change request fcr_1)', ref: 'FACTORY:fcr_1' },
  VERIFY: { baseline: 'rate = 0.2 before', comparison: 'rate = 0.6 after on production rows', passed: true },
  INTEGRATE: { capability: 'fewer failures', version: 'abc', provenance: 'improvement candidate', owner: OWNER, status: 'ACTIVE' },
  CONTINUE: { resumed: 'the improvement tick advances the next ranked candidate' },
};
const ORDER = ['NOTICE', 'HYPOTHESIS', 'SEARCH_EXISTING', 'VALUE', 'ACQUIRE', 'VERIFY', 'INTEGRATE', 'CONTINUE'];

/** A full loop on one gap; `minutes` apart between consecutive steps. */
async function fullLoop(gap: string, minutes: number, overrides: Record<string, Record<string, unknown>> = {}): Promise<void> {
  const start = Date.parse('2026-10-02T00:00:00.000Z');
  for (const [i, name] of ORDER.entries()) {
    await step(gap, name, new Date(start + i * minutes * 60_000).toISOString(), { ...CONTENT[name], ...(overrides[name] ?? {}) });
  }
}

describe('the autonomy probes', () => {
  it('answer UNKNOWN on a Brain with no improvement rows, never PASS', async () => {
    for (const name of ['r01.auto-20-1', 'r01.auto-20-2', 'r01.auto-20-4']) {
      const result = await getProbe(name)!({});
      expect(result.ok, `${name}: ${result.detail}`).toBeNull();
    }
  });
});

describe('AUTO-20-1: origination', () => {
  it('passes on originated work from more than one family, with a method judged inadequate on the record', async () => {
    await candidate('CAPABILITY:research.CAP-7', { kind: 'CAPABILITY_GAP', decision: 'KEPT_NO_EFFECT' });
    const judgment = 'A repair of CAPABILITY:research.CAP-7 was decided KEPT_NO_EFFECT at attempt 1, and the gap still blocks 2 live goal(s).';
    await candidate('ORIGINATED:GOAL_CONSTRAINT:CAP-7', {
      kind: 'ORIGINATED_GOAL_CONSTRAINT',
      evidence: { ...origination('GOAL_CONSTRAINT', { methodInadequate: judgment }), methodInadequacy: { judgment, failedAttempts: [] } },
    });
    await candidate('ORIGINATED:FAILURE_PATTERN:research:timeout', { kind: 'ORIGINATED_FAILURE_PATTERN', evidence: origination('FAILURE_PATTERN') });
    const result = await getProbe('r01.auto-20-1')!({});
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toMatch(/across 2 families/);
    expect(result.detail).toMatch(/1 judging an earlier method inadequate/);
  });

  it('stays UNKNOWN while origination covers one family or no method has been judged inadequate', async () => {
    await candidate('ORIGINATED:IDLE_CAPACITY:pool', { kind: 'ORIGINATED_IDLE_CAPACITY', evidence: origination('IDLE_CAPACITY') });
    expect((await getProbe('r01.auto-20-1')!({})).ok).toBeNull();
    await candidate('ORIGINATED:UNMET_NEED:supplier', { kind: 'ORIGINATED_UNMET_NEED', evidence: origination('UNMET_NEED') });
    const two = await getProbe('r01.auto-20-1')!({});
    expect(two.ok).toBeNull();
    expect(two.detail).toMatch(/no method has yet been judged inadequate/);
  });

  it('fails on an originated candidate with no judgment, or a method judged inadequate with no failed attempt behind it', async () => {
    await candidate('ORIGINATED:MISSED_OPPORTUNITY:READY', { kind: 'ORIGINATED_MISSED_OPPORTUNITY', evidence: { origination: { family: 'MISSED_OPPORTUNITY', judgment: '', observed: ['o1'] } } });
    const blank = await getProbe('r01.auto-20-1')!({});
    expect(blank.ok).toBe(false);
    expect(blank.detail).toMatch(/no recorded judgment/);
    await getDb().run('DELETE FROM improvement_candidates', []);
    await candidate('FREE_LANE:X', { decision: 'REJECTED' });
    await candidate('FREE_LANE:X#2', { attempt: 2, evidence: { methodInadequacy: { judgment: 'attempt 1 failed', failedAttempts: [1] } } });
    const unbacked = await getProbe('r01.auto-20-1')!({});
    expect(unbacked.ok).toBe(false);
    expect(unbacked.detail).toMatch(/attempt 1 as a failed method, but that attempt was decided REJECTED/);
  });
});

describe('AUTO-20-2: the capability-gap loop', () => {
  it('passes on a full loop in order, reuse searched first, resumed across passes', async () => {
    await fullLoop('FREE_LANE:X', 30);
    const result = await getProbe('r01.auto-20-2')!({});
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toMatch(/1 ran the full loop in order, 1 of them across passes/);
  });

  it('stays UNKNOWN on a partial loop, or a full one written inside a single pass', async () => {
    const start = Date.parse('2026-10-02T00:00:00.000Z');
    for (const [i, name] of ORDER.slice(0, 4).entries()) await step('FREE_LANE:P', name, new Date(start + i * 1000).toISOString(), CONTENT[name]!);
    expect((await getProbe('r01.auto-20-2')!({})).ok).toBeNull();
    await fullLoop('FREE_LANE:ONE', 0);
    const single = await getProbe('r01.auto-20-2')!({});
    expect(single.ok).toBeNull();
    expect(single.detail).toMatch(/inside one pass/);
  });

  it('does not count a search recorded after the hand-off, or a valuation that weighed nothing, as the loop', async () => {
    await fullLoop('FREE_LANE:LATE', 30, { SEARCH_EXISTING: { beforeAcquire: false }, VALUE: { evaluated: false } });
    expect((await getProbe('r01.auto-20-2')!({})).ok).toBeNull();
  });

  it('fails when a gap acquired before reuse was searched (a broken order)', async () => {
    const start = Date.parse('2026-10-02T00:00:00.000Z');
    const broken = ['NOTICE', 'HYPOTHESIS', 'VALUE', 'ACQUIRE', 'SEARCH_EXISTING', 'VERIFY', 'INTEGRATE', 'CONTINUE'];
    for (const [i, name] of broken.entries()) await step('FREE_LANE:B', name, new Date(start + i * 30 * 60_000).toISOString(), CONTENT[name]!);
    const result = await getProbe('r01.auto-20-2')!({});
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ACQUIRE .* before any SEARCH_EXISTING/);
  });

  it('fails when a step carries less than the loop requires of it', async () => {
    await fullLoop('FREE_LANE:H', 30, { HYPOTHESIS: { cause: 'BAD_LUCK' } });
    const result = await getProbe('r01.auto-20-2')!({});
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/HYPOTHESIS .* names cause BAD_LUCK/);
  });
});

describe('AUTO-20-4: gaps identified and closed without owner input', () => {
  it('stays UNKNOWN while gaps are identified but none has closed', async () => {
    await candidate('FREE_LANE:OPEN');
    await candidate('FREE_LANE:RV', { decision: 'REVERTED', decided: '2026-10-03T00:00:00.000Z' });
    const result = await getProbe('r01.auto-20-4')!({});
    expect(result.ok).toBeNull();
    expect(result.detail).toMatch(/2 gap\(s\) identified; 0 closed.*1 reverted/);
  });

  it('passes when a gap closed under the loop’s own release grant into the owner it extended, and fails when it was integrated elsewhere', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-probe-repo-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'subject', scripts: {} }));
      await run('git', ['init', '-b', 'main'], { cwd: root });
      await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
      await run('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
      await run('git', ['add', '-A'], { cwd: root });
      await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
      const admin = await createUser({ email: 'autonomy-probe@test.local', displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
      const merge = 'b'.repeat(40);
      const id = await candidate('FREE_LANE:AUTO', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T06:00:00.000Z' });
      const submitted = await submitObjective({
        projectId: t.project.id,
        objective: 'Improve FREE_LANE:AUTO so its metric moves.',
        expectedOutcome: 'the metric moves',
        acceptanceConditions: [{ statement: 'the metric moves', verification: 'measure it' }],
        repositoryRoot: root,
        mutationScope: ['client/**'],
      });
      const approved = await approveObjective({ changeRequestId: submitted.changeRequest.id, via: 'PERSON', userId: admin.id });
      expect(approved.ok).toBe(true);
      const { campaign } = await ensureCampaign({
        changeRequestId: submitted.changeRequest.id,
        projectId: t.project.id,
        baseSha: approved.changeRequest.baseSha,
        laneTarget: 1,
        laneTargetReason: 'initial',
      });
      await getDb().run('UPDATE improvement_candidates SET campaign_id = ?, delivered_ref = ? WHERE id = ?', [campaign.id, merge, id]);
      const { grant } = await grantRelease({
        changeRequestId: submitted.changeRequest.id,
        projectId: t.project.id,
        liveChecks: [],
        pagePath: null,
        grantedByUserId: admin.id,
        authorityChannel: 'SHELL',
        executedByRef: 'improvement-loop',
        reason: 'test',
      });
      const { run: opened } = await openRun({ campaignId: campaign.id, changeRequestId: submitted.changeRequest.id, grantId: grant.id, headSha: 'a'.repeat(40), attempt: 1, state: 'GATING', refusal: [], workflowRunId: null });
      await advanceRun(opened!.id, { from: ['GATING'], to: 'LIVE', mergeSha: merge });

      // Closed by Brain alone, but its integration is not on the gap's record yet.
      const pending = await getProbe('r01.auto-20-4')!({});
      expect(pending.ok, pending.detail).toBeNull();
      expect(pending.detail).toMatch(/owner input: 1 none/);

      await step('FREE_LANE:AUTO', 'INTEGRATE', '2026-10-02T06:10:00.000Z', CONTENT.INTEGRATE!);
      const pass = await getProbe('r01.auto-20-4')!({});
      expect(pass.ok, pass.detail).toBe(true);
      expect(pass.detail).toMatch(/1 closed .*median 6\.0 h to use/);

      await step('FREE_LANE:AUTO', 'INTEGRATE', '2026-10-02T07:00:00.000Z', { ...CONTENT.INTEGRATE, owner: 'server/services/newMechanism.ts' });
      const elsewhere = await getProbe('r01.auto-20-4')!({});
      expect(elsewhere.ok).toBe(false);
      expect(elsewhere.detail).toMatch(/did not extend the existing owner/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count a gap a person released as closed without owner input', async () => {
    const id = await candidate('FREE_LANE:HAND', { decision: 'KEPT', decided: '2026-10-03T00:00:00.000Z' });
    await recordImprovementEvent({ candidateId: id, kind: 'OWNER_OVERRIDE', detail: {} });
    await step('FREE_LANE:HAND', 'INTEGRATE', '2026-10-03T00:10:00.000Z', CONTENT.INTEGRATE!);
    const result = await getProbe('r01.auto-20-4')!({});
    expect(result.ok).toBeNull();
    expect(result.detail).toMatch(/owner input: 0 none, 1 with/);
  });
});
