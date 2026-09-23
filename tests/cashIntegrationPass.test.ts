/**
 * One sprint, walked the whole way, through the entrances production uses.
 *
 * Each of `cashMode`, `cashMoney`, `cashAuthority`, `cashPortfolio`,
 * `cashDiscovery` and `cashOperate` proves one service. None of them walks the
 * journey, and walking it is what this file is for — because every defect two
 * external reviews found was a transition that existed, was tested, and could
 * be reached by nothing.
 *
 * ---------------------------------------------------------------------------
 * What the first version of this file could not prove, and why
 * ---------------------------------------------------------------------------
 *
 * It filled the evidence card by calling `fillCard` as the user with the payer,
 * the access channel, the offer, the price, the acceptance condition, the
 * delivery path and the fulfilment owner already in hand. So the step it looked
 * like it was demonstrating — research reaching a card — was the one step it
 * supplied the answer to. The connection was missing the whole time and the
 * journey passed.
 *
 * It also rewound an EXECUTING opportunity to READY by hand, with an action
 * already on its record, and called what followed a resumption. That proves a
 * retry from a state nothing naturally reaches; it does not prove the first
 * resumption works, which is the one that was broken.
 *
 * ---------------------------------------------------------------------------
 * What is simulated, and where the line is
 * ---------------------------------------------------------------------------
 *
 * **The external edge, and nothing else.** `workerResearches` authenticates as
 * a `WORKER` principal, claims a research item off the durable queue and
 * submits through `brain_submit_claims` and `brain_submit_verification` — the
 * same tools a Cowork session calls — so the scope check, the lease and
 * generation proof, the lane validation, Step 6's idempotency and Brain's own
 * evidence gate all run here. What is fixture is what a worker brings in from
 * outside: the sentences it found, and the two judgements only somebody who
 * read the source can make.
 *
 * **Two things this is not, said plainly rather than left to be assumed.** It
 * is not a live Cowork session: no Routine is fired, no provider is called, no
 * OAuth token is minted, and nothing external is read — the claims are a
 * declared fixture and the web is never touched. And it is the tool *layer*
 * rather than the MCP *transport*: the tools are invoked through the registry
 * with a constructed principal, so `POST /mcp`, the bearer, the era
 * dispatcher, origin validation and the rate limiter are **not** exercised
 * here. `tests/mcp.test.ts` and `tests/oauth.test.ts` are what cover those,
 * for the reason `packet.test.ts` gives: what is under test here is the
 * authorization, the gate and the idempotency rather than the wire.
 *
 * No live buyer, live payment or live Cowork activation happens in this suite.
 *
 * Everything else actually runs: the durable tick, the discovery producer, the
 * harvest, the capability register, the needs, the continuations, the card, the
 * commercial proposal, the authority check and the money. A person's answers go
 * through the HTTP routes the Cash screen calls, mounted in process —
 * `cashSection.test.tsx` is what proves the screen calls those routes, and this
 * is what proves the routes do the thing.
 *
 * Two of the twelve acceptance points are demonstrated by their own suites and
 * are named here rather than duplicated: the non-USD money journey is
 * `cashCurrencyHttp`, driven against a booted server, and the deterministic
 * two-connection concurrency test is `cashConcurrency`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { freshProject } from './helpers.ts';
import { EXECUTION_THESIS } from './helpers/cashTier.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { findTool } from '../server/mcp/tools.ts';
import { claimWork } from '../server/repos/workQueue.ts';
import { advancePacket, approvePlan } from '../server/services/research/packetRunner.ts';
import { createWorker } from '../server/repos/identity.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createCandidate, getCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import {
  CONTINUATION_LEASE_MS,
  claimNeedContinuation,
  getNeed,
  getOpportunity,
  listNeeds,
  listOpportunities,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { actionsFor } from '../server/repos/cashActions.ts';
import { getCashMode, listCashEvents, recordCashEvent } from '../server/repos/cashMode.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { tick } from '../server/services/russell/loop.ts';
import {
  activate,
  launchableUnderCashMode,
  setLifecycle,
} from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import { SEARCH_BUCKETS, openDiscovery } from '../server/services/cash/discovery.ts';
import { advanceWithinAuthority, runNeedContinuations } from '../server/services/cash/operate.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import { cashView } from '../server/services/cash/view.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  ProjectMembership,
  WorkerScope,
} from '../server/domain/types.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

let fixture: Awaited<ReturnType<typeof freshProject>>;
let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

/**
 * Everything a research worker holds.
 *
 * Spelled out rather than taken from a constant, because the point of going
 * through the tools is that a missing scope refuses — and a list built from
 * whatever the tool asks for could never show that.
 */
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
  const worker = await createWorker({
    name: `sprint-worker-${Math.random().toString(36).slice(2, 10)}`,
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
 * One worker session's result for one fragment, the way a real one arrives.
 *
 * Not the service functions: the **tools**. The worker authenticates as a
 * `WORKER` principal, claims a `RESEARCH_FRAGMENT` item off the durable queue,
 * reads its assignment, and submits through `brain_submit_claims` and
 * `brain_submit_verification` carrying the fence its claim gave it. So
 * everything a real Cowork session is held to actually runs here: the scope
 * check, the lease and generation proof, the lane validation that refuses
 * *before* anything is stored, Step 6's idempotency scope, the pass records,
 * the one-ledger-per-fragment guard, and then Brain's own gate.
 *
 * What is simulated is the one thing that has to be — the **external edge**:
 * the sentences a worker found on the open web, and the two judgements only
 * somebody who read the source can make. Both are a declared fixture; nothing
 * here reads the web, fires a Routine or calls a provider.
 *
 * The transport is the other half that is not exercised: these are the real
 * tools reached through the registry, not over `POST /mcp` behind an OAuth
 * bearer. No live buyer, no live payment and no live Cowork activation happens
 * in this suite, and nothing here claims one.
 */
async function principalFor(scopes: WorkerScope[] = WORKER_SCOPES): Promise<Principal> {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'sprint-worker',
    displayName: 'The research worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_sprint',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_sprint_worker',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      },
    ],
    requestId: 'req_sprint',
  };
}

