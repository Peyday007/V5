/**
 * A route is assembled from the answer that found it (trace break points 1–3,
 * 2026-11-25; server/services/cash/routeEvidence.ts).
 *
 * The real path: `openGoalDiscovery` opens a goal's round, a mission's fragment
 * is answered the way a worker files a whole way under the goal profile's lanes
 * — the signalled claim, the price, how buyers are reached, who does the work,
 * the cost, the market's size and the payment terms — and `harvest` files it.
 * Before: the opening held its buying signal and nothing else, and every other
 * part was asked again by its own mission. After: the parts the same answer
 * established are on the opening's card, and a claim about another population
 * in the same answer is not.
 */
import type { OpportunitySignal } from '../server/domain/types.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { SIGNAL_LANE, harvest, openGoalDiscovery } from '../server/services/cash/discovery.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { cardFactMap } from '../server/repos/cashCardFacts.ts';
import { populationKey, sameRoute } from '../server/services/cash/routeEvidence.ts';
import { ROUTE_LANES } from '../server/services/russell/compilerProfiles.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `route-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goalRound() {
  const { createWorkstream, getWorkstream } = await import('../server/repos/register.ts');
  const { setTerms } = await import('../server/services/goals/decide.ts');
  const { setTarget } = await import('../server/services/goals/target.ts');
  const { forgetGoalReadings, readGoalPlan } = await import('../server/services/goals/plan.ts');
  const day = 86_400_000;
  forgetGoalReadings();
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  const g = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 30 * day).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 300_000, currency: 'USD', projectId, capitalCeilingCents: 50_000, hoursCeiling: 40, now: new Date(Date.now() - 60_000) } as Parameters<typeof setTarget>[0])).ok).toBe(true);
  const target = (await readGoalPlan({ goalId: g.id, evaluations: 200 }))!.target;
  const opened = await openGoalDiscovery({ goal: (await getWorkstream(g.id))!, target, bestReach: null });
  expect(opened).not.toBeNull();
  return { goalId: g.id, opened: opened! };
}

interface Filed { claim: string; lane: string; route?: string | null; population?: string | null; signal?: OpportunitySignal | null; sourceUrl: string }

async function answer(candidateId: string | null, claims: Filed[]) {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a goal lens' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a goal lens', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'anywhere',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }, ...ROUTE_LANES],
      acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'], completionCriteria: ['one dated request'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'goal-lens', question: 'Who pays?', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a goal lens', whyNow: 'the goal is live', idempotencyKey: `mission:${orchestration.id}`, candidateId, attempt: 1 } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
  const inserted = await insertClaims(claims.map((one) => ({
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
    claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A source', sourcePublisher: 'A publisher',
    sourceDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10), evidenceExcerpt: one.claim, evidenceLocator: 'the body', evidenceLane: one.lane,
    opportunitySignal: one.signal ?? null, closesOn: null, retrievedAt: new Date().toISOString().slice(0, 10), confidence: 0.8,
    validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
    population: one.population ?? null, route: one.route ?? null, contentHash: `${one.claim}|${one.sourceUrl}`,
  })) as unknown as Parameters<typeof insertClaims>[0]);
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

const DENTAL = 'Independent dental practices in Michigan';
const ROUTE = `${DENTAL} · HIPAA security risk assessment`;

