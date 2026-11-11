/**
 * A synthesis its worker failed on a transient cause is replaced, bounded, and
 * a park says what the item recorded (§15, §20, §33).
 *
 * Production, seven days to 2026-11-11: two of the five recorded NEEDS_HUMAN
 * reasons were "A synthesis work item finished without recording anything, and
 * nothing was recorded about why." The synthesis item had been failed by its
 * worker as DEPENDENCY_UNAVAILABLE — a provider that could not answer — which
 * `mayReplace` did not count as spent, so the packet parked holding accepted
 * research; and `faultedOut` read only the orchestration's reason, so the park
 * said nothing was recorded while the item's own `result_summary` said why.
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
