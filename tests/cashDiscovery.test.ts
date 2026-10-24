/**
 * Where a sprint's opportunities come from, and what may become one.
 *
 * Activating a sprint used to write a mode row and an event and nothing else.
 * No goal, no candidate, no mission, no queued job — and `capture` had exactly
 * two production callers, a person pressing a button and the reoffer service.
 * So a freshly activated sprint could sit empty indefinitely beside a perfectly
 * healthy research fleet while the screen said discovery had started, which is
 * §24's "a state that says waiting which nobody can resolve is not waiting" at
 * a section rather than at a state machine.
 *
 * Two properties are what make the producer honest, and they are what this file
 * pins:
 *
 * **Brain decomposes; it never invents a finding.** The buckets are a closed
 * set of declared places to look, filled from a template. Everything after the
 * candidate is the existing path — the archive check, the judgment, the mission
 * compiler, the approval envelope, the evidence gate, all three audit roles.
 *
 * **A lane is a row, so a signal is not a judgement.** Harvest reads
 * `evidence_lane` rather than prose, and what it produces is an opportunity
 * with a **blank card**: a published request is evidence somebody asked, and it
 * is not a payer, a price, an acceptance condition or a delivery path.
 */
import type { OpportunitySignal } from '../server/domain/types.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listCashEvents, recordCashEvent } from '../server/repos/cashMode.ts';
import { getOpportunity, listOpportunities } from '../server/repos/cashPortfolio.ts';
import { getCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import {
  BARREN_ROUNDS,
  nextRoundFor,
  SEARCH_BUCKETS,
  PLAY_BUCKETS,
  SIGNAL_LANE,
  harvest,
  executionFrameSentence,
  openDiscovery,
  runDiscovery,
} from '../server/services/cash/discovery.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `discovery-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

/**
 * A finished mission for one opened bucket, carrying the claims given.
 *
 * Built from the real repositories rather than from a stub, because the thing
 * under test is which rows the harvest reads: a fixture that handed it claims
 * directly would pass against a harvest that read prose.
 */
async function finishedMission(input: {
  candidateId: string;
  claims: {
    claim: string;
    lane: string | null;
    /**
     * The typed opening this claim establishes, if it establishes one.
     *
     * Separate from the lane on purpose, and that separation *is* the repair.
     * Whether a claim is a piece of work used to be read off the lane id, and
     * lane ids are a planner's words: production wrote seventeen of them across
     * 82 claims and not one was the literal the harvest compared against.
     */
    signal?: OpportunitySignal;
    sourceUrl: string | null;
    /** The published deadline, as a worker would declare it. */
    closesOn?: string | null;
    accepted?: boolean;
    sourceDate?: string | null;
    /** What the claim established. A documented absence is not an opening. */
    claimType?: 'SOURCED_FACT' | 'NEGATIVE_EXISTENCE' | 'QUOTATION';
  }[];
  fragmentStatus?: 'ACCEPTED' | 'BLOCKED' | 'REJECTED';
  /** Where the mission ends; DONE unless a test says the research stopped. */
  missionEnds?: 'DONE' | 'FAILED' | 'NEEDS_HUMAN';
}): Promise<{ missionId: string; orchestrationId: string }> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a discovery bucket',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a discovery bucket',
    assignment: 'where to look',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the sprint may look at',
      requiredEvidence: [
        { id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a marketplace or job board listing'],
      excludedSourceTypes: ['a forecast or projection presented as a current fact'],
      completionCriteria: ['at least one dated published request'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'cash-discovery',
      question: 'Who is publicly asking to pay for work right now?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const [fragment] = await currentFragments(orchestration.id);
  const status = input.fragmentStatus ?? 'ACCEPTED';
  await updateFragment(fragment!.id, {
    status,
    completedAt: new Date().toISOString(),
    blockedReason: status === 'BLOCKED' ? 'The bucket was only partly covered.' : null,
  });

  const inserted = await insertClaims(
    input.claims.map((one) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: one.sourceUrl,
      sourceTitle: 'A listing',
      sourcePublisher: 'A marketplace',
      sourceDate: one.sourceDate === undefined ? '2026-09-10' : one.sourceDate,
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the listing body',
      evidenceLane: one.lane,
      opportunitySignal: one.signal ?? null,
      closesOn: one.closesOn ?? null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: one.sourceUrl !== null,
      claimType: one.claimType ?? ('SOURCED_FACT' as const),
      contentHash: `${one.claim}|${one.sourceUrl ?? ''}`,
    })),
  );
  for (const [index, claim] of inserted.entries()) {
    await decideClaim(claim.id, { accepted: input.claims[index]!.accepted ?? true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a discovery bucket',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  const ends = input.missionEnds ?? 'DONE';
  await transitionMission({
    missionId: mission.id,
    from: 'RUNNING',
    to: ends,
    terminalReason: ends === 'DONE' ? null : 'No fragment cleared its evidence gate.',
    waitingOn: ends === 'NEEDS_HUMAN' ? 'a person' : null,
  });
  return { missionId: mission.id, orchestrationId: orchestration.id };
}

describe('opening the discovery of a sprint', () => {
  it('creates one candidate per bucket, and stops when every bucket is open', async () => {
    await activated();

    const opened: string[] = [];
    for (let pass = 0; pass < SEARCH_BUCKETS.length + 2; pass += 1) {
      for (const one of await openDiscovery({ projectId })) opened.push(one.bucketId);
    }

    expect(opened.sort()).toEqual(SEARCH_BUCKETS.map((one) => one.id).sort());
    const candidates = await listCandidates({ projectId });
    expect(candidates).toHaveLength(SEARCH_BUCKETS.length);
    // Captured, so the ordinary judgment pass picks them up — never queued
    // past the archive check, which is what would make this a second pipeline.
    for (const candidate of candidates) expect(candidate.state).toBe('CAPTURED');
  });

  it('is idempotent by rows, so a tick that dies re-opens nothing', async () => {
    await activated();
    const first = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length });
    expect(first).toHaveLength(SEARCH_BUCKETS.length);

    const second = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length });
    expect(second).toEqual([]);
    expect(await listCandidates({ projectId })).toHaveLength(SEARCH_BUCKETS.length);

    const events = (await listCashEvents(projectId, 100)).filter(
      (event) => event.kind === 'CASH_DISCOVERY_OPENED',
    );
    expect(events).toHaveLength(SEARCH_BUCKETS.length);
  });

  it('opens no Claude round while BRAIN_CLAUDE_DISCOVERY is off, and resumes when it is not', async () => {
    await activated();
    process.env['BRAIN_CLAUDE_DISCOVERY'] = 'off';
    try {
      expect(await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length })).toEqual([]);
      expect(await listRounds(projectId)).toEqual([]);
    } finally {
      delete process.env['BRAIN_CLAUDE_DISCOVERY'];
    }
    expect(await openDiscovery({ projectId })).toHaveLength(1);
  });

  it('opens nothing without a sprint, and nothing once it has wound down', async () => {
    expect(await openDiscovery({ projectId })).toEqual([]);

    await activated();
    expect(await openDiscovery({ projectId })).toHaveLength(1);

    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'done' });
    expect(await openDiscovery({ projectId })).toEqual([]);

    // Reactivating opens what it had not reached, rather than starting again.
    await setLifecycle({ projectId, to: 'ACTIVE', actorUserId: userId, reason: 'more to do' });
    const resumed = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length });
    expect(resumed).toHaveLength(SEARCH_BUCKETS.length - 1);
  });

  it('asks a question and never states a finding', () => {
    for (const bucket of SEARCH_BUCKETS) {
      expect(bucket.question.length).toBeGreaterThan(80);
      expect(bucket.question.trimEnd().endsWith('?')).toBe(true);
    }
    // "Something else" is not a question, so there is no OTHER bucket for a
    // worker to decide the contents of.
    expect(SEARCH_BUCKETS.map((one) => one.mechanism)).not.toContain('OTHER');
  });
});

