/**
 * What a deep dive's answers may and may not settle on a card, from rows.
 *
 * Production, Cash Mode 1, 2026-10-11, at the fifteen healthy deep dives: one
 * card carried "No payer was found" as its payer and a capture thesis composed
 * from it; four were one field short of QUALIFIED with their route on the card
 * and their request closed; and a second round on the New Jersey Department of
 * Health opening was blocked for not rediscovering a payer the first round had
 * already established. Release 2 (#171) made the route answer `access` and a
 * declared `ruled_out` claim stop the opening; this pins those beside the two
 * this change adds — an absence never answering the field it looked for, and a
 * later round inheriting an established payer.
 *
 * Each new regression was run against the code before this change to watch it
 * fail first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate, getCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims, updateFragment } from '../server/repos/research.ts';
import { cardFact, cardFactsFor, recordRecommendationFact } from '../server/repos/cashCardFacts.ts';
import { applyValidationAnswers, whyNotDiving } from '../server/services/cash/validation.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashTier, qualificationKeys } from '../server/services/cash/tier.ts';
import { compileMission } from '../server/services/russell/compiler.ts';
import { getProject } from '../server/repos/projects.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import type { ClaimType, EvidenceLane, Layer } from '../server/domain/types.ts';

const DIVE_LANES: EvidenceLane[] = profileFor('RUSSELL_CASH_VALIDATION_V1')!.lanes;

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  // Off the in-code slug map, so a dive compiles under the validation envelope
  // exactly as it does on a project an operator created.
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', ['typed-findings-sprint', projectId]);
  const owner = await createUser({
    email: 'typed@example.com',
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
  type?: ClaimType;
  accepted?: boolean;
}

async function dive(key: string, claims: ClaimSpec[]): Promise<{ candidateId: string; claimIds: string[] }> {
  const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: `Qualify: ${key}`, statement: key });
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: key,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: `Qualify: ${key}`,
    assignment: key,
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
      question: 'Who pays, how a supplier reaches them, and what rules it out?',
      geography: 'United States',
      timeframe: 'as at 2026',
      population: null,
      definitions: null,
      // The lanes a dive compiled today declares, `ruled_out` included.
      requiredEvidence: DIVE_LANES,
      acceptableSourceTypes: ['the published request'],
      excludedSourceTypes: ['blog'],
      completionCriteria: ['A named payer.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
    },
  ]);
  await updateFragment(fragment!.id, { status: 'BLOCKED' });
  const inserted = await insertClaims(
    claims.map((spec) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'TARGETED' as const,
      claim: spec.text,
      claimType: spec.type ?? 'SOURCED_FACT',
      sourceUrl: 'https://www.stlpartnership.com/rfp/',
      sourceTitle: 'Request for proposals',
      sourcePublisher: 'St. Louis Development Corporation',
      sourceDate: '2026-09-01',
      evidenceExcerpt: spec.text,
      evidenceLocator: 'RFP',
      evidenceLane: spec.lane,
      retrievedAt: '2026-10-07T12:00:00.000Z',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      accepted: spec.accepted ?? true,
      rejectionReason: spec.accepted === false ? 'unsupported' : null,
      contentHash: `${key}:${spec.lane}:${spec.text}`,
    })),
  );
  const { mission } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: key,
    whyNow: 'test',
    idempotencyKey: `dive:${key}`,
    candidateId: candidate.id,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'FAILED', terminalReason: 'x' });
  return { candidateId: candidate.id, claimIds: inserted.map((c) => c.id) };
}

async function opening(rounds: { candidateId: string }[], title = 'RFP: urban planning services'): Promise<string> {
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    opportunitySignal: 'PAID_TASK_OR_CONTRACT',
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
    validation_state: 'BLOCKED',
    validation_rounds: rounds.length,
    buying_signal: title,
  });
  return made.id;
}

async function tierOf(opportunityId: string) {
  const opportunity = (await getOpportunity(opportunityId))!;
  const card = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunityId) });
  return { card, reading: cashTier({ opportunity, card, readiness: evidenceCard(opportunity).readiness }) };
}

/** Every qualification key answered except the ones named, as a person would have filled them. */
async function answerAllExcept(opportunityId: string, skip: string[]): Promise<void> {
  const opportunity = (await getOpportunity(opportunityId))!;
  const keys = qualificationKeys(opportunity.opportunitySignal);
  await updateOpportunity(opportunityId, {
    payer: skip.includes('payer') ? null : 'The City of St. Louis',
    reachable_channel: skip.includes('access') ? null : opportunity.reachableChannel,
    offer_scope: 'An urban planning study',
    acceptance_condition: 'Delivered study accepted by the board',
    price_cents: 2_500_000,
    delivery_method: 'Report',
    fulfillment_owner: 'Brain with a subcontracted planner',
    peak_funding_cents: 100_000,
    payment_terms: 'Net 30 from acceptance',
    economics_note: 'Published comparable fees',
  });
  for (const key of keys) {
    if (skip.includes(key)) continue;
    const card = evidenceCard((await getOpportunity(opportunityId))!);
    if (card.fields.some((field) => field.key === key)) continue;
    if (key === 'captureMechanism' || key === 'disqualifiers') continue;
    await recordRecommendationFact({
      projectId,
      opportunityId,
      field: key,
      value: `answered ${key}`,
      basis: 'test',
      assumptions: 'test',
      uncertainty: 'test',
    });
  }
  if (!skip.includes('captureMechanism')) {
    await recordRecommendationFact({
      projectId,
      opportunityId,
      field: 'captureMechanism',
      value: 'Respond to the RFP with a planning study',
      basis: 'test',
      assumptions: 'test',
      uncertainty: 'test',
    });
  }
}

