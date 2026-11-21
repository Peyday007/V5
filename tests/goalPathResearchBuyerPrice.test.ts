/**
 * CAPABILITY:GOAL_PLAN.EVIDENCE.BUYER_PRICE: an opening with no payer, an
 * undated signal and an unsourced price used to raise no question, because
 * those chain links had no field to ask about. Each now raises one narrow
 * question through the ordinary path, inside the existing caps.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listNeeds, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { researchGoalPaths, staleDemand, MAX_OPEN_PATH_QUESTIONS, PATH_RESEARCH_OPENINGS } from '../server/services/goals/pathResearch.ts';
import { RECOMMENDATION_POLICY, type PlanReading } from '../server/services/goals/plan.ts';

describe('buyer, demand and price questions', () => {
  it('raises one question per missing fact, within the caps', async () => {
    const { project } = await freshProject();
    const projectId = project.id;
    const owner = await createUser({ email: `bp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect cash.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(projectId))!.id;
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: owner.id, title: 'Unpriced opening', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
      sourceClaimId: 'clm_bp1', opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
    });
    const reading = {
      target: { remainingCents: 100_000 },
      considered: [{
        opportunityId: o.id, title: o.title, missing: ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE'],
        supportedReach: 1000, potentialReach: 1000, competitiveAward: false, volumeEstablished: true, paysOnce: false,
      }],
    } as unknown as PlanReading;

    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading, projectId, now: new Date(), trace });
    const text = trace.join('\n');
    expect(text).toMatch(/payer: asked/);
    expect(text).toMatch(/access: asked/);
    expect(text).toMatch(/buyingEvidence: asked/);
    expect(text).toMatch(/revenueRange: asked/);
    expect(raised).toHaveLength(4);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => raised.includes(n.id));
    expect(needs.some((n) => /observed/.test(n.nextStep ?? ''))).toBe(true);
    expect(raised.length).toBeLessThanOrEqual(MAX_OPEN_PATH_QUESTIONS);
    expect(PATH_RESEARCH_OPENINGS).toBe(4);

    // Asked once: a second pass raises nothing new while the questions live.
    expect(await researchGoalPaths({ reading, projectId, now: new Date() })).toHaveLength(0);
  });
});

async function opening(title: string, claim: string) {
  const { project } = await freshProject();
  const projectId = project.id;
  const owner = await createUser({ email: `bp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
  expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect cash.' })).ok).toBe(true);
  const cashModeId = (await getCashMode(projectId))!.id;
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: owner.id, title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: claim, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
  });
  const readingFor = (missing: string[]) =>
    ({
      target: { remainingCents: 100_000 },
      considered: [{ opportunityId: o.id, title: o.title, missing, supportedReach: 1000, potentialReach: 1000, competitiveAward: false, volumeEstablished: true, paysOnce: false }],
    }) as unknown as PlanReading;
  return { projectId, o, readingFor };
}

describe('a partly established link asks only for the half still missing', () => {
  it('asks for the channel alone when the payer is already on the card', async () => {
    const { projectId, o, readingFor } = await opening('Payer known opening', 'clm_bp2');
    await recordCardFact({ projectId, opportunityId: o.id, field: 'payer', kind: 'EVIDENCE', value: 'Property managers', claimId: 'clm_payer_bp2', decidedBy: 'BRAIN' });
    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading: readingFor(['REACHABLE_BUYER']), projectId, now: new Date(), trace });
    const text = trace.join('\n');
    expect(text).toMatch(/payer: already established/);
    expect(text).toMatch(/access: asked/);
    expect(raised).toHaveLength(1);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => raised.includes(n.id));
    expect(needs[0]?.nextStep ?? '').toMatch(/published channel/);
    expect(needs[0]?.nextStep ?? '').not.toMatch(/Name who pays/);
  });

  it('asks for the payer alone when the channel is already on the card', async () => {
    const { projectId, o, readingFor } = await opening('Channel known opening', 'clm_bp3');
    await recordCardFact({ projectId, opportunityId: o.id, field: 'access', kind: 'EVIDENCE', value: 'The county association member list', claimId: 'clm_access_bp3', decidedBy: 'BRAIN' });
    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading: readingFor(['REACHABLE_BUYER']), projectId, now: new Date(), trace });
    const text = trace.join('\n');
    expect(text).toMatch(/access: already established/);
    expect(text).toMatch(/payer: asked/);
    expect(raised).toHaveLength(1);
  });

  it('asks only about the link the plan lists as missing', async () => {
    const { projectId, readingFor } = await opening('Only demand missing', 'clm_bp4');
    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading: readingFor(['CURRENT_DEMAND']), projectId, now: new Date(), trace });
    const text = trace.join('\n');
    expect(text).toMatch(/buyingEvidence: asked/);
    expect(text).not.toMatch(/payer: asked|access: asked|revenueRange: asked/);
    expect(raised).toHaveLength(1);
  });
});

describe('an answer changes what is asked next', () => {
  it('stops asking a question once its answer is on the card, and keeps asking the others', async () => {
    const { projectId, o, readingFor } = await opening('Answered opening', 'clm_bp5');
    const missing = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE'];
    const before: string[] = [];
    const first = await researchGoalPaths({ reading: readingFor(missing), projectId, now: new Date(), trace: before, dryRun: true });
    expect(first).toHaveLength(0);
    expect(before.join('\n')).toMatch(/revenueRange: would ask/);

    // A sourced, dated price arrives: the plan no longer waits on it.
    await recordCardFact({ projectId, opportunityId: o.id, field: 'revenueRange', kind: 'EVIDENCE', value: '$800-$1,200 per report (2026-10-02, published rate card)', claimId: 'clm_price_bp5', decidedBy: 'BRAIN' });
    const after: string[] = [];
    await researchGoalPaths({ reading: readingFor(missing), projectId, now: new Date(), trace: after, dryRun: true });
    const text = after.join('\n');
    expect(text).toMatch(/revenueRange: already established/);
    expect(text).not.toMatch(/revenueRange: would ask/);
    expect(text).toMatch(/payer: would ask/);
    expect(text).toMatch(/buyingEvidence: would ask/);
  });
});

describe('a demand signal that has aged out is asked for again', () => {
  const DAY = 86_400_000;

  it('re-asks current demand when the recorded signal is older than the plan allows', async () => {
    const { projectId, o, readingFor } = await opening('Stale buyingEvidence', 'clm_bp6');
    const now = new Date();
    await updateOpportunity(o.id, { buying_signal: 'A tender', signal_observed_at: new Date(now.getTime() - 90 * DAY).toISOString() });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'buyingEvidence', kind: 'EVIDENCE', value: 'A tender', claimId: 'clm_demand_bp6', decidedBy: 'BRAIN' });
    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading: readingFor(['CURRENT_DEMAND']), projectId, now, trace });
    const text = trace.join('\n');
    expect(text).not.toMatch(/buyingEvidence: already established/);
    expect(text).toMatch(/buyingEvidence: on record but observed 90 days ago/);
    expect(text).toMatch(/buyingEvidence: asked/);
    expect(raised).toHaveLength(1);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => raised.includes(n.id));
    expect(needs[0]?.nextStep ?? '').toMatch(new RegExp(`within the last ${RECOMMENDATION_POLICY.demandFreshDays} days`));
  });

  it('re-asks when the recorded signal carries no date at all', async () => {
    const { projectId, o, readingFor } = await opening('Undated buyingEvidence', 'clm_bp7');
    await updateOpportunity(o.id, { buying_signal: 'A request', signal_observed_at: null });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'buyingEvidence', kind: 'EVIDENCE', value: 'A request', claimId: 'clm_demand_bp7', decidedBy: 'BRAIN' });
    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading: readingFor(['CURRENT_DEMAND']), projectId, now: new Date(), trace });
    expect(trace.join('\n')).toMatch(/buyingEvidence: on record but undated/);
    expect(raised).toHaveLength(1);
  });

  it('still treats a signal inside the window as established', async () => {
    const { projectId, o, readingFor } = await opening('Fresh buyingEvidence', 'clm_bp8');
    const now = new Date();
    await updateOpportunity(o.id, { buying_signal: 'A listing', signal_observed_at: new Date(now.getTime() - 5 * DAY).toISOString() });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'buyingEvidence', kind: 'EVIDENCE', value: 'A listing', claimId: 'clm_demand_bp8', decidedBy: 'BRAIN' });
    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading: readingFor(['CURRENT_DEMAND']), projectId, now, trace });
    expect(trace.join('\n')).toMatch(/buyingEvidence: already established/);
    expect(raised).toHaveLength(0);
  });

  it('judges staleness against the same window the plan uses', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const days = (n: number) => new Date(now.getTime() - n * DAY).toISOString();
    expect(staleDemand('buyingEvidence', days(RECOMMENDATION_POLICY.demandFreshDays), now)).toBeNull();
    expect(staleDemand('buyingEvidence', days(RECOMMENDATION_POLICY.demandFreshDays + 1), now)).toMatch(/older than/);
    expect(staleDemand('buyingEvidence', null, now)).toBe('undated');
    expect(staleDemand('payer', null, now)).toBeNull();
  });
});
