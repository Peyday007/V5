/**
 * Recovering one synthesis that was submitted and could not be filed.
 *
 * The production shape: a worker submits, `fileResearchPacket` builds an object
 * key the bucket refuses, the throw lands inside `runIdempotent`'s transaction,
 * and the synthesis pass and report text roll back while the claims,
 * verifications and gate decisions written by earlier tools survive. The packet
 * stops at NEEDS_HUMAN holding real accepted research and no report.
 *
 * What is under test here is the **guards**, so the fixtures write the rows a
 * finished research phase leaves behind rather than driving the gate to produce
 * them. The gate has its own suites; this one is about what a recovery will and
 * will not do to a packet in each of the states production actually produced.
 *
 * Every refusal below was run against a neutered guard to watch it fail before
 * it was trusted to pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getOrchestration,
  insertClaims,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { cancelWork, enqueueWork, getWorkItem, listWorkItems } from '../server/repos/workQueue.ts';
import { createBin, getBin, listBins } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { storeFile } from '../server/services/storage.ts';
import { initStorage, resetStorage } from '../server/services/storage/index.ts';
import {
  assessProjectSyntheses,
  recoverFailedSynthesis,
} from '../server/services/research/synthesisRecovery.ts';

let projectId = '';
let layerId = '';
let layerName = '';
let fixture: Awaited<ReturnType<typeof freshProject>>;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  const layer = (await listLayers(projectId))[0]!;
  layerId = layer.id;
  layerName = layer.name;
});

afterEach(async () => {
  await teardown();
});

interface Stuck {
  orchestrationId: string;
  workItemId: string;
  binId: string;
}

/**
 * A packet in exactly the state the production failure leaves: one accepted
 * fragment with an accepted claim, a terminal synthesis item, no document, and
 * a bin parked for a person.
 */
async function stuckPacket(options: { claims?: number; binAttempts?: number } = {}): Promise<Stuck> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded discovery question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'Where the same deliverable has two published prices',
    assignment: 'the openings it would find',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      geography: 'United States',
      requiredEvidence: [{ id: 'published_price', description: 'a price', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the platform itself'],
      excludedSourceTypes: ['a blog about it'],
      completionCriteria: ['one dated price'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'prices',
      question: 'What does each platform publish?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const fragment = (await currentFragments(orchestration.id))[0]!;
  await updateFragment(fragment.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });

  const howMany = options.claims ?? 1;
  if (howMany > 0) {
    await insertClaims(
      Array.from({ length: howMany }, (_, index) => ({
        orchestrationId: orchestration.id,
        fragmentId: fragment.id,
        passId: null,
        passKey: 'TARGETED' as const,
        claim: `Platform ${index} publishes a price.`,
        sourceUrl: `https://example.invalid/${index}`,
        sourceTitle: 'Pricing',
        sourcePublisher: 'Example',
        sourceDate: '2026-09-01',
        evidenceExcerpt: 'the price',
        evidenceLocator: 'pricing page',
        evidenceLane: 'published_price',
        retrievedAt: '2026-09-01T00:00:00.000Z',
        confidence: 0.9,
        validationState: 'SOURCED' as const,
        validationDetail: null,
        sourced: true,
        accepted: true,
        scopeMatch: 'MATCH',

        primarySource: true,
        requirementIds: [],
        contentHash: `hash-${index}`,
      })),
    );
  }

  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_SYNTHESIZE',
    payload: { orchestrationId: orchestration.id },
    createdByType: 'SYSTEM',
    requiredScopes: ['queue:claim'],
    orchestrationId: orchestration.id,
  });
  // Terminal, having recorded nothing — the state an exhausted attempt leaves.
  await cancelWork(item.id, 'attempts exhausted');

  const bin = await createBin({
    projectId,
    layerId,
    orchestrationId: orchestration.id,
    kind: 'RESEARCH_PACKET',
    title: 'the packet',
    objective: 'File the report this packet already researched.',
    manifest: {
      objective: 'File the report this packet already researched.',
      why: 'the fire has to be for something',
      lineage: { projectId, layerId, goal: null, orchestrationId: orchestration.id },
      units: [],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 30 },
      stoppingConditions: ['filed'],
    },
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await getDb().run(
    `UPDATE bins SET state = 'NEEDS_HUMAN', terminal_reason = 'the packet stopped', attempt_count = ?
      WHERE id = ?`,
    [options.binAttempts ?? 1, bin.id],
  );

  await updateOrchestration(orchestration.id, {
    status: 'NEEDS_HUMAN',
    failureReason: 'A synthesis work item finished without recording anything.',
  });

  return { orchestrationId: orchestration.id, workItemId: item.id, binId: bin.id };
}

