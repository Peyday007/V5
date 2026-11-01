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
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { linkWorkstream } from '../server/repos/register.ts';
import { recordAction } from '../server/repos/cashActions.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { goalSpendingRefusal, spendingRuleSentence } from '../server/services/goals/spending.ts';
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
async function play(input: { title: string; priceCents: number; days?: number; capitalCents?: number; hours?: number; costCents?: number; reach?: boolean; signal?: boolean; volume?: string | null }): Promise<CashOpportunity> {
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
  // Established by default, so each test exercises the link it names; the
  // market-volume link has its own tests.
  if (input.volume !== null) await fact(o, 'buyerVolume', input.volume ?? '400 property managers are listed in the state directory; each orders monthly.');
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
    expect(reading.strategies[0]!.constraintsFailed.join(' ')).toMatch(/more than the 500 the owner said this goal may commit/);
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

  it('stays inside the engine limits however many openings there are', async () => {
    for (let i = 0; i < 9; i += 1) await play({ title: `Opening ${i}`, priceCents: 50_000 + i, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.refusal).toBeNull();
    expect(reading.strategies.length).toBeGreaterThan(1);
    expect(reading.excluded.filter((one) => one.reason.includes('openings in one model')).length).toBeGreaterThan(0);
  });

  it('never gives a slot to an opening that has already closed', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    for (let i = 0; i < 4; i += 1) {
      const closed = await play({ title: `Closed ${i}`, priceCents: 90_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
      await getDb().run('UPDATE cash_opportunities SET expires_at = ? WHERE id = ?', [yesterday, closed.id]);
    }
    await play({ title: 'Still open', priceCents: 50_000, days: 7, capitalCents: 0, hours: 3, costCents: 2_000 });
    const id = await goal(1_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.excluded.filter((one) => one.reason.startsWith('closed on'))).toHaveLength(4);
    expect(reading.excluded.some((one) => one.title === 'Still open')).toBe(false);
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


/** A one-off opening: one buyer, one deal, no deliverable of Brain's required. */
async function oneOff(input: { title: string; priceCents: number; days?: number | null; hours?: number; costCents?: number; capitalCents?: number; fulfilledBy?: { who: string; kind: 'PERSON' | 'EVIDENCE' | 'RECOMMENDATION' } }): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title: input.title,
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'PAID_TASK_OR_CONTRACT',
    source: 'A publisher',
    requiredCapabilities: [],
  });
  await fact(o, CAPTURE_KEY, 'Arrange it for the buyer for a fee.');
  await fact(o, 'payer', 'The shipper');
  await updateOpportunity(o.id, {
    payer: 'The shipper',
    price_cents: input.priceCents,
    offer_scope: 'Arrange one load',
    reachable_channel: 'The posted contact on the load board',
    buying_signal: 'Posted this week',
    signal_observed_at: inDays(-2),
    peak_funding_cents: input.capitalCents ?? 0,
    human_hours: input.hours ?? 2,
    fulfillment_owner: input.fulfilledBy?.who ?? null,
  });
  await fact(o, 'price', `$${input.priceCents / 100}`);
  if (input.days !== null) await fact(o, 'timeToFirstCash', `${input.days ?? 5} days`);
  await fact(o, 'directCosts', `$${(input.costCents ?? 1_000) / 100}`);
  await fact(o, 'exposure', `$${(input.capitalCents ?? 0) / 100}`);
  if (input.fulfilledBy) {
    await recordCardFact({
      projectId,
      opportunityId: o.id,
      field: 'fulfillment',
      kind: input.fulfilledBy.kind,
      value: input.fulfilledBy.who,
      claimId: input.fulfilledBy.kind === 'EVIDENCE' ? `clm_ful_${o.id}` : null,
      decidedBy: input.fulfilledBy.kind === 'PERSON' ? 'PERSON' : 'BRAIN',
      ...(input.fulfilledBy.kind === 'RECOMMENDATION' ? { basis: 'b', assumptions: 'a', uncertainty: 'c' } : {}),
    });
  }
  return o;
}

describe("a goal's own resources, combinations and reach (2026-10-28)", () => {
  it('does not treat unstated capital as zero, and asks the owner rather than refusing', async () => {
    const o = await play({ title: 'Stock bought then resold', priceCents: 1_200_000, days: 7, capitalCents: 400_000, hours: 3, costCents: 2_000 });
    await insertAgreement({ projectId, opportunityId: o.id, amountCents: 1_200_000, currency: 'USD', deliverable: 'stock', acceptanceCondition: 'delivered', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: 'po-1', recordedBy: 'PERSON', requestKey: 'agree-stock' });
    await proveCapabilities();

    // Nobody said how much may be committed: no ceiling to break, and a question for the owner.
    const unstated = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    expect(unstated.target.capitalCeilingCents).toBeNull();
    expect(unstated.strategies[0]!.constraintsFailed.join(' ')).not.toMatch(/ties up/);
    expect(unstated.verdict).toBe('NEEDS_EVIDENCE');
    expect(unstated.nextTest).toMatchObject({ link: 'ECONOMICS', by: 'PERSON' });
    expect(unstated.nextTest!.test).toMatch(/ties up about 4000 USD/);

    // The owner says more may be used: the same plan is recommendable.
    expect((await readGoalPlan({ goalId: await goal(1_000_000, 1_000_000), evaluations: 2_000 }))!.verdict).toBe('RECOMMENDABLE');
    // The owner says less: not viable, and it says why.
    const tight = (await readGoalPlan({ goalId: await goal(1_000_000, 100_000), evaluations: 2_000 }))!;
    expect(tight.verdict).toBe('NOT_VIABLE');
    expect(tight.strategies[0]!.constraintsFailed.join(' ')).toMatch(/ties up 4000 USD, more than the 1000/);
  });

  it('keeps what the owner has to work with on the goal, as context and never as permission', async () => {
    const g = await createWorkstream({ projectId, title: 'g', intent: 'g', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, resources: 'A box truck, two helpers on weekends, a contact at a regional liquidator' });
    expect(set.ok).toBe(true);
    expect((await readTarget((await getWorkstream(g.id))!))!.resources).toMatch(/box truck/);
  });

  it('combines openings by what each actually offers, with no fixed count or split', async () => {
    await oneOff({ title: 'Refrigerated load to Chicago', priceCents: 600_000, fulfilledBy: { who: 'A partner carrier', kind: 'PERSON' } });
    await oneOff({ title: 'Machinery finder fee', priceCents: 500_000, fulfilledBy: { who: 'The dealer handles the sale', kind: 'EVIDENCE' } });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 4_000 }))!;
    const singles = reading.strategies.filter((one) => one.key.startsWith('only_'));
    expect(singles.every((one) => one.constraintsFailed.some((why) => /cannot reach/.test(why)))).toBe(true);
    const combined = reading.strategies.find((one) => one.key.startsWith('combine_'))!;
    expect(combined.opportunityIds).toHaveLength(2);
    expect(combined.constraintsFailed.join(' ')).not.toMatch(/cannot reach/);
    // The combination reaches the target on paper, but nothing is established
    // yet, so it is not a realistic plan and Brain keeps looking.
    expect(reading.verdict).not.toBe('RECOMMENDABLE');
    expect(reading.needsMoreOpenings).toBe(true);
    // Delivered by somebody other than Brain, named by a person and by a source.
    expect(combined.links.find((one) => one.link === 'FULFILMENT')!.ok).toBe(true);
  });

  it('one opening may carry the whole goal, and then nothing is combined for its own sake', async () => {
    await oneOff({ title: 'One large brokered sale', priceCents: 2_000_000 });
    await oneOff({ title: 'A small extra job', priceCents: 50_000 });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    const combined = reading.strategies.find((one) => one.key === 'combine_reach');
    // Largest reach first covers the goal alone, so that combination is not built.
    expect(combined).toBeUndefined();
    expect(reading.strategies.find((one) => one.label.includes('One large'))!.constraintsFailed.join(' ')).not.toMatch(/cannot reach/);
  });

  it("does not count Brain's own guess at who fulfils it as a way to deliver", async () => {
    await oneOff({ title: 'Guessed fulfiller', priceCents: 2_000_000, fulfilledBy: { who: 'Some carrier, probably', kind: 'RECOMMENDATION' } });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    expect(reading.strategies[0]!.links.find((one) => one.link === 'FULFILMENT')).toMatchObject({ ok: false, basis: 'nobody has established who would do the work' });
  });

  it('gives the slots to what could reach the goal, not to whatever is newest', async () => {
    await oneOff({ title: 'The one that matters', priceCents: 900_000 });
    for (let i = 0; i < 5; i += 1) await oneOff({ title: `Tiny job ${i}`, priceCents: 1_000 + i });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    expect(reading.strategies.some((one) => one.label.includes('The one that matters'))).toBe(true);
    expect(reading.excluded.some((one) => one.title === 'The one that matters')).toBe(false);
  });

  it('looks for more when what it holds cannot reach the goal, through ordinary discovery, once a day', async () => {
    await oneOff({ title: 'Too small', priceCents: 30_000 });
    const g = await createWorkstream({ projectId, title: 'Ten thousand in a month', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, resources: 'a box truck and two weekend helpers' });

    const all = async () => (await listRounds(projectId)).filter((one) => one.bucketId.startsWith(`goal-${g.id}-`));
    // Lens rounds ask the world; `-mx-` rounds ask about arrangements Brain constructed (§81).
    const mine = async () => (await all()).filter((one) => !one.bucketId.includes('-mx-'));
    const first = await advanceGoalPlans(now);
    expect(first.asked).toBe(1);
    expect(first.constructed).toBe(1);
    expect((await all()).filter((one) => one.bucketId.includes('-mx-'))).toHaveLength(1);
    const rounds = await mine();
    expect(rounds.map((one) => one.bucketId)).toEqual([`goal-${g.id}-open`]);
    // The round is the goal's own work, so the goal's rank reaches its bins.
    expect(
      (await listLinks(g.id)).some((one) => one.kind === 'CANDIDATE' && one.ref === rounds[0]!.candidateId && one.relation === 'PURSUES'),
    ).toBe(true);
    const statement = (await getCandidate(rounds[0]!.candidateId))!.statement;
    expect(statement).toMatch(/any way at all, in any market, industry or arrangement/);
    expect(statement).toMatch(/reach at most USD 300/);
    expect(statement).toMatch(/look for different kinds: "Too small"/);
    expect(statement).toMatch(/box truck/);
    expect(statement).toMatch(/has not said how much of their own capital/);

    // Each later read asks from a different angle, never the same one twice at once…
    for (let i = 1; i <= 4; i += 1) await advanceGoalPlans(new Date(now.getTime() + i * 31 * 60_000));
    const lenses = (await mine()).map((one) => one.bucketId.slice(`goal-${g.id}-`.length));
    expect(lenses.sort()).toEqual(['consumer', 'open']);
    // …and no more than three are open at once, constructed rounds included.
    expect((await all()).filter((one) => one.state === 'OPEN')).toHaveLength(3);
    // Three is how many run at once, not how many are asked: when one settles,
    // a new angle is asked in its place.
    const settled = (await mine()).find((one) => one.bucketId.endsWith('-open'))!;
    await getDb().run(`UPDATE cash_discovery_rounds SET state = 'HARVESTED', found = 0, harvested_at = ? WHERE candidate_id = ?`, [now.toISOString(), settled.candidateId]);
    await advanceGoalPlans(new Date(now.getTime() + 6 * 31 * 60_000));
    const after = (await mine()).map((one) => one.bucketId.slice(`goal-${g.id}-`.length));
    expect(after.sort()).toEqual(['brokerage', 'consumer', 'open']);
  });
});


