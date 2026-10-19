/**
 * The Opportunity Intelligence integration walk (OPPORTUNITY-INTELLIGENCE §6 F
 * step 3): one sprint, driven by the real passes, from discovery through a
 * stage-one kill, dormancy, a shared capability flipping under a hundred
 * pieces, a re-dive in a new epoch, and qualification.
 *
 * Each piece of this is exercised on its own elsewhere — the staged screen and
 * epochs in `cashStagedDive`, the hundred-piece fan-out in
 * `cashReconsideration`, standing in `cashStanding`, the guarded transition in
 * `cashReconsiderTransition`, own-evidence reuse in `researchReuse`. What only a
 * walk can show is that they compose: that the screen's dormancy is what the
 * reconsideration ledger watches, that the change which meets a watch is what
 * opens the next epoch, and that a re-dive in that epoch is what qualifies the
 * opening — with nothing set by hand in between.
 *
 * What is simulated is the external edge only, as in `cashIntegrationPass` and
 * `cashAutonomousFunnel`: the sentences a worker found and the two judgements
 * only a reader of a source can make, submitted through the real MCP tools
 * under a real lease and decided by Brain's own gate; and the messaging
 * provider, as an effect adapter. Every state the walk asserts is one the
 * Russell tick or `operate()` wrote. The test only ever answers questions Brain
 * itself asked, and the mission lifecycle around each answered packet is linked
 * by the test because judging an idea is itself a bin a fleet worker answers
 * and there is no fleet here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { findTool } from '../server/mcp/tools.ts';
import { claimWork } from '../server/repos/workQueue.ts';
import { advancePacket, approvePlan } from '../server/services/research/packetRunner.ts';
import {
  latestMissionForCandidate,
  launchMission,
  linkMission,
  listOpenRequests,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import {
  createOpportunity,
  getOpportunity,
  listNeeds,
  listOpportunities,
} from '../server/repos/cashPortfolio.ts';
import {
  reconsiderationTriggersFor,
  reopenConditionsFor,
  SUPERSEDED_BY_PREFIX,
} from '../server/repos/cashReconsideration.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { tick } from '../server/services/russell/loop.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { operate } from '../server/services/cash/operate.ts';
import { archiveOpportunity } from '../server/services/cash/opportunities.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { whyNotDiving } from '../server/services/cash/validation.ts';
import { diveStarts } from '../server/services/cash/diveStage.ts';
import { projectStandings } from '../server/services/cash/standing.ts';
import { CAPABILITIES } from '../server/services/cash/capabilities.ts';
import { CONTACT_BUYER_NAMESPACE } from '../server/services/cash/effects.ts';
import {
  CAPABILITY_CHANGED_EVENT,
  RECONSIDER_REQUEST_PREFIX,
  RECONSIDERATION_TRIGGERED_EVENT,
} from '../server/services/cash/reconsider.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { cashTier, type TierReading } from '../server/services/cash/tier.ts';
import { clearAdapters, registerAdapter, type EffectAdapter } from '../server/services/effects/adapter.ts';
import type {
  BlockerKey,
  CashOpportunity,
  ClaimedWork,
  Layer,
  Principal,
  WorkerScope,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

const SEND: BlockerKey = 'CAPABILITY:SEND_A_MESSAGE';

const WORKER_SCOPES: WorkerScope[] = [
  'project:read',
  'documents:read',
  'research:read',
  'research:propose',
  'research:write',
  'claims:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
];

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `walk-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
  const worker = await createWorker({
    name: `walk-worker-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'The research worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: workerId,
    role: 'MEMBER',
    scopes: WORKER_SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

afterEach(() => clearAdapters());

/* --------------------------------------------------------------------------
 * The simulated edge: a worker, through the real tools, and a provider
 * ------------------------------------------------------------------------ */

function principal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'walk-worker',
    displayName: 'The research worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_walk',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_walk_worker',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: WORKER_SCOPES,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      },
    ],
    requestId: 'req_walk',
  } as Principal;
}

async function asWorker(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: principal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

/** Claim the item Brain queued for this packet, and only that one. */
async function claimQueued(type: string, orchestrationId: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId, scopes: WORKER_SCOPES }],
    workTypes: [type],
    orchestrationId,
  });
  if (!claimed) throw new Error(`Brain queued nothing of type ${type}`);
  return claimed;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

interface Found {
  claim: string;
  lane: string;
  sourceUrl: string;
  signal?: string;
}

