/**
 * §81: Brain constructs arrangements nobody published, asks the world only
 * for the parts nothing establishes, and models a repeatable play from the
 * volume research established — never from the buyers a plan would like.
 *
 * The full chain is walked once with only the worker simulated: a goal the
 * held openings cannot reach → a constructed arrangement → a research round
 * through the ordinary gate → a finished mission whose gated claim carries an
 * opening signal → the harvest files an opening → research answers its card →
 * the goal's model includes it, with its volume capping its deals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { createWorkstream, getWorkstream, listLinks } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { advanceGoalPlans, askConstructedArrangements, forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { constructArrangements, STRUCTURES } from '../server/services/cash/construct.ts';
import { harvest, MAX_LIVE_GOAL_ROUNDS, SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { readVolume } from '../server/services/cash/volume.ts';
import { researchGoalPaths } from '../server/services/goals/pathResearch.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashMechanism, Layer, OpportunitySignal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `mx-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

type ClaimInput = { claim: string; signal?: OpportunitySignal; lane?: string; sourceUrl: string };

/** A finished mission for a candidate, with gated claims — the real rows a harvest reads. */
async function finishedMission(candidateId: string, claims: ClaimInput[]): Promise<string[]> {
  const { ids, orchestrationId } = await gatedClaims(claims);
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${orchestrationId}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
  return ids;
}

/** Claims accepted at the gate inside an orchestration of their own. */
async function gatedClaims(claims: ClaimInput[]): Promise<{ ids: string[]; orchestrationId: string }> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a question' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a question', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: ['a forecast'], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: one.claim, evidenceLocator: 'the page', evidenceLane: one.lane ?? SIGNAL_LANE, opportunitySignal: one.signal ?? null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${one.claim}|${one.sourceUrl}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return { ids: inserted.map((one) => one.id), orchestrationId: orchestration.id };
}

/** Map parts established by gated claims — the industry kernel's own rows. */
async function sector(name: string, parts: { buyer: string; bottleneck: string; supply: string }): Promise<void> {
  const [, buyer, bottleneck, supply] = (await gatedClaims([
    { claim: `${name} is a sector.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(name)}` },
    { claim: `${parts.buyer} buy in ${name}.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.buyer)}` },
    { claim: `${parts.bottleneck} is a recurring problem.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.bottleneck)}` },
    { claim: `${parts.supply} serve this.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.supply)}` },
  ])).ids;
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: parts.buyer, origin: buyer ? 'DISCOVERED' : 'SEED', sourceClaimId: buyer ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: parts.bottleneck, origin: bottleneck ? 'DISCOVERED' : 'SEED', sourceClaimId: bottleneck ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: parts.supply, origin: supply ? 'DISCOVERED' : 'SEED', sourceClaimId: supply ?? null });
}

async function goal(amountCents: number, days = 30, capitalCents: number | null = null): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: capitalCents, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

