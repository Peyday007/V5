/**
 * The autonomy chain, walked: an ACTIVE sprint to a pull request with nobody
 * pressing anything between the gates a person owns.
 *
 * Two halves were each proven on their own. `cashAutonomousFunnel` carries a
 * discovery to READY_TO_TEST with no person answering a fact, and
 * `factoryExecutionPlane` proves every hosted stage one at a time — always by
 * calling `tickRemoteCampaign` by hand, which is the operator's `remote-tick`
 * and not what production runs. Nothing held one opportunity across the seam,
 * and nothing proved that the loop production actually runs finishes a
 * campaign without somebody nudging it.
 *
 * PART A is the seam. The person makes exactly the decisions that are theirs:
 * pressing Start, declaring on the card that the bounded test is software,
 * granting `BUILD_A_TEST` on the standing commercial authority, and onboarding
 * one repository on Build. Everything after that is the Russell tick: the
 * handoff submits the objective, approves it *on the standing grant* (§16),
 * starts the campaign and ticks its first stage itself.
 *
 * PART B is the Factory with no manual tick. The only things that move the
 * campaign are `tickAllRemoteCampaigns` — the function the twenty-second
 * interval calls, so calling it is waiting for the interval and is not the
 * operator's per-campaign `remote-tick` — and a simulated Cowork worker that
 * takes bins the way `checkIn` does (routing, families, the production
 * admission hook including review independence) and finishes them. The
 * first review finds a defect and names only the test it shows in; the repair
 * the loop queues must own the file the defect is fixed in (§27's root-cause
 * rule), and a second independent review passes the repaired tree.
 *
 * What is simulated is the external edge and nothing else:
 *   - the sentences a researcher found on the web, and the two judgements only
 *     a reader of a source can make (PART A, exactly as in the funnel);
 *   - a worker's judgement: the plan it proposes, the code it says it pushed,
 *     the merge it says it made, the verdict it reaches, the request it opened;
 *   - the forge, through `globalThis.fetch`, so every one of those reports is
 *     believed only as far as "the repository" confirms it — Brain reads the
 *     branch, the compare and the pull request, never the worker's summary.
 * Every transition between those edges is the service production calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL } from '../server/services/cash/authority.ts';
import {
  createUser,
  createWorker,
  getWorkerByName,
  grantMembership,
  listMembershipsForPrincipal,
} from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { findTool } from '../server/mcp/tools.ts';
import { claimWork } from '../server/repos/workQueue.ts';
import { advancePacket, approvePlan } from '../server/services/research/packetRunner.ts';
import {
  latestMissionForCandidate,
  launchMission,
  linkMission,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { getOpportunity, listNeeds, listOpportunities } from '../server/repos/cashPortfolio.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { tick } from '../server/services/russell/loop.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { fillCard } from '../server/services/cash/opportunities.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { cashTier, type TierReading } from '../server/services/cash/tier.ts';
import { handoffKey } from '../server/services/cash/factoryHandoff.ts';
import { listRepositoryGrants } from '../server/services/factory/repositoryEnvelope.ts';
import { factoryWorkerName, onboardRepository } from '../server/services/factory/onboard.ts';
import { tickAllRemoteCampaigns } from '../server/services/factory/remoteLoop.ts';
import { declaredBranchFor } from '../server/services/factory/remote.ts';
import { assignNextBin, finishBin, listBins, putBinUnitResult } from '../server/repos/bins.ts';
import { binAdmission, claimableProjects, workerRoutingFor } from '../server/services/bins/service.ts';
import { classesForFamilies } from '../server/services/bins/routing.ts';
import { getCampaign, getChangeRequest, listUnits } from '../server/repos/factory.ts';
import { listFindings, listReviews } from '../server/repos/factoryFleet.ts';
import type {
  Bin,
  CashOpportunity,
  ClaimedWork,
  Layer,
  Principal,
  User,
  WorkerScope,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let admin: User;
let layer: Layer;
let realFetch: typeof globalThis.fetch;

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
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  const user = await createUser({
    email: `autonomy-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
  // Onboarding a repository is an administrator's act on Build.
  admin = await createUser({
    email: `onboarder-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The onboarder',
    password: 'a-long-enough-test-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  const worker = await createWorker({
    name: `autonomy-research-${Math.random().toString(36).slice(2, 10)}`,
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

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  await teardown();
});

/* ========================================================================= */
/* The research edge — copied from `cashAutonomousFunnel`                     */
/* ========================================================================= */