/**
 * One research packet, answered through the tools and judged by Brain's gate.
 * Returns the orchestration, so a caller can link it to the idea that asked.
 */
async function researchPacket(question: string, found: Found[]): Promise<string> {
  const lanes: { id: string; description: string; necessity: 'REQUIRED' | 'CONDITIONAL' }[] = [
    ...new Set(found.map((one) => one.lane)),
  ].map((id) => ({ id, description: `Evidence for ${id}.`, necessity: 'REQUIRED' as const }));
  if (lanes.some((lane) => lane.id === 'disqualifier') && !lanes.some((lane) => lane.id === 'ruled_out')) {
    lanes.push({ id: 'ruled_out', description: 'A fact that rules it out.', necessity: 'CONDITIONAL' });
  }
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: question,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: question,
    assignment: question,
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets this sprint may look at',
      requiredEvidence: lanes,
      acceptableSourceTypes: ['a published request, posting, listing, notice or schedule'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published source'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'walk',
      question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: userId });

  const researching = await claimQueued('RESEARCH_FRAGMENT', orchestration.id);
  const submitted = await asWorker('brain_submit_claims', {
    ...proof(researching),
    claims: found.map((one) => ({
      claim: one.claim,
      claim_type: 'SOURCED_FACT',
      source_url: one.sourceUrl,
      source_title: 'A published page',
      source_publisher: new URL(one.sourceUrl).hostname,
      source_date: '2026-09-28',
      evidence_excerpt: one.claim,
      evidence_locator: 'the page body',
      evidence_lane: one.lane,
      retrieved_at: '2026-09-29',
      confidence: 0.9,
      primary_source: true,
      ...(one.signal ? { opportunity_signal: one.signal } : {}),
    })),
    search_queries: [question.slice(0, 400)],
  });
  const stored = submitted['claims'] as { claimId: string }[];
  expect(stored).toHaveLength(found.length);
  await asWorker('brain_complete_work', {
    ...proof(researching),
    result_ref: String(submitted['recorded']),
    summary: 'claims submitted',
  });

  await advancePacket(orchestration.id);
  const verifying = await claimQueued('RESEARCH_VERIFY', orchestration.id);
  const gate = await asWorker('brain_submit_verification', {
    ...proof(verifying),
    verdicts: stored.map((row) => ({
      claim_id: row.claimId,
      supports_claim: true,
      geography: 'MATCH',
      timeframe: 'MATCH',
      population: 'MATCH',
      definitions: 'MATCH',
      geography_basis: 'Judged against the geography the fragment declares.',
      timeframe_basis: 'Judged against the timeframe the fragment declares.',
      population_basis: 'Judged against the population the fragment declares.',
      definitions_basis: 'Judged against the definitions the fragment declares.',
      note: 'Read the page.',
    })),
    sufficiency: 'SUFFICIENT',
    missing_lanes: [],
    unresolved_gaps: [],
  });
  // Brain's gate decides, not the worker.
  expect(gate['acceptedClaims']).toBe(found.length);
  await asWorker('brain_complete_work', {
    ...proof(verifying),
    result_ref: String(gate['acceptedClaims']),
    summary: 'verified and gated',
  });
  return orchestration.id;
}

/** Answer an idea Brain created: its packet, then a DONE mission for it. */
async function answer(candidateId: string, question: string, found: Found[]): Promise<string> {
  const orchestrationId = await researchPacket(question, found);
  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: question,
    whyNow: 'Brain asked this',
    idempotencyKey: `mission:${orchestrationId}`,
    candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
  return orchestrationId;
}

function messagingAdapter(): EffectAdapter {
  return {
    name: 'test.messaging',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: CONTACT_BUYER_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (request) => ({ kind: 'CONFIRMED', receiptRef: `rcpt_${request.businessId}` }),
  };
}

/* --------------------------------------------------------------------------
 * Counters, the technique `cashReconsideration` uses
 * ------------------------------------------------------------------------ */

/** How many times any capability reader actually ran while `work` ran. */
async function readsDuring<T>(work: () => Promise<T>): Promise<{ value: T; reads: number }> {
  let reads = 0;
  const originals = CAPABILITIES.map((one) => one.read);
  for (const definition of CAPABILITIES) {
    const read = definition.read;
    if (!read) continue;
    (definition as { read: typeof read }).read = async () => {
      reads += 1;
      return read();
    };
  }
  try {
    return { value: await work(), reads };
  } finally {
    CAPABILITIES.forEach((definition, index) => {
      (definition as { read: unknown }).read = originals[index];
    });
  }
}

