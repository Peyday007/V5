/**
 * The foundations under the production screenshots.
 *
 * Every case here is a *defect that was reproducible in production on
 * 2026-09-21*, asserted as an absence rather than as a success — because each
 * one passed every test that existed at the time. The readings they are written
 * against are the report the closeout took before anything was changed:
 *
 *   opportunities=40 signals=40 candidates=0 qualified=0 ready=0 validations=2
 *   usr_14439966398243339341 PERSON ADMIN signs-in=pin rosserpeyton@gmail.com
 *   Brain Research A ENABLED ref=trig_01CBLu5o… worker=wkr_1cdd82… fires=350
 *   cop_b1eb51e4932c43528d39 validation=RUNNING … mission=NEEDS_HUMAN
 *   cop_00ece786785648e384a4 validation=RUNNING … mission=NEEDS_HUMAN
 *
 * Several assertions were run against the un-fixed behaviour first, to watch
 * them fail: a regression test nobody has seen fail is a claim rather than a
 * reading.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { fact, qualifyingFacts, tiersFor } from './helpers/cashTier.ts';
import { assemble, isWorkable, placements } from '../server/services/cash/portfolio.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashTier } from '../server/services/cash/tier.ts';
import { looksLikeAddress, personName, refuseAddressAsName } from '../server/domain/personName.ts';
import { collectionNameFor } from '../server/services/russell/collections.ts';
import { titleFrom } from '../server/services/russell/turn.ts';
import { createUser, createWorker, getUser, renameUser } from '../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createConversation, getConversation } from '../server/repos/russellConversations.ts';
import { adoptSurface } from '../server/services/capacity/adopt.ts';
import {
  MAX_VALIDATIONS_IN_FLIGHT,
  MAX_VALIDATION_ROUNDS,
  VALIDATION_STALL_MS,
  settleValidations,
  sprintCanRefine,
  startValidations,
  whyNotDiving,
} from '../server/services/cash/validation.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import {
  createOpportunity,
  getOpportunity,
  listOpportunities,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { OPPORTUNITY_VALIDATION_STATES } from '../server/domain/types.ts';
import type { PortfolioInput } from '../server/services/cash/portfolio.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

const NOW = '2026-09-21T02:16:00.000Z';

function opportunity(overrides: Partial<CashOpportunity> = {}): CashOpportunity {
  return {
    id: `cop_${Math.random().toString(36).slice(2, 12)}`,
    projectId: 'prj_1',
    cashModeId: 'csm_1',
    ownerUserId: 'usr_1',
    title: 'An opening',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    industryNodeId: null,
    industry: null,
    source: null,
    candidateId: null,
    externalRecordId: null,
    sourceClaimId: null,
    discoveredByCandidateId: null,
    orchestrationId: null,
    fragmentId: null,
    discoveryRoundId: null,
    validationOrchestrationId: null,
    validationState: null,
    validationStartedAt: null,
    validationSettledAt: null,
    validationRounds: 0,
    opportunitySignal: null,
    state: 'DISCOVERED',
    currency: 'USD',
    payer: null,
    offerScope: null,
    acceptanceCondition: null,
    priceCents: null,
    deliveryMethod: null,
    fulfillmentOwner: null,
    economicsNote: null,
    peakFundingCents: null,
    humanHours: null,
    buyingSignal: null,
    signalObservedAt: null,
    reachableChannel: null,
    requiredCapabilities: [],
    dependsOnId: null,
    deadline: null,
    expiresAt: null,
    expiryReason: null,
    exhaustedAt: null,
    exhaustedReason: null,
    nextAction: null,
    outcome: null,
    archivedReason: null,
    declinedReason: null,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  } as CashOpportunity;
}

/**
 * The two records the owner actually saw, as rows.
 *
 * A published per-minute price from one vendor and a published per-minute price
 * from another, gated, sourced and dated — and neither of them says anybody
 * would pay *us*, which is what `PRICING_OR_INFORMATION_ASYMMETRY` declares in
 * `SIGNAL_MEANING`.
 */
function vendorPriceEvidence(): CashOpportunity[] {
  return [
    opportunity({
      id: 'cop_rev',
      title:
        'Rev.com publishes a per-minute price of $1.99 for its human transcription service',
      opportunitySignal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      buyingSignal: 'Rev.com publishes $1.99 per minute on its own pricing page.',
      signalObservedAt: '2026-09-18',
      sourceClaimId: 'clm_883cb54de2d849f58743',
    }),
    opportunity({
      id: 'cop_gotranscript',
      title: 'GoTranscript publishes per-minute pricing for standard English transcription',
      opportunitySignal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      buyingSignal: 'GoTranscript publishes a per-minute rate on its own pricing page.',
      signalObservedAt: '2026-09-18',
      sourceClaimId: 'clm_0b05d53065c746978edb',
    }),
  ];
}

/**
 * The plan, with **no** card facts unless a case supplies them.
 *
 * `tiersFor`'s own default is `qualifyingFacts`, which answers every question
 * a piece's kind asks — right for the suites that predate the tier boundary and
 * exactly wrong here, where the whole subject is a piece that has answered
 * nothing. A fixture that qualified itself would assert against a
 * classification production could not produce.
 */
