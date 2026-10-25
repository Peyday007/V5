/**
 * The shared finding pool (§31) over the real route over the real database.
 *
 * ---------------------------------------------------------------------------
 * Why this seam needs its own file
 * ---------------------------------------------------------------------------
 *
 * `tests/sharedKnowledge.test.ts` proves the boundary itself — what crosses
 * between four private operations and what never does. It has no screen and
 * calls no route for the two decisions §31 gives a finding's origin project:
 * `describeForReader` gained `mayDecide`/`decideRefusal`, `RussellApi` gained
 * three methods, and `Frontier.tsx` gained a "Shared across this Brain"
 * section — and nothing before this file drove any of the three together. A
 * component suite over a scripted `fetch` and a service suite with no screen
 * both pass for a control that posts a field the route does not take, which is
 * exactly the seam `laborSurface.test.tsx` and `designKernelSurface.test.tsx`
 * already exist to close for their own kernels.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here and nowhere else
 * ---------------------------------------------------------------------------
 *
 * **The finding is produced, never hand-written.** The promotion rule reads
 * rows the gate writes, so seeding `shared_findings` by hand would test the
 * fixture rather than the boundary. A `WORKER` principal claims a
 * `RESEARCH_FRAGMENT` off the durable queue, submits through
 * `brain_submit_claims`, and the gate decides acceptance from
 * `brain_submit_verification` — the identical path `sharedKnowledge.test.ts`
 * already walks. Two things this is not, said rather than assumed: not a live
 * Cowork session (no Routine fired, no provider called), and the tool *layer*
 * rather than the MCP *transport* (`tests/mcp.test.ts` and `tests/oauth.test.ts`
 * cover the wire).
 *
 * **`mayDecide`/`decideRefusal` are read for three readers, and the refusal
 * never names the origin project.** An ADMIN of the origin, a member of it
 * below ADMIN, and somebody with no membership there at all.
 *
 * **The rendered section is the server's sentences, not a paraphrase.**
 * Mounted with `projectId: null` deliberately — the pool is Brain-wide and the
 * five project-scoped regions are covered elsewhere; this file is about the
 * one section that does not depend on a project being selected at all.
 *
 * **A revoked or expired finding stays listed.** Withdrawing one is a real
 * POST, read back from the row, and the finding is still there afterward
 * carrying its own `withheldReason`.
 *
 * **A control somebody may not use is disabled with the server's reason.**
 * Never removed — §35 — so a reader who cannot decide sees the identical
 * finding a reader who can decide sees, with both controls present and
 * disabled, carrying `decideRefusal` verbatim.
 *
 * The jsdom-by-hand construction, the dynamic imports and the real socket are
 * `machinesBrowserToDatabase`'s; see its opening comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createLayer, listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { approvePlan, advancePacket } from '../server/services/research/packetRunner.ts';
import { findTool } from '../server/mcp/tools.ts';
import { getFinding, listFindings, promoteEligibleClaims } from '../server/repos/sharedFindings.ts';
import { describeForReader } from '../server/services/knowledge/shared.ts';
import { getProject } from '../server/repos/projects.ts';
import { russellRouter } from '../server/routes/russell.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  ProjectMembership,
  ProjectRole,
  WorkerScope,
} from '../server/domain/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { Frontier } = await import('../client/src/russell/Frontier.tsx');

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
  workerId: string;
  credentialId: string;
}

async function makeOperation(who: string, seeded?: { projectId: string; layer: Layer }): Promise<Operation> {
  const user = await createUser({
    email: `${who}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: who,
    password: 'correct horse battery staple',
  });
  const projectId =
    seeded?.projectId ??
    (
      await createProject({
        name: `${who}'s operation`,
        slug: `${who}-${Math.random().toString(36).slice(2, 8)}`,
      })
    ).id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: user.id,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const layer =
    seeded?.layer ??
    (await listLayers(projectId))[0] ??
    (await createLayer({ projectId, name: 'Opportunity Research', orderIndex: 0 }));

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
  };
}

function workerPrincipalFor(operation: Operation): Principal {
  return {
    type: 'WORKER',
    id: operation.workerId,
    handle: `worker-${operation.who}`,
    displayName: `Worker for ${operation.who}`,
    isBrainAdmin: false,
    mustChangePassword: false,
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

/** A person, holding exactly the memberships this test grants and no more. */
function humanPrincipal(input: {
  who: string;
  userId: string;
  isBrainAdmin?: boolean;
  memberships?: { projectId: string; role: ProjectRole }[];
}): Principal {
  const memberships = input.memberships ?? [];
  return {
    type: 'HUMAN',
    id: input.userId,
    handle: `${input.who}@example.test`,
    displayName: input.who,
    isBrainAdmin: input.isBrainAdmin ?? false,
    mustChangePassword: false,
    credentialId: `sess_${input.who}`,
    authMethod: 'SESSION_COOKIE',
    memberships: memberships.map((membership, index) => ({
      id: `mem_${input.who}_${index}`,
      projectId: membership.projectId,
      principalType: 'HUMAN',
      principalId: input.userId,
      role: membership.role,
      scopes: ['project:read'],
      active: true,
      grantedByType: 'SYSTEM',
      grantedById: 'test',
      grantedAt: new Date().toISOString(),
      revokedAt: null,
    })) as ProjectMembership[],
    requestId: `req_${input.who}`,
  } as Principal;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

async function toolCall(
  name: string,
  args: Record<string, unknown>,
  operation: Operation,
): Promise<Record<string, any>> {
  const found = findTool(name);
  if (!found) throw new Error(`no such tool: ${name}`);
  const outcome = await found.run(args, {
    principal: workerPrincipalFor(operation),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, any>;
}

async function claimQueued(operation: Operation, type: string): Promise<ClaimedWork> {
  const outcome = await toolCall(
    'brain_claim_work',
    { project_id: operation.projectId, work_types: [type], limit: 1 },
    operation,
  );
  const [claimed] = (outcome['claimed'] ?? []) as ClaimedWork[];
  if (!claimed) {
    throw new Error(
      `Brain queued nothing of type ${type} for ${operation.who}: ${JSON.stringify(outcome).slice(0, 600)}`,
    );
  }
  return claimed;
}

/**
 * One accepted claim, through the real path, and promoted into the pool.
 *
 * Everything a fixture could get wrong about the gate — the lane, the source,
 * the four verification judgements — is instead decided by the real
 * `brain_submit_claims` / `brain_submit_verification` tools, exactly as
 * `sharedKnowledge.test.ts`'s `workerResearches` already does. One claim from
 * one source is enough here: this file is about the reader and the two
 * decisions, not about the gate's own independent-source arithmetic.
 */
async function seedOneFinding(operation: Operation): Promise<string> {
  const question = 'Does the county require an electronic recording cover sheet?';
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
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: operation.projectId,
      layerId: operation.layer.id,
      requiredEvidence: [
        {
          id: 'official_source',
          description: 'the recording requirement as an official body states it',
          necessity: 'REQUIRED' as const,
        },
      ],
      acceptableSourceTypes: ['an official page or a county register of deeds'],
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

  const approved = await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: operation.userId });
  expect(approved.enqueued.length).toBeGreaterThan(0);

  const researching = await claimQueued(operation, 'RESEARCH_FRAGMENT');
  const submitted = await toolCall(
    'brain_submit_claims',
    {
      ...proof(researching),
      claims: [
        {
          claim: 'Oakland County requires an electronic recording cover sheet on every submitted deed.',
          claim_type: 'SOURCED_FACT',
          source_url: 'https://records.example.org/oakland/e-recording',
          source_title: 'A published page',
          source_publisher: 'records.example.org',
          source_date: '2026-09-10',
          evidence_excerpt: 'Oakland County requires an electronic recording cover sheet.',
          evidence_locator: 'the page body',
          evidence_lane: 'official_source',
          retrieved_at: '2026-09-12',
          confidence: 0.9,
          primary_source: true,
        },
      ],
      search_queries: [question],
    },
    operation,
  );
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];
  await toolCall(
    'brain_complete_work',
    { ...proof(researching), result_ref: String(submitted['recorded']), summary: 'claims submitted' },
    operation,
  );

  await advancePacket(orchestration.id);
  const verifying = await claimQueued(operation, 'RESEARCH_VERIFY');
  await toolCall(
    'brain_submit_verification',
    {
      ...proof(verifying),
      verdicts: [
        {
          claim_id: stored[0]!.claimId,
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
        },
      ],
      sufficiency: 'SUFFICIENT',
      missing_lanes: [],
      unresolved_gaps: [],
    },
    operation,
  );
  await toolCall(
    'brain_complete_work',
    { ...proof(verifying), result_ref: 'gated', summary: 'verified and gated' },
    operation,
  );

  return stored[0]!.claimId;
}