const ACTOR = { type: 'HUMAN' as const, id: 'usr_operator' };

describe('an eligible failed synthesis', () => {
  it('is reissued once, with the evidence and the original intact', async () => {
    const stuck = await stuckPacket({ claims: 3 });

    const outcome = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: ACTOR,
      reason: 'the filing path was repaired',
    });

    expect(outcome.ok, outcome.reason).toBe(true);
    expect(outcome.status).toBe('RECOVERED');
    expect(outcome.replacementWorkItemId).not.toBeNull();
    expect(outcome.reason).toContain('3 citable claim(s)');

    // The replacement is claimable, and it is the only live one.
    const items = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) => item.orchestrationId === stuck.orchestrationId,
    );
    const live = items.filter((item) => item.state === 'QUEUED' || item.state === 'LEASED');
    expect(live.map((item) => item.id)).toEqual([outcome.replacementWorkItemId]);

    // The original keeps its state and its history. It is the evidence for why
    // this happened, and a recovery that rewrote it would destroy that.
    const original = (await getWorkItem(stuck.workItemId))!;
    expect(original.state).toBe('CANCELLED');
    expect(original.attemptCount).toBe(0);

    // And the packet, bin and mission are back where the ordinary scheduler
    // can proceed — NEEDS_HUMAN on the packet would hand it straight to
    // `concludeAbandonedParks`.
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('SYNTHESIZING');
    expect((await getBin(stuck.binId))!.state).toBe('READY');
    expect(outcome.restored?.packet).toBe('SYNTHESIZING');
  });

  it('reports the same verdict the action would reach', async () => {
    const stuck = await stuckPacket();
    const rows = await assessProjectSyntheses(projectId);
    const row = rows.find((one) => one.workItemId === stuck.workItemId);
    expect(row?.eligible).toBe(true);
    expect(row?.citableClaims).toBe(1);
    expect(row?.documentId).toBeNull();
  });
});

describe('a second request for the same recovery', () => {
  it('returns the existing replacement rather than a second item', async () => {
    const stuck = await stuckPacket();
    const first = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: ACTOR,
      reason: 'first',
    });
    const second = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: { type: 'HUMAN', id: 'usr_someone_else' },
      reason: 'second',
    });

    expect(second.ok).toBe(true);
    expect(second.status).toBe('ALREADY_RECOVERED');
    expect(second.replacementWorkItemId).toBe(first.replacementWorkItemId);

    const synth = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) =>
        item.orchestrationId === stuck.orchestrationId && item.workType === 'RESEARCH_SYNTHESIZE',
    );
    expect(synth.length, 'a second replacement was created').toBe(2);
  });

  it('produces one item when two administrators press it at once', async () => {
    const stuck = await stuckPacket();
    const [a, b] = await Promise.all([
      recoverFailedSynthesis({ workItemId: stuck.workItemId, actor: ACTOR, reason: 'a' }),
      recoverFailedSynthesis({
        workItemId: stuck.workItemId,
        actor: { type: 'HUMAN', id: 'usr_two' },
        reason: 'b',
      }),
    ]);

    // Both are told something true, and only one item exists. Which of them
    // won is not a property worth asserting; how many items exist is.
    expect(a!.ok || b!.ok).toBe(true);
    const synth = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) =>
        item.orchestrationId === stuck.orchestrationId && item.workType === 'RESEARCH_SYNTHESIZE',
    );
    expect(synth.length).toBe(2);
  });
});

