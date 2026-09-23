/**
 * From "what can we actually do?" to a recommendation, a step, and the step's
 * result changing the recommendation — walked through the real turn, the real
 * tick pass and the real Cash machinery.
 *
 * What is simulated is the outside world only: the deep dive's answers arrive
 * as card facts, exactly where `applyValidationAnswers` writes them when a real
 * worker's claims clear the gate. Everything between — the turn, the objective,
 * the candidate paths, the eight tests, the decision, the steered deep dive,
 * the change report in the conversation — is the production code path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import {
  createOpportunity,
  getOpportunity,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { beginTurn } from '../server/services/russell/turn.ts';
import { asksForDecision } from '../server/services/decision/entrance.ts';
import { advanceObjectives, advanceObjective } from '../server/services/decision/act.ts';
import { composeBrief } from '../server/services/decision/brief.ts';
import {
  listDecisions,
  listObjectives,
  listSteps,
  steeredOpenings,
} from '../server/repos/objectives.ts';
import { ensureDiscoveryAuthority } from '../server/services/cash/discoveryAuthority.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { captureCandidate } from './decisionJourney.helpers.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { CANONICAL_CASH_OBJECTIVE } from '../server/services/cash/root.ts';
import { decide, judgePath, type CandidatePath } from '../server/domain/decision.ts';
import type { Principal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';

// The objective production actually records on a sprint: Cash Mode composes it
// from this constant at activation, so this is not a paraphrase of it.
const OBJECTIVE = CANONICAL_CASH_OBJECTIVE;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `decision-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'OWNER',
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
  expect(outcome.ok).toBe(true);
  await ensureDiscoveryAuthority(projectId);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function principal(): Promise<Principal> {
  const { listMembershipsForPrincipal } = await import('../server/repos/identity.ts');
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'Owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: await listMembershipsForPrincipal('HUMAN', userId),
    requestId: 'req_test',
  } as Principal;
}

async function opening(input: {
  title: string;
  signal: string;
  observed: string;
  opportunitySignal: string;
  patch?: Parameters<typeof updateOpportunity>[1];
}): Promise<string> {
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title: input.title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 10)}`,
    opportunitySignal: input.opportunitySignal as never,
  });
  await updateOpportunity(created.id, {
    buying_signal: input.signal,
    signal_observed_at: input.observed,
    ...(input.patch ?? {}),
  });
  return created.id;
}

async function ask(conversationId: string, content: string) {
  return beginTurn({ principal: await principal(), conversationId, content });
}

describe('asking for a decision is recognised narrowly', () => {
  it('reads the questions somebody asks when they want to be told what to do', () => {
    for (const text of [
      'What can we actually do?',
      'Given all this, what should we do first?',
      'What do you recommend?',
      "What's the best next move here?",
      'How can we actually make money from this?',
    ]) {
      expect(asksForDecision(text).asks, text).toBe(true);
    }
  });

  it('does not read a report, a remark or a refusal as a request', () => {
    for (const text of [
      'We decided what to do yesterday.',
      'It is hard to know what to do with transcription pricing.',
      "Don't tell me what we can do, just list the openings.",
      'Show me the openings.',
    ]) {
      expect(asksForDecision(text).asks, text).toBe(false);
    }
  });

  it('keeps an objective stated in the same message, without the question', () => {
    const read = asksForDecision('Our goal is to finish the short film this quarter. What should we do first?');
    expect(read.asks).toBe(true);
    expect(read.stated).toBe('finish the short film this quarter');
  });
});

describe('the pure decision', () => {
  function path(ref: string, readings: Partial<Record<string, CandidatePath['assessments'][number]['reading']>>, kind: 'FACT' | 'ESTIMATE' = 'FACT'): CandidatePath {
    const criteria = ['DEMAND', 'REACH', 'PRODUCTION', 'DELIVERY', 'COST', 'TIME', 'CAPACITY', 'AUTHORITY'] as const;
    return {
      ref,
      source: 'CASH_OPPORTUNITY',
      title: ref,
      sourceRef: null,
      how: null,
      assessments: criteria.map((criterion) => ({
        criterion,
        reading: readings[criterion] ?? 'MET',
        kind: readings[criterion] === 'UNKNOWN' ? 'UNKNOWN' : kind,
        statement: `${criterion} reading`,
        evidenceRef: null,
        task: null,
      })),
      executionStep: null,
      researchStep: {
        kind: 'QUALIFY_OPENING',
        description: `qualify ${ref}`,
        serves: null,
        authority: 'AUTHORIZED',
        boundary: null,
        prepared: null,
        existingWork: null,
      },
      economics: [],
    };
  }

  it('never rejects on an estimate, and never lets an unknown count as met', () => {
    expect(judgePath(path('a', { COST: 'NOT_MET' }, 'ESTIMATE')).standing).toBe('OPEN');
    expect(judgePath(path('b', { COST: 'NOT_MET' }, 'FACT')).standing).toBe('REJECTED');
    expect(judgePath(path('c', { TIME: 'UNKNOWN' })).standing).toBe('OPEN');
    expect(judgePath(path('d', { AUTHORITY: 'NEEDS_PERSON' })).standing).toBe('QUALIFIES');
  });

  it('researches only the leading path’s first open test, and nothing once one qualifies', () => {
    const open = decide([path('far', { DEMAND: 'UNKNOWN' }), path('near', { TIME: 'UNKNOWN' })]);
    expect(open.verdict).toBe('NO_PATH_QUALIFIES');
    expect(open.leading?.ref).toBe('near');
    expect(open.nextStepPath).toBe('near');
    expect(open.nextStep?.serves).toBe('TIME');
    expect(open.alternatives[0]?.whyLower).toMatch(/stops earlier/);

    const done = decide([path('ready', {}), path('near', { TIME: 'UNKNOWN' })]);
    expect(done.verdict).toBe('RECOMMEND');
    expect(done.nextStep?.kind).not.toBe('QUALIFY_OPENING');
  });

  it('stops rather than filling an empty shortlist', () => {
    const none = decide([path('closed', { TIME: 'NOT_MET' })]);
    expect(none.verdict).toBe('STOP');
    expect(none.leading).toBeNull();
    expect(none.rejected).toHaveLength(1);
    expect(none.nextStep).toBeNull();
  });
});

describe('the journey, from a question in Russell to a changed recommendation', () => {
  it('answers with a brief, rejects on evidence, steers research, and reports the result back', async () => {
    // Three openings shaped like the ones the production sprint holds.
    const transcription = await opening({
      title: 'GoTranscript publishes per-minute pricing for standard English transcription',
      signal: 'GoTranscript publishes per-minute pricing for standard English audio-to-text transcription.',
      observed: '2026-09-15',
      opportunitySignal: 'PRICING_OR_INFORMATION_ASYMMETRY',
    });
    const closedRfq = await opening({
      title: 'NJDOH RFQ for preventative maintenance',
      signal: 'NJDOH has an open, currently-accepting solicitation for preventative maintenance.',
      observed: '2026-09-11',
      opportunitySignal: 'PAID_TASK_OR_CONTRACT',
      patch: { expires_at: '2026-09-20T00:00:00.000Z', expiry_reason: 'The RFQ response deadline.' },
    });
    const domain = await opening({
      title: 'VJN.com listed below its appraisal',
      signal: 'Appraise.net valued VJN.com at $55,000-$85,000, above its $39,000 Afternic asking price.',
      observed: '2026-09-14',
      opportunitySignal: 'RESALABLE_ASSET_OPENING',
      patch: { peak_funding_cents: 3_900_000 },
    });

    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'Cash',
      projectId,
      visibility: 'PRIVATE',
    });

    // 1. The question, answered in the request that asked it.
    const started = await ask(conversation.id, 'Looking at everything the sprint has found, what can we actually do?');
    expect(started.ok).toBe(true);
    expect(started.binId).toBeNull();
    const answer = started.pendingMessage!;
    expect(answer.status).toBe('COMPLETE');
    expect(answer.content).toContain('recorded on this project’s Cash Mode sprint');
    expect(answer.produced?.['objectiveId']).toBeTruthy();

    const [objective] = await listObjectives({ projectId });
    expect(objective!.sourceKind).toBe('CASH_MODE');
    expect(objective!.statement).toBe(OBJECTIVE);

    const first = (await composeBrief(objective!)).brief;
    expect(first.verdict).toBe('NO_PATH_QUALIFIES');
    // Rejected for evidenced reasons, each naming the row that decided it.
    const rejected = new Map(first.rejected.map((one) => [one.ref, one]));
    const rfq = rejected.get(`CASH_OPPORTUNITY:${closedRfq}`)!;
    expect(rfq.because).toMatch(/closed on 2026-09-20/);
    expect(rfq.tests.find((one) => one.criterion === 'TIME')?.kind).toBe('MEASURED');
    const asset = rejected.get(`CASH_OPPORTUNITY:${domain}`)!;
    expect(asset.because).toMatch(/USD 39,000\.00 committed before any money arrives, and USD 0\.00 may be committed now/);
    // The one live path leads, stopping at who would pay *us*.
    expect(first.leading?.ref).toBe(`CASH_OPPORTUNITY:${transcription}`);
    expect(first.leading?.tests.find((one) => one.criterion === 'REACH')?.reading).toBe('UNKNOWN');
    // Unknowns are shown as unknown, never as figures.
    expect(first.leading?.economics.every((one) => one.value !== null || one.kind === 'UNKNOWN')).toBe(true);
    expect(answer.content).toContain('Rejected (2)');
    expect(answer.content).toContain('What needs a person or an integration');

    // 2. The step became work: the existing deep dive, steered and started.
    const steps = await listSteps(objective!.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe('QUALIFY_OPENING');
    expect(steps[0]!.workRef).toBe(transcription);
    expect(await steeredOpenings(projectId)).toEqual([transcription]);
    const dived = await getOpportunity(transcription);
    expect(dived!.validationState).toBe('PENDING');
    expect(dived!.candidateId).toBeTruthy();
    // Research on the rejected paths was not started.
    expect((await getOpportunity(domain))!.validationState).toBeNull();
    expect(first.currentStep?.status).toBe('RUNNING');

    // Asking again reuses the objective, the step and the dive.
    await ask(conversation.id, 'What should we do?');
    expect(await listObjectives({ projectId })).toHaveLength(1);
    expect(await listSteps(objective!.id)).toHaveLength(1);

    // 3. The deep dive's answers arrive where the gate writes them — every
    //    question Cash's own qualification standard asks, and the card.
    await updateOpportunity(transcription, {
      payer: 'Podcast producers who post transcription jobs on Upwork',
      reachable_channel: 'Upwork job posts in the transcription category',
      offer_scope: 'Corrected English transcripts of podcast audio, up to 60 minutes per job',
      acceptance_condition: 'The client accepts the file on the job thread',
      price_cents: 90,
      fulfillment_owner: 'The owner, with an ASR draft corrected by hand',
      delivery_method: 'A corrected transcript file delivered on the job thread',
      peak_funding_cents: 0,
      deadline: '2026-10-15',
      validation_state: 'COMPLETE',
      validation_settled_at: '2026-09-23T10:00:00.000Z',
    });
    const signal = (await getOpportunity(transcription))!.opportunitySignal;
    for (const field of new Set([CAPTURE_KEY, ...qualificationKeys(signal)])) {
      await recordCardFact({
        projectId,
        opportunityId: transcription,
        field,
        kind: 'EVIDENCE',
        value:
          field === 'directCosts'
            ? 'USD 0.10 per audio minute for the ASR draft.'
            : field === 'revenueRange'
              ? 'USD 0.80 to 1.50 per audio minute on posted jobs.'
              : `The deep dive's sourced answer to ${field}.`,
        claimId: `clm_${field}`,
        decidedBy: 'BRAIN',
      } as never);
    }

    // 4. The tick re-decides and reports the change in the conversation.
    const passed = await advanceObjectives();
    expect(passed.map((one) => one.objectiveId)).toContain(objective!.id);
    const now = (await composeBrief(objective!)).brief;
    expect(now.verdict).toBe('RECOMMEND');
    expect(now.leading?.ref).toBe(`CASH_OPPORTUNITY:${transcription}`);
    expect(now.proposedStep?.kind).toBe('COMMERCIAL_ACTION');
    // No grant and no messaging integration: prepared, never performed.
    expect(now.proposedStep?.authority).toBe('NEEDS_PERSON');
    expect(now.proposedStep?.boundary).toMatch(/commercial grant/);
    expect(now.proposedStep?.prepared?.['action']).toBe('CONTACT_BUYER');

    const history = await listDecisions(objective!.id);
    expect(history.map((one) => one.verdict)).toEqual(['NO_PATH_QUALIFIES', 'RECOMMEND']);
    expect(history[1]!.changedBecause).toMatch(/deep dive settled complete/);

    const turns = await listTurns(conversation.id, 50);
    const report = turns[turns.length - 1]!;
    expect(report.role).toBe('RUSSELL');
    expect(report.content).toMatch(/The recommendation for .* changed/);
    expect(report.content).toMatch(/Do this: /);

    // A second pass with nothing new says nothing.
    await advanceObjective(objective!.id);
    expect(await listDecisions(objective!.id)).toHaveLength(2);

    // 5. A person sets a grant: the boundary moves to the one thing left.
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
    const granted = (await composeBrief(objective!)).brief;
    expect(granted.proposedStep?.boundary).not.toMatch(/commercial grant/);
    expect(granted.proposedStep?.boundary).toMatch(/cannot send a message itself/);
  });

  it('announces one change once, however many passes notice it at the same time', async () => {
    const only = await opening({
      title: 'A published request for data entry',
      signal: 'A client posted a paid data-entry job with a stated budget.',
      observed: '2026-09-15',
      opportunitySignal: 'PAID_TASK_OR_CONTRACT',
      patch: { expires_at: '2026-12-01T00:00:00.000Z' },
    });
    const conversation = await createConversation({ ownerUserId: userId, title: 'Race', projectId, visibility: 'PRIVATE' });
    await ask(conversation.id, 'What can we actually do?');
    const [objective] = await listObjectives({ projectId });
    expect(await listDecisions(objective!.id)).toHaveLength(1);

    // The one live path's window closes: the recommendation changes to a stop.
    await updateOpportunity(only, { expires_at: '2026-09-01T00:00:00.000Z' });
    const before = (await listTurns(conversation.id, 50)).length;
    await Promise.all([advanceObjective(objective!.id), advanceObjective(objective!.id), advanceObjective(objective!.id)]);

    const history = await listDecisions(objective!.id);
    expect(history.map((one) => one.verdict)).toEqual(['NO_PATH_QUALIFIES', 'STOP']);
    const after = await listTurns(conversation.id, 50);
    expect(after.length - before).toBe(1);
    expect(after[after.length - 1]!.content).toMatch(/closed on 2026-09-01/);
  });

  it('asks for the objective when nothing records one, and takes the answer', async () => {
    const other = await freshProject();
    const plain = other.project.id;
    await grantMembership({
      projectId: plain,
      principalType: 'HUMAN',
      principalId: userId,
      role: 'OWNER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    // freshProject re-seeds; recreate the user row the test uses.
    const user = await createUser({
      email: `plain-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Plain',
      password: 'correct horse battery staple',
    });
    userId = user.id;
    await grantMembership({
      projectId: plain,
      principalType: 'HUMAN',
      principalId: userId,
      role: 'OWNER',
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const conversation = await createConversation({ ownerUserId: userId, title: 'Film', projectId: plain, visibility: 'PRIVATE' });
    const first = await ask(conversation.id, 'What can we actually do?');
    expect(first.pendingMessage!.content).toMatch(/What are you trying to achieve/);
    expect(await listObjectives({ projectId: plain })).toHaveLength(0);

    const idea = await captureCandidate(plain, conversation.id);
    const second = await ask(conversation.id, 'Our goal is to finish and submit a ten-minute documentary short.');
    expect(second.pendingMessage!.produced?.['objectiveId']).toBeTruthy();
    const [objective] = await listObjectives({ projectId: plain });
    expect(objective!.sourceKind).toBe('CONVERSATION');
    expect(objective!.statement).toBe('finish and submit a ten-minute documentary short');
    const brief = (await composeBrief(objective!)).brief;
    // Not a revenue objective: nothing about it is a revenue calculation.
    expect(brief.context.revenue).toBe(false);
    expect(brief.leading?.ref).toBe(`IDEA:${idea}`);
    expect(brief.leading?.tests.find((one) => one.criterion === 'DEMAND')?.reading).toBe('NOT_APPLICABLE');
  });
});
