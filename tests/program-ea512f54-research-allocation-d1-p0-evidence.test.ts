/**
 * RES-15-4 (S-0150), repair F3: per-position evidence is a row, not question text.
 *
 * The finding this pins untrue: "S-0150's per-position evidence … is only requested in
 * question text. No harvest, claim lane or row stores it per constructed position, so a
 * probe reading production records has nothing to read, and the 'public asking price or
 * market size only → separately investigate access and conversion' rule is never applied
 * to real harvested findings."
 *
 * So this drives a real harvest of an intermediation-bucket claim through the real
 * repositories, reads the `CASH_POSITION_EVIDENCE` row it wrote, moves the opening's
 * evidence and reads the next reading, and checks the narrow-source rule reaches the
 * full dive's question.
 */
import type { CashOpportunity, Layer, OpportunitySignal } from '../server/domain/types.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { cashEventsOfKind, cashEventsOfKindInProject, getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordEvidenceFact } from '../server/repos/cashCardFacts.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { GOAL_BUCKET_PREFIX, harvest, openDiscovery, SEARCH_BUCKETS, SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { isIntermediationBucket } from '../server/services/cash/intermediationBuckets.ts';
import { EVIDENCE_FIELD_KEYS, POSITION_KEYS } from '../server/services/cash/intermediationPositions.ts';
import {
  claimBasis,
  GOAL_ROUND_PREFIX,
  latestPositionEvidence,
  owesPositionEvidence,
  POSITION_EVIDENCE_EVENT,
  positionsNamed,
  readPositionEvidence,
  recordPositionEvidence,
  refreshPositionEvidence,
  separateInvestigationsSentence,
  type PositionEvidence,
} from '../server/services/cash/positionEvidence.ts';

const RECENT_SOURCE_DATE = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (
    await createUser({
      email: `posev-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

async function activated(): Promise<void> {
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' })).ok).toBe(true);
}

/** A finished mission for one opened round, carrying one accepted signalled claim. */
async function finishedMission(candidateId: string, claim: { text: string; signal: OpportunitySignal; url: string }): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a bucket' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a bucket', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'any',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a listing'],
      excludedSourceTypes: [],
      completionCriteria: ['one dated source'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'cash-discovery',
      question: 'Where could a transaction be held from an intermediary position?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [inserted] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: claim.text,
      sourceUrl: claim.url,
      sourceTitle: 'A listing',
      sourcePublisher: 'A publisher',
      sourceDate: RECENT_SOURCE_DATE,
      evidenceExcerpt: claim.text,
      evidenceLocator: 'the body',
      evidenceLane: SIGNAL_LANE,
      opportunitySignal: claim.signal,
      closesOn: null,
      retrievedAt: RECENT_SOURCE_DATE,
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${claim.text}|${claim.url}`,
    },
  ]);
  await decideClaim(inserted!.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a bucket', whyNow: 'active', idempotencyKey: `mission:${orchestration.id}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

async function openIntermediationRound(): Promise<{ bucketId: string; candidateId: string }> {
  const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length });
  const one = opened.find((round) => isIntermediationBucket({ id: round.bucketId }));
  expect(one, 'an intermediation entry bucket opens').toBeDefined();
  return one!;
}

const opening = (over: Partial<CashOpportunity> = {}): CashOpportunity =>
  ({
    id: 'cop_x',
    projectId: 'p',
    currency: 'USD',
    payer: null,
    reachableChannel: null,
    buyingSignal: null,
    offerScope: null,
    priceCents: null,
    fulfillmentOwner: null,
    deliveryMethod: null,
    economicsNote: null,
    paymentTerms: null,
    peakFundingCents: null,
    opportunitySignal: null,
    sourceClaimId: null,
    ...over,
  }) as CashOpportunity;

