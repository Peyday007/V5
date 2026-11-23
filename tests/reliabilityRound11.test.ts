/**
 * planningReliability round 11.
 *
 * - A fulfiller is the party it names, not the words describing it: "owner of
 *   the panels" or "the tent owner" inside a supplier's description is what
 *   that supplier owns, never the goal's owner doing the delivery.
 * - A qualified opening left out only because its card names the owner doing
 *   physical work lacks a fulfiller, not an offer: the next test is FULFILMENT.
 * - Adaptation: a capital ceiling the owner removed is their answer (no limit),
 *   so neither the figure the objective first stated nor a figureless phrase
 *   reopens the capital question; and an opening stopped while the goal runs
 *   (archived — the buyer withdrew) is excluded with its recorded reason rather
 *   than vanishing from the reading.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream, recordWorkstreamEvent } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget, setTargetLimits } from '../server/services/goals/target.ts';
import { composeGoalModel, fulfillerIsOwner } from '../server/services/cash/goalScenario.ts';
import { archiveOpportunity } from '../server/services/cash/opportunities.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { fulfillerParty, operatingFit } from '../server/domain/operatingModel.ts';
import { capitalQuestionOpen, qualifyTest } from '../server/services/goals/plan.ts';

describe('fulfillerIsOwner: the party named, not its description', () => {
  it('reads a supplier described as owning the equipment as the supplier', () => {
    expect(fulfillerIsOwner('Northwind Staging Co. (owner of the lighting rigs; invoices after the event)')).toBe(false);
    expect(fulfillerIsOwner('Harbor Marquee Hire (marquee owner; bills net-30 after each event)')).toBe(false);
    expect(fulfillerIsOwner('Owner of the scaffolding, Atlas Access, invoices monthly')).toBe(false);
    expect(fulfillerParty('Harbor Marquee Hire (marquee owner; bills net-30)')).toBe('Harbor Marquee Hire');
  });
  it('still reads the owner doing the work as the owner', () => {
    expect(fulfillerIsOwner('The owner, personally')).toBe(true);
    expect(fulfillerIsOwner('Me (I hold the certificate)')).toBe(true);
    expect(fulfillerIsOwner('The founder')).toBe(true);
  });
  it('does not read an equipment owner performing an on-site service as the owner doing physical work', () => {
    const fit = operatingFit({ title: 'On-site stage lighting rental for touring shows', fulfillmentOwner: 'Northwind Staging (owner of the rigs)' });
    expect(fit.kind).not.toBe('OWNER_PHYSICAL');
    expect(operatingFit({ title: 'On-site marquee setup for county shows', fulfillmentOwner: 'Harbor Marquee Hire company (marquee owner; bills net-30)' }).kind).toBe('BROKERED_PHYSICAL');
    expect(operatingFit({ title: 'On-site stage lighting rental for touring shows', fulfillmentOwner: 'The owner, personally' }).kind).toBe('OWNER_PHYSICAL');
  });
});

describe('qualifyTest: an opening left out for the owner\'s physical work lacks a fulfiller', () => {
  it('names FULFILMENT for a qualified opening the owner would have to perform', () => {
    const t = qualifyTest(1, [{ title: 'On-site forklift refresher courses', rule: 'OWNER_PHYSICAL' }]);
    expect(t.link).toBe('FULFILMENT');
    expect(t.test).toContain('independent provider');
  });
  it('keeps the earlier tests otherwise', () => {
    expect(qualifyTest(1, [{ title: 'x' }]).link).toBe('OFFER_AND_PRICE');
    expect(qualifyTest(0, [{ title: 'x', rule: 'OWNER_PHYSICAL' }]).link).toBe('REACHABLE_BUYER');
  });
});

describe('capitalQuestionOpen: a removed ceiling is the owner\'s answer', () => {
  const scope = (stated: number | null, removed: boolean) => ({ recurring: null, industry: null, hoursPerWeek: null, capitalAssumed: null, capitalStatedCents: stated, capitalRemoved: removed });
  it('is closed for any exposure once the owner removed the ceiling', () => {
    expect(capitalQuestionOpen({ capitalCeilingCents: null, scope: scope(null, true) }, 40_000)).toBe(false);
  });
  it('is still open above the stated figure when nothing was removed', () => {
    expect(capitalQuestionOpen({ capitalCeilingCents: null, scope: scope(70_000, false) }, 4_000)).toBe(true);
  });
});

describe('adaptation on the database', () => {
  let projectId = '';
  let userId = '';
  beforeEach(async () => {
    forgetKnowledge();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `r11-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Collect usable cash.' })).ok).toBe(true);
  });

  async function goal(intent: string, capitalCeilingCents: number | null) {
    const g = await createWorkstream({ projectId, title: 'Collect cash', intent, purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 700_000, currency: 'USD', projectId, capitalCeilingCents, now: new Date(Date.now() - 60_000) })).ok).toBe(true);
    return (await getWorkstream(g.id))!;
  }

  it('reads a capital ceiling the owner removed as removed', async () => {
    const w = await goal('Collect $7,000 of settled cash within 30 days with at most $700 of capital.', 70_000);
    const before = w.target;
    expect((await setTargetLimits({ goal: w, capitalCeilingCents: null })).ok).toBe(true);
    await recordWorkstreamEvent({ workstreamId: w.id, kind: 'GOAL_TARGET_LIMITS_SET', summary: 'Limits: the capital limit is removed.', detail: { before }, actorRef: `person:${userId}` });
    const removed = (await readTarget((await getWorkstream(w.id))!))!;
    expect(removed.scope?.capitalRemoved).toBe(true);
    expect(removed.scope?.capitalStatedCents).toBeNull();
    expect(capitalQuestionOpen(removed, 4_000)).toBe(false);
  });

  it('reads a ceiling nobody removed from the words', async () => {
    const never = await goal('Collect $7,000 of settled cash within 30 days with at most $700 of capital.', null);
    const read = (await readTarget(never))!;
    expect(read.scope?.capitalRemoved).toBeUndefined();
    expect(read.scope?.capitalStatedCents).toBe(70_000);
  });

  it('excludes an opening archived while the goal runs, with the reason it stopped', async () => {
    const w = await goal('Collect $7,000 of settled cash within 30 days.', null);
    const cashModeId = (await getCashMode(projectId))!.id;
    const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: 'Quarterly compliance binders for marinas', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: 'clm_r11_marina', opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [] });
    expect((await archiveOpportunity({ opportunityId: o.id, actorRef: `person:${userId}`, reason: 'The marina group chose another vendor.' })).ok).toBe(true);
    const model = await composeGoalModel({ goal: w, target: (await readTarget(w))! });
    const stopped = model.excluded.find((one) => one.opportunityId === o.id);
    expect(stopped?.reason).toContain('The marina group chose another vendor.');
  });
});