async function opening(input: { title: string; priceCents: number; mechanism?: CashMechanism; payer?: string; volume?: string; signal?: OpportunitySignal; play?: boolean }) {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title: input.title, mechanism: input.mechanism ?? 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: input.signal ?? 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
    requiredCapabilities: input.play === false ? [] : ['PRODUCE_SPREADSHEET'],
  });
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, 'Sell the work to each buyer.');
  await fact('payer', input.payer ?? 'Property managers');
  await fact('delivery', 'Brain produces it.');
  await updateOpportunity(o.id, { payer: input.payer ?? 'Property managers', price_cents: input.priceCents, offer_scope: 'One report', reachable_channel: 'Published emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-2), peak_funding_cents: 0, human_hours: 2 });
  await fact('price', `$${input.priceCents / 100}`);
  await fact('timeToFirstCash', '7 days');
  await fact('directCosts', '$10');
  if (input.volume) await fact('buyerVolume', input.volume);
  return o;
}

describe('a market volume is read, never assumed', () => {
  it('reads buyers and frequency, or an order rate, and refuses words that are not a count', () => {
    expect(readVolume('About 3,400 property management firms are listed in the state directory; each orders the report monthly.', 30)).toMatchObject({ deals: 3400, buyers: 3400, everyDays: 30 });
    expect(readVolume('120 orders per month are published in the category', 30)).toMatchObject({ deals: 120 });
    expect(readVolume('200 restaurants buy weekly', 30)!.deals).toBe(800);
    expect(readVolume('12 businesses', 30)).toMatchObject({ deals: 12, everyDays: null });
    // A money figure is not a count of buyers, and "thousands" states no number.
    expect(readVolume('$5,000 per engagement', 30)).toBeNull();
    expect(readVolume('Thousands of buyers need this', 30)).toBeNull();
    expect(readVolume('Many firms', 30)).toBeNull();
  });

  it('holds a repeatable play to the volume research established, and names the missing link when nobody has', async () => {
    const unknown = await opening({ title: 'Monthly owner reports, volume unknown', priceCents: 50_000 });
    const id = await goal(500_000);
    let reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const one = reading.considered.find((c) => c.opportunityId === unknown.id)!;
    // One deal at a supported price, never the 200 buyers a strategy would like.
    expect(one.supportedReach).toBe(500);
    expect(one.missing).toContain('MARKET_VOLUME');
    expect(one.volumeEstablished).toBe(false);
    const only = reading.strategies.find((s) => s.opportunityIds[0] === unknown.id)!;
    expect(only.links.find((l) => l.link === 'MARKET_VOLUME')!.basis).toMatch(/nobody has established how many buyers/);
    // And it is the next research question for this opening.
    const trace: string[] = [];
    await researchGoalPaths({ reading, projectId, now, trace, dryRun: true });
    expect(trace.join('\n')).toMatch(/buyerVolume: would ask/);

    // Research establishes a small market: three buyers, once each. The plan cannot pretend more.
    await recordCardFact({ projectId, opportunityId: unknown.id, field: 'buyerVolume', kind: 'EVIDENCE', value: 'The registry lists 3 property management firms in the county.', claimId: 'clm_vol', decidedBy: 'BRAIN' });
    forgetKnowledge();
    reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const small = reading.strategies.find((s) => s.opportunityIds[0] === unknown.id)!;
    expect(small.links.find((l) => l.link === 'MARKET_VOLUME')).toMatchObject({ ok: false });
    expect(small.constraintsFailed.join(' ')).toMatch(/at most 1500/);
    expect(reading.considered.find((c) => c.opportunityId === unknown.id)!.supportedReach).toBe(1_500);
  });

  it('makes a one-off repeatable only when research shows it sells again', async () => {
    const o = await opening({ title: 'Arrange one freight load', priceCents: 40_000, mechanism: 'SUPPLY_DEMAND_MISMATCH', signal: 'PAID_TASK_OR_CONTRACT', play: false });
    const id = await goal(400_000);
    let reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.considered.find((c) => c.opportunityId === o.id)!.supportedReach).toBe(400);
    // Whether it repeats is investigated rather than assumed.
    const trace: string[] = [];
    await researchGoalPaths({ reading, projectId, now, trace, dryRun: true });
    expect(trace.join('\n')).toMatch(/Arrange one freight load buyerVolume: would ask/);
    await recordCardFact({ projectId, opportunityId: o.id, field: 'buyerVolume', kind: 'EVIDENCE', value: 'The load board lists 60 shippers posting this lane, each weekly.', claimId: 'clm_vol2', decidedBy: 'BRAIN' });
    reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.considered.find((c) => c.opportunityId === o.id)!.supportedReach).toBe(4_000);
    expect(reading.pool.conclusion).toBe('POOL_COULD_REACH');
  });
});