function principal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'autonomy-worker',
    displayName: 'The research worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_autonomy',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_autonomy_worker',
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
    requestId: 'req_autonomy',
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

/** One packet for one candidate Brain created, judged by Brain's gate. */
async function answer(candidateId: string, question: string, found: Found[]): Promise<void> {
  const lanes = [...new Set(found.map((one) => one.lane))].map((id) => ({
    id,
    description: `Evidence for ${id}.`,
    necessity: 'REQUIRED' as const,
  }));
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
      fragmentKey: 'autonomy',
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
    search_queries: [question],
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
  expect(gate['acceptedClaims']).toBe(found.length);
  await asWorker('brain_complete_work', {
    ...proof(verifying),
    result_ref: String(gate['acceptedClaims']),
    summary: 'verified and gated',
  });

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: question,
    whyNow: 'Brain asked this',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
}

const SOURCE = 'https://example.test/westfield/notices/2026-441';

const DEEP_DIVE: Found[] = [
  {
    claim:
      'The Westfield drainage authority procurement officer approves and pays for research ' +
      'purchases under USD 25,000.',
    lane: 'payer',
    sourceUrl: 'https://example.test/westfield/delegations',
  },
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

function forField(field: string): Found[] | null {
  const lane = 'demand_signal';
  switch (field) {
    case 'payer':
      return [{ claim: DEEP_DIVE[0]!.claim, lane, sourceUrl: DEEP_DIVE[0]!.sourceUrl }];
    case 'access':
      return [
        {
          claim: 'The notice gives procurement@westfield-drainage.example for questions and submissions.',
          lane,
          sourceUrl: SOURCE,
        },
      ];
    case 'price':
      return [{ claim: DEEP_DIVE[1]!.claim, lane, sourceUrl: DEEP_DIVE[1]!.sourceUrl }];
    case 'exposure':
      return [{ claim: DEEP_DIVE[2]!.claim, lane, sourceUrl: DEEP_DIVE[2]!.sourceUrl }];
    case 'delivery':
    case 'fulfillment':
      return [{ claim: DEEP_DIVE[5]!.claim, lane, sourceUrl: SOURCE }];
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

async function readingOf(opportunity: CashOpportunity): Promise<TierReading> {
  return cashTier({
    opportunity,
    card: cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }),
    readiness: evidenceCard(opportunity).readiness,
  });
}

/**
 * Drive one ACTIVE sprint from Start to an opening at READY / READY_TO_TEST,
 * answering only questions Brain itself asked.
 */
async function drive(): Promise<CashOpportunity> {
  const activated = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(activated.ok).toBe(true);

  await tick('autonomy');
  const bucket = (await listCandidates({ projectId })).find(
    (one) => one.title === SEARCH_BUCKETS[0]!.title,
  );
  expect(bucket, 'discovery opened a bucket round on its own').toBeDefined();
  await answer(bucket!.id, bucket!.statement, [
    {
      claim:
        'The Westfield drainage authority published request 2026-441 for ownership research ' +
        'on twenty parcels, with a stated budget of USD 2,000, closing 30 October 2026.',
      lane: 'demand_signal',
      sourceUrl: SOURCE,
      signal: 'ACTIVE_BUYER_DEMAND',
    },
  ]);

  const answered = new Set<string>();
  let piece: CashOpportunity | null = null;
  for (let pass = 0; pass < 12; pass += 1) {
    await tick('autonomy');
    piece = (await listOpportunities({ projectId }))[0] ?? null;
    if (!piece) continue;
    if ((await readingOf(piece)).tier === 'READY_TO_TEST' && piece.state === 'READY') break;
    if (piece.validationState === 'PENDING' && piece.candidateId && !answered.has(piece.candidateId)) {
      if (!(await latestMissionForCandidate(piece.candidateId))) {
        answered.add(piece.candidateId);
        await answer(piece.candidateId, `Qualify: ${piece.title}`, DEEP_DIVE);
      }
    }
    for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
      if (!need.candidateId || answered.has(need.candidateId)) continue;
      if (await latestMissionForCandidate(need.candidateId)) continue;
      const found = forField(need.requestKey?.split(':').pop() ?? '');
      if (!found) continue;
      answered.add(need.candidateId);
      await answer(need.candidateId, need.nextStep, found);
    }
  }
  expect(piece).not.toBeNull();
  const final = (await getOpportunity(piece!.id))!;
  const reading = await readingOf(final);
  expect({ state: final.state, tier: reading.tier }).toEqual({ state: 'READY', tier: 'READY_TO_TEST' });
  return final;
}

