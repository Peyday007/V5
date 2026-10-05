/**
 * A research goal is approved once, and Brain continues it inside the ceilings.
 *
 * ---------------------------------------------------------------------------
 * What this walks
 * ---------------------------------------------------------------------------
 *
 * A person creates a goal (two packets at most). The durable Russell tick —
 * `tick()` itself, so the call in loop.ts is part of the walk — starts
 * packet 1; a worker proposes fragments, claims and verifications through the
 * real MCP tools, and the packet's fragments are approved with nobody asked.
 * When packet 1 ends leaving a mandatory requirement unresolved the pass starts
 * packet 2 with no new approval, and the third is refused by the ceiling with
 * exactly one request for a person.
 *
 * **What is simulated, said rather than assumed.** The worker's own judgements
 * (the fragment, the claims, the verdicts) are the declared external edge, and
 * the end of packet 1 is set by the test. That is deliberate rather than
 * convenient: a packet that leaves a mandatory requirement unresolved reaches a
 * terminal status only through repair attempts, three separately sessioned audit
 * roles and, for a filed-short packet, a person's decision (§16, §23) — all of
 * which have their own suites and none of which this module decides. Everything
 * the continuation pass reads and writes — goal rows, packet rows, the budget
 * ledger, the human request — is the real one, and every assertion reads rows.
 * It is not a live Cowork session and it is the tool layer rather than the MCP
 * transport.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { findTool } from '../server/mcp/tools.ts';
import { importFile } from '../server/services/importer.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { claimWork, listWorkItems } from '../server/repos/workQueue.ts';
import { createResearchGoal, getGoal, goalBudgetStatus } from '../server/repos/russellAuthority.ts';
import { currentFragments, updateOrchestration } from '../server/repos/research.ts';
import { inventoryProject } from '../server/services/reconcile/plan.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { advanceResearchGoals } from '../server/services/research/goalContinuation.ts';
import { tick } from '../server/services/russell/loop.ts';
import type { ClaimedWork, Layer, Principal, WorkerScope } from '../server/domain/types.ts';

const HOUR = 3_600_000;
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

const QUESTION = 'Employment in the outsourced telemarketing occupation';
const ANSWERED = [
  'Recognition of custody transfer in the United States',
  '',
  'Employment in the outsourced telemarketing occupation was 81,580 in 2024 according to the',
  'Bureau of Labor Statistics. https://www.bls.gov/oes/current/oes419041.htm',
  '',
  'Census Bureau statistics put employment in the same outsourced telemarketing occupation at a',
  'comparable level for 2024. https://www.census.gov/programs-surveys/susb.html',
].join('\n');

let fixture: TestProject;
let layer: Layer;
let workerId = '';
let userId = '';

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

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: await principal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, any>;
}

async function claimOf(type: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId: fixture.project.id, scopes: FULL }],
    workTypes: [type],
  });
  if (!claimed) throw new Error(`nothing claimable of type ${type}`);
  return claimed;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

async function newGoal(over: { maxPackets?: number; assignment?: string } = {}) {
  return createResearchGoal({
    projectId: fixture.project.id,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Telemarketing employment',
    maxPackets: over.maxPackets ?? 2,
    maxFragments: 10,
    deadline: new Date(Date.now() + 2 * HOUR).toISOString(),
    researchAssignment: over.assignment ?? 'How many people work in outsourced telemarketing, and where.',
    researchLayerId: layer.id,
  });
}

async function count(table: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [
    fixture.project.id,
  ]);
  return Number(row?.n ?? 0);
}

async function claimCount(): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM research_claims
      WHERE fragment_id IN (SELECT id FROM research_fragments WHERE project_id = ?)`,
    [fixture.project.id],
  );
  return Number(row?.n ?? 0);
}

async function packetsOf(goalId: string): Promise<{ id: string; goal_packet_key: string; status: string }[]> {
  return getDb().all(
    'SELECT id, goal_packet_key, status FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at, id',
    [goalId],
  );
}

async function requestsFor(goalId: string): Promise<{ id: string; state: string; authority_needed: string }[]> {
  return getDb().all(
    `SELECT id, state, authority_needed FROM russell_human_requests WHERE resume_key LIKE ?`,
    [`goal-budget:${goalId}:%`],
  );
}

beforeEach(async () => {
  fixture = await freshProject();
  layer = await fixture.layerByName('Monetization Logic');
  userId = (
    await createUser({
      email: `gj-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
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

describe('a goal approved once continues without another approval', () => {
  it('starts packet 1, then packet 2 when packet 1 leaves the goal unanswered', async () => {
    const goal = await newGoal();
    expect((await getGoal(goal.id))?.researchAssignment).toMatch(/telemarketing/);

    // Through the durable tick, as production runs it: the wiring in loop.ts is
    // part of what is being walked, so removing the call fails here.
    const first = await tick('journey');
    expect(first.ran).toBe(true);
    expect(first.researchGoals?.started).toHaveLength(1);
    expect(first.researchGoals?.started[0]!.packetKey).toBe('round-1');
    const [one] = await packetsOf(goal.id);
    expect(one?.goal_packet_key).toBe('round-1');

    // A second tick while packet 1 is live creates nothing.
    await tick('journey');
    expect(await packetsOf(goal.id)).toHaveLength(1);

    // The worker plans through the real tools; nobody approves the fragments.
    const plan = await claimOf('RESEARCH_PLAN');
    const proposed = await call('brain_propose_fragments', {
      ...proof(plan),
      fragments: [
        {
          key: 'telemarketing-employment',
          question: QUESTION,
          geography: 'United States',
          timeframe: '2024',
          required_evidence: ['official statistics'],
          completion_criteria: ['a sourced figure from a statistical agency'],
        },
      ],
    });
    expect(proposed['proposed']).toBe(1);
    await call('brain_complete_work', { ...proof(plan), result_ref: 'planned', summary: 'plan proposed' });
    await advancePacket(one!.id);

    const fragments = await currentFragments(one!.id);
    expect(fragments).toHaveLength(1);
    const approvedItems = (await listWorkItems(fixture.project.id, { limit: 100 })).filter(
      (item) => item.orchestrationId === one!.id && item.workType === 'RESEARCH_FRAGMENT',
    );
    expect(approvedItems.length).toBeGreaterThan(0);
    // No person was ever asked: the goal's approval was the only approval.
    expect(await requestsFor(goal.id)).toHaveLength(0);

    // The worker researches and a verifier judges, through the real tools.
    const researching = await claimOf('RESEARCH_FRAGMENT');
    const submitted = await call('brain_submit_claims', {
      ...proof(researching),
      claims: [
        {
          claim: 'Employment in the outsourced telemarketing occupation was 81,580 in 2024.',
          claim_type: 'SOURCED_FACT',
          source_url: 'https://www.bls.gov/oes/current/oes419041.htm',
          source_title: 'A published page',
          source_publisher: 'www.bls.gov',
          source_date: '2025-04-01',
          evidence_excerpt: 'Employment in the outsourced telemarketing occupation was 81,580 in 2024.',
          evidence_locator: 'the page body',
          evidence_lane: 'official_statistics',
          retrieved_at: '2026-09-12',
          confidence: 0.9,
          primary_source: true,
        },
      ],
      search_queries: [QUESTION],
    });
    const stored = (submitted['claims'] ?? []) as { claimId: string }[];
    expect(stored.length).toBe(1);
    await call('brain_complete_work', {
      ...proof(researching),
      result_ref: String(submitted['recorded']),
      summary: 'claims submitted',
    });
    await advancePacket(one!.id);
    const verifying = await claimOf('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
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
      sufficiency: 'INSUFFICIENT',
      missing_lanes: ['official_statistics'],
      unresolved_gaps: [],
    });
    await call('brain_complete_work', { ...proof(verifying), result_ref: 'gated', summary: 'verified and gated' });
    expect(await requestsFor(goal.id)).toHaveLength(0);

    // Packet 1 ends, finished but not answered. Not COMPLETE_WITH_GAPS: that
    // status alone would settle the question, so this reaches the branch that
    // reads the packet's own requirements and coverage.
    await updateOrchestration(one!.id, { status: 'COMPLETE', completedAt: new Date().toISOString() });

    const second = await tick('journey');
    expect(second.researchGoals?.started).toHaveLength(1);
    expect(second.researchGoals?.started[0]!.packetKey).toBe('round-2');
    const packets = await packetsOf(goal.id);
    expect(packets.map((p) => p.goal_packet_key)).toEqual(['round-1', 'round-2']);

    const status = await goalBudgetStatus(goal.id);
    expect(status?.packets.used).toBe(2);
    expect(status?.fragments.committed).toBe(fragments.length);
    expect(await requestsFor(goal.id)).toHaveLength(0);
  });
});

describe('a ceiling stops the goal and asks a person once', () => {
  it('creates nothing, raises exactly one request across repeated ticks, and touches nothing earlier', async () => {
    const goal = await newGoal({ maxPackets: 1 });
    await advanceResearchGoals();
    const [one] = await packetsOf(goal.id);
    await updateOrchestration(one!.id, { status: 'COMPLETE_WITH_GAPS', completedAt: new Date().toISOString() });

    const orchestrations = await count('research_orchestrations');
    const runs = await count('research_runs');
    const fragments = await count('research_fragments');
    const claims = await claimCount();

    const a = await tick('journey');
    expect(a.researchGoals?.stopped).toEqual([{ goalId: goal.id, ceiling: 'PACKETS', asked: true }]);
    await tick('journey');
    await tick('journey');

    const requests = await requestsFor(goal.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe('OPEN');
    expect(requests[0]!.authority_needed).toMatch(/PACKETS/);

    expect(await count('research_orchestrations')).toBe(orchestrations);
    expect(await count('research_runs')).toBe(runs);
    expect(await count('research_fragments')).toBe(fragments);
    expect(await claimCount()).toBe(claims);
    expect((await packetsOf(goal.id)).map((p) => p.status)).toEqual(['COMPLETE_WITH_GAPS']);
  });

  async function archiveThatAnswers(): Promise<void> {
    await importFile({
      projectId: fixture.project.id,
      originalFilename: 'World Model v1.txt',
      contents: Buffer.from(ANSWERED),
      layerId: (await fixture.layerByName('World Model')).id,
      version: 'v1',
      documentType: 'FOUNDATION',
    });
    await whenExtractionIdle();
  }

  it('starts zero packets when the archive already answers the assignment', async () => {
    await archiveThatAnswers();
    // The project's claims have been inventoried, as any earlier reconcile does.
    await inventoryProject(fixture.project.id);
    const goal = await newGoal({ assignment: QUESTION });

    const report = await advanceResearchGoals();
    expect(report.skipped).toEqual([]);
    expect(report.answeredByArchive).toEqual([goal.id]);
    expect(await packetsOf(goal.id)).toHaveLength(0);
    expect((await goalBudgetStatus(goal.id))?.packets.used).toBe(0);
  });

  it('starts zero packets for an archive nobody has inventoried yet', async () => {
    await archiveThatAnswers();
    const goal = await newGoal({ assignment: QUESTION });
    const report = await advanceResearchGoals();
    expect(report.answeredByArchive).toEqual([goal.id]);
    expect(await packetsOf(goal.id)).toHaveLength(0);
  });
});

describe('one packet however the pass is repeated', () => {
  it('two concurrent passes create one packet', async () => {
    const goal = await newGoal();
    await Promise.all([advanceResearchGoals(), advanceResearchGoals()]);
    expect(await packetsOf(goal.id)).toHaveLength(1);
    expect((await goalBudgetStatus(goal.id))?.packets.used).toBe(1);
  });

  it('a pass after a restart between reservation and creation still creates exactly one', async () => {
    const goal = await newGoal();
    // The reservation a crashed pass would have left behind: held, no packet.
    const { reserveGoalPacket } = await import('../server/repos/russellAuthority.ts');
    const held = await reserveGoalPacket({ goalId: goal.id, packetKey: 'round-1', projectId: fixture.project.id });
    expect(held.ok).toBe(true);
    expect(await packetsOf(goal.id)).toHaveLength(0);

    await advanceResearchGoals();
    await advanceResearchGoals();
    expect(await packetsOf(goal.id)).toHaveLength(1);
    expect((await goalBudgetStatus(goal.id))?.packets.used).toBe(1);
  });
});
