/**
 * One sprint, walked the whole way, through the entrances production uses.
 *
 * `cashMode`, `cashMoney`, `cashAuthority`, `cashPortfolio`, `cashDiscovery`
 * and `cashOperate` each prove one service. None of them walks the journey, and
 * walking it is what this file is for — because every defect an external review
 * found in the first pass was a transition that existed, was tested, and could
 * be reached by nothing:
 *
 *   - activating wrote a mode row and no goal, candidate, mission or job, so a
 *     sprint sat empty beside a healthy fleet while the screen said discovery
 *     had started;
 *   - `required_capabilities` was written by the card and read by nothing;
 *   - `closeNeed` set a status and resumed nothing, because nothing recorded
 *     what had been waiting;
 *   - `beginExecution` wrote EXECUTING with no work enqueued and no action
 *     performed.
 *
 * Every one of them was invisible to a test that arranges its own starting
 * state, which is the fifth time this repository has had to write that a
 * mechanism nothing calls is not a mechanism.
 *
 * **Only the research worker is simulated, and its output is a declared
 * fixture.** `completesResearch` writes what a Cowork session's accepted claims
 * become — it is not live research and nothing here reaches the network.
 * Everything between is the real tick, the real compiler, the real gate on the
 * card, the real authority check and the real repositories. No step writes a
 * row it then asserts, and where a decision belongs to a person the test makes
 * it through the same service the product calls.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import {
  getMission,
  linkMission,
  listMissions,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { getNeed, listNeeds, listOpportunities } from '../server/repos/cashPortfolio.ts';
import { actionsFor } from '../server/repos/cashActions.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { tick } from '../server/services/russell/loop.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import {
  actionKey,
  advance,
  beginExecution,
  fillCard,
  markReady,
  recordMoneyEvent,
} from '../server/services/cash/opportunities.ts';
import { closeNeed } from '../server/services/cash/needs.ts';
import { cashView } from '../server/services/cash/view.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import type { Layer } from '../server/domain/types.ts';

let fixture: Awaited<ReturnType<typeof freshProject>>;
let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `sprint-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

/**
 * The standing *research* authority, which is a different decision from the
 * commercial grant and is never manufactured by activating a sprint.
 */
async function authorizeResearch(): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode discovery',
    allowedWork: ['RESEARCH'],
    maxMissions: 8,
    maxFragments: 24,
    maxConcurrent: 2,
    maxProbes: 4,
  });
}

