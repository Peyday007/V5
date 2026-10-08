/**
 * Brain selects an opening because somebody is shown paying us and the
 * published figures leave something — not because enough fields are filled.
 *
 * Production, 2026-10-08: 24 of 40 openings read CANDIDATE, among them
 * GoTranscript, WriterAccess, Verblio and Depositphotos price lists, two
 * domain appraisals and seven resale listings. The audit found four
 * mechanisms, each reproduced here and each run against the old behaviour:
 *
 *   1. a documented absence ("No payer was found", "no sale price was found")
 *      filed as the field it found nothing for, and counted as answered;
 *   2. a capture thesis composed from any payer sentence — a vendor's own
 *      customers included — and the offer template;
 *   3. a price asymmetry or a resale counted as a transaction before anybody
 *      established that it could be bought now or sold at the higher figure;
 *   4. QUALIFIED reached on a field count, whatever the figures leave.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { cashEventsOfKind, recordCashEvent } from '../server/repos/cashMode.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  getClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { cardFact, cardFactsFor, recordCardFact } from '../server/repos/cashCardFacts.ts';
import {
  applyValidationAnswers,
  proposeEngineTerms,
  withdrawUnsupportedFacts,
} from '../server/services/cash/validation.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashTier, type TierReading } from '../server/services/cash/tier.ts';
import type {
  ClaimType,
  FragmentStatus,
  Layer,
  MissionState,
  OpportunitySignal,
} from '../server/domain/types.ts';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({
    email: 'transfer@example.com',
    displayName: 'Peyton',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  ownerId = owner.id;
  const started = await activate({
    projectId,
    ownerUserId: owner.id,
    actorUserId: owner.id,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  if (!started.ok) throw new Error('could not activate');
  modeId = started.mode.id;
});

interface ClaimSpec {
  lane: string;
  text: string;
  accepted?: boolean;
  sourceUrl?: string | null;
  claimType?: ClaimType;
}

/** One dive: an idea, its finished mission, its packet, one fragment and its claims. */
async function dive(input: {
  key: string;
  mission: MissionState;
  fragment: FragmentStatus;
  claims: ClaimSpec[];
}): Promise<{ candidateId: string; orchestrationId: string; claimIds: string[] }> {
  const candidate = await createCandidate({
    projectId,
    visibility: 'SHARED',
    title: `Qualify: ${input.key}`,
    statement: input.key,
  });
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: input.key,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: `Qualify: ${input.key}`,
    assignment: input.key,
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'opening-validation',
      question: 'Who pays, what it pays, when, and what rules it out?',
      geography: 'United States',
      timeframe: 'as at 2026',
      population: null,
      definitions: null,
      requiredEvidence: [{ id: 'payer', description: 'a named payer', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the published request'],
      excludedSourceTypes: ['blog'],
      completionCriteria: ['A named payer.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
    },
  ]);
  await updateFragment(fragment!.id, { status: input.fragment });
  const claims = await insertClaims(
    input.claims.map((spec) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'TARGETED' as const,
      claim: spec.text,
      sourceUrl: spec.sourceUrl === undefined ? 'https://www.nj.gov/health/bids/' : spec.sourceUrl,
      sourceTitle: 'Bidding Opportunities',
      sourcePublisher: 'NJ Department of Health',
      sourceDate: '2026-09-11',
      evidenceExcerpt: spec.text,
      evidenceLocator: 'RFQ #09-11-26-39DPA',
      evidenceLane: spec.lane,
      retrievedAt: '2026-10-07T12:00:00.000Z',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: spec.sourceUrl !== null,
      accepted: spec.accepted ?? true,
      rejectionReason: spec.accepted === false ? 'The source does not support it.' : null,
      contentHash: `${input.key}:${spec.lane}:${spec.text}`,
      claimType: spec.claimType ?? 'SOURCED_FACT',
    })),
  );
  const { mission } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: input.key,
    whyNow: 'test',
    idempotencyKey: `dive:${input.key}`,
    candidateId: candidate.id,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  if (input.mission !== 'PLANNED') {
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: input.mission,
      terminalReason: 'x',
      waitingOn: input.mission === 'NEEDS_HUMAN' ? 'a person' : null,
    });
  }
  return { candidateId: candidate.id, orchestrationId: orchestration.id, claimIds: claims.map((c) => c.id) };
}

