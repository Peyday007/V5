/**
 * How research claims become a goal's openings (2026-11-14 investigation).
 *
 * O-1  An opening is named from its structured parts, never the claim sentence,
 *      and a seller's own price page or a supplier listing is not lane-promoted.
 * O-2  An observation of a moment expires: a stale undeadlined request is not
 *      harvested, a fresh one expires demandFreshDays after its source's date,
 *      an undated one is never dated by its retrieval, and the goal model
 *      leaves out a one-off opening whose signal is older than the window.
 * O-3  One buyer population enters the goal model once, however many designs
 *      reach it, and two needs of one buyer no longer share a label.
 * O-5  A blocked packet's detail names the block's cause, not the first reason
 *      the gate happened to write.
 * O-7  An opening whose capital nobody published reaches C_MARKET_TEST_READY
 *      when the worst case swept for it fits the owner's before-proof limit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  signalledClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { SIGNAL_LANE, harvest, openGoalDiscovery } from '../server/services/cash/discovery.ts';
import { createOpportunity, listOpportunities, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { createNode } from '../server/repos/industry.ts';
import { constructArrangements } from '../server/services/cash/construct.ts';
import { pickEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { noFragmentClearedDetail } from '../server/services/research/packetRunner.ts';
import { RECOMMENDATION_POLICY, readGoalPlan, validationStage } from '../server/services/goals/plan.ts';
import { observationExpiry, openingTitle, sellersOwnPage } from '../server/domain/opportunitySignals.ts';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (
    await createUser({
      email: `openings-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
});

async function goal(capitalCents: number | null = 300_000) {
  const { createWorkstream, getWorkstream } = await import('../server/repos/register.ts');
  const { setTerms } = await import('../server/services/goals/decide.ts');
  const { setTarget } = await import('../server/services/goals/target.ts');
  const { forgetGoalReadings } = await import('../server/services/goals/plan.ts');
  forgetGoalReadings();
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 25 * DAY).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: capitalCents, hoursCeiling: 200, now: new Date(Date.now() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return { id: g.id, workstream: (await getWorkstream(g.id))! };
}

interface Claim {
  claim: string;
  sourceUrl: string;
  signal?: OpportunitySignal | null;
  lane?: string;
  sourceTitle?: string;
  sourcePublisher?: string | null;
  sourceDate?: string | null;
  population?: string | null;
}

/** A goal lens round, answered by a real mission and packet whose one fragment declares a published-request lane. */
async function goalRoundWith(claims: Claim[]) {
  const { id, workstream } = await goal();
  const target = (await readGoalPlan({ goalId: id, evaluations: 200 }))!.target;
  const round = (await openGoalDiscovery({ goal: workstream, target, bestReach: null }))!;
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a goal lens' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a goal lens', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'anywhere',
      requiredEvidence: [
        { id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' },
        { id: 'demand_pattern', description: 'buyers repeatedly paying', necessity: 'CONDITIONAL' },
      ],
      acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'],
      completionCriteria: ['one dated request'], minIndependentSources: 1, maxRepairs: 2,
      fragmentIndex: 0, fragmentKey: 'goal-lens', question: 'Who pays?', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const { mission } = await launchMission({
    projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a goal lens', whyNow: 'the goal is live',
    idempotencyKey: `mission:${orchestration.id}`, candidateId: round.candidateId, attempt: 1,
  } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
  const inserted = await insertClaims(claims.map((one) => ({
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
    claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: one.sourceTitle ?? 'A listing',
    sourcePublisher: one.sourcePublisher === undefined ? 'A marketplace' : one.sourcePublisher,
    sourceDate: one.sourceDate === undefined ? daysAgo(3) : one.sourceDate,
    population: one.population ?? null,
    evidenceExcerpt: one.claim, evidenceLocator: 'the body', evidenceLane: one.lane ?? SIGNAL_LANE,
    opportunitySignal: one.signal ?? null, closesOn: null, retrievedAt: new Date().toISOString(), confidence: 0.8,
    validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
    contentHash: `${one.claim}|${one.sourceUrl}`,
  })) as unknown as Parameters<typeof insertClaims>[0]);
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
  return { goalId: id };
}

describe('O-1: an opening is named from its parts, and a seller’s page is not a buyer', () => {
  it('recognises a supplier rate card and a supplier listing, and passes a buyer’s request', () => {
    // Verification: the two production titles are refused; a buyer's request is not.
    expect(sellersOwnPage({ claim: 'Rev.com publishes a per-minute price of $1.99 for human transcription.', sourceUrl: 'https://www.rev.com/pricing', sourcePublisher: 'Rev' })).toMatch(/price page/);
    expect(sellersOwnPage({ claim: 'Rev.com publishes a per-minute price of $1.99 for human transcription.', sourceUrl: 'https://www.rev.com/blog/transcription', sourcePublisher: 'Rev' })).toMatch(/stating its own price/);
    expect(sellersOwnPage({ claim: 'The 10 Best Christmas Decorators Near Me (with Prices)', sourceUrl: 'https://www.thumbtack.com/k/christmas-decorators/near-me/', sourceTitle: 'The 10 Best Christmas Decorators Near Me' })).toMatch(/listing of suppliers/);
    expect(sellersOwnPage({ claim: 'Harris County published a request for quotes for a facilities survey, budget $8,000, responses due 2026-12-01.', sourceUrl: 'https://sam.example.test/opp/1', sourcePublisher: 'SAM.gov' })).toBeNull();
    expect(sellersOwnPage({ claim: 'Property managers pay $400 a month for outsourced tenant screening (examples March and May 2026).', sourceUrl: 'https://news.example.test/article', sourcePublisher: 'Property News' })).toBeNull();
  });

  it('names an opening by kind, buyers and publisher', () => {
    expect(openingTitle({ signal: 'ACTIVE_BUYER_DEMAND', population: 'County facilities departments', deliverable: null, publisher: 'SAM.gov', sourceUrl: 'https://sam.gov/x' }))
      .toBe('Buyer request: County facilities departments — SAM.gov');
    expect(openingTitle({ signal: 'RECURRING_OUTSOURCED_WORK', population: null, deliverable: 'spreadsheet', publisher: null, sourceUrl: 'https://www.example.test/a' }))
      .toBe('Recurring outsourced work: spreadsheet buyers — example.test');
  });

  it('files a request under a structured title with the sentence as its buying signal, and refuses the seller’s pages', async () => {
    const request = 'Harris County published a request for quotes for a facilities condition survey, budget $8,000.';
    await goalRoundWith([
      { claim: request, sourceUrl: 'https://sam.example.test/opp/harris', sourcePublisher: 'SAM.gov', population: 'County facilities departments' },
      // A supplier listing filed in the request lane.
      { claim: 'The 10 Best Christmas Decorators Near Me, with prices from $300.', sourceUrl: 'https://www.thumbtack.example/k/christmas-decorators/near-me/', sourceTitle: 'The 10 Best Christmas Decorators Near Me' },
      // A supplier's own rate card filed in the pattern lane: buying words and a currency figure, so the lane rule alone promoted it.
      { claim: 'Rev.com publishes a per-minute price of $1.99 that customers pay for transcription.', sourceUrl: 'https://www.rev.com/pricing', sourcePublisher: 'Rev', lane: 'demand_pattern' },
    ]);
    // Before the fix all three were read; now only the request is.
    expect((await signalledClaims({ projectId })).map((one) => one.claim.claim)).toEqual([request]);
    await harvest({ projectId });
    const filed = (await listOpportunities({ projectId })).filter((one) => one.discoveryRoundId !== null);
    expect(filed.map((one) => one.title)).toEqual(['Buyer request: County facilities departments — SAM.gov']);
    expect(filed[0]!.buyingSignal).toBe(request);
  });
});

describe('O-2: an observation of a moment expires', () => {
  it('reads the expiry from the source date, never from when Brain read it', () => {
    const now = new Date('2026-11-14T00:00:00.000Z');
    const at = (sourceDate: string | null, closesOn: string | null = null, signal: OpportunitySignal = 'RESALABLE_ASSET_OPENING') =>
      observationExpiry({ signal, closesOn, sourceDate, freshDays: 30, now });
    // The Coachella resale price seen in April 2026, modelled in November: stale.
    expect(at('2026-04-12')).toMatchObject({ stale: true });
    expect(at('2026-11-01')).toEqual({ stale: false, expiresAt: '2026-12-01', observedAt: '2026-11-01T00:00:00.000Z' });
    // A published deadline is the answer, whatever the source's age.
    expect(at('2026-04-12', '2026-12-20')).toMatchObject({ stale: false, expiresAt: '2026-12-20' });
    // Undated: no expiry it can be held to, and no observation date invented.
    expect(at(null)).toEqual({ stale: false, expiresAt: null, observedAt: null });
    // A recurring pattern is not a moment.
    expect(at('2026-04-12', null, 'RECURRING_OUTSOURCED_WORK')).toMatchObject({ stale: false, expiresAt: null });
  });

  it('skips a stale request, gives a fresh one an end, and leaves an undated one undated', async () => {
    await goalRoundWith([
      { claim: 'A festival-goer is reselling two Coachella weekend passes at $1,100.', sourceUrl: 'https://resale.example.test/coachella', sourceDate: '2026-04-12', signal: 'RESALABLE_ASSET_OPENING' },
      { claim: 'A clinic asked for a patient-intake spreadsheet, budget $600.', sourceUrl: 'https://jobs.example.test/clinic', sourceDate: daysAgo(5), population: 'Clinics' },
      { claim: 'A landlord asked for a rent-roll spreadsheet, budget $300.', sourceUrl: 'https://jobs.example.test/landlord', sourceDate: null, population: 'Landlords' },
    ]);
    // Verification: the April observation is not even read, so it cannot fill a bounded read.
    expect((await signalledClaims({ projectId, staleBefore: new Date(Date.now() - 30 * DAY).toISOString() })).map((one) => one.claim.sourceUrl).sort())
      .toEqual(['https://jobs.example.test/clinic', 'https://jobs.example.test/landlord']);
    await harvest({ projectId });
    const filed = (await listOpportunities({ projectId })).filter((one) => one.discoveryRoundId !== null);
    expect(filed).toHaveLength(2);
    const clinic = filed.find((one) => one.title.startsWith('Buyer request: Clinics'))!;
    expect(clinic.expiresAt?.slice(0, 10)).toBe(new Date(Date.parse(daysAgo(5)) + 30 * DAY).toISOString().slice(0, 10));
    expect(clinic.signalObservedAt?.slice(0, 10)).toBe(daysAgo(5));
    const landlord = filed.find((one) => one.title.startsWith('Buyer request: Landlords'))!;
    expect(landlord.expiresAt).toBeNull();
    expect(landlord.signalObservedAt).toBeNull();
  });

  it('leaves a one-off opening with a stale signal and no expiry out of the goal model', async () => {
    const cashModeId = (await getCashMode(projectId))!.id;
    const make = async (title: string, observed: string) => {
      const o = await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title, mechanism: 'RESALE_OR_ASSET', currency: 'USD',
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RESALABLE_ASSET_OPENING', source: 'A publisher',
      });
      for (const [field, value] of [[CAPTURE_KEY, 'Buy the passes and resell them at the asking price.'], ['payer', 'Festival-goers'], ['price', '$900'], ['delivery', 'A transfer of the passes.']] as const) {
        await recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
      }
      await updateOpportunity(o.id, {
        payer: 'Festival-goers', price_cents: 90_000, offer_scope: 'Two passes', reachable_channel: 'The resale listing',
        buying_signal: 'Posted asking for passes', signal_observed_at: observed,
      });
      return o;
    };
    await make('Coachella passes, seen in April', '2026-04-12T00:00:00.000Z');
    await make('Passes asked for this week', new Date(Date.now() - 2 * DAY).toISOString());
    const { id } = await goal();
    const reading = (await readGoalPlan({ goalId: id, evaluations: 500 }))!;
    const reason = `signal older than ${RECOMMENDATION_POLICY.demandFreshDays} days`;
    // Verification: before the fix nothing excluded it, because its expiresAt is null.
    expect(reading.excluded.find((one) => one.title === 'Coachella passes, seen in April')?.reason).toMatch(reason);
    expect(reading.excluded.find((one) => one.title === 'Passes asked for this week')?.reason ?? '').not.toMatch(reason);
  });
});

