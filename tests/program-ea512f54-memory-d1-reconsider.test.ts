/**
 * MEM-32, reconsideration (S-0471, S-0474): a changed material fact behind a
 * decision in force is detected by fingerprint, its dependent forecasts,
 * opportunities, approvals and actions are named from the record's chain, the
 * decision is reconsidered exactly once per fact version, the earlier record
 * and its evidence are kept, the obsolete decision leaves current truth, and
 * the plan's own owner reads the goal again so the next step changes by
 * itself. Unchanged facts cause nothing. The goals tick runs the
 * decision-record, calibration and reconsideration passes and reports a
 * failing pass instead of throwing. A prediction error earns a specific
 * method correction (`server/services/goals/reconsider.ts`, `tick.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { advanceGoalPlans, forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { DECISION_EVENT_KIND, WORLD_FACT_KINDS, decisionHistory, factValue, worldFactRefs, type DecisionRecord, type FactRows } from '../server/services/goals/decisionRecord.ts';
import { canonicalJson, sha256 } from '../server/services/scenario/model.ts';
import { CALIBRATION_PASS_EVERY_MS, reconcileCalibrationIfDue, type CalibrationPorts } from '../server/services/goals/calibration.ts';
import {
  RECONSIDER_EVENT_KIND,
  activeTruth,
  changedFacts,
  dependentsOf,
  forgetReconsiderPass,
  reconcileFactChanges,
  reconsiderationId,
} from '../server/services/goals/reconsider.ts';
import { advanceGoals } from '../server/services/goals/tick.ts';
import type { MissCause, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  forgetReconsiderPass();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `rc-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function fact(o: CashOpportunity, field: string, value: string): Promise<void> {
  await recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
}

/** A qualified, repeatable play: the plan reads it into a strategy. */
async function play(priceCents: number): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title: 'Monthly owner reports', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: ['PRODUCE_SPREADSHEET'],
  });
  await fact(o, CAPTURE_KEY, 'Sell a monthly report to each buyer.');
  await fact(o, 'payer', 'Property managers');
  await fact(o, 'delivery', 'A spreadsheet Brain produces.');
  await updateOpportunity(o.id, {
    payer: 'Property managers', price_cents: priceCents, offer_scope: 'One monthly report', reachable_channel: 'Published business email addresses',
    buying_signal: 'Posted asking for this report', signal_observed_at: inDays(-3), peak_funding_cents: 0, human_hours: 3,
  });
  await fact(o, 'price', `$${priceCents / 100}`);
  await fact(o, 'timeToFirstCash', '7 days');
  await fact(o, 'directCosts', '$20');
  await fact(o, 'exposure', '$0');
  await fact(o, 'buyerVolume', '400 property managers are listed in the state directory; each orders monthly.');
  return o;
}