describe('which openings owe per-position evidence', () => {
  it('is every intermediation entry bucket and every constructed arrangement round, and nothing else', () => {
    expect(GOAL_ROUND_PREFIX).toBe(GOAL_BUCKET_PREFIX);
    for (const bucket of SEARCH_BUCKETS.filter((one) => isIntermediationBucket(one))) expect(owesPositionEvidence(bucket.id)).toBe(true);
    expect(owesPositionEvidence(`${GOAL_BUCKET_PREFIX}wks_1-mx-abc123`)).toBe(true);
    expect(owesPositionEvidence(`${GOAL_BUCKET_PREFIX}wks_1`)).toBe(false);
    expect(owesPositionEvidence('explicit-paid-requests')).toBe(false);
    expect(owesPositionEvidence(null)).toBe(false);
  });
});

describe('reading a finding (pure)', () => {
  it('reads an asking price or a market size as exactly that, whatever signal was set', () => {
    expect(claimBasis({ signal: 'SUPPLY_DEMAND_MISMATCH', claim: 'The US commercial cleaning market is worth $90 billion.' })).toEqual(['TOTAL_MARKET_SIZE']);
    expect(claimBasis({ signal: 'RESALABLE_ASSET_OPENING', claim: 'A used excavator is listed at $42,000.' })).toEqual(['PUBLIC_ASKING_PRICE']);
    expect(claimBasis({ signal: 'ACTIVE_BUYER_DEMAND', claim: 'A school district posted an RFQ for janitorial services.' })).toEqual(['BUYER_INQUIRY']);
  });

  it('names the positions a finding states, and examines every catalogued one when it states none', () => {
    expect(positionsNamed('Freight brokers keep 15% and lead suppliers sell inquiries')).toEqual(expect.arrayContaining(['BROKER', 'LEAD_SUPPLIER']));
    const none = readPositionEvidence({ opportunity: opening(), facts: [], bucketId: 'intermediation-pricing-spreads', claim: { id: 'c1', claim: 'Pallets are priced at $12 retail.', signal: 'PRICING_OR_INFORMATION_ASYMMETRY' } });
    expect(none.positions.map((one) => one.catalogued)).toEqual(POSITION_KEYS);
    expect(none.entry).toMatchObject({ end: 'SUPPLY_FIRST', entryPoint: 'pricing spreads' });
  });

  it('applies the narrow-source rule per position, and closes only the gap later evidence closes', () => {
    const claim = { id: 'c1', claim: 'Distributors list the unit at an asking price of $1,200.', signal: 'RESALABLE_ASSET_OPENING' as const };
    const narrow = readPositionEvidence({ opportunity: opening({ buyingSignal: claim.claim }), facts: [], bucketId: null, claim });
    expect(narrow.narrow).toBe(true);
    expect(narrow.chosen).toEqual(['distributor']);
    expect(narrow.fields.demand).toBeUndefined();
    expect(narrow.positions[0]!.gaps).toEqual(expect.arrayContaining(['BUYER_ACCESS', 'CONVERSION', 'payer', 'channel']));
    expect(narrow.positions[0]!.separateInvestigations).toHaveLength(2);
    const reached = readPositionEvidence({ opportunity: opening({ buyingSignal: claim.claim, payer: 'Regional hardware chains', reachableChannel: 'their published vendor-onboarding portal' }), facts: [], bucketId: null, claim });
    expect(reached.positions[0]!.gaps).not.toContain('BUYER_ACCESS');
    expect(reached.positions[0]!.gaps).toContain('CONVERSION');
    expect(separateInvestigationsSentence(reached)).toContain('conversion');
    expect(separateInvestigationsSentence(reached)).not.toContain('buyer access');
    const demand = readPositionEvidence({ opportunity: opening({ buyingSignal: 'A buyer asked for 40 units.' }), facts: [], bucketId: null, claim: { id: 'c2', claim: 'A buyer asked for 40 units.', signal: 'ACTIVE_BUYER_DEMAND' } });
    expect(demand.narrow).toBe(false);
    expect(demand.fields.demand).toMatchObject({ from: 'OPENING', claimId: 'c2' });
    expect(separateInvestigationsSentence(demand)).toBe('');
  });
});