describe('O-3: one buyer population is one market', () => {
  it('labels two needs of one buyer apart and enters the population once', async () => {
    const s = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Anime', origin: 'SEED' });
    await createNode({ projectId, parentId: s.node.id, kind: 'BUYER_TYPE', name: 'Production committee investor companies', origin: 'SEED' });
    await createNode({ projectId, parentId: s.node.id, kind: 'BOTTLENECK', name: 'Overseas licensing', origin: 'SEED' });
    await createNode({ projectId, parentId: s.node.id, kind: 'BOTTLENECK', name: 'Subtitle localisation', origin: 'SEED' });
    await createNode({ projectId, parentId: s.node.id, kind: 'FULFILMENT_SOURCE', name: 'Licensing agents', origin: 'SEED' });
    const all = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: null, daysLeft: 30, now: new Date() } as Parameters<typeof constructArrangements>[0]);
    const buyer = all.filter((one) => one.demand.name === 'Production committee investor companies' && one.need);
    expect(buyer.length).toBeGreaterThan(1);
    // Verification: one label per (need, design, supply), where before every need of this buyer shared its labels.
    const labels = new Map<string, Set<string>>();
    for (const one of buyer) labels.set(one.label, (labels.get(one.label) ?? new Set()).add(one.need!.ref));
    expect([...labels.values()].every((needs) => needs.size === 1)).toBe(true);
    expect(buyer.every((one) => one.label.includes(one.need!.name))).toBe(true);

    const estimated = buyer.map((one) => ({ ...one, value: { tier: 'COMPARABLE', p10: 100, p50: 500, p90: 900, observations: 2 }, stress: { ...one.stress, exposure: 'SAFE' as const } }));
    const picked = pickEstimatedArrangements(estimated as never, { projectId, currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [] });
    // The repro picked every design over this one population; now one stands for it.
    expect(picked).toHaveLength(1);
  });
});

