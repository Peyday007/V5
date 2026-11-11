/**
 * The plan calls the reliability rebuild (F3): a serious candidate's failure
 * paths, the protections its rows establish and the rebuilt plan are part of
 * the stored plan reading and of its evidence, and a changed improvement is a
 * new reading. Driven through `readGoalPlan`, the plan's real entry point.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { listReadings, readGoalPlan, type StrategyReading } from '../server/services/goals/plan.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { assessReliability } from '../server/services/goals/reliability.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({ email: `rel-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function fact(o: CashOpportunity, field: string, value: string): Promise<void> {
  await recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
}

async function play(input: { title: string; priceCents: number; days: number; capitalCents?: number }): Promise<CashOpportunity> {
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
    reachable_channel: 'Published business email addresses',
    buying_signal: 'Posted asking for this report',
    signal_observed_at: inDays(-3),
    peak_funding_cents: input.capitalCents ?? 0,
    human_hours: 3,
  });
  await fact(o, 'price', `$${input.priceCents / 100}`);
  await fact(o, 'timeToFirstCash', `${input.days} days`);
  await fact(o, 'directCosts', '$20');
  await fact(o, 'exposure', `$${(input.capitalCents ?? 0) / 100}`);
  return o;
}

async function goal(amountCents: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

const candidates = (strategies: StrategyReading[]) => strategies.filter((s) => s.verdict !== 'NOT_VIABLE');

describe('the plan engineers the reliability of every serious candidate', () => {
  it('derives failure paths for each candidate and none for a strategy that is not viable', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7 });
    await play({ title: 'Big contract paid in 45 days', priceCents: 1_500_000, days: 45 });
    const id = await goal(200_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(candidates(reading.strategies).length).toBeGreaterThan(0);
    for (const s of reading.strategies) {
      if (s.verdict === 'NOT_VIABLE') expect(s.reliability).toBeNull();
      else {
        expect(s.reliability).not.toBeNull();
        expect(s.reliability!.failurePaths.length).toBeGreaterThan(0);
        // Counts of tested cases, never a probability.
        expect(s.reliability!.after.note).toMatch(/not a probability/);
        expect(s.reliability!.before.tested).toBeGreaterThan(0);
      }
    }
  });

  it('combines an evidenced second opening into a one-opening plan and stores the improvement and its evidence on the reading', async () => {
    const a = await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7 });
    const b = await play({ title: 'Weekly vacancy summaries', priceCents: 40_000, days: 5 });
    const id = await goal(200_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true }))!;
    const single = candidates(reading.strategies).find((s) => s.opportunityIds.length === 1 && s.reliability);
    expect(single).toBeTruthy();
    const other = single!.opportunityIds[0] === a.id ? b.id : a.id;
    const rel = single!.reliability!;
    // One opening is a single customer source: a failure path the plan's own facts state.
    expect(rel.failurePaths.map((p) => p.kind)).toContain('CUSTOMER_ACQUISITION');
    // The other opening's rows establish a buyer, a dated need and a price: an evidenced protection.
    const combined = rel.applied.find((p) => p.kind === 'COMBINE_COMPATIBLE_PATH');
    expect(combined?.evidenceId).toBe(other);
    expect(rel.addedOpportunityIds).toContain(other);
    expect(rel.evidence).toContain(other);
    expect(rel.rebuilt.customers.map((c) => c.id)).toEqual(expect.arrayContaining([single!.opportunityIds[0], other]));
    // No deposit or backup capacity is on record, so those are reported as questions, not invented.
    expect(rel.applied.some((p) => p.kind === 'DEPOSIT_OR_PAYMENT_TERMS' || p.kind === 'BACKUP_CAPACITY')).toBe(false);

    // The stored reading carries it, so the improvement is part of the record, not only of the return value.
    const rows = await listReadings(id);
    expect(rows).toHaveLength(1);
    const stored = (JSON.parse(rows[0]!.strategies) as StrategyReading[]).find((s) => s.key === single!.key)!;
    expect(stored.reliability?.applied.map((p) => p.evidenceId)).toContain(other);
    expect(stored.reliability?.evidence).toContain(other);
    if (rows[0]!.chosen_strategy === single!.key) {
      expect((JSON.parse(rows[0]!.forecast!) as { reliability: { addedOpportunityIds: string[] } }).reliability.addedOpportunityIds).toContain(other);
    }
  });

  it('writes a new reading when the evidenced improvements change, and none when they do not', async () => {
    await play({ title: 'Monthly owner reports', priceCents: 50_000, days: 7 });
    const id = await goal(200_000);
    await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true });
    await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true });
    expect(await listReadings(id)).toHaveLength(1);
    const first = JSON.parse((await listReadings(id))[0]!.strategies) as StrategyReading[];
    expect(first.every((s) => s.verdict === 'NOT_VIABLE' || (s.reliability && s.reliability.applied.length === 0))).toBe(true);

    // A second evidenced opening is a protection the rebuild can now apply: the conclusion changed.
    const b = await play({ title: 'Weekly vacancy summaries', priceCents: 40_000, days: 5 });
    await readGoalPlan({ goalId: id, evaluations: 2_000, persist: true });
    const rows = await listReadings(id);
    expect(rows.length).toBe(2);
    const latest = JSON.parse(rows[1]!.strategies) as StrategyReading[];
    expect(latest.some((s) => s.reliability?.applied.some((p) => p.evidenceId === b.id))).toBe(true);
  });
});

describe('the rebuild measures the plan against the setbacks it was meant to answer', () => {
  it('a combined path raises the cases that still meet the target, and an unknown payment time is never favourable', () => {
    const facts = {
      key: 's', targetCents: 100_000, daysLeft: 30, directCostsCents: 0, upfrontCents: 0, capitalCeilingCents: null,
      capacityHours: 200, neededHours: 10, basis: 'CONSERVATIVE' as const,
      members: [{ opportunityId: 'opp_a', revenueCents: 120_000, fulfilledBy: null, daysToCash: 7, claimId: 'clm_a' }],
    };
    const alone = assessReliability(facts, []);
    const helped = assessReliability(facts, [{ opportunityId: 'opp_b', revenueCents: 150_000 }]);
    expect(alone.applied).toHaveLength(0);
    expect(alone.unprotected.map((u) => u.kind)).toContain('CUSTOMER_ACQUISITION');
    expect(helped.applied.some((p) => p.kind === 'COMBINE_COMPATIBLE_PATH' && p.evidenceId === 'opp_b')).toBe(true);
    expect(helped.after.meetingTarget).toBeGreaterThan(helped.before.meetingTarget);
    expect(helped.evidence).toEqual(expect.arrayContaining(['opp_a', 'clm_a', 'opp_b']));
    // Combined setbacks are tested, not only single ones.
    expect(helped.after.tested).toBeGreaterThan(helped.rebuilt.customers.length);

    const unknownPay = assessReliability({ ...facts, members: [{ ...facts.members[0]!, daysToCash: null }] }, []);
    expect(unknownPay.failurePaths.map((p) => p.kind)).toContain('PAYMENT_DELAY');
    expect(unknownPay.before.meetingTarget).toBe(0);
  });
});
