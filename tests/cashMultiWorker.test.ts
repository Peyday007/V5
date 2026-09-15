/**
 * Two workers, two operations, one Brain.
 *
 * The intended architecture is one shared Brain with several parallel workers
 * and separate human work views — not four isolated brains. This suite is about
 * what that does and does not mean, driven through the real tool boundary with
 * two genuinely distinct worker identities racing each other.
 *
 * ---------------------------------------------------------------------------
 * What "shared" is, precisely
 * ---------------------------------------------------------------------------
 *
 * Shared is the **machinery**: one database, one work queue, one fleet, one
 * pool of workers. Any worker may serve any project it holds a membership on,
 * and a second worker is throughput rather than a second brain.
 *
 * Shared is **not** the claims. Every claim read in this codebase is keyed by
 * orchestration — `citableClaims`, `acceptedClaims`, `listClaims` — and an
 * orchestration belongs to one project. So Ana's project does not reuse Ben's
 * research, and nothing here pretends it does; that would be a new capability
 * and it is named in the report rather than asserted by a test that could not
 * see the difference.
 *
 * What is asserted is what actually decides whether parallel work is safe:
 * two workers racing take different items, neither can reach the other's
 * project, both results land accepted in the one store, the work is not handed
 * out twice, and neither human's view shows the other's operation.
 *
 * The external edge is a declared fixture — the sentences a worker found — and
 * everything it passes through is real.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  citableClaims,
  createFragments,
  createOrchestration,
  currentFragments,
  listClaims,
} from '../server/repos/research.ts';
import { approvePlan, advancePacket } from '../server/services/research/packetRunner.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { cashView } from '../server/services/cash/view.ts';
import { findTool } from '../server/mcp/tools.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  ProjectMembership,
  WorkerScope,
} from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = [
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

interface Operation {
  who: string;
  userId: string;
  projectId: string;
  layer: Layer;
  /** The worker that serves this operation, with its own credential. */
  workerId: string;
  credentialId: string;
  orchestrationId: string;
}

let ana: Operation;
let ben: Operation;

function principalFor(operation: Operation): Principal {
  return {
    type: 'WORKER',
    id: operation.workerId,
    handle: `worker-${operation.who}`,
    displayName: `Worker for ${operation.who}`,
    isBrainAdmin: false,
    mustChangePassword: false,
    // Distinct per worker: the session dimension is the credential a request
    // authenticated with, so two workers sharing one would be one session.
    credentialId: operation.credentialId,
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: `mem_${operation.who}`,
        projectId: operation.projectId,
        principalType: 'WORKER',
        principalId: operation.workerId,
        role: 'MEMBER',
        scopes: SCOPES,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      } as ProjectMembership,
    ],
    requestId: `req_${operation.who}`,
  } as Principal;
}

