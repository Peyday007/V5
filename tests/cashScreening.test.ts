/**
 * Cheap commercial screening, driven through the entrance production uses.
 *
 * Every assertion here is about what Brain *spends*: which openings get a deep
 * dive, whether that dive is the full qualification or one question, and how
 * many needs — each its own research mission — a pass raises. The verdicts
 * themselves are pinned in `cashScreeningRules.test.ts`; this file is the half
 * that fails against the code before screening existed, because before it
 * every eligible opening got the full dive and every signal raised three needs.
 *
 * The fixtures are the production shapes from Cash Mode 1 on 2026-10-08: a
 * vendor's per-minute rate card (GoTranscript, Rev), a domain appraisal with no
 * sale behind it, a public agency's dated RFQ, and a repeated small brief.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  createOpportunity,
  getOpportunity,
  listNeeds,
  transitionOpportunity,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind, recordCashEvent } from '../server/repos/cashMode.ts';
import { createCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  finishPass,
  insertClaims,
  startPass,
  updateFragment,
} from '../server/repos/research.ts';
import { operate, reconcileDiscoverableGaps } from '../server/services/cash/operate.ts';
import { startValidations } from '../server/services/cash/validation.ts';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';

let projectId = '';
let layer: Layer;
let modeId = '';
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({
    email: 'screen@example.com',
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

async function piece(input: {
  title: string;
  signal: OpportunitySignal;
  source: string;
  observed?: string | null;
  payer?: string | null;
}): Promise<string> {
  const made = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: ownerId,
    title: input.title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    source: input.source,
    opportunitySignal: input.signal,
  });
  await updateOpportunity(made.id, {
    buying_signal: input.title,
    signal_observed_at: input.observed === undefined ? '2026-09-20' : input.observed,
    payer: input.payer ?? null,
  });
  return made.id;
}

async function fact(opportunityId: string, field: string, value: string): Promise<void> {
  await recordCardFact({ projectId, opportunityId, field, kind: 'PERSON', value, decidedBy: ownerId });
}

/**
 * One finished dive of an opening: an idea, its finished mission, a packet with
 * a completed research pass, and the claims the gate accepted.
 */
async function finishedDive(
  opportunityId: string,
  input: {
    round: number;
    targeted?: string;
    claims: { lane: string; text: string; negative?: boolean }[];
  },
): Promise<void> {
  const key = `${opportunityId}:${input.round}`;
  const candidate = await createCandidate({
    projectId,
    visibility: 'SHARED',
    title: `Qualify: ${key}`,
    statement: key,
  });
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
    title: key,
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
      question: key,
      geography: 'United States',
      timeframe: 'as at 2026',
      population: null,
      definitions: null,
      requiredEvidence: [{ id: 'exit_evidence', description: 'a sale', necessity: 'CONDITIONAL' }],
      acceptableSourceTypes: ['a published page'],
      excludedSourceTypes: ['blog'],
      completionCriteria: ['An answer.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
    },
  ]);
  await updateFragment(fragment!.id, { status: 'ACCEPTED' });
  const pass = await startPass({
    orchestrationId: orchestration.id,
    fragmentId: fragment!.id,
    passKey: 'TARGETED',
    ordinal: 1,
    provider: 'WORKER',
    prompt: key,
    promptSha256: 'x',
  });
  await finishPass(pass.id, { status: 'COMPLETE' });
  if (input.claims.length > 0) {
    await insertClaims(
      input.claims.map((spec) => ({
        orchestrationId: orchestration.id,
        fragmentId: fragment!.id,
        passId: null,
        passKey: 'TARGETED' as const,
        claim: spec.text,
        claimType: spec.negative ? ('NEGATIVE_EXISTENCE' as const) : ('SOURCED_FACT' as const),
        sourceUrl: 'https://www.example.com/search',
        sourceTitle: 'A published page',
        sourcePublisher: 'Example',
        sourceDate: '2026-09-11',
        evidenceExcerpt: spec.text,
        evidenceLocator: 'the page body',
        evidenceLane: spec.lane,
        retrievedAt: '2026-10-07T12:00:00.000Z',
        confidence: 0.8,
        validationState: 'SOURCED' as const,
        validationDetail: null,
        sourced: true,
        accepted: true,
        rejectionReason: null,
        contentHash: `${key}:${spec.lane}:${spec.text}`,
      })),
    );
  }
  const { mission } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: key,
    whyNow: 'test',
    idempotencyKey: `dive:${key}`,
    candidateId: candidate.id,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'DONE', terminalReason: 'x' });
  await recordCashEvent({
    projectId,
    opportunityId,
    kind: 'CASH_VALIDATION_STARTED',
    actorRef: 'BRAIN',
    summary: 'started',
    detail: { candidateId: candidate.id, round: input.round, targeted: input.targeted ?? null },
  });
  await updateOpportunity(opportunityId, {
    candidate_id: candidate.id,
    validation_state: 'COMPLETE',
    validation_rounds: input.round,
    validation_orchestration_id: orchestration.id,
    validation_settled_at: new Date().toISOString(),
  });
}