describe('arrangements Brain constructs from what it knows', () => {
  it('composes new arrangements in unrelated industries with no per-industry code, and leaves out what it already holds', async () => {
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' });
    await sector('Commercial grounds care', { buyer: 'Homeowner association boards', bottleneck: 'Snow removal surges', supply: 'Independent plow operators' });
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: null, daysLeft: 30, now });
    const sectors = new Set(built.map((one) => one.sector));
    expect(sectors).toEqual(new Set(['Veterinary care', 'Commercial grounds care']));
    const structures = new Set(built.map((one) => one.structure));
    for (const s of ['PRODUCE', 'BROKER', 'REFERRAL', 'SUBCONTRACT', 'POOL']) expect(structures.has(s as never)).toBe(true);
    const vet = built.find((one) => one.structure === 'BROKER' && one.sector === 'Veterinary care')!;
    expect(vet.demand.name).toBe('Independent veterinary clinics');
    expect(vet.need!.name).toBe('After-hours phone coverage');
    expect(vet.supply!.name).toBe('Remote answering services');
    // The decomposition decides the question: every part nothing establishes is asked.
    expect(vet.unknownParts).toEqual(expect.arrayContaining(['buyers', 'need_rate', 'conversion', 'value', 'commission', 'supply_units']));
    expect(vet.question).toMatch(/how many buyers of exactly this kind exist/);
    expect(vet.question).toMatch(/commission share/);
    expect(vet.question).toMatch(/refutes the arrangement/);
    // With no capital allowed, arrangements that tie up money rank after those that do not.
    const firstCapital = built.findIndex((one) => STRUCTURES[one.structure].capital !== 'NONE');
    const lastFree = built.map((one) => STRUCTURES[one.structure].capital).lastIndexOf('NONE');
    expect(firstCapital).toBeGreaterThan(lastFree);

    // A payer already held as a subcontracted job is not offered back as one.
    await opening({ title: 'Clinic overflow calls, subcontracted', priceCents: 30_000, mechanism: 'SUBCONTRACTED_FULFILMENT', payer: 'Independent veterinary clinics' });
    const again = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: null, daysLeft: 30, now });
    expect(again.some((one) => one.structure === 'SUBCONTRACT' && one.demand.name === 'Independent veterinary clinics' && one.sector === 'Veterinary care')).toBe(false);
  });

  it('uses what Brain holds about the buyer directly when it is enough, and asks only what is missing', async () => {
    // Two openings researched what clinics pay for other work: that is evidence about this buyer.
    for (const [i, price] of [45_000, 60_000].entries()) {
      await opening({ title: `Clinic report ${i}`, priceCents: price, payer: 'Independent veterinary clinics', mechanism: 'PRODUCTIZED_SERVICE' });
    }
    await createNode({ projectId, parentId: null, kind: 'BUYER_TYPE', name: 'Feed stores', origin: 'SEED' });
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    // No supply on the map and no deliverable proved: nothing can be composed for clinics yet.
    expect(built).toHaveLength(0);
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' });
    const withSupply = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    const clinic = withSupply.find((one) => one.demand.name === 'Independent veterinary clinics' && one.structure === 'BROKER')!;
    expect(clinic.value.tier).toBe('COMPARABLE');
    expect(clinic.value.observations).toBe(2);
    expect(clinic.unknownParts).not.toContain('value');
    expect(clinic.question).toMatch(/already partly established \(USD \d+–\d+ from 2 published figures\)/);
  });

  it('runs the whole chain: construct → research round → gated claim → opening → card → plan', async () => {
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' });
    const small = await opening({ title: 'One small report', priceCents: 20_000, play: false, signal: 'PAID_TASK_OR_CONTRACT' });
    void small;
    const id = await goal(600_000);

    // The tick: the held pool cannot reach the goal, so Brain constructs and asks.
    const tick = await advanceGoalPlans(now);
    expect(tick.constructed).toBeGreaterThan(0);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    expect(reading.pool.conclusion).toBe('POOL_INSUFFICIENT');
    expect(reading.pool.sentence).toMatch(/not .*nothing viable exists|rather than concluding nothing viable exists/);
    const mx = (await listRounds(projectId)).filter((one) => one.bucketId.startsWith(`goal-${id}-mx-`));
    expect(mx.length).toBe(tick.constructed);
    const candidate = (await getCandidate(mx[0]!.candidateId))!;
    expect(candidate.statement).toMatch(/Brain composed an arrangement nobody has published/);
    expect((await listLinks(id)).some((l) => l.kind === 'CANDIDATE' && l.ref === candidate.id && l.relation === 'PURSUES')).toBe(true);

    // The world answers through the ordinary gate: a gated claim with an opening signal.
    await finishedMission(candidate.id, [
      { claim: 'Independent veterinary clinics publish requests for after-hours call coverage, paid monthly at $300 per clinic.', signal: 'RECURRING_OUTSOURCED_WORK', sourceUrl: 'https://example.test/vet-after-hours' },
    ]);
    const filed = await harvest({ projectId });
    expect(filed).toHaveLength(1);
    const o = (await getOpportunity(filed[0]!.opportunity.id))!;
    expect(o.discoveredByCandidateId).toBe(candidate.id);

    // Path research answers its card through the gate; the model then includes it.
    const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: filed[0]!.claimId, decidedBy: 'BRAIN' });
    await fact(CAPTURE_KEY, 'Arrange after-hours coverage for each clinic for a commission.');
    await fact('payer', 'Independent veterinary clinics');
    await fact('price', '$300');
    await fact('timeToFirstCash', '14 days');
    await fact('directCosts', '$20');
    await fact('buyerVolume', 'The state veterinary board lists 900 independent veterinary clinics; each pays monthly.');
    await updateOpportunity(o.id, { payer: 'Independent veterinary clinics', price_cents: 30_000, offer_scope: 'After-hours call coverage for one month', reachable_channel: 'Published clinic emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-3), peak_funding_cents: 0, human_hours: 1, fulfillment_owner: 'Remote answering services' });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'fulfillment', kind: 'EVIDENCE', value: 'Remote answering services', claimId: filed[0]!.claimId, decidedBy: 'BRAIN' });
    const after = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const considered = after.considered.find((c) => c.opportunityId === o.id)!;
    expect(considered).toBeDefined();
    expect(considered.volumeEstablished).toBe(true);
    // Its deals are capped by the 900 clinics research found, not by a guess, and it can carry the gap.
    expect(considered.supportedReach).toBe(6_000);
    expect(after.pool.conclusion).toBe('POOL_COULD_REACH');
    const strategy = after.strategies.find((s) => s.opportunityIds.includes(o.id))!;
    expect(strategy.links.find((l) => l.link === 'MARKET_VOLUME')).toMatchObject({ ok: true });
  });

  it('asks each constructed arrangement once, then the next, within the live cap', async () => {
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' });
    const id = await goal(600_000);
    const w = (await getWorkstream(id))!;
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    const first = await askConstructedArrangements(w, reading, now, 2, MAX_LIVE_GOAL_ROUNDS);
    expect(first).toHaveLength(2);
    const second = await askConstructedArrangements(w, reading, now, 2, MAX_LIVE_GOAL_ROUNDS);
    // The cap of three is shared; only one more fits, and it is a different arrangement.
    expect(second).toHaveLength(1);
    const keys = (await listRounds(projectId)).filter((one) => one.bucketId.includes('-mx-')).map((one) => one.bucketId);
    expect(new Set(keys).size).toBe(3);
  });
});
