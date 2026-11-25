/**
 * Whole commercial routes for a goal, from its objective alone
 * (docs/PLANNING-9-10-INVESTIGATION-2026-11-24.md §4.1).
 *
 *   - a stubbed operator model's routes are filed as one opening each, every
 *     figure a RECOMMENDATION — no evidence, no buying signal, no observation
 *     date — linked to the goal and marked by origin;
 *   - routes that break the owner's limits (capital, deadline, hours) are
 *     rejected with the reason, and the prompt carries those limits;
 *   - filing is idempotent per goal and route, asked at most once per interval
 *     and bounded per day, and a refuted route is named to the next ask;
 *   - with no model configured nothing is filed and the goal's record says why;
 *   - the deep dive admits a route opening by its origin, asks the whole route
 *     as one question, and its answers reach the card fields the planner reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { getOpportunity, opportunitiesWithRecordPrefix, transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import { cardFact, cardFactsFor, recordCardFact } from '../server/repos/cashCardFacts.ts';
import { listLinks, workstreamEventsOfKind } from '../server/repos/register.ts';
import { getCandidate, createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims, updateFragment } from '../server/repos/research.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { applyValidationAnswers, routeValidationQuestion, startValidations, whyNotDiving } from '../server/services/cash/validation.ts';
import { DISQUALIFIED_FIELD } from '../server/services/cash/engineCard.ts';
import { goalRoutePrefix, isRouteOpening, ROUTE_SEARCHES_FIELD } from '../server/domain/routeOrigin.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { parseRoutes, proposeGoalRoutes, ROUTE_EVENT, ROUTE_PROPOSAL_EVERY_MS, ROUTES_PER_DAY, type RouteContext, type RouteDeps } from '../server/services/goals/routeProposal.ts';
import { registerResearchSurfaces } from './helpers/researchSurfaces.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';
import type { EvidenceLane, Layer } from '../server/domain/types.ts';

let projectId = '';
let goalId = '';
let layer: Layer;
const now = new Date();

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  // Off the in-code slug map, so a dive compiles under the validation envelope.
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`routes-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `routes-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({ projectId, objective: 'Collect 3000 dollars of settled cash within 30 days using at most $500', actorRef: 'test', userId: owner.id, now: new Date(now.getTime() - 60_000) });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
});

/** Four routes: two inside the limits, one over the capital limit, one settling after the deadline. */
const ANSWER = {
  routes: [
    {
      title: 'Monthly bookkeeping spreadsheets for dental practices', mechanism: 'PRODUCTIZED_SERVICE', industry: 'Dental', payer: 'Independent dental practices',
      offer: 'A monthly cash-flow spreadsheet', price: 400, monthly: true, channel: 'Published practice email addresses', performer: 'BRAIN', fulfiller: 'Brain', brainDeliverable: 'spreadsheet',
      directCost: 20, capital: 0, ownerHoursPerDeal: 0, daysToFirstCash: 7, buyerCount: 120000, volumeBasis: 'ADA practice counts', assumptions: 'Practices pay monthly for this.', ownerFit: 'Brain produces it; no owner work.',
      searches: { price: ['dental bookkeeping monthly price'], demand: ['dental practice hiring bookkeeper 2026'], volume: ['number of dental practices US'] },
    },
    {
      title: 'Subcontracted podcast editing for agencies', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'Media', payer: 'Marketing agencies with podcasts',
      offer: 'Edited podcast episodes', price: 250, monthly: false, channel: 'Agency directory contact forms', performer: 'SUBCONTRACTOR', fulfiller: 'A freelance audio editor',
      directCost: 90, capital: 100, ownerHoursPerDeal: 0.5, daysToFirstCash: 10, buyerCount: 5000, volumeBasis: 'directory listing', assumptions: 'Agencies outsource editing.', ownerFit: 'Subcontracted; the owner only approves.',
      searches: { price: ['podcast editing rates'], demand: ['agency podcast editor wanted'], volume: ['marketing agencies with podcasts count'] },
    },
    {
      title: 'Bulk resale of refurbished laptops', mechanism: 'RESALE_OR_ASSET', industry: 'Electronics', payer: 'Small offices', offer: 'Refurbished laptops', price: 600, monthly: false,
      channel: 'Marketplace listings', performer: 'SUBCONTRACTOR', fulfiller: 'A refurbisher', ownerFit: 'Shipped by the refurbisher.', directCost: 300, capital: 5000, ownerHoursPerDeal: 0, daysToFirstCash: 14, buyerCount: 1000,
    },
    {
      title: 'Annual compliance audits', mechanism: 'PRODUCTIZED_SERVICE', industry: 'Finance', payer: 'Credit unions', offer: 'Compliance audit', price: 9000, monthly: false,
      channel: 'Conference', performer: 'SUBCONTRACTOR', fulfiller: 'A licensed auditor', ownerFit: 'Remote audit.', directCost: 4000, capital: 0, ownerHoursPerDeal: 0, daysToFirstCash: 90, buyerCount: 4000,
    },
  ],
};