async function tool(
  name: string,
  args: Record<string, unknown>,
  operation: Operation,
): Promise<Record<string, any>> {
  const found = findTool(name);
  if (!found) throw new Error(`no such tool: ${name}`);
  const outcome = await found.run(args, {
    principal: principalFor(operation),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, any>;
}

/** One operation, set up the way a person would: project, sprint, authority. */
async function makeOperation(who: string, seeded?: { projectId: string; layer: Layer }): Promise<Operation> {
  const user = await createUser({
    email: `${who}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: who,
    password: 'correct horse battery staple',
  });
  const projectId =
    seeded?.projectId ??
    (await createProject({
      name: `${who}'s operation`,
      slug: `${who}-${Math.random().toString(36).slice(2, 8)}`,
    })).id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: user.id,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const activated = await activate({
    projectId,
    ownerUserId: user.id,
    actorUserId: user.id,
    objective: `${who} wants more usable cash over the next few weeks.`,
  });
  expect(activated.ok).toBe(true);

  await createGoal({
    projectId,
    ownerUserId: user.id,
    createdByUserId: user.id,
    name: 'Cash Mode discovery',
    allowedWork: ['RESEARCH'],
    maxMissions: 8,
    maxFragments: 24,
    maxConcurrent: 2,
    maxProbes: 4,
  });

  /*
   * Read rather than created: activating a sprint on a project with no layer
   * makes one, so creating a second here collides on the slug. That collision
   * is the layer fix working.
   */
  const layer = seeded?.layer ?? (await listLayers(projectId))[0]!;
  expect(layer).toBeTruthy();

  const worker = await createWorker({
    name: `worker-${who}-${Math.random().toString(36).slice(2, 8)}`,
    displayName: `Worker for ${who}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  return {
    who,
    userId: user.id,
    projectId,
    layer,
    workerId: worker.id,
    credentialId: `cred_${who}_${Math.random().toString(36).slice(2, 8)}`,
    orchestrationId: '',
  };
}

/** A research item Brain created, queued the way the runner queues it. */
async function queueResearch(operation: Operation, question: string): Promise<void> {
  const run = await createRun({
    projectId: operation.projectId,
    layerId: operation.layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: question,
  });
  const orchestration = await createOrchestration({
    projectId: operation.projectId,
    layerId: operation.layer.id,
    runId: run.id,
    title: question,
    assignment: question,
    provider: 'WORKER',
    autoApprove: false,
  });
  operation.orchestrationId = orchestration.id;
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: operation.projectId,
      layerId: operation.layer.id,
      geography: 'the markets this sprint may look at',
      requiredEvidence: [
        { id: 'demand_signal', description: 'a published request', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a published request, posting, listing or notice'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published source'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: `fragment-${operation.who}`,
      question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const approved = await approvePlan({
    orchestrationId: orchestration.id,
    approvedByUserId: operation.userId,
  });
  expect(approved.enqueued.length).toBeGreaterThan(0);
}

/**
 * Claim as this operation's worker, exactly as a fired session would.
 *
 * Through the **tool**, never `claimWork` directly. The repository function
 * takes the eligible scopes as an argument, so calling it from a test means the
 * test supplies the authorization — which would make a cross-project refusal
 * unprovable, because the thing being refused is the thing being handed in.
 * `brain_claim_work` builds that list from the authenticated principal's own
 * memberships, which is the boundary that actually decides.
 */
async function claimAs(
  operation: Operation,
  projectId = operation.projectId,
  workTypes = ['RESEARCH_FRAGMENT'],
): Promise<ClaimedWork[]> {
  const value = await tool(
    'brain_claim_work',
    { project_id: projectId, work_types: workTypes, limit: 1 },
    operation,
  );
  return (value['claimed'] ?? []) as ClaimedWork[];
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

/** The declared fixture: what a worker found outside, and nothing more. */
async function research(operation: Operation, claimed: ClaimedWork, found: string): Promise<void> {
  const submitted = await tool(
    'brain_submit_claims',
    {
      ...proof(claimed),
      claims: [
        {
          claim: found,
          claim_type: 'SOURCED_FACT',
          source_url: `https://example.invalid/notices/${operation.who}`,
          source_title: 'A published notice',
          source_publisher: 'example.invalid',
          source_date: '2026-09-10',
          evidence_excerpt: found,
          evidence_locator: 'the notice body',
          evidence_lane: 'demand_signal',
          retrieved_at: '2026-09-12',
          confidence: 0.9,
          primary_source: true,
        },
      ],
    },
    operation,
  );
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];
  await tool('brain_complete_work', { ...proof(claimed), summary: 'claims in' }, operation);

  await advancePacket(operation.orchestrationId);
  const [verifying] = await claimAs(operation, operation.projectId, ['RESEARCH_VERIFY']);
  if (!verifying) throw new Error(`no verification queued for ${operation.who}`);

  const gate = await tool(
    'brain_submit_verification',
    {
      ...proof(verifying),
      verdicts: stored.map((one) => ({
        claim_id: one.claimId,
        supports_claim: true,
        geography: 'MATCH',
        timeframe: 'MATCH',
        population: 'MATCH',
        definitions: 'MATCH',
        note: 'Read the notice.',
      })),
      sufficiency: 'SUFFICIENT',
    },
    operation,
  );
  expect(gate['acceptedClaims']).toBeGreaterThan(0);
  await tool('brain_complete_work', { ...proof(verifying), summary: 'gated' }, operation);
}

beforeEach(async () => {
  const fixture = await freshProject();
  ana = await makeOperation('ana', {
    projectId: fixture.project.id,
    layer: await fixture.layerByName('Discovery Logic'),
  });
  ben = await makeOperation('ben');
  await queueResearch(ana, 'Who is publicly asking to have an intake form repaired?');
  await queueResearch(ben, 'Who is publicly asking for a one-off data cleanup?');
});

