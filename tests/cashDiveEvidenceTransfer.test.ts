/**
 * A deep dive's accepted claims reach the card even when the dive itself failed.
 *
 * Production, Cash Mode 1, 2026-10-08: the New Jersey Department of Health dive
 * `orc_381e9bb31d4f49ecb7cc` ended with four accepted, sourced claims — payer,
 * price, timing, disqualifier — in a fragment whose integrity passed and whose
 * sufficiency did not. Its mission FAILED, so the dive settled BLOCKED, and
 * `applyValidationAnswers` read only openings settled COMPLETE, and only the
 * one packet `validation_orchestration_id` named — which by then was the
 * opening's second round. None of the four reached the card.
 *
 * The fixture is that shape exactly, and the refusals are pinned beside it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import {
  cardFact,
  cardFactsFor,
  recordCardFact,
  recordEvidenceFact,
} from '../server/repos/cashCardFacts.ts';
import { applyValidationAnswers } from '../server/services/cash/validation.ts';
import type { FragmentStatus, Layer, MissionState } from '../server/domain/types.ts';

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
): Promise<string> {
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title: 'Market: New Jersey state government procurement (NJ Department of Health).',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
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

const NJDOH: ClaimSpec[] = [
  { lane: 'payer', text: 'NJDOH is the buyer named on RFQ #09-11-26-39DPA.' },
  { lane: 'price_evidence', text: 'Comparable preventative maintenance awards were published at $18,400.' },
  { lane: 'timing', text: 'NJDOH pays approved invoices within 30 days of acceptance.' },
  { lane: 'disqualifier', text: 'The RFQ restricts no bidder by state of incorporation.' },
];

describe('a failed deep dive still carries its accepted claims to the card', () => {
  it('applies all four claims of a BLOCKED round-1 dive after the opening moved to round 2', async () => {
    const round1 = await dive({ key: 'njdoh round 1', mission: 'FAILED', fragment: 'BLOCKED', claims: NJDOH });
    // The newer round already exists and is still being researched.
    const round2 = await dive({ key: 'njdoh round 2', mission: 'RUNNING', fragment: 'QUEUED', claims: [] });
    const id = await opening([round1, round2], { state: 'RUNNING', orchestrationId: round2.orchestrationId });

    const applied = await applyValidationAnswers(projectId);
    expect(applied.map((one) => one.claimId).sort()).toEqual([...round1.claimIds].sort());

    const facts = await cardFactsFor(id);
    expect(facts.map((fact) => fact.field).sort()).toEqual(
      ['disqualifiers', 'payer', 'revenueRange', 'timeToFirstCash'].sort(),
    );
    for (const fact of facts) {
      expect(fact.kind).toBe('EVIDENCE');
      expect(round1.claimIds).toContain(fact.claimId);
    }
    const after = (await getOpportunity(id))!;
    // The column a reader of the row uses, written from the same claim.
    expect(after.payer).toBe(NJDOH[0]!.text);
    // And nothing about the dive moved: it is still the round being researched.
    expect(after.validationState).toBe('RUNNING');
    expect(after.validationOrchestrationId).toBe(round2.orchestrationId);
  });

  it('reads a dive only once its mission has finished', async () => {
    const running = await dive({ key: 'still running', mission: 'RUNNING', fragment: 'BLOCKED', claims: NJDOH });
    const parked = await dive({ key: 'parked', mission: 'NEEDS_HUMAN', fragment: 'BLOCKED', claims: NJDOH });
    const id = await opening([running, parked], { state: 'NEEDS_PERSON' as never, orchestrationId: parked.orchestrationId });
    expect(await applyValidationAnswers(projectId)).toEqual([]);
    expect(await cardFactsFor(id)).toEqual([]);
  });

  it('never carries a rejected claim, a claim with no source, or a cancelled or rejected fragment', async () => {
    const mixed = await dive({
      key: 'mixed',
      mission: 'FAILED',
      fragment: 'BLOCKED',
      claims: [
        { lane: 'payer', text: 'A payer the source does not support.', accepted: false },
        { lane: 'price_evidence', text: 'A price with no source.', sourceUrl: null },
        { lane: 'timing', text: 'Payment terms of 30 days.' },
      ],
    });
    const rejected = await dive({ key: 'rejected', mission: 'DONE', fragment: 'REJECTED', claims: NJDOH });
    const cancelled = await dive({ key: 'cancelled', mission: 'CANCELLED', fragment: 'CANCELLED', claims: NJDOH });
    const id = await opening([mixed, rejected, cancelled], { state: 'BLOCKED', orchestrationId: cancelled.orchestrationId });

    await applyValidationAnswers(projectId);
    const facts = await cardFactsFor(id);
    expect(facts.map((fact) => [fact.field, fact.claimId])).toEqual([['timeToFirstCash', mixed.claimIds[2]]]);
  });

  it('leaves a person’s answer exactly where it is', async () => {
    const round1 = await dive({ key: 'person', mission: 'FAILED', fragment: 'BLOCKED', claims: NJDOH });
    const id = await opening([round1], { state: 'BLOCKED', orchestrationId: round1.orchestrationId });
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'payer',
      kind: 'PERSON',
      value: 'The NJDOH Office of Procurement, confirmed by phone.',
      decidedBy: ownerId,
    });
    await applyValidationAnswers(projectId);
    const payer = (await cardFact(id, 'payer'))!;
    expect(payer.kind).toBe('PERSON');
    expect(payer.value).toBe('The NJDOH Office of Procurement, confirmed by phone.');
    // The other three still land.
    expect((await cardFactsFor(id)).filter((fact) => fact.kind === 'EVIDENCE')).toHaveLength(3);
  });

  it('keeps the earlier evidence when a later dive answers the same field differently, and replaces a proposal', async () => {
    const older = await dive({
      key: 'older',
      mission: 'FAILED',
      fragment: 'BLOCKED',
      claims: [{ lane: 'price_evidence', text: 'Older award published at $18,400.' }],
    });
    const newer = await dive({
      key: 'newer',
      mission: 'DONE',
      fragment: 'ACCEPTED',
      claims: [
        { lane: 'price_evidence', text: 'Newer award published at $21,000.' },
        { lane: 'timing', text: 'Net 30 from acceptance.' },
      ],
    });
    const id = await opening([older, newer], { state: 'COMPLETE', orchestrationId: newer.orchestrationId });
    // A proposal Brain made for timing stands in for a source, so a source replaces it.
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'timeToFirstCash',
      kind: 'RECOMMENDATION',
      value: 'About a month, proposed.',
      basis: 'b',
      assumptions: 'a',
      uncertainty: 'u',
      decidedBy: 'BRAIN',
    });
    await applyValidationAnswers(projectId);
    expect((await cardFact(id, 'revenueRange'))!.claimId).toBe(older.claimIds[0]);
    const timing = (await cardFact(id, 'timeToFirstCash'))!;
    expect(timing.kind).toBe('EVIDENCE');
    expect(timing.claimId).toBe(newer.claimIds[1]);
  });

  it('is idempotent across repeated ticks and a restart, and writes one fact per field', async () => {
    const round1 = await dive({ key: 'repeat 1', mission: 'FAILED', fragment: 'BLOCKED', claims: NJDOH });
    const round2 = await dive({
      key: 'repeat 2',
      mission: 'CANCELLED',
      fragment: 'BLOCKED',
      claims: [{ lane: 'payer', text: 'A second payer reading.' }],
    });
    const id = await opening([round1, round2], { state: 'BLOCKED', orchestrationId: round2.orchestrationId });

    expect(await applyValidationAnswers(projectId)).toHaveLength(4);
    const first = await cardFactsFor(id);
    expect(await applyValidationAnswers(projectId)).toEqual([]);
    await restartDatabase();
    expect(await applyValidationAnswers(projectId)).toEqual([]);

    const again = await cardFactsFor(id);
    expect(again.map((fact) => [fact.id, fact.field, fact.claimId, fact.updatedAt])).toEqual(
      first.map((fact) => [fact.id, fact.field, fact.claimId, fact.updatedAt]),
    );
    const rows = await getDb().all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cash_card_facts WHERE opportunity_id = ?',
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(4);
  });

  it('converges under concurrent application, with column and fact naming the same claim', async () => {
    const round1 = await dive({ key: 'race 1', mission: 'FAILED', fragment: 'BLOCKED', claims: NJDOH });
    const round2 = await dive({
      key: 'race 2',
      mission: 'DONE',
      fragment: 'ACCEPTED',
      claims: [{ lane: 'payer', text: 'A competing payer reading.' }],
    });
    const id = await opening([round1, round2], { state: 'COMPLETE', orchestrationId: round2.orchestrationId });

    await Promise.all([applyValidationAnswers(projectId), applyValidationAnswers(projectId)]);
    const facts = await cardFactsFor(id);
    expect(facts).toHaveLength(4);
    const payer = facts.find((fact) => fact.field === 'payer')!;
    expect(payer.claimId).toBe(round1.claimIds[0]);
    expect((await getOpportunity(id))!.payer).toBe(payer.value);
  });

  it('lets exactly one of two different claims win one empty field', async () => {
    const round1 = await dive({ key: 'one field', mission: 'FAILED', fragment: 'BLOCKED', claims: NJDOH });
    const id = await opening([round1], { state: 'BLOCKED', orchestrationId: round1.orchestrationId });
    const [a, b] = await Promise.all([
      recordEvidenceFact({ projectId, opportunityId: id, field: 'payer', value: 'a', claimId: round1.claimIds[0]! }),
      recordEvidenceFact({ projectId, opportunityId: id, field: 'payer', value: 'b', claimId: round1.claimIds[1]! }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (await cardFact(id, 'payer'))!;
    expect(winner.claimId).toBe(a ? round1.claimIds[0] : round1.claimIds[1]);
  });
});
