/**
 * F1–F3 of the 2026-11-15 adversarial review: capabilities that passed on
 * hand-inserted fixtures and were inert on the rows production writes.
 *
 * - F1: a precedent is read from what the deep dive actually writes — a gated
 *   payer and a gated price (EVIDENCE), or a buyer's payment — never from a
 *   captureMechanism EVIDENCE fact no production path writes, and never from
 *   Brain's own RECOMMENDATION alone.
 * - F2: an OBSERVED construction fact about a map buyer reaches the value of
 *   an arrangement whose buyers are exactly those.
 * - F3: buyer names match after normalisation, the map question asks for unit
 *   economics where a subject's buyers are unpriced, and a bounded idempotent
 *   back-fill files facts from claims research already holds.
 *
 * Every card fact here is written by `applyValidationAnswers` and
 * `proposeEngineTerms` from gated claims, exactly as production writes them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims, updateFragment } from '../server/repos/research.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { listProjectConstructionFacts, recordClaimFact } from '../server/repos/construction.ts';
import { applyValidationAnswers, proposeEngineTerms } from '../server/services/cash/validation.ts';
import { clearConstructionMemo, constructArrangements, heldPrecedents, shownWorkingIn } from '../server/services/cash/construct.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { runIndustryKernel, resetBackfillIdle } from '../server/services/industry/kernel.ts';
import { backfillClaimFacts, unpricedBuyersUnder } from '../server/services/industry/expand.ts';
import { transferOfBucket } from '../server/services/industry/transfer.ts';
import { mapQuestion } from '../server/services/industry/questions.ts';
import { listNodes } from '../server/repos/industry.ts';
import { buyerNameKey, matchBuyerType } from '../server/domain/industry.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import type { CashMechanism, ClaimType, EvidenceLane, Layer } from '../server/domain/types.ts';

const DIVE_LANES: EvidenceLane[] = profileFor('RUSSELL_CASH_VALIDATION_V1')!.lanes;

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`precedent-${Math.random().toString(36).slice(2, 8)}`, projectId]);
  const owner = await createUser({ email: `p-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  ownerId = owner.id;
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
  clearConstructionMemo();
  resetBackfillIdle();
});

interface ClaimSpec {
  lane: string;
  text: string;
  type?: ClaimType;
}

/** A finished deep dive whose gated claims are filed in the named lanes, as a worker submits them. */
async function dive(key: string, claims: ClaimSpec[]): Promise<{ candidateId: string; claimIds: string[] }> {
  const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: `Qualify: ${key}`, statement: key });
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: key });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: `Qualify: ${key}`, assignment: key, provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'opening-validation',
      question: 'Who pays, at what price, and what rules it out?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: DIVE_LANES, acceptableSourceTypes: ['a published price list'], excludedSourceTypes: ['blog'], completionCriteria: ['A named payer.'],
      dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    },
  ]);
  await updateFragment(fragment!.id, { status: 'BLOCKED' });
  const inserted = await insertClaims(
    claims.map((spec) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
      claim: spec.text, claimType: spec.type ?? 'SOURCED_FACT', sourceUrl: 'https://example.org/price-list', sourceTitle: 'Published price list',
      sourcePublisher: 'A trade association', sourceDate: '2026-09-01', evidenceExcerpt: spec.text, evidenceLocator: 'p. 2', evidenceLane: spec.lane,
      retrievedAt: '2026-10-07T12:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `${key}:${spec.lane}:${spec.text}`,
    })),
  );
  const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: key, whyNow: 'test', idempotencyKey: `dive:${key}`, candidateId: candidate.id });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'FAILED', terminalReason: 'x' });
  return { candidateId: candidate.id, claimIds: inserted.map((c) => c.id) };
}

/** An opening whose dive settled, as the validation lane leaves it. */
async function opening(round: { candidateId: string }, title: string, mechanism: CashMechanism = 'SUBCONTRACTED_FULFILMENT', industry = 'Dentistry'): Promise<string> {
  const made = await createOpportunity({ projectId, cashModeId: modeId, ownerUserId: ownerId, title, mechanism, currency: 'USD', requiredCapabilities: [], sourceClaimId: null, source: 'A publisher' });
  await recordCashEvent({ projectId, opportunityId: made.id, kind: 'CASH_VALIDATION_STARTED', actorRef: 'BRAIN', summary: 'started', detail: { candidateId: round.candidateId, round: 1 } });
  await updateOpportunity(made.id, { candidate_id: round.candidateId, validation_state: 'BLOCKED', validation_rounds: 1, industry, offer_scope: 'After-hours sterilisation audits' } as never);
  return made.id;
}

