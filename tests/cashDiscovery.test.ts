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
import { listCashEvents } from '../server/repos/cashMode.ts';
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
import {
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
      claimType: 'SOURCED_FACT' as const,
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
          claim: 'Nobody asked for anything and there is no buyer here.',
          lane: SIGNAL_LANE,
          sourceUrl: 'https://example.test/rfp/2026-443',
        },
      ],
    });

    const harvested = await harvest({ projectId });
    // The economics claim reads like an opening and is not one; the signal
    // claim reads like the opposite and is. The column decides, not the words.
    expect(harvested).toHaveLength(1);
    expect(harvested[0]!.opportunity.buyingSignal).toContain('Nobody asked');
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