describe('a goal round files the whole route its answer established', () => {
  it('writes the price, channel, fulfiller, cost, market size and settlement onto the opening of the same route', { timeout: 180_000 }, async () => {
    const { opened, goalId } = await goalRound();
    await answer(opened.candidateId, [
      { claim: 'Michigan dental practices posted requests this month for an outsourced HIPAA security risk assessment.', lane: SIGNAL_LANE, signal: 'RECURRING_OUTSOURCED_WORK', route: ROUTE, sourceUrl: 'https://example.test/requests/hipaa' },
      { claim: 'Dental practices pay $450 for a HIPAA security risk assessment report.', lane: 'economics', route: ROUTE, sourceUrl: 'https://example.test/prices/hipaa' },
      { claim: 'The Michigan Dental Association member directory lists practices with their published office email addresses.', lane: 'route_channel', route: ROUTE, sourceUrl: 'https://example.test/directory' },
      { claim: 'The assessment report is a document produced from a published questionnaire template.', lane: 'route_fulfiller', route: ROUTE, sourceUrl: 'https://example.test/template' },
      { claim: 'The per-report cost is $15 of software and printing.', lane: 'route_cost', route: ROUTE, sourceUrl: 'https://example.test/cost' },
      { claim: 'One assessment takes the reviewer 2 hours to complete.', lane: 'route_effort', route: ROUTE, sourceUrl: 'https://example.test/effort' },
      { claim: 'About 2,400 dental practices are licensed in Michigan; each buys one assessment a year.', lane: 'route_volume', route: ROUTE, sourceUrl: 'https://example.test/licensing' },
      { claim: 'Buyers pay at checkout by card.', lane: 'route_settlement', route: ROUTE, sourceUrl: 'https://example.test/terms' },
      // Another way in the same answer: its price must not reach the dental opening.
      { claim: 'Veterinary clinics pay $900 for an inventory audit.', lane: 'economics', route: 'Veterinary clinics in Ohio · inventory audit', sourceUrl: 'https://example.test/vet' },
    ]);
    await harvest({ projectId });
    const openings = (await listOpportunities({ projectId })).filter((one) => !one.duplicateOfId);
    expect(openings).toHaveLength(1);
    const o = openings[0]!;
    const card = await cardFactMap(o.id, projectId);
    expect(card('payer')?.kind).toBe('EVIDENCE');
    expect(o.payer).toBe(DENTAL);
    expect(card('revenueRange')?.value).toContain('$450');
    expect(card('access')?.value).toContain('member directory');
    expect(card('fulfillment')?.value).toContain('questionnaire template');
    expect(card('directCosts')?.value).toContain('$15');
    expect(card('buyerVolume')?.value).toContain('2,400');
    expect(card('timeToFirstCash')?.value).toContain('checkout');
    for (const field of ['revenueRange', 'access', 'fulfillment', 'directCosts', 'buyerVolume', 'timeToFirstCash']) expect(card(field)?.kind).toBe('EVIDENCE');
    // The normal operating tick proposes the offer and the capture thesis from those facts, and the
    // planner reads a startable plan: every link established but the close rate selling measures.
    const { forgetGoalReadings, readGoalPlan } = await import('../server/services/goals/plan.ts');
    const { operate } = await import('../server/services/cash/operate.ts');
    await operate(projectId);
    const after = await cardFactMap(o.id, projectId);
    expect(after('captureMechanism')?.kind).toBe('RECOMMENDATION');
    expect(after('price')?.kind).toBe('EVIDENCE');
    forgetGoalReadings();
    const plan = (await readGoalPlan({ goalId, evaluations: 200 }))!;
    const strategy = plan.strategies.find((one) => one.opportunityIds.includes(o.id));
    expect(strategy, JSON.stringify(plan.excluded)).toBeDefined();
    expect(strategy!.constraintsFailed).toEqual([]);
    expect(strategy!.links.filter((l) => !l.ok).map((l) => l.link)).toEqual(['CONVERSION']);
    const operations = plan.steps.map((one) => one.executor?.operation);
    expect(operations).toContain('SEND_OFFER');
    expect(operations).toContain('COLLECT_PAYMENT');
  });

  it('joins nothing to a fragment holding two openings when a claim names no population', () => {
    const one = { id: 'a', population: DENTAL, sourceUrl: 'https://x/1' };
    expect(sameRoute(one, { id: 'b', population: null, sourceUrl: 'https://x/2' }, 2)).toBe(false);
    expect(sameRoute(one, { id: 'b', population: null, sourceUrl: 'https://x/2' }, 1)).toBe(true);
    expect(sameRoute(one, { id: 'b', population: null, sourceUrl: 'https://x/1' }, 2)).toBe(true);
    // A shared population is the fragment's scope, not a route: with two ways found it joins nothing by itself.
    expect(sameRoute(one, { id: 'b', population: 'independent dental practice in michigan', sourceUrl: null }, 2)).toBe(false);
    // The route a worker names decides over the fragment's shared population.
    const named = { id: 'c', population: 'any business', sourceUrl: 'https://x/9', route: ROUTE };
    expect(sameRoute(named, { id: 'd', population: 'any business', sourceUrl: 'https://x/8', route: ROUTE.toLowerCase() }, 3)).toBe(true);
    expect(sameRoute(named, { id: 'e', population: 'any business', sourceUrl: 'https://x/9', route: 'Ohio vets · audit' }, 3)).toBe(false);
    expect(populationKey('Veterinary clinics in Ohio')).not.toBe(populationKey(DENTAL));
  });
});