describe('a published deadline reaches the opening', () => {
  it('copies the closing date a worker declared onto the opening it harvests', async () => {
    /*
     * A closed RFP used to be discovered, harvested and dived before anything
     * noticed, because its deadline was a sentence on a card. The date is a
     * typed declaration on the claim now, and the harvest carries it.
     */
    await activated();
    const [first] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: first!.candidateId,
      claims: [
        {
          claim: 'A county published an RFP for parcel research, proposals due 25 September 2026.',
          lane: SIGNAL_LANE,
          signal: 'EXPIRING_OPENING',
          sourceUrl: 'https://example.test/rfp/dated',
          closesOn: '2026-09-25',
        },
      ],
    });
    const [made] = await harvest({ projectId });
    expect((await getOpportunity(made!.opportunity.id))!.expiresAt).toBe('2026-09-25');
  });
});

describe('discovery keeps going while the sprint is active', () => {
  it('asks a bucket again once its round is answered and the cool-off has passed', async () => {
    /*
     * A bucket was skipped for ever once its opening event existed, so a sprint
     * discovered five things in its first hour and nothing for the rest of its
     * life. That is not what a month of broad discovery is for: the buckets are
     * places to look, published requests appear daily, and a single pass is a
     * snapshot of one morning.
     */
    await activated();
    const [first] = await openDiscovery({ projectId });
    expect(first!.round).toBe(1);

    // Not while the first round is live: a second asking would duplicate the
    // first one's spending on the same question.
    expect(await openDiscovery({ projectId })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ bucketId: first!.bucketId })]),
    );

    await finishedMission({
      candidateId: first!.candidateId,
      claims: [
        {
          claim: 'A county published a request for parcel research, closing 30 September 2026.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/round-1',
        },
      ],
    });
    expect(await harvest({ projectId })).toHaveLength(1);

    // Answered, but not yet due: the cool-off is what keeps "ongoing" from
    // becoming "uncontrolled".
    const soon = await openDiscovery({ projectId, limit: 9 });
    expect(soon.some((one) => one.bucketId === first!.bucketId)).toBe(false);

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const again = await openDiscovery({ projectId, limit: 9, now: tomorrow });
    const second = again.find((one) => one.bucketId === first!.bucketId);
    expect(second?.round).toBe(2);

    // And the second round says what the first already covered, so a worker is
    // looking for what is new rather than re-reporting what Brain holds.
    const candidate = (await getCandidate(second!.candidateId))!;
    expect(candidate.statement).toContain('asked this 1 time before');
    expect(candidate.statement).toContain('filed 1 opening');
  });

  it('carries the sprint objective into the question a worker reads', async () => {
    // The objective was recorded in the event and left out of the candidate, so
    // the thing a worker read was the generic template and the thing saying
    // what the sprint was *for* sat in a row nothing downstream opened.
    await activated();
    const [opened] = await openDiscovery({ projectId });
    const candidate = (await getCandidate(opened!.candidateId))!;
    expect(candidate.statement).toContain('Maximize additional usable cash');
  });

  it('tells the worker what this operation can act on, from its own rows', async () => {
    // Production, 2026-10-19: 248 of 312 openings were evidence nobody could say
    // how we would be paid from, because no question said what this operation
    // can do. The frame is read from the ledger and the capability proof.
    await activated();
    const [opened] = await openDiscovery({ projectId });
    const statement = (await getCandidate(opened!.candidateId))!.statement;
    expect(statement).toContain('Report first the openings this operation could act on now');
    // Not being able to act today is a named gap, never a reason to drop the opening.
    expect(statement).toMatch(/still worth reporting when the money is real/);
    expect(statement).not.toMatch(/Report only openings/);
    expect(statement).toContain('holds no capital of its own to commit');
    expect(statement).toMatch(/who would pay this operation/);
    expect(statement).toMatch(/spreadsheet/);
    // And no envelope reads it as an instruction to act on the world.
    const { APPROVAL_ENVELOPES } = await import('../server/services/research/approvalEnvelope.ts');
    const { describesOwnAction } = await import('../server/services/research/actorScope.ts');
    // The envelopes cash research compiles under; the licensing ones refuse any money word at all.
    const cash = Object.values(APPROVAL_ENVELOPES).filter((one) => one.id.startsWith('RUSSELL_CASH_'));
    expect(cash.length).toBeGreaterThan(0);
    for (const envelope of cash) {
      expect(describesOwnAction(statement, envelope.forbiddenActions), envelope.id).toBe(false);
    }
  });

  it('states the capital the ledger says may be committed, and no more', () => {
    expect(executionFrameSentence({ delivers: [], deployableCents: 50_000, currency: 'USD' })).toContain(
      'about USD 500 of its own capital',
    );
  });

  it('stops asking a bucket that has documented three times that there is nothing', async () => {
    await activated();
    let at = Date.now();
    let bucketId = '';
    for (let round = 1; round <= BARREN_ROUNDS; round += 1) {
      const opened = await openDiscovery({
        projectId,
        limit: 9,
        now: new Date(at).toISOString(),
      });
      const mine = bucketId
        ? opened.find((one) => one.bucketId === bucketId)!
        : opened[0]!;
      bucketId = mine.bucketId;
      expect(mine.round).toBe(round);
      await finishedMission({
        candidateId: mine.candidateId,
        claims: [
          {
            claim: `A documented search of the boards found nothing, pass ${round}.`,
            lane: 'demand_absence',
            sourceUrl: `https://example.test/search/${round}`,
          },
        ],
      });
      await harvest({ projectId, limit: 50 });
      at += 25 * 60 * 60 * 1000;
    }

    // Brain has now documented that there is nothing there. Asking a fourth
    // time spends the allowance to learn it again, which is §13's rule about
    // the archive applied to Brain's own history.
    const fourth = await openDiscovery({
      projectId,
      limit: 9,
      now: new Date(at).toISOString(),
    });
    expect(fourth.some((one) => one.bucketId === bucketId)).toBe(false);
  });

  it('keeps its identity after more than five hundred unrelated events', async () => {
    /*
     * Both halves of discovery read `listCashEvents(projectId, 500)` — the
     * activity *display window*, hard-capped and newest-first. A month of
     * ordinary sprint activity pushes the opening events out of it, and then
     * every bucket re-opens as a duplicate and `harvest` returns nothing at all
     * because it no longer recognises its own missions.
     *
     * A display window is not an index.
     */
    await activated();
    const [opened] = await openDiscovery({ projectId });

    /*
     * A millisecond between the opening event and the noise, so the precondition
     * below is a fact rather than a coin toss.
     *
     * `listCashEvents` orders `created_at DESC, id DESC`, and an id is a random
     * uuid rather than a time — so among events sharing one millisecond the
     * order is arbitrary. A tight loop writes tens of these per millisecond, and
     * when enough of them land in the opening event's own millisecond with
     * smaller ids, that event sorts *into* the newest five hundred and the
     * precondition fails. It did, twice, under full-suite load, on trees either
     * side of this change.
     *
     * The assertion this scaffolds is about a display window not being an index,
     * and it is right. What was wrong was proving the precondition by racing the
     * clock. One sleep makes every note strictly newer, so the ordering is
     * decided by the column that means time rather than by the one that does
     * not.
     */
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 520; i += 1) {
      await recordCashEvent({
        projectId,
        kind: 'CASH_NOTE',
        actorRef: userId,
        summary: `Ordinary activity ${i}`,
      });
    }
    // The opening event is now well outside the window it used to be read from.
    const window = await listCashEvents(projectId, 500);
    expect(window.some((event) => event.kind === 'CASH_DISCOVERY_OPENED')).toBe(false);

    // No duplicate: the bucket is still known to have an open round.
    const again = await openDiscovery({ projectId, limit: 9 });
    expect(again.some((one) => one.bucketId === opened!.bucketId)).toBe(false);

    // And the research still files, which is the half that would have failed
    // silently — a sprint that kept researching and stopped producing anything.
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A county published a request for parcel research after all that noise.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/after-the-noise',
        },
      ],
    });
    expect(await harvest({ projectId })).toHaveLength(1);
  });
});

