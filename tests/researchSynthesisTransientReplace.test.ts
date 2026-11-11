/**
 * A synthesis that ended without filing a document is replaced, bounded, and
 * a park cites the item it stopped on (§15, §20, §33).
 *
 * Production, seven days to 2026-11-11: two of the five recorded NEEDS_HUMAN
 * reasons were "A synthesis work item finished without recording anything, and
 * nothing was recorded about why." No row for those two parks is cited here:
 * the reasons are verbatim, but the work items behind them were not read, so
 * which state they ended in is not known. That text is reached from every state
 * an earlier synthesis can end in while the packet still has no document —
 * FAILED on a transient cause (DEPENDENCY_UNAVAILABLE, WORKER_ERROR, UNKNOWN),
 * SUCCEEDED without filing anything, and CANCELLED with attempts left. The
 * first two are now replaced, bounded. The third still parks by design (only
 * an ended packet or a person cancels a current-round synthesis;
 * packetFaultDiagnosis.test.ts holds it), and is pinned below. The
 * post-release measurement of this park class is what confirms the cause.
 *
 * A replacement is still refused when an earlier item reached the filing
 * effect (that is `synthesisRecovery`'s, which asks the store first), and an
 * INVALID_INPUT failure still parks: the input will not change.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getOrchestration,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { listWorkItemsForOrchestration } from '../server/repos/workQueue.ts';
import { createRequirements } from '../server/repos/reconciliation.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  advancePacket,
  faultedOutReason,

  MAX_ITEMS_PER_TARGET,
} from '../server/services/research/packetRunner.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

/** One accepted fragment with an accepted claim, no document, no synthesis item yet. */
async function readyPacket(): Promise<string> {
  const layer = await fixture.layerByName('World Model');
  const run = await createRun({
    projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId: fixture.project.id, layerId: layer.id, runId: run.id, title: 'Where the same deliverable has two published prices',
    assignment: 'the openings it would find', provider: 'WORKER', autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: fixture.project.id, layerId: layer.id, geography: 'United States',
      requiredEvidence: [{ id: 'published_price', description: 'a price', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the platform itself'], excludedSourceTypes: ['a blog about it'], completionCriteria: ['one dated price'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'prices', question: 'What does each platform publish?',
      dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const fragment = (await currentFragments(orchestration.id))[0]!;
  await updateFragment(fragment.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
  await insertClaims(
    [0, 1].map((index) => ({
      orchestrationId: orchestration.id, fragmentId: fragment.id, passId: null, passKey: 'TARGETED' as const,
      claim: `Platform ${index} publishes a price.`, sourceUrl: `https://example.invalid/${index}`, sourceTitle: 'Pricing',
      sourcePublisher: `Example ${index}`, sourceDate: '2026-09-01', evidenceExcerpt: 'the price', evidenceLocator: 'pricing page',
      evidenceLane: 'published_price', retrievedAt: '2026-09-01T00:00:00.000Z', confidence: 0.9, validationState: 'SOURCED' as const,
      validationDetail: null, sourced: true, accepted: true, scopeMatch: 'MATCH', primarySource: true, requirementIds: [],
      contentHash: `hash-${index}`,
    })),
  );
  return orchestration.id;
}

const synthItems = async (id: string) =>
  (await listWorkItemsForOrchestration(id)).filter((item) => item.workType === 'RESEARCH_SYNTHESIZE');

/** Fail every queued synthesis item the way a worker's not-retryable failure leaves it. */
async function failQueuedSynthesis(id: string, category: string, detail: string): Promise<void> {
  for (const item of await synthItems(id)) {
    if (item.state !== 'QUEUED' && item.state !== 'LEASED') continue;
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = ?, result_summary = ?, attempt_count = 1,
              completed_at = ?, updated_at = ? WHERE id = ?`,
      [category, detail, new Date().toISOString(), new Date(Date.now() + 1000 * item.attemptCount).toISOString(), item.id],
    );
  }
}

/** A packet whose only synthesis item failed with `category`, created by the runner itself. */
async function packetWithFailedSynthesis(category: string, detail: string): Promise<string> {
  const id = await readyPacket();
  const first = await advancePacket(id);
  expect(first.enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
  await failQueuedSynthesis(id, category, detail);
  return id;
}

describe('a synthesis failed on a transient cause', () => {
  it('is replaced instead of parking the packet (the recorded PACKETS:NEEDS_HUMAN class)', async () => {
    const id = await packetWithFailedSynthesis('DEPENDENCY_UNAVAILABLE', 'The model provider returned 529 overloaded.');
    const result = await advancePacket(id);
    expect(result.status).not.toBe('NEEDS_HUMAN');
    expect(result.enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
    expect((await getOrchestration(id))!.status).not.toBe('NEEDS_HUMAN');
    expect((await getOrchestration(id))!.failureReason ?? '').not.toContain('nothing was recorded about why');
  });

  it('replaces WORKER_ERROR and UNKNOWN the same way', async () => {
    for (const category of ['WORKER_ERROR', 'UNKNOWN']) {
      const id = await packetWithFailedSynthesis(category, `the worker crashed (${category})`);
      const result = await advancePacket(id);
      expect(result.enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
    }
  });

  it('parks after MAX_ITEMS_PER_TARGET, carrying the last item\'s own reason', async () => {
    const id = await packetWithFailedSynthesis('DEPENDENCY_UNAVAILABLE', 'provider outage 1');
    for (let n = 2; n <= MAX_ITEMS_PER_TARGET; n += 1) {
      const result = await advancePacket(id);
      expect(result.enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
      await failQueuedSynthesis(id, 'DEPENDENCY_UNAVAILABLE', `provider outage ${n}`);
    }
    expect(await synthItems(id)).toHaveLength(MAX_ITEMS_PER_TARGET);
    const parked = await advancePacket(id);
    expect(parked.status).toBe('NEEDS_HUMAN');
    expect(parked.enqueued).toEqual([]);
    const reason = (await getOrchestration(id))!.failureReason!;
    expect(reason).not.toBe(faultedOutReason('synthesis'));
    expect(reason).toContain('RESEARCH_SYNTHESIZE');
    expect(reason).toContain(`provider outage ${MAX_ITEMS_PER_TARGET}`);
  });

  it('is not replaced when an earlier item reached the filing effect: that is synthesisRecovery\'s', async () => {
    const id = await packetWithFailedSynthesis('DEPENDENCY_UNAVAILABLE', 'the store refused the key');
    const item = (await synthItems(id))[0]!;
    const now = new Date().toISOString();
    const op = newId('idop');
    // The row a filing that reached the store leaves, in synthesisRecovery.test.ts's shape.
    await getDb().run(
      `INSERT INTO idempotency_operations
         (id, scope_hash, key_fingerprint, namespace, namespace_version, project_id,
          created_by_type, work_item_id, request_fingerprint, state, attempt_count,
          failure_category, reserved_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'research.synthesis', 1, ?, 'WORKER', ?, 'fp', 'FAILED', 1,
               'INTERNAL_ERROR', ?, ?, ?, ?)`,
      [op, `scope-${op}`, `key-${op}`, fixture.project.id, item.id, now, now, now, now],
    );
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect(result.enqueued).toEqual([]);
    expect(await synthItems(id)).toHaveLength(1);
  });

  it('still parks on INVALID_INPUT, and the park names the item\'s reason', async () => {
    const id = await packetWithFailedSynthesis('INVALID_INPUT', 'the packet text is malformed');
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect(result.enqueued).toEqual([]);
    expect((await getOrchestration(id))!.failureReason).toContain('the packet text is malformed');
  });
});

/*
 * The recorded class "The packet does not cover the goal's mandatory part, so
 * it was not synthesized." For a research goal's round with no mission, that
 * park reached nobody and, being live to `goalContinuation`, held the goal's
 * next round. It now ends FAILED, the same rule a round where no fragment
 * cleared its gate already follows; invariant 20 is untouched (nothing is
 * synthesized), the gap is still recorded, and a round behind a mission, or
 * outside any goal, still parks for its person.
 */
describe('a packet that does not cover the goal\'s mandatory part', () => {
  async function withOpenMandatoryRequirement(id: string): Promise<void> {
    const orchestration = (await getOrchestration(id))!;
    await createRequirements([
      {
        orchestrationId: id, projectId: orchestration.projectId, layerId: orchestration.layerId, requirementKey: 'heartbeat-mechanisms',
        ordinal: 0, statement: 'Which documented mechanisms detect that a unit of work holding a worker slot has gone silent',
        necessity: 'MANDATORY', kind: 'RESEARCH',
      },
    ]);
  }
  async function asGoalRound(id: string): Promise<string> {
    const layer = await fixture.layerByName('World Model');
    const user = await createUser({ email: `gr-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    const goal = await createResearchGoal({
      projectId: fixture.project.id, ownerUserId: user.id, createdByUserId: user.id, name: 'Worker liveness',
      maxPackets: 2, maxFragments: 10, deadline: new Date(Date.now() + 7_200_000).toISOString(),
      researchAssignment: 'How do work queues detect a dead worker?', researchLayerId: layer.id,
    });
    await getDb().run('UPDATE research_orchestrations SET goal_id = ?, goal_packet_key = ? WHERE id = ?', [goal.id, 'round-1', id]);
    return goal.id;
  }
  const gapEvents = async (id: string) =>
    (await getDb().all<{ payload: string }>(`SELECT payload FROM project_events WHERE event_type = 'RESEARCH_COVERAGE_GAP'`, []))
      .filter((row) => row.payload.includes(id));

  it('ends a goal round with no mission FAILED instead of parking it with nobody to ask, and still records the gap', async () => {
    const id = await readyPacket();
    await withOpenMandatoryRequirement(id);
    await asGoalRound(id);
    const result = await advancePacket(id);
    expect(result.status).toBe('FAILED');
    expect(result.enqueued).toEqual([]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toMatch(/^The packet does not cover the goal's mandatory part, so it was not synthesized\./);
    expect(after.failureReason).toContain('may start its next round');
    expect(await synthItems(id)).toHaveLength(0);
    expect(await gapEvents(id)).toHaveLength(1);
  });

  it('still parks for a person when the packet is not a goal round', async () => {
    const id = await readyPacket();
    await withOpenMandatoryRequirement(id);
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect((await getOrchestration(id))!.failureReason).not.toContain('may start its next round');
    expect(await synthItems(id)).toHaveLength(0);
  });

  it('still parks for a person when a mission stands behind the goal round', async () => {
    const id = await readyPacket();
    await withOpenMandatoryRequirement(id);
    await asGoalRound(id);
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO russell_missions (id, project_id, objective, why_now, state, orchestration_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'cover the gap', 'asked by the owner', 'RUNNING', ?, ?, ?, ?)`,
      [newId('rms'), fixture.project.id, id, newId('key'), now, now],
    );
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect(await synthItems(id)).toHaveLength(0);
  });
});

/** End every live synthesis item in `state`, as a worker or a sweep would leave it. */
async function endQueuedSynthesis(id: string, state: 'SUCCEEDED' | 'CANCELLED', summary: string | null): Promise<void> {
  for (const item of await synthItems(id)) {
    if (item.state !== 'QUEUED' && item.state !== 'LEASED') continue;
    await getDb().run(
      `UPDATE work_items SET state = ?, failure_category = NULL, result_summary = ?, attempt_count = 1,
              completed_at = ?, updated_at = ? WHERE id = ?`,
      [state, summary, new Date().toISOString(), new Date(Date.now() + 1000).toISOString(), item.id],
    );
  }
}

describe('the other states that produced "finished without recording anything"', () => {
  it('replaces a synthesis that SUCCEEDED without filing a document', async () => {
    const id = await readyPacket();
    expect((await advancePacket(id)).enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
    await endQueuedSynthesis(id, 'SUCCEEDED', null);
    expect((await getOrchestration(id))!.documentId).toBeNull();
    const result = await advancePacket(id);
    expect(result.status).not.toBe('NEEDS_HUMAN');
    expect(result.enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
    expect(await synthItems(id)).toHaveLength(2);
  });

  it('still parks a synthesis CANCELLED with attempts left: a cancellation is a decision, not a fault to retry', async () => {
    const id = await readyPacket();
    await advancePacket(id);
    const item = (await synthItems(id))[0]!;
    expect(item.maxAttempts).toBeGreaterThan(1);
    await endQueuedSynthesis(id, 'CANCELLED', 'cancelled by an operator');
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect(result.enqueued).toEqual([]);
    expect(await synthItems(id)).toHaveLength(1);
  });

  it('parks after MAX_ITEMS_PER_TARGET no-op successes, citing the item by id instead of "nothing was recorded"', async () => {
    const id = await readyPacket();
    await advancePacket(id);
    await endQueuedSynthesis(id, 'SUCCEEDED', null);
    for (let n = 2; n <= MAX_ITEMS_PER_TARGET; n += 1) {
      expect((await advancePacket(id)).enqueued.map((e) => e.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
      await endQueuedSynthesis(id, 'SUCCEEDED', null);
    }
    const items = await synthItems(id);
    expect(items).toHaveLength(MAX_ITEMS_PER_TARGET);
    const parked = await advancePacket(id);
    expect(parked.status).toBe('NEEDS_HUMAN');
    const reason = (await getOrchestration(id))!.failureReason!;
    expect(reason).not.toBe(faultedOutReason('synthesis'));
    expect(reason).not.toContain('nothing was recorded about why');
    expect(reason).toContain('SUCCEEDED');
    expect(items.some((item) => reason.includes(item.id))).toBe(true);
  });

  it('still refuses a no-op success whose filing reached the store', async () => {
    const id = await readyPacket();
    await advancePacket(id);
    await endQueuedSynthesis(id, 'SUCCEEDED', null);
    const item = (await synthItems(id))[0]!;
    const now = new Date().toISOString();
    const op = newId('idop');
    await getDb().run(
      `INSERT INTO idempotency_operations
         (id, scope_hash, key_fingerprint, namespace, namespace_version, project_id,
          created_by_type, work_item_id, request_fingerprint, state, attempt_count,
          failure_category, reserved_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'research.synthesis', 1, ?, 'WORKER', ?, 'fp', 'FAILED', 1,
               'INTERNAL_ERROR', ?, ?, ?, ?)`,
      [op, `scope-${op}`, `key-${op}`, fixture.project.id, item.id, now, now, now, now],
    );
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect(result.enqueued).toEqual([]);
    expect(await synthItems(id)).toHaveLength(1);
  });
});