/* ========================================================================= */
/* The person's decisions, and the forge                                      */
/* ========================================================================= */

/** The grant this Brain authorizes for its own repository. */
function brainGrant() {
  const grant = listRepositoryGrants().find((one) => one.id === 'brain');
  if (!grant) throw new Error('the envelope no longer authorizes Brain');
  return grant;
}

/** The person's typed card declaration: the bounded test is a piece of software. */
async function declareSoftware(opportunityId: string, capabilities: string[]): Promise<void> {
  const filled = await fillCard({
    opportunityId,
    actorRef: userId,
    patch: { requiredCapabilities: capabilities },
  });
  expect(filled.ok).toBe(true);
}

async function grant(allowedActions: string[]): Promise<string> {
  const authority = await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions,
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000,
    maxPerActionCents: 300_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
  return authority.id;
}

async function onboard(): Promise<void> {
  const outcome = await onboardRepository({
    projectId,
    grantId: brainGrant().id,
    scope: { kind: 'WHOLE_REPOSITORY' },
    actor: admin,
    origin: 'https://brain.example',
  });
  if (!outcome.ok) throw new Error(`onboarding refused: ${outcome.reason}`);
}

const BASE = 'a'.repeat(40);

/**
 * What "the repository" says. Mutable, because a worker pushing is a change
 * to the forge, and Brain only ever believes what the forge answers.
 */
interface Forge {
  defaultBranch: string;
  branches: Record<string, string>;
  compares: Record<string, { files: string[]; status: string }>;
  pulls: { number: number; headRef: string; headSha: string; baseRef: string }[];
  files: Record<string, string>;
  /** Every request Brain made, for the assertion that it read the forge at all. */
  requests: string[];
}

function newForge(): Forge {
  return {
    defaultBranch: 'production',
    branches: { production: BASE },
    compares: {},
    pulls: [],
    files: { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) },
    requests: [],
  };
}

function installForge(forge: Forge): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    forge.requests.push(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const branch = /\/git\/ref\/heads\/(.+)$/.exec(url);
    if (branch) {
      const name = decodeURIComponent(branch[1] ?? '');
      const sha = forge.branches[name];
      return sha ? json({ ref: `refs/heads/${name}`, object: { sha } }) : json({ message: 'Not Found' }, 404);
    }
    const compare = /\/compare\/(.+)\.\.\.(.+)$/.exec(url);
    if (compare) {
      const key = `${decodeURIComponent(compare[1] ?? '')}...${decodeURIComponent(compare[2] ?? '')}`;
      const found = forge.compares[key];
      if (!found) return json({ message: 'Not Found' }, 404);
      return json({
        status: found.status,
        ahead_by: 1,
        base_commit: { sha: decodeURIComponent(compare[1] ?? '') },
        files: found.files.map((filename) => ({ filename })),
      });
    }
    const describe = (pull: Forge['pulls'][number]) => ({
      number: pull.number,
      state: 'open',
      html_url: `https://github.com/Peyday007/V5/pull/${pull.number}`,
      title: 'the bounded test',
      updated_at: '2026-10-06T00:00:00Z',
      head: { sha: pull.headSha, ref: pull.headRef },
      base: { ref: pull.baseRef },
    });
    if (url.includes('/pulls?')) {
      const head = /head=([^&]+)/.exec(url);
      const wanted = decodeURIComponent(head?.[1] ?? '').split(':')[1] ?? '';
      return json(forge.pulls.filter((pull) => pull.headRef === wanted).map(describe));
    }
    const pull = /\/pulls\/(\d+)$/.exec(url);
    if (pull) {
      const found = forge.pulls.find((candidate) => candidate.number === Number(pull[1]));
      return found ? json(describe(found)) : json({ message: 'Not Found' }, 404);
    }
    if (url.includes('/check-runs')) return json({ check_runs: [] });
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents) {
      const body = forge.files[decodeURIComponent(contents[1] ?? '')];
      if (body === undefined) return json({ message: 'Not Found' }, 404);
      return json({ content: Buffer.from(body, 'utf8').toString('base64'), encoding: 'base64' });
    }
    if (/\/repos\/[^/]+\/[^/?]+(\?.*)?$/.test(url)) return json({ default_branch: forge.defaultBranch });
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;
}