/** The commercial grant, which is the one thing execution cannot proceed without. */
async function authorizeCommerce(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 200_000,
    maxPerActionCents: 50_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/**
 * A declared fixture standing in for one Cowork session's accepted claims.
 *
 * Not live research and not a shortcut past the gate: these rows are what a
 * fragment looks like *after* `gateFragment` accepted its claims, which is the
 * only shape `harvest` ever reads. What is under test is what Brain does with
 * them, and inventing the network instead would test the network.
 */
async function completesResearch(input: {
  candidateId: string;
  claims: { claim: string; sourceUrl: string; observedOn: string }[];
}): Promise<void> {
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
        { id: 'demand_signal', description: 'a published request', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a marketplace or job board listing'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
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
  await updateFragment(fragment!.id, {
    status: 'ACCEPTED',
    completedAt: new Date().toISOString(),
    blockedReason: null,
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
      sourceDate: one.observedOn,
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the listing body',
      evidenceLane: 'demand_signal',
      retrievedAt: one.observedOn,
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.sourceUrl}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });

  const { mission } = await (async () => {
    const existing = (await listMissions({ projectId })).find(
      (one) => one.candidateId === input.candidateId,
    );
    if (existing) return { mission: existing };
    const { launchMission } = await import('../server/repos/russellMissions.ts');
    return launchMission({
      projectId,
      layerId: layer.id,
      visibility: 'SHARED',
      objective: 'a discovery bucket',
      whyNow: 'the sprint is active',
      idempotencyKey: `mission:${orchestration.id}`,
      candidateId: input.candidateId,
    });
  })();
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  const now = (await getMission(mission.id))!;
  if (now.state !== 'DONE') {
    if (now.state === 'PLANNED') {
      await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    }
    await transitionMission({
      missionId: (await getMission(mission.id))!.id,
      from: (await getMission(mission.id))!.state,
      to: 'DONE',
    });
  }
}

describe('one sprint, from activation to money in and winding down', () => {
  it('walks the whole journey through the entrances production uses', async () => {
    /* ------------------------------------------------------------------ *
     * 1. A person activates the sprint. It spends nothing and authorizes
     *    nothing: the research grant and the commercial grant are two
     *    separate decisions and this is neither of them.
     * ------------------------------------------------------------------ */
    const activated = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(activated.ok).toBe(true);
    expect(await listOpportunities({ projectId })).toEqual([]);

    /* ------------------------------------------------------------------ *
     * 2. The tick starts discovery. This is the connection that did not
     *    exist: before it, a sprint could sit here for ever.
     * ------------------------------------------------------------------ */
    await authorizeResearch();
    const opening = await tick('journey');
    const discovery = opening.cashDiscovery.find((one) => one.projectId === projectId);
    expect(discovery?.opened).toHaveLength(1);
    expect(SEARCH_BUCKETS.map((one) => one.id)).toContain(discovery!.opened[0]!);

    const candidates = await listCandidates({ projectId });
    expect(candidates).toHaveLength(1);
    // Captured, so the archive is asked first and the judgment decides. It is
    // not queued past any of that, which is what would make this a second
    // pipeline rather than a new entrance.
    const bucketCandidate = candidates[0]!;

    /* ------------------------------------------------------------------ *
     * 3. The research finishes, and what it found becomes the portfolio.
     *    A lane is a row, so no prose is read to decide what is an opening.
     * ------------------------------------------------------------------ */
    await completesResearch({
      candidateId: bucketCandidate.id,
      claims: [
        {
          claim:
            'A regional drainage authority published a paid request for parcel research, ' +
            'closing on 30 September 2026.',
          sourceUrl: 'https://example.test/rfp/2026-441',
          observedOn: '2026-09-10',
        },
      ],
    });

    const harvesting = await tick('journey');
    const filed = harvesting.cashDiscovery.find((one) => one.projectId === projectId);
    expect(filed?.harvested).toHaveLength(1);
    // The same tick's operating pass is where the needs come from, so the
    // report that says a piece was filed is the report that says what it is
    // still missing. They are one pass over one project for a reason.
    const operated = harvesting.cashOperations.find((one) => one.projectId === projectId);
    expect(operated?.needsRaised.length).toBeGreaterThan(0);
    expect(operated?.dependentWork.length).toBeGreaterThan(0);

    const [piece] = await listOpportunities({ projectId });
    expect(piece!.state).toBe('DISCOVERED');
    expect(piece!.sourceClaimId).toBeTruthy();
    expect(piece!.discoveredByCandidateId).toBe(bucketCandidate.id);
    // The card is blank. A published request is evidence somebody asked and is
    // not a payer, a price, an acceptance condition or a delivery path.
    expect(piece!.payer).toBeNull();
    expect(piece!.priceCents).toBeNull();

    /* ------------------------------------------------------------------ *
     * 4. Brain names what it still does not know — and goes and finds the
     *    parts that are facts rather than the owner's decisions.
     * ------------------------------------------------------------------ */
    /*
     * Asserted on the rows rather than on one tick's report, deliberately.
     *
     * The operating pass runs in the same tick as the harvest, so the needs
     * for a piece filed on tick 2 are raised on tick 2 — and a test that
     * demanded them in tick 3's report would be pinning the order the passes
     * happen to run in rather than the thing that matters, which is that they
     * exist and say what they are waiting for.
     */
    const raised = await listNeeds({ projectId, states: ['OPEN'] });
    expect(raised.length).toBeGreaterThan(0);
    const fields = raised.map((one) => one.requestKey?.split(':').pop()).sort();
    // Payer and access are facts about the world. The buying evidence arrived
    // with the claim, so it is not asked about — and the price, the offer and
    // the delivery path are never asked of a worker at all.
    expect(fields).toEqual(['access', 'payer']);
    for (const need of raised) {
      expect(need.completionCondition).toBeTruthy();
      expect(need.blocksState).toBe('EXECUTING');
    }

    // Each one becomes a real research idea rather than a note on a screen —
    // which is what makes a need a dependent work reference rather than prose.
    for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
      expect(need.candidateId).toBeTruthy();
    }
    const questionIdeas = new Set(
      (await listNeeds({ projectId, states: ['OPEN'] })).map((one) => one.candidateId),
    );
    expect(questionIdeas.size).toBe(raised.length);

    /* ------------------------------------------------------------------ *
     * 5. The answers arrive and the needs settle themselves, because the
     *    condition Brain wrote is one Brain can read.
     * ------------------------------------------------------------------ */
    const filledIn = await fillCard({
      opportunityId: piece!.id,
      actorRef: userId,
      patch: {
        payer: 'The authority’s procurement officer, who signs',
        reachableChannel: 'The address on the published notice; they replied on Tuesday',
        offerScope: 'One parcel research packet for the named sections',
        acceptanceCondition: 'The packet lists every parcel with its current owner of record',
        priceCents: 120_000,
        deliveryMethod: 'Two days of record searching and one afternoon of assembly',
        fulfillmentOwner: 'Us',
        peakFundingCents: 0,
      },
    });
    expect(filledIn.ok).toBe(true);

    await tick('journey');
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(0);
    expect((await listNeeds({ projectId, states: ['RESOLVED'] })).length).toBe(2);

    /* ------------------------------------------------------------------ *
     * 6. Executing is refused until a person has decided what Brain may do,
     *    and then until something has actually happened.
     * ------------------------------------------------------------------ */
    expect((await markReady({ opportunityId: piece!.id, actorRef: userId })).ok).toBe(true);

    const beforeGrant = await beginExecution({ opportunityId: piece!.id, actorRef: userId });
    expect(beforeGrant.ok).toBe(false);
    if (!beforeGrant.ok) expect(beforeGrant.reason).toContain('commercial authority');

    await authorizeCommerce();
    const beforeAnything = await beginExecution({ opportunityId: piece!.id, actorRef: userId });
    expect(beforeAnything.ok).toBe(false);
    if (!beforeAnything.ok) {
      expect(beforeAnything.reason).toContain('Nothing has happened on this yet');
    }

    const executing = await beginExecution({
      opportunityId: piece!.id,
      actorRef: userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Replied to the notice with a one-page scope and the price.',
        reference: 'notice-2026-441',
        requestKey: actionKey(piece!.id, 'CONTACT_BUYER', 'first'),
      },
    });
    expect(executing.ok).toBe(true);
    expect((await actionsFor(piece!.id))).toHaveLength(1);

    /* ------------------------------------------------------------------ *
     * 7. A capability Brain does not have becomes a need with a remedy, and
     *    answering it resumes what was waiting — exactly once.
     * ------------------------------------------------------------------ */
    const { updateOpportunity, transitionOpportunity } = await import(
      '../server/repos/cashPortfolio.ts'
    );
    await updateOpportunity(piece!.id, {
      required_capabilities: JSON.stringify(['ISSUE_AN_INVOICE']),
    });
    await tick('journey');
    const capabilityNeed = (await listNeeds({ projectId, states: ['OPEN'] }))[0]!;
    expect(capabilityNeed.requestKey).toContain('capability:');
    expect(capabilityNeed.recommendedPath).toContain('invoicing integration');
    // It stops nothing. The piece is executing and stays executing.
    expect((await listOpportunities({ projectId }))[0]!.state).toBe('EXECUTING');

    // Put it back to the shape a resumption starts from, answer the need, and
    // the transition it was blocking is retried by itself.
    await transitionOpportunity({ id: piece!.id, from: ['EXECUTING'], to: 'READY' });
    expect(
      (
        await closeNeed({
          needId: capabilityNeed.id,
          to: 'RESOLVED',
          resolution: 'Invoicing is handled outside Brain for now, and the invoice is sent.',
          actorUserId: userId,
        })
      ).ok,
    ).toBe(true);

    const resuming = await tick('journey');
    expect(
      resuming.cashOperations.find((one) => one.projectId === projectId)?.resumed,
    ).toContain(capabilityNeed.id);
    expect((await listOpportunities({ projectId }))[0]!.state).toBe('EXECUTING');

    // And once, however many ticks read it.
    const again = await tick('journey');
    expect(
      again.cashOperations.find((one) => one.projectId === projectId)?.resumed ?? [],
    ).not.toContain(capabilityNeed.id);
    expect((await getNeed(capabilityNeed.id))!.continuedAt).toBeTruthy();

    /* ------------------------------------------------------------------ *
     * 8. Delivery, then money — and only a settlement is cash.
     * ------------------------------------------------------------------ */
    expect(
      (await advance({ opportunityId: piece!.id, to: 'DELIVERING', actorRef: userId })).ok,
    ).toBe(true);
    // Agreed, which is pipeline: the customer has said yes and nothing has
    // moved. It is deliberately not cash, and never becomes cash by itself.
    expect(
      (
        await recordMoneyEvent({
          projectId,
          opportunityId: piece!.id,
          kind: 'PIPELINE_AGREED',
          amountCents: 120_000,
          currency: 'USD',
          actorRef: userId,
          idempotencyKey: `agreed:${piece!.id}`,
        })
      ).ok,
    ).toBe(true);

    // A payment nobody can trace is not a payment. The reference is what makes
    // the row verifiable, and it is refused without one.
    const untraceable = await recordMoneyEvent({
      projectId,
      opportunityId: piece!.id,
      kind: 'CUSTOMER_PAYMENT',
      amountCents: 120_000,
      currency: 'USD',
      actorRef: userId,
      idempotencyKey: `unverified:${piece!.id}`,
    });
    expect(untraceable.ok).toBe(false);

    expect(
      (
        await recordMoneyEvent({
          projectId,
          opportunityId: piece!.id,
          kind: 'CUSTOMER_PAYMENT',
          amountCents: 120_000,
          currency: 'USD',
          verifiedReference: 'stripe-pi-88412',
          actorRef: userId,
          idempotencyKey: `payment:${piece!.id}`,
        })
      ).ok,
    ).toBe(true);

    const earnedOnly = await cashView({ projectId });
    // Earned, and not yet usable: a payment and a settlement are two events
    // about the same money and only the second one is cash.
    expect(earnedOnly.myCash.position.customerPaymentsCents).toBe(120_000);
    expect(earnedOnly.myCash.position.availableFundsCents).toBe(0);
    expect(earnedOnly.myCash.position.pipelineCents).toBe(120_000);

    expect(
      (
        await recordMoneyEvent({
          projectId,
          opportunityId: piece!.id,
          kind: 'SETTLEMENT',
          amountCents: 120_000,
          currency: 'USD',
          verifiedReference: 'bank-ref-88412',
          actorRef: userId,
          idempotencyKey: `settlement:${piece!.id}`,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await advance({ opportunityId: piece!.id, to: 'COLLECTED', actorRef: userId })).ok,
    ).toBe(true);

    const collected = await cashView({ projectId });
    expect(collected.myCash.position.availableFundsCents).toBe(120_000);
    expect(collected.myCash.position.deployableCents).toBe(120_000);

    /* ------------------------------------------------------------------ *
     * 9. Winding down stops new discovery and nothing else.
     * ------------------------------------------------------------------ */
    const openedBefore = (await listCandidates({ projectId })).length;
    expect(
      (
        await setLifecycle({
          projectId,
          to: 'WINDING_DOWN',
          actorUserId: userId,
          reason: 'Enough for now.',
        })
      ).ok,
    ).toBe(true);

    const windingDown = await tick('journey');
    expect(
      windingDown.cashDiscovery.find((one) => one.projectId === projectId)?.opened ?? [],
    ).toEqual([]);
    expect((await listCandidates({ projectId })).length).toBe(openedBefore);

    // Everything already in the portfolio is untouched, the money history
    // stands, and the sprint itself is still readable.
    const after = await cashView({ projectId });
    expect(after.myCash.position.availableFundsCents).toBe(120_000);
    expect(after.myCurrentWork.placements).toHaveLength(1);
    expect(after.discovery.open).toBe(false);
    expect((await getCashMode(projectId))!.state).toBe('WINDING_DOWN');
    expect(after.whatBrainHasDone.length).toBeGreaterThan(5);
  });
});