function stub(answer: unknown = ANSWER): { deps: RouteDeps; prompts: string[] } {
  const prompts: string[] = [];
  const chat: ChatFn = async (messages) => {
    // The proposals only: the critique's ask is a second turn, and this answer is no critique, so the proposal stands.
    if (/strategist/.test(String((messages[0] as { content: string }).content))) prompts.push(String((messages[1] as { content: string }).content));
    return { content: JSON.stringify(answer), toolCalls: [], ms: 1, completionTokens: 1, error: null };
  };
  return { prompts, deps: { chats: async () => [{ label: 'stub', chat }], delivers: async () => ['spreadsheet'] } };
}

const routes = () => opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(goalId));

describe('a goal is given whole routes from its objective', () => {
  it('files each route inside the limits as one opening carrying RECOMMENDATION facts only', async () => {
    const { deps, prompts } = stub();
    const outcome = await proposeGoalRoutes({ goalId, now }, deps);
    expect(outcome.kind).toBe('PROPOSED');
    if (outcome.kind !== 'PROPOSED') return;
    expect(outcome.filed).toHaveLength(2);
    expect(outcome.rejected.map((one) => one.why).join(' | ')).toMatch(/more than the \$500 allowed/);
    expect(outcome.rejected.map((one) => one.why).join(' | ')).toMatch(/beyond the \d+ left/);

    // The prompt carries the owner's own words verbatim, the limits and Brain's proved deliverables, and no industry template.
    expect(prompts[0]).toContain('Collect 3000 dollars of settled cash within 30 days using at most $500');
    expect(prompts[0]).toMatch(/must settle inside \d+ day/);
    expect(prompts[0]).toMatch(/no two routes may share a buyer type/i);
    expect(prompts[0]).toMatch(/ownerFit/);
    expect(prompts[0]).toMatch(/at most \$500 may be tied up/);
    expect(prompts[0]).toMatch(/within \d+ day/);
    expect(prompts[0]).toMatch(/PROVABLY PRODUCES[^\n]*spreadsheet/);

    const filed = await routes();
    expect(filed).toHaveLength(2);
    for (const o of filed) {
      expect(isRouteOpening(o)).toBe(true);
      expect(o.buyingSignal).toBeNull();
      expect(o.signalObservedAt).toBeNull();
      expect(o.sourceClaimId).toBeNull();
      const facts = await cardFactsFor(o.id);
      expect(facts.length).toBeGreaterThan(5);
      expect(facts.every((f) => f.kind === 'RECOMMENDATION' && f.claimId === null)).toBe(true);
      expect(facts.map((f) => f.field)).toEqual(expect.arrayContaining(['captureMechanism', 'payer', 'price', 'revenueRange', 'directCosts', 'timeToFirstCash', 'buyerVolume', 'fulfillment', ROUTE_SEARCHES_FIELD]));
    }
    const dental = filed.find((o) => /dental/i.test(o.title))!;
    expect(dental.priceCents).toBe(40_000);
    expect(dental.payer).toBe('Independent dental practices');
    expect(dental.requiredCapabilities).toEqual(['PRODUCE_SPREADSHEET']);
    expect((await cardFact(dental.id, 'price'))!.value).toMatch(/a month/);

    const links = (await listLinks(goalId)).filter((l) => l.kind === 'OPPORTUNITY');
    expect(links.map((l) => l.ref).sort()).toEqual(filed.map((o) => o.id).sort());
    const events = await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail['outcome']).toBe('PROPOSED');
  });

  it('is asked at most once per interval, never files a route twice, and stays inside the daily bound', async () => {
    const first = stub();
    await proposeGoalRoutes({ goalId, now }, first.deps);
    const again = await proposeGoalRoutes({ goalId, now: new Date(now.getTime() + 60_000) }, first.deps);
    expect(again.kind).toBe('NOT_DUE');
    expect(first.prompts).toHaveLength(1);

    // Past the interval the same answer files nothing new: the routes are already held.
    const later = await proposeGoalRoutes({ goalId, now: new Date(now.getTime() + ROUTE_PROPOSAL_EVERY_MS + 60_000) }, first.deps);
    expect(later.kind).toBe('PROPOSED');
    if (later.kind === 'PROPOSED') {
      expect(later.filed).toHaveLength(0);
      expect(later.existing).toHaveLength(2);
    }
    expect(await routes()).toHaveLength(2);
    expect(first.prompts[1]).toMatch(/ALREADY HELD[^\n]*dental/i);

    // Many new routes in a day: never more than the bound.
    const many = { routes: Array.from({ length: 12 }, (_, i) => ({ ...ANSWER.routes[1]!, title: `Route ${i}`, payer: `Buyer segment ${'abcdefghijkl'[i]}`, offer: `Offer ${i}` })) };
    await proposeGoalRoutes({ goalId, now: new Date(now.getTime() + 2 * ROUTE_PROPOSAL_EVERY_MS + 60_000) }, stub(many).deps);
    expect((await routes()).length).toBeLessThanOrEqual(ROUTES_PER_DAY);
  });

  it('names refuted and stopped routes to the next ask, so it proposes differently', async () => {
    await proposeGoalRoutes({ goalId, now }, stub().deps);
    const [a, b] = await routes();
    await recordCardFact({ projectId, opportunityId: a!.id, field: DISQUALIFIED_FIELD, kind: 'EVIDENCE', value: 'Practices do not buy this from outside suppliers.', claimId: 'clm_refute', decidedBy: 'BRAIN' });
    expect(await transitionOpportunity({ id: b!.id, from: ['DISCOVERED'], to: 'ARCHIVED', archivedReason: 'no editor would take it at that cost' })).toBe(true);
    const next = stub({ routes: [] });
    await proposeGoalRoutes({ goalId, now: new Date(now.getTime() + ROUTE_PROPOSAL_EVERY_MS + 60_000) }, next.deps);
    expect(next.prompts[0]).toMatch(/REFUTED OR STOPPED[\s\S]*do not buy this from outside suppliers/);
    expect(next.prompts[0]).toMatch(/stopped: no editor would take it at that cost/);
  });

  it('with no model configured files nothing and records why', async () => {
    const outcome = await proposeGoalRoutes({ goalId, now }, { chats: async () => [] });
    expect(outcome.kind).toBe('NO_MODEL');
    expect(await routes()).toHaveLength(0);
    const events = await workstreamEventsOfKind(goalId, ROUTE_EVENT, new Date(0).toISOString(), 5);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail['outcome']).toBe('NO_MODEL');
    expect(events[0]!.summary).toMatch(/no operator model is configured/);
  });

  it('drops a route with no owner fit, and a second route to the same buyer type', () => {
    const ctx: RouteContext = { objective: 'I speak Spanish and live in Seattle', currency: 'USD', remaining: 3000, daysLeft: 30, capitalLimit: null, hoursLimit: null, resources: null, industry: null, recurring: false, exclusions: [], delivers: [], held: [], refuted: [] };
    const base = ANSWER.routes[1]!;
    const { routes: kept, rejected } = parseRoutes({ routes: [{ ...base, ownerFit: undefined }, base, { ...base, offer: 'Show notes', title: 'Show notes' }] }, ctx);
    expect(kept).toHaveLength(1);
    expect(rejected.map((one) => one.why).join(' | ')).toMatch(/does not say how it uses or respects/);
    expect(rejected.map((one) => one.why).join(' | ')).toMatch(/same buyer type/);
  });

  it('rejects a route needing more owner hours than the limit allows', () => {
    const ctx: RouteContext = { objective: 'x', currency: 'USD', remaining: 3000, daysLeft: 30, capitalLimit: null, hoursLimit: 5, resources: null, industry: null, recurring: false, exclusions: [], delivers: [], held: [], refuted: [] };
    const owner = { ...ANSWER.routes[1]!, performer: 'OWNER', ownerHoursPerDeal: 3, fulfiller: 'The owner edits online' };
    const { routes: kept, rejected } = parseRoutes({ routes: [owner] }, ctx);
    expect(kept).toHaveLength(0);
    expect(rejected[0]!.why).toMatch(/owner hour/);
  });
});

