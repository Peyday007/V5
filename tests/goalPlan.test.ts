/**
 * A rough cash goal, modelled from real rows, judged by an evidence gate.
 *
 * The journeys are the brief's: unknown economics is refused a recommendation;
 * a bigger deal that settles after the deadline loses to a smaller fast one; a
 * plan that ties up more money than allowed is not viable; payments that have
 * not settled do not complete a settled-cash goal; and a plan with every link
 * established and cautious numbers that reach the target is recommendable.
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
import { createWorkstream, getWorkstream, listLinks } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { advanceGoalPlans, listReadings, readGoalPlan, recordGoalOutcome } from '../server/services/goals/plan.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
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
  userId = (
    await createUser({ email: `goal-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function fact(o: CashOpportunity, field: string, value: string, kind: 'EVIDENCE' | 'PERSON' = 'EVIDENCE'): Promise<void> {
  await recordCardFact({ projectId, opportunityId: o.id, field, kind, value, claimId: kind === 'EVIDENCE' ? `clm_${field}_${o.id}` : null, decidedBy: kind === 'EVIDENCE' ? 'BRAIN' : 'PERSON' });
}

/** A qualified, repeatable play with the given economics. */
async function play(input: { title: string; priceCents: number; days?: number; capitalCents?: number; hours?: number; costCents?: number; reach?: boolean; signal?: boolean }): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title: input.title,
    mechanism: 'PRODUCTIZED_SERVICE',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
    source: 'A publisher',
    requiredCapabilities: ['PRODUCE_SPREADSHEET'],
  });
  await fact(o, CAPTURE_KEY, 'Sell a monthly report to each buyer.');
  await fact(o, 'payer', 'Property managers');
  await fact(o, 'delivery', 'A spreadsheet Brain produces.');
  await updateOpportunity(o.id, {
    payer: 'Property managers',
    price_cents: input.priceCents,
    offer_scope: 'One monthly report',
    reachable_channel: input.reach === false ? null : 'Published business email addresses',
    buying_signal: input.signal === false ? null : 'Posted asking for this report',
    signal_observed_at: input.signal === false ? null : inDays(-3),
    peak_funding_cents: input.capitalCents ?? null,
    human_hours: input.hours ?? null,
  });
  await fact(o, 'price', `$${input.priceCents / 100}`);
  if (input.days !== undefined) await fact(o, 'timeToFirstCash', `${input.days} days`);
  if (input.costCents !== undefined) await fact(o, 'directCosts', `$${input.costCents / 100}`);
  if (input.capitalCents !== undefined) await fact(o, 'exposure', `$${input.capitalCents / 100}`);
  return o;
}

async function goal(amountCents: number, capitalCents: number | null = null, days = 30): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: capitalCents, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

describe('a target is read from the ledger, never from promises', () => {
  it('counts only settled money, names what it left out, and completes the goal only at the target', async () => {
    const id = await goal(100_000);
    const key = () => `k${Math.random().toString(36).slice(2, 10)}`;
    await recordMoney({ projectId, kind: 'PIPELINE_AGREED', amountCents: 80_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key() });
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 60_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'pi_1' });
    let reading = (await readTarget((await getWorkstream(id))!))!;
    expect(reading.achievedCents).toBe(0);
    expect(reading.achieved).toBe(false);
    expect(reading.notCounted.map((one) => one.label).join(' ')).toMatch(/pipeline.*settled/);
    expect((await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === id)!.lifecycle).toBe('ACTIVE');

    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 100_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'po_1' });
    reading = (await readTarget((await getWorkstream(id))!))!;
    expect(reading).toMatchObject({ achievedCents: 100_000, achieved: true, remainingCents: 0 });
    const view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === id)!;
    expect(view.lifecycle).toBe('COMPLETE');
    expect(view.lifecycleReason).toMatch(/ledger shows 1000/);
  });

  it('refuses a target it cannot count honestly', async () => {
    const g = await createWorkstream({ projectId, title: 'x', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const w = (await getWorkstream(g.id))!;
    expect((await setTarget({ goal: w, metric: 'BOOKINGS', amountCents: 1, currency: 'USD', projectId })).ok).toBe(false);
    expect((await setTarget({ goal: w, metric: 'SETTLED_CASH', amountCents: 0, currency: 'USD', projectId })).ok).toBe(false);
    expect((await setTarget({ goal: w, metric: 'SETTLED_CASH', amountCents: 1, currency: 'USD', projectId: 'prj_nope' })).ok).toBe(false);
  });
});

