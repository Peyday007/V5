/**
 * MEM-32, decision record: each goal plan reading is one immutable
 * GOAL_DECISION_RECORDED event carrying the decision faced, its alternatives,
 * the evidence with fingerprints, assumed conditions, the prediction, the
 * authority with the owner policy version, the time and the reason, and the
 * chain evidence -> variable -> mechanism -> decision -> action -> result.
 * Current truth is derived from the records; an older reading never stands
 * against a newer owner policy version.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { governingFrom, policyVersions } from '../server/services/goals/ownerPolicy.ts';
import {
  DECISION_EVENT_KIND,
  activeDecisions,
  buildDecisionRecord,
  decisionEventId,
  decisionHistory,
  deriveDecisionStates,
  recordDecision,
  recordDecisionsIfDue,
  type PlanReadingRow,
} from '../server/services/goals/decisionRecord.ts';

const strategies = (opportunityId: string) =>
  JSON.stringify([
    {
      key: 'S1',
      label: 'Sell the audit',
      verdict: 'CANDIDATE',
      opportunityIds: [opportunityId],
      links: [
        { link: 'REACHABLE_BUYER', ok: true, basis: 'claim clm_1' },
        { link: 'PRICE', ok: false, basis: 'no published price' },
      ],
      constraintsFailed: [],
      chainComplete: false,
    },
    { key: 'S2', label: 'Broker the install', verdict: 'NOT_VIABLE', opportunityIds: ['cop_other'], links: [{ link: 'PRICE', ok: false, basis: '' }], constraintsFailed: ['capital'], chainComplete: false },
  ]);

const row = (over: Partial<PlanReadingRow> = {}): PlanReadingRow => ({
  id: 'gpr_1',
  workstream_id: 'wst_g',
  digest: 'd',
  scenario_model_id: 'scm_1',
  scenario_run_id: 'scr_1',
  verdict: 'CANDIDATE',
  chosen_strategy: 'S1',
  strategies: strategies('cop_1'),
  next_test: JSON.stringify({ link: 'PRICE', test: 'Ask three buyers for a quote', by: 'BRAIN', blocker: null }),
  forecast: JSON.stringify({ remainingCents: 500_000, daysLeft: 20, conservativeSettled: null }),
  created_at: '2026-11-05T00:00:00.000Z',
  ...over,
});

const policyAt = (...times: string[]) =>
  governingFrom('wst_g', policyVersions('wst_g', times.map((createdAt, i) => ({ id: `wse_p${i}`, workstreamId: 'wst_g', kind: 'GOAL_TERMS_SET', summary: '', detail: {}, actorRef: 'person:usr_owner', createdAt }))));

describe('the pure record', () => {
  const facts = {
    opportunities: [{ id: 'cop_1', price_cents: 150_000, currency: 'USD', deadline: '2026-12-01' }, { id: 'cop_unrelated', price_cents: 1, currency: 'USD', deadline: null }],
    cashNeeds: [{ id: 'cnd_1', opportunity_id: 'cop_1', expected_cost_cents: 20_000, state: 'OPEN' }],
  };

  it('carries the decision, alternatives, evidence with fingerprints, conditions, prediction, authority, time and reason', () => {
    const record = buildDecisionRecord({ reading: row(), facts, policy: policyAt('2026-11-01T00:00:00.000Z'), pursued: [{ id: 'wsl_1', ref: 'cop_1' }] });
    expect(record.decision).toMatch(/Which plan/);
    expect(record.alternatives.map((a) => [a.key, a.chosen, a.missing])).toEqual([['S1', true, ['PRICE']], ['S2', false, ['PRICE']]]);
    expect(record.evidence.map((e) => `${e.kind}:${e.sourceRowId}`)).toEqual(['OPPORTUNITY_PRICE:cop_1', 'OPPORTUNITY_DEADLINE:cop_1', 'CASH_NEED_COST:cnd_1', 'SCENARIO_MODEL:scm_1', 'SCENARIO_RUN:scr_1']);
    for (const e of record.evidence) expect(e.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.conditions).toEqual(expect.arrayContaining([expect.stringMatching(/assumed, not established: PRICE/), '20 days left to the deadline']));
    expect(record.predicted).toMatchObject({ remainingCents: 500_000 });
    expect(record.authority).toMatchObject({ actor: 'BRAIN', policyVersion: 1, policyEventId: 'wse_p0', verdict: 'CURRENT' });
    expect(record.decidedAt).toBe('2026-11-05T00:00:00.000Z');
    expect(record.reason).toMatch(/Sell the audit was chosen/);
    expect(record.status).toBe('IN_FORCE');
  });

  it('a changed fact changes its fingerprint', () => {
    const before = buildDecisionRecord({ reading: row(), facts, policy: policyAt('2026-11-01T00:00:00.000Z'), pursued: [] });
    const after = buildDecisionRecord({ reading: row(), facts: { ...facts, opportunities: [{ id: 'cop_1', price_cents: 90_000, currency: 'USD', deadline: '2026-12-01' }] }, policy: policyAt('2026-11-01T00:00:00.000Z'), pursued: [] });
    expect(after.evidence[0]!.fingerprint).not.toBe(before.evidence[0]!.fingerprint);
    expect(after.evidence[1]!.fingerprint).toBe(before.evidence[1]!.fingerprint);
  });

  it('carries the chain evidence -> variable -> mechanism -> decision -> action -> result', () => {
    const record = buildDecisionRecord({ reading: row(), facts, policy: policyAt('2026-11-01T00:00:00.000Z'), pursued: [{ id: 'wsl_1', ref: 'cop_1' }, { id: 'wsl_x', ref: 'cop_elsewhere' }] });
    expect(record.chain.evidence).toContain('OPPORTUNITY_PRICE:cop_1');
    expect(record.chain.variables).toEqual([{ link: 'REACHABLE_BUYER', ok: true, basis: 'claim clm_1' }, { link: 'PRICE', ok: false, basis: 'no published price' }]);
    expect(record.chain.mechanism).toEqual({ strategy: 'S1', opportunityIds: ['cop_1'] });
    expect(record.chain.decision).toBe('gpr_1');
    expect(record.chain.actions).toEqual([
      { kind: 'NEXT_TEST', link: 'PRICE', test: 'Ask three buyers for a quote', by: 'BRAIN' },
      { kind: 'PURSUES', linkId: 'wsl_1', opportunityId: 'cop_1' },
    ]);
    expect(record.chain.results).toEqual({ by: 'goal_outcomes.reading_id', readingId: 'gpr_1' });
  });

  it('a reading older than the governing policy version is superseded by policy, never in force; no policy is unknown', () => {
    const stale = buildDecisionRecord({ reading: row(), facts, policy: policyAt('2026-11-01T00:00:00.000Z', '2026-11-06T00:00:00.000Z'), pursued: [] });
    expect(stale.status).toBe('SUPERSEDED_BY_POLICY');
    expect(stale.authority).toMatchObject({ policyVersion: 2, verdict: 'STALE' });
    const unknown = buildDecisionRecord({ reading: row(), facts, policy: policyAt(), pursued: [] });
    expect(unknown.status).toBe('POLICY_UNKNOWN');
  });

  it('derives current truth without touching the records: newest in force, earlier replaced, newer policy supersedes', () => {
    const p1 = policyAt('2026-11-01T00:00:00.000Z');
    const a = buildDecisionRecord({ reading: row({ id: 'gpr_a', created_at: '2026-11-02T00:00:00.000Z' }), facts, policy: p1, pursued: [] });
    const b = buildDecisionRecord({ reading: row({ id: 'gpr_b', created_at: '2026-11-03T00:00:00.000Z' }), facts, policy: p1, pursued: [] });
    const records = [{ eventId: 'wse_gdr_gpr_b', record: b }, { eventId: 'wse_gdr_gpr_a', record: a }].sort((x, y) => x.record.decidedAt.localeCompare(y.record.decidedAt));
    const frozen = JSON.stringify(records);
    expect(deriveDecisionStates(records, p1).map((s) => [s.record.readingId, s.current])).toEqual([['gpr_a', 'REPLACED'], ['gpr_b', 'IN_FORCE']]);
    const p2 = policyAt('2026-11-01T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    const states = deriveDecisionStates(records, p2, [{ id: 'gou_1', reading_id: 'gpr_b', kind: 'MISSED', achieved_cents: 0, target_cents: 1, observed_at: '2026-11-04T00:00:00.000Z' }]);
    expect(states.map((s) => s.current)).toEqual(['SUPERSEDED_BY_POLICY', 'SUPERSEDED_BY_POLICY']);
    expect(states[1]!.recordedStatus).toBe('IN_FORCE');
    expect(states[1]!.results).toEqual([{ id: 'gou_1', kind: 'MISSED', achievedCents: 0, targetCents: 1, observedAt: '2026-11-04T00:00:00.000Z' }]);
    expect(JSON.stringify(records)).toBe(frozen);
  });
});

describe('the production pass', () => {
  let projectId = '';
  let userId = '';
  let goalId = '';
  let opportunityId = '';

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `dr-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(projectId))!.id;
    const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: 'An opening', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: null, source: 'A publisher' });
    await updateOpportunity(o.id, { price_cents: 150_000 });
    opportunityId = o.id;
    goalId = (await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId })).id;
  });

  const ownerDecision = async (at: string) =>
    getDb().run(`INSERT INTO workstream_events (id, workstream_id, kind, summary, detail, actor_ref, created_at) VALUES (?, ?, 'GOAL_TERMS_SET', 'terms', '{}', ?, ?)`, [newId('wse'), goalId, `person:${userId}`, at]);
  const reading = async (id: string, at: string) => {
    const r = row({ id, workstream_id: goalId, strategies: strategies(opportunityId), created_at: at });
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.workstream_id, `${id}-digest`, null, null, r.verdict, r.chosen_strategy, r.strategies, r.next_test, r.forecast, r.created_at],
    );
    return r;
  };
  const records = async () => getDb().all<{ id: string; detail: string }>(`SELECT id, detail FROM workstream_events WHERE workstream_id = ? AND kind = ? ORDER BY id`, [goalId, DECISION_EVENT_KIND]);

  it('writes exactly one record per reading, however often it runs, and never edits one', async () => {
    await ownerDecision('2026-11-01T00:00:00.000Z');
    const r1 = await reading('gpr_t1', '2026-11-02T00:00:00.000Z');
    await reading('gpr_t2', '2026-11-03T00:00:00.000Z');
    await linkWorkstream({ workstreamId: goalId, kind: 'OPPORTUNITY', ref: opportunityId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
    expect(await recordDecisionsIfDue({ goalId })).toEqual({ recorded: 2, pending: 0 });
    const first = await records();
    expect(first.map((one) => one.id)).toEqual([decisionEventId('gpr_t1'), decisionEventId('gpr_t2')]);
    expect(await recordDecisionsIfDue({ goalId })).toEqual({ recorded: 0, pending: 0 });
    expect(await recordDecision(r1)).toBe(false);
    // A fact changes afterwards: the record keeps the value it was decided on.
    await updateOpportunity(opportunityId, { price_cents: 1 });
    await recordDecisionsIfDue({ goalId });
    expect(await records()).toEqual(first);
    const detail = JSON.parse(first[0]!.detail) as ReturnType<typeof buildDecisionRecord>;
    expect(detail.evidence.find((e) => e.kind === 'OPPORTUNITY_PRICE')).toMatchObject({ sourceRowId: opportunityId, value: { priceCents: 150_000, currency: 'USD' } });
    expect(detail.chain.actions.some((a) => a.kind === 'PURSUES' && a.opportunityId === opportunityId)).toBe(true);
    expect(detail.authority).toMatchObject({ policyVersion: 1, verdict: 'CURRENT' });
  });

  it('active decisions are the newest record under the governing policy, and a later result links by id', async () => {
    await ownerDecision('2026-11-01T00:00:00.000Z');
    await reading('gpr_a', '2026-11-02T00:00:00.000Z');
    await reading('gpr_b', '2026-11-03T00:00:00.000Z');
    await recordDecisionsIfDue({ goalId });
    expect((await activeDecisions(goalId)).map((s) => s.record.readingId)).toEqual(['gpr_b']);
    await getDb().run(
      `INSERT INTO goal_outcomes (id, workstream_id, reading_id, kind, achieved_cents, target_cents, detail, observed_at) VALUES (?, ?, ?, 'MISSED', 0, 100, '{}', ?)`,
      ['gou_1', goalId, 'gpr_b', '2026-11-04T00:00:00.000Z'],
    );
    const before = await records();
    const history = await decisionHistory(goalId);
    expect(history.find((s) => s.record.readingId === 'gpr_b')!.results.map((r) => r.id)).toEqual(['gou_1']);
    expect(await records()).toEqual(before);
    // A newer owner decision: nothing produced before it stays in force.
    await ownerDecision('2026-11-05T00:00:00.000Z');
    expect(await activeDecisions(goalId)).toEqual([]);
    expect(await records()).toEqual(before);
  });

  it('records a reading older than the governing policy as superseded by policy, never in force', async () => {
    await ownerDecision('2026-11-01T00:00:00.000Z');
    await reading('gpr_old', '2026-11-02T00:00:00.000Z');
    await ownerDecision('2026-11-04T00:00:00.000Z');
    await recordDecisionsIfDue({ goalId });
    const [one] = await records();
    const detail = JSON.parse(one!.detail) as ReturnType<typeof buildDecisionRecord>;
    expect(detail.status).toBe('SUPERSEDED_BY_POLICY');
    expect(detail.authority).toMatchObject({ policyVersion: 2, verdict: 'STALE' });
    expect(await activeDecisions(goalId)).toEqual([]);
  });
});