describe('an absence never answers the field it looked for', () => {
  it('a search that found no payer is not written as the payer, and leaves it unknown', async () => {
    const one = await dive('no-payer', [
      { lane: 'payer', text: 'No published source names a payer for this listing.', type: 'NEGATIVE_EXISTENCE' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect(await cardFact(id, 'payer')).toBeNull();
    expect((await getOpportunity(id))!.payer).toBeNull();
    expect((await tierOf(id)).card.entries.find((e) => e.key === 'payer')!.value).toBeNull();
  });

  it('nor a search that found no price, cost, terms or effort figure', async () => {
    const one = await dive('no-figures', [
      { lane: 'price_evidence', text: 'No comparable fee is published.', type: 'NEGATIVE_EXISTENCE' },
      { lane: 'cost_evidence', text: 'No input price is published.', type: 'NEGATIVE_EXISTENCE' },
      { lane: 'timing', text: 'No payment terms are published.', type: 'NEGATIVE_EXISTENCE' },
      { lane: 'effort', text: 'No effort estimate is published.', type: 'NEGATIVE_EXISTENCE' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    for (const field of ['revenueRange', 'directCosts', 'timeToFirstCash', 'hours']) {
      expect(await cardFact(id, field)).toBeNull();
    }
  });

  it('where an absence is the answer, it still answers', async () => {
    const one = await dive('absence-answers', [
      { lane: 'eligibility', text: 'The notice states no licence is required below USD 25,000.', type: 'NEGATIVE_EXISTENCE' },
      { lane: 'disqualifier', text: 'Nothing in the terms excludes an out-of-state supplier.', type: 'NEGATIVE_EXISTENCE' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect((await cardFact(id, 'eligibility'))?.claimId).toBe(one.claimIds[0]);
    expect((await cardFact(id, 'disqualifiers'))?.claimId).toBe(one.claimIds[1]);
  });

  it('a payer already on the card from a search is withdrawn, with what Brain composed from it', async () => {
    const one = await dive('withdraw', [{ lane: 'payer', text: 'No payer was found.', type: 'NEGATIVE_EXISTENCE' }]);
    const id = await opening([one]);
    // The production shape, written before this guard existed.
    await getDb().run(
      `INSERT INTO cash_card_facts (id, project_id, opportunity_id, field, kind, value, claim_id, decided_by, created_at, updated_at)
       VALUES ('ccf_legacy', ?, ?, 'payer', 'EVIDENCE', 'No payer was found.', ?, 'BRAIN', '2026-10-08', '2026-10-08')`,
      [projectId, id, one.claimIds[0]],
    );
    await updateOpportunity(id, { payer: 'No payer was found.' });
    await recordRecommendationFact({
      projectId,
      opportunityId: id,
      field: 'captureMechanism',
      value: 'Supply something to No payer was found.',
      basis: `A payer established from a published source (claim ${one.claimIds[0]})`,
      assumptions: 'x',
      uncertainty: 'x',
    });
    await applyValidationAnswers(projectId);
    expect(await cardFact(id, 'payer')).toBeNull();
    expect((await getOpportunity(id))!.payer).toBeNull();
    expect(await cardFact(id, 'captureMechanism')).toBeNull();
    const events = await getDb().all<{ detail: string }>(
      "SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_CARD_FACT_WITHDRAWN'",
      [id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain('No payer was found.');
    // And a replay withdraws nothing twice.
    await applyValidationAnswers(projectId);
    expect(
      await getDb().all("SELECT 1 FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_CARD_FACT_WITHDRAWN'", [id]),
    ).toHaveLength(1);
  });

  it('a person’s own payer is never withdrawn', async () => {
    const one = await dive('person', [{ lane: 'payer', text: 'No payer was found.', type: 'NEGATIVE_EXISTENCE' }]);
    const id = await opening([one]);
    await getDb().run(
      `INSERT INTO cash_card_facts (id, project_id, opportunity_id, field, kind, value, claim_id, decided_by, created_at, updated_at)
       VALUES ('ccf_person', ?, ?, 'payer', 'PERSON', 'The city clerk', NULL, 'usr_x', '2026-10-08', '2026-10-08')`,
      [projectId, id],
    );
    await applyValidationAnswers(projectId);
    expect((await cardFact(id, 'payer'))?.value).toBe('The city clerk');
  });
});

describe('accepted buyer-route evidence fills access', () => {
  it('a route found in the contact lane fills access as well as whether a call is needed', async () => {
    const one = await dive('route', [
      { lane: 'contact_mode', text: 'Proposals are submitted by email to rfp@stlpartnership.com.' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect((await cardFact(id, 'access'))?.claimId).toBe(one.claimIds[0]);
    expect((await getOpportunity(id))!.reachableChannel).toContain('rfp@stlpartnership.com');
    expect((await cardFact(id, 'phoneDependency'))?.claimId).toBe(one.claimIds[0]);
  });

  it('a documented absence of a route, or a rejected route claim, fills nothing', async () => {
    const none = await opening(
      [await dive('no-route', [{ lane: 'contact_mode', text: 'No route to the buyer is published.', type: 'NEGATIVE_EXISTENCE' }])],
      'RFP: no route',
    );
    const rejected = await opening(
      [await dive('rejected-route', [{ lane: 'contact_mode', text: 'Email rfp@example.com.', accepted: false }])],
      'RFP: rejected',
    );
    await applyValidationAnswers(projectId);
    expect(await cardFact(none, 'access')).toBeNull();
    expect(await cardFact(rejected, 'access')).toBeNull();
  });
});

describe('expired or closed openings cannot qualify', () => {
  it('a declared closed request is disqualified with every other field answered, and is not dived again', async () => {
    const one = await dive('closed', [
      { lane: 'contact_mode', text: 'Proposals by email to rfp@stlpartnership.com.' },
      { lane: 'ruled_out', text: 'The RFP closed on 2026-09-30 and was awarded.' },
    ]);
    const id = await opening([one]);
    await answerAllExcept(id, ['access']);
    await applyValidationAnswers(projectId);
    const { reading } = await tierOf(id);
    expect(reading.tier).toBe('CANDIDATE');
    expect(reading.summary).toContain('Disqualified');
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('DISQUALIFIED');
  });

  it('the same card with a documented absence of any disqualifier does qualify', async () => {
    const one = await dive('open', [
      { lane: 'contact_mode', text: 'Proposals by email to rfp@stlpartnership.com.' },
      { lane: 'disqualifier', text: 'Nothing in the terms excludes an out-of-state supplier.', type: 'NEGATIVE_EXISTENCE' },
    ]);
    const id = await opening([one]);
    await answerAllExcept(id, ['access', 'disqualifiers']);
    await applyValidationAnswers(projectId);
    expect((await tierOf(id)).reading.tier).toBe('QUALIFIED');
  });

  it('applying the evidence twice changes nothing the second time', async () => {
    const one = await dive('replay', [
      { lane: 'ruled_out', text: 'The listing is closed.' },
      { lane: 'contact_mode', text: 'Message the client on the platform.' },
    ]);
    await opening([one]);
    expect((await applyValidationAnswers(projectId)).length).toBeGreaterThan(0);
    expect(await applyValidationAnswers(projectId)).toEqual([]);
  });
});

describe('a later round inherits an established payer', () => {
  async function compiledLanesFor(candidateId: string) {
    const candidate = (await getCandidate(candidateId))!;
    const project = (await getProject(projectId))!;
    const compiled = await compileMission({ candidate, project, archive: { claimsConsidered: 0, contradicting: [] } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.reason);
    expect(compiled.mission.envelopeId).toBe('RUSSELL_CASH_VALIDATION_V1');
    return compiled.mission.fragments[0]!.requiredEvidence;
  }

  async function secondRound(opportunityId: string): Promise<string> {
    // A round's idea is always created after the evidence it inherits.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Qualify: round two',
      statement: 'Qualify this opening a second time.',
    });
    await updateOpportunity(opportunityId, { candidate_id: candidate.id, validation_rounds: 2 });
    return candidate.id;
  }

  it('existing valid payer evidence makes the payer lane conditional and names the claim', async () => {
    const one = await dive('round-1', [
      { lane: 'payer', text: 'The New Jersey Department of Health is the buyer under RFQ #09-11-26-39DPA.' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    const payer = await cardFact(id, 'payer');
    expect(payer?.claimId).toBe(one.claimIds[0]);
    const lanes = await compiledLanesFor(await secondRound(id));
    const lane = lanes.find((l) => l.id === 'payer')!;
    expect(lane.necessity).toBe('CONDITIONAL');
    expect(lane.description).toContain(one.claimIds[0]!);
    // The lineage stays on the card: the inherited claim is still the payer's evidence.
    expect((await cardFact(id, 'payer'))?.claimId).toBe(one.claimIds[0]);
  });

  it('unresolved payer evidence still blocks: no payer, or only a search that found nobody', async () => {
    const none = await opening([await dive('none', [{ lane: 'price_evidence', text: 'Comparable studies list at $25,000.' }])], 'RFP: none');
    await applyValidationAnswers(projectId);
    expect((await compiledLanesFor(await secondRound(none))).find((l) => l.id === 'payer')!.necessity).toBe('REQUIRED');

    const searched = await opening(
      [await dive('searched', [{ lane: 'payer', text: 'No payer is published.', type: 'NEGATIVE_EXISTENCE' }])],
      'RFP: searched',
    );
    await applyValidationAnswers(projectId);
    expect((await compiledLanesFor(await secondRound(searched))).find((l) => l.id === 'payer')!.necessity).toBe('REQUIRED');
  });

  it('a first round is never relaxed, even when the payer is already on the card', async () => {
    const one = await dive('first', [{ lane: 'payer', text: 'The city is the buyer.' }]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    // The first round's own candidate predates nothing it established.
    const lanes = await compiledLanesFor(one.candidateId);
    expect(lanes.find((l) => l.id === 'payer')!.necessity).toBe('REQUIRED');
    expect(id).toBeTruthy();
  });
});