describe("the owner's pace: a test stage before money arrives, then spread over the month (2026-10-28)", () => {
  async function pacedGoal(): Promise<string> {
    const g = await createWorkstream({ projectId, title: 'Ten thousand this month', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    const set = await setTarget({
      goal: (await getWorkstream(g.id))!,
      metric: 'SETTLED_CASH',
      amountCents: 1_000_000,
      currency: 'USD',
      projectId,
      capitalCeilingCents: 300_000,
      capitalBeforeProofCents: 30_000,
      capitalPerWeekCents: 75_000,
      now: new Date(now.getTime() - 60_000),
    });
    expect(set.ok).toBe(true);
    return g.id;
  }
  async function pursued(goalId: string, title: string, capitalCents: number, executing = false, priceCents = 400_000): Promise<CashOpportunity> {
    const o = await oneOff({ title, priceCents, capitalCents });
    await linkWorkstream({ workstreamId: goalId, kind: 'OPPORTUNITY', ref: o.id, relation: 'PURSUES', recordedBy: 'PERSON' });
    if (executing) {
      await getDb().run(`UPDATE cash_opportunities SET state = 'EXECUTING' WHERE id = ?`, [o.id]);
      const grant = await createAuthority({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'g', allowedActions: ['CONTACT_BUYER'], prohibitions: [], maxCommittedCents: 1_000_000, maxPerActionCents: 1_000_000, maxConcurrent: 5, currency: 'USD' });
      await recordAction({ projectId, opportunityId: o.id, authorityId: grant.id, action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'started', confirmedBy: userId, requestKey: `start-${o.id}` });
    }
    return o;
  }

  it('holds spending to the test stage until a customer payment arrives', async () => {
    const id = await pacedGoal();
    const small = await pursued(id, 'A small test campaign', 20_000);
    const big = await pursued(id, 'The full campaign', 150_000);
    expect(await goalSpendingRefusal({ opportunity: small, neededCents: 20_000 })).toBeNull();
    expect(await goalSpendingRefusal({ opportunity: big, neededCents: 150_000 })).toMatch(/Until a customer payment arrives.*at most USD 300.*proof it works/);

    // Proof: a verified customer payment since the target was set.
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 50_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: 'proof-1', verifiedReference: 'pi_proof' });
    // Past the test stage, the weekly pace still spreads it out: 1500 is more than 750 a week.
    expect(await goalSpendingRefusal({ opportunity: big, neededCents: 150_000 })).toMatch(/at most USD 750 in any seven days/);
    expect(await goalSpendingRefusal({ opportunity: big, neededCents: 60_000 })).toBeNull();
  });

  it('counts what this week already started, and never goes past the total', async () => {
    const id = await pacedGoal();
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 50_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: 'proof-2', verifiedReference: 'pi_proof2' });
    await pursued(id, 'Started this week', 60_000, true);
    const next = await pursued(id, 'Next one', 30_000);
    expect(await goalSpendingRefusal({ opportunity: next, neededCents: 30_000 })).toMatch(/USD 600 was started this week/);
    // A week later the room is back.
    expect(await goalSpendingRefusal({ opportunity: next, neededCents: 30_000, now: inDaysDate(8) })).toBeNull();
    // And the total holds whatever the week says.
    expect(await goalSpendingRefusal({ opportunity: next, neededCents: 250_000, now: inDaysDate(8) })).toMatch(/at most USD 3000/);
  });

  it('says the rule in words, and holds the plan to it', async () => {
    const id = await pacedGoal();
    const target = (await readTarget((await getWorkstream(id))!))!;
    expect(spendingRuleSentence(target)).toBe('at most USD 300 before any money comes in; at most USD 750 newly tied up a week; at most USD 3000 in all');
    await pursued(id, 'A campaign', 20_000, false, 2_000_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.nextTest?.link).toBe('CONVERSION');
    expect(reading.nextTest?.test).toMatch(/no more than 300 USD until money comes in/);
  });

  it('changes nothing for a goal whose owner set no pace', async () => {
    const id = await goal(1_000_000);
    const o = await pursued(id, 'Unpaced', 900_000);
    expect(await goalSpendingRefusal({ opportunity: o, neededCents: 900_000 })).toBeNull();
  });
});

