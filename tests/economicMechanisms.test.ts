/**
 * §82: Brain learns the economics of an arrangement rather than its business
 * format, and constructs new arrangements both forward (from parts it holds)
 * and in reverse (from the properties a goal needs).
 *
 * The local shared mailer is used once, as a design, to show its properties
 * are derived rather than declared. Every other test runs in industries that
 * have nothing to do with mail, with no code naming any of them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, setConstraints } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { askConstructedArrangements, forgetGoalReadings, goalLimits, readGoalPlan } from '../server/services/goals/plan.ts';
import { constructArrangements, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import {
  allDesigns,
  coherent,
  designFacts,
  propertiesOf,
  stressDesign,
  STRUCTURE_KEYS,
  targetProperties,
  type Design,
} from '../server/services/cash/properties.ts';
import { excludedBy, exclusionsIn } from '../server/services/cash/exclusions.ts';
import { composeArrangement } from '../server/services/quant/mechanism.ts';
import { compile, parse, identifiers } from '../server/services/scenario/expr.ts';
import { harvest, MAX_LIVE_GOAL_ROUNDS, SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';
import { describesOwnAction } from '../server/services/research/actorScope.ts';
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
  userId = (await createUser({ email: `em-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

type ClaimInput = { claim: string; signal?: OpportunitySignal; lane?: string; sourceUrl: string };

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

async function finishedMission(candidateId: string, claims: ClaimInput[]): Promise<void> {
  const { orchestrationId } = await gatedClaims(claims);
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${orchestrationId}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

async function sector(name: string, parts: { buyer: string; bottleneck: string; supply: string }): Promise<void> {
  const [, buyer, bottleneck, supply] = (await gatedClaims([
    { claim: `${name} is a sector.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(name)}` },
    { claim: `${parts.buyer} buy in ${name}.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.buyer)}` },
    { claim: `${parts.bottleneck} is a recurring problem.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.bottleneck)}` },
    { claim: `${parts.supply} serve this.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.supply)}` },
  ])).ids;
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: parts.buyer, origin: 'DISCOVERED', sourceClaimId: buyer! });
  await createNode({ projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: parts.bottleneck, origin: 'DISCOVERED', sourceClaimId: bottleneck! });
  await createNode({ projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: parts.supply, origin: 'DISCOVERED', sourceClaimId: supply! });
}

async function goal(amountCents: number, opts: { days?: number; capitalCents?: number | null; beforeProofCents?: number | null; intent?: string } = {}): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: opts.intent ?? 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(opts.days ?? 30), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId,
      capitalCeilingCents: opts.capitalCents ?? null, capitalBeforeProofCents: opts.beforeProofCents ?? null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return g.id;
}

async function opening(input: { title: string; priceCents: number; mechanism?: CashMechanism; payer: string; industry?: string; peakCents?: number }) {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title: input.title, mechanism: input.mechanism ?? 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
    requiredCapabilities: [],
  });
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, 'Own the buyer and pay a supplier.');
  await fact('payer', input.payer);
  await updateOpportunity(o.id, { payer: input.payer, industry: input.industry ?? null, price_cents: input.priceCents, peak_funding_cents: input.peakCents ?? null, offer_scope: 'One job' });
  return o;
}

const dims = (d: Design) => `${d.funding}/${d.aggregation}/${d.repeat}/${designFacts(d).payer}/${designFacts(d).riskBearer}`;
const forward = (all: ConstructedArrangement[]) => all.filter((one) => one.origin !== 'REVERSE');

describe('properties are derived from the transaction design, never from a business', () => {
  it('reads the shared mailer as a design, and finds the same properties in a design with nothing to do with mail', () => {
    // A local shared mailer, as economics: several buyers share one supplier's run,
    // presold and bought only once enough prepay, with a fresh group each run.
    const mailer: Design = { base: 'SUBCONTRACT', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' };
    expect(propertiesOf(mailer)).toEqual(expect.arrayContaining([
      'SHARED_FIXED_COST', 'AFFORDABLE_UNIT_PRICE', 'PREPAID_FULFILMENT', 'NO_CAPITAL_AT_RISK', 'SHORT_TIME_TO_CASH', 'LOW_BUYER_RISK', 'REPEATABLE', 'REUSABLE_INFRASTRUCTURE',
    ]));
    // The same design produced by Brain itself (one deliverable shared by several buyers) keeps the economics and adds a near-zero marginal cost.
    const shared: Design = { ...mailer, base: 'PRODUCE' };
    expect(propertiesOf(shared)).toEqual(expect.arrayContaining(['SHARED_FIXED_COST', 'PREPAID_FULFILMENT', 'LOW_MARGINAL_COST']));
    // A referral paid by the supplier has properties a mailer lacks.
    expect(propertiesOf({ base: 'REFERRAL', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' })).toEqual(expect.arrayContaining(['LOW_BUYER_RISK', 'NO_CAPITAL_AT_RISK']));
  });

  it('refuses incoherent designs by rule, and every design it keeps is coherent', () => {
    expect(coherent({ base: 'REFERRAL', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'ONE_OFF' })).toBe(false);
    expect(coherent({ base: 'SUBCONTRACT', funding: 'THRESHOLD_PRESALE', aggregation: 'SINGLE', repeat: 'ONE_OFF' })).toBe(false);
    expect(coherent({ base: 'POOL', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' })).toBe(false);
    const designs = allDesigns(STRUCTURE_KEYS);
    expect(designs.every(coherent)).toBe(true);
    expect(new Set(designs.map((d) => `${d.base}/${dims(d)}`)).size).toBe(designs.length);
  });

  it('models a shared run: below its minimum a threshold presale loses nothing while an unprotected run loses its fixed cost', () => {
    const composeRun = (threshold: boolean) =>
      composeArrangement({
        key: 'r', label: 'run', period: '30 days', currency: 'USD',
        demand: { buyers: { min: 0, max: 1 }, needRate: { min: 0, max: 1 }, reach: { min: 0, max: 1 }, conversion: { min: 0, max: 1 } },
        value: { min: 0, max: 1 }, capture: { kind: 'FEE', fee: { min: 0, max: 1 } }, cost: { min: 0, max: 1 },
        pooling: { fixedCost: { min: 0, max: 1 }, minParticipants: { min: 0, max: 1 }, threshold },
        funding: { prepayShare: { min: 0, max: 1 } },
      });
    const evaluate = (formula: string, env: Record<string, number>) => {
      const names = [...identifiers(parse(formula))];
      return compile(parse(formula), (n) => names.indexOf(n))(Float64Array.from(names.map((n) => env[n] ?? 0)));
    };
    const world = (transactions: number) => ({ r_transactions: transactions, r_capture: 60, r_cost: 5, r_fixed_cost: 1_000, r_min_participants: 25, r_prepay_share: 0.5 });
    const protectedRun = composeRun(true);
    const exposedRun = composeRun(false);
    // Fewer buyers than the run needs.
    expect(evaluate(protectedRun.formulas['r_contribution']!, world(10))).toBe(0);
    expect(evaluate(exposedRun.formulas['r_contribution']!, world(10))).toBe(10 * 55 - 1_000);
    // Enough buyers: the shared fixed cost is divided and both earn.
    expect(evaluate(protectedRun.formulas['r_contribution']!, world(40))).toBe(40 * 55 - 1_000);
    // A threshold presale ties up nothing; an unprotected run ties up the unfunded part of its fixed cost.
    expect(protectedRun.exposure).toBeNull();
    expect(evaluate(exposedRun.formulas['r_exposure']!, world(40))).toBe(500);
  });

  it('stresses each design on bounds: only a structural cap survives a tight limit', () => {
    const exposed: Design = { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'POOLED_BUYERS', repeat: 'ONE_OFF' };
    const capped: Design = { ...exposed, funding: 'THRESHOLD_PRESALE' };
    expect(stressDesign(exposed, { atRiskCents: null, limitCents: 30_000 }).exposure).toBe('UNKNOWN');
    expect(stressDesign(exposed, { atRiskCents: 500_000, limitCents: 30_000 }).exposure).toBe('EXCEEDS');
    expect(stressDesign(exposed, { atRiskCents: 20_000, limitCents: 30_000 }).exposure).toBe('BOUNDED');
    const safe = stressDesign(capped, { atRiskCents: 500_000, limitCents: 30_000 });
    expect(safe.exposure).toBe('SAFE');
    const effect = (f: string) => safe.failures.find((one) => one.failure === f)!.effect;
    expect(effect('FEWER_BUYERS')).toMatch(/refunded; nothing of ours is spent/);
    expect(effect('SUPPLIER_SHORTFALL')).toMatch(/refunded or served by another supplier/);
    expect(stressDesign(exposed, { atRiskCents: null, limitCents: null }).failures.find((one) => one.failure === 'DELAYED_PAYMENT')!.effect).toMatch(/after the deadline/);
  });
});

describe('reverse construction starts from what the goal needs', () => {
  it('reads target properties from the goal’s own limits, with the limit each came from', () => {
    const t = targetProperties({ daysLeft: 25, remainingCents: 1_000_000, capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, bestReachCents: 125_000 });
    const props = t.map((one) => one.property);
    expect(props).toEqual(expect.arrayContaining(['NO_CAPITAL_AT_RISK', 'PREPAID_FULFILMENT', 'SHORT_TIME_TO_CASH', 'REPEATABLE', 'SHARED_FIXED_COST']));
    expect(t.find((one) => one.property === 'NO_CAPITAL_AT_RISK')!.because).toMatch(/only 300 may be tied up/);
    // A goal with money to spare and a pool that reaches it asks for none of those.
    expect(targetProperties({ daysLeft: null, remainingCents: 100_000, capitalCeilingCents: 1_000_000, capitalBeforeProofCents: null, bestReachCents: 200_000 })).toEqual([]);
  });

  it('composes structurally different reverse arrangements for an empty map, each asking for the evidence its properties need', async () => {
    const limits = { daysLeft: 25, remainingCents: 1_000_000, capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, bestReachCents: 0 };
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 300_000, daysLeft: 25, limits, now });
    const reverse = built.filter((one) => one.origin === 'REVERSE');
    expect(reverse.length).toBeGreaterThanOrEqual(3);
    // Different structures, not one template with a knob turned.
    expect(new Set(reverse.map((one) => one.structure)).size).toBe(reverse.length);
    for (const one of reverse) {
      expect(one.targetsMet.length).toBeGreaterThan(0);
      expect(one.demand.from).toBe('REVERSE');
      expect(one.question).toMatch(/starting from the economics the goal needs/);
      expect(one.question).toMatch(/refutes the arrangement/);
      expect(one.question).toMatch(/how many buyers of exactly this kind exist/);
    }
    // A presold design names prepayment as a hypothesis to establish, not a fact.
    const presold = reverse.find((one) => one.design.funding !== 'ON_DELIVERY')!;
    expect(presold.unknownParts).toContain('prepay_share');
    expect(presold.question).toMatch(/paying before delivery/);
    expect(presold.question).toMatch(/each of these is a hypothesis/);
    // Nothing tight-limit-unsafe leads the ranking.
    expect(built[0]!.stress.exposure).toBe('SAFE');
  });

  it('reports emergent properties the goal did not ask for', async () => {
    const limits = { daysLeft: 25, remainingCents: 1_000_000, capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, bestReachCents: 0 };
    await sector('Pet boarding', { buyer: 'Independent kennels', bottleneck: 'Holiday overflow bookings', supply: 'Licensed home pet sitters' });
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 25, limits, now });
    const referral = built.find((one) => one.structure === 'REFERRAL')!;
    expect(referral.emergent).toContain('LOW_BUYER_RISK');
    expect(referral.targetsMet).not.toContain('LOW_BUYER_RISK');
  });
});

describe('forward construction and transfer', () => {
  it('makes several structurally different arrangements from one principle for the same buyers', async () => {
    await sector('Residential window cleaning', { buyer: 'Suburban homeowners', bottleneck: 'Seasonal exterior cleaning', supply: 'Independent window cleaners' });
    const built = forward(await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now }));
    const homeowners = built.filter((one) => one.demand.name === 'Suburban homeowners');
    // Who pays, who bears the risk, how buyers aggregate, when money moves and what recurs all vary.
    expect(new Set(homeowners.map((one) => designFacts(one.design).payer))).toEqual(new Set(['BUYER', 'SUPPLIER']));
    expect(new Set(homeowners.map((one) => designFacts(one.design).riskBearer)).size).toBe(3);
    expect(new Set(homeowners.map((one) => one.design.aggregation)).size).toBe(2);
    expect(new Set(homeowners.map((one) => one.design.funding)).size).toBe(3);
    expect(new Set(homeowners.map((one) => one.design.repeat)).size).toBe(3);
    // Route density: many nearby buyers pooled onto one supplier's run, presold — the mailer's economics, in a different trade.
    const route = homeowners.find((one) => one.structure === 'SUBCONTRACT' && one.design.aggregation === 'POOLED_BUYERS' && one.design.funding === 'THRESHOLD_PRESALE' && one.design.repeat === 'RECURRING_COHORT')!;
    expect(route.properties).toEqual(expect.arrayContaining(['SHARED_FIXED_COST', 'NO_CAPITAL_AT_RISK', 'REUSABLE_INFRASTRUCTURE']));
    expect(route.unknownParts).toEqual(expect.arrayContaining(['fixed_cost', 'min_participants', 'prepay_share', 'repeat_rate']));
    expect(route.question).toMatch(/fell short of their minimum/);
    // No two arrangements share a key.
    expect(new Set(built.map((one) => one.key)).size).toBe(built.length);
  });

  it('carries a design a held opening shows working to a different buyer, naming the precedent', async () => {
    await opening({ title: 'Dental practices outsource after-hours sterilisation audits to contractors', priceCents: 40_000, mechanism: 'SUBCONTRACTED_FULFILMENT', payer: 'Dental practices', industry: 'Dentistry' });
    await sector('Commercial kitchens', { buyer: 'Independent restaurants', bottleneck: 'Hood and duct cleaning compliance', supply: 'Certified hood cleaning crews' });
    const built = forward(await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now }));
    const transfer = built.find((one) => one.origin === 'TRANSFER' && one.demand.name === 'Independent restaurants' && one.structure === 'SUBCONTRACT')!;
    expect(transfer.precedent!.title).toMatch(/Dental practices/);
    expect(transfer.question).toMatch(/same design is shown working for a different buyer/);
    // A precedent ranks ahead of an otherwise equal arrangement without one.
    const plain = built.find((one) => one.origin === 'FORWARD' && one.demand.name === 'Independent restaurants' && one.structure === 'BROKER' && one.design.funding === 'ON_DELIVERY' && one.design.aggregation === 'SINGLE' && one.design.repeat === 'ONE_OFF');
    if (plain && plain.stress.exposure === transfer.stress.exposure && plain.targetsMet.length === transfer.targetsMet.length) {
      expect(built.indexOf(transfer)).toBeLessThan(built.indexOf(plain));
    }
  });

  it('rejects a design whose known worst case exceeds the money the goal may tie up, and keeps its presold revision', async () => {
    // Two deals for these buyers each tied up thousands before money came in.
    for (const [i, peak] of [400_000, 600_000].entries()) {
      await opening({ title: `Event equipment hire ${i}`, priceCents: 90_000, mechanism: 'PRODUCTIZED_SERVICE', payer: 'Wedding planners', industry: 'Events', peakCents: peak });
    }
    await sector('Events', { buyer: 'Wedding planners', bottleneck: 'Last-minute furniture shortfalls', supply: 'Party rental yards' });
    const id = await goal(1_000_000, { capitalCents: 300_000, beforeProofCents: 30_000 });
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 30, limits: goalLimits(reading), now });
    const planners = built.filter((one) => one.demand.name === 'Wedding planners');
    const margin = planners.find((one) => one.structure === 'SUBCONTRACT' && one.design.funding === 'ON_DELIVERY' && one.design.aggregation === 'SINGLE')!;
    expect(margin.stress.exposure).toBe('EXCEEDS');
    expect(margin.stress.worstCaseCents).toBeGreaterThan(30_000);
    const revised = planners.find((one) => one.structure === 'SUBCONTRACT' && one.design.funding === 'THRESHOLD_PRESALE')!;
    expect(revised.stress.exposure).toBe('SAFE');
    // The goal tick never asks about the rejected design.
    const opened = await askConstructedArrangements((await getWorkstream(id))!, reading, now, 20, 20);
    const statements = await Promise.all(opened.map(async (c) => (await getCandidate(c))!.statement));
    expect(statements.some((s) => s.includes('Wedding planners') && /own the buyer, pay a supplier to deliver, and keep the margin\. /.test(s))).toBe(false);
  });

  it('writes every question in words the research envelopes accept as research rather than action', async () => {
    await sector('Commercial kitchens', { buyer: 'Independent restaurants', bottleneck: 'Hood and duct cleaning compliance', supply: 'Certified hood cleaning crews' });
    const limits = { daysLeft: 25, remainingCents: 1_000_000, capitalCeilingCents: 300_000, capitalBeforeProofCents: 30_000, bestReachCents: 0 };
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 300_000, daysLeft: 25, limits, now });
    const cash = Object.entries(APPROVAL_ENVELOPES).filter(([id]) => id.startsWith('RUSSELL_CASH')).map(([, e]) => e);
    expect(cash.length).toBeGreaterThan(0);
    for (const one of built) for (const envelope of cash) expect(describesOwnAction(one.question, envelope.forbiddenActions)).toBe(false);
  });
});

describe('what the goal’s owner left out', () => {
  it('reads an exclusion only where a negator governs it', () => {
    expect(exclusionsIn('Avoid government/federal contracts and broken-website plays for this goal.')).toEqual(['GOVERNMENT_CONTRACTING', 'WEBSITE_REPAIR']);
    expect(exclusionsIn('No federal work.')).toEqual(['GOVERNMENT_CONTRACTING']);
    expect(exclusionsIn('Subcontract work that government buyers pay for.')).toEqual([]);
    expect(excludedBy('Market: US federal procurement (SAM.gov) solicitation', ['GOVERNMENT_CONTRACTING'])).toBe('GOVERNMENT_CONTRACTING');
    expect(excludedBy('Fix the broken website of a dental practice', ['WEBSITE_REPAIR'])).toBe('WEBSITE_REPAIR');
    expect(excludedBy('Independent restaurants', ['GOVERNMENT_CONTRACTING', 'WEBSITE_REPAIR'])).toBeNull();
  });

  it('leaves excluded openings out of the plan and excluded parts out of construction, from the sprint’s own additions', async () => {
    await sector('Public procurement', { buyer: 'Federal agencies', bottleneck: 'Document scanning backlogs', supply: 'Records scanning vendors' });
    await sector('Commercial kitchens', { buyer: 'Independent restaurants', bottleneck: 'Hood and duct cleaning compliance', supply: 'Certified hood cleaning crews' });
    const federal = await opening({ title: 'Market: US federal procurement (SAM.gov). Records scanning RFQ', priceCents: 900_000, payer: 'A federal agency' });
    expect((await setConstraints({ projectId, actorUserId: userId, constraints: 'Avoid government and federal contracts and broken-website plays.' })).ok).toBe(true);
    const id = await goal(1_000_000, { capitalCents: 300_000, beforeProofCents: 30_000 });
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.excluded.find((one) => one.opportunityId === federal.id)!.reason).toMatch(/left out by the goal: government/);
    const opened = await askConstructedArrangements((await getWorkstream(id))!, reading, now, 20, 20);
    const statements = await Promise.all(opened.map(async (c) => (await getCandidate(c))!.statement));
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((s) => s.includes('Federal agencies'))).toBe(false);
    expect(statements.every((s) => /Leave out government and public-sector contracts and broken-website and website-repair plays/.test(s))).toBe(true);
  });
});

describe('the live goal: a structurally new arrangement becomes an opening and moves the plan', () => {
  it('opens a reverse round when the map is sparse, and its gated answer becomes an opening the plan reads', async () => {
    // One buyer population on the map — the production shape that confined construction to one corner.
    await sector('Animation', { buyer: 'Production committees', bottleneck: 'Licensing paperwork', supply: 'Licensing agents' });
    const id = await goal(1_000_000, { days: 25, capitalCents: 300_000, beforeProofCents: 30_000 });
    const w = (await getWorkstream(id))!;
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.pool.conclusion).not.toBe('POOL_COULD_REACH');
    const opened = await askConstructedArrangements(w, reading, now, 3, 2 * MAX_LIVE_GOAL_ROUNDS);
    expect(opened.length).toBeGreaterThanOrEqual(2);
    const candidates = await Promise.all(opened.map((c) => getCandidate(c)));
    // The map's one population is asked once; the rest of the pass goes to designs the goal needs.
    const reverse = candidates.find((c) => /starting from the economics the goal needs/.test(c!.statement))!;
    expect(reverse).toBeDefined();
    expect(candidates.filter((c) => c!.statement.includes('Production committees')).length).toBeLessThanOrEqual(1);
    const rounds = (await listRounds(projectId)).filter((r) => r.bucketId.startsWith(`goal-${id}-mx-`));
    expect(rounds.length).toBe(opened.length);

    // The world answers through the ordinary gate: a repeating buyer pattern nobody named.
    await finishedMission(reverse.id, [
      { claim: 'Neighbourhood associations publish group bookings for gutter cleaning each autumn, $120 per home, paid upfront once 20 homes sign up.', signal: 'RECURRING_OUTSOURCED_WORK', sourceUrl: 'https://example.test/gutter-group' },
    ]);
    const filed = await harvest({ projectId });
    expect(filed).toHaveLength(1);
    const o = (await getOpportunity(filed[0]!.opportunity.id))!;
    expect(o.discoveredByCandidateId).toBe(reverse.id);

    const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: filed[0]!.claimId, decidedBy: 'BRAIN' });
    await fact(CAPTURE_KEY, 'Presell a shared gutter-cleaning run to each association, pay the crew from the prepayments.');
    await fact('payer', 'Neighbourhood associations');
    await fact('price', '$120');
    await fact('timeToFirstCash', '5 days');
    await fact('directCosts', '$70');
    await fact('buyerVolume', 'The county lists 300 neighbourhood associations; each books once a season.');
    await updateOpportunity(o.id, { payer: 'Neighbourhood associations', price_cents: 12_000, offer_scope: 'One home in a shared autumn gutter run', reachable_channel: 'Published association emails', buying_signal: 'Posted group booking', signal_observed_at: inDays(-3), peak_funding_cents: 0, human_hours: 1, fulfillment_owner: 'Local gutter crews' });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'fulfillment', kind: 'EVIDENCE', value: 'Local gutter crews', claimId: filed[0]!.claimId, decidedBy: 'BRAIN' });
    const after = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    const considered = after.considered.find((c) => c.opportunityId === o.id)!;
    expect(considered).toBeDefined();
    expect(considered.volumeEstablished).toBe(true);
    // A new mechanism moved the goal: more is reachable than before.
    expect(after.bestReach ?? 0).toBeGreaterThan(reading.bestReach ?? 0);
  });
});
