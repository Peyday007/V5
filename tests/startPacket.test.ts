/**
 * Starting a packet, and refusing to research what the project already knows.
 *
 * Two things are under test and they are the two halves of the same rule.
 *
 * `startPacket` is the operation the console has been performing inline, now
 * where a scheduler or the Brain's own decider can call it. The tests assert
 * what it must keep doing — one planning job, nothing researched, no
 * allowance spent — and the one thing it now does that the route did not:
 * take the approval policy as an argument, and refuse a mode whose budget
 * nothing enforces.
 *
 * The coverage gate is §13 arriving on the path that did not have it. A
 * worker's proposal used to become research without anybody asking what the
 * archive held. These tests build a real archive — imported, extracted, read —
 * and check that a fragment it answers does not become work, and that one it
 * does not answer still does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { findTool } from '../server/mcp/tools.ts';
import { importFile } from '../server/services/importer.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { createWorker, grantMembership, revokeMembership } from '../server/repos/identity.ts';
import { claimWork, enqueueWork, listWorkItems } from '../server/repos/workQueue.ts';
import { dependencyKeys } from '../server/domain/dependencies.ts';
import { isLaneId } from '../server/domain/evidenceLanes.ts';
import { currentFragments, getOrchestration } from '../server/repos/research.ts';
import { listRequirements, listCoverage } from '../server/repos/reconciliation.ts';
import { getRun } from '../server/repos/runs.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import {
  ApprovalModeUnavailable,
  GoalIncomplete,
  NoSuchTarget,
  startPacket,
  SUPPORTED_APPROVAL_MODES,
} from '../server/services/research/startPacket.ts';
import { MICHIGAN_LICENSING_ASSIGNMENT } from '../server/services/research/approvalEnvelope.ts';
import type { ClaimedWork, Layer, Principal, WorkerScope } from '../server/domain/types.ts';

const FULL: WorkerScope[] = [
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

let fixture: TestProject;
let layer: Layer;
let workerId = '';

async function principal(): Promise<Principal> {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'test-worker',
    displayName: 'Test Worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_test',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_test',
        projectId: fixture.project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: FULL,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'seed',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      },
    ],
    requestId: 'req_test',
  };
}

/** Call a tool and return the refusal rather than throwing it. */
async function refusal(
  name: string,
  args: Record<string, unknown>,
): Promise<{ category: string; message: string }> {
  try {
    await call(name, args);
  } catch (error) {
    const err = error as { category?: string; message?: string };
    return { category: err.category ?? 'THREW', message: err.message ?? String(error) };
  }
  throw new Error(`${name} was expected to refuse and did not.`);
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: await principal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

/** Queue the planning item for a packet and claim it, as a worker would. */
async function claimPlan(orchestrationId: string): Promise<ClaimedWork> {
  const definition = workType('RESEARCH_PLAN');
  const items = await listWorkItems(fixture.project.id, { limit: 100 });
  const existing = items.find(
    (item) => item.orchestrationId === orchestrationId && item.workType === 'RESEARCH_PLAN',
  );
  if (!existing) {
    await enqueueWork({
      projectId: fixture.project.id,
      workType: 'RESEARCH_PLAN',
      payload: definition.validate({}),
      requiredScopes: definition.requiredScopes,
      orchestrationId,
      fragmentId: null,
      createdByType: 'SYSTEM',
    });
  }
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId: fixture.project.id, scopes: FULL }],
    workTypes: ['RESEARCH_PLAN'],
  });
  if (!claimed) throw new Error('nothing claimable');
  return claimed;
}

/** Import a document with known contents and wait for it to be read. */
async function addRead(name: string, text: string): Promise<string> {
  const result = await importFile({
    projectId: fixture.project.id,
    originalFilename: name,
    contents: Buffer.from(text),
    layerId: (await fixture.layerByName('World Model')).id,
    version: 'v1',
    documentType: 'FOUNDATION',
  });
  await whenExtractionIdle();
  return result.documentId!;
}

/**
 * An archive that answers one question properly.
 *
 * Two independent publishers, both cited, both dated inside the timeframe —
 * which is what SATISFIED costs. Anything less lands on one of the statuses
 * that still needs research, which is the point of setting the bar there.
 */