let origin: Operation;
let outsider: Operation;
let currentPrincipal: Principal | null = null;
let server: Server | null = null;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await freshProject();
  origin = await makeOperation('origin');
  outsider = await makeOperation('outsider');
  currentPrincipal = null;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: currentPrincipal,
      requestId: newRequestId(),
      method: req.method,
      /*
       * `req.path` in a middleware registered with no mount path is the
       * *whole* path, so mounting at `/api/russell` (matching
       * `createApiRouter()`'s real `router.use('/russell', russellRouter)`)
       * gives the policy module exactly the path it matches against, rather
       * than a doubled or missing `/russell` segment.
       */
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api/russell', russellRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    return await realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function originAdminPrincipal(): Principal {
  return humanPrincipal({
    who: 'origin-admin',
    userId: origin.userId,
    memberships: [{ projectId: origin.projectId, role: 'ADMIN' }],
  });
}

async function makeOriginMemberBelowAdmin(): Promise<Principal> {
  const user = await createUser({
    email: `origin-member-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: 'origin-member',
    password: 'correct horse battery staple',
  });
  await grantMembership({
    projectId: origin.projectId,
    principalType: 'HUMAN',
    principalId: user.id,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  return humanPrincipal({
    who: 'origin-member',
    userId: user.id,
    memberships: [{ projectId: origin.projectId, role: 'MEMBER' }],
  });
}

function outsiderPrincipal(): Principal {
  return humanPrincipal({
    who: 'outsider',
    userId: outsider.userId,
    memberships: [{ projectId: outsider.projectId, role: 'ADMIN' }],
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    render(createElement(Frontier, { projectId: null }));
  });
  await waitFor(() => expect(screen.getByText('Shared across this Brain')).toBeTruthy());
  // The heading renders during the loading state too; wait for the fetch to
  // resolve into whichever of empty/populated/error it becomes.
  await waitFor(() =>
    expect(screen.queryByText('Reading the shared finding pool…')).toBeNull(),
  );
}

describe('mayDecide and decideRefusal, read directly', () => {
  it('A01: is true for the origin ADMIN, false for a below-ADMIN member and a non-member, and names no project', async () => {
    await seedOneFinding(origin);
    await promoteEligibleClaims();
    const [finding] = await listFindings();
    expect(finding).toBeTruthy();
    const now = new Date().toISOString();

    const admin = describeForReader(finding!, originAdminPrincipal(), now);
    expect(admin.mayDecide).toBe(true);
    expect(admin.decideRefusal).toBeNull();

    const belowAdmin = describeForReader(finding!, await makeOriginMemberBelowAdmin(), now);
    expect(belowAdmin.mayDecide).toBe(false);
    expect(belowAdmin.decideRefusal).not.toBeNull();

    const stranger = describeForReader(finding!, outsiderPrincipal(), now);
    expect(stranger.mayDecide).toBe(false);
    expect(stranger.decideRefusal).not.toBeNull();

    const originProject = await getProject(origin.projectId);
    for (const refusal of [belowAdmin.decideRefusal, stranger.decideRefusal]) {
      expect(refusal).not.toBeNull();
      expect(refusal).not.toContain(origin.projectId);
      if (originProject) expect(refusal).not.toContain(originProject.name);
    }

    // The same refusal, whichever DenialReason produced it -- a sentence built
    // per project could leak one by accident; a constant cannot.
    expect(belowAdmin.decideRefusal).toBe(stranger.decideRefusal);

    // No credentials at all is refused the identical way.
    const anonymous = describeForReader(finding!, null, now);
    expect(anonymous.mayDecide).toBe(false);
    expect(anonymous.decideRefusal).toBe(belowAdmin.decideRefusal);
  }, 60000);
});

describe('the shared pool, rendered', () => {
  it('A02: renders every statement, source URL and the two counts, and hides the origin from a reader who cannot read it', async () => {
    await seedOneFinding(origin);
    await promoteEligibleClaims();

    currentPrincipal = outsiderPrincipal();
    await mount();

    const section = dom.window.document.querySelector('.rs-frontier-shared')!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain(
      'Oakland County requires an electronic recording cover sheet on every submitted deed.',
    );
    expect(section.textContent).toContain('https://records.example.org/oakland/e-recording');
    expect(section.textContent).toMatch(/1 finding\(s\) total/);
    expect(section.textContent).toMatch(/1 Brain would reuse right now/);

    // The outsider cannot read the origin project: no id or name anywhere.
    expect(section.textContent).not.toContain(origin.projectId);
    expect(section.textContent).toContain('Which project this came from is not shown to you.');
  }, 60000);
});

describe('withdrawing a finding', () => {
  it('A03: leaves the row REVOKED with its stored reason, and it is still listed carrying that reason', async () => {
    await seedOneFinding(origin);
    await promoteEligibleClaims();
    const [finding] = await listFindings();
    expect(finding).toBeTruthy();

    currentPrincipal = originAdminPrincipal();
    const response = await fetch(`/api/russell/shared-findings/${finding!.findingId}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'This one is superseded by a newer reading.' }),
    });
    expect(response.status).toBe(200);

    const revoked = await getFinding(finding!.findingId);
    expect(revoked?.state).toBe('REVOKED');
    expect(revoked?.revokedReason).toBe('This one is superseded by a newer reading.');

    await mount();
    const section = dom.window.document.querySelector('.rs-frontier-shared')!;
    expect(section.textContent).toContain(
      'Oakland County requires an electronic recording cover sheet on every submitted deed.',
    );
    expect(section.textContent).toContain(
      'Withdrawn from reuse: This one is superseded by a newer reading.',
    );
    expect(section.textContent).toMatch(/0 Brain would reuse right now/);
  }, 60000);
});