describe('O-5: a blocked packet names the cause, not the first reason written', () => {
  it('reads the verifier’s verdict, not an open conditional lane that does not block', () => {
    const reasons = [
      '3 conditional lane(s) are open and do not block: demand_absence, demand_closed, economics. They were asked and nothing was accepted for them.',
      'Verification judged the answer incomplete even though every lane is covered: demand_signal',
    ];
    const gate = { claims: [{}, {}], acceptedClaims: 2, rejectedClaims: 0, unresolvedRetrieval: [], coverage: [], integrity: 'PASS', sufficiency: 'INSUFFICIENT', reasons };
    const fragment = { id: 'f', fragmentKey: 'market-signal', attempt: 2, status: 'BLOCKED', blockedReason: reasons.join(' '), verdictDetail: gate, blockCause: null } as never;
    const detail = noFragmentClearedDetail([fragment], { refused: [], mintable: [] } as never);
    // Verification: before the fix the detail read "3 conditional lane(s) are open and do not block…".
    expect(detail).toMatch(/^market-signal \(attempt 2, VERIFIER_INSUFFICIENT\): Verification judged the answer incomplete/);
    expect(detail).not.toMatch(/do not block/);
  });

  it('reads the stored cause first, and the matching sentence for it', () => {
    const reasons = [
      '1 claim(s) failed: the exact passage, table or locator is preserved.',
      '1 required evidence lane(s) have no accepted claim: demand_signal (a published request)',
    ];
    const gate = { claims: [{}, {}], acceptedClaims: 1, rejectedClaims: 1, unresolvedRetrieval: [], coverage: [], integrity: 'PASS', sufficiency: 'INSUFFICIENT', reasons };
    const fragment = { id: 'f', fragmentKey: 'lens', attempt: 1, status: 'BLOCKED', blockedReason: reasons.join(' '), verdictDetail: gate, blockCause: 'REQUIRED_LANE_EMPTY' } as never;
    expect(noFragmentClearedDetail([fragment], { refused: [], mintable: [] } as never)).toMatch(/^lens \(attempt 1, REQUIRED_LANE_EMPTY\): 1 required evidence lane/);
  });
});

