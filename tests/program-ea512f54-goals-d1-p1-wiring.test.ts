/**
 * GOAL-13-6, GOAL-18-4, GOAL-23 wired into the goal plan pass (`plan.ts`).
 *
 * Through the real entry point (`readGoalPlan`) on rows: the reading carries
 * the compressed-timeline search, the goal's configured objective with its
 * expected/upper/adverse outcomes, and the distinct plan set; acceptance is
 * judged against the goal's own configured confidence; candidate and accepted
 * stay distinct; no probability is published uncalibrated; and reaching or
 * accepting the target keeps the goal's productive work going, recorded with why.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { insertAgreement } from '../server/repos/cashJourney.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { continuationOf, continueSearch, judgeAcceptance, listReadings, readGoalPlan, settledQuantile, RECOMMENDATION_POLICY, type StrategyReading } from '../server/services/goals/plan.ts';
import { DEFAULT_REQUIRED_CONFIDENCE } from '../server/services/goals/objective.ts';
import { STANDARD_HORIZONS } from '../server/services/goals/timelines.ts';
import { MODEL_FIELDS } from '../server/services/goals/planSet.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { proveCapabilities } from '../server/services/cash/deliverables/capabilities.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `wire-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function fact(o: CashOpportunity, field: string, value: string): Promise<void> {
  await recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
}

async function play(title: string, priceCents: number, days = 7): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
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
  await fact(o, 'timeToFirstCash', `${days} days`);
  await fact(o, 'directCosts', '$20');
  await fact(o, 'exposure', '$0');
  await fact(o, 'buyerVolume', '400 property managers are listed in the state directory; each orders monthly.');
  return o;
}

async function goal(amountCents: number, intent = 'Collect settled cash within the window.', days = 45): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent, purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  await getDb().run(`UPDATE workstreams SET cancelled_at = ? WHERE target_project_id = ? AND target_metric = ? AND cancelled_at IS NULL AND id <> ?`, [now.toISOString(), projectId, 'SETTLED_CASH', g.id]);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

describe('judgeAcceptance reads the goal’s configured confidence (pure)', () => {
  const chosen = { key: 's1', label: 'Monthly reports', verdict: 'RECOMMENDABLE', opportunityIds: ['o1'], links: [], constraintsFailed: [], sweep: { goalMetShare: null, settledP50: null, settledP90: null, infeasibleShare: null, probabilistic: false }, conservativeSettled: 100, chainComplete: true, nextTest: null } as StrategyReading;
  const measuredChance = { estimate: 0.9, lowerBound: 0.85, upperBound: 0.95, sampleSize: 30, cohort: 'earlier plans' };
  const base = { achieved: false, chosen, portfolio: null, measuredChance, considered: [] };

  it('a goal stating 80% is judged against 80%; one stating nothing against the recorded default', () => {
    expect(DEFAULT_REQUIRED_CONFIDENCE).toBe(RECOMMENDATION_POLICY.requiredProbability);
    const unstated = judgeAcceptance(base);
    expect(unstated.required).toBe(0.9);
    expect(unstated.status).toBe('CANDIDATE_ONLY');
    expect(unstated.probability).toBeNull();
    const eighty = judgeAcceptance({ ...base, objective: { requiredConfidence: { value: 0.8, source: 'STATED', statement: '80% chance' } } });
    expect(eighty.required).toBe(0.8);
    expect(eighty.status).toBe('ACCEPTED');
    expect(eighty.probability).toMatchObject({ basis: 'MEASURED_RECORD', lowerBound: 0.85 });
    const ninetyFive = judgeAcceptance({ ...base, measuredChance: { ...measuredChance, lowerBound: 0.92 }, objective: { requiredConfidence: { value: 0.95, source: 'STATED', statement: '95% chance' } } });
    expect(ninetyFive.status).toBe('CANDIDATE_ONLY');
  });
});

describe('the continuation rule: a threshold is a minimum, never a stop (pure)', () => {
  const at = { daysLeft: 20, outcomeRecorded: false, policy: 'EVIDENCE_FIRST' as const };
  it('an achieved goal with its window open keeps working, even with its outcome on the record, and says why', () => {
    const c = continuationOf({ ...at, achieved: true, outcomeRecorded: true, acceptance: 'ACCEPTED', surplus: 1_500 });
    expect(c.continues).toBe(true);
    expect(c.reason).toMatch(/minimum, not a stop/);
    expect(c.surplusForSuccessors).toBe(1_500);
  });
  it('an accepted plan does not end the search for more value', () => {
    expect(continueSearch({ ...at, achieved: false, acceptance: 'ACCEPTED' })).toBe(true);
    expect(continuationOf({ ...at, achieved: false, acceptance: 'ACCEPTED' }).reason).toMatch(/exceed it/);
  });
  it('a closed window, a missed outcome or arithmetic infeasibility still ends it', () => {
    expect(continuationOf({ ...at, daysLeft: 0, achieved: true, acceptance: 'ACCEPTED' }).continues).toBe(false);
    expect(continuationOf({ ...at, outcomeRecorded: true, achieved: false, acceptance: 'CANDIDATE_ONLY' }).continues).toBe(false);
    expect(continuationOf({ ...at, achieved: false, acceptance: 'NOT_SUPPORTED' }).continues).toBe(false);
  });
  it('reads quantiles only between the engine’s own p10 and p90, never an invented tail', () => {
    const m = { p10: 100, p50: 500, p90: 900 };
    expect(settledQuantile(m, 0.01)).toBe(100);
    expect(settledQuantile(m, 0.3)).toBe(300);
    expect(settledQuantile(m, 0.99)).toBe(900);
  });
});

describe('the goal plan pass carries the three readings, from rows', () => {
  it('populates timelines, objective and planSet; keeps candidate and accepted apart; publishes no uncalibrated probability; records them', async () => {
    await proveCapabilities();
    await play('Monthly owner reports', 90_000, 7);
    await play('Quarterly audit packs', 250_000, 20);
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000, persist: true }))!;
    expect(reading.acceptance.status).not.toBe('ACCEPTED');

    // GOAL-13-6: 30/60/90 and the deadline, solved backward; candidates only, coverage not probability.
    const t = reading.timelines!;
    const days = t.horizons.map((h) => h.days);
    for (const d of STANDARD_HORIZONS) expect(days).toContain(d);
    expect(t.horizons.find((h) => h.days === 45)?.origins).toContain('DEADLINE');
    for (const h of t.horizons) {
      expect(h.economics.structures.length).toBeGreaterThan(0);
      expect(h.status).toBe('CANDIDATE');
      expect(h.probability).toBeNull();
      expect(h.reach.basis).not.toBe('PROBABILITY');
    }

    // GOAL-18-4: the goal's configured objective, read as a minimum; a 90% goal is not a floor.
    const o = reading.objective!;
    expect(o.goal.requiredConfidence).toMatchObject({ value: 0.9, source: 'DEFAULT' });
    expect(o.goal.continueBeyondThreshold).toBe(true);
    expect(o.goal.meaning).toMatch(/not a guarantee that the worst outcome/);
    expect(reading.acceptance.required).toBe(0.9);
    if (o.outcome) {
      expect(o.outcome.upper).toBeGreaterThanOrEqual(o.outcome.expected - 1e-6);
      expect(o.outcome.adverse).toBeLessThanOrEqual(o.outcome.upper);
      expect(o.outcome.status).toBe('CANDIDATE');
      expect(o.outcome.meetsConfidence).toBeNull();
      expect(o.outcome.confidenceWithheld).toBeTruthy();
      expect(o.outcome.floor).toBeNull();
      expect(o.outcome.continueExploring).toBe(true);
    }

    // GOAL-23: distinct plans, each with a complete model and a clear status; confidence withheld.
    const s = reading.planSet!;
    expect(s.distinct).toBeGreaterThan(0);
    expect(s.distinct).toBeLessThanOrEqual(s.candidates);
    expect(new Set(s.plans.map((p) => p.signature)).size).toBe(s.plans.length);
    for (const p of s.plans) {
      for (const f of MODEL_FIELDS) expect(p.model[f]).toBeDefined();
      expect(['ACCEPTED', 'PROVISIONAL']).toContain(p.acceptance);
      expect(p.acceptance).toBe('PROVISIONAL');
      expect(p.confidence.withheld).toBe(true);
    }
    expect(s.confidence.withheld).toBe(true);
    expect(s.attempts.executed).toBe(0);
    expect(s.collections.observed).toBe(0);
    if (s.rebuild) expect(s.rebuild.why.length).toBeGreaterThan(0);

    expect(reading.continuation?.continues).toBe(true);
    expect(reading.needsMoreOpenings).toBe(true);

    // The production record carries them: the stored reading's forecast.
    const [row] = await listReadings(id);
    const forecast = JSON.parse(row!.forecast ?? '{}') as Record<string, any>;
    expect(forecast.timelines.horizons.length).toBe(t.horizons.length);
    expect(forecast.objective.requiredConfidence.value).toBe(0.9);
    expect(forecast.planSet.distinct).toBe(s.distinct);
    expect(forecast.continuation.continues).toBe(true);
  });

  it('a goal stating its own confidence is judged against it', async () => {
    await proveCapabilities();
    await play('Monthly owner reports', 90_000, 7);
    const id = await goal(1_000_000, 'Collect settled cash within the window with an 80% chance of reaching the target.');
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.objective!.goal.requiredConfidence).toMatchObject({ value: 0.8, source: 'STATED' });
    expect(reading.acceptance.required).toBe(0.8);
  });

  it('an accepted plan keeps the goal’s productive work going and records why', async () => {
    await proveCapabilities();
    const o = await play('Agreed monthly reports', 400_000, 7);
    await insertAgreement({ projectId, opportunityId: o.id, amountCents: 1_200_000, currency: 'USD', deliverable: 'reports', acceptanceCondition: 'delivered', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: 'email-w', recordedBy: 'PERSON', requestKey: 'agree-w' });
    const history = await createWorkstream({ projectId, title: 'history', intent: 'history', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const at = new Date(now.getTime() - 86_400_000).toISOString();
    for (let i = 0; i < 40; i += 1) {
      await getDb().run(
        `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at) VALUES (?, ?, ?, NULL, NULL, 'RECOMMENDABLE', NULL, '[]', NULL, NULL, ?)`,
        [`gpr_wire_${i}`, history.id, `w${i}`, at],
      );
      await getDb().run(`INSERT INTO goal_outcomes (id, workstream_id, reading_id, kind, achieved_cents, target_cents, detail, observed_at) VALUES (?, ?, ?, 'ACHIEVED', 100, 100, '{}', ?)`, [`gou_wire_${i}`, history.id, `gpr_wire_${i}`, at]);
    }
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000, persist: true }))!;
    expect(reading.acceptance.status).toBe('ACCEPTED');
    expect(reading.continuation).toMatchObject({ continues: true });
    expect(reading.needsMoreOpenings).toBe(true);
    // A receivable agreed on a row is the only basis for a floor, and its limits are named.
    if (reading.objective?.outcome?.floor) expect(reading.objective.outcome.floor.limits.join(' ')).toMatch(/systemic/);
    const events = await listWorkstreamEvents(id);
    expect(events.some((e) => e.kind === 'GOAL_CONTINUES_BEYOND_TARGET')).toBe(true);
  });

  it('a target already collected does not stop the goal while its window is open', async () => {
    const id = await goal(100_000);
    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 150_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: `k${Math.random().toString(36).slice(2, 10)}`, verifiedReference: 'po_w' });
    const reading = (await readGoalPlan({ goalId: id, persist: true }))!;
    expect(reading.target.achieved).toBe(true);
    expect(reading.acceptance.status).toBe('ACCEPTED');
    expect(reading.continuation?.continues).toBe(true);
    expect(reading.continuation?.surplusForSuccessors).toBeGreaterThanOrEqual(500);
    expect(reading.needsMoreOpenings).toBe(true);
    expect(reading.timelines).toBeTruthy();
    expect(reading.planSet).toBeTruthy();
    const events = await listWorkstreamEvents(id);
    expect(events.find((e) => e.kind === 'GOAL_CONTINUES_BEYOND_TARGET')?.summary).toMatch(/minimum, not a stop/);
  });
});