describe('setting and clearing a horizon', () => {
  it('A04: stores validUntil, clears it on null, and refuses a non-ADMIN reader with no row change', async () => {
    await seedOneFinding(origin);
    await promoteEligibleClaims();
    const [finding] = await listFindings();
    expect(finding).toBeTruthy();
    const findingId = finding!.findingId;

    currentPrincipal = originAdminPrincipal();
    const setResponse = await fetch(`/api/russell/shared-findings/${findingId}/horizon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ validUntil: '2030-01-01T00:00:00.000Z' }),
    });
    expect(setResponse.status).toBe(200);
    expect((await getFinding(findingId))?.validUntil).toBe('2030-01-01T00:00:00.000Z');

    const clearResponse = await fetch(`/api/russell/shared-findings/${findingId}/horizon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ validUntil: null }),
    });
    expect(clearResponse.status).toBe(200);
    expect((await getFinding(findingId))?.validUntil).toBeNull();

    // A below-ADMIN member is refused, and nothing about the row moves.
    currentPrincipal = await makeOriginMemberBelowAdmin();
    const before = await getFinding(findingId);
    const refused = await fetch(`/api/russell/shared-findings/${findingId}/horizon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ validUntil: '2030-01-01T00:00:00.000Z' }),
    });
    expect(refused.status).toBe(404);
    expect(await getFinding(findingId)).toEqual(before);

    const revokeRefused = await fetch(`/api/russell/shared-findings/${findingId}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Trying anyway.' }),
    });
    expect(revokeRefused.status).toBe(404);
    expect(await getFinding(findingId)).toEqual(before);

    // The rendered controls are disabled for that same reader, carrying the
    // server's own refusal.
    await mount();
    const section = dom.window.document.querySelector('.rs-frontier-shared')!;
    const withdrawButton = Array.from(section.querySelectorAll('button')).find(
      (button) => button.textContent === 'Withdraw',
    ) as HTMLButtonElement;
    const setButton = Array.from(section.querySelectorAll('button')).find(
      (button) => button.textContent === 'Set',
    ) as HTMLButtonElement;
    expect(withdrawButton?.disabled).toBe(true);
    expect(setButton?.disabled).toBe(true);
    const freshFinding = (await listFindings()).find((one) => one.findingId === findingId);
    expect(freshFinding).toBeTruthy();
    const refusalText = describeForReader(freshFinding!, currentPrincipal, new Date().toISOString())
      .decideRefusal;
    expect(refusalText).not.toBeNull();
    expect(section.textContent).toContain(refusalText);
  }, 60000);
});

describe('who may read the pool, and what an empty one looks like', () => {
  it('A05: renders the empty-pool sentence on an empty database', async () => {
    currentPrincipal = originAdminPrincipal();
    await mount();
    const section = dom.window.document.querySelector('.rs-frontier-shared')!;
    expect(section.textContent).toContain('Nothing has been shared into this pool yet.');
    expect(section.textContent).toMatch(/0 finding\(s\) total/);
  }, 60000);

  it('A05: refuses a WORKER principal with 404 at GET /shared-findings', async () => {
    currentPrincipal = workerPrincipalFor(origin);
    const response = await fetch('/api/russell/shared-findings');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No such route.' });
  }, 60000);
});