/** The deep dives a pass started, by opening, with the question each asks. */
async function divesStarted(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const candidate of await listCandidates({ projectId })) {
    if (!candidate.title.startsWith('Qualify: ')) continue;
    out.set(candidate.title.slice('Qualify: '.length), candidate.statement);
  }
  return out;
}

async function needsFor(opportunityId: string): Promise<string[]> {
  return (await listNeeds({ projectId }))
    .filter((one) => one.opportunityId === opportunityId && one.requestKey?.startsWith('question:'))
    .map((one) => one.requestKey!.split(':').pop()!)
    .sort();
}

const FULL = 'Establish who actually pays and how a supplier reaches them';
const ONE_QUESTION = 'Establish only';

describe('2. a vendor publishing its own price is asked one question, not qualified in full', () => {
  it('asks only whether anything actually sells at the higher figure, and raises no needs', async () => {
    const id = await piece({
      title: 'GoTranscript publishes $1.02 per minute for standard transcription.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://gotranscript.com/pricing',
    });
    await operate(projectId);

    const dives = await divesStarted();
    const statement = dives.get('GoTranscript publishes $1.02 per minute for standard transcription.');
    expect(statement).toContain(ONE_QUESTION);
    expect(statement).toContain('actually sells at the higher figure');
    expect(statement).not.toContain(FULL);
    // Before: payer, access and buying evidence — three research missions about
    // a vendor's price list. Now: none until the one question is answered.
    expect(await needsFor(id)).toEqual([]);
  });
});

describe('1. economically weak manual work that has already been qualified twice', () => {
  it('stops spending once both dives asked the decisive question and nothing answered it', async () => {
    const id = await piece({
      title: 'GoTranscript pays transcribers per audio minute.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://gotranscript.com/transcription-jobs',
    });
    await finishedDive(id, { round: 1, claims: [{ lane: 'cost_evidence', text: 'Each minute takes about four minutes of human typing.' }] });
    await finishedDive(id, { round: 2, claims: [] });
    // A Brain-proposed capture thesis makes it a candidate, which used to
    // raise every researchable blank as its own mission.
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'captureMechanism',
      kind: 'RECOMMENDATION',
      value: 'Do transcription jobs for the platform.',
      basis: 'b',
      assumptions: 'a',
      uncertainty: 'u',
      decidedBy: 'BRAIN',
    });

    await operate(projectId);
    expect(await needsFor(id)).toEqual([]);
    const screened = await cashEventsOfKind(id, 'CASH_OPPORTUNITY_SCREENED');
    expect(screened.at(-1)!.detail['verdict']).toBe('PARK');
    expect(screened.at(-1)!.detail['decisive']).toBe('exitEvidence');
    // Kept, not archived: the row and its state are untouched.
    expect((await getOpportunity(id))!.state).toBe('DISCOVERED');
  });
});

describe('3. a genuine active buyer with a known payer gets the full qualification first', () => {
  it('is dived in full, ahead of a vendor price list found earlier', async () => {
    await piece({
      title: 'Rev publishes $1.99 per minute for human transcription.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://www.rev.com/pricing',
    });
    await piece({
      title: 'NJDOH RFQ 09-11-26-39DPA for preventative maintenance, closing 2026-10-30.',
      signal: 'ACTIVE_BUYER_DEMAND',
      source: 'https://www.nj.gov/health/bids/',
      payer: 'New Jersey Department of Health',
    });
    const started = await startValidations({ projectId, limit: 1 });
    expect(started).toHaveLength(1);
    const statement = (await divesStarted()).get(
      'NJDOH RFQ 09-11-26-39DPA for preventative maintenance, closing 2026-10-30.',
    );
    expect(statement).toContain(FULL);
  });
});