describe('the gate', () => {
  it('withholds a recommendation when nobody has asked a buyer, names the test and who can run it', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(200_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.verdict).toBe('NEEDS_EVIDENCE');
    expect(reading.nextTest?.link).toBe('CONVERSION');
    // No commercial grant exists, so a person has to allow the test.
    expect(reading.nextTest?.by).toBe('PERSON');
    expect(reading.nextTest?.blocker).toMatch(/CONTACT_BUYER/);
    expect(reading.measuredChance).toBeNull();
    // Unknown agreement rates are swept: coverage, never a probability.
    expect(reading.strategies[0]!.sweep.probabilistic).toBe(false);
  });

  it('is not fooled by detail: more prose changes nothing', async () => {
    const o = await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(200_000);
    const before = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    await updateOpportunity(o.id, { economics_note: 'We are extremely confident: 95% of buyers will say yes. '.repeat(20) });
    await fact(o, 'recommendation', 'Certain to succeed.', 'PERSON');
    const after = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(after.verdict).toBe(before.verdict);
    expect(after.nextTest?.link).toBe(before.nextTest?.link);
  });

  it('lets a smaller fast plan beat a bigger one that settles after the deadline', async () => {
    await play({ title: 'Big contract paid in 45 days', priceCents: 1_500_000, days: 45, capitalCents: 0, hours: 10, costCents: 10_000 });
    await play({ title: 'Quick reports paid in a week', priceCents: 300_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 4_000 }))!;
    const big = reading.strategies.find((one) => one.label.includes('Big contract'))!;
    const quick = reading.strategies.find((one) => one.label.includes('Quick reports'))!;
    expect(big.verdict).toBe('NOT_VIABLE');
    expect(big.constraintsFailed.join(' ')).toMatch(/settles in 45 days/);
    expect(quick.verdict).not.toBe('NOT_VIABLE');
    expect(reading.chosen).not.toBe(big.key);
  });

  it('marks a plan not viable when it ties up more money than allowed', async () => {
    await play({ title: 'Needs stock up front', priceCents: 1_200_000, days: 7, capitalCents: 400_000, hours: 3, costCents: 2_000 });
    const id = await goal(1_000_000, 50_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.verdict).toBe('NOT_VIABLE');
    expect(reading.strategies[0]!.constraintsFailed.join(' ')).toMatch(/more than the 500 ceiling/);
  });

  it('recommends only when every link is established and the cautious numbers reach the target', async () => {
    // Fulfilment is a real proof: Brain renders and verifies a sample of the deliverable.
    expect((await proveCapabilities()).SPREADSHEET.available).toBe(true);
    const o = await play({ title: 'Agreed monthly reports', priceCents: 400_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    await insertAgreement({ projectId, opportunityId: o.id, amountCents: 1_200_000, currency: 'USD', deliverable: 'reports', acceptanceCondition: 'delivered', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: 'email-1', recordedBy: 'PERSON', requestKey: 'agree-1' });
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true }))!;
    expect(reading.verdict).toBe('RECOMMENDABLE');
    expect(reading.strategies[0]!.links.every((one) => one.ok)).toBe(true);
    // No success percentage: there is no record of earlier recommended plans.
    expect(reading.measuredChance).toBeNull();
    // The recommended plan's opportunity is now work the goal pursues.
    expect((await listLinks(id)).some((one) => one.kind === 'OPPORTUNITY' && one.ref === o.id && one.relation === 'PURSUES')).toBe(true);
    expect(reading.scenarioRunId).toBeTruthy();
  });

  it('does not let one buyer saying yes stand for a rate: a smaller agreement still needs evidence', async () => {
    const o = await play({ title: 'One agreed, more needed', priceCents: 400_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    await insertAgreement({ projectId, opportunityId: o.id, amountCents: 400_000, currency: 'USD', deliverable: 'reports', acceptanceCondition: 'delivered', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: 'email-2', recordedBy: 'PERSON', requestKey: 'agree-2' });
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.verdict).toBe('NEEDS_EVIDENCE');
    expect(reading.nextTest?.link).toBe('CONVERSION');
  });

  it('records a reading only when the conclusion changes, and the outcome once', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true });
    await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true });
    expect(await listReadings(id)).toHaveLength(1);
    expect((await listReadings(id))[0]!.scenario_run_id).toBeTruthy();

    // Not met by the due date: recorded as missed, once, and kept.
    const late = new Date(now.getTime() + 40 * 86_400_000);
    expect(await recordGoalOutcome(id, late)).toBe('MISSED');
    expect(await recordGoalOutcome(id, late)).toBeNull();
    const rows = await getDb().all<{ kind: string }>('SELECT kind FROM goal_outcomes WHERE workstream_id = ?', [id]);
    expect(rows.map((one) => one.kind)).toEqual(['MISSED']);
  });

  it('says why there is nothing to model rather than inventing a plan', async () => {
    const id = await goal(100_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.verdict).toBe('NEEDS_EVIDENCE');
    expect(reading.refusal).toMatch(/no live opportunity/);
    expect(reading.strategies).toEqual([]);
  });

  it('runs on the tick without a person and does not run again inside the refresh window', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(100_000);
    expect((await advanceGoalPlans(now)).read).toBe(1);
    expect((await advanceGoalPlans(new Date(now.getTime() + 60_000))).read).toBe(0);
    expect(await listReadings(id)).toHaveLength(1);
  });
});