describe('harvesting what discovery found', () => {
  it('files a gated demand signal as an opportunity with its provenance', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A county drain commission posted a paid request for parcel research closing 30 September 2026.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-441',
        },
      ],
    });

    const harvested = await harvest({ projectId });
    expect(harvested).toHaveLength(1);

    const opportunity = (await getOpportunity(harvested[0]!.opportunity.id))!;
    expect(opportunity.state).toBe('DISCOVERED');
    expect(opportunity.sourceClaimId).toBe(harvested[0]!.claimId);
    expect(opportunity.discoveredByCandidateId).toBe(opened!.candidateId);
    // Never `candidateId`: that column means the idea this opportunity *is*,
    // and the wind-down guard reads it to tell discovery from support work.
    expect(opportunity.candidateId).toBeNull();
    // From the claim's own signal, never from the bucket that asked (`harvest`).
    expect(opportunity.mechanism).toBe('EXPLICIT_PAID_REQUEST');
    expect(opportunity.buyingSignal).toContain('drain commission');
    expect(opportunity.signalObservedAt).toBe('2026-09-10');
  });

  it('leaves the card blank, so every unknown arrives as a task', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A buyer published a request for eight hours of drafting work at $95 an hour.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-442',
        },
      ],
    });

    const [harvested] = await harvest({ projectId });
    const opportunity = harvested!.opportunity;

    // The source says somebody asked. It does not say who pays, at what price,
    // against which acceptance condition, or how it is delivered — and writing
    // any of those from it would be the favourable assumption §30 refuses.
    expect(opportunity.payer).toBeNull();
    expect(opportunity.priceCents).toBeNull();
    expect(opportunity.acceptanceCondition).toBeNull();
    expect(opportunity.deliveryMethod).toBeNull();
    expect(opportunity.reachableChannel).toBeNull();

    const card = evidenceCard(opportunity);
    expect(card.readiness.ready).toBe(false);
    expect(card.readiness.missing).toContain('payer');
    const unanswered = card.fields.filter((field) => field.value === null);
    expect(unanswered.length).toBeGreaterThan(0);
    for (const field of unanswered) expect(field.task.length).toBeGreaterThan(0);
  });

  it('reads the lane rather than the prose', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'Demand for this service is widely reported to be growing.',
          lane: 'economics',
          sourceUrl: 'https://example.test/report',
        },
        {
          claim: 'A county published a request for eight parcel searches, closing 30 September.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-443',
        },
      ],
    });

    // The economics claim reads like an opening and is not one. The lane says
    // what *kind* of evidence a claim is, and only one kind is a piece of work.
    const harvested = await harvest({ projectId });
    expect(harvested).toHaveLength(1);
    expect(harvested[0]!.opportunity.buyingSignal).toContain('county published a request');
  });

  it('keeps a documented absence as research and out of the portfolio', async () => {
    /*
     * This test used to feed "Nobody asked for anything and there is no buyer
     * here" into the signal lane and **expect an opportunity**, to prove that
     * the column decided rather than the words. The property was right and the
     * example proved the defect: a lane says what kind of evidence a claim is,
     * and "a county published a request" and "nobody is asking" are the same
     * kind of evidence with opposite answers. Filing the second one put
     * *nobody is asking* into the portfolio as something to go and sell.
     *
     * Two structural readings separate them, and neither is prose.
     * `NEGATIVE_EXISTENCE` is the claim type the evidence standards already use
     * for an established absence, and `demand_absence` / `demand_closed` are
     * lanes of their own so a worker has somewhere to put the finding.
     */
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A documented search of the three boards found no open requests in this market.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/board/search',
          claimType: 'NEGATIVE_EXISTENCE',
        },
        {
          claim: 'No published request for this work exists on the county portal.',
          lane: 'demand_absence',
          sourceUrl: 'https://example.test/portal',
        },
        {
          claim: 'The parcel research request published in June was awarded on 1 August.',
          lane: 'demand_closed',
          sourceUrl: 'https://example.test/award/118',
        },
      ],
    });

    expect(await harvest({ projectId })).toEqual([]);
    expect(await listOpportunities({ projectId })).toEqual([]);

    // The claims are untouched: a documented absence is evidence about where
    // Brain has already looked, and discarding it would make the next round
    // search the same ground.
    const round = (await listRounds(projectId)).find((one) => one.candidateId === opened!.candidateId)!;
    expect(round.state).toBe('HARVESTED');
    expect(round.found).toBe(0);
  });

  it('refuses a claim the gate rejected, and one with no source', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A buyer is asking, according to a page that could not be located.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-444',
          accepted: false,
        },
        {
          claim: 'Somebody mentioned a buyer.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: null,
        },
      ],
    });

    expect(await harvest({ projectId })).toEqual([]);
    expect(await listOpportunities({ projectId })).toEqual([]);
  });

  it('keeps a gated claim from a fragment that fell short on coverage', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      fragmentStatus: 'BLOCKED',
      claims: [
        {
          claim: 'One buyer published a paid request; the rest of the market was not covered.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-445',
        },
      ],
    });

    // Coverage is a statement about the question, not about the claim. A
    // bucket question is broad by construction, so discarding its gated claims
    // for falling short would discard most of what discovery finds.
    expect(await harvest({ projectId })).toHaveLength(1);
  });

  it('contributes nothing from a fragment the gate refused outright', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      fragmentStatus: 'REJECTED',
      claims: [
        {
          claim: 'A buyer published a request.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-446',
        },
      ],
    });

    expect(await harvest({ projectId })).toEqual([]);
  });

  it('files one opportunity per claim however many times it runs', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A buyer published a paid request for survey work.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-447',
        },
      ],
    });

    expect(await harvest({ projectId })).toHaveLength(1);
    expect(await harvest({ projectId })).toEqual([]);
    expect(await harvest({ projectId })).toEqual([]);
    expect(await listOpportunities({ projectId })).toHaveLength(1);
  });

  it('files what a finished mission found even after the sprint wound down', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      claims: [
        {
          claim: 'A buyer published a paid request before the sprint ended.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/2026-448',
        },
      ],
    });
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'done' });

    // The spending happened when the mission ran. Winding down stops new
    // discovery; it does not stop the answers to what already ran arriving.
    const run = await runDiscovery(projectId);
    expect(run.opened).toEqual([]);
    expect(run.harvested).toHaveLength(1);
  });

  /*
   * Database pressure used to stop discovery outright, and production Cash
   * Mode 1 ended up with no open round at all. Under pressure only the sweeps
   * over every opportunity wait; the next round still opens.
   */
  it('opens a round under database pressure, with only the sweeps skipped', async () => {
    await activated();
    const run = await runDiscovery(projectId, { sweep: false });
    expect(run.opened).toHaveLength(1);
    expect(run.signalled).toEqual([]);
    expect(run.failures).toEqual([]);
  });

  /*
   * A packet a bucket did not open is still authorized research in this sprint.
   *
   * This test used to assert the opposite, and that assertion was the defect.
   * `harvest` walked candidate → mission → round, so a packet with no mission
   * was invisible — which in production meant four packets an administrator
   * started, holding 69 accepted claims, could never produce a single piece of
   * work however good they were.
   *
   * What decides is the claim's own typed signal, not which question produced
   * it. The round is null, honestly, because no bucket asked for it, and the
   * wind-down guard keeps reading `discoveredByCandidateId` for the difference
   * between new discovery and work supporting an obligation.
   */
  it('files an opening from a packet no bucket opened, with no round on it', async () => {
    await activated();
    await openDiscovery({ projectId });
    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const stranger = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Something a person asked about',
      statement: 'An ordinary research question with nothing to do with the sprint.',
    });
    await finishedMission({
      candidateId: stranger.id,
      claims: [
        {
          claim: 'A county published a request for parcel research, closing 30 September 2026.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/stranger',
        },
      ],
    });

    const filed = await harvest({ projectId });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.opportunity.discoveryRoundId).toBeNull();
    expect(filed[0]!.opportunity.discoveredByCandidateId).toBeNull();
    expect(filed[0]!.opportunity.orchestrationId).not.toBeNull();
  });

  /*
   * And a claim the *deep dive* produced is not a second opening.
   *
   * A validation packet researches one opening that already exists, so it will
   * legitimately establish demand, a price and a deadline about it. Harvesting
   * those would file the answer to "is this worth doing" as another piece of
   * work and then validate that in turn — a loop that looks like discovery and
   * is one packet chasing its own tail.
   */
  it('does not harvest a validation packet\'s own findings', async () => {
    await activated();
    const opened = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened[0]!.candidateId,
      claims: [
        {
          claim: 'A county published a request for parcel research, closing 30 September 2026.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/one',
        },
      ],
    });
    const [first] = await harvest({ projectId });
    expect(first).toBeDefined();

    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const deepDive = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Validate that opening',
      statement: 'Who pays, what it pays and when it closes.',
    });
    const validation = await finishedMission({
      candidateId: deepDive.id,
      claims: [
        {
          claim: 'The same county also published a second, larger request for the same work.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/two',
        },
      ],
    });
    const { updateOpportunity } = await import('../server/repos/cashPortfolio.ts');
    await updateOpportunity(first!.opportunity.id, {
      validation_orchestration_id: validation.orchestrationId,
      validation_state: 'RUNNING',
    });

    expect(await harvest({ projectId })).toEqual([]);
  });

  /*
   * Nor is a claim that answers any other question about an opening already in
   * the portfolio. Production, 2026-10-18: a need's research ("Payer for …")
   * and an earlier round's deep dive each filed the opening they were about as
   * a new one, read through a different URL so the twin check missed it, and
   * every new "opening" raised needs of its own.
   */
  it("does not harvest a need's research, or an earlier round's dive", async () => {
    await activated();
    const opened = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened[0]!.candidateId,
      claims: [
        {
          claim: 'A client posted a fixed-price request for a WordPress site, open for bids.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/projects/site',
        },
      ],
    });
    const [first] = await harvest({ projectId });
    expect(first).toBeDefined();

    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const { createNeed, updateOpportunity } = await import('../server/repos/cashPortfolio.ts');

    // A need about that opening, researched by its own mission.
    const payerQuestion = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Payer for the WordPress site request',
      statement: 'Who pays for this request, and how much?',
    });
    await createNeed({
      projectId,
      opportunityId: first!.opportunity.id,
      blockedAction: 'Qualify the opening',
      whyItMatters: 'Nobody is known to pay.',
      recommendedPath: 'Research the payer.',
      setupEffort: 'None',
      nextStep: 'Research the payer.',
      completionCondition: 'payer is answered',
      candidateId: payerQuestion.id,
    });
    await finishedMission({
      candidateId: payerQuestion.id,
      claims: [
        {
          claim: 'The same project, read through the public API, is open with a $250-$750 budget.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/api/projects/site',
        },
      ],
    });

    // An earlier round's deep dive: the opening's own idea, while its current
    // validation orchestration names a later packet.
    const firstDive = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Qualify: the WordPress site request',
      statement: 'Who pays, what it pays and when it closes.',
    });
    await updateOpportunity(first!.opportunity.id, { candidate_id: firstDive.id });
    await finishedMission({
      candidateId: firstDive.id,
      claims: [
        {
          claim: 'The request is listed on a regional mirror of the same marketplace, still open.',
          lane: SIGNAL_LANE,
          signal: 'PAID_TASK_OR_CONTRACT',
          sourceUrl: 'https://mirror.example.test/projects/site',
        },
      ],
    });

    expect(await harvest({ projectId })).toEqual([]);
  });

  /*
   * A resale lot carries a seller's description and a current bid, and both
   * invite a margin nobody has established. The shared view names what is
   * unresolved rather than leaving a reader to infer it from a bid and an
   * estimate.
   */
  it('names the unresolved checks on a fresh resale opening, and no figure', async () => {
    await activated();
    const opened = await openDiscovery({ projectId });
    const closes = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await finishedMission({
      candidateId: opened[0]!.candidateId,
      claims: [
        {
          claim: 'A state surplus auction lists a bracelet described as 14k, 11.5 g; current bid $201.',
          lane: SIGNAL_LANE,
          signal: 'RESALABLE_ASSET_OPENING',
          sourceUrl: 'https://example.test/auction/lot-24',
          closesOn: closes,
        },
      ],
    });
    const [filed] = await harvest({ projectId });
    expect(filed).toBeDefined();

    const { sharedFrontier } = await import('../server/services/cash/shared.ts');
    const frontier = await sharedFrontier({ projectId });
    const fresh = frontier.fresh.find((one) => one.opportunityId === filed!.opportunity.id);
    expect(fresh).toBeDefined();
    expect(fresh!.doesNotEstablish).toMatch(/what is left after fees/);
    const checks = fresh!.unresolvedChecks.join(' ');
    expect(checks).toMatch(/Authenticity and condition are unverified/);
    expect(checks).toMatch(/Acquisition cost is not established/);
    expect(checks).toMatch(/selling route is unverified/);
    expect(checks).toMatch(/not a validated margin/);
    // Static sentences: none of them carries a figure.
    expect(checks).not.toMatch(/\$\s?\d/);
  });

  it('does nothing at all for a project with no sprint', async () => {
    expect(await runDiscovery(projectId)).toEqual({
      opened: [],
      harvested: [],
      authorized: false,
      resumed: [],
      // Nothing to read a signal back for either: one read of `cash_modes`
      // answers the whole pass for a project holding no sprint at all.
      signalled: [],
      failures: [],
    });
  });
});