describe('a synthesis that must not be recovered', () => {
  it('refuses one that already filed a document', async () => {
    const stuck = await stuckPacket();
    // A real row, because the pointer carries a foreign key — and because the
    // condition being tested is "this packet has a report", not "this column is
    // non-null".
    const filed = await addDocument(fixture, layerName, 'v1', { withFile: true });
    await updateOrchestration(stuck.orchestrationId, { documentId: filed.id });

    const outcome = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: ACTOR,
      reason: 'should refuse',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('ALREADY_FILED');
  });

  it('refuses one that is still somebody\'s to finish', async () => {
    const stuck = await stuckPacket();
    const live = await enqueueWork({
      projectId,
      workType: 'RESEARCH_SYNTHESIZE',
      payload: { orchestrationId: stuck.orchestrationId },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: stuck.orchestrationId,
    });
    const outcome = await recoverFailedSynthesis({
      workItemId: live.id,
      actor: ACTOR,
      reason: 'should refuse',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('STILL_LIVE');
  });

  it('refuses a work type that is not a synthesis', async () => {
    const stuck = await stuckPacket();
    const other = await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      payload: { orchestrationId: stuck.orchestrationId, role: 'PRIMARY' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: stuck.orchestrationId,
    });
    await cancelWork(other.id, 'done');
    const outcome = await recoverFailedSynthesis({
      workItemId: other.id,
      actor: ACTOR,
      reason: 'should refuse',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('NOT_A_SYNTHESIS');
  });

  it('refuses when no claim cleared its gate', async () => {
    const stuck = await stuckPacket({ claims: 0 });
    const outcome = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: ACTOR,
      reason: 'should refuse',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('NO_CITABLE_EVIDENCE');
  });

  it('refuses when the bin has no dispatch attempts left', async () => {
    // The budget check that matters: a replacement item in a spent bin is work
    // nothing can ever be fired at, which is the deadlock this whole session
    // started with.
    const stuck = await stuckPacket({ binAttempts: 5 });
    const outcome = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: ACTOR,
      reason: 'should refuse',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('BIN_EXHAUSTED');
    expect(outcome.reason).toContain('Regrant its budget first');
  });
});

describe('an external filing the database cannot see', () => {
  /*
   * The case a rollback cannot rule out.
   *
   * The upload happens inside `runIdempotent`'s transaction, so there is a
   * window where the store accepted the bytes and the transaction then failed.
   * A recovery reasoning from the absent document row alone would file a second
   * copy under a second key, leaving two objects and one row — §20's rule that
   * a timeout is not evidence, at the boundary where the evidence is somebody
   * else's storage.
   */
  it('refuses when the store holds bytes no document row points at', async () => {
    const stuck = await stuckPacket();
    const layer = (await listLayers(projectId))[0]!;
    const project = fixture.project;

    // What an interrupted attempt would have left: the report, under the key
    // this packet's canonical name produces, with nothing pointing at it.
    await storeFile({
      projectSlug: project.slug,
      layerSlug: layer.slug,
      filename: `${layer.name} v1.md`,
      contents: Buffer.from('# a report an earlier attempt uploaded\n', 'utf8'),
    });

    const outcome = await recoverFailedSynthesis({
      workItemId: stuck.workItemId,
      actor: ACTOR,
      reason: 'should refuse',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('AMBIGUOUS_EXTERNAL_FILING');
    expect(outcome.reason).toContain('a person');

    // And nothing was created while it refused.
    const synth = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) =>
        item.orchestrationId === stuck.orchestrationId && item.workType === 'RESEARCH_SYNTHESIZE',
    );
    expect(synth.length).toBe(1);
  });

  it('refuses when the store cannot be read at all', async () => {
    // Unknown must never read as absent. A store that will not answer is a
    // refusal, not an empty result.
    const stuck = await stuckPacket();
    resetStorage();
    await initStorage({
      config: {
        provider: 'supabase',
        supabaseUrl: 'https://example.supabase.co',
        serviceRoleKey: 'service-role',
        bucket: 'brain',
      },
      fetchImpl: (async () => {
        throw new Error('the store is unreachable');
      }) as unknown as typeof fetch,
      verify: false,
    });

    try {
      const outcome = await recoverFailedSynthesis({
        workItemId: stuck.workItemId,
        actor: ACTOR,
        reason: 'should refuse',
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.refusal).toBe('STORE_UNREADABLE');
    } finally {
      resetStorage();
    }
  });
});