async function changeRequestsFor(opportunityId: string) {
  return await getDb().all<{
    id: string;
    state: string;
    approved_via: string | null;
    authority_id: string | null;
  }>(
    `SELECT id, state, approved_via, authority_id FROM factory_change_requests WHERE submission_key = ?`,
    [handoffKey(opportunityId)],
  );
}

async function count(sql: string, params: string[]): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(sql, params);
  return Number(row?.n ?? 0);
}

/* ========================================================================= */
/* The simulated Cowork worker                                                */
/* ========================================================================= */

interface Taken {
  bin: Bin;
  proof: { binId: string; leaseId: string; leaseGeneration: number; workerId: string };
}

/**
 * A Cowork session checking in and being handed the next bin — exactly the
 * assignment `checkIn` performs (claimable projects from the principal's own
 * memberships, the families its routing row serves, and the production
 * admission hook, which is where review independence is enforced before the
 * lease) — and deliberately *without* `checkIn`'s derive-and-retry, because
 * that derive is itself a tick and this test exists to prove the loop alone.
 */
async function checkInAs(factoryWorkerId: string, session: string): Promise<Taken | null> {
  const memberships = await listMembershipsForPrincipal('WORKER', factoryWorkerId);
  const who = {
    type: 'WORKER',
    id: factoryWorkerId,
    handle: factoryWorkerId,
    displayName: 'Factory Brain',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `crd_${session}`,
    authMethod: 'OAUTH_BEARER',
    memberships,
    requestId: `req_${session}`,
  } as unknown as Principal;
  const routing = await workerRoutingFor(factoryWorkerId, who);
  const assigned = await assignNextBin({
    workerId: factoryWorkerId,
    credentialId: who.credentialId,
    projectIds: claimableProjects(who).map((scope) => scope.projectId),
    sessionRef: session,
    families: classesForFamilies(routing.families),
    admit: await binAdmission({ workerId: factoryWorkerId, principal: who, sessionRef: session }),
  });
  if (!assigned) return null;
  return {
    bin: assigned.bin,
    proof: {
      binId: assigned.bin.id,
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.leaseGeneration,
      workerId: factoryWorkerId,
    },
  };
}

/** Submit one unit result and finish the bin, as `brain_bin_submit_unit` and `brain_bin_complete` do. */
async function submit(taken: Taken, unitKey: string, value: unknown): Promise<void> {
  const put = await putBinUnitResult({
    binId: taken.bin.id,
    unitKey,
    value: JSON.stringify(value),
    contentHash: `h-${taken.bin.id}-${unitKey}`,
    leaseId: taken.proof.leaseId,
    leaseGeneration: taken.proof.leaseGeneration,
  });
  expect(put, `the result for ${unitKey} was stored`).toMatchObject({ stored: true });
  expect(await finishBin(taken.proof, { state: 'COMPLETE', reason: `${unitKey} reported` })).toBe('OK');
}

/** What production's twenty-second interval does, once. */
async function interval(): Promise<void> {
  await tickAllRemoteCampaigns();
}

/* ========================================================================= */