describe('a discovery round whose research stopped', () => {
  it('is not barren evidence: a bucket whose rounds all stopped unfinished is asked again', () => {
    const at = (hours: number) => new Date(Date.UTC(2026, 9, 18) + hours * 3_600_000).toISOString();
    const round = (n: number, state: 'HARVESTED' | 'ABANDONED', found: number) =>
      ({ id: `cdr_${n}`, round: n, state, found, openedAt: at(n * 30), harvestedAt: at(n * 30 + 1) }) as never;
    const abandoned = [round(1, 'ABANDONED', 0), round(2, 'ABANDONED', 0), round(3, 'ABANDONED', 0)];
    expect(nextRoundFor(abandoned, at(3 * 30 + 1 + 25))).toBe(4);
    // Still bounded by the cool-off.
    expect(nextRoundFor(abandoned, at(3 * 30 + 1 + 2))).toBeNull();
    // Three finished rounds that found nothing still stop it.
    const harvested = [round(1, 'HARVESTED', 0), round(2, 'HARVESTED', 0), round(3, 'HARVESTED', 0)];
    expect(nextRoundFor(harvested, at(3 * 30 + 1 + 25))).toBeNull();
  });

  it('closes, keeps what it filed, and lets the bucket be asked again', async () => {
    /*
     * Production, Cash Mode 1: all ten buckets OPEN at round 1, every one
     * parked, because a round closed only on a DONE mission. An open round is
     * what `nextRoundFor` refuses to ask past, so broad discovery stopped.
     */
    await activated();
    const [opened] = await openDiscovery({ projectId });
    await finishedMission({
      candidateId: opened!.candidateId,
      missionEnds: 'NEEDS_HUMAN',
      fragmentStatus: 'BLOCKED',
      claims: [
        {
          claim: 'A city published an open request for records digitization.',
          lane: SIGNAL_LANE,
          signal: 'ACTIVE_BUYER_DEMAND',
          sourceUrl: 'https://example.test/rfp/stopped',
        },
      ],
    });

    // The gated claim of the blocked fragment is still filed, against the round.
    const filed = await harvest({ projectId });
    expect(filed).toHaveLength(1);
    const rounds = await listRounds(projectId);
    const round = rounds.find((one) => one.bucketId === opened!.bucketId)!;
    expect(round.state).toBe('ABANDONED');
    expect(round.found).toBe(1);

    // And the bucket is asked again once the cool-off has passed.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const again = await openDiscovery({ projectId, limit: 9, now: tomorrow });
    expect(again.find((one) => one.bucketId === opened!.bucketId)?.round).toBe(2);
  });

  it('leaves a round alone while its research is still running or never launched', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    // No mission at all: the idea has not launched, and closing it would record
    // a round that researched nothing.
    await harvest({ projectId });
    expect((await listRounds(projectId)).find((one) => one.bucketId === opened!.bucketId)!.state).toBe(
      'OPEN',
    );
  });
});