describe('a real harvested intermediation finding writes per-position evidence (S-0150)', () => {
  it('records a row per harvested opening, applies the narrow rule to it, and re-reads it when the opening’s evidence moves', async () => {
    await activated();
    const round = await openIntermediationRound();
    await finishedMission(round.candidateId, {
      text: 'A wholesaler lists pallets of surplus packaging at an asking price of $1,800, for resellers.',
      signal: 'RESALABLE_ASSET_OPENING',
      url: 'https://example.test/listing/surplus',
    });
    const [made] = await harvest({ projectId });
    expect(made).toBeDefined();
    const id = made!.opportunity.id;

    const rows = await cashEventsOfKind(id, POSITION_EVIDENCE_EVENT);
    expect(rows).toHaveLength(1);
    const first = rows[0]!.detail as unknown as PositionEvidence;
    expect(first.bucketId).toBe(round.bucketId);
    expect(first.sourceClaimId).toBe(made!.claimId);
    expect(first.narrow).toBe(true);
    expect(first.bases).toEqual(['PUBLIC_ASKING_PRICE']);
    expect(first.chosen).toEqual(['reseller']);
    expect(first.entry).not.toBeNull();
    const reseller = first.positions.find((one) => one.catalogued === 'RESELLER')!;
    for (const field of EVIDENCE_FIELD_KEYS.filter((one) => one !== 'uncertainties' && one !== 'nextAction')) expect(reseller.gaps).toContain(field);
    expect(reseller.gaps).toEqual(expect.arrayContaining(['BUYER_ACCESS', 'CONVERSION']));
    expect((await latestPositionEvidence(projectId)).get(id)?.fingerprint).toBe(first.fingerprint);

    // A replay writes nothing: the latest reading already says this.
    expect(await refreshPositionEvidence(projectId, (await getOpportunity(id))!)).toBeNull();
    expect(await cashEventsOfKind(id, POSITION_EVIDENCE_EVENT)).toHaveLength(1);

    // Research names the payer and the channel; a new reading is appended and the old one kept.
    await recordEvidenceFact({ projectId, opportunityId: id, field: 'payer', value: 'Independent packaging resellers', claimId: made!.claimId });
    await updateOpportunity(id, { reachable_channel: 'the wholesaler’s published reseller sign-up form' });
    const second = await refreshPositionEvidence(projectId, (await getOpportunity(id))!);
    expect(second).not.toBeNull();
    expect(second!.fields.payer).toMatchObject({ from: 'CARD_FACT', claimId: made!.claimId });
    expect(second!.positions[0]!.gaps).not.toContain('BUYER_ACCESS');
    expect(second!.positions[0]!.gaps).toContain('CONVERSION');
    const history = await cashEventsOfKind(id, POSITION_EVIDENCE_EVENT);
    expect(history).toHaveLength(2);
    expect((history[0]!.detail as unknown as PositionEvidence).fingerprint).toBe(first.fingerprint);
  });

  it('writes nothing for an opening outside the contract, and refreshing it stays a no-op', async () => {
    await activated();
    const mode = (await getCashMode(projectId))!;
    const o = await createOpportunity({ projectId, cashModeId: mode.id, ownerUserId: userId, title: 'Hand-entered', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: null, source: 'a person' });
    expect(await refreshPositionEvidence(projectId, o)).toBeNull();
    expect(await cashEventsOfKindInProject(projectId, POSITION_EVIDENCE_EVENT)).toEqual([]);
    const written = await recordPositionEvidence({ projectId, opportunity: o, bucketId: 'intermediation-direct-inquiries', claim: null, discovered: ['allocation trader'] });
    expect(written!.positions.at(-1)!.position).toBe('allocation trader');
    expect(written!.positions.at(-1)!.catalogued).toBeNull();
  });
});