describe('4. a small transaction with a low cost and published repeat demand', () => {
  it('is not screened out for being small: every gate answered earns the full qualification', async () => {
    const id = await piece({
      title: 'Small firms repeatedly commission formatted CSV exports from Shopify data.',
      signal: 'RECURRING_OUTSOURCED_WORK',
      source: 'https://www.upwork.com/freelance-jobs/csv/',
      payer: 'Small Shopify merchants',
    });
    await fact(id, 'revenueRange', '$8 per export');
    await fact(id, 'directCosts', '$0.50 of compute per export');
    await fact(id, 'scalingLever', 'One template serves every merchant; 300 such requests a month are posted.');
    await startValidations({ projectId });
    const statement = (await divesStarted()).get(
      'Small firms repeatedly commission formatted CSV exports from Shopify data.',
    );
    expect(statement).toContain(FULL);
  });
});

describe('6. a speculative resale with no current acquisition or exit evidence', () => {
  it('is asked for evidence of an actual sale first, and stops when a documented search finds none', async () => {
    const id = await piece({
      title: 'dujo.com is listed on Afternic at $36,000 and appraised at $55,000.',
      signal: 'RESALABLE_ASSET_OPENING',
      source: 'https://www.afternic.com/domain/dujo.com',
    });
    await startValidations({ projectId });
    expect((await divesStarted()).get('dujo.com is listed on Afternic at $36,000 and appraised at $55,000.')).toContain(
      'actually sells at the higher figure',
    );

    // The targeted round finishes with a documented absence of any sale.
    await finishedDive(id, {
      round: 1,
      targeted: 'exitEvidence',
      claims: [{ lane: 'exit_evidence', text: 'No sale of dujo.com or a comparable domain was found.', negative: true }],
    });
    await operate(projectId);
    const last = (await cashEventsOfKind(id, 'CASH_OPPORTUNITY_SCREENED')).at(-1)!;
    expect(last.detail['verdict']).toBe('SCREEN_OUT');
    expect(last.detail['reason']).toBe('ESTABLISHED_ABSENT');
    // No second round, and no needs.
    expect((await getOpportunity(id))!.validationRounds).toBe(1);
    expect(await needsFor(id)).toEqual([]);
  });

  it('parks when the one question found nothing either way, rather than paying for the full round', async () => {
    const id = await piece({
      title: 'VJN.com is listed on Afternic at $39,000 and appraised at $55,000.',
      signal: 'RESALABLE_ASSET_OPENING',
      source: 'https://www.afternic.com/domain/vjn.com',
    });
    await finishedDive(id, { round: 1, targeted: 'exitEvidence', claims: [] });
    await operate(projectId);
    expect((await getOpportunity(id))!.validationRounds).toBe(1);
    const last = (await cashEventsOfKind(id, 'CASH_OPPORTUNITY_SCREENED')).at(-1)!;
    expect(last.detail['verdict']).toBe('PARK');
  });
});

describe('7. a genuine resale with current acquisition and sold-price exit evidence', () => {
  it('earns the full qualification once its one question was answered', async () => {
    const id = await piece({
      title: 'Sealed Prismatic Evolutions ETBs are in stock at $59.99.',
      signal: 'RESALABLE_ASSET_OPENING',
      source: 'https://www.tcgplayer.com/product/prismatic-etb',
    });
    await finishedDive(id, {
      round: 1,
      targeted: 'exitEvidence',
      claims: [{ lane: 'exit_evidence', text: 'Sixty completed sales in ten days ranged $92.79 to $129.99.' }],
    });
    await fact(id, 'exitEvidence', 'Sixty completed sales in ten days ranged $92.79 to $129.99.');
    await startValidations({ projectId });
    const round2 = (await cashEventsOfKind(id, 'CASH_VALIDATION_STARTED')).find(
      (one) => one.detail['round'] === 2,
    );
    expect(round2).toBeDefined();
    expect(round2!.detail['targeted']).toBeNull();
    expect(round2!.detail['screen']).toBe('DECISIVE_QUESTION_PASSED');
  });
});