describe('harvest reads past what it already filed', () => {
  it('files the forty-first signalled claim', async () => {
    /*
     * `signalledClaims` read the oldest forty and `harvest` skipped every one
     * already filed, so once forty openings existed nothing later could be read.
     */
    await activated();
    const [opened] = await openDiscovery({ projectId });
    const claims = Array.from({ length: 45 }, (_, index) => ({
      claim: `Buyer ${index} published a paid request for survey work.`,
      lane: SIGNAL_LANE,
      signal: 'ACTIVE_BUYER_DEMAND' as const,
      sourceUrl: `https://example.test/rfp/${index}`,
    }));
    await finishedMission({ candidateId: opened!.candidateId, claims });
    // The tick's own bound: runDiscovery harvests ten, so it reads forty.
    for (let pass = 0; pass < 6; pass += 1) await harvest({ projectId, limit: 10 });
    expect(await listOpportunities({ projectId })).toHaveLength(45);
  });
});

describe('plays: a kind of business that pays for something Brain can make', () => {
  it('asks one play question per deliverable Brain proves, right after the quick plays', async () => {
    const { DELIVERABLE_KINDS } = await import('../server/services/cash/deliverables/spec.ts');
    const { QUICK_PLAY_BUCKETS } = await import('../server/services/cash/discovery.ts');
    expect(PLAY_BUCKETS.map((one) => one.deliverable)).toEqual([...DELIVERABLE_KINDS]);
    // The owner (2026-10-22): quick, short-window plays come first, then plays.
    expect(SEARCH_BUCKETS.slice(0, QUICK_PLAY_BUCKETS.length).map((one) => one.id)).toEqual(
      QUICK_PLAY_BUCKETS.map((one) => one.id),
    );
    expect(
      SEARCH_BUCKETS.slice(QUICK_PLAY_BUCKETS.length, QUICK_PLAY_BUCKETS.length + PLAY_BUCKETS.length).map(
        (one) => one.id,
      ),
    ).toEqual(PLAY_BUCKETS.map((one) => one.id));
    for (const bucket of PLAY_BUCKETS) {
      expect(bucket.question).toMatch(/pay, again and again/);
      expect(bucket.question).toMatch(/published prices/);
      expect(bucket.question).toMatch(/business email addresses can be found/);
    }
    expect(new Set(SEARCH_BUCKETS.map((one) => one.id)).size).toBe(SEARCH_BUCKETS.length);
  });

  it('an opening from a play round requires producing that deliverable, which Brain proves it can', async () => {
    await activated();
    const { QUICK_PLAY_BUCKETS } = await import('../server/services/cash/discovery.ts');
    const opened = await openDiscovery({ projectId, limit: QUICK_PLAY_BUCKETS.length + 1 });
    const first = opened.find((one) => PLAY_BUCKETS.some((play) => play.id === one.bucketId));
    const bucket = PLAY_BUCKETS.find((one) => one.id === first!.bucketId)!;
    expect(bucket).toBeDefined();
    await finishedMission({
      candidateId: first!.candidateId,
      claims: [
        {
          claim: 'Independent property managers repeatedly buy owner-statement spreadsheets at $150 each.',
          lane: SIGNAL_LANE,
          signal: 'RECURRING_OUTSOURCED_WORK',
          sourceUrl: 'https://example.test/plays/spreadsheets',
        },
      ],
    });
    const [made] = await harvest({ projectId });
    const opportunity = (await getOpportunity(made!.opportunity.id))!;
    expect(opportunity.requiredCapabilities).toEqual([`PRODUCE_${bucket.deliverable}`]);
    const { readCapability } = await import('../server/services/cash/capabilities.ts');
    const { proveCapabilities } = await import('../server/services/cash/deliverables/capabilities.ts');
    await proveCapabilities();
    const reading = await readCapability(`PRODUCE_${bucket.deliverable}`);
    expect(reading.definition).not.toBeNull();
    expect(reading.state).toBe('PRESENT');
  });

  it('tells the worker this operation reaches buyers by email, and what a play is', async () => {
    await activated();
    const [opened] = await openDiscovery({ projectId });
    const statement = (await getCandidate(opened!.candidateId))!.statement;
    expect(statement).toMatch(/reaches buyers by email at the business addresses they publish/);
    expect(statement).toMatch(/repeatedly pays for something this operation delivers/);
  });
});