/** An opening whose rounds are the given dives, the last one current. */
async function opening(
  rounds: { candidateId: string; orchestrationId: string }[],
  current: { state: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'BLOCKED'; orchestrationId: string | null },
  signal: OpportunitySignal = 'ACTIVE_BUYER_DEMAND',
  title = 'Market: New Jersey state government procurement (NJ Department of Health).',
): Promise<string> {
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    opportunitySignal: signal,
  });
  for (const [index, round] of rounds.entries()) {
    await recordCashEvent({
      projectId,
      opportunityId: made.id,
      kind: 'CASH_VALIDATION_STARTED',
      actorRef: 'BRAIN',
      summary: 'started',
      detail: { candidateId: round.candidateId, round: index + 1 },
    });
  }
  await updateOpportunity(made.id, {
    candidate_id: rounds[rounds.length - 1]!.candidateId,
    validation_state: current.state,
    validation_rounds: rounds.length,
    validation_orchestration_id: current.orchestrationId,
  });
  return made.id;
}


async function tierOf(id: string): Promise<TierReading> {
  const opportunity = (await getOpportunity(id))!;
  return cashTier({
    opportunity,
    card: cashEngineCard({ opportunity, facts: await cardFactsFor(id) }),
    readiness: evidenceCard(opportunity).readiness,
  });
}

/** One dive on one opening, its claims applied and its terms proposed, as the tick does. */
async function piece(input: {
  key: string;
  signal: OpportunitySignal;
  claims: ClaimSpec[];
  offer?: string;
}): Promise<{ id: string; claimIds: string[] }> {
  const round = await dive({ key: input.key, mission: 'FAILED', fragment: 'BLOCKED', claims: input.claims });
  const id = await opening([round], { state: 'BLOCKED', orchestrationId: round.orchestrationId }, input.signal, input.key);
  await updateOpportunity(id, { offer_scope: input.offer ?? `Deliver what ${input.key} names.` });
  await withdrawUnsupportedFacts(projectId);
  await applyValidationAnswers(projectId);
  await proposeEngineTerms(projectId);
  return { id, claimIds: round.claimIds };
}

const VENDOR_PRICE: ClaimSpec[] = [
  {
    lane: 'payer',
    text: "GoTranscript's billing terms name universities and research institutions as its customers.",
  },
  {
    lane: 'price_evidence',
    text: 'GoTranscript publishes $1.20 per minute at 5-day turnaround up to $2.75 per minute.',
  },
  {
    lane: 'effort',
    text: 'Contractor rates are listed at $0.40 to $0.60 per audio minute for general transcription.',
  },
];

