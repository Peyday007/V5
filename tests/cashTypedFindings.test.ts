/**
 * Typed validation findings: payer, access and disqualifier, from rows.
 *
 * Production, Cash Mode 1, 2026-10-11: of fifteen healthy deep dives, four were
 * one field short of QUALIFIED with only `access` blank while their own contact
 * evidence named the route; all four were closed requests, so filling `access`
 * alone would have reported expired openings as qualified. One card carried
 * "No payer was found" as its payer. And a second round on the New Jersey
 * Department of Health opening was blocked for not rediscovering a payer the
 * first round had already established.
 *
 * Every regression here was run against the code before this change to watch it
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
import {
  applyValidationAnswers,
  cardFieldsFor,
  whyNotDiving,
} from '../server/services/cash/validation.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashTier, qualificationKeys } from '../server/services/cash/tier.ts';
import { compileMission } from '../server/services/russell/compiler.ts';
import { getProject } from '../server/repos/projects.ts';
import { validateValidationFinding } from '../server/domain/validationFindings.ts';
import { parseResearchPass } from '../server/services/research/schema.ts';
import type { ClaimType, Layer, ResearchClaim } from '../server/domain/types.ts';
import type { ValidationFinding } from '../server/domain/validationFindings.ts';

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
  finding?: ValidationFinding | null;
  date?: string | null;
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
      requiredEvidence: [{ id: 'payer', description: 'a named payer', necessity: 'REQUIRED' }],
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
      validationFinding: spec.finding ?? null,
      validationDate: spec.date ?? null,
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

function claimOf(spec: Partial<ResearchClaim>): ResearchClaim {
  return {
    claimType: 'SOURCED_FACT',
    evidenceLane: null,
    validationFinding: null,
    ...spec,
  } as ResearchClaim;
}

describe('the typed finding is validated at both doors', () => {
  it('refuses an absence asserted as the thing that was not found, and the reverse', () => {
    expect(validateValidationFinding({ where: 'c', finding: 'NO_PAYER_FOUND', date: null, claimType: 'SOURCED_FACT' }).ok).toBe(false);
    expect(validateValidationFinding({ where: 'c', finding: 'PAYER_ESTABLISHED', date: null, claimType: 'NEGATIVE_EXISTENCE' }).ok).toBe(false);
    expect(validateValidationFinding({ where: 'c', finding: 'NO_PAYER_FOUND', date: null, claimType: 'NEGATIVE_EXISTENCE' }).ok).toBe(true);
    expect(validateValidationFinding({ where: 'c', finding: 'RESPONSE_DEADLINE', date: null, claimType: 'SOURCED_FACT' }).ok).toBe(false);
    expect(validateValidationFinding({ where: 'c', finding: 'PAYER_ESTABLISHED', date: '2026-10-13', claimType: 'SOURCED_FACT' }).ok).toBe(false);
    expect(validateValidationFinding({ where: 'c', finding: 'MAYBE', date: null, claimType: 'SOURCED_FACT' }).ok).toBe(false);
  });

  it('the provider door carries the finding and refuses the same shapes', () => {
    const good = parseResearchPass(JSON.stringify({
      claims: [
        {
          claim: 'Responses close on 2026-10-13.',
          sourceUrl: 'https://example.gov/rfp',
          evidenceLane: 'timing',
          validationFinding: 'RESPONSE_DEADLINE',
          validationDate: '2026-10-13',
        },
      ],
    }));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.claims[0]!.validationFinding).toBe('RESPONSE_DEADLINE');
      expect(good.value.claims[0]!.validationDate).toBe('2026-10-13');
    }
    const bad = parseResearchPass(JSON.stringify({
      claims: [{ claim: 'No payer is published.', sourceUrl: 'https://example.gov', validationFinding: 'NO_PAYER_FOUND' }],
    }));
    expect(bad.ok).toBe(false);
  });
});

describe('negative findings never masquerade as positive answers', () => {
  it('"no payer found" is never written as the payer, and leaves it unknown rather than settled', async () => {
    const one = await dive('no-payer', [
      { lane: 'payer', text: 'No published source names a payer for this listing.', type: 'NEGATIVE_EXISTENCE', finding: 'NO_PAYER_FOUND' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect(await cardFact(id, 'payer')).toBeNull();
    expect((await getOpportunity(id))!.payer).toBeNull();
    const { card } = await tierOf(id);
    expect(card.entries.find((e) => e.key === 'payer')!.value).toBeNull();
  });

  it('an untyped legacy payer claim that was a search finding nobody is not a payer either', async () => {
    const one = await dive('legacy-no-payer', [
      { lane: 'payer', text: 'No payer was found.', type: 'NEGATIVE_EXISTENCE' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect(await cardFact(id, 'payer')).toBeNull();
  });

  it('a payer already on the card from a negative claim is withdrawn, with what Brain composed from it', async () => {
    const one = await dive('withdraw', [
      { lane: 'payer', text: 'No payer was found.', type: 'NEGATIVE_EXISTENCE' },
    ]);
    const id = await opening([one]);
    // The production shape: written before typed findings existed.
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
    const events = await getDb().all<{ kind: string }>(
      "SELECT kind FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_CARD_FACT_WITHDRAWN'",
      [id],
    );
    expect(events).toHaveLength(1);
  });

  it('"no disqualifier found" answers the question; an untyped legacy claim leaves it unresolved', async () => {
    const clean = await dive('clean', [
      { lane: 'disqualifier', text: 'The RFP terms contain no set-aside or residency rule.', type: 'NEGATIVE_EXISTENCE', finding: 'NO_DISQUALIFIER_FOUND' },
    ]);
    const cleanId = await opening([clean], 'RFP: clean');
    const vague = await dive('vague', [
      { lane: 'disqualifier', text: 'The RFP was issued on 2026-09-01.' },
    ]);
    const vagueId = await opening([vague], 'RFP: vague');
    await applyValidationAnswers(projectId);
    expect((await tierOf(cleanId)).card.disqualifierStatus).toBe('NONE_FOUND');
    expect((await tierOf(cleanId)).card.entries.find((e) => e.key === 'disqualifiers')!.value).not.toBeNull();
    const vagueCard = (await tierOf(vagueId)).card;
    expect(vagueCard.disqualifierStatus).toBe('UNRESOLVED');
    expect(vagueCard.entries.find((e) => e.key === 'disqualifiers')!.value).toBeNull();
    expect(vagueCard.entries.find((e) => e.key === 'disqualifiers')!.task).toContain('Unresolved');
  });

  it('a documented absence of a route does not answer whether a call is needed', () => {
    expect(
      cardFieldsFor(claimOf({ evidenceLane: 'contact_mode', claimType: 'NEGATIVE_EXISTENCE', validationFinding: 'NO_BUYER_ROUTE_FOUND' })),
    ).toEqual([]);
  });
});

describe('accepted buyer-route evidence fills access', () => {
  it('a typed route fills access as well as the contact field', async () => {
    const one = await dive('route', [
      { lane: 'contact_mode', text: 'Proposals are submitted by email to rfp@stlpartnership.com.', finding: 'BUYER_ROUTE_ESTABLISHED' },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect((await cardFact(id, 'access'))?.claimId).toBe(one.claimIds[0]);
    expect((await getOpportunity(id))!.reachableChannel).toContain('rfp@stlpartnership.com');
    expect((await cardFact(id, 'phoneDependency'))?.claimId).toBe(one.claimIds[0]);
  });

  it('an untyped legacy route in the contact lane fills access too, and a legacy absence does not', async () => {
    expect(cardFieldsFor(claimOf({ evidenceLane: 'contact_mode' }))).toContain('access');
    expect(cardFieldsFor(claimOf({ evidenceLane: 'contact_mode', claimType: 'NEGATIVE_EXISTENCE' }))).not.toContain('access');
  });

  it('a rejected route claim fills nothing', async () => {
    const one = await dive('rejected-route', [
      { lane: 'contact_mode', text: 'Email rfp@example.com.', finding: 'BUYER_ROUTE_ESTABLISHED', accepted: false },
    ]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    expect(await cardFact(id, 'access')).toBeNull();
  });
});

describe('expired or closed openings cannot qualify', () => {
  it('a closed request is disqualified even with every other field answered', async () => {
    const one = await dive('closed', [
      { lane: 'contact_mode', text: 'Proposals by email to rfp@stlpartnership.com.', finding: 'BUYER_ROUTE_ESTABLISHED' },
      { lane: 'disqualifier', text: 'The RFP was awarded on 2026-09-30.', finding: 'DISQUALIFIED_CLOSED' },
    ]);
    const id = await opening([one]);
    await answerAllExcept(id, ['access']);
    await applyValidationAnswers(projectId);
    const { card, reading } = await tierOf(id);
    expect(card.disqualifierStatus).toBe('ESTABLISHED');
    expect(reading.tier).not.toBe('QUALIFIED');
    expect(reading.summary).toContain('Disqualified');
    expect((await whyNotDiving((await getOpportunity(id))!)).kind).toBe('DISQUALIFIED');
  });

  it('a passed closing date disqualifies; the same answers with a future date qualify', async () => {
    const past = await dive('past-deadline', [
      { lane: 'contact_mode', text: 'Bids through the city portal.', finding: 'BUYER_ROUTE_ESTABLISHED' },
      { lane: 'timing', text: 'Responses are due 2026-10-01.', finding: 'RESPONSE_DEADLINE', date: '2026-10-01' },
      { lane: 'disqualifier', text: 'Nothing in the terms excludes an out-of-state supplier.', type: 'NEGATIVE_EXISTENCE', finding: 'NO_DISQUALIFIER_FOUND' },
    ]);
    const pastId = await opening([past], 'RFP: past');
    const future = await dive('future-deadline', [
      { lane: 'contact_mode', text: 'Bids through the city portal.', finding: 'BUYER_ROUTE_ESTABLISHED' },
      { lane: 'timing', text: 'Responses are due 2026-12-01.', finding: 'RESPONSE_DEADLINE', date: '2026-12-01' },
      { lane: 'disqualifier', text: 'Nothing in the terms excludes an out-of-state supplier.', type: 'NEGATIVE_EXISTENCE', finding: 'NO_DISQUALIFIER_FOUND' },
    ]);
    const futureId = await opening([future], 'RFP: future');
    await answerAllExcept(pastId, ['access']);
    await answerAllExcept(futureId, ['access']);
    const now = Date.parse('2026-10-11T12:00:00Z');
    await applyValidationAnswers(projectId, now);

    const pastTier = await tierOf(pastId);
    expect(pastTier.card.disqualifierStatus).toBe('ESTABLISHED');
    expect(pastTier.card.disqualifiedBy!.value).toContain('2026-10-01');
    expect(pastTier.reading.tier).toBe('CANDIDATE');
    expect((await getOpportunity(pastId))!.expiresAt).toBe('2026-10-01');

    const futureTier = await tierOf(futureId);
    expect(futureTier.card.disqualifierStatus).toBe('NONE_FOUND');
    expect(futureTier.reading.tier).toBe('QUALIFIED');
    expect((await getOpportunity(futureId))!.expiresAt).toBe('2026-12-01');
  });

  it('an extension published later takes back a disqualifier only the old date established', async () => {
    const first = await dive('extension-1', [
      { lane: 'timing', text: 'Responses are due 2026-10-01.', finding: 'RESPONSE_DEADLINE', date: '2026-10-01' },
    ]);
    const id = await opening([first]);
    const now = Date.parse('2026-10-11T12:00:00Z');
    await applyValidationAnswers(projectId, now);
    expect((await tierOf(id)).card.disqualifierStatus).toBe('ESTABLISHED');
    const second = await dive('extension-2', [
      { lane: 'timing', text: 'Addendum 2 extends the due date to 2026-11-15.', finding: 'RESPONSE_DEADLINE', date: '2026-11-15' },
    ]);
    await recordCashEvent({
      projectId,
      opportunityId: id,
      kind: 'CASH_VALIDATION_STARTED',
      actorRef: 'BRAIN',
      summary: 'started',
      detail: { candidateId: second.candidateId, round: 2 },
    });
    await applyValidationAnswers(projectId, now);
    expect((await tierOf(id)).card.disqualifierStatus).not.toBe('ESTABLISHED');
  });

  it('the same answers without a typed disqualifier finding do not qualify (unresolved is not none)', async () => {
    const one = await dive('unresolved', [
      { lane: 'contact_mode', text: 'Proposals by email.', finding: 'BUYER_ROUTE_ESTABLISHED' },
      { lane: 'disqualifier', text: 'The deadline for questions was 2026-09-15.' },
    ]);
    const id = await opening([one]);
    await answerAllExcept(id, ['access']);
    await applyValidationAnswers(projectId);
    const { reading } = await tierOf(id);
    expect(reading.tier).toBe('CANDIDATE');
    expect(reading.toAdvance.map((r) => r.key)).toContain('disqualifiers');
  });

  it('applying the evidence twice changes nothing the second time', async () => {
    const one = await dive('replay', [
      { lane: 'disqualifier', text: 'The listing is closed.', finding: 'DISQUALIFIED_CLOSED' },
      { lane: 'contact_mode', text: 'Message the client on the platform.', finding: 'BUYER_ROUTE_ESTABLISHED' },
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
      { lane: 'payer', text: 'The New Jersey Department of Health is the buyer under RFQ #09-11-26-39DPA.', finding: 'PAYER_ESTABLISHED' },
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
      [await dive('searched', [{ lane: 'payer', text: 'No payer is published.', type: 'NEGATIVE_EXISTENCE', finding: 'NO_PAYER_FOUND' }])],
      'RFP: searched',
    );
    await applyValidationAnswers(projectId);
    expect((await compiledLanesFor(await secondRound(searched))).find((l) => l.id === 'payer')!.necessity).toBe('REQUIRED');
  });

  it('a first round is never relaxed, even when the payer is already on the card', async () => {
    const one = await dive('first', [{ lane: 'payer', text: 'The city is the buyer.', finding: 'PAYER_ESTABLISHED' }]);
    const id = await opening([one]);
    await applyValidationAnswers(projectId);
    // The first round's own candidate predates nothing it established.
    const lanes = await compiledLanesFor(one.candidateId);
    expect(lanes.find((l) => l.id === 'payer')!.necessity).toBe('REQUIRED');
    expect(id).toBeTruthy();
  });
});