async function eventsOf(kind: string, opportunityId?: string): Promise<{ id: string; opportunity_id: string | null }[]> {
  const rows = await getDb().all<{ id: string; opportunity_id: string | null }>(
    'SELECT id, opportunity_id FROM cash_events WHERE project_id = ? AND kind = ?',
    [projectId, kind],
  );
  return opportunityId ? rows.filter((one) => one.opportunity_id === opportunityId) : rows;
}

async function reconsiderRequests() {
  return (await listOpenRequests(projectId)).filter((one) => one.resumeKey.startsWith(RECONSIDER_REQUEST_PREFIX));
}

async function readingOf(opportunity: CashOpportunity): Promise<TierReading> {
  return cashTier({
    opportunity,
    card: cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }),
    readiness: evidenceCard(opportunity).readiness,
  });
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
const QUALIFIED_TIERS = new Set(['QUALIFIED', 'READY_TO_TEST']);

/* --------------------------------------------------------------------------
 * What the open web says. The only fixture in the walk.
 * ------------------------------------------------------------------------ */

const SOURCE = 'https://example.test/westfield/notices/2026-441';

const DISCOVERY: Found = {
  claim:
    'The Westfield drainage authority published request 2026-441 for ownership research ' +
    'on twenty parcels, with a stated budget of USD 2,000, closing 30 October 2026.',
  lane: 'demand_signal',
  sourceUrl: SOURCE,
  signal: 'ACTIVE_BUYER_DEMAND',
};

/** The first screen finds nothing naming who pays — only what does not rule it out. */
const SCREEN_WITHOUT_PAYER: Found[] = [
  {
    claim: 'The notice restricts bidders only by a conflict of interest with a named landowner.',
    lane: 'disqualifier',
    sourceUrl: SOURCE,
  },
];

const PAYER: Found = {
  claim:
    'The Westfield drainage authority procurement officer approves and pays for research ' +
    'purchases under USD 25,000.',
  lane: 'payer',
  sourceUrl: 'https://example.test/westfield/delegations',
};

/** The full dive's gated answers, as `cashAutonomousFunnel` gives them. */
const FULL_DIVE: Found[] = [
  PAYER,
  {
    claim: 'Comparable parcel-ownership research engagements are published at USD 1,800 to USD 2,400.',
    lane: 'price_evidence',
    sourceUrl: 'https://example.test/rates/parcel-research',
  },
  {
    claim: 'The county recorder publishes title-search fees totalling USD 300 for the twenty parcels named.',
    lane: 'cost_evidence',
    sourceUrl: 'https://example.test/county/recorder/fees',
  },
  {
    claim: 'The authority publishes payment terms of net 30 from written acceptance.',
    lane: 'timing',
    sourceUrl: 'https://example.test/westfield/terms',
  },
  {
    claim: 'The notice states the work is a desk review of twenty parcels, about twelve hours.',
    lane: 'effort',
    sourceUrl: SOURCE,
  },
  {
    claim:
      'The notice requires a written ownership table per parcel, delivered by email; no site ' +
      'visit is required.',
    lane: 'delivery_requirements',
    sourceUrl: SOURCE,
  },
  {
    claim: 'The notice disqualifies only bidders with a conflict of interest with a named landowner.',
    lane: 'disqualifier',
    sourceUrl: SOURCE,
  },
  {
    claim: 'The authority states no licence or registration is required below USD 25,000.',
    lane: 'eligibility',
    sourceUrl: 'https://example.test/westfield/procurement-rules',
  },
  {
    claim: 'The notice accepts questions and submissions by email only; no call is required.',
    lane: 'contact_mode',
    sourceUrl: SOURCE,
  },
];

/** A card question Brain raised, answered by the page that settles it. */
function forField(field: string): Found[] | null {
  const lane = 'demand_signal';
  switch (field) {
    case 'payer':
      return [{ claim: PAYER.claim, lane, sourceUrl: PAYER.sourceUrl }];
    case 'access':
      return [
        {
          claim: 'The notice gives procurement@westfield-drainage.example for questions and submissions.',
          lane,
          sourceUrl: SOURCE,
        },
      ];
    case 'price':
      return [{ claim: FULL_DIVE[1]!.claim, lane, sourceUrl: FULL_DIVE[1]!.sourceUrl }];
    case 'exposure':
      return [{ claim: FULL_DIVE[2]!.claim, lane, sourceUrl: FULL_DIVE[2]!.sourceUrl }];
    case 'delivery':
    case 'fulfillment':
      return [{ claim: FULL_DIVE[5]!.claim, lane, sourceUrl: SOURCE }];
    case 'buyingEvidence':
      return [
        {
          claim: 'The Westfield drainage authority published request 2026-441 on 28 September 2026.',
          lane,
          sourceUrl: SOURCE,
        },
      ];
    default:
      return null;
  }
}