const ANSWERED = [
  'Recognition of custody transfer in the United States',
  '',
  'Employment in the outsourced telemarketing occupation was 81,580 in 2024 according to the',
  'Bureau of Labor Statistics. https://www.bls.gov/oes/current/oes419041.htm',
  '',
  'Census Bureau statistics put employment in the same outsourced telemarketing occupation at a',
  'comparable level for 2024. https://www.census.gov/programs-surveys/susb.html',
].join('\n');

function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'telemarketing-employment',
    question: 'Employment in the outsourced telemarketing occupation',
    geography: 'United States',
    timeframe: '2024',
    required_evidence: ['official statistics'],
    completion_criteria: ['a sourced figure from a statistical agency'],
    ...over,
  };
}

beforeEach(async () => {
  fixture = await freshProject();
  layer = await fixture.layerByName('Monetization Logic');
  const worker = await createWorker({
    name: 'test-worker',
    displayName: 'Test Worker',
    createdByType: 'SYSTEM',
    createdById: 'seed',
  });
  workerId = worker.id;
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: FULL,
    grantedByType: 'SYSTEM',
    grantedById: 'seed',
  });
});
afterEach(async () => {
  await teardown();
});

function goal(over: Partial<Parameters<typeof startPacket>[0]> = {}): Parameters<typeof startPacket>[0] {
  return {
    projectId: fixture.project.id,
    layerId: layer.id,
    title: 'Licensure of success-fee intermediation',
    assignment: 'Which US states require a licence, and what provision settles it.',
    approval: { mode: 'PER_PACKET' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The operation the console used to be
// ---------------------------------------------------------------------------

describe('what the plan tool tells a worker to do next', () => {
  /*
   * The defect that stopped the first real packet, one layer above the queue.
   *
   * This tool answered `AWAITING_APPROVAL` whatever the packet's approval mode
   * was, and its description said "nothing is researched until a person
   * approves". For a packet carrying an envelope both were false. The worker
   * proposed all four fragments, read that a human was needed, and released the
   * bin **without completing the work item** — and completing it is the only
   * thing that calls `advancePacket`, which is the only place the envelope is
   * evaluated. The plan was written, correct, and never checked.
   *
   * So the tool has to say which approval is coming, and in both modes it has
   * to say the item still needs completing. Nothing about the gate moves.
   */
  it('tells a preauthorized packet that Brain approves it, and to finish the item', async () => {
    const started = await startPacket(
      goal({
        assignment: MICHIGAN_LICENSING_ASSIGNMENT,
        approval: {
          mode: 'AUTO_WITHIN_ENVELOPE',
          envelopeId: 'STEP10_MICHIGAN_LICENSING_V1',
          authorizedBy: 'operator:test',
        },
      }),
    );
    const claimed = await claimPlan(started.orchestration.id);
    const value = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal()],
    });

    expect(value['status']).toBe('AWAITING_SYSTEM_APPROVAL');
    const next = String(value['nextStep']);
    expect(next).toMatch(/complete this work item/i);
    // The inversion. A worker told to wait for somebody is a worker that does
    // not complete the item, which is exactly what happened in production.
    expect(next).not.toMatch(/wait for a person|until a person|human approval/i);
  });

  it('tells an ordinary packet a person decides, and still to finish the item', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);
    const value = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal()],
    });

    expect(value['status']).toBe('AWAITING_HUMAN_APPROVAL');
    const next = String(value['nextStep']);
    expect(next).toMatch(/complete this work item/i);
    expect(next).toMatch(/person/i);
  });
});

