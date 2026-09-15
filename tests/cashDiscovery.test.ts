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
  SEARCH_BUCKETS,
  SIGNAL_LANE,
  harvest,
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
    sourceUrl: string | null;
    accepted?: boolean;
    sourceDate?: string | null;
    /** What the claim established. A documented absence is not an opening. */
    claimType?: 'SOURCED_FACT' | 'NEGATIVE_EXISTENCE' | 'QUOTATION';
  }[];
  fragmentStatus?: 'ACCEPTED' | 'BLOCKED' | 'REJECTED';
}): Promise<string> {
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
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
  return mission.id;
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
    const first = await openDiscovery({ projectId, limit: 5 });
    expect(first).toHaveLength(SEARCH_BUCKETS.length);

    const second = await openDiscovery({ projectId, limit: 5 });
    expect(second).toEqual([]);
    expect(await listCandidates({ projectId })).toHaveLength(SEARCH_BUCKETS.length);

    const events = (await listCashEvents(projectId, 100)).filter(
      (event) => event.kind === 'CASH_DISCOVERY_OPENED',
    );
    expect(events).toHaveLength(SEARCH_BUCKETS.length);
  });

  it('opens nothing without a sprint, and nothing once it has wound down', async () => {
    expect(await openDiscovery({ projectId })).toEqual([]);

    await activated();
    expect(await openDiscovery({ projectId })).toHaveLength(1);

    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'done' });
    expect(await openDiscovery({ projectId })).toEqual([]);

    // Reactivating opens what it had not reached, rather than starting again.
    await setLifecycle({ projectId, to: 'ACTIVE', actorUserId: userId, reason: 'more to do' });
    const resumed = await openDiscovery({ projectId, limit: 5 });
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
    expect(opportunity.mechanism).toBe(SEARCH_BUCKETS[0]!.mechanism);
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
          sourceUrl: 'https://example.test/rfp/2026-444',
          accepted: false,
        },
        {
          claim: 'Somebody mentioned a buyer.',
          lane: SIGNAL_LANE,
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

  it('ignores a mission for a candidate discovery did not open', async () => {
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
          claim: 'A statutory fact that happens to have been filed under this lane.',
          lane: SIGNAL_LANE,
          sourceUrl: 'https://example.test/mcl/339',
        },
      ],
    });

    expect(await harvest({ projectId })).toEqual([]);
  });

  it('does nothing at all for a project with no sprint', async () => {
    expect(await runDiscovery(projectId)).toEqual({ opened: [], harvested: [] });
  });
});