describe('a READY_TO_TEST software test reaches the Factory and the hosted loop finishes it', () => {
  it('hands off on the standing grant, then plans, implements, integrates, reviews, repairs a finding, re-reviews and delivers with no manual tick', async () => {
    const started = Date.now();

    /* ----------------------------- PART A ----------------------------- */
    const ready = await drive();
    const timeToReady = Date.now() - started;
    const forge = newForge();
    installForge(forge);

    // The person's three decisions, and nothing else.
    await declareSoftware(ready.id, ['BUILD_SOFTWARE']);
    const authorityId = await grant(['BUILD_A_TEST']);
    await onboard();

    await tick('autonomy');

    const [request, ...more] = await changeRequestsFor(ready.id);
    expect(more).toEqual([]);
    expect(request).toMatchObject({
      state: 'APPROVED',
      approved_via: 'STANDING_AUTHORITY',
      authority_id: authorityId,
    });
    const campaigns = await getDb().all<{ id: string }>(
      'SELECT id FROM factory_campaigns WHERE change_request_id = ?',
      [request!.id],
    );
    expect(campaigns).toHaveLength(1);
    const campaignId = campaigns[0]!.id;

    // The handoff ticked the campaign itself: the plan stage exists and is READY
    // already, with no Factory loop and no `remote-tick` having run.
    const planBins = (await listBins({ projectId })).filter(
      (bin) => bin.kind === 'FACTORY_PLAN' && bin.factoryCampaignId === campaignId,
    );
    expect(planBins).toHaveLength(1);
    expect(planBins[0]!.state).toBe('READY');

    // The action and the event, once each, under the grant.
    const actions = await getDb().all<{ action: string; authority_id: string; performed_by: string }>(
      'SELECT action, authority_id, performed_by FROM cash_actions WHERE opportunity_id = ?',
      [ready.id],
    );
    expect(actions).toEqual([{ action: 'BUILD_A_TEST', authority_id: authorityId, performed_by: 'BRAIN' }]);
    const handoffEvents = `SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_FACTORY_HANDOFF'`;
    expect(await count(handoffEvents, [ready.id])).toBe(1);
    // The opportunity itself is not moved by a build: it is still READY.
    expect((await getOpportunity(ready.id))!.state).toBe('READY');

    // Two more ticks duplicate nothing.
    await tick('autonomy');
    await tick('autonomy');
    expect(await changeRequestsFor(ready.id)).toHaveLength(1);
    expect(
      await count('SELECT COUNT(*) AS n FROM factory_campaigns WHERE change_request_id = ?', [request!.id]),
    ).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM cash_actions WHERE opportunity_id = ?', [ready.id])).toBe(1);
    expect(await count(handoffEvents, [ready.id])).toBe(1);
    // And the handoff did not run again at all: a re-run resubmits the
    // objective, which asks the forge and writes a dedupe row every tick.
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM factory_events WHERE kind = 'CHANGE_REQUEST_DEDUPED' AND detail LIKE ?",
        [`%${request!.id}%`],
      ),
    ).toBe(0);
    expect(
      (await listBins({ projectId })).filter(
        (bin) => bin.kind === 'FACTORY_PLAN' && bin.factoryCampaignId === campaignId,
      ),
    ).toHaveLength(1);
    const timeToHandoff = Date.now() - started;

    /* ----------------------------- PART B ----------------------------- */
    const changeRequest = (await getChangeRequest(request!.id))!;
    const conditionIds = changeRequest.acceptanceConditions.map((condition) => condition.id);
    expect(conditionIds.length).toBeGreaterThan(0);
    // The worker onboarding registered, for the repository the request names.
    const factory = (await getWorkerByName(factoryWorkerName(brainGrant().id)))!;
    expect(factory).toBeTruthy();

    // One activation does the planning, implementation and integration; a
    // second, distinct session reviews. Same worker identity, so the tier the
    // floor earns is SESSION_SEPARATED and nothing rounds it up.
    const IMPLEMENTER = 'cse_activation_one';
    const REVIEWER = 'cse_activation_two';

    // PLAN — a worker proposes; `validatePlan` decides.
    const plan = await checkInAs(factory.id, IMPLEMENTER);
    expect(plan?.bin.kind).toBe('FACTORY_PLAN');
    await submit(plan!, 'plan', {
      units: [
        {
          key: 'quote-tool',
          kind: 'IMPLEMENTATION',
          title: 'A parcel-research quote tool',
          objective:
            'Add a small quote tool that prices a parcel-ownership review from the parcel count, ' +
            'with a test that pins the published price.',
          acceptance: ['the suite pins the quote for twenty parcels'],
          ownedPaths: ['tools/quote/quote.ts', 'tools/quote/quote.test.ts'],
          requiredContext: [],
          verification: changeRequest.verificationCommands.slice(0, 1),
          expectedArtifact: 'a module and its test',
          risk: 'LOW',
          criticalPath: true,
          dependsOn: [],
          serves: conditionIds,
        },
      ],
    });

    await interval();
    const units = await listUnits(campaignId);
    expect(units.map((unit) => unit.unitKey)).toEqual(['quote-tool']);

    // UNITS — the loop created the units bin; the worker pushes, the forge agrees.
    await interval();
    const implementing = await checkInAs(factory.id, IMPLEMENTER);
    expect(implementing?.bin.kind).toBe('FACTORY_UNITS');
    const branch = declaredBranchFor(implementing!.bin, 'quote-tool')!;
    expect(branch).toBeTruthy();
    const unitHead = 'c'.repeat(40);
    forge.branches[branch] = unitHead;
    forge.compares[`${BASE}...${unitHead}`] = {
      files: ['tools/quote/quote.ts', 'tools/quote/quote.test.ts'],
      status: 'ahead',
    };
    await submit(implementing!, 'quote-tool', {
      unitKey: 'quote-tool',
      outcome: 'IMPLEMENTED',
      branch,
      headSha: unitHead,
      filesChanged: ['tools/quote/quote.ts', 'tools/quote/quote.test.ts'],
      commands: [{ command: 'npm test', exitCode: 0 }],
      summary: 'added the quote tool and its test',
    });

    await interval();
    expect((await listUnits(campaignId))[0]!.state).toBe('IMPLEMENTED');

    // INTEGRATE — on the campaign's own branch, the contract's command green.
    await interval();
    const integrating = await checkInAs(factory.id, IMPLEMENTER);
    expect(integrating?.bin.kind).toBe('FACTORY_INTEGRATE');
    const campaign = (await getCampaign(campaignId))!;
    const integrationHead = 'd'.repeat(40);
    forge.branches[campaign.integrationBranch] = integrationHead;
    forge.compares[`${unitHead}...${integrationHead}`] = { files: [], status: 'identical' };
    forge.compares[`${BASE}...${integrationHead}`] = {
      files: ['tools/quote/quote.ts', 'tools/quote/quote.test.ts'],
      status: 'ahead',
    };
    await submit(integrating!, 'integrate', {
      outcome: 'IMPLEMENTED',
      integrationBranch: campaign.integrationBranch,
      headSha: integrationHead,
      merged: [{ unitKey: 'quote-tool', branch, headSha: unitHead }],
      conflicts: [],
      commands: [{ command: 'npm test', exitCode: 0 }],
      summary: 'merged the quote tool onto the campaign branch',
    });

    await interval();
    expect((await listUnits(campaignId))[0]!.state).toBe('INTEGRATED');
    expect((await getCampaign(campaignId))!.integrationSha).toBe(integrationHead);

    // REVIEW, round 1 — the implementing session is refused by admission
    // before any lease, and a distinct session is handed the review. It finds a
    // defect, and names only the test the defect *shows* in.
    await interval();
    expect(await checkInAs(factory.id, IMPLEMENTER)).toBeNull();
    const reviewing = await checkInAs(factory.id, REVIEWER);
    expect(reviewing?.bin.kind).toBe('FACTORY_REVIEW');
    await submit(reviewing!, 'review', {
      verdict: 'CHANGES_REQUIRED',
      reviewedSha: integrationHead,
      summary: 'The quote is computed per page rather than per parcel.',
      findings: [
        {
          key: 'quote-per-parcel',
          severity: 'MAJOR',
          category: 'correctness',
          statement: 'The quote for twenty parcels is wrong: it is priced per page, not per parcel.',
          evidence: 'tools/quote/quote.test.ts asserts the per-page figure.',
          acceptanceConditionId: conditionIds[0]!,
        },
      ],
    });

    await interval();
    const firstRound = await listReviews(campaignId);
    expect(firstRound).toHaveLength(1);
    expect(firstRound[0]).toMatchObject({ verdict: 'CHANGES_REQUIRED', independence: 'SESSION_SEPARATED' });

    // The finding became a repair unit by itself, and the repair owns the file
    // the defect must be fixed in — not only the test that showed it.
    const repair = (await listUnits(campaignId)).find((unit) => unit.kind === 'REPAIR');
    expect(repair, 'the finding queued a repair unit').toBeDefined();
    expect(repair!.ownedPaths).toContain('tools/quote/quote.ts');
    expect((await getCampaign(campaignId))!.state).not.toBe('BLOCKED');

    // REPAIR — implemented on its own branch and integrated, by the same loop.
    await interval();
    const repairing = await checkInAs(factory.id, IMPLEMENTER);
    expect(repairing?.bin.kind).toBe('FACTORY_UNITS');
    const repairBranch = declaredBranchFor(repairing!.bin, repair!.unitKey)!;
    expect(repairBranch).toBeTruthy();
    const repairHead = 'e'.repeat(40);
    forge.branches[repairBranch] = repairHead;
    // A repair round is based on the campaign's integrated head.
    forge.compares[`${integrationHead}...${repairHead}`] = { files: ['tools/quote/quote.ts'], status: 'ahead' };
    forge.compares[`${BASE}...${repairHead}`] = { files: ['tools/quote/quote.ts'], status: 'ahead' };
    await submit(repairing!, repair!.unitKey, {
      unitKey: repair!.unitKey,
      outcome: 'IMPLEMENTED',
      branch: repairBranch,
      headSha: repairHead,
      filesChanged: ['tools/quote/quote.ts'],
      commands: [{ command: 'npm test', exitCode: 0 }],
      summary: 'priced per parcel',
    });
    await interval();
    expect((await listUnits(campaignId)).find((unit) => unit.id === repair!.id)!.state).toBe('IMPLEMENTED');

    await interval();
    const reintegrating = await checkInAs(factory.id, IMPLEMENTER);
    expect(reintegrating?.bin.kind).toBe('FACTORY_INTEGRATE');
    const repairedHead = 'f'.repeat(40);
    forge.branches[campaign.integrationBranch] = repairedHead;
    forge.compares[`${repairHead}...${repairedHead}`] = { files: [], status: 'identical' };
    forge.compares[`${integrationHead}...${repairedHead}`] = { files: ['tools/quote/quote.ts'], status: 'ahead' };
    forge.compares[`${BASE}...${repairedHead}`] = {
      files: ['tools/quote/quote.ts', 'tools/quote/quote.test.ts'],
      status: 'ahead',
    };
    await submit(reintegrating!, 'integrate', {
      outcome: 'IMPLEMENTED',
      integrationBranch: campaign.integrationBranch,
      headSha: repairedHead,
      merged: [{ unitKey: repair!.unitKey, branch: repairBranch, headSha: repairHead }],
      conflicts: [],
      commands: [{ command: 'npm test', exitCode: 0 }],
      summary: 'merged the repair',
    });
    await interval();
    expect((await getCampaign(campaignId))!.integrationSha).toBe(repairedHead);
    const findings = await listFindings(campaignId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.state).toBe('REPAIRED');

    // REVIEW, round 2 — again a session that implemented nothing.
    await interval();
    expect(await checkInAs(factory.id, IMPLEMENTER)).toBeNull();
    const rereviewing = await checkInAs(factory.id, REVIEWER);
    expect(rereviewing?.bin.kind).toBe('FACTORY_REVIEW');
    await submit(rereviewing!, 'review', {
      verdict: 'PASS',
      reviewedSha: repairedHead,
      summary: 'The quote is per parcel and the test pins the published figure.',
      findings: [],
    });
    await interval();
    const reviews = await listReviews(campaignId);
    expect(reviews.map((row) => row.verdict)).toEqual(['CHANGES_REQUIRED', 'PASS']);
    expect(reviews[1]).toMatchObject({ independence: 'SESSION_SEPARATED', reviewedSha: repairedHead });

    // DELIVER — the worker opens the request; Brain confirms it points at the
    // commit it integrated, aimed at the branch the contract is pinned against.
    await interval();
    const delivering = await checkInAs(factory.id, REVIEWER);
    expect(delivering?.bin.kind).toBe('FACTORY_DELIVER');
    forge.pulls.push({
      number: 77,
      headRef: campaign.integrationBranch,
      headSha: repairedHead,
      baseRef: changeRequest.baseBranch,
    });
    await submit(delivering!, 'deliver', {
      outcome: 'IMPLEMENTED',
      pullRequest: 77,
      headSha: repairedHead,
      action: 'OPENED',
      summary: 'opened the pull request',
    });

    await interval();
    await interval();
    const finished = (await getCampaign(campaignId))!;
    expect({ state: finished.state, prRef: finished.prRef }).toEqual({ state: 'COMPLETE', prRef: '#77' });
    expect(finished.prUrl).toContain('/pull/77');

    // Brain read the forge for every belief, and nothing here was an operator
    // command: the only movers were `tick`, `tickAllRemoteCampaigns` and the
    // worker's bin calls. And nothing merged — the pull request is a person's.
    expect(forge.requests.some((url) => url.includes('/pulls/77'))).toBe(true);
    expect(forge.requests.some((url) => /merge/i.test(url))).toBe(false);

    // The loop at rest changes nothing more.
    const binsBefore = (await listBins({ projectId })).length;
    await interval();
    await interval();
    expect((await listBins({ projectId })).length).toBe(binsBefore);
    expect((await getCampaign(campaignId))!.state).toBe('COMPLETE');

    console.info(
      `[autonomyChain] READY_TO_TEST in ${timeToReady}ms, handed off by ${timeToHandoff}ms, ` +
        `COMPLETE by ${Date.now() - started}ms`,
    );
  }, 240_000);
});