function inDaysDate(n: number): Date {
  return new Date(now.getTime() + n * 86_400_000);
}

describe('where the pace binds', () => {
  it('is asked where execution begins, after the capital the ledger can cover', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../server/services/cash/opportunities.ts', import.meta.url), 'utf8');
    const capital = source.indexOf('cents are deployable. Settle something');
    const paced = source.indexOf('await goalSpendingRefusal({ opportunity, neededCents: needed })');
    expect(capital).toBeGreaterThan(0);
    expect(paced).toBeGreaterThan(capital);
  });
});

describe('how the money actually arrives (2026-10-28)', () => {
  async function pacedGoalFor(amountCents = 1_000_000): Promise<string> {
    const g = await createWorkstream({ projectId, title: 'Ten thousand, little by little', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, capitalPerWeekCents: 75_000, now: new Date(now.getTime() - 60_000) });
    return g.id;
  }

  it('recognises an opening that is won by competing for an award', async () => {
    const { isCompetitiveAward } = await import('../server/services/cash/goalScenario.ts');
    for (const title of ['RFPMart lists RFP DE-5507, records scanning', 'Market: US federal grants (NEH cooperative agreements)', 'Market: US federal procurement (SAM.gov)', 'City tender for snow removal']) {
      expect(isCompetitiveAward({ title, source: null, buyingSignal: null }), title).toBe(true);
    }
    for (const title of ['Refrigerated load to Chicago', 'Liquidation lot of cordless drills', 'Property managers buy owner reports']) {
      expect(isCompetitiveAward({ title, source: null, buyingSignal: null }), title).toBe(false);
    }
  });

  it('does not count a big award as reach, and keeps looking rather than resting on it', async () => {
    await oneOff({ title: 'Federal RFP for records digitization', priceCents: 13_502_000, days: null });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    const award = reading.strategies[0]!;
    expect(award.links.find((one) => one.link === 'SETTLES_IN_TIME')!.basis).toMatch(/only after winning an award/);
    expect(award.constraintsFailed.join(' ')).toMatch(/cannot reach/);
    expect(reading.needsMoreOpenings).toBe(true);
  });

  it("refuses a plan that only pays in one lump after somebody else decides, when the owner wants it step by step", async () => {
    await oneOff({ title: 'NEH grant: cooperative agreement for archives', priceCents: 2_000_000, days: 10 });
    const reading = (await readGoalPlan({ goalId: await pacedGoalFor(), evaluations: 2_000 }))!;
    expect(reading.verdict).toBe('NOT_VIABLE');
    expect(reading.strategies[0]!.constraintsFailed.join(' ')).toMatch(/not little by little/);
  });

  it('puts a way that pays in steps ahead of an award of the same footing', async () => {
    await oneOff({ title: 'Federal bid for scanning services', priceCents: 1_200_000 });
    await oneOff({ title: 'Recurring freight loads for a distributor', priceCents: 1_200_000 });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    const chosen = reading.strategies.find((one) => one.key === reading.chosen)!;
    expect(chosen.label).toMatch(/freight/);
  });

  it('refuses a plan where no step can start inside the test budget', async () => {
    await oneOff({ title: 'Buy and resell a pallet', priceCents: 1_200_000, capitalCents: 100_000 });
    const reading = (await readGoalPlan({ goalId: await pacedGoalFor(), evaluations: 2_000 }))!;
    expect(reading.strategies[0]!.constraintsFailed.join(' ')).toMatch(/no step can start with 300 USD or less tied up/);
  });

  it("asks the goal's own discovery for ways that pay step by step", async () => {
    await oneOff({ title: 'Federal RFP, too slow', priceCents: 13_502_000, days: null });
    const id = await pacedGoalFor();
    expect((await advanceGoalPlans(now)).asked).toBe(1);
    const round = (await listRounds(projectId)).find((one) => one.bucketId.startsWith(`goal-${id}-`))!;
    const statement = (await getCandidate(round.candidateId))!.statement;
    expect(statement).toMatch(/come in step by step/);
    expect(statement).toMatch(/no more than USD 300 tied up before the first payment/);
    expect(statement).toMatch(/only pays after a competitive award/);
  });

  it("compiles a goal's own round to accept a repeating buyer pattern as well as one open request (§80)", async () => {
    await oneOff({ title: 'Federal RFP, too slow', priceCents: 13_502_000, days: null });
    const id = await pacedGoalFor();
    expect((await advanceGoalPlans(now)).asked).toBe(1);
    const round = (await listRounds(projectId)).find((one) => one.bucketId.startsWith(`goal-${id}-`))!;
    // Off the in-code slug map, so the round compiles under the sprint's own discovery envelope.
    await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`goalmech-${projectId.slice(-6)}`, projectId]);
    const { compileMission } = await import('../server/services/russell/compiler.ts');
    const { getProject } = await import('../server/repos/projects.ts');
    const compiled = await compileMission({
      candidate: (await getCandidate(round.candidateId))!,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const lanes = compiled.mission.fragments[0]!.requiredEvidence;
    expect(lanes.find((lane) => lane.id === 'demand_signal')!.necessity).toBe('CONDITIONAL');
    const pattern = lanes.find((lane) => lane.id === 'demand_pattern')!;
    expect(pattern.necessity).toBe('CONDITIONAL');
    expect(pattern.evidenceKind).toBe('MARKET_PATTERN');
  });

  it("searches for the goal even while bulk Claude discovery is switched off", async () => {
    await oneOff({ title: 'Federal RFP, too slow', priceCents: 13_502_000, days: null });
    const id = await pacedGoalFor();
    const before = process.env['BRAIN_CLAUDE_DISCOVERY'];
    process.env['BRAIN_CLAUDE_DISCOVERY'] = 'off';
    try {
      expect((await advanceGoalPlans(now)).asked).toBe(1);
      expect((await listRounds(projectId)).filter((one) => one.bucketId.startsWith(`goal-${id}-`) && !one.bucketId.includes('-mx-'))).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env['BRAIN_CLAUDE_DISCOVERY'];
      else process.env['BRAIN_CLAUDE_DISCOVERY'] = before;
    }
  });
});