async function settle(): Promise<void> {
  await applyValidationAnswers(projectId);
  await proposeEngineTerms(projectId);
}

describe('F1: a precedent from the rows production writes', () => {
  it('a dive that established the payer and the price makes a precedent; the capture thesis on it is only Brain’s recommendation', async () => {
    const one = await dive('dental', [
      { lane: 'payer', text: 'Dental practices' },
      { lane: 'price_evidence', text: 'Dental practices pay contractors $350 per after-hours sterilisation audit.' },
    ]);
    const id = await opening(one, 'Dental practices outsource after-hours sterilisation audits to contractors');
    await settle();

    expect((await cardFact(id, 'payer'))?.kind).toBe('EVIDENCE');
    expect((await cardFact(id, 'revenueRange'))?.kind).toBe('EVIDENCE');
    // What production writes for the capture thesis: a recommendation, never evidence.
    expect((await cardFact(id, 'captureMechanism'))?.kind).toBe('RECOMMENDATION');

    const shown = await shownWorkingIn(projectId);
    expect(shown.has(id)).toBe(true);
    const held = heldPrecedents([(await getOpportunity(id))!], shown);
    expect(held.get('SUBCONTRACT')?.id).toBe(id);

    // And the standing kernel, with no live goal, asks to carry it to a different population.
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: ownerId, reason: 'the sprint is over' });
    await createGoal({ projectId, ownerUserId: ownerId, createdByUserId: ownerId, name: 'Standing research', allowedWork: ['RESEARCH'], maxMissions: 0, maxFragments: 0, maxConcurrent: 6, maxProbes: 0, workPolicy: 'UNCAPPED' });
    const kitchens = await seedSubject({ projectId, name: 'Commercial kitchens', actorRef: ownerId });
    const restaurants = await seedSubject({ projectId, name: 'Independent restaurants', kind: 'BUYER_TYPE', parentId: kitchens.node.id, actorRef: ownerId });
    const pass = await runIndustryKernel(projectId);
    expect(pass.failures ?? []).toEqual([]);
    const opened = pass.opened.find((round) => transferOfBucket(round.bucketId) !== null);
    expect(opened?.nodeId).toBe(restaurants.node.id);
    expect(transferOfBucket(opened!.bucketId)).toMatchObject({ precedentId: id, design: { base: 'SUBCONTRACT' } });
  });

  it('a payer with no price is not a precedent, though Brain still proposed a capture thesis for it', async () => {
    const one = await dive('payer-only', [{ lane: 'payer', text: 'Dental practices' }]);
    const id = await opening(one, 'Dental practices outsource audits');
    await settle();
    expect((await cardFact(id, 'payer'))?.kind).toBe('EVIDENCE');
    expect((await cardFact(id, 'captureMechanism'))?.kind).toBe('RECOMMENDATION');
    expect((await shownWorkingIn(projectId)).has(id)).toBe(false);
  });

  it('a price with no established payer is not a precedent', async () => {
    const one = await dive('price-only', [{ lane: 'price_evidence', text: 'Audits are quoted at $350 each.' }]);
    const id = await opening(one, 'Audits are outsourced');
    await settle();
    expect((await cardFact(id, 'revenueRange'))?.kind).toBe('EVIDENCE');
    expect((await shownWorkingIn(projectId)).has(id)).toBe(false);
  });

  it('a buyer’s payment shows the design working; a refunded one does not', async () => {
    const one = await dive('paid', [{ lane: 'payer', text: 'Dental practices' }]);
    const id = await opening(one, 'Dental practices paid for an audit');
    await settle();
    expect((await shownWorkingIn(projectId)).has(id)).toBe(false);
    await recordMoney({ projectId, opportunityId: id, kind: 'CUSTOMER_PAYMENT', amountCents: 35_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: 'pay-1', verifiedReference: 'bank-1' });
    expect((await shownWorkingIn(projectId)).has(id)).toBe(true);
    await recordMoney({ projectId, opportunityId: id, kind: 'REFUND', amountCents: 35_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: 'refund-1' });
    expect((await shownWorkingIn(projectId)).has(id)).toBe(false);
  });
});