describe('a capture thesis needs somebody established as paying us', () => {
  it('composes none for a vendor publishing its own prices, and the piece stays a signal', async () => {
    const { id } = await piece({ key: 'GoTranscript', signal: 'PRICING_OR_INFORMATION_ASYMMETRY', claims: VENDOR_PRICE });
    expect(await cardFact(id, 'captureMechanism')).toBeNull();
    const tier = await tierOf(id);
    expect(tier.tier).toBe('SIGNAL');
    expect(tier.toAdvance.map((one) => one.key)).toEqual(['acquisitionAccess', 'exitEvidence']);
    // Per-minute rates are rates, not a transaction: nothing is multiplied into one.
    expect(tier.economics.verdict).toBe('UNKNOWN');
    expect(tier.route).toBe('UNPROVEN');
  });

  it('stops counting a thesis already written over a vendor price list, and withdraws it with a record', async () => {
    const { id } = await piece({ key: 'Depositphotos', signal: 'PRICING_OR_INFORMATION_ASYMMETRY', claims: VENDOR_PRICE });
    // The shape production holds: a thesis Brain wrote before the rule existed.
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'captureMechanism',
      kind: 'RECOMMENDATION',
      value: 'Supply Deliver exactly what the published request asks for to its customers.',
      basis: 'b',
      assumptions: 'a',
      uncertainty: 'u',
      decidedBy: 'BRAIN',
    });
    expect((await tierOf(id)).tier).toBe('SIGNAL');
    expect(await withdrawUnsupportedFacts(projectId)).toContain(`${id}:captureMechanism`);
    expect(await cardFact(id, 'captureMechanism')).toBeNull();
    const events = await cashEventsOfKind(id, 'CASH_CARD_FACT_WITHDRAWN');
    expect(events).toHaveLength(1);
    expect(events[0]!.detail['value']).toContain('Supply Deliver');
    // Idempotent: nothing left to withdraw, nothing recorded twice.
    expect(await withdrawUnsupportedFacts(projectId)).toEqual([]);
    expect(await cashEventsOfKind(id, 'CASH_CARD_FACT_WITHDRAWN')).toHaveLength(1);
  });

  it('never reads "no payer was found" as the payer, and keeps the claim itself', async () => {
    const { id, claimIds } = await piece({
      key: 'no payer',
      signal: 'ACTIVE_BUYER_DEMAND',
      claims: [
        { lane: 'payer', text: 'No payer was found: the page names no buyer.', claimType: 'NEGATIVE_EXISTENCE' },
        { lane: 'disqualifier', text: 'No restriction excludes a supplier like us.', claimType: 'NEGATIVE_EXISTENCE' },
      ],
    });
    expect(await cardFact(id, 'payer')).toBeNull();
    expect(await cardFact(id, 'captureMechanism')).toBeNull();
    // A documented absence of a disqualifier *is* the answer.
    expect((await cardFact(id, 'disqualifiers'))!.claimId).toBe(claimIds[1]);
    // The evidence is untouched.
    expect((await getClaim(claimIds[0]!))!.accepted).toBe(true);
  });

  it('withdraws an absence already filed as an answer, and clears the column it wrote', async () => {
    const round = await dive({
      key: 'stale absence',
      mission: 'FAILED',
      fragment: 'BLOCKED',
      claims: [{ lane: 'payer', text: 'No payer is named anywhere.', claimType: 'NEGATIVE_EXISTENCE' }],
    });
    const id = await opening([round], { state: 'BLOCKED', orchestrationId: round.orchestrationId });
    // What the old application wrote: the fact and the column.
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'payer',
      kind: 'EVIDENCE',
      value: 'No payer is named anywhere.',
      claimId: round.claimIds[0],
      decidedBy: 'BRAIN',
    });
    await updateOpportunity(id, { payer: 'No payer is named anywhere.' });
    await withdrawUnsupportedFacts(projectId);
    expect(await cardFact(id, 'payer')).toBeNull();
    expect((await getOpportunity(id))!.payer).toBeNull();
    expect((await getClaim(round.claimIds[0]!))!.accepted).toBe(true);
  });

  it('keeps a person’s payer answer whatever the claim behind the evidence says', async () => {
    const { id } = await piece({ key: 'person payer', signal: 'ACTIVE_BUYER_DEMAND', claims: [] });
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'payer',
      kind: 'PERSON',
      value: 'The county clerk, who called us.',
      decidedBy: ownerId,
    });
    await withdrawUnsupportedFacts(projectId);
    expect((await cardFact(id, 'payer'))!.kind).toBe('PERSON');
  });

  it('keeps a legitimate buyer’s opening a candidate', async () => {
    const { id } = await piece({
      key: 'NJDOH RFQ',
      signal: 'ACTIVE_BUYER_DEMAND',
      claims: [{ lane: 'payer', text: 'NJDOH issued RFQ #09-11-26-39DPA and pays the awarded vendor by EFT.' }],
    });
    const thesis = (await cardFact(id, 'captureMechanism'))!;
    expect(thesis.kind).toBe('RECOMMENDATION');
    expect((await tierOf(id)).tier).toBe('CANDIDATE');
  });
});

describe('a resale is a transaction only once it can be bought now and sold after fees', () => {
  it('is speculation on an appraisal with no sale anywhere', async () => {
    const { id } = await piece({
      key: 'dujo.com',
      signal: 'RESALABLE_ASSET_OPENING',
      claims: [
        { lane: 'payer', text: 'An unnamed buyer reached through the Afternic network.' },
        { lane: 'acquisition_access', text: 'dujo.com can be bought via Afternic checkout at $36,000.' },
        {
          lane: 'exit_evidence',
          text: 'No sale of dujo.com or a comparable domain was found; only an appraisal exists.',
          claimType: 'NEGATIVE_EXISTENCE',
        },
      ],
    });
    expect(await cardFact(id, 'exitEvidence')).toBeNull();
    expect(await cardFact(id, 'captureMechanism')).toBeNull();
    const tier = await tierOf(id);
    expect(tier.tier).toBe('SIGNAL');
    expect(tier.toAdvance.map((one) => one.key)).toEqual(['exitEvidence']);
  });

  it('is a candidate with current acquisition, sold-price exit evidence and a positive margin', async () => {
    const { id } = await piece({
      key: 'sealed ETB',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      claims: [
        { lane: 'payer', text: 'Collectors buying sealed ETBs on TCGPlayer, per completed sales.' },
        { lane: 'acquisition_access', text: 'The ETB is in stock at a retailer for $59.99 today.' },
        { lane: 'exit_evidence', text: 'Sixty completed sales in the last ten days ranged $92.79 to $129.99.' },
        { lane: 'price_evidence', text: 'The most recent completed sale was $114.74.' },
        { lane: 'cost_evidence', text: 'Acquisition $59.99 plus fees of $18.00, at most $77.99 delivered.' },
      ],
    });
    expect((await cardFact(id, 'captureMechanism'))!.kind).toBe('RECOMMENDATION');
    const tier = await tierOf(id);
    expect(tier.tier).toBe('CANDIDATE');
    expect(tier.economics.verdict).toBe('POSITIVE');
    expect(tier.economics.contributionCents).toBe(11474 - 7799);
  });
});