/* --------------------------------------------------------------------------
 * The walk
 * ------------------------------------------------------------------------ */

describe('discovery → a stage-one kill → dormant → a shared capability flips → re-dive → qualified', () => {
  it('composes across the real passes, and a replay triggers nothing twice', async () => {
    /* 1. Discovery. A person presses Start; the tick asks; a worker answers. */
    const activated = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(activated.ok).toBe(true);
    expect(await listOpportunities({ projectId })).toEqual([]);

    await tick('walk');
    const bucket = (await listCandidates({ projectId })).find((one) => one.title === SEARCH_BUCKETS[0]!.title);
    expect(bucket, 'discovery opened a bucket round on its own').toBeDefined();
    await answer(bucket!.id, bucket!.statement, [DISCOVERY]);

    await tick('walk');
    const harvested = await listOpportunities({ projectId });
    expect(harvested, 'harvest turned the gated claim into one opening').toHaveLength(1);
    const openingId = harvested[0]!.id;
    expect(harvested[0]!.sourceClaimId).not.toBeNull();
    expect(harvested[0]!.payer ?? null, 'a published request names nobody who pays').toBeNull();

    /* 2. A payer-less opening gets a stage-one SCREEN, never a full dive. */
    let opening = (await getOpportunity(openingId))!;
    for (let pass = 0; pass < 3 && opening.validationState !== 'PENDING'; pass += 1) {
      await tick('walk');
      opening = (await getOpportunity(openingId))!;
    }
    expect(opening.validationState).toBe('PENDING');
    const firstStarts = await diveStarts(openingId);
    expect(firstStarts.map((one) => one.stage)).toEqual(['SCREEN']);
    const screen = firstStarts[0]!;
    expect(opening.candidateId).toBe(screen.candidateId);
    expect(await latestMissionForCandidate(screen.candidateId)).toBeNull();

    // The worker finds nothing naming who pays.
    await answer(screen.candidateId, `Screen: ${opening.title}`, SCREEN_WITHOUT_PAYER);
    await pause();
    await tick('walk');
    opening = (await getOpportunity(openingId))!;
    expect(opening.validationState).toBe('COMPLETE');
    expect(opening.payer ?? null).toBeNull();
    expect((await whyNotDiving(opening)).kind).toBe('STAGE_ONE_FAILED');
    expect(
      (await reopenConditionsFor(openingId))
        .filter((one) => one.triggeredAt === null)
        .map((one) => one.blockerKey)
        .sort(),
    ).toEqual(['EVIDENCE:payer', 'FIELD:payer']);
    const dormant = (await projectStandings(projectId)).get(openingId)!.standing;
    expect(dormant).toMatchObject({ kind: 'DORMANT' });
    expect([...(dormant as { reopenWhen: string[] }).reopenWhen].sort()).toEqual(['EVIDENCE:payer', 'FIELD:payer']);

    // No stage-two packet was compiled, and another tick starts none.
    await tick('walk');
    expect((await diveStarts(openingId)).map((one) => one.stage)).toEqual(['SCREEN']);
    expect((await listCandidates({ projectId })).filter((one) => one.title.startsWith('Qualify:'))).toEqual([]);
    expect((await getOpportunity(openingId))!.validationState).toBe('COMPLETE');

    /* 3 and 5. A hundred pieces share one capability blocker; one a person archived watches it too. */
    const blocked: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const made = await createOpportunity({
        projectId,
        cashModeId: (activated as { mode: { id: string } }).mode.id,
        ownerUserId: userId,
        title: `Opening waiting on outreach ${index}`,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: 'USD',
        requiredCapabilities: ['SEND_A_MESSAGE'],
      });
      blocked.push(made.id);
    }
    const archived = await createOpportunity({
      projectId,
      cashModeId: (activated as { mode: { id: string } }).mode.id,
      ownerUserId: userId,
      title: 'An opening a person stopped until outreach exists',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
      requiredCapabilities: ['SEND_A_MESSAGE'],
    });
    const stopped = await archiveOpportunity({
      opportunityId: archived.id,
      actorRef: userId,
      reason: 'No way to reach buyers yet.',
      reopenWhen: [SEND],
    });
    expect(stopped.ok).toBe(true);

    // The tick names what is missing: one need each, all under the one shared key.
    await operate(projectId);
    // (The same pass also raises each piece's researchable card blanks; those
    // are Brain's to look up and are not what this step is about.)
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter(
      (one) => blocked.includes(one.opportunityId ?? '') && (one.blockerKey ?? '').startsWith('CAPABILITY:'),
    );
    expect(needs).toHaveLength(100);
    expect(new Set(needs.map((one) => one.blockerKey))).toEqual(new Set([SEND]));
    expect(await reconsiderRequests()).toEqual([]);

    // The capability arrives, and ONE operate tick reconsiders every one of them.
    registerAdapter(messagingAdapter());
    await pause();
    const flipped = await readsDuring(() => operate(projectId));
    const reconsideration = flipped.value.reconsideration;
    expect(reconsideration && 'triggered' in reconsideration).toBe(true);
    const triggered = reconsideration && 'triggered' in reconsideration ? reconsideration.triggered : [];
    const triggeredIds = new Set(triggered.map((one) => one.opportunityId));
    for (const id of blocked) expect(triggeredIds.has(id), `piece ${id} was reconsidered`).toBe(true);
    expect(triggered.filter((one) => blocked.includes(one.opportunityId)).every((one) => one.key === SEND)).toBe(true);
    // The dormant opening waits on payer evidence, not on outreach: this change is not its change.
    expect(triggeredIds.has(openingId)).toBe(false);
    // Without per-opportunity capability reads: the vocabulary, read a bounded
    // number of times for the whole pass — never once per piece.
    expect(flipped.reads).toBeLessThan(blocked.length);
    expect(flipped.reads).toBeLessThanOrEqual(CAPABILITIES.length * 2);
    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(1);

    // Reconsideration is not readiness: nothing moved to READY or EXECUTING.
    for (const id of blocked) {
      const after = (await getOpportunity(id))!;
      expect(after.state).toBe('DISCOVERED');
      expect(after.reconsiderRequestedAt).not.toBeNull();
    }
    expect((await listOpportunities({ projectId })).filter((one) => one.state === 'READY' || one.state === 'EXECUTING')).toEqual([]);

    // 5. The person's archive is asked about exactly once, and is not moved.
    expect(triggeredIds.has(archived.id)).toBe(true);
    expect(triggered.find((one) => one.opportunityId === archived.id)).toMatchObject({ via: 'PERSON', key: SEND });
    expect((await getOpportunity(archived.id))!.state).toBe('ARCHIVED');
    const asking = await reconsiderRequests();
    expect(asking).toHaveLength(1);
    expect(asking[0]!.choices.map((one) => one.key).sort()).toEqual(['KEEP', 'RECONSIDER']);

    // 6. Replaying the same tick triggers nothing twice.
    const triggeredEvents = (await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).length;
    expect(triggeredEvents).toBe(triggered.length);
    const replay = await operate(projectId);
    expect(replay.reconsideration && 'triggered' in replay.reconsideration ? replay.reconsideration.triggered : null).toEqual([]);
    await tick('walk');
    expect(await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).toHaveLength(triggeredEvents);
    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(1);
    expect(await reconsiderRequests()).toHaveLength(1);
    expect((await getOpportunity(archived.id))!.state).toBe('ARCHIVED');

    /* 4. New, meaningful evidence about who pays reopens the dormant opening in a new epoch. */
    // Still dormant, and its epoch still spent, before anything new exists.
    opening = (await getOpportunity(openingId))!;
    expect((await whyNotDiving(opening)).kind).toBe('STAGE_ONE_FAILED');
    expect(opening.reconsiderRequestedAt).toBeNull();

    await pause();
    await researchPacket('Who pays for parcel-ownership research at drainage authorities?', [PAYER]);
    await pause();
    await tick('walk');
    opening = (await getOpportunity(openingId))!;
    expect(opening.reconsiderRequestedAt, 'the payer evidence reconsidered it').not.toBeNull();
    const evidenceTriggers = await eventsOf(RECONSIDERATION_TRIGGERED_EVENT, openingId);
    expect(evidenceTriggers).toHaveLength(1);
    const watches = await reopenConditionsFor(openingId);
    const watch = watches.find((one) => one.blockerKey === 'EVIDENCE:payer')!;
    expect(watch.triggeredAt).not.toBeNull();
    // One reopening per dormancy: the sibling watch is retired, not left to fire
    // on the payer this very re-dive is about to write onto the card.
    const sibling = watches.find((one) => one.blockerKey === 'FIELD:payer')!;
    expect(sibling.triggeredAt).not.toBeNull();
    expect(sibling.triggerChangeRef).toBe(`${SUPERSEDED_BY_PREFIX}${watch.triggerChangeRef}`);

    // A new epoch allows a new dive: the tick that reconsidered it started one.
    const secondStarts = await diveStarts(openingId);
    expect(secondStarts.length).toBe(2);
    expect(secondStarts[1]!.epochStartedAt).not.toBe(secondStarts[0]!.epochStartedAt);
    expect(opening.validationState).toBe('PENDING');

    // Then the walk answers only what Brain asks, until the full bar is met.
    const answered = new Set<string>([screen.candidateId]);
    let fullDiveAnswered = false;
    let reading = await readingOf(opening);
    for (let pass = 0; pass < 14 && !QUALIFIED_TIERS.has(reading.tier); pass += 1) {
      opening = (await getOpportunity(openingId))!;
      if (opening.validationState === 'PENDING' && opening.candidateId && !answered.has(opening.candidateId)) {
        if (!(await latestMissionForCandidate(opening.candidateId))) {
          answered.add(opening.candidateId);
          const starts = await diveStarts(openingId);
          const stage = starts.find((one) => one.candidateId === opening.candidateId)?.stage;
          if (stage === 'SCREEN') {
            // The second screen finds the payer.
            await answer(opening.candidateId, `Screen: ${opening.title}`, [PAYER]);
          } else {
            await answer(opening.candidateId, `Qualify: ${opening.title}`, FULL_DIVE);
            fullDiveAnswered = true;
          }
        }
      }
      for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
        if (need.opportunityId !== openingId) continue;
        if (!need.candidateId || answered.has(need.candidateId)) continue;
        if (await latestMissionForCandidate(need.candidateId)) continue;
        const field = need.requestKey?.split(':').pop() ?? '';
        const found = forField(field);
        if (!found) continue;
        answered.add(need.candidateId);
        await answer(need.candidateId, need.nextStep, found);
      }
      await pause();
      await tick('walk');
      opening = (await getOpportunity(openingId))!;
      reading = await readingOf(opening);
      // QUALIFIED only after the full dive's answers landed: the payer alone qualifies nothing.
      if (!fullDiveAnswered) expect(QUALIFIED_TIERS.has(reading.tier), `qualified on ${reading.tier} before the full dive`).toBe(false);
    }

    expect(
      { tier: reading.tier, toAdvance: reading.toAdvance.map((one) => one.key) },
      `the walk stopped at ${reading.tier}`,
    ).toMatchObject({ tier: expect.stringMatching(/^(QUALIFIED|READY_TO_TEST)$/) });
    expect(fullDiveAnswered).toBe(true);
    const stages = (await diveStarts(openingId)).map((one) => one.stage);
    expect(stages[0]).toBe('SCREEN');
    expect(stages).toContain('FULL');
    expect(opening.payer).toContain('procurement officer');
    // Every dive after the dormancy ran in the one epoch the payer evidence
    // opened: the re-dive's own answers reopened nothing.
    expect((await reconsiderationTriggersFor(openingId)).map((one) => one.blockerKey)).toEqual(['EVIDENCE:payer']);
    const after = (await diveStarts(openingId)).slice(1);
    expect(new Set(after.map((one) => one.epochStartedAt)).size).toBe(1);
    // Nobody typed a fact onto the card.
    expect((await cardFactsFor(openingId)).filter((one) => one.kind === 'PERSON')).toEqual([]);

    /* 6, again. A replay of the whole tick re-opens nothing and asks nothing twice. */
    const before = {
      triggers: (await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).length,
      changes: (await eventsOf(CAPABILITY_CHANGED_EVENT)).length,
      starts: (await diveStarts(openingId)).length,
    };
    const last = await operate(projectId);
    expect(last.reconsideration && 'triggered' in last.reconsideration ? last.reconsideration.triggered : null).toEqual([]);
    await tick('walk');
    expect((await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).length).toBe(before.triggers);
    expect((await eventsOf(CAPABILITY_CHANGED_EVENT)).length).toBe(before.changes);
    expect((await diveStarts(openingId)).length).toBe(before.starts);
    expect(await reconsiderRequests()).toHaveLength(1);
    expect((await getOpportunity(archived.id))!.state).toBe('ARCHIVED');
    for (const id of blocked) expect((await getOpportunity(id))!.state).toBe('DISCOVERED');
  }, 180_000);
});
