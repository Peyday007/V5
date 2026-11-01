/**
 * §79 inside the live goal workflow: what other openings' research established
 * is reused to reconstruct an opening's unknowns, the plan's simulation runs on
 * the reconstruction instead of a blind sweep, the gate still refuses to count
 * an inference as an established link, a reconstruction that settles too late
 * makes the strategy not viable, and the run measures which questions could
 * change the choice.
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
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { composeGoalModel } from '../server/services/cash/goalScenario.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { researchGoalPaths } from '../server/services/goals/pathResearch.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashMechanism, CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `quant-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function opening(input: { title: string; priceCents: number; mechanism?: CashMechanism; days?: string }): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title: input.title,
    mechanism: input.mechanism ?? 'PRODUCTIZED_SERVICE',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
    source: 'A publisher',
    requiredCapabilities: ['PRODUCE_SPREADSHEET'],
  });
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, 'Sell a monthly report to each buyer.');
  await fact('payer', 'Property managers');
  await fact('delivery', 'A spreadsheet Brain produces.');
  await updateOpportunity(o.id, { payer: 'Property managers', price_cents: input.priceCents, offer_scope: 'One report', reachable_channel: 'Published emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-2) });
  await fact('price', `$${input.priceCents / 100}`);
  if (input.days) await fact('timeToFirstCash', input.days);
  await fact('buyerVolume', '400 property managers are listed in the state directory; each orders monthly.');
  return o;
}

async function goal(amountCents: number, days: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

describe('an unknown is reconstructed from what other openings established', () => {
  it('replaces the blind 3–60 day sweep with a comparable distribution, and still does not call it established', async () => {
    for (const [i, d] of ['10 days', '12 days', '14 days'].entries()) await opening({ title: `Comparable report ${i}`, priceCents: 40_000, days: d });
    const target = await opening({ title: 'New report with no payment terms', priceCents: 45_000 });
    const id = await goal(500_000, 30);
    const w = (await getWorkstream(id))!;
    const model = await composeGoalModel({ goal: w, target: (await readTarget(w))! });
    const modelled = model.considered.find((one) => one.opportunity.id === target.id)!;
    expect(modelled.daysToCash.inferred?.tier).toBe('COMPARABLE');
    expect(modelled.daysToCash.inferred?.justified).toBe(true);
    expect(modelled.daysToCash.inferred!.p50).toBeGreaterThan(9);
    expect(modelled.daysToCash.inferred!.p50).toBeLessThan(16);
    expect(modelled.daysToCash.value).toBeNull();
    const variable = model.definition.variables.find((one) => one.key === `o${modelled.index || model.included.find((x) => x.opportunity.id === target.id)!.index}_days`);
    expect(variable?.spec.kind).toBe('EMPIRICAL');

    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const inferred = reading.inferred.find((one) => one.opportunityId === target.id && one.field === 'daysToCash');
    expect(inferred?.tier).toBe('COMPARABLE');
    // The gate is unchanged: an inference never establishes a link.
    const only = reading.strategies.find((one) => one.opportunityIds.length === 1 && one.opportunityIds[0] === target.id);
    expect(only?.links.find((one) => one.link === 'SETTLES_IN_TIME')?.ok).toBe(false);
    expect(Array.isArray(reading.researchPriority)).toBe(true);
  });

  it('makes a strategy not viable when comparable evidence says the money arrives after the deadline', async () => {
    for (const [i, d] of ['60 days', '70 days', '75 days'].entries()) await opening({ title: `Slow payer ${i}`, priceCents: 40_000, days: d });
    const target = await opening({ title: 'Another slow payer, terms unknown', priceCents: 45_000 });
    const id = await goal(500_000, 20);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const only = reading.strategies.find((one) => one.opportunityIds.length === 1 && one.opportunityIds[0] === target.id)!;
    expect(only.verdict).toBe('NOT_VIABLE');
    expect(only.constraintsFailed.join(' ')).toMatch(/nine of ten reconstructed cases \(comparable evidence/);
  });

  it('uses another transaction type only as bounds, never as a distribution or a reason to refuse', async () => {
    for (const [i, d] of ['70 days', '80 days'].entries()) await opening({ title: `Resale ${i}`, priceCents: 40_000, days: d, mechanism: 'RESALE_OR_ASSET' });
    const target = await opening({ title: 'Service with unknown terms', priceCents: 45_000 });
    const id = await goal(500_000, 20);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const inferred = reading.inferred.find((one) => one.opportunityId === target.id && one.field === 'daysToCash');
    expect(inferred?.tier).toBe('MECHANISM');
    expect(inferred?.justified).toBe(false);
    const only = reading.strategies.find((one) => one.opportunityIds.length === 1 && one.opportunityIds[0] === target.id)!;
    expect(only.constraintsFailed.join(' ')).not.toMatch(/reconstructed/);
  });

  it('does not research a question the run measured as unable to change the choice', async () => {
    await opening({ title: 'Report A', priceCents: 40_000 });
    const id = await goal(500_000, 30);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const fake = { ...reading, researchPriority: reading.considered.map((one) => ({ variable: 'o1_days', opportunityId: one.opportunityId, field: 'timeToFirstCash', value: 0, changesDecision: false, decision: 'IGNORE' as const, reason: 'whatever the answer, the same choice is best, so researching it buys nothing' })) };
    const trace: string[] = [];
    await researchGoalPaths({ reading: fake, projectId, now, trace, dryRun: true });
    expect(trace.join('\n')).toMatch(/timeToFirstCash: not asked — ignore: whatever the answer/);
  });
});