describe('9 and 10. a rejected mechanism reappearing, and new evidence about it', () => {
  async function declinedEarlier(): Promise<string> {
    const old = await piece({
      title: 'GoTranscript transcription rate card, September.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://gotranscript.com/pricing',
    });
    await transitionOpportunity({
      id: old,
      from: ['DISCOVERED'],
      to: 'DECLINED',
      declinedByUserId: ownerId,
      declinedReason: 'Pays below any rate we would accept.',
    });
    await getDb().run(`UPDATE cash_opportunities SET updated_at = ? WHERE id = ?`, [
      '2026-09-01T00:00:00.000Z',
      old,
    ]);
    return old;
  }

  it('9. does not spend on the same mechanism from the same source again', async () => {
    const old = await declinedEarlier();
    const again = await piece({
      title: 'GoTranscript transcription rate card, October.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://www.gotranscript.com/pricing?ref=oct',
    });
    await operate(projectId);
    expect((await divesStarted()).has('GoTranscript transcription rate card, October.')).toBe(false);
    expect(await needsFor(again)).toEqual([]);
    const last = (await cashEventsOfKind(again, 'CASH_OPPORTUNITY_SCREENED')).at(-1)!;
    expect(last.detail['reason']).toBe('MECHANISM_REJECTED');
    expect(last.summary).toContain(old);
  });

  it('9. a different source of the same kind is not tarred with it', async () => {
    await declinedEarlier();
    await piece({
      title: 'Rev publishes $1.99 per minute.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://www.rev.com/pricing',
    });
    await startValidations({ projectId });
    expect((await divesStarted()).has('Rev publishes $1.99 per minute.')).toBe(true);
  });

  it('10. new evidence on a decisive question reopens it', async () => {
    const old = await declinedEarlier();
    const again = await piece({
      title: 'GoTranscript transcription rate card, October.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://gotranscript.com/pricing',
    });
    await fact(again, 'exitEvidence', 'Resellers now publish completed white-label sales at $2.40 a minute.');
    await operate(projectId);
    const last = (await cashEventsOfKind(again, 'CASH_OPPORTUNITY_SCREENED')).at(-1)!;
    expect(last.detail['reason']).not.toBe('MECHANISM_REJECTED');
    expect(last.detail['reconsidered']).toEqual({ rejectedOpportunityId: old, evidenceField: 'exitEvidence' });
  });
});

describe('11. screening repeated across ticks and a restart', () => {
  it('records one reading per change and never re-dives what it withheld', async () => {
    const id = await piece({
      title: 'dujo.com appraisal.',
      signal: 'RESALABLE_ASSET_OPENING',
      source: 'https://www.afternic.com/domain/dujo.com',
    });
    await finishedDive(id, {
      round: 1,
      targeted: 'exitEvidence',
      claims: [{ lane: 'exit_evidence', text: 'No sale was found.', negative: true }],
    });
    for (let pass = 0; pass < 3; pass += 1) await operate(projectId);
    await restartDatabase();
    for (let pass = 0; pass < 3; pass += 1) await operate(projectId);

    expect(await cashEventsOfKind(id, 'CASH_OPPORTUNITY_SCREENED')).toHaveLength(1);
    expect(await cashEventsOfKind(id, 'CASH_VALIDATION_STARTED')).toHaveLength(1);
    expect(await needsFor(id)).toEqual([]);
  });
});

describe('12. capacity pressure with competing signals', () => {
  it('spends the two slots on the strongest claims and never on a screened-out one', async () => {
    await (async () => {
      const old = await piece({
        title: 'Old Adobe Stock rate card.',
        signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
        source: 'https://stock.adobe.com/plans',
      });
      await transitionOpportunity({
        id: old,
        from: ['DISCOVERED'],
        to: 'DECLINED',
        declinedByUserId: ownerId,
        declinedReason: 'A vendor price list.',
      });
    })();
    // Found first, and therefore first in arrival order before screening.
    await piece({
      title: 'Adobe Stock rate card again.',
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      source: 'https://stock.adobe.com/plans',
    });
    await piece({
      title: 'Coachella resale listings at $2,100.',
      signal: 'RESALABLE_ASSET_OPENING',
      source: 'https://www.stubhub.com/coachella',
    });
    await piece({
      title: 'City of St. Louis RFP for parcel title research, closing 2026-10-25.',
      signal: 'ACTIVE_BUYER_DEMAND',
      source: 'https://www.stlouis-mo.gov/bids',
      payer: 'City of St. Louis',
    });

    const started = await startValidations({ projectId });
    expect(started).toHaveLength(2);
    const dives = await divesStarted();
    expect(dives.get('City of St. Louis RFP for parcel title research, closing 2026-10-25.')).toContain(FULL);
    expect(dives.get('Coachella resale listings at $2,100.')).toContain(ONE_QUESTION);
    expect(dives.has('Adobe Stock rate card again.')).toBe(false);
  });
});

describe('the needs path asks the decisive question alone', () => {
  it('raises one need for a buyer whose payer is unknown, not three', async () => {
    const id = await piece({
      title: 'A county posted a request for drainage parcel research.',
      signal: 'ACTIVE_BUYER_DEMAND',
      source: 'https://county.example.gov/rfp',
    });
    await reconcileDiscoverableGaps(projectId);
    expect(await needsFor(id)).toEqual(['payer']);
    // And the payer question is a need, so no dive asks it a second time.
    await startValidations({ projectId });
    expect((await divesStarted()).has('A county posted a request for drainage parcel research.')).toBe(false);
  });
});