describe('startPacket', () => {
  it('creates the run and the orchestration and queues exactly one planning job', async () => {
    const started = await startPacket(goal());

    expect(started.orchestration.title).toBe('Licensure of success-fee intermediation');
    expect(started.orchestration.projectId).toBe(fixture.project.id);
    expect(started.orchestration.layerId).toBe(layer.id);
    expect((await getRun(started.run.id))?.provider).toBe('WORKER');

    const items = await listWorkItems(fixture.project.id, { limit: 100 });
    const mine = items.filter((item) => item.orchestrationId === started.orchestration.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.workType).toBe('RESEARCH_PLAN');
  });

  it('researches nothing and spends nothing', async () => {
    const started = await startPacket(goal());

    // The whole §16 gate in one assertion: after starting a packet there is no
    // fragment, so there is nothing a worker could research even if it tried.
    expect(await currentFragments(started.orchestration.id)).toHaveLength(0);
    const items = await listWorkItems(fixture.project.id, { limit: 100 });
    expect(items.some((item) => item.workType === 'RESEARCH_FRAGMENT')).toBe(false);
    expect(started.advanced.status).toBe('PLANNING');
  });

  it('marks the packet as needing a person under per-packet approval', async () => {
    const started = await startPacket(goal());
    expect(started.orchestration.autoApprove).toBe(false);
    expect(started.orchestration.approvedAt).toBeNull();
  });

  it('targets v1 for a layer with no document and a later version for one with', async () => {
    const first = await startPacket(goal());
    expect(first.run.runType).toBe('FOUNDATION');

    await importFile({
      projectId: fixture.project.id,
      originalFilename: 'Monetization Logic v1.txt',
      contents: Buffer.from('A prior packet already landed here, at some length, to be readable.'),
      layerId: layer.id,
      version: 'v1',
      documentType: 'FOUNDATION',
    });
    await whenExtractionIdle();

    const second = await startPacket(goal());
    // FOUNDATION targets v1 by definition, so a second packet on the same
    // layer that asked for one would be refused by the importer as a
    // duplicate. This is the assertion that stops that regressing.
    expect(second.run.runType).toBe('EXPANSION');
  });

  it('reports what the archive already holds, before anything is created', async () => {
    await addRead('World Model v1.txt', ANSWERED);
    const started = await startPacket(goal());

    expect(started.archive.documentsRead).toBeGreaterThan(0);
    expect(started.archive.claims).toBeGreaterThan(0);
    expect(started.archive.documentsUnreadable).toBe(0);
  });

  it('counts a document it cannot read as unreadable rather than as empty', async () => {
    await addRead('World Model v1.txt', 'too short');
    const started = await startPacket(goal());
    expect(started.archive.documentsUnreadable).toBeGreaterThan(0);
  });

  it('counts a worker that holds the scopes the queued work actually needs', async () => {
    // The fixture already granted this worker the full research scopes, which
    // is the ordinary case: somebody who can do the work belongs to the
    // project the work is in.
    const started = await startPacket(goal());
    expect(started.claimants.workers).toBe(1);
    expect(started.claimants.eligible).toBe(1);
  });

  it('says when no connected worker could claim what it just queued', async () => {
    // The failure this exists to stop: a packet created in a project no worker
    // belongs to. The queue is right to say nothing — a worker sees only its
    // own projects, and a project it may not have is absent rather than
    // refused. But that makes "there is no work" and "that work is not yours"
    // the same sentence from the worker's side, so the difference has to be
    // said where it is knowable, which is here.
    await revokeMembership(fixture.project.id, 'WORKER', workerId);

    const started = await startPacket(goal());
    expect(started.claimants.workers).toBe(0);
    expect(started.claimants.eligible).toBe(0);
  });

  it('does not count a member that cannot claim this kind of work', async () => {
    const narrow = await createWorker({
      name: 'narrow-worker',
      displayName: 'Narrow Worker',
      createdByType: 'SYSTEM',
      createdById: 'seed',
    });
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'WORKER',
      principalId: narrow.id,
      role: 'MEMBER',
      // Enough to see the project and take an item, and not enough to plan.
      scopes: ['project:read', 'queue:read', 'queue:claim'],
      grantedByType: 'SYSTEM',
      grantedById: 'seed',
    });

    const started = await startPacket(goal());
    // Two members, one of whom could actually do it. Counting memberships
    // alone would have called the narrow one covered.
    expect(started.claimants.workers).toBe(2);
    expect(started.claimants.eligible).toBe(1);
  });

  it('refuses a goal with no title or no assignment', async () => {
    await expect(startPacket(goal({ title: '   ' }))).rejects.toBeInstanceOf(GoalIncomplete);
    await expect(startPacket(goal({ assignment: '' }))).rejects.toBeInstanceOf(GoalIncomplete);
  });

  it('answers a missing project and a missing layer with the same refusal', async () => {
    const noProject = await startPacket(goal({ projectId: 'prj_nope' })).then(
      () => null,
      (error: unknown) => error as Error,
    );
    const noLayer = await startPacket(goal({ layerId: 'lyr_nope' })).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(noProject).toBeInstanceOf(NoSuchTarget);
    expect(noLayer).toBeInstanceOf(NoSuchTarget);
    // Invariant 23 does not stop applying because the caller is in-process.
    expect(noProject!.message).toBe(noLayer!.message);
  });

  it('refuses an approval mode whose budget nothing enforces', async () => {
    expect(SUPPORTED_APPROVAL_MODES).not.toContain('GOAL_BUDGET');

    const refused = await startPacket(
      goal({
        approval: {
          mode: 'GOAL_BUDGET',
          goalId: 'goal_test',
          budget: {
            maxPackets: 3,
            maxFragments: 12,
            deadline: null,
            externalSpendCents: 0,
            paidOveragesEnabled: false,
          },
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(refused).toBeInstanceOf(ApprovalModeUnavailable);
    // Refused before anything was created, so a ceiling nobody enforces never
    // becomes a packet that ran without one.
    expect(await listWorkItems(fixture.project.id, { limit: 100 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §13 on the path that did not have it
// ---------------------------------------------------------------------------

describe('the coverage gate on a proposed plan', () => {
  it('does not create a fragment for a question the archive already answers', async () => {
    await addRead('World Model v1.txt', ANSWERED);
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const value = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal()],
    });

    expect(value['proposed']).toBe(0);
    expect(value['status']).toBe('NOTHING_TO_RESEARCH');
    const answered = value['alreadyAnswered'] as { fragmentKey: string; why: string }[];
    expect(answered.map((entry) => entry.fragmentKey)).toEqual(['telemarketing-employment']);
    expect(answered[0]!.why).toMatch(/already answers this/i);

    // Nothing to research means nothing was created to research.
    expect(await currentFragments(started.orchestration.id)).toHaveLength(0);
  });

  it('ends the packet with a reason rather than as a gate everything failed', async () => {
    await addRead('World Model v1.txt', ANSWERED);
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);
    await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal()],
    });

    const orchestration = await getOrchestration(started.orchestration.id);
    expect(orchestration?.status).toBe('CANCELLED');
    // "The project already knew this" is the best outcome this module has and
    // must not be reported as "no fragment cleared its evidence gate".
    expect(orchestration?.cancelReason).toMatch(/already answers all 1 proposed fragment/i);
    expect(orchestration?.failureReason ?? '').not.toMatch(/cleared/i);
  });

  it('still creates a fragment for a question the archive does not answer', async () => {
    await addRead('World Model v1.txt', ANSWERED);
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const value = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        proposal(),
        proposal({
          key: 'licence-california',
          question: 'Does California require a broker licence for a success fee on a business sale?',
          required_evidence: ['statute'],
          completion_criteria: ['one statute section that answers yes or no'],
        }),
      ],
    });

    expect(value['proposed']).toBe(1);
    expect(value['fragmentKeys']).toEqual(['licence-california']);
    expect(value['status']).toBe('AWAITING_HUMAN_APPROVAL');

    const fragments = await currentFragments(started.orchestration.id);
    expect(fragments.map((fragment) => fragment.fragmentKey)).toEqual(['licence-california']);
    expect(fragments[0]!.status).toBe('PLANNED');
  });

  it('researches everything proposed when the project has no archive at all', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const value = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal(), proposal({ key: 'second-question' })],
    });

    // An empty archive answers nothing, so the check must never be a reason
    // a packet on a new project researches less than it was asked to.
    expect(value['proposed']).toBe(2);
    expect((value['alreadyAnswered'] as unknown[])).toHaveLength(0);
  });

  it('refuses a fragment that names a sibling it does not declare a dependency on', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const refused = await refusal('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        proposal({ key: 'ca-licence-trigger', question: 'Does California require a licence?' }),
        proposal({
          key: 'ca-penalty',
          // Names its sibling and declares nothing. Exactly what the first
          // real packet did, five times, and nothing noticed.
          question: 'What is the penalty for acting without the licence identified in ca-licence-trigger?',
        }),
      ],
    });

    expect(refused.category).toBe('INVALID_INPUT');
    expect(refused.message).toContain('depends_on');
    // Refused whole. A plan that is half-created is worse than one refused.
    expect(await currentFragments(started.orchestration.id)).toHaveLength(0);
  });

  it('refuses a plan whose fragments wait on each other', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const refused = await refusal('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        // Every key exists and neither depends on itself, so both of the
        // existing checks pass. Neither can ever start.
        proposal({ key: 'scope', question: 'What counts as a business sale?', depends_on: ['trigger'] }),
        proposal({ key: 'trigger', question: 'Does a licence apply?', depends_on: ['scope'] }),
      ],
    });

    expect(refused.category).toBe('INVALID_INPUT');
    expect(refused.message).toContain('cycle');
    expect(refused.message).toContain('scope');
    expect(refused.message).toContain('trigger');
    expect(await currentFragments(started.orchestration.id)).toHaveLength(0);
  });

  it('refuses a longer ring, not only a pair', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const refused = await refusal('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        proposal({ key: 'a', question: 'First question?', depends_on: ['c'] }),
        proposal({ key: 'b', question: 'Second question?', depends_on: ['a'] }),
        proposal({ key: 'c', question: 'Third question?', depends_on: ['b'] }),
      ],
    });

    expect(refused.category).toBe('INVALID_INPUT');
    expect(refused.message).toContain('cycle');
    expect(await currentFragments(started.orchestration.id)).toHaveLength(0);
  });

  it('accepts the same pair once the dependency is declared', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const value = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        proposal({ key: 'ca-licence-trigger', question: 'Does California require a licence?' }),
        proposal({
          key: 'ca-penalty',
          question: 'What is the penalty for acting without the licence identified in ca-licence-trigger?',
          depends_on: ['ca-licence-trigger'],
        }),
      ],
    });

    expect(value['proposed']).toBe(2);
    const fragments = await currentFragments(started.orchestration.id);
    const penalty = fragments.find((f) => f.fragmentKey === 'ca-penalty');
    // Typed now, not a bare string: a dependency says how much it blocks. A
    // key proposed without a kind reads HARD, which is what it meant before
    // kinds existed — the conservative reading, and no row is rewritten.
    expect(dependencyKeys(penalty?.dependsOn ?? [])).toEqual(['ca-licence-trigger']);
    expect(penalty?.dependsOn).toEqual([{ key: 'ca-licence-trigger', kind: 'HARD' }]);
  });

  /**
   * A lane is an id, a description and a necessity — and the id is refused
   * rather than repaired when it is a sentence.
   *
   * The packet before this declared lanes like "Definitions in NY Real
   * Property Law Art. 12-A deciding whether 'real estate broker' activity
   * includes or excludes arranging a business sale with no realty
   * transferred", three per fragment, matched by exact string. Quietly slugging
   * that into an id would leave the plan believing it had named a concept when
   * it had named a paragraph, so the plan is refused and told what an id is.
   */
  it('refuses a lane id that is a sentence, and says what one looks like', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    const refusal = await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        proposal({
          required_evidence: [
            {
              id: "Definitions in NY Real Property Law Art. 12-A deciding whether 'real estate " +
                "broker' activity includes arranging a business sale",
              description: 'The operative definition.',
              necessity: 'REQUIRED',
            },
          ],
        }),
      ],
    })
      .then(() => null)
      .catch((error: unknown) => error as Error);

    expect(refusal).toBeTruthy();
    expect(refusal!.message).toMatch(/not an identifier/i);
    expect(refusal!.message).toContain('operative_authority');
    expect(await currentFragments(started.orchestration.id)).toHaveLength(0);
  });

  it('keeps a declared id, its description and its necessity, apart', async () => {
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);

    await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [
        proposal({
          key: 'ny-licence',
          required_evidence: [
            {
              id: 'operative_authority',
              description: 'The statute or regulation that settles whether a licence is required.',
              necessity: 'REQUIRED',
            },
            {
              id: 'regulator_guidance',
              description: 'Published regulator guidance on business-only sales, if any exists.',
              necessity: 'CONDITIONAL',
            },
          ],
        }),
      ],
    });

    const [fragment] = await currentFragments(started.orchestration.id);
    expect(fragment!.requiredEvidence).toEqual([
      {
        id: 'operative_authority',
        description: 'The statute or regulation that settles whether a licence is required.',
        necessity: 'REQUIRED',
      },
      {
        id: 'regulator_guidance',
        description: 'Published regulator guidance on business-only sales, if any exists.',
        necessity: 'CONDITIONAL',
      },
    ]);
    // The fragment's own lane label, when it has one, is an id and never a
    // sentence. `brain_propose_fragments` leaves it unset; the archive-derived
    // planner sets it, and both go through the same shape.
    expect(fragment!.evidenceLane === null || isLaneId(fragment!.evidenceLane)).toBe(true);
  });

  it('records the decision behind every fragment, kept or dropped', async () => {
    await addRead('World Model v1.txt', ANSWERED);
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);
    await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal(), proposal({ key: 'licence-california', question: 'Does California require a broker licence for a success fee?' })],
    });

    const requirements = await listRequirements(started.orchestration.id);
    expect(requirements.map((entry) => entry.requirementKey).sort()).toEqual([
      'licence-california',
      'telemarketing-employment',
    ]);

    // A decision nobody can look up is not a decision. Every proposed
    // fragment has a persisted coverage row saying what was concluded.
    const coverage = await listCoverage(started.orchestration.id);
    expect(coverage).toHaveLength(2);
    const byRequirement = new Map(coverage.map((entry) => [entry.requirementId, entry]));
    const answered = requirements.find((r) => r.requirementKey === 'telemarketing-employment')!;
    const open = requirements.find((r) => r.requirementKey === 'licence-california')!;
    expect(byRequirement.get(answered.id)!.needsResearch).toBe(false);
    expect(byRequirement.get(open.id)!.needsResearch).toBe(true);
    expect(byRequirement.get(answered.id)!.reasons.join(' ')).toMatch(/publisher/i);
  });

  it('carries the archive claims a surviving fragment has to improve on', async () => {
    // A single publisher: enough to be about the question, not enough to
    // settle it. The fragment survives, and it should know what it is adding
    // to rather than start as though the archive were empty.
    await addRead(
      'World Model v1.txt',
      [
        'Recognition of custody transfer in the United States',
        '',
        'Employment in the outsourced telemarketing occupation was 81,580 in 2024 according to',
        'the Bureau of Labor Statistics. https://www.bls.gov/oes/current/oes419041.htm',
        '',
        'Custody transfer is recognised at the point of the recorded act in 2024 filings.',
      ].join('\n'),
    );
    const started = await startPacket(goal());
    const claimed = await claimPlan(started.orchestration.id);
    await call('brain_propose_fragments', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      fragments: [proposal()],
    });

    const [fragment] = await currentFragments(started.orchestration.id);
    expect(fragment).toBeDefined();
    expect(fragment!.existingClaimIds.length).toBeGreaterThan(0);
    expect(fragment!.whyExistingInsufficient ?? '').not.toBe('');
    expect(fragment!.requirementIds).toHaveLength(1);
  });
});

describe('the unresolved-gap policy as a packet input', () => {
  it('is absent unless the caller asks for it', async () => {
    const started = await startPacket(goal());
    expect(started.orchestration.unresolvedGapPolicy).toBeNull();
    expect(started.orchestration.unresolvedGapAuthorizedBy).toBeNull();
  });

  it('is recorded with its author when the caller authorizes it', async () => {
    const started = await startPacket({
      ...goal(),
      unresolvedGap: { policy: 'RECORD_GAPS', authorizedBy: 'usr_operator' },
    });
    expect(started.orchestration.unresolvedGapPolicy).toBe('RECORD_GAPS');
    expect(started.orchestration.unresolvedGapAuthorizedBy).toBe('usr_operator');
    expect((started.orchestration.unresolvedGapAuthorizedAt ?? '').length).toBeGreaterThan(0);
  });
});