async function goal(amountCents: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

const noCalibration = { calibration: async () => null };
const events = async (goalId: string, kind: string) =>
  getDb().all<{ id: string; detail: string; created_at: string }>(`SELECT id, detail, created_at FROM workstream_events WHERE workstream_id = ? AND kind = ? ORDER BY created_at, id`, [goalId, kind]);

describe('a changed material fact, after a real plan used it', () => {
  it('names the dependents, reconsiders once, keeps the earlier decision, and the next step changes by itself', async () => {
    const o = await play(50_000);
    const goalId = await goal(200_000);
    const first = (await readGoalPlan({ goalId, evaluations: 2_000, persist: true }))!;
    expect(first.nextTest?.link).toBe('CONVERSION');

    // The tick records the reading as a decision; with nothing changed, nothing is reconsidered.
    const quiet = await advanceGoals({ memory: noCalibration });
    expect(quiet.memory.decisions).toMatchObject({ recorded: 1 });
    expect(quiet.memory.reconsidered).toMatchObject({ checked: 1, unchanged: 1, reconsidered: [], replanned: [] });
    const decided = await events(goalId, DECISION_EVENT_KIND);
    expect(decided).toHaveLength(1);
    const before = decided[0]!;
    const record = JSON.parse(before.detail) as DecisionRecord;
    expect(record.evidence.find((e) => e.kind === 'OPPORTUNITY_PRICE')).toMatchObject({ sourceRowId: o.id, value: { priceCents: 50_000, currency: 'USD' } });

    // A new price: the economically material fact the plan rested on.
    await updateOpportunity(o.id, { price_cents: 1_000 });
    await fact(o, 'price', '$10');
    forgetReconsiderPass();
    const changed = await advanceGoals({ memory: noCalibration });
    const pass = changed.memory.reconsidered as Exclude<typeof changed.memory.reconsidered, null | { error: string }>;
    expect(pass.reconsidered).toHaveLength(1);
    const one = pass.reconsidered[0]!;
    expect(one.change).toMatchObject({ kind: 'OPPORTUNITY_PRICE', sourceRowId: o.id, before: { priceCents: 50_000, currency: 'USD' }, after: { priceCents: 1_000, currency: 'USD' }, gone: false });
    expect(one.dependents.forecasts).toEqual([{ readingId: record.readingId, predicted: record.predicted }]);
    expect(one.dependents.opportunities).toEqual([o.id]);
    expect(one.dependents.approvals.some((a) => a.kind === 'OWNER_POLICY')).toBe(true);
    // The plan's next test, and the goal's pursuit of the opportunity whose price moved.
    expect(one.dependents.actions).toEqual([expect.objectContaining({ kind: 'NEXT_TEST', link: 'CONVERSION' }), expect.objectContaining({ kind: 'PURSUES', opportunityId: o.id })]);
    expect(pass.replanned).toEqual([goalId]);
    const reconsidered = await events(goalId, RECONSIDER_EVENT_KIND);
    expect(reconsidered).toHaveLength(1);
    expect(JSON.parse(reconsidered[0]!.detail)).toMatchObject({ readingId: record.readingId, old: { value: { priceCents: 50_000 } }, new: { value: { priceCents: 1_000 } } });

    // The obsolete decision has left current truth; its record and evidence are untouched.
    expect(await activeTruth(goalId)).toEqual([]);
    expect(await events(goalId, DECISION_EVENT_KIND)).toEqual([before]);

    // Once per fact version: another pass changes nothing.
    forgetReconsiderPass();
    const again = await advanceGoals({ memory: noCalibration });
    expect(again.memory.reconsidered).toMatchObject({ reconsidered: [] });
    expect(await events(goalId, RECONSIDER_EVENT_KIND)).toHaveLength(1);

    // The plan's owner reads the goal at once, and the tick records the new decision.
    await advanceGoalPlans(new Date());
    await advanceGoals({ memory: noCalibration });
    const truth = await activeTruth(goalId);
    expect(truth).toHaveLength(1);
    expect(truth[0]!.record.readingId).not.toBe(record.readingId);
    const step = truth[0]!.record.chain.actions.find((a) => a.kind === 'NEXT_TEST');
    expect(step).toMatchObject({ kind: 'NEXT_TEST' });
    expect(step && step.kind === 'NEXT_TEST' ? step.link : null).not.toBe('CONVERSION');
    // The earlier decision is history, kept and replaced, never edited.
    const history = await decisionHistory(goalId);
    expect(history.map((s) => [s.record.readingId, s.current])).toEqual([[record.readingId, 'REPLACED'], [truth[0]!.record.readingId, 'IN_FORCE']]);
    expect((await events(goalId, DECISION_EVENT_KIND))[0]).toEqual(before);
    // The new decision rests on the new price, so it is not reconsidered again.
    forgetReconsiderPass();
    const settled = await advanceGoals({ memory: noCalibration });
    expect(settled.memory.reconsidered).toMatchObject({ unchanged: 1, reconsidered: [] });
  });

  it('still-valid evidence causes no reconsideration and asks for no re-research', async () => {
    await play(50_000);
    const goalId = await goal(200_000);
    await readGoalPlan({ goalId, evaluations: 2_000, persist: true });
    await advanceGoals({ memory: noCalibration });
    const asked: string[] = [];
    const ports = { requestPlanPass: (id: string) => void asked.push(id) };
    for (let i = 0; i < 3; i += 1) {
      const report = await reconcileFactChanges({ goalId, ports });
      expect(report).toMatchObject({ checked: 1, unchanged: 1, reconsidered: [] });
    }
    expect(asked).toEqual([]);
    expect(await events(goalId, RECONSIDER_EVENT_KIND)).toEqual([]);
  });

  it('a changed fact asks for one plan pass however many passes see it', async () => {
    const o = await play(50_000);
    const goalId = await goal(200_000);
    await readGoalPlan({ goalId, evaluations: 2_000, persist: true });
    await advanceGoals({ memory: noCalibration });
    await updateOpportunity(o.id, { price_cents: 70_000 });
    const asked: string[] = [];
    const ports = { requestPlanPass: (id: string) => void asked.push(id) };
    await Promise.all([reconcileFactChanges({ goalId, ports }), reconcileFactChanges({ goalId, ports })]);
    await reconcileFactChanges({ goalId, ports });
    expect(await events(goalId, RECONSIDER_EVENT_KIND)).toHaveLength(1);
    expect(asked.length).toBe(1);
  });
});

describe('every world fact a plan rests on is read back, not only prices (S-0471)', () => {
  const ports = () => {
    const asked: string[] = [];
    return { asked, ports: { requestPlanPass: (id: string) => void asked.push(id) } };
  };
  async function decided(): Promise<{ o: CashOpportunity; goalId: string; record: DecisionRecord }> {
    const o = await play(50_000);
    const goalId = await goal(200_000);
    await readGoalPlan({ goalId, evaluations: 2_000, persist: true });
    await advanceGoals({ memory: noCalibration });
    const record = JSON.parse((await events(goalId, DECISION_EVENT_KIND))[0]!.detail) as DecisionRecord;
    return { o, goalId, record };
  }

  it('the record fingerprints the goal target, the capital constraint, the conversion rate and the contracts', async () => {
    const { o, goalId, record } = await decided();
    const kinds = new Set(record.evidence.map((e) => `${e.kind}:${e.sourceRowId}`));
    expect(kinds.has(`GOAL_TARGET:${goalId}`)).toBe(true);
    expect(kinds.has(`CAPITAL_CONSTRAINT:${goalId}`)).toBe(true);
    expect(kinds.has(`CONVERSION_RATE:${projectId}:PRODUCTIZED_SERVICE`)).toBe(true);
    expect(kinds.has(`CONTRACT_STATE:${o.id}`)).toBe(true);
    expect(record.evidence.find((e) => e.kind === 'GOAL_TARGET')).toMatchObject({ value: { metric: 'SETTLED_CASH', amountCents: 200_000, currency: 'USD' } });
    expect(record.evidence.find((e) => e.kind === 'CAPITAL_CONSTRAINT')).toMatchObject({ value: { capitalCeilingCents: null, hoursCeiling: 200 } });
  });

  it('a changed goal target or capital constraint reconsiders the decision and names every strategy as dependent', async () => {
    const { o, goalId, record } = await decided();
    const { asked, ports: p } = ports();
    expect(await reconcileFactChanges({ goalId, ports: p })).toMatchObject({ unchanged: 1, reconsidered: [] });
    expect((await setTarget({ goal: (await getWorkstream(goalId))!, metric: 'SETTLED_CASH', amountCents: 200_000, currency: 'USD', projectId, capitalCeilingCents: 5_000, hoursCeiling: 40, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const report = await reconcileFactChanges({ goalId, ports: p });
    const capital = report.reconsidered.find((r) => r.change.kind === 'CAPITAL_CONSTRAINT');
    expect(capital).toBeDefined();
    expect(capital!.change).toMatchObject({ sourceRowId: goalId, before: { capitalCeilingCents: null, hoursCeiling: 200 }, after: { capitalCeilingCents: 5_000, hoursCeiling: 40 } });
    expect(capital!.dependents.opportunities).toEqual([o.id]);
    expect(capital!.dependents.actions.some((a) => a.kind === 'PURSUES' && a.opportunityId === o.id)).toBe(true);
    expect(asked).toEqual([goalId]);
    expect(await activeTruth(goalId)).toEqual([]);
    expect(JSON.parse((await events(goalId, DECISION_EVENT_KIND))[0]!.detail)).toEqual(record);
  });

  it('an account being disconnected reconsiders a decision taken while it was connected, once', async () => {
    const integrationId = `acct-${Math.random().toString(36).slice(2, 10)}`;
    const check = (state: string, at: string) =>
      getDb().run(`INSERT INTO integration_events (id, integration_id, kind, state, detail, source, recorded_at) VALUES (?, ?, 'CHECK', ?, '', 'test', ?)`, [`ie_${Math.random().toString(36).slice(2)}`, integrationId, state, at]);
    await check('CONNECTED', new Date(now.getTime() - 120_000).toISOString());
    const { goalId, record } = await decided();
    expect(record.evidence.find((e) => e.kind === 'ACCOUNT_STATE' && e.sourceRowId === integrationId)).toMatchObject({ value: { state: 'CONNECTED' } });
    await check('DISCONNECTED', new Date(now.getTime() + 60_000).toISOString());
    const { asked, ports: p } = ports();
    const report = await reconcileFactChanges({ goalId, ports: p });
    expect(report.reconsidered.map((r) => [r.change.kind, r.change.sourceRowId, r.change.after])).toEqual([['ACCOUNT_STATE', integrationId, { state: 'DISCONNECTED' }]]);
    await reconcileFactChanges({ goalId, ports: p });
    expect(asked).toEqual([goalId]);
    expect(await events(goalId, RECONSIDER_EVENT_KIND)).toHaveLength(1);
  });

  it('a fulfilled contract reconsiders the decision taken before it was delivered', async () => {
    const o = await play(50_000);
    const at = new Date(now.getTime() - 30_000).toISOString();
    await getDb().run(
      `INSERT INTO cash_agreements (id, project_id, opportunity_id, amount_cents, currency, deliverable, acceptance_condition, evidence_kind, evidence_ref, state, request_key, recorded_by, created_at, updated_at)
       VALUES (?, ?, ?, 50000, 'USD', 'One monthly report', 'Buyer accepts the report', 'WRITTEN_ACCEPTANCE', 'email:1', 'AGREED', ?, 'test', ?, ?)`,
      ['cag_rc1', projectId, o.id, `rk-${o.id}`, at, at],
    );
    await getDb().run(
      `INSERT INTO cash_fulfillments (id, project_id, opportunity_id, agreement_id, kind, performer, declared_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'SOFTWARE', 'brain', 'test', ?, ?)`,
      ['cfl_rc1', projectId, o.id, 'cag_rc1', at, at],
    );
    const goalId = await goal(200_000);
    await readGoalPlan({ goalId, evaluations: 2_000, persist: true });
    await advanceGoals({ memory: noCalibration });
    const record = JSON.parse((await events(goalId, DECISION_EVENT_KIND))[0]!.detail) as DecisionRecord;
    expect(record.evidence.find((e) => e.kind === 'CONTRACT_STATE')).toMatchObject({ sourceRowId: o.id, value: [{ id: 'cag_rc1', state: 'AGREED', fulfilment: null }] });
    await getDb().run(
      `INSERT INTO cash_fulfillment_events (id, project_id, fulfillment_id, opportunity_id, kind, detail, recorded_by, request_key, created_at) VALUES (?, ?, ?, ?, 'ACCEPTED', 'accepted', 'test', 'rk-acc', ?)`,
      ['cfe_rc1', projectId, 'cfl_rc1', o.id, new Date().toISOString()],
    );
    const { ports: p } = ports();
    const report = await reconcileFactChanges({ goalId, ports: p });
    const contract = report.reconsidered.find((r) => r.change.kind === 'CONTRACT_STATE');
    expect(contract?.change).toMatchObject({ sourceRowId: o.id, after: [{ id: 'cag_rc1', fulfilment: 'ACCEPTED' }] });
    expect(contract?.dependents.opportunities).toEqual([o.id]);
  });
});

describe('the pure reading of the wider facts', () => {
  const rows: FactRows = {
    opportunities: [
      { id: 'cop_1', price_cents: 100, currency: 'USD', deadline: null, project_id: 'prj_1', mechanism: 'SERVICE' },
      { id: 'cop_2', price_cents: 100, currency: 'USD', deadline: null, project_id: 'prj_1', mechanism: 'RESALE' },
    ],
    cashNeeds: [],
    goal: { id: 'wst_1', target: null, dueAt: null },
    conversions: [{ projectId: 'prj_1', mechanism: 'SERVICE', lessons: [{ channel: 'email', contacts: 40, answered: 6, agreements: 2 }] }],
    contracts: [{ opportunityId: 'cop_1', agreements: [] }, { opportunityId: 'cop_2', agreements: [] }],
    accounts: [{ integrationId: 'instantly', state: 'CONNECTED' }],
  };
  const refs = worldFactRefs(new Set(['cop_1', 'cop_2']), 'wst_1', rows).map((ref) => {
    const value = factValue(ref, rows);
    return { ...ref, value, fingerprint: sha256(canonicalJson(value)) };
  });
  const record = {
    readingId: 'gpr_w', evidence: refs, predicted: null,
    alternatives: [{ key: 'S1', label: 'S1', verdict: null, opportunityIds: ['cop_1', 'cop_2'], missing: [], constraintsFailed: [], chosen: true }],
    authority: { actor: 'BRAIN' as const, policyVersion: null, policyEventId: null, verdict: 'CURRENT' as const, reason: '' },
    chain: { actions: [] },
  } as unknown as DecisionRecord;

  it('no kind of world fact is skipped by the read-back', () => {
    // These rows hold no cash need; every other world fact kind is on the record.
    expect(new Set(refs.map((r) => r.kind))).toEqual(new Set([...WORLD_FACT_KINDS].filter((k) => k !== 'CASH_NEED_COST')));
    expect(changedFacts(record, rows)).toEqual([]);
  });

  it('a measured conversion rate that moved reconsiders the opportunities of that mechanism only', () => {
    const moved = { ...rows, conversions: [{ projectId: 'prj_1', mechanism: 'SERVICE', lessons: [{ channel: 'email', contacts: 80, answered: 6, agreements: 2 }] }] };
    const changes = changedFacts(record, moved);
    expect(changes.map((c) => [c.kind, c.sourceRowId])).toEqual([['CONVERSION_RATE', 'prj_1:SERVICE']]);
    expect(dependentsOf(record, changes, moved).opportunities).toEqual(['cop_1']);
  });

  it('an account check that is gone is a change to nothing recorded', () => {
    const changes = changedFacts(record, { ...rows, accounts: [] });
    expect(changes).toEqual([expect.objectContaining({ kind: 'ACCOUNT_STATE', sourceRowId: 'instantly', after: null, gone: true })]);
    expect(dependentsOf(record, changes, rows).opportunities).toEqual(['cop_1', 'cop_2']);
  });
});

describe('the pure reading', () => {
  const record = {
    readingId: 'gpr_x',
    evidence: [
      { kind: 'OPPORTUNITY_PRICE' as const, sourceRowId: 'cop_1', value: { priceCents: 100, currency: 'USD' }, fingerprint: '' },
      { kind: 'CASH_NEED_COST' as const, sourceRowId: 'cnd_1', value: { expectedCostCents: 5, state: 'OPEN' }, fingerprint: '' },
      { kind: 'SCENARIO_RUN' as const, sourceRowId: 'scr_1', value: 'scr_1', fingerprint: 'whatever' },
    ],
  };
  const facts = { opportunities: [{ id: 'cop_1', price_cents: 100, currency: 'USD', deadline: null }], cashNeeds: [{ id: 'cnd_1', opportunity_id: 'cop_1', expected_cost_cents: 5, state: 'OPEN' }] };

  it('a row that is gone is a change to nothing recorded, never the old value kept; a scenario id is not read back', async () => {
    const { canonicalJson, sha256 } = await import('../server/services/scenario/model.ts');
    const fp = (v: unknown) => sha256(canonicalJson(v));
    const r = { ...record, evidence: record.evidence.map((e) => (e.kind === 'SCENARIO_RUN' ? e : { ...e, fingerprint: fp(e.value) })) };
    expect(changedFacts(r, facts)).toEqual([]);
    const gone = changedFacts(r, { ...facts, cashNeeds: [] });
    expect(gone).toEqual([expect.objectContaining({ kind: 'CASH_NEED_COST', sourceRowId: 'cnd_1', after: null, gone: true })]);
    expect(reconsiderationId('gpr_x', gone[0]!)).toBe(reconsiderationId('gpr_x', gone[0]!));
    expect(reconsiderationId('gpr_x', gone[0]!)).not.toBe(reconsiderationId('gpr_y', gone[0]!));
  });

  it('a pursued opportunity whose fact did not change is not a dependent action', () => {
    const full = {
      readingId: 'gpr_x', alternatives: [{ key: 'S1', label: 'S1', verdict: null, opportunityIds: ['cop_1', 'cop_2'], missing: [], constraintsFailed: [], chosen: true }],
      authority: { actor: 'BRAIN' as const, policyVersion: 2, policyEventId: 'wse_p', verdict: 'CURRENT' as const, reason: '' }, predicted: { remainingCents: 1 },
      chain: { actions: [{ kind: 'PURSUES' as const, linkId: 'wsl_1', opportunityId: 'cop_1' }, { kind: 'PURSUES' as const, linkId: 'wsl_2', opportunityId: 'cop_2' }] },
    } as unknown as DecisionRecord;
    const deps = dependentsOf(full, [{ kind: 'OPPORTUNITY_PRICE', sourceRowId: 'cop_1', before: null, after: null, beforeFingerprint: 'a', afterFingerprint: 'b', gone: false }], facts);
    expect(deps.opportunities).toEqual(['cop_1']);
    expect(deps.actions.map((a) => (a.kind === 'PURSUES' ? a.opportunityId : a.kind))).toEqual(['cop_1']);
    expect(deps.approvals).toEqual([{ kind: 'OWNER_POLICY', ref: 'wse_p', version: 2 }, { kind: 'CASH_NEED', ref: 'cnd_1', state: 'OPEN' }]);
  });
});

/* A prediction error: 24 predictions at 90%, 16 of them missed for a measured cause. */
const PROJECT = 'prj_cal';
function systematic(cause: MissCause) {
  const predictions: PredictionRow[] = Array.from({ length: 24 }, (_, i) => ({
    id: `cash:${PROJECT}:b-${i}@v1`, claimId: `cash:${PROJECT}:b-${i}`, version: 1, outcome: 'the deal settles', horizonDays: 30, population: 'small bakeries',
    data: ['cash_outcomes:seed'], assumptions: ['reply rate 5%'], probability: 0.9, comparableKey: 'bucket-a', madeAt: '2026-10-01T00:00:00.000Z',
  }));
  const outcomes: OutcomeRow[] = predictions.map((p, i) => ({
    predictionId: p.id, observedAt: `2026-10-${String((i % 27) + 1).padStart(2, '0')}T12:00:00.000Z`, occurred: i >= 16, ...(i < 16 ? { observedCauses: [cause] } : {}), evidence: `cash_outcomes:${p.id}`,
  }));
  return { predictions, outcomes };
}

describe('the goals tick runs the decision-history passes', () => {
  it('a prediction error earns a specific method correction, recorded once, from the tick', async () => {
    const ledger = systematic('CAPACITY');
    const written: { goalId: string; lesson: string; evidence: string }[] = [];
    const ports: CalibrationPorts = {
      goals: async () => [{ goalId: 'wst_cal', projectId: PROJECT }],
      ledger: async () => ({ predictions: ledger.predictions, exposures: [], outcomes: ledger.outcomes }),
      goalRows: async () => ({ readings: [], outcomes: [] }),
      recordedKeys: async (goalId) => new Set(written.filter((w) => w.goalId === goalId).map((w) => w.evidence.slice('calibration-key='.length, 'calibration-key='.length + 32))),
      record: async (goalId, lesson, evidence) => void written.push({ goalId, lesson, evidence }),
    };
    let at = Date.now() + 10 * CALIBRATION_PASS_EVERY_MS;
    const calibration = () => reconcileCalibrationIfDue((at += 2 * CALIBRATION_PASS_EVERY_MS), ports);
    const first = await advanceGoals({ memory: { calibration } });
    const report = first.memory.calibration as Exclude<typeof first.memory.calibration, null | { error: string }>;
    expect(report[0]!.recorded.length).toBeGreaterThan(0);
    expect(report[0]!.classes.EXECUTION_FAILURE).toBeGreaterThan(0);
    expect(written[0]!.lesson).toMatch(/^(\[FACTORY\] )?EXECUTION_FAILURE \(CAPACITY\) in bucket-a: .+\./);
    expect(written[0]!.evidence).toMatch(/supporting \d+: .+; disconfirming \d+/);
    const count = written.length;
    const second = await advanceGoals({ memory: { calibration } });
    expect((second.memory.calibration as typeof report)[0]!.recorded).toEqual([]);
    expect(written).toHaveLength(count);
  });

  it('a failing pass is reported in the tick report and never thrown, and the others still run', async () => {
    let reconsiderRan = false;
    const report = await advanceGoals({
      memory: {
        decisions: async () => {
          throw new Error('decision store unavailable');
        },
        calibration: async () => {
          throw new Error('ledger unavailable');
        },
        reconsider: async () => {
          reconsiderRan = true;
          return null;
        },
      },
    });
    expect(report.memory.decisions).toEqual({ error: 'decision store unavailable' });
    expect(report.memory.calibration).toEqual({ error: 'ledger unavailable' });
    expect(reconsiderRan).toBe(true);
    expect(report.memory.reconsidered).toBeNull();
  });
});