describe('what a transaction leaves decides whether it is worth acting on', () => {
  async function fullyAnswered(key: string, signal: OpportunitySignal, price: string, cost: string, extra: Partial<Record<string, string>> = {}) {
    const { id } = await piece({
      key,
      signal,
      claims: [
        { lane: 'payer', text: `${key}: the buyer named in its own published request.` },
        { lane: 'price_evidence', text: price },
        { lane: 'cost_evidence', text: cost },
      ],
    });
    // Every other field answered, so only the economics decide.
    const opportunity = (await getOpportunity(id))!;
    const card = cashEngineCard({ opportunity, facts: await cardFactsFor(id) });
    for (const entry of card.entries) {
      if (entry.value !== null) continue;
      await recordCardFact({
        projectId,
        opportunityId: id,
        field: entry.key,
        kind: 'PERSON',
        value: extra[entry.key] ?? `${entry.key} answered by a person`,
        decidedBy: ownerId,
      });
    }
    return id;
  }

  it('never qualifies a project whose published costs exceed its price', async () => {
    const id = await fullyAnswered('big project', 'ACTIVE_BUYER_DEMAND', 'The award is $50,000.', 'Subcontracted delivery costs $62,000.');
    const tier = await tierOf(id);
    expect(tier.tier).toBe('CANDIDATE');
    expect(tier.economics.verdict).toBe('NEGATIVE');
    expect(tier.route).toBe('UNATTRACTIVE');
  });

  it('leaves an unknown cost unknown rather than zero, and does not qualify on it', async () => {
    const id = await fullyAnswered('no cost', 'ACTIVE_BUYER_DEMAND', 'The award is $5,000.', 'Delivery requires an unpublished licence fee.');
    const tier = await tierOf(id);
    expect(tier.economics.verdict).toBe('UNKNOWN');
    expect(tier.economics.costCents).toBeNull();
    expect(tier.tier).toBe('CANDIDATE');
  });

  it('reads a buyer’s profitable commission as fast cash, once when the money arrives is known', async () => {
    const id = await fullyAnswered('county RFQ', 'ACTIVE_BUYER_DEMAND', 'The award is $5,000.', 'Delivery costs $1,200.');
    const tier = await tierOf(id);
    expect(tier.economics.verdict).toBe('POSITIVE');
    expect(tier.economics.contributionCents).toBe(380000);
    expect(tier.route).toBe('FAST_CASH');
    expect(['QUALIFIED', 'READY_TO_TEST']).toContain(tier.tier);
  });

  it('reads a small, cheap, repeating transaction with an established lever as scalable', async () => {
    const id = await fullyAnswered('formatted export', 'RECURRING_OUTSOURCED_WORK', 'Each export sells for $8.00.', 'Each costs $0.50 in compute.');
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'scalingLever',
      kind: 'PERSON',
      value: 'The same template serves every customer; a source shows 300 such requests a month.',
      decidedBy: ownerId,
    });
    const tier = await tierOf(id);
    expect(tier.economics.contributionCents).toBe(750);
    expect(tier.route).toBe('SCALABLE');
  });

  it('does not call a lever Brain proposed for itself evidence of scale', async () => {
    const id = await fullyAnswered('generic lever', 'RECURRING_OUTSOURCED_WORK', 'Each export sells for $8.00.', 'Each costs $0.50.');
    // The lever on this card is Brain's own generic proposal, from the price.
    expect((await cardFact(id, 'scalingLever'))!.kind).toBe('RECOMMENDATION');
    expect((await tierOf(id)).route).not.toBe('SCALABLE');
  });
});