describe('the handoff refuses what a person has not authorized', () => {
  it('raises an authority need, and submits nothing, when the grant does not cover BUILD_A_TEST', async () => {
    const ready = await drive();
    installForge(newForge());
    await declareSoftware(ready.id, ['BUILD_SOFTWARE']);
    await grant(['ACCEPT_PAYMENT']);
    await onboard();
    await tick('autonomy');

    expect(await changeRequestsFor(ready.id)).toEqual([]);
    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    expect(needs.map((need) => need.requestKey)).toContain(`factory-handoff:authority:${ready.id}`);
    expect(await count('SELECT COUNT(*) AS n FROM factory_campaigns', [])).toBe(0);
  }, 180_000);

  it('raises a repository need, and submits nothing, when no repository is onboarded', async () => {
    const ready = await drive();
    installForge(newForge());
    await declareSoftware(ready.id, ['BUILD_SOFTWARE']);
    await grant(['BUILD_A_TEST']);
    await tick('autonomy');

    expect(await changeRequestsFor(ready.id)).toEqual([]);
    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    expect(needs.map((need) => need.requestKey)).toContain(`factory-handoff:repository:${ready.id}`);
    expect(await count('SELECT COUNT(*) AS n FROM factory_campaigns', [])).toBe(0);
  }, 180_000);

  it('hands nothing over when the card does not declare BUILD_SOFTWARE', async () => {
    const ready = await drive();
    installForge(newForge());
    await declareSoftware(ready.id, ['SEND_A_MESSAGE']);
    await grant(['BUILD_A_TEST']);
    await onboard();
    await tick('autonomy');
    await tick('autonomy');

    expect(await changeRequestsFor(ready.id)).toEqual([]);
    expect(await count('SELECT COUNT(*) AS n FROM factory_campaigns', [])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM cash_actions WHERE opportunity_id = ?', [ready.id])).toBe(0);
    const keys = (await listNeeds({ projectId })).map((need) => need.requestKey ?? '');
    expect(keys.filter((key) => key.startsWith('factory-handoff:'))).toEqual([]);
  }, 180_000);
});