describe('two workers, racing', () => {
  it('take different items, each from its own operation', async () => {
    // Concurrently, on purpose: a claim is a compare-and-swap, and the
    // interesting case is both reading the same generation.
    const [mine, theirs] = await Promise.all([claimAs(ana), claimAs(ben)]);

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]!.workItemId).not.toBe(theirs[0]!.workItemId);
    // And each got its own project's work rather than whichever was oldest.
    expect(mine[0]!.projectId).toBe(ana.projectId);
    expect(theirs[0]!.projectId).toBe(ben.projectId);
  });

  it('cannot be handed the same item twice, however many ask', async () => {
    const [first] = await claimAs(ana);
    expect(first).toBeTruthy();

    // The same worker asking again, and a second worker asking at all.
    const again = await claimAs(ana);
    expect(again).toHaveLength(0);
    const other = await claimAs(ben);
    expect(other.every((one) => one.workItemId !== first!.workItemId)).toBe(true);
  });

  it('cannot reach the other operation by claiming in its project', async () => {
    /*
     * Ben's worker, pointed at Ana's project. Naming a project is a filter over
     * rows the server holds, never a widening of reach — so this is refused
     * outright rather than answered with an empty queue.
     */
    const refused = await claimAs(ben, ana.projectId).catch((error: unknown) => error as Error);
    expect(refused).toBeInstanceOf(Error);

    // And it is the *same* refusal a project that does not exist gives: a
    // distinguishable one is an oracle for enumerating a Brain you cannot see.
    const invented = await claimAs(ben, 'prj_does_not_exist').catch(
      (error: unknown) => error as Error,
    );
    expect((refused as Error).message).toBe((invented as Error).message);

    // Ana's own worker still gets it, so the refusal was about Ben rather than
    // about the item being unavailable.
    expect(await claimAs(ana)).toHaveLength(1);
  });
});

describe('what both of them produced', () => {
  beforeEach(async () => {
    const [mine, theirs] = await Promise.all([claimAs(ana), claimAs(ben)]);
    // Researched concurrently, which is the throughput claim being made.
    await Promise.all([
      research(ana, mine[0]!, 'A published notice asks for an intake form to be repaired.'),
      research(ben, theirs[0]!, 'A published notice asks for a one-off data cleanup.'),
    ]);
  });

  it('lands both results accepted, in the one store', async () => {
    const hers = await citableClaims(ana.orchestrationId);
    const his = await citableClaims(ben.orchestrationId);
    expect(hers).toHaveLength(1);
    expect(his).toHaveLength(1);
    expect(hers[0]!.claim).toContain('intake form');
    expect(his[0]!.claim).toContain('data cleanup');
    // Two orchestrations, one database, both gated by the same engine.
    expect(hers[0]!.id).not.toBe(his[0]!.id);
  });

  it('did not overwrite each other', async () => {
    // Each orchestration holds exactly its own worker's claim: concurrent
    // submission is not a last-writer-wins.
    expect(await listClaims(ana.orchestrationId)).toHaveLength(1);
    expect(await listClaims(ben.orchestrationId)).toHaveLength(1);
  });

  it('keeps each person to their own work view', async () => {
    // An opening apiece, so there is something in each view to confuse.
    for (const operation of [ana, ben]) {
      const captured = await capture({
        projectId: operation.projectId,
        actorRef: operation.userId,
        ownerUserId: operation.userId,
        title: `${operation.who}'s opening`,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: 'USD',
      });
      expect(captured.ok).toBe(true);
    }

    const hers = await cashView({ projectId: ana.projectId });
    const his = await cashView({ projectId: ben.projectId });
    const titles = (view: typeof hers): string[] =>
      view!.myCurrentWork.placements.map((one) => one.opportunity.title);

    expect(titles(hers)).toEqual(["ana's opening"]);
    expect(titles(his)).toEqual(["ben's opening"]);

    // And nothing of the other operation is anywhere in the payload — not the
    // opening, not the claim, not the project.
    const serialized = JSON.stringify(hers);
    expect(serialized).not.toContain("ben's opening");
    expect(serialized).not.toContain(ben.projectId);
    expect(serialized).not.toContain('data cleanup');
  });
});