describe('F2: an observed construction fact prices the arrangement for its own buyers', () => {
  it('reaches the value of an arrangement whose buyers it is about, and of no other', async () => {
    const kitchens = await seedSubject({ projectId, name: 'Commercial kitchens', actorRef: ownerId });
    const restaurants = await seedSubject({ projectId, name: 'Independent restaurants', kind: 'BUYER_TYPE', parentId: kitchens.node.id, actorRef: ownerId });
    await seedSubject({ projectId, name: 'Hotel kitchens', kind: 'BUYER_TYPE', parentId: kitchens.node.id, actorRef: ownerId });
    await seedSubject({ projectId, name: 'Grease trap cleaning', kind: 'BOTTLENECK', parentId: kitchens.node.id, actorRef: ownerId });
    await seedSubject({ projectId, name: 'Licensed grease haulers', kind: 'FULFILMENT_SOURCE', parentId: kitchens.node.id, actorRef: ownerId });
    const base = { projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30 };
    const before = await constructArrangements(base);
    const ownBefore = before.filter((one) => one.demand.name === 'Independent restaurants' && one.origin !== 'REVERSE');
    expect(ownBefore.length).toBeGreaterThan(0);
    expect(ownBefore.every((one) => one.value.tier === 'UNKNOWN')).toBe(true);

    // An assumption is not evidence of what they pay.
    await recordClaimFact({ projectId, nodeId: restaurants.node.id, claimId: 'clm_guess', key: 'price_per_unit', segment: `map_${restaurants.node.id}`, low: 900, high: 900, status: 'ASSUMPTION', measures: 'a forecast', sourceTitle: 'x', sourceUrl: 'https://example.org/x', sourceKind: 'SECONDARY', observedAt: '2026-10-01T00:00:00.000Z' });
    clearConstructionMemo();
    expect((await constructArrangements(base)).filter((one) => one.demand.name === 'Independent restaurants' && one.origin !== 'REVERSE').every((one) => one.value.tier === 'UNKNOWN')).toBe(true);

    await recordClaimFact({ projectId, nodeId: restaurants.node.id, claimId: 'clm_seen', key: 'price_per_unit', segment: `map_${restaurants.node.id}`, low: 280, high: 420, status: 'OBSERVED', measures: 'restaurants pay $280–$420 per trap cleaning', sourceTitle: 'Price survey', sourceUrl: 'https://example.org/survey', sourceKind: 'PRIMARY', observedAt: '2026-10-01T00:00:00.000Z' });
    clearConstructionMemo();
    const after = await constructArrangements(base);
    const own = after.filter((one) => one.demand.name === 'Independent restaurants' && one.origin !== 'REVERSE');
    expect(own.some((one) => one.value.tier !== 'UNKNOWN' && one.value.observations >= 1 && one.value.p50 > 100 && one.value.p50 < 1000)).toBe(true);
    // Never pooled onto another population.
    expect(after.filter((one) => one.demand.name === 'Hotel kitchens' && one.origin !== 'REVERSE').every((one) => one.value.tier === 'UNKNOWN')).toBe(true);
  }, 90_000); // ~12 s alone (composes the full arrangement library); CI shard load pushed it past the 30 s default on Deploy 44247254003.
});