function plan(
  opportunities: CashOpportunity[],
  facts: CashCardFact[] = [],
  overrides: Partial<PortfolioInput> = {},
): ReturnType<typeof assemble> {
  const byId = new Map<string, CashCardFact[]>();
  for (const one of facts) {
    byId.set(one.opportunityId, [...(byId.get(one.opportunityId) ?? []), one]);
  }
  return assemble({
    opportunities,
    tiers: tiersFor(opportunities, (one) => byId.get(one.id) ?? []),
    deployableCents: 500_000,
    maxConcurrent: 3,
    discoveryOpen: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// A. Evidence is never work, never waiting, and never in the aggregate
// ---------------------------------------------------------------------------

describe('a pair of vendor price claims is not a piece of work', () => {
  it('appears in neither current work nor waiting', () => {
    const assembled = plan(vendorPriceEvidence());

    expect(assembled.executeNow).toHaveLength(0);
    expect(assembled.waiting).toHaveLength(0);
    // And it is not hidden either: it is evidence, named as evidence.
    expect(assembled.evidence.map((one) => one.opportunity.id).sort()).toEqual([
      'cop_gotranscript',
      'cop_rev',
    ]);
    expect(assembled.evidence.every((one) => one.disposition === 'EVIDENCE_ONLY')).toBe(true);
  });

  it('contributes nothing to the combined conservative contribution', () => {
    /*
     * With prices on both and no exposure established, the old arithmetic made
     * this the *sum of two vendors' published prices* and called it what the
     * sprint would contribute. There is no work here, so there is no total.
     */
    const priced = vendorPriceEvidence().map((one) =>
      opportunity({ ...one, priceCents: 199_00, peakFundingCents: null }),
    );
    expect(plan(priced).combinedContributionCents).toBeNull();
  });

  it('is never offered as one of the best opportunities', () => {
    const assembled = plan(vendorPriceEvidence());
    expect(assembled.best).toHaveLength(0);
    expect(assembled.bestAreNearlyQualified).toBe(false);
  });

  it('cannot become work by having a capture thesis alone', () => {
    /*
     * A capture thesis makes it a CANDIDATE — Brain can say how money would be
     * made — and that is Brain's work rather than the person's. The prompt's
     * own definition is the qualification set: a buyer, a payer, a capture
     * path, a fulfilment path, economics, timing and a decisive unknown.
     */
    const [rev] = vendorPriceEvidence();
    const facts = ['captureMechanism', 'payer', 'access', 'buyingEvidence'].map((key) =>
      fact(rev!, key),
    );
    const assembled = plan([rev!], facts);

    expect(assembled.byTier.CANDIDATE).toBe(1);
    expect(assembled.executeNow).toHaveLength(0);
    expect(assembled.waiting).toHaveLength(0);
    expect(assembled.beingQualified.map((one) => one.disposition)).toEqual(['BEING_QUALIFIED']);
  });

  it('becomes work at exactly the point the whole contract is answered', () => {
    const [rev] = vendorPriceEvidence();
    const ready = opportunity({
      ...rev!,
      payer: 'A named buyer',
      offerScope: 'A bounded deliverable',
      acceptanceCondition: 'What counts as done',
      priceCents: 120_00,
      deliveryMethod: 'How it is delivered',
      fulfillmentOwner: 'Who does it',
      economicsNote: 'What is left after costs',
      peakFundingCents: 20_00,
      reachableChannel: 'A published route to them',
      buyingSignal: rev!.buyingSignal,
      signalObservedAt: rev!.signalObservedAt,
    });
    const assembled = plan([ready], qualifyingFacts(ready));

    expect(['QUALIFIED', 'READY_TO_TEST']).toContain(assembled.placements[0]!.tier.tier);
    expect(assembled.executeNow.length + assembled.waiting.length).toBe(1);
    // And now there is something to total, so the aggregate exists.
    expect(assembled.combinedContributionCents).toBe(100_00);
  });

  it('keeps a piece somebody took, whatever its evidence says', () => {
    /*
     * The half this must not get wrong. `READY` is reached only through
     * `markReady` and the executing states only through a recorded action, so
     * removing one from the work list because the engine card is thin would be
     * a derivation overruling a person's decision.
     */
    expect(isWorkable({ tier: 'SIGNAL', state: 'READY' })).toBe(true);
    expect(isWorkable({ tier: 'SIGNAL', state: 'EXECUTING' })).toBe(true);
    expect(isWorkable({ tier: 'SIGNAL', state: 'COLLECTED' })).toBe(true);
    expect(isWorkable({ tier: 'SIGNAL', state: 'DISCOVERED' })).toBe(false);
    expect(isWorkable({ tier: 'CANDIDATE', state: 'EVIDENCE_CARD' })).toBe(false);
    expect(isWorkable({ tier: 'QUALIFIED', state: 'DISCOVERED' })).toBe(true);
  });

  it('says of forty signals exactly what production held, and no more', () => {
    /*
     * The shape of the production reading, at its own size: forty records, all
     * of them evidence, and a page that told a person `1 to act on now, 40
     * waiting`.
     */
    const forty = Array.from({ length: 40 }, (_, index) =>
      opportunity({
        id: `cop_${index}`,
        opportunitySignal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      }),
    );
    const assembled = plan(forty);
    expect(assembled.byTier.SIGNAL).toBe(40);
    expect(assembled.executeNow).toHaveLength(0);
    expect(assembled.waiting).toHaveLength(0);
    expect(assembled.evidence).toHaveLength(40);
    expect(assembled.combinedContributionCents).toBeNull();
  });

  it('never tells a person a signal is waiting on a decisive unknown', () => {
    /*
     * The sentence matters as much as the list. "Four things on this card are
     * unknown" about a published price list is homework, and the whole point
     * of the correction is to stop handing it out.
     */
    const placed = placements({
      opportunities: vendorPriceEvidence(),
      tiers: tiersFor(vendorPriceEvidence(), () => []),
      deployableCents: 0,
      maxConcurrent: 1,
      discoveryOpen: true,
    });
    for (const one of placed) {
      expect(one.disposition).toBe('EVIDENCE_ONLY');
      expect(one.because).toContain('evidence, not work');
    }
  });
});

// ---------------------------------------------------------------------------
// B. A person is called something, and it is not their address
// ---------------------------------------------------------------------------

describe('the owner is a person rather than a login', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('never shows an address where a name belongs', () => {
    expect(personName({ displayName: 'rosserpeyton@gmail.com' })).toBe('rosserpeyton');
    expect(personName({ displayName: 'Peyton' })).toBe('Peyton');
    // A name somebody chose that merely contains an @ is left exactly as it is.
    expect(personName({ displayName: 'DJ @ Night' })).toBe('DJ @ Night');
    expect(personName({ displayName: '  ' })).toBe('Someone');
  });

  it('is narrow about what counts as an address', () => {
    expect(looksLikeAddress('a@b.com')).toBe(true);
    expect(looksLikeAddress('@handle')).toBe(false);
    expect(looksLikeAddress('a@b')).toBe(false);
    expect(looksLikeAddress('a@@b.com')).toBe(false);
    expect(looksLikeAddress('Alex Smith')).toBe(false);
  });

  it('refuses an address at the door that writes a name', () => {
    expect(() => refuseAddressAsName('someone@example.com')).toThrow(/not their address/);
    expect(() => refuseAddressAsName('Peyton')).not.toThrow();
  });

  it('carries the renamed owner rather than the address, and changes nothing else', async () => {
    const owner = await createUser({
      email: 'rosserpeyton@example.com',
      displayName: 'rosserpeyton@example.com',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    expect(personName(owner)).toBe('rosserpeyton');

    await renameUser(owner.id, 'Peyton');
    const after = await getUser(owner.id);

    expect(after!.displayName).toBe('Peyton');
    expect(personName(after!)).toBe('Peyton');
    // The address, the administration flag and the id are all untouched: a
    // rename is a fact about presentation and nothing else.
    expect(after!.email).toBe('rosserpeyton@example.com');
    expect(after!.isBrainAdmin).toBe(true);
    expect(after!.id).toBe(owner.id);
  });

  it('keeps two members two people', async () => {
    const one = await createUser({
      email: 'airyn@example.com',
      displayName: 'Airyn',
      password: 'a-long-enough-password',
    });
    const two = await createUser({
      email: 'caleb@example.com',
      displayName: 'Caleb',
      password: 'a-long-enough-password',
    });
    expect(one.id).not.toBe(two.id);
    expect(personName(one)).toBe('Airyn');
    expect(personName(two)).toBe('Caleb');
    // Renaming one leaves the other exactly as it was, including its own
    // credential state: identity is per account and is never inherited.
    await renameUser(one.id, 'Airyn R');
    expect((await getUser(two.id))!.displayName).toBe('Caleb');
    expect((await getUser(two.id))!.pinUpdatedAt).toBe(one.pinUpdatedAt);
  });
});

// ---------------------------------------------------------------------------
// D. A general thread is not a deal
// ---------------------------------------------------------------------------

describe('a conversation is filed by what it is for', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('never files a general thread under a project', () => {
    expect(collectionNameFor({ projectName: 'Deal Dispatch', visibility: 'PRIVATE' })).toEqual({
      name: 'Deal Dispatch',
      kind: 'PROJECT',
    });
    // The same row, with the purpose it actually has.
    expect(
      collectionNameFor({ projectName: 'Deal Dispatch', visibility: 'PRIVATE', purpose: 'GENERAL' }),
    ).toEqual({ name: 'Personal', kind: 'PERSONAL' });
    expect(
      collectionNameFor({ projectName: 'Deal Dispatch', visibility: 'SHARED', purpose: 'GENERAL' }),
    ).toEqual({ name: 'Unfiled', kind: 'CATEGORY' });
    expect(
      collectionNameFor({ projectName: 'Deal Dispatch', visibility: 'PRIVATE', purpose: 'PROJECT' }),
    ).toEqual({ name: 'Deal Dispatch', kind: 'PROJECT' });
  });

  it('creates an ordinary thread general and unattached', async () => {
    const owner = await createUser({
      email: 'threads@example.com',
      displayName: 'Threads',
      password: 'a-long-enough-password',
    });
    const thread = await createConversation({
      ownerUserId: owner.id,
      title: 'Conversation — Sep 21, 02:14',
    });
    expect(thread.projectId).toBeNull();
    expect(thread.purpose).toBe('GENERAL');
    expect(thread.attachmentSource).toBe('NONE');
  });

  it('says both things at once when a project is chosen, rather than disagreeing', async () => {
    const fixture = await freshProject();
    const owner = await createUser({
      email: 'deal@example.com',
      displayName: 'Deal',
      password: 'a-long-enough-password',
    });
    const thread = await createConversation({
      ownerUserId: owner.id,
      title: 'About a deal',
      projectId: fixture.project.id,
    });
    expect(thread.projectId).toBe(fixture.project.id);
    expect(thread.purpose).toBe('PROJECT');
    // The column that used to say `NONE` on a row carrying a project.
    expect(thread.attachmentSource).toBe('USER');
    expect((await getConversation(thread.id))!.purpose).toBe('PROJECT');
  });

  it('names a thread after what was said in it rather than "New conversation"', () => {
    expect(titleFrom('Can you look at the pricing page? It looks wrong.')).toBe(
      'Can you look at the pricing page?',
    );
    expect(titleFrom('  Fix   the   footer  ')).toBe('Fix the footer');
    // A long opening sentence is clamped rather than truncated mid-word count.
    const long = titleFrom(`${'word '.repeat(40)}end.`);
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. The connection reports the surface that is actually there
// ---------------------------------------------------------------------------

describe('an already-registered surface can be recorded as somebody’s', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('refuses a Routine reference that names nothing, and says what to do', async () => {
    const person = await createUser({
      email: 'adopt@example.com',
      displayName: 'Adopter',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const outcome = await adoptSurface({
      userId: person.id,
      routineRef: 'trig_does_not_exist',
      actorUserId: person.id,
      channel: 'SHELL',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('register-routine');
  });

  it('refuses a person who does not exist without creating anything', async () => {
    const outcome = await adoptSurface({
      userId: 'usr_nobody',
      routineRef: 'trig_whatever',
      actorUserId: 'usr_nobody',
    });
    expect(outcome.ok).toBe(false);
  });

  it('records the surface, idempotently, and never as healthy', async () => {
    /*
     * The production shape: `Brain Research A`, its real trigger reference and
     * its real deployment secret, bound to a worker, registered long before
     * anybody's connection journey existed.
     */
    const owner = await createUser({
      email: 'owner-adopt@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const worker = await createWorker({
      name: 'brain-worker',
      displayName: 'Brain worker',
      createdByType: 'HUMAN',
      createdById: owner.id,
    });
    const account = await createAccount({ name: 'primary', declaredPlanPower: null });
    const routine = await createRoutine({
      accountId: account.id,
      name: 'Brain Research A',
      routineRef: 'trig_01CBLu5oCZziEwznw5q9xU7g',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
      tokenDigest: 'a'.repeat(64),
      capabilities: [],
    });
    await bindRoutineWorker(routine.id, worker.id);

    const first = await adoptSurface({
      userId: owner.id,
      routineRef: 'trig_01CBLu5oCZziEwznw5q9xU7g',
      actorUserId: owner.id,
      channel: 'SHELL',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.alreadyAdopted).toBe(false);
    expect(first.connection.workerId).toBe(worker.id);
    // The Routine's own names, not the ones `namesFor` would have derived: an
    // administrator set that secret, and pointing a screen at a variable
    // nothing reads is worse than no screen.
    expect(first.connection.routineName).toBe('Brain Research A');
    expect(first.connection.secretName).toBe('BRAIN_ROUTINE_TOKEN');
    expect(first.connection.triggerRef).toBe('trig_01CBLu5oCZziEwznw5q9xU7g');
    /*
     * CONFIGURED, and never HEALTHY from somebody's say-so. Healthy is the
     * four-row chain, read by `reconcile` on the next view.
     */
    expect(first.connection.state).toBe('CONFIGURED');

    const again = await adoptSurface({
      userId: owner.id,
      routineRef: 'trig_01CBLu5oCZziEwznw5q9xU7g',
      actorUserId: owner.id,
      channel: 'SHELL',
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.alreadyAdopted).toBe(true);

    // The account foundation reads the adopted worker, as the connection page
    // does. By derived name alone it said "no worker identity exists" about a
    // connection production showed passing one line above (§44).
    const { foundationReading } = await import('../server/services/identity/foundation.ts');
    const mine = (await foundationReading()).accounts.find((one) => one.userId === owner.id)!;
    const attribution = mine.findings.find((one) => one.dimension === 'WORKER_ATTRIBUTION')!;
    expect(attribution.because).not.toMatch(/No worker identity named/);

    // And a surface belongs to one person.
    const other = await createUser({
      email: 'member-adopt@example.com',
      displayName: 'Airyn',
      password: 'a-long-enough-password',
    });
    const taken = await adoptSurface({
      userId: other.id,
      routineRef: 'trig_01CBLu5oCZziEwznw5q9xU7g',
      actorUserId: owner.id,
      channel: 'SHELL',
    });
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.reason).toContain('already recorded as somebody else');
  });

  /**
   * Every reader of "which worker is this connection" reads the binding.
   *
   * The repair started as one line inside the member's own read path, and a
   * merge with the work-register branch showed why that was not enough: the
   * same question is asked in three places — settling a connection, registering
   * its Routine, and **revoking it** — and all three resolved a worker by
   * composing the member's display name.
   *
   * The third is the one with teeth. `revoke` looks a worker up in order to
   * revoke its tokens, so a name-only lookup there leaves an adopted surface's
   * credentials live after somebody has taken their connection back — the
   * failure being silent and in the unsafe direction. So it is one `workerFor`
   * with three callers, and this asserts the property at the caller where being
   * wrong costs something rather than at the one where it only misinforms.
   */
  it('reaches an adopted worker from every reader, including the one that revokes', async () => {
    const { connectionForUser } = await import('../server/repos/capacityConnections.ts');
    const { revokeOwnConnection, settleConnection } = await import(
      '../server/services/capacity/connection.ts'
    );
    const { listTokensForWorker } = await import('../server/repos/oauth.ts');

    const person = await createUser({
      email: 'adopted-revoke@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
    });
    /*
     * A worker whose name is deliberately nothing `namesFor` would ever
     * derive — which is the whole production shape: four Routines registered
     * on a terminal years before this journey existed.
     */
    const worker = await createWorker({
      name: 'research-registered-on-a-terminal',
      displayName: 'Registered on a terminal',
      createdByType: 'HUMAN',
      createdById: person.id,
    });
    const account = await createAccount({ name: 'primary-revoke', declaredPlanPower: null });
    const routine = await createRoutine({
      accountId: account.id,
      name: 'Brain Research A',
      routineRef: 'trig_adopted_revoke',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
      tokenDigest: 'b'.repeat(64),
      capabilities: [],
    });
    await bindRoutineWorker(routine.id, worker.id);
    await adoptSurface({
      userId: person.id,
      routineRef: 'trig_adopted_revoke',
      actorUserId: person.id,
      channel: 'SHELL',
    });

    // The settler finds it by the row rather than by a name it cannot guess.
    const settled = await settleConnection(person);
    expect(settled.worker?.id).toBe(worker.id);

    const before = await listTokensForWorker(worker.id);
    const outcome = await revokeOwnConnection({
      user: person,
      actor: person,
      reason: 'a different Claude account',
      origin: 'https://brain.invalid',
    });
    expect(outcome.ok).toBe(true);

    // Whatever this worker held is revoked, because revoke found the worker.
    const after = await listTokensForWorker(worker.id);
    expect(after.length).toBe(before.length);
    expect(after.every((one) => one.revokedAt !== null)).toBe(true);

    const row = await connectionForUser(person.id);
    expect(row?.state).toBe('REVOKED');
    // And the binding is history rather than something a revoke destroys.
    expect(row?.workerId).toBe(worker.id);
  });
});

// ---------------------------------------------------------------------------
// F. A deep dive that is parked is not a deep dive that is running
// ---------------------------------------------------------------------------

describe('the refinement lifecycle is bounded and says what it is doing', () => {
  it('has a state for a dive waiting on a person, and it is not RUNNING', () => {
    expect(OPPORTUNITY_VALIDATION_STATES).toContain('NEEDS_PERSON');
    // The ordering matters to nobody and the membership matters to the
    // in-flight count, which is what deadlocked production.
    expect(OPPORTUNITY_VALIDATION_STATES).toContain('RUNNING');
    expect(OPPORTUNITY_VALIDATION_STATES).toContain('BLOCKED');
  });

  it('bounds a dive that never progresses, rather than holding a slot for ever', () => {
    // A number rather than a comment: the report prints it, and a stall
    // longer than this is what frees the slot.
    expect(VALIDATION_STALL_MS).toBeGreaterThan(60 * 60 * 1000);
    expect(MAX_VALIDATIONS_IN_FLIGHT).toBeGreaterThan(0);
  });

  /**
   * One deep dive, as rows, in whatever state the case needs.
   *
   * The real repositories rather than hand-written SQL, so a case asserts
   * against what `settleValidations` will actually read: an opportunity whose
   * `candidate_id` names a candidate, a mission for that candidate, and the
   * orchestration the mission names.
   */
  async function dive(input: {
    projectId: string;
    ownerUserId: string;
    cashModeId: string;
    missionState: 'RUNNING' | 'DONE' | 'NEEDS_HUMAN';
    startedAt: string;
  }): Promise<string> {
    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      title: 'Qualify: an opening',
      statement: 'Who pays, what it pays, what it costs and what would rule it out.',
    });
    const { mission } = await launchMission({
      projectId: input.projectId,
      visibility: 'SHARED',
      objective: 'Qualify one opening.',
      whyNow: 'It was harvested.',
      idempotencyKey: `idem_${candidate.id}`,
      candidateId: candidate.id,
    });
    /*
     * Deliberately no orchestration linked.
     *
     * `settleValidations` reads one only for the *reason* on a park or a
     * block, and tolerates its absence — so leaving it out keeps the fixture
     * to the rows these two cases are actually about: an opportunity, its
     * candidate, and the mission's state.
     */
    // A mission is born `PLANNED`; `RUNNING` is the state a worker takes it to.
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    if (input.missionState !== 'RUNNING') {
      await transitionMission({
        missionId: mission.id,
        from: 'RUNNING',
        to: input.missionState,
        ...(input.missionState === 'NEEDS_HUMAN'
          ? { waitingOn: 'A decision only a person can make.' }
          : {}),
      });
    }
    const opportunity = await createOpportunity({
      projectId: input.projectId,
      cashModeId: input.cashModeId,
      ownerUserId: input.ownerUserId,
      title: 'An opening a deep dive was launched for',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    await updateOpportunity(opportunity.id, {
      candidate_id: candidate.id,
      validation_state: 'RUNNING',
      validation_started_at: input.startedAt,
      validation_rounds: 1,
    });
    return opportunity.id;
  }

  it('parks a dive whose mission stopped at a person, and frees its slot', async () => {
    const fixture = await freshProject();
    const owner = await createUser({
      email: 'dive@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const started = await activate({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const parked = await dive({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      cashModeId: started.mode.id,
      missionState: 'NEEDS_HUMAN',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const settled = await settleValidations(fixture.project.id);
    expect(settled).toContainEqual({ opportunityId: parked, to: 'NEEDS_PERSON' });
    const after = await getOpportunity(parked);
    expect(after!.validationState).toBe('NEEDS_PERSON');
    /*
     * And the slot is free, which is the whole repair: `RUNNING` counted
     * against `MAX_VALIDATIONS_IN_FLIGHT` and production had both of its two
     * held by parked missions.
     */
    const live = (await listOpportunities({ projectId: fixture.project.id })).filter(
      (one) => one.validationState === 'PENDING' || one.validationState === 'RUNNING',
    );
    expect(live).toHaveLength(0);
  });

  it('never blocks a dive whose mission has finished, however long the tick was down', async () => {
    /*
     * The ordering the stall backstop got wrong on its first write. A packet
     * that completed yesterday, read by a tick that came back today, has a
     * last pass older than the stall window — and settling it `BLOCKED` would
     * throw away a `COMPLETE` and the card facts taken from it. A backstop
     * that can destroy a result is worse than no backstop.
     */
    const fixture = await freshProject();
    const owner = await createUser({
      email: 'dive2@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const started = await activate({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    if (!started.ok) return;

    const finished = await dive({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      cashModeId: started.mode.id,
      missionState: 'DONE',
      // Well past VALIDATION_STALL_MS, and with no pass ever completed.
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const settled = await settleValidations(fixture.project.id);
    expect(settled).toContainEqual({ opportunityId: finished, to: 'COMPLETE' });
    expect((await getOpportunity(finished))!.validationState).toBe('COMPLETE');
  });

  it('derives a tier from the card rather than from the validation state', () => {
    /*
     * The two production records that were stuck: `validation=RUNNING` and
     * `answered=3/18`, `to advance: captureMechanism`. A dive being in flight
     * has never made a piece work, and this is what says so.
     */
    const [rev] = vendorPriceEvidence();
    const diving = opportunity({
      ...rev!,
      validationState: 'RUNNING',
      validationStartedAt: '2026-09-19T00:00:00.000Z',
      validationRounds: 1,
    });
    const reading = cashTier({
      opportunity: diving,
      card: cashEngineCard({ opportunity: diving, facts: [] }),
      readiness: evidenceCard(diving).readiness,
    });
    expect(reading.tier).toBe('SIGNAL');
    expect(reading.toAdvance.map((one) => one.key)).toEqual(['captureMechanism']);
    expect(plan([diving]).waiting).toHaveLength(0);
  });

  /**
   * Why nothing is being refined, read off the rows rather than counted.
   *
   * `passes 0/0` is a true statement about a packet and no statement at all
   * about whether the lifecycle is stuck, waiting on a person, or working
   * exactly as designed — and those three have three different remedies. What
   * makes the answer trustworthy is that it is not a second opinion:
   * `startValidations` is written in terms of `whyNotDiving`, so the reading a
   * report prints is the refusal that actually happened.
   *
   * These assert the *agreement* rather than either half. A test of the
   * derivation alone would pass over a producer that had quietly grown a
   * fourth condition of its own, which is the failure mode having one reader
   * exists to prevent.
   */
  it('names, per opening, the row-level reason it is not being qualified', async () => {
    const fixture = await freshProject();
    const owner = await createUser({
      email: 'why@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const started = await activate({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const make = async (
      title: string,
      patch: Record<string, unknown>,
    ): Promise<CashOpportunity> => {
      const made = await createOpportunity({
        projectId: fixture.project.id,
        cashModeId: started.mode.id,
        ownerUserId: owner.id,
        title,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: 'USD',
      });
      await updateOpportunity(made.id, patch);
      return (await getOpportunity(made.id))!;
    };

    // Four openings, four different reasons, all of them rows.
    const eligible = await make('has a published signal', {
      buying_signal: 'A county published a paid request on 2026-09-01.',
    });
    const silent = await make('nothing published to ask about', {});
    const spent = await make('both dives spent', {
      buying_signal: 'A published request.',
      validation_state: 'BLOCKED',
      validation_rounds: MAX_VALIDATION_ROUNDS,
    });
    const closed = await make('somebody declined it', {
      buying_signal: 'A published request.',
      state: 'DECLINED',
    });

    expect((await whyNotDiving(eligible)).kind).toBe('ELIGIBLE');
    expect((await whyNotDiving(silent)).kind).toBe('NOTHING_PUBLISHED_TO_ASK_ABOUT');
    expect((await whyNotDiving(spent)).kind).toBe('ROUNDS_SPENT');
    expect((await whyNotDiving(closed)).kind).toBe('NOT_A_QUALIFYING_STATE');

    /*
     * And the producer agrees, which is the assertion that matters.
     *
     * Exactly the opening the derivation called eligible is the one that
     * starts — not merely *an* opening, and not three of them.
     */
    const begun = await startValidations({ projectId: fixture.project.id });
    expect(begun.map((one) => one.opportunityId)).toEqual([eligible.id]);
  });

  /**
   * A dive that never became a mission held a slot with no bound at all.
   *
   * The stall backstop is guarded on `mission.state === 'RUNNING'`, and here
   * there is no mission — so `PENDING` counted against the two slots and
   * nothing in `settleValidations` could ever take one back. Found by reading
   * production rather than the code: the first causal reading of a live sprint
   * printed two `PENDING` dives holding both slots with `candidate=QUEUED
   * mission=—`, against four parked ones whose missions had appeared within
   * forty-four minutes.
   *
   * Asserted from both sides of the window, because a backstop that fires
   * early would cancel a dive whose candidate is simply still being judged —
   * which is the ordinary case and takes minutes.
   */
  it('frees a slot held by a dive that never became a mission, and not before', async () => {
    const fixture = await freshProject();
    const owner = await createUser({
      email: 'nomission@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const started = await activate({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    if (!started.ok) return;

    const launch = async (ago: number): Promise<string> => {
      // A candidate with no mission: exactly what an unjudged one looks like.
      const candidate = await createCandidate({
        projectId: fixture.project.id,
        visibility: 'SHARED',
        title: 'Qualify: an opening nobody has judged',
        statement: 'Who pays, what it pays, what it costs and what would rule it out.',
      });
      const made = await createOpportunity({
        projectId: fixture.project.id,
        cashModeId: started.mode.id,
        ownerUserId: owner.id,
        title: 'An opening whose dive never became a mission',
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: 'USD',
      });
      await updateOpportunity(made.id, {
        candidate_id: candidate.id,
        // A real harvested opening quotes a published signal into its
        // question; without one there would be nothing to ask a second time.
        buying_signal: 'A county published a paid request.',
        validation_state: 'PENDING',
        validation_started_at: new Date(Date.now() - ago).toISOString(),
        validation_rounds: 1,
      });
      return made.id;
    };

    // Inside the window: still being judged, and left alone.
    const fresh = await launch(VALIDATION_STALL_MS / 2);
    expect(await settleValidations(fixture.project.id)).toEqual([]);
    expect((await getOpportunity(fresh))!.validationState).toBe('PENDING');

    // Past it: nothing is researching it, so the slot comes back.
    const stale = await launch(VALIDATION_STALL_MS * 2);
    const settled = await settleValidations(fixture.project.id);
    expect(settled).toContainEqual({ opportunityId: stale, to: 'BLOCKED' });

    const after = (await getOpportunity(stale))!;
    expect(after.validationState).toBe('BLOCKED');
    // The row says what happened, and blames nobody for it.
    expect(after.nextAction ?? '').not.toMatch(/worker/i);
    // Nothing was destroyed: the candidate and the round count are untouched.
    expect(after.candidateId).not.toBeNull();
    expect(after.validationRounds).toBe(1);
    // And a second round is available, rather than the piece being written off.
    expect((await whyNotDiving(after)).kind).toBe('ELIGIBLE');
  });

  /**
   * A park is the lifecycle *waiting*, and that is a different fact from
   * stuck — provable from rows rather than asserted.
   */
  it('separates waiting on a person from having no capacity and from being refused', async () => {
    const fixture = await freshProject();
    const owner = await createUser({
      email: 'why2@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const started = await activate({
      projectId: fixture.project.id,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    if (!started.ok) return;

    // A sprint with nothing running has free slots, and says how many.
    const free = await sprintCanRefine(fixture.project.id);
    expect(free).toEqual({ kind: 'READY', free: MAX_VALIDATIONS_IN_FLIGHT, cap: MAX_VALIDATIONS_IN_FLIGHT });

    // Fill every slot with a live dive.
    for (let i = 0; i < MAX_VALIDATIONS_IN_FLIGHT; i += 1) {
      const held = await createOpportunity({
        projectId: fixture.project.id,
        cashModeId: started.mode.id,
        ownerUserId: owner.id,
        title: `live dive ${i}`,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: 'USD',
      });
      await updateOpportunity(held.id, { validation_state: 'RUNNING', validation_rounds: 1 });
    }
    expect((await sprintCanRefine(fixture.project.id)).kind).toBe('SLOTS_TAKEN');

    /*
     * Now park one. A parked dive uses no provider capacity, so the slot comes
     * back — and the opening itself reports `AWAITING_PERSON` rather than
     * anything that reads as a refusal of the work.
     */
    const live = (await listOpportunities({ projectId: fixture.project.id })).filter(
      (one) => one.validationState === 'RUNNING',
    );
    await updateOpportunity(live[0]!.id, { validation_state: 'NEEDS_PERSON' });
    expect((await sprintCanRefine(fixture.project.id)).kind).toBe('READY');
    const parked = (await getOpportunity(live[0]!.id))!;
    expect((await whyNotDiving(parked)).kind).toBe('AWAITING_PERSON');

    // And it is not re-dived while it waits: the answer must not be bought twice.
    expect(await startValidations({ projectId: fixture.project.id })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The counts a screen reads come from the corrected semantics
// ---------------------------------------------------------------------------

describe('what the page counts', () => {
  it('counts tiers from the same placements the list renders', () => {
    const mixed = [...vendorPriceEvidence()];
    const qualified = opportunity({
      id: 'cop_real',
      payer: 'A named buyer',
      offerScope: 'A bounded deliverable',
      acceptanceCondition: 'What counts as done',
      priceCents: 90_00,
      deliveryMethod: 'Delivered how',
      fulfillmentOwner: 'By whom',
      economicsNote: 'What is left',
      peakFundingCents: 10_00,
      reachableChannel: 'A published route',
      buyingSignal: 'A named buyer published a request.',
      signalObservedAt: '2026-09-19',
      opportunitySignal: 'ACTIVE_BUYER_DEMAND',
    });
    const assembled = plan([...mixed, qualified], qualifyingFacts(qualified));

    const counted =
      assembled.byTier.SIGNAL +
      assembled.byTier.CANDIDATE +
      assembled.byTier.QUALIFIED +
      assembled.byTier.READY_TO_TEST;
    expect(counted).toBe(3);
    expect(assembled.byTier.SIGNAL).toBe(2);

    // And the four lists partition the live pieces exactly once each.
    const listed =
      assembled.executeNow.length +
      assembled.waiting.length +
      assembled.beingQualified.length +
      assembled.evidence.length;
    expect(listed).toBe(3);
  });
});

/**
 * A parameter whose only use is an `IS NULL` test has no type, on one of the
 * two backends.
 *
 * This is the convention's own `ORDER BY` rule one shape along, and it is here
 * because it cost a full Postgres run to learn: `WHEN ? IS NULL THEN 'GENERAL'`
 * is perfectly ordinary SQLite and answers
 * `42P18 could not determine data type of parameter $4` on Postgres, where the
 * parameter is a `$n` with nothing around it to infer from. The whole SQLite
 * suite passed over it — 4 118 tests — so nothing short of the second backend
 * or a reading of the statement could have said so.
 *
 * It refuses the shape rather than the instance, because the instance is
 * already gone and the next one will be somebody else's. A bare `?` is what is
 * refused: `CAST(? AS TEXT) IS NULL` gives the parameter a type and is fine,
 * which is why the pattern requires the placeholder to be immediately adjacent
 * to the test.
 */
const UNTYPED_NULL_TEST = /\?\s+IS\s+(?:NOT\s+)?NULL/i;

describe('a parameter Postgres cannot type', () => {
  it('is detected in the statement that actually failed', () => {
    // Production's own text, from the 42P18 the Postgres run reported.
    const failed = `UPDATE russell_conversations
        SET project_id = ?, attachment_source = ?, attachment_confidence = ?,
            purpose = CASE
              WHEN purpose IN ('OPERATIONAL','TECHNICAL') THEN purpose
              WHEN ? IS NULL THEN 'GENERAL'
              ELSE 'PROJECT'
            END,
            updated_at = ?
      WHERE id = ?`;
    expect(UNTYPED_NULL_TEST.test(failed)).toBe(true);

    // And the rewrite that replaced it is not.
    const fixed = failed.replace(/\s*WHEN \? IS NULL THEN 'GENERAL'\n/, '\n').replace(
      "ELSE 'PROJECT'",
      'ELSE ?',
    );
    expect(UNTYPED_NULL_TEST.test(fixed)).toBe(false);
  });

  it('appears nowhere in the server', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const root = new URL('../server/', import.meta.url);

    async function walk(dir: URL): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) out.push(...(await walk(child)));
        else if (entry.name.endsWith('.ts')) out.push(child.pathname);
      }
      return out;
    }

    const files = await walk(root);
    /*
     * A scan over nothing passes, and reads as coverage. §41 records what that
     * costs, so the reading is asserted before the absence is trusted.
     */
    expect(files.length).toBeGreaterThan(200);

    /*
     * Comments are stripped before the shape is looked for.
     *
     * The fourth time a guard in this repository has read prose as code: §33
     * records a mobile-layout check failing on a comment explaining why
     * `type="number"` is wrong, and the correction there was the same one.
     * It arrived here the moment somebody documented *why* a statement avoids
     * this shape — a sentence containing the words it warns about, in a file
     * that had done the right thing.
     *
     * Rewording the comment was the other option and is the worse one. A guard
     * that forces the code it protects to stop explaining itself is teaching
     * the next reader to write a quieter version of the same mistake, and this
     * file's own header is four paragraphs about a shape that is invisible
     * without an explanation. The strip is deliberately crude — a `//` or a
     * `*` opening a line — because what it has to survive is prose, and a
     * statement is never written with its opening quote inside a comment.
     */
    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/^\s*(?:\/\/|\/?\*+\/?).*$/, '').replace(/\/\/.*$/, '');
        if (UNTYPED_NULL_TEST.test(code)) offenders.push(`${file}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