describe('Brain keeps looking until a plan is realistic, and digs into what it holds', () => {
  it("does not count a guessed or listed price as money, however big", async () => {
    const o = await oneOff({ title: 'Flip a domain listed at 36,000', priceCents: 3_600_000 });
    // The card's price came from Brain's proposal, not from anything buyers paid.
    await recordCardFact({ projectId, opportunityId: o.id, field: 'price', kind: 'RECOMMENDATION', value: '$36000', claimId: null, decidedBy: 'BRAIN', basis: 'listing', assumptions: 'a', uncertainty: 'u' });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    const only = reading.strategies[0]!;
    expect(only.links.find((one) => one.link === 'OFFER_AND_PRICE')!).toMatchObject({ ok: false });
    expect(only.links.find((one) => one.link === 'OFFER_AND_PRICE')!.basis).toMatch(/is a guess/);
    expect(only.constraintsFailed.join(' ')).toMatch(/at prices buyers are shown to pay/);
    expect(reading.bestReach).toBe(0);
    expect(reading.needsMoreOpenings).toBe(true);
  });

  it('judges every opening it holds, not only the few the simulation fits', async () => {
    for (let i = 0; i < 7; i += 1) await oneOff({ title: `Opening ${i}`, priceCents: 200_000 + i });
    const reading = (await readGoalPlan({ goalId: await goal(1_000_000), evaluations: 2_000 }))!;
    expect(reading.considered).toHaveLength(7);
    expect(reading.considered.filter((one) => one.modelled)).toHaveLength(4);
    expect(reading.considered.every((one) => Array.isArray(one.missing))).toBe(true);
  });

  it('raises research for the path to the money on the openings closest to a plan', async () => {
    const o = await oneOff({ title: 'Freight loads with unknown payment timing', priceCents: 2_000_000, days: null });
    const id = await goal(1_000_000);
    const result = await advanceGoalPlans(now);
    expect(result.researched).toBeGreaterThan(0);
    const { listNeeds } = await import('../server/repos/cashPortfolio.ts');
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.opportunityId === o.id);
    const timing = needs.find((one) => one.requestKey === `question:${o.id}:timeToFirstCash`)!;
    expect(timing.nextStep).toMatch(/each step, who decides it, how long each takes, and the published payment or payout terms/);
    // Asking again does not duplicate it.
    await advanceGoalPlans(new Date(now.getTime() + 31 * 60_000));
    expect((await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.requestKey === `question:${o.id}:timeToFirstCash`)).toHaveLength(1);
    expect(id).toBeTruthy();
  });

  it('spends no research on an opening too small to matter, and asks a guessed one only what buyers pay', async () => {
    const small = await oneOff({ title: 'A one-off bounty worth little', priceCents: 25_000, days: null });
    const guessed = await oneOff({ title: 'A big listing at a guessed price', priceCents: 3_600_000, days: null });
    await recordCardFact({ projectId, opportunityId: guessed.id, field: 'price', kind: 'RECOMMENDATION', value: '$36000', claimId: null, decidedBy: 'BRAIN', basis: 'listing', assumptions: 'a', uncertainty: 'u' });
    await goal(1_000_000);
    await advanceGoalPlans(now);
    const { listNeeds } = await import('../server/repos/cashPortfolio.ts');
    const open = await listNeeds({ projectId, states: ['OPEN'] });
    expect(open.filter((one) => one.opportunityId === small.id && one.requestKey?.startsWith('question:'))).toHaveLength(0);
    expect(open.filter((one) => one.opportunityId === guessed.id).map((one) => one.requestKey)).toEqual([`question:${guessed.id}:revenueRange`]);
  });

  it("does not count Brain's own estimate as an answer, so a question is researched rather than churned", async () => {
    const o = await oneOff({ title: 'Freight loads with unknown payment timing', priceCents: 2_000_000, days: null });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'timeToFirstCash', kind: 'RECOMMENDATION', value: '30', claimId: null, decidedBy: 'BRAIN', basis: 'b', assumptions: 'a', uncertainty: 'u' });
    await goal(1_000_000);
    const { listNeeds } = await import('../server/repos/cashPortfolio.ts');
    const { readNeedCondition } = await import('../server/services/cash/conditions.ts');
    for (let i = 0; i < 3; i += 1) await advanceGoalPlans(new Date(now.getTime() + i * 31 * 60_000));
    const timing = (await listNeeds({ projectId })).filter((one) => one.requestKey === `question:${o.id}:timeToFirstCash`);
    expect(timing).toHaveLength(1);
    expect(timing[0]!.state).toBe('OPEN');
    expect((await readNeedCondition(timing[0]!))!.holds).toBe(false);
  });

  it('does not ask again for what a source already established', async () => {
    const o = await oneOff({ title: 'A big listing at a guessed price', priceCents: 3_600_000, days: null });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'price', kind: 'RECOMMENDATION', value: '$36000', claimId: null, decidedBy: 'BRAIN', basis: 'listing', assumptions: 'a', uncertainty: 'u' });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'revenueRange', kind: 'EVIDENCE', value: '$200-$400', claimId: null, decidedBy: 'BRAIN', basis: 'b', assumptions: 'a', uncertainty: 'u' });
    await goal(1_000_000);
    for (let i = 0; i < 3; i += 1) await advanceGoalPlans(new Date(now.getTime() + i * 31 * 60_000));
    const { listNeeds } = await import('../server/repos/cashPortfolio.ts');
    expect((await listNeeds({ projectId })).filter((one) => one.requestKey === `question:${o.id}:revenueRange`)).toHaveLength(0);
  });

  it('does not let dead questions fill the cap and stop new ones', async () => {
    const o = await oneOff({ title: 'Freight loads with unknown payment timing', priceCents: 2_000_000, days: null });
    await goal(1_000_000);
    const { listNeeds, setNeedCandidate } = await import('../server/repos/cashPortfolio.ts');
    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const { raiseNeed } = await import('../server/services/cash/needs.ts');
    for (let i = 0; i < 12; i += 1) {
      const need = await raiseNeed({ projectId, opportunityId: o.id, actorRef: 'BRAIN', blockedAction: 'old', whyItMatters: 'w', recommendedPath: 'r', setupEffort: 's', nextStep: 'n', completionCondition: 'c', requestKey: `question:${o.id}:old${i}` });
      const idea = await createCandidate({ projectId, title: 't', statement: 's' });
      await setNeedCandidate(need.ok ? need.value.id : '', idea.id);
      await getDb().run(`UPDATE russell_candidates SET state = 'PARKED' WHERE id = ?`, [idea.id]);
    }
    await advanceGoalPlans(now);
    const open = await listNeeds({ projectId, states: ['OPEN'] });
    expect(open.some((one) => one.requestKey === `question:${o.id}:timeToFirstCash`)).toBe(true);
  });

  it('asks a path question again when its research ended without an answer, at most three times', async () => {
    const o = await oneOff({ title: 'Freight loads with unknown payment timing', priceCents: 2_000_000, days: null });
    await goal(1_000_000);
    const { listNeeds, setNeedCandidate } = await import('../server/repos/cashPortfolio.ts');
    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const key = `question:${o.id}:timeToFirstCash`;
    const timing = async () => (await listNeeds({ projectId })).filter((one) => one.requestKey === key);
    let at = now.getTime();
    await advanceGoalPlans(new Date(at));
    for (let round = 1; round <= 4; round += 1) {
      const open = (await timing()).filter((one) => one.state === 'OPEN');
      expect(open).toHaveLength(1);
      expect(open[0]!.occurrence).toBe(Math.min(round, 3));
      // Its research is turned away and nothing more happens to it.
      const idea = await createCandidate({ projectId, title: 't', statement: 's' });
      await setNeedCandidate(open[0]!.id, idea.id);
      await getDb().run(`UPDATE russell_candidates SET state = 'PARKED', updated_at = ? WHERE id = ?`, [new Date(at).toISOString(), idea.id]);
      // A day later the goal asks again, until it has asked three times.
      at += 25 * 60 * 60 * 1000;
      await advanceGoalPlans(new Date(at));
    }
    const all = await timing();
    expect(all.filter((one) => one.state === 'WITHDRAWN')).toHaveLength(2);
    expect(all).toHaveLength(3);
    // Never the same way twice: the second asking turns to other sources, the
    // third to comparable cases, and each names what went wrong before.
    const byAsking = [...all].sort((a, b) => a.occurrence - b.occurrence).map((one) => one.nextStep);
    expect(new Set(byAsking).size).toBe(3);
    expect(byAsking[1]).toMatch(/Do not repeat that approach/);
    expect(byAsking[2]).toMatch(/comparable published cases/);
    expect(byAsking[1]).toMatch(/earlier attempt ended without an answer/);
  });

  it('keeps a barren goal lens searching later, from elsewhere, instead of retiring it', async () => {
    const { nextGoalRoundFor, nextRoundFor } = await import('../server/services/cash/discovery.ts');
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const rounds = [1, 2, 3].map((round) => ({
      round, state: 'HARVESTED', found: 0, openedAt: new Date(t0 + (round - 3) * day).toISOString(), harvestedAt: new Date(t0 + (round - 3) * day).toISOString(),
    })) as never[];
    // A bucket stops after three barren rounds; a goal lens only waits longer.
    expect(nextRoundFor(rounds, new Date(t0 + 30 * day).toISOString())).toBeNull();
    expect(nextGoalRoundFor(rounds, new Date(t0 + 6 * day).toISOString())).toBeNull();
    expect(nextGoalRoundFor(rounds, new Date(t0 + 7 * day + 1).toISOString())).toBe(4);
  });

  it("reaches past its fixed angles into Brain's industry map, and asks how to find openings after an empty search", async () => {
    const { createNode } = await import('../server/repos/industry.ts');
    const { GOAL_LENSES } = await import('../server/services/cash/discovery.ts');
    await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    await oneOff({ title: 'Too small', priceCents: 30_000 });
    const id = await goal(1_000_000);
    const mine = async () => (await listRounds(projectId)).filter((one) => one.bucketId.startsWith(`goal-${id}-`));
    // Every fixed angle has been asked once and came back empty.
    const at = now.getTime();
    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    for (const [i, lens] of GOAL_LENSES.entries()) {
      const c = await createCandidate({ projectId, title: 't', statement: 's' });
      const when = new Date(at - 60 * 60_000).toISOString();
      await getDb().run(
        `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, harvested_at, found, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'OTHER', 1, ?, 'HARVESTED', ?, ?, 0, ?, ?)`,
        [`cdr_lens${i}`, projectId, cashModeId, `goal-${id}-${lens.id}`, c.id, when, when, when, when],
      );
    }
    expect(new Set((await mine()).map((one) => one.bucketId)).size).toBe(GOAL_LENSES.length);
    // The next angle is an industry nobody has looked at, not a fixed one again.
    await advanceGoalPlans(new Date(at));
    const industry = (await mine()).find((one) => one.bucketId.includes('-ind-'))!;
    expect(industry).toBeTruthy();
    expect((await getCandidate(industry.candidateId))!.statement).toMatch(/Commercial laundry industry/);
    expect((await getCandidate(industry.candidateId))!.statement).toMatch(/say how it was found/);
    // Two days later an empty fixed angle is asked again — by first working out how such openings are found.
    await getDb().run(`UPDATE cash_discovery_rounds SET state = 'HARVESTED', found = 0, harvested_at = ? WHERE id = ?`, [new Date(at).toISOString(), industry.id]);
    await advanceGoalPlans(new Date(at + 3 * 24 * 60 * 60 * 1000));
    const again = (await mine()).filter((one) => one.round === 2);
    expect(again.length).toBeGreaterThan(0);
    expect((await getCandidate(again[0]!.candidateId))!.statement).toMatch(/start with how such openings are actually found/);
  });

  it('measures which ways of looking found openings worth having', async () => {
    const { discoveryYield } = await import('../server/services/cash/discoveryYield.ts');
    const o = await oneOff({ title: 'Recurring loads', priceCents: 500_000 });
    const idea = (await import('../server/repos/russellCandidates.ts')).createCandidate;
    const c = await idea({ projectId, title: 't', statement: 's' });
    await getDb().run(`UPDATE cash_opportunities SET discovered_by_candidate_id = ? WHERE id = ?`, [c.id, o.id]);
    await getDb().run(
      `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
       VALUES ('cdr_t1', ?, ?, 'goal-x-logistics', 'OTHER', 1, ?, 'HARVESTED', ?, 1, ?, ?)`,
      [projectId, cashModeId, c.id, now.toISOString(), now.toISOString(), now.toISOString()],
    );
    const reading = await discoveryYield(projectId);
    const row = reading.byMethod.find((one) => one.key === 'goal-x-logistics')!;
    expect(row).toMatchObject({ rounds: 1, openings: 1 });
    expect(row.useful).toBeGreaterThanOrEqual(0);
  });

  it("never asks a goal's question as an instruction to act", async () => {
    const { GOAL_LENSES } = await import('../server/services/cash/discovery.ts');
    const { APPROVAL_ENVELOPES } = await import('../server/services/research/approvalEnvelope.ts');
    const { describesOwnAction } = await import('../server/services/research/actorScope.ts');
    const cash = Object.values(APPROVAL_ENVELOPES).filter((one) => one.id.startsWith('RUSSELL_CASH_'));
    for (const lens of GOAL_LENSES) {
      const text = `Looking at ${lens.angle} — which lawful ways could bring this operation USD 10000 more?`;
      for (const envelope of cash) expect(describesOwnAction(text, envelope.forbiddenActions), `${lens.id} ${envelope.id}`).toBe(false);
    }
  });
});