describe('F3: facts are asked for, matched and back-filed', () => {
  it('matches a buyer name after normalisation, and never a qualified population', async () => {
    expect(buyerNameKey('The Independent Restaurants')).toBe(buyerNameKey('independent restaurant'));
    expect(buyerNameKey('Dental practices')).toBe(buyerNameKey('dental practice'));
    expect(buyerNameKey('Chain restaurants')).not.toBe(buyerNameKey('Restaurants'));
    const root = await seedSubject({ projectId, name: 'Food service', actorRef: ownerId });
    const node = await seedSubject({ projectId, name: 'Independent restaurant', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    const nodes = await listNodes(projectId);
    expect(matchBuyerType('The independent restaurants', nodes)?.id).toBe(node.node.id);
    expect(matchBuyerType('Chain restaurants', nodes)).toBeNull();
  });

  it('the map question asks for unit economics where the subject’s buyers are unpriced, and stops once they are', async () => {
    const root = await seedSubject({ projectId, name: 'Food service', actorRef: ownerId });
    const buyer = await seedSubject({ projectId, name: 'Independent restaurants', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    const byId = new Map((await listNodes(projectId)).map((one) => [one.id, one]));
    const unpriced = unpricedBuyersUnder(root.node.id, byId, new Set());
    expect(unpriced).toEqual(['Independent restaurants']);
    const asked = mapQuestion({ path: ['Food service'], objective: null, round: 1, childrenSoFar: 1, unpricedBuyers: unpriced });
    expect(asked).toContain('UNIT_ECONOMIC');
    expect(asked).toContain('price_per_unit');
    expect(asked).toContain('"Independent restaurants"');
    expect(unpricedBuyersUnder(root.node.id, byId, new Set([buyer.node.id]))).toBeNull();
    expect(mapQuestion({ path: ['Food service'], objective: null, round: 1, childrenSoFar: 1, unpricedBuyers: null })).not.toContain('UNIT_ECONOMIC');
  });

  it('back-fills a price a card holds as evidence for a mapped payer, once, with the claim as provenance — and the arrangement reads it', async () => {
    const one = await dive('restaurants', [
      { lane: 'payer', text: 'Independent Restaurants' },
      { lane: 'price_evidence', text: 'Independent restaurants pay $300 to $450 per grease trap cleaning.' },
    ]);
    const id = await opening(one, 'Restaurants outsource grease trap cleaning', 'SUBCONTRACTED_FULFILMENT', 'Food service');
    await settle();
    const price = (await cardFact(id, 'revenueRange'))!;
    expect(price.kind).toBe('EVIDENCE');
    const root = await seedSubject({ projectId, name: 'Food service', actorRef: ownerId });
    const node = await seedSubject({ projectId, name: 'independent restaurant', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    await seedSubject({ projectId, name: 'Grease trap cleaning', kind: 'BOTTLENECK', parentId: root.node.id, actorRef: ownerId });
    await seedSubject({ projectId, name: 'Licensed grease haulers', kind: 'FULFILMENT_SOURCE', parentId: root.node.id, actorRef: ownerId });

    const first = await backfillClaimFacts(projectId);
    expect(first.filed).toHaveLength(1);
    const fact = first.filed[0]!;
    expect(fact).toMatchObject({ key: 'price_per_unit', segment: `map_${node.node.id}`, status: 'OBSERVED', sourceClaimId: price.claimId, low: 300, high: 300 });
    expect(fact.validUntil).toBeTruthy();
    // Idempotent: a replay files nothing.
    expect((await backfillClaimFacts(projectId)).filed).toHaveLength(0);
    expect(await listProjectConstructionFacts(projectId)).toHaveLength(1);

    // F2 on the back-filled row: the arrangement for these buyers is priced from it.
    clearConstructionMemo();
    const arrangements = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30 });
    expect(arrangements.some((one) => one.demand.name === 'independent restaurant' && one.value.tier !== 'UNKNOWN')).toBe(true);
  });

  it('back-fills a declared UNIT_ECONOMIC claim from outside any kernel round, and bounds each pass', async () => {
    const root = await seedSubject({ projectId, name: 'Food service', actorRef: ownerId });
    const node = await seedSubject({ projectId, name: 'Independent restaurants', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'x' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'x', assignment: 'x', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([
      { orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'f', question: 'q', geography: null, timeframe: null, population: null, definitions: null, requiredEvidence: DIVE_LANES, acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: [], dependsOn: [], minIndependentSources: 1, status: 'QUEUED' },
    ]);
    await insertClaims(
      [0, 1, 2].map((i) => ({
        orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
        claim: `Restaurants pay $${300 + i} per cleaning (${i}).`, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/${i}`, sourceTitle: 'Survey',
        sourcePublisher: 'Assoc', sourceDate: '2026-09-01', evidenceExcerpt: 'x', evidenceLocator: 'x', evidenceLane: 'payer',
        retrievedAt: '2026-10-07T12:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
        sourced: true, accepted: true, rejectionReason: null, contentHash: `ue:${i}`,
        structuralFinding: 'UNIT_ECONOMIC' as const, structuralSubject: 'price_per_unit', structuralQualifier: i === 2 ? 'Hospitals' : 'independent restaurant', structuralAmountCents: (300 + i) * 100,
      })),
    );
    const first = await backfillClaimFacts(projectId, 1);
    expect(first.filed).toHaveLength(1);
    const second = await backfillClaimFacts(projectId, 5);
    expect(second.filed).toHaveLength(1);
    // The third names a buyer the map does not hold: left for a later pass, not filed.
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(2);
    expect(facts.every((one) => one.segment === `map_${node.node.id}` && one.status === 'OBSERVED')).toBe(true);
    expect((await backfillClaimFacts(projectId, 5)).filed).toHaveLength(0);
  });
});