describe('O-7: an unpublished capital whose worst case fits the limit is a market test', () => {
  const input = (value: number | null, low: number, high: number | null) => ({ value, low, high, provenance: value === null ? 'UNKNOWN' : 'EVIDENCE', source: null, note: '' });
  const card = (capital: ReturnType<typeof input>) => ({
    opportunity: { payer: 'Property managers', offerScope: 'A monthly report', buyingSignal: 'Posted asking', reachableChannel: 'email' },
    price: input(300, 300, 300), capital, directCost: input(null, 0, 180), agreed: false, competitiveAward: false,
  }) as never;
  const checks = [{ link: 'REACHABLE_BUYER', ok: true, basis: '' }] as never;
  const limit = (cents: number | null) => ({ capitalBeforeProofCents: cents }) as never;

  it('price 300, capital swept 0–300: C under a 375 limit, B under 200, B with no limit', () => {
    // Verification: before the fix the first read B_EVIDENCED, because capital.value was null.
    expect(validationStage(card(input(null, 0, 300)), checks, limit(37_500), false)).toBe('C_MARKET_TEST_READY');
    expect(validationStage(card(input(null, 0, 300)), checks, limit(20_000), false)).toBe('B_EVIDENCED');
    expect(validationStage(card(input(null, 0, 300)), checks, limit(null), false)).toBe('B_EVIDENCED');
    // An unbounded worst case assumes nothing favourable.
    expect(validationStage(card(input(null, 0, null)), checks, limit(37_500), false)).toBe('B_EVIDENCED');
    // A published figure is read as before.
    expect(validationStage(card(input(0, 0, 0)), checks, limit(20_000), false)).toBe('C_MARKET_TEST_READY');
    expect(validationStage(card(input(250, 250, 250)), checks, limit(20_000), false)).toBe('B_EVIDENCED');
  });
});