/** One MCP tool call, as the worker. */
async function asWorker(
  name: string,
  args: Record<string, unknown>,
  scopes: WorkerScope[] = WORKER_SCOPES,
): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: await principalFor(scopes),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

/**
 * Claim whatever Brain has queued of this type.
 *
 * It does not enqueue: `approvePlan` and `advancePacket` do that, which is the
 * point. An item the test created would prove the tools accept a proof the test
 * also wrote; this one was written by the runner, for a fragment the runner
 * moved to QUEUED, and the worker finds it the same way a fired session does.
 */
async function claimQueued(type: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId, scopes: WORKER_SCOPES }],
    workTypes: [type],
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

async function workerResearches(input: {
  candidateId: string;
  question: string;
  lanes: { id: string; description: string; necessity: 'REQUIRED' | 'CONDITIONAL' }[];
  claims: {
    claim: string;
    lane: string;
    sourceUrl: string;
    claimType?: 'SOURCED_FACT' | 'NEGATIVE_EXISTENCE';
    sourceDate?: string;
    supports?: boolean;
    /*
     * What kind of opening the worker says this claim is, from the closed
     * vocabulary, or nothing when it is not one.
     *
     * This is the fixture half of the bridge: a claim becomes a piece of work
     * because somebody who read the source typed it as an opening, never
     * because a sentence about it matched a word. A claim with no signal is
     * evidence and nothing else, which is why the documented absence below
     * carries none.
     */
    signal?: string;
  }[];
  sufficiency?: 'SUFFICIENT' | 'INSUFFICIENT';
}): Promise<{ missionId: string; orchestrationId: string }> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: input.question,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: input.question,
    assignment: input.question,
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets this sprint may look at',
      requiredEvidence: input.lanes,
      acceptableSourceTypes: ['a published request, posting, listing or notice'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published source'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'walk',
      question: input.question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  // A plan a person approved, which is the only thing that queues research
  // (§16). The runner moves the fragment to QUEUED and writes the work item.
  const approved = await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: userId });
  expect(approved.enqueued.length).toBeGreaterThan(0);

  // The worker takes that item off the queue. Everything after this carries the
  // fence that claim issued, and a call that could not prove it is refused.
  const researching = await claimQueued('RESEARCH_FRAGMENT');

  // It reads the declaration the gate will judge it against — the lane ids a
  // claim must name come from here, never from the test.
  const assignment = (await asWorker('brain_get_assignment', {
    work_item_id: researching.workItemId,
  }))['assignment'] as Record<string, unknown>;
  const declared = assignment['fragment'] as Record<string, unknown>;
  expect(declared['evidenceLaneIds']).toEqual(input.lanes.map((lane) => lane.id));

  const submitted = await asWorker('brain_submit_claims', {
    ...proof(researching),
    claims: input.claims.map((one) => ({
      claim: one.claim,
      claim_type: one.claimType ?? 'SOURCED_FACT',
      source_url: one.sourceUrl,
      source_title: 'A published page',
      source_publisher: new URL(one.sourceUrl).hostname,
      source_date: one.sourceDate ?? '2026-09-10',
      evidence_excerpt: one.claim,
      evidence_locator: 'the page body',
      evidence_lane: one.lane,
      retrieved_at: '2026-09-12',
      confidence: 0.9,
      primary_source: true,
      ...(one.signal ? { opportunity_signal: one.signal } : {}),
    })),
    search_queries: [input.question],
  });
  // Stored, and none of them accepted: the worker never decides that.
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];
  await asWorker('brain_complete_work', {
    ...proof(researching),
    result_ref: String(submitted['recorded']),
    summary: 'claims submitted',
  });

  // Completing that item advances the packet, and the packet is what decides
  // the verification is next. Reading the sources is its own job, and it is
  // what lets the gate ask the two questions Brain cannot.
  await advancePacket(orchestration.id);
  const verifying = await claimQueued('RESEARCH_VERIFY');
  const gate = await asWorker('brain_submit_verification', {
    ...proof(verifying),
    verdicts: stored.map((row, index) => ({
      claim_id: row.claimId,
      supports_claim: input.claims[index]!.supports ?? true,
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
    sufficiency: input.sufficiency ?? 'SUFFICIENT',
    missing_lanes: [],
    unresolved_gaps: [],
  });
  expect(gate['acceptedClaims']).toBeGreaterThan(0);
  await asWorker('brain_complete_work', {
    ...proof(verifying),
    result_ref: String(gate['acceptedClaims']),
    summary: 'verified and gated',
  });

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: input.question,
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
  return { missionId: mission.id, orchestrationId: orchestration.id };
}

/**
 * The Cash routes, mounted in process behind a real request context.
 *
 * Not a convenience: the point of a walk is which transitions have a
 * production caller, and for a person's own answers the production caller is
 * the route the Cash screen calls. `cashSection.test.tsx` proves the screen
 * calls these; this proves they do the thing.
 */
async function withCashRoutes<T>(
  fn: (
    call: (method: string, route: string, body?: unknown) => Promise<{ status: number; body: any }>,
  ) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      /*
       * The path the policy module matches on, which is the one the request
       * already carries. `req.path` in a middleware registered with no mount
       * path is the whole path, so prefixing `/api` again yields `/api/api/…`,
       * which matches no pattern in `services/identity/policy.ts` and falls
       * silently to the default `READ` — every write in this harness would then
       * be authorized at the wrong level, and a refusal asserted against one
       * would be vacuous.
       */
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', cashRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({
      error: String(error?.message ?? error),
    });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(async (method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* left as text */
      }
      return { status: response.status, body: parsed as any };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'ADMIN',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

/** The lanes a discovery bucket declares, so a negative finding has a home. */
const DISCOVERY_LANES = [
  { id: 'demand_signal', description: 'An opening that is open.', necessity: 'REQUIRED' as const },
  {
    id: 'demand_absence',
    description: 'A documented absence.',
    necessity: 'CONDITIONAL' as const,
  },
];

/** The single lane a card question declares. */
const CARD_LANES = [
  {
    id: 'demand_signal',
    description: 'The published page that settles it.',
    necessity: 'REQUIRED' as const,
  },
];

describe('one sprint, from activation to money in and winding down', () => {
  it('walks the whole journey through the entrances production uses', async () => {
    /* ------------------------------------------------------------------ *
     * 1. A person activates the sprint, and the tick starts discovery.
     *
     * Activating spends nothing and authorizes nothing: the research grant
     * and the commercial grant are two separate decisions and this is
     * neither. Before this connection existed a sprint could sit here for
     * ever while the screen said discovery had started.
     * ------------------------------------------------------------------ */
    const activated = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(activated.ok).toBe(true);
    expect(await listOpportunities({ projectId })).toEqual([]);

    await authorizeResearch();
    const opening = await tick('journey');
    const discovery = opening.cashDiscovery.find((one) => one.projectId === projectId);
    expect(discovery?.opened).toHaveLength(1);

    /*
     * The bucket this step is about, by name rather than by position.
     *
     * The same tick also opens the industry kernel's bootstrap question, so
     * `[0]` stopped meaning "the search bucket" the moment a second kind of
     * discovery existed. Selecting by the title `openDiscovery` writes keeps
     * this step about the thing it is testing however many other entrances
     * open beside it.
     */
    const candidates = await listCandidates({ projectId });
    const bucket = candidates.find((one) => one.title === SEARCH_BUCKETS[0]!.title)!;
    expect(bucket).toBeDefined();
    // Captured, so the archive is asked first and the judgment decides — this
    // is a new entrance to the existing path, not a second pipeline.
    expect(bucket.state).toBe('CAPTURED');
    // And the question a worker reads says what the sprint is for, which used
    // to sit in an event detail nothing downstream opened.
    expect(bucket.statement).toContain('Maximize additional usable cash');

    /* ------------------------------------------------------------------ *
     * 2. A sourced opening comes back through the worker-result boundary,
     *    beside a documented absence that must not become one.
     * ------------------------------------------------------------------ */
    await workerResearches({
      candidateId: bucket.id,
      question: bucket.statement,
      lanes: DISCOVERY_LANES,
      claims: [
        {
          claim:
            'The Westfield drainage authority published a request for parcel research, ' +
            'closing 30 September 2026.',
          lane: 'demand_signal',
          sourceUrl: 'https://example.test/notices/2026-441',
          signal: 'PAID_TASK_OR_CONTRACT',
        },
        {
          claim:
            'A documented search of the three regional boards found no other open requests ' +
            'for this work.',
          lane: 'demand_absence',
          sourceUrl: 'https://example.test/boards/search',
          claimType: 'NEGATIVE_EXISTENCE',
        },
      ],
    });

    const harvesting = await tick('journey');
    const filed = harvesting.cashDiscovery.find((one) => one.projectId === projectId);
    expect(filed?.harvested).toHaveLength(1);

    const pieces = await listOpportunities({ projectId });
    // Point 10: the absence is evidence about where Brain looked, and it is
    // not a piece of work. Filing it would put "nobody is asking" into the
    // portfolio as something to go and sell.
    expect(pieces).toHaveLength(1);
    const piece = pieces[0]!;
    expect(piece.buyingSignal).toContain('drainage authority');
    expect(piece.state).toBe('DISCOVERED');
    // The card is blank: a published request is evidence somebody asked, and
    // is not a payer, a price, an acceptance condition or a delivery path.
    expect(piece.payer).toBeNull();
    expect(piece.priceCents).toBeNull();

    const round = (await listRounds(projectId)).find((one) => one.candidateId === bucket.id)!;
    expect(round.state).toBe('HARVESTED');
    expect(round.found).toBe(1);

    /* ------------------------------------------------------------------ *
     * 3. Brain names what it does not know, and researches the parts that
     *    are facts rather than the owner's decisions.
     * ------------------------------------------------------------------ */
    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    expect(needs.map((one) => one.requestKey?.split(':').pop()).sort()).toEqual([
      'access',
      'payer',
    ]);
    for (const need of needs) {
      expect(need.completionCondition).toBeTruthy();
      expect(need.blocksState).toBe('EXECUTING');
      // A dependent work reference rather than a note on a screen.
      expect(need.candidateId).toBeTruthy();
    }

    const payerNeed = needs.find((one) => one.requestKey?.endsWith(':payer'))!;
    const accessNeed = needs.find((one) => one.requestKey?.endsWith(':access'))!;
    await workerResearches({
      candidateId: payerNeed.candidateId!,
      question: payerNeed.nextStep,
      lanes: CARD_LANES,
      claims: [
        {
          claim:
            'The authority’s published delegation schedule names the procurement officer as ' +
            'the approver for purchases under $25,000.',
          lane: 'demand_signal',
          sourceUrl: 'https://example.test/authority/delegations',
        },
      ],
    });
    await workerResearches({
      candidateId: accessNeed.candidateId!,
      question: accessNeed.nextStep,
      lanes: CARD_LANES,
      claims: [
        {
          claim:
            'The notice gives procurement@westfield-drainage.example as the address for ' +
            'questions and submissions.',
          lane: 'demand_signal',
          sourceUrl: 'https://example.test/notices/2026-441',
        },
      ],
    });

    const applying = await tick('journey');
    const operated = applying.cashOperations.find((one) => one.projectId === projectId)!;
    expect(operated.cardsAnswered).toEqual(
      expect.arrayContaining([payerNeed.id, accessNeed.id]),
    );

    /*
     * On the card, and resolvable to the passage it came from — the whole of
     * what "research reaching the card" means, and the step the first version
     * of this file supplied the answer to.
     */
    const answered = (await getOpportunity(piece.id))!;
    expect(answered.payer).toContain('procurement officer');
    expect(answered.reachableChannel).toContain('procurement@westfield-drainage.example');
    const payerFact = (await cardFact(piece.id, 'payer'))!;
    expect(payerFact.kind).toBe('EVIDENCE');
    expect(payerFact.claimId).toBeTruthy();

    // The need it answered is closed because the condition holds, not because
    // somebody wrote a sentence.
    const settledNeed = (await getNeed(payerNeed.id))!;
    expect(settledNeed.state).toBe('RESOLVED');
    expect(settledNeed.verifiedBy).toBe('BRAIN_READ_THE_ROW');

    /* ------------------------------------------------------------------ *
     * 4. Brain prepares the commercial proposal — and never calls it a fact.
     * ------------------------------------------------------------------ */
    expect(operated.termsProposed).toContain(piece.id);
    const offer = (await cardFact(piece.id, 'offer'))!;
    expect(offer.kind).toBe('RECOMMENDATION');
    // All three are required to write one, so a recommendation with no stated
    // uncertainty cannot exist.
    expect(offer.basis).toBeTruthy();
    expect(offer.assumptions).toBeTruthy();
    expect(offer.uncertainty).toBeTruthy();
    for (const field of ['acceptance', 'delivery', 'fulfillment']) {
      expect((await cardFact(piece.id, field))!.kind).toBe('RECOMMENDATION');
    }
    // And it withholds what it has no basis for: no source states a figure, so
    // no price is invented and then explained.
    expect((await getOpportunity(piece.id))!.priceCents).toBeNull();
    expect(await cardFact(piece.id, 'price')).toBeNull();

    /* ------------------------------------------------------------------ *
     * 5. The one answer that is genuinely a person's, through the route the
     *    Cash screen calls.
     * ------------------------------------------------------------------ */
    await withCashRoutes(async (call) => {
      const priced = await call('PATCH', `/cash/opportunities/${piece.id}`, {
        priceCents: 120_000,
        // The remaining blank the card still refuses on.
        peakFundingCents: 0,
        /*
         * And the execution thesis. `markReady` asks for both now: the twelve
         * short-card fields are what a bounded *test* turns on, and these are
         * what a *decision* turns on. They have no column, so a person
         * answering one is a `PERSON` row in `cash_card_facts`.
         */
        ...EXECUTION_THESIS,
      });
      expect(priced.status).toBe(200);
    });

    const pricedFact = (await cardFact(piece.id, 'price'))!;
    // Theirs now, permanently: the point of being able to change a
    // recommendation is that it stays changed.
    expect(pricedFact.kind).toBe('PERSON');
    expect(pricedFact.decidedBy).toBe(userId);

    await tick('journey');
    expect((await cardFact(piece.id, 'price'))!.kind).toBe('PERSON');

    /* ------------------------------------------------------------------ *
     * 6. A capability Brain does not have, and the substitute that is not
     *    the same fact as having it.
     * ------------------------------------------------------------------ */
    await withCashRoutes(async (call) => {
      const asked = await call('PATCH', `/cash/opportunities/${piece.id}`, {
        requiredCapabilities: ['TAKE_A_PAYMENT'],
      });
      expect(asked.status).toBe(200);
    });
    await tick('journey');

    const capabilityNeed = (await listNeeds({ projectId, states: ['OPEN'] })).find((one) =>
      one.requestKey?.startsWith('capability:'),
    )!;
    expect(capabilityNeed.recommendedPath).toContain('payment processor');

    await withCashRoutes(async (call) => {
      // A written explanation is not a working integration.
      const pretended = await call('POST', `/cash/needs/${capabilityNeed.id}/close`, {
        to: 'RESOLVED',
        resolution: 'Done.',
      });
      expect(pretended.status).toBe(422);

      const substituted = await call('POST', `/cash/needs/${capabilityNeed.id}/close`, {
        to: 'RESOLVED',
        resolution: 'The buyer paid us directly.',
        substitute: 'Taking payment by bank transfer outside Brain for now.',
      });
      expect(substituted.status).toBe(200);
    });

    const substituted = (await getNeed(capabilityNeed.id))!;
    expect(substituted.verifiedBy).toBe('PERSON_SUBSTITUTE');
    // The integration is still missing, and Brain says so.
    expect((await readCapability('TAKE_A_PAYMENT')).state).toBe('MISSING');

    /* ------------------------------------------------------------------ *
     * 7. Brain takes the decision it is allowed to take, and stops at the
     *    one it is not.
     *
     * The card is complete — research answered what was discoverable and
     * the proposal filled the rest — so Brain declares the piece ready to
     * test rather than putting that on somebody's review. `markReady`'s own
     * gate is untouched: what changed is who presses the button, never what
     * the button checks.
     *
     * And then it stops, out loud. Nobody has granted a standing commercial
     * authority yet, which is the one decision Brain cannot take for
     * somebody — so nothing is contacted and the refusal says which decision
     * is missing rather than reporting the nearest available reason.
     * ------------------------------------------------------------------ */
    const decided = (await getOpportunity(piece.id))!;
    expect(decided.state).toBe('READY');
    const readied = (await listCashEvents(projectId, 200)).find(
      (one) => one.kind === 'CASH_OPPORTUNITY_READY' && one.opportunityId === piece.id,
    )!;
    expect(readied.actorRef).toBe('BRAIN');

    const withheld = (await advanceWithinAuthority(projectId)).withheld.find(
      (one) => one.opportunityId === piece.id,
    )!;
    expect(withheld.because).toContain('no standing commercial authority');
    expect(withheld.because).toContain('nobody has been contacted');
    // And it is still READY: withholding is not a state change.
    expect((await getOpportunity(piece.id))!.state).toBe('READY');

    const firstTry = await runNeedContinuations(projectId);
    const waiting = firstTry.find((one) => one.needId === capabilityNeed.id)!;
    expect(waiting.resumed).toBe(false);
    // A wait rather than an answer: no commercial authority yet.
    expect(waiting.retry).toBe(true);
    expect(waiting.note).toContain('commercial authority');
    expect((await getNeed(capabilityNeed.id))!.continuedAt).toBeNull();

    // Deferred with backoff rather than retried immediately, so a condition
    // nobody is going to fix becomes visible instead of spinning.
    const deferredUntil = (await getNeed(capabilityNeed.id))!.continuationNotBefore!;
    const mine = (list: { needId: string }[]): { needId: string }[] =>
      list.filter((one) => one.needId === capabilityNeed.id);
    expect(mine(await runNeedContinuations(projectId))).toEqual([]);

    /*
     * And a tick that dies holding the claim does not strand it.
     *
     * Step 5's rule at a new table: an expired lease is claimable work, so
     * recovery never depends on one process staying alive. The old flag was
     * terminal and written before the attempt, so a crash here left the need
     * marked continued with nothing having continued.
     */
    const due = new Date(Date.parse(deferredUntil) + 1_000).toISOString();
    expect(await claimNeedContinuation(capabilityNeed.id, due)).toBe(true);
    // Live claim: another tick leaves it alone rather than doubling it.
    expect(mine(await runNeedContinuations(projectId, due))).toEqual([]);

    const afterCrash = new Date(Date.parse(due) + CONTINUATION_LEASE_MS + 60_000).toISOString();
    expect(mine(await runNeedContinuations(projectId, afterCrash))).toHaveLength(1);
    // Still not spent: the condition it is waiting for has not changed.
    expect((await getNeed(capabilityNeed.id))!.continuedAt).toBeNull();

    /* ------------------------------------------------------------------ *
     * 8. The person makes the one decision nothing can proceed without, and
     *    the continuation carries the piece the rest of the way by itself.
     * ------------------------------------------------------------------ */
    await authorizeCommerce();

    /*
     * Authorized, and still unable — which is the honest state of this Brain
     * rather than a gap in the walk.
     *
     * With the grant in place the refusal moves to the operational fact
     * underneath it: reaching a buyer needs `SEND_A_MESSAGE`, no integration
     * of that kind exists, so Brain does not contact anybody and does not say
     * it did. That is why the action below is performed by a **person**.
     */
    const authorized = (await advanceWithinAuthority(projectId)).withheld.find(
      (one) => one.opportunityId === piece.id,
    )!;
    expect(authorized.because).toContain('SEND_A_MESSAGE');
    expect(authorized.because).toContain('nobody has been contacted');
    expect(await actionsFor(piece.id)).toEqual([]);

    await withCashRoutes(async (call) => {
      const executing = await call('POST', `/cash/opportunities/${piece.id}/execute`, {
        action: 'CONTACT_BUYER',
        detail: 'Replied to the notice with a one-page scope and the price.',
        reference: 'notice-2026-441',
      });
      expect(executing.status).toBe(200);
    });

    const executing = (await getOpportunity(piece.id))!;
    expect(executing.state).toBe('EXECUTING');
    // EXECUTING because something happened, and the record says what.
    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.performedBy).toBe('PERSON');

    // The continuation now finds nothing left to resume and settles, once.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await runNeedContinuations(projectId, later);
    const finished = (await getNeed(capabilityNeed.id))!;
    expect(finished.continuedAt).toBeTruthy();
    expect(finished.continuationNote).toBeTruthy();

    /* ------------------------------------------------------------------ *
     * 9. The obligation, the delivery and the money — through the commercial
     *    journey's own routes. A bare "deliver" and a bare "collect" are both
     *    refused now: delivery needs an obligation the buyer agreed to, and
     *    collected needs a settlement in the account. Only a settlement is cash.
     * ------------------------------------------------------------------ */
    await withCashRoutes(async (call) => {
      expect((await call('POST', `/cash/opportunities/${piece.id}/deliver`, {})).status).toBe(422);
      expect((await call('POST', `/cash/opportunities/${piece.id}/collect`, {})).status).toBe(422);

      const offered = await call('POST', `/projects/${projectId}/cash/obligations`, {
        opportunityId: piece.id,
        buyer: 'The contracting officer named on the notice',
        scope: 'The deliverable the notice describes; excludes anything it does not',
        priceCents: 120_000,
        acceptanceConditions: ['The officer confirms receipt of the deliverable'],
        deliveryPlan: 'Prepared by the operator and sent through the notice channel',
        deliveryRoute: 'HUMAN',
      });
      expect(offered.status).toBe(200);
      const obligation = offered.body.obligation.id as string;
      const step = (action: string, body: unknown) =>
        call('POST', `/cash/obligations/${obligation}/${action}`, body);
      expect((await step('send', { reference: 'notice-2026-441-offer' })).status).toBe(200);
      expect(
        (await step('answer', { kind: 'AGREED_TO_BUY', channel: 'notice', reference: 'notice-2026-441-award', excerpt: 'Awarded at the quoted price.' })).status,
      ).toBe(200);
      expect((await step('produce', { productionReference: 'operator: drafting' })).status).toBe(200);
      expect(
        (await step('deliver', {
          deliverableReference: 'notice-2026-441-delivery',
          checks: [{ condition: 'The officer confirms receipt of the deliverable', met: true, evidence: 'receipt email 441-r' }],
        })).status,
      ).toBe(200);
      expect(
        (await step('answer', { kind: 'ACCEPTED_DELIVERY', channel: 'notice', reference: 'notice-2026-441-accept', excerpt: 'Accepted.' })).status,
      ).toBe(200);
      const invoiced = await step('invoice', { provider: 'stripe', providerReference: 'in_88412' });
      expect(invoiced.status).toBe(200);
      const paid = await call('POST', `/cash/invoices/${invoiced.body.invoice.id}/state`, {
        to: 'PAID',
        reference: 'stripe-pi-88412',
      });
      expect(paid.status).toBe(200);

      const earned = await cashView({ projectId });
      // Earned, and not yet usable: two events about the same money and only the
      // second one is cash.
      expect(earned.myCash.position.customerPaymentsCents).toBe(120_000);
      expect(earned.myCash.position.availableFundsCents).toBe(0);
      expect((await call('POST', `/cash/opportunities/${piece.id}/collect`, {})).status).toBe(422);

      const settled = await call('POST', `/cash/invoices/${invoiced.body.invoice.id}/state`, {
        to: 'SETTLED',
        reference: 'bank-ref-88412',
      });
      expect(settled.status).toBe(200);
    });
    expect((await getOpportunity(piece.id))!.state).toBe('COLLECTED');

    const collected = await cashView({ projectId });
    expect(collected.myCash.position.availableFundsCents).toBe(120_000);
    expect(collected.myCash.position.otherCurrencies).toEqual([]);

    /* ------------------------------------------------------------------ *
     * 10. Discovery keeps going: a second round of the same bucket once the
     *     first is answered and the cool-off has passed.
     * ------------------------------------------------------------------ */
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const second = await openDiscovery({ projectId, limit: 9, now: tomorrow });
    const reasked = second.find((one) => one.bucketId === round.bucketId)!;
    expect(reasked.round).toBe(2);
    // It says what the first round already covered, so a worker looks for what
    // is new rather than re-reporting what Brain holds.
    expect((await getCandidate(reasked.candidateId))!.statement).toContain('filed 1 opening');

    /* ------------------------------------------------------------------ *
     * 11. And its identity survives an ordinary month of activity.
     *
     * Both halves of discovery used to read the activity display window,
     * hard-capped at 500 rows newest-first — so a busy sprint re-opened every
     * bucket as a duplicate *and* stopped recognising its own missions.
     * ------------------------------------------------------------------ */
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
    expect(
      (await listCashEvents(projectId, 500)).some(
        (event) => event.kind === 'CASH_DISCOVERY_OPENED',
      ),
    ).toBe(false);

    const afterNoise = await openDiscovery({ projectId, limit: 9, now: tomorrow });
    // No duplicate of a bucket whose round is still open.
    expect(afterNoise.some((one) => one.bucketId === reasked.bucketId)).toBe(false);

    /* ------------------------------------------------------------------ *
     * 12. Winding down stops new discovery and nothing else.
     *
     * With queued discovery *and* an existing obligation both present, which
     * is the only arrangement that can tell the two apart.
     * ------------------------------------------------------------------ */
    const support = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Which format does this buyer need the file in?',
      statement: 'Establish the delivery format this customer’s system accepts.',
    });
    await updateOpportunity(piece.id, { candidate_id: support.id });

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

    const wound = await getCashMode(projectId);
    // The queued discovery stops — the case that used to sail through, because
    // the guard read "no opportunity link" as "not a cash idea".
    expect(
      await launchableUnderCashMode({ candidateId: reasked.candidateId, mode: wound }),
    ).toBe(false);
    expect(await launchableUnderCashMode({ candidateId: bucket.id, mode: wound })).toBe(false);
    // And support for something already owed keeps running.
    expect(await launchableUnderCashMode({ candidateId: support.id, mode: wound })).toBe(true);
    // As does unrelated Brain work.
    const unrelated = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'An ordinary research question',
      statement: 'Nothing to do with the sprint.',
    });
    expect(await launchableUnderCashMode({ candidateId: unrelated.id, mode: wound })).toBe(true);

    const windingDown = await tick('journey');
    expect(
      windingDown.cashDiscovery.find((one) => one.projectId === projectId)?.opened ?? [],
    ).toEqual([]);

    // Delivery, collection and the money record are untouched.
    const after = await cashView({ projectId });
    expect(after.myCash.position.availableFundsCents).toBe(120_000);
    expect(after.myCurrentWork.placements).toHaveLength(1);
    expect(after.discovery.open).toBe(false);
    expect((await getCashMode(projectId))!.state).toBe('WINDING_DOWN');
  });

  it('names the two points its own suites demonstrate', () => {
    /*
     * Point 11 is `cashCurrencyHttp` — a sprint activated in euros, driven
     * against a booted server through the routes a person uses, because
     * project creation is deliberately not an HTTP route and this file's
     * project is a dollar sprint by the time it could be asked.
     *
     * And the deterministic two-connection concurrency test is
     * `cashConcurrency`, which needs a third raw connection to hold a row lock
     * open. Both are named here rather than duplicated, so a reader of this
     * file knows where the other two points are rather than assuming they are
     * missing.
     */
    expect(fs.existsSync(path.join(REPO, 'tests/cashCurrencyHttp.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'tests/cashConcurrency.test.ts'))).toBe(true);
  });
});