describe('a proposed route is researched as one unit', () => {
  it('the dive admits it by its origin and asks the whole route', async () => {
    await proposeGoalRoutes({ goalId, now }, stub().deps);
    const editing = (await routes()).find((o) => /podcast/i.test(o.title))!;
    expect((await whyNotDiving(editing)).kind).toBe('ELIGIBLE');

    await registerResearchSurfaces(projectId, 4);
    // Filing may already have started it inside the room's floor; the next pass starts the rest.
    await startValidations({ projectId });
    const after = (await getOpportunity(editing.id))!;
    const startedRow = await getDb().get<{ detail: string }>("SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_VALIDATION_STARTED'", [editing.id]);
    const mine = after.candidateId && startedRow ? { candidateId: after.candidateId, stage: (JSON.parse(startedRow.detail) as { stage: string }).stage } : undefined;
    expect(mine, 'the route dive started').toBeDefined();
    expect(mine!.stage).toBe('FULL');
    const statement = (await getCandidate(mine!.candidateId))!.statement;
    for (const lane of ['ruled_out', 'payer', 'contact_mode', 'price_evidence', 'buyer_volume', 'current_demand', 'fulfiller', 'cost_evidence', 'timing']) {
      expect(statement).toContain(`${lane}`);
    }
    expect(statement).toMatch(/Edited podcast episodes/);
    expect(statement).toMatch(/hypothesis/);
    expect(statement).toMatch(/podcast editing rates/);
  });

  it('a route question is composed from the row and card alone', async () => {
    await proposeGoalRoutes({ goalId, now }, stub().deps);
    const dental = (await routes()).find((o) => /dental/i.test(o.title))!;
    const facts = await cardFactsFor(dental.id);
    const q = routeValidationQuestion(dental, (field) => facts.find((f) => f.field === field) ?? null, ['buyerVolume']);
    expect(q).toMatch(/Independent dental practices/);
    expect(q).toMatch(/\$400 a month/);
    expect(q).toMatch(/ask first what it left open: buyer_volume/);
  });

  it('the dive answers reach the price, volume, dated demand and fulfiller the planner reads', async () => {
    await proposeGoalRoutes({ goalId, now }, stub().deps);
    const dental = (await routes()).find((o) => /dental/i.test(o.title))!;
    const lanes: EvidenceLane[] = profileFor('RUSSELL_CASH_VALIDATION_V1')!.lanes;
    expect(lanes.map((l) => l.id)).toEqual(expect.arrayContaining(['buyer_volume', 'current_demand', 'fulfiller']));
    const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: 'Qualify: dental', statement: 'dental' });
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'dental' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Qualify: dental', assignment: 'dental', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([{
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'opening-validation', question: 'route', geography: 'United States', timeframe: 'as at 2026',
      population: null, definitions: null, requiredEvidence: lanes, acceptableSourceTypes: ['a price list'], excludedSourceTypes: ['blog'], completionCriteria: ['A named payer.'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    }]);
    await updateFragment(fragment!.id, { status: 'BLOCKED' });
    const demandDate = new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10);
    const claims = [
      { lane: 'payer', text: 'Smile Dental pays Ledgerly for monthly bookkeeping.', date: '2026-10-01' },
      { lane: 'price_evidence', text: 'Dental bookkeeping is priced at $350 a month to $600 a month.', date: '2026-10-01' },
      { lane: 'buyer_volume', text: 'There are 135,000 independent dental practices in the United States.', date: '2026-01-01' },
      { lane: 'current_demand', text: 'A dental practice posted a request for a bookkeeper to manage monthly cash flow.', date: demandDate },
      { lane: 'fulfiller', text: 'Brain produces the spreadsheet itself from the practice ledger export.', date: '2026-10-01' },
    ];
    await insertClaims(claims.map((c) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const, claim: c.text, claimType: 'SOURCED_FACT' as const,
      sourceUrl: 'https://example.com/source', sourceTitle: 'Source', sourcePublisher: 'Publisher', sourceDate: c.date, evidenceExcerpt: c.text, evidenceLocator: 'p1',
      evidenceLane: c.lane, retrievedAt: now.toISOString(), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true, accepted: true, rejectionReason: null,
      contentHash: `route:${c.lane}`,
    })));
    const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'dental', whyNow: 'test', idempotencyKey: 'dive:dental', candidateId: candidate.id });
    await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'FAILED', terminalReason: 'x' });
    await recordCashEvent({ projectId, opportunityId: dental.id, kind: 'CASH_VALIDATION_STARTED', actorRef: 'BRAIN', summary: 'started', detail: { candidateId: candidate.id, round: 1 } });
    await getDb().run('UPDATE cash_opportunities SET candidate_id = ?, validation_state = ?, validation_rounds = 1 WHERE id = ?', [candidate.id, 'BLOCKED', dental.id]);

    await applyValidationAnswers(projectId);
    const after = (await getOpportunity(dental.id))!;
    const price = (await cardFact(dental.id, 'price'))!;
    expect(price.kind).toBe('EVIDENCE');
    // The lowest published figure, per month as the route is priced.
    expect(after.priceCents).toBe(35_000);
    expect((await cardFact(dental.id, 'revenueRange'))!.kind).toBe('EVIDENCE');
    expect((await cardFact(dental.id, 'buyerVolume'))!).toMatchObject({ kind: 'EVIDENCE' });
    expect((await cardFact(dental.id, 'fulfillment'))!.kind).toBe('EVIDENCE');
    // The dated sign of demand becomes the signal, observed when its source says.
    expect(after.buyingSignal).toMatch(/posted a request/);
    expect(after.signalObservedAt!.slice(0, 10)).toBe(demandDate);

    // The goal's plan reads the route as one of its openings, its price now evidenced and its demand current.
    const reading = (await readGoalPlan({ goalId, now: new Date(), evaluations: 50 }))!;
    const considered = reading.considered.find((one) => one.opportunityId === dental.id);
    expect(considered, JSON.stringify(reading.excluded.filter((one) => one.opportunityId === dental.id))).toBeDefined();
    expect(considered!.missing).not.toContain('OFFER_AND_PRICE');
    expect(considered!.missing).not.toContain('CURRENT_DEMAND');
  }, 60_000);
});
