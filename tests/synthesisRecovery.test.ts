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
  finishPass,
  getOrchestration,
  insertClaims,
  startPass,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { cancelWork, enqueueWork, getWorkItem, listWorkItems } from '../server/repos/workQueue.ts';
import { createBin, getBin, listBins } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { createCredentiallessUser } from '../server/repos/identity.ts';
import {
  answerHumanRequest,
  askHuman,
  getHumanRequest,
  getMission,
  launchMission,
  linkMission,
  reopenWithdrawnRequest,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { storeFile } from '../server/services/storage.ts';
import { initStorage, resetStorage } from '../server/services/storage/index.ts';
import { recordEvent } from '../server/repos/events.ts';
import {
  assessProjectSyntheses,
  assessSynthesisRecovery,
  FILING_RECOVERY_ACTOR,
  FILING_REGRANT_REASON,
  recoverFailedSynthesis,
  recoverFilingFailures,
  SPENT_RECOVERY_ACTOR,
  SPENT_REGRANT_REASON,
  MAX_SPENT_RECOVERIES_PER_ROUND,
  resetFilingRecoveryThrottle,
  surfaceNamedBy,
  synthesisSurfacesToAvoid,
} from '../server/services/research/synthesisRecovery.ts';

let projectId = '';
let layerId = '';
let layerName = '';
let fixture: Awaited<ReturnType<typeof freshProject>>;

beforeEach(async () => {
  resetFilingRecoveryThrottle();
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

/**
 * Write the ledger a filing refusal leaves: one `research.synthesis` operation
 * on the failed item, and an attempt row carrying Brain's own words for what
 * the store said. That row is what the automatic recovery selects on.
 */
async function ledger(workItemId: string, detail: string): Promise<void> {
  const now = new Date().toISOString();
  const op = `idop_${Math.random().toString(16).slice(2)}`;
  await getDb().run(
    `INSERT INTO idempotency_operations
       (id, scope_hash, key_fingerprint, namespace, namespace_version, project_id,
        created_by_type, work_item_id, request_fingerprint, state, attempt_count,
        failure_category, reserved_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'research.synthesis', 1, ?, 'WORKER', ?, 'fp', 'FAILED', 1,
             'INTERNAL_ERROR', ?, ?, ?, ?)`,
    [op, `scope-${op}`, `key-${op}`, projectId, workItemId, now, now, now, now],
  );
  await getDb().run(
    `INSERT INTO effect_attempts
       (id, operation_id, attempt_number, executor_type, work_item_id, phase, started_at,
        ended_at, outcome, detail)
     VALUES (?, ?, 1, 'WORKER', ?, 'FAILED', ?, ?, 'FAILED', ?)`,
    [`att_${op}`, op, workItemId, now, now, detail],
  );
}

describe('the automatic recovery of a synthesis Brain could not file', () => {
  const STORE_REFUSED = 'The document store refused an upload (HTTP 400). · InvalidKey';

  it('reissues it without a person, leaving the research and the original intact', async () => {
    const stuck = await stuckPacket({ claims: 2 });
    await ledger(stuck.workItemId, STORE_REFUSED);

    const out = await recoverFilingFailures(10, { force: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workItemId: stuck.workItemId, outcome: 'RECOVERED', regranted: null });

    const items = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) => item.orchestrationId === stuck.orchestrationId,
    );
    const live = items.filter((item) => item.state === 'QUEUED');
    expect(live).toHaveLength(1);
    expect(live[0]!.createdByType).toBe('SYSTEM');
    expect(live[0]!.createdById).toBe(FILING_RECOVERY_ACTOR);
    // Nothing was re-researched: the only new item is the synthesis.
    expect(items.filter((item) => item.workType !== 'RESEARCH_SYNTHESIZE')).toHaveLength(0);
    expect((await getWorkItem(stuck.workItemId))!.state).toBe('CANCELLED');
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('SYNTHESIZING');
    expect((await getBin(stuck.binId))!.state).toBe('READY');

    // Never twice: a second pass finds the live replacement and does nothing.
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
  });

  it('regrants a bin whose budget the refused filings spent, once, and records why', async () => {
    const stuck = await stuckPacket({ binAttempts: 3 });
    await ledger(stuck.workItemId, STORE_REFUSED);

    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ regranted: stuck.binId, outcome: 'RECOVERED' });
    const bin = (await getBin(stuck.binId))!;
    expect(bin.attemptCount).toBe(3); // the history of spent attempts is kept
    expect(bin.maxAttempts).toBe(7);
    expect(bin.state).toBe('READY');
    const events = await getDb().all<{ reason: string }>(
      `SELECT reason FROM bin_events WHERE bin_id = ? AND event_type = 'BIN_ATTEMPTS_REGRANTED'`,
      [stuck.binId],
    );
    expect(events.map((event) => event.reason)).toEqual([FILING_REGRANT_REASON]);
  });

  it('does not loop when the replacement is refused by the store as well', async () => {
    const stuck = await stuckPacket();
    await ledger(stuck.workItemId, STORE_REFUSED);
    const first = await recoverFilingFailures(10, { force: true });
    const replacement = (await listWorkItems(projectId, { limit: 50 })).find(
      (item) => item.orchestrationId === stuck.orchestrationId && item.state === 'QUEUED',
    )!;
    expect(first[0]!.outcome).toBe('RECOVERED');

    // The replacement fails the same way. The defect is not historical now,
    // and a person should look: nothing is reissued a second time.
    await cancelWork(replacement.id, 'refused again');
    await ledger(replacement.id, STORE_REFUSED);
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
  });

  it('leaves alone a synthesis whose failure was not Brain\'s filing', async () => {
    const stuck = await stuckPacket();
    await ledger(stuck.workItemId, 'The report cites claim clm_x, which is not citable in this packet.');
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
    // And one with no ledger at all — a worker that never submitted.
    await stuckPacket();
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
  });

  it('reissues, once, a synthesis whose attempts the queue spent, and leaves a second failure to a person (F7)', async () => {
    const stuck = await stuckPacket({ claims: 2 });
    // The production shape: FAILED, ATTEMPTS_EXHAUSTED, no filing refusal in its ledger.
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
              attempt_count = 2, max_attempts = 2 WHERE id = ?`,
      [stuck.workItemId],
    );

    const out = await recoverFilingFailures(10, { force: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workItemId: stuck.workItemId, outcome: 'RECOVERED', regranted: null });
    const items = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) => item.orchestrationId === stuck.orchestrationId,
    );
    const replacement = items.find((item) => item.state === 'QUEUED')!;
    expect(replacement.createdById).toBe(SPENT_RECOVERY_ACTOR);
    // Lineage: the spent item keeps its state and its attempts.
    expect((await getWorkItem(stuck.workItemId))!).toMatchObject({ state: 'FAILED', attemptCount: 2 });
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('SYNTHESIZING');

    // The replacement spends its attempts too: nothing is reissued a second time.
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
              attempt_count = max_attempts WHERE id = ?`,
      [replacement.id],
    );
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
  });

  it('reroutes a synthesis spent on one surface to another, bounded per round, never back to a surface that failed it', async () => {
    // Production, orc_c40cc84d8e944531a8d9: the synthesis spent its attempts on the
    // lane's one GPU model, the single reissue went to the same model, and the
    // packet sat NEEDS_HUMAN for eight days.
    const spentOn = (model: string) =>
      `free lane (${model}) produced no answer Brain accepted for this RESEARCH_SYNTHESIZE`;
    const spend = async (id: string, model: string) => {
      await getDb().run(
        `UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
                attempt_count = max_attempts, result_summary = ? WHERE id = ?`,
        [spentOn(model), id],
      );
    };
    const live = async (orchestrationId: string) =>
      (await listWorkItems(projectId, { limit: 50 })).find(
        (item) => item.orchestrationId === orchestrationId && item.state === 'QUEUED',
      );
    const row = async (id: string) =>
      (await getDb().get<{ work_type: string; created_by_id: string | null; orchestration_id: string | null }>(
        'SELECT work_type, created_by_id, orchestration_id FROM work_items WHERE id = ?',
        [id],
      ))!;

    const stuck = await stuckPacket({ claims: 2 });
    await spend(stuck.workItemId, 'runpod/openai/gpt-oss-120b');
    expect(surfaceNamedBy(spentOn('runpod/openai/gpt-oss-120b'))).toBe('runpod/openai/gpt-oss-120b');

    // First reissue: the free lane must not hand it back to the model that spent it.
    expect((await recoverFilingFailures(10, { force: true }))[0]).toMatchObject({ outcome: 'RECOVERED' });
    const first = (await live(stuck.orchestrationId))!;
    expect(first.createdById).toBe(SPENT_RECOVERY_ACTOR);
    expect([...(await synthesisSurfacesToAvoid(await row(first.id)))]).toEqual(['runpod/openai/gpt-oss-120b']);

    // It failed on the other model too: reissued again, avoiding both — not left for a person.
    await spend(first.id, 'auto/best-coding');
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    expect((await recoverFilingFailures(10, { force: true }))[0]).toMatchObject({ outcome: 'RECOVERED' });
    const second = (await live(stuck.orchestrationId))!;
    expect(new Set(await synthesisSurfacesToAvoid(await row(second.id)))).toEqual(
      new Set(['runpod/openai/gpt-oss-120b', 'auto/best-coding']),
    );
    // An ordinary synthesis item is never steered.
    expect((await synthesisSurfacesToAvoid({ ...(await row(second.id)), created_by_id: 'runner' })).size).toBe(0);

    // Bounded: the third reissue is the last one this round.
    await spend(second.id, 'runpod/other-model');
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    expect((await recoverFilingFailures(10, { force: true }))[0]).toMatchObject({ outcome: 'RECOVERED' });
    const third = (await live(stuck.orchestrationId))!;
    await spend(third.id, 'runpod/a-fourth-model');
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    expect(MAX_SPENT_RECOVERIES_PER_ROUND).toBe(3);
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
    expect(await live(stuck.orchestrationId)).toBeUndefined();
    // Every spent item keeps its row and its attempts (§5).
    for (const id of [stuck.workItemId, first.id, second.id, third.id]) {
      expect((await getWorkItem(id))!).toMatchObject({ state: 'FAILED', failureCategory: 'ATTEMPTS_EXHAUSTED' });
    }
  });

  it('reads the current round: a judge-resumed packet whose new synthesis ran out is reissued over the earlier report (W10)', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const stuck = await stuckPacket({ claims: 3 });
    const before = await getOrchestration(stuck.orchestrationId);
    // Round one: its synthesis succeeded, its pass completed, its filing operation succeeded.
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED' WHERE id = ?`, [stuck.workItemId]);
    const pass = await startPass({
      orchestrationId: stuck.orchestrationId,
      passKey: 'SYNTHESIS',
      ordinal: 4,
      provider: 'WORKER',
      prompt: 'synthesize',
      promptSha256: 'sha',
    } as Parameters<typeof startPass>[0]);
    await finishPass(pass.id, { status: 'COMPLETE' } as Parameters<typeof finishPass>[1]);
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO idempotency_operations
         (id, scope_hash, key_fingerprint, namespace, namespace_version, project_id,
          created_by_type, work_item_id, request_fingerprint, state, attempt_count,
          reserved_at, completed_at, created_at, updated_at)
       VALUES ('idop_round_one', 'scope-r1', 'key-r1', 'research.synthesis', 1, ?, 'WORKER', ?, 'fp',
               'SUCCEEDED', 1, ?, ?, ?, ?)`,
      [projectId, stuck.workItemId, now, now, now, now],
    );
    // The judge's corrected round began: document_id cleared, the history kept.
    await tick();
    await recordEvent({
      projectId,
      layerId,
      entityType: 'RUN',
      entityId: before!.runId,
      eventType: 'RESEARCH_ROUND_RESUMED',
      payload: { orchestrationId: stuck.orchestrationId, roundStartedAt: new Date().toISOString() },
    });
    await tick();
    // Round two's synthesis ran out of attempts.
    const second = await enqueueWork({
      projectId,
      workType: 'RESEARCH_SYNTHESIZE',
      payload: { orchestrationId: stuck.orchestrationId },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: stuck.orchestrationId,
    });
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
              attempt_count = 2, max_attempts = 2 WHERE id = ?`,
      [second.id],
    );

    // The earlier round's item is not the one to reissue.
    const earlier = await assessSynthesisRecovery(stuck.workItemId);
    expect(earlier.eligible).toBe(false);
    expect(!earlier.eligible && earlier.outcome.refusal).toBe('EARLIER_ROUND');

    const out = await recoverFilingFailures(10, { force: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workItemId: second.id, outcome: 'RECOVERED' });
    const replacement = (await listWorkItems(projectId, { limit: 50 })).find(
      (item) => item.orchestrationId === stuck.orchestrationId && item.state === 'QUEUED',
    )!;
    expect(replacement.createdById).toBe(SPENT_RECOVERY_ACTOR);
    // §5: round one's item and the spent round-two item are kept as they were.
    expect((await getWorkItem(stuck.workItemId))!.state).toBe('SUCCEEDED');
    expect((await getWorkItem(second.id))!).toMatchObject({ state: 'FAILED', attemptCount: 2 });
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('SYNTHESIZING');
  });

  /** Spend a synthesis item's attempts the way the queue does. */
  async function spend(workItemId: string): Promise<void> {
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
              attempt_count = 2, max_attempts = 2 WHERE id = ?`,
      [workItemId],
    );
  }

  /** A judge opens a new round on the packet, and that round's synthesis runs out of attempts. */
  async function newRoundSpent(stuck: Stuck): Promise<string> {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const packet = (await getOrchestration(stuck.orchestrationId))!;
    await tick();
    await recordEvent({
      projectId,
      layerId,
      entityType: 'RUN',
      entityId: packet.runId,
      eventType: 'RESEARCH_ROUND_RESUMED',
      payload: { orchestrationId: stuck.orchestrationId, roundStartedAt: new Date().toISOString() },
    });
    await tick();
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_SYNTHESIZE',
      payload: { orchestrationId: stuck.orchestrationId },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: stuck.orchestrationId,
    });
    await spend(item.id);
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    return item.id;
  }

  const queuedFor = async (orchestrationId: string) =>
    (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) => item.orchestrationId === orchestrationId && item.state === 'QUEUED',
    );

  it('recovers once per round: a packet recovered in round one is swept again when a judge opens round two (W10b)', async () => {
    const stuck = await stuckPacket({ claims: 2 });
    await spend(stuck.workItemId);

    // Round one: one automatic recovery, whose replacement then runs out as well.
    expect((await recoverFilingFailures(10, { force: true }))[0]).toMatchObject({ outcome: 'RECOVERED' });
    const roundOne = (await queuedFor(stuck.orchestrationId))[0]!;
    await spend(roundOne.id);
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    // The bound holds inside the round: a person's now, not a second reissue.
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
    expect(await queuedFor(stuck.orchestrationId)).toHaveLength(0);

    // The judge's round two is new research, and its own synthesis ran out.
    const roundTwo = await newRoundSpent(stuck);
    const out = await recoverFilingFailures(10, { force: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workItemId: roundTwo, outcome: 'RECOVERED' });
    const replacement = (await queuedFor(stuck.orchestrationId))[0]!;
    expect(replacement.createdById).toBe(SPENT_RECOVERY_ACTOR);
    // §5: every earlier item is kept exactly as it ended.
    expect((await getWorkItem(stuck.workItemId))!).toMatchObject({ state: 'FAILED', attemptCount: 2 });
    expect((await getWorkItem(roundOne.id))!).toMatchObject({ state: 'FAILED', createdById: SPENT_RECOVERY_ACTOR });
    expect((await getWorkItem(roundTwo))!).toMatchObject({ state: 'FAILED', attemptCount: 2 });

    // And round two is bounded the same way.
    await spend(replacement.id);
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
  });

  it('gives a spent synthesis an attempt in its exhausted bin, once per round, and records why (W10b)', async () => {
    const stuck = await stuckPacket({ claims: 2, binAttempts: 3 });
    await spend(stuck.workItemId);

    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'RECOVERED', regranted: stuck.binId });
    const bin = (await getBin(stuck.binId))!;
    expect(bin.attemptCount).toBe(3); // the spent attempts stay counted
    expect(bin.maxAttempts).toBe(7);
    expect(bin.state).toBe('READY');
    const reasons = async () =>
      (
        await getDb().all<{ reason: string }>(
          `SELECT reason FROM bin_events WHERE bin_id = ? AND event_type = 'BIN_ATTEMPTS_REGRANTED' ORDER BY at`,
          [stuck.binId],
        )
      ).map((event) => event.reason);
    expect(await reasons()).toEqual([SPENT_REGRANT_REASON]);

    // The replacement spends the bin again. Inside the round nothing more is given.
    const replacement = (await queuedFor(stuck.orchestrationId))[0]!;
    await spend(replacement.id);
    await getDb().run(`UPDATE bins SET attempt_count = max_attempts, state = 'NEEDS_HUMAN' WHERE id = ?`, [stuck.binId]);
    await updateOrchestration(stuck.orchestrationId, { status: 'NEEDS_HUMAN' });
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
    expect((await getBin(stuck.binId))!.maxAttempts).toBe(7);

    // A judge's new round earns its one recovery, and the attempt it needs to run.
    await newRoundSpent(stuck);
    expect((await recoverFilingFailures(10, { force: true }))[0]).toMatchObject({ outcome: 'RECOVERED', regranted: stuck.binId });
    expect((await getBin(stuck.binId))!).toMatchObject({ attemptCount: 7, maxAttempts: 11, state: 'READY' });
    expect(await reasons()).toEqual([SPENT_REGRANT_REASON, SPENT_REGRANT_REASON]);
  });

  it('does not regrant a spent synthesis\'s bin when anything else refuses the recovery', async () => {
    const stuck = await stuckPacket({ claims: 0, binAttempts: 3 });
    await spend(stuck.workItemId);
    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'REFUSED', refusal: 'NO_CITABLE_EVIDENCE', regranted: null });
    expect((await getBin(stuck.binId))!.maxAttempts).toBe(3);
  });

  it('leaves a spent synthesis\'s exhausted bin alone when a person has answered its card', async () => {
    const stuck = await stuckPacket({ binAttempts: 3 });
    await spend(stuck.workItemId);
    const { requestId } = await parkedWithCard(stuck);
    const person = await createCredentiallessUser({ email: null, displayName: 'Answerer', createdByType: 'SYSTEM', createdById: 'test' });
    await answerHumanRequest({ requestId, actorUserId: person.id, choice: 'STOP' });
    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'REFUSED', refusal: 'PERSON_HAS_ANSWERED' });
    expect((await getBin(stuck.binId))!.maxAttempts).toBe(3);
  });

  it('still refuses a synthesis recorded in the current round', async () => {
    const stuck = await stuckPacket();
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED',
              attempt_count = 2, max_attempts = 2 WHERE id = ?`,
      [stuck.workItemId],
    );
    const pass = await startPass({
      orchestrationId: stuck.orchestrationId,
      passKey: 'SYNTHESIS',
      ordinal: 4,
      provider: 'WORKER',
      prompt: 'synthesize',
      promptSha256: 'sha',
    } as Parameters<typeof startPass>[0]);
    await finishPass(pass.id, { status: 'COMPLETE' } as Parameters<typeof finishPass>[1]);
    const assessed = await assessSynthesisRecovery(stuck.workItemId);
    expect(!assessed.eligible && assessed.outcome.refusal).toBe('SYNTHESIS_RECORDED');
  });

  it('does not reissue a synthesis its worker failed as invalid input', async () => {
    const stuck = await stuckPacket();
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = 'INVALID_INPUT',
              attempt_count = 1, max_attempts = 2 WHERE id = ?`,
      [stuck.workItemId],
    );
    expect(await recoverFilingFailures(10, { force: true })).toEqual([]);
  });

  it('still refuses what the targeted recovery refuses', async () => {
    const stuck = await stuckPacket({ claims: 0 });
    await ledger(stuck.workItemId, STORE_REFUSED);
    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'REFUSED', refusal: 'NO_CITABLE_EVIDENCE' });
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('NEEDS_HUMAN');
  });

  it('never undoes a person\'s STOP: a cancelled mission stays cancelled', async () => {
    const stuck = await stuckPacket();
    await ledger(stuck.workItemId, STORE_REFUSED);
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'a bounded question',
      whyNow: 'test',
      idempotencyKey: `stop-${stuck.orchestrationId}`,
    });
    await linkMission({ missionId: mission.id, orchestrationId: stuck.orchestrationId });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'CANCELLED', terminalReason: 'STOP' });

    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'REFUSED', refusal: 'MISSION_ENDED_BY_DECISION' });
    expect((await getMission(mission.id))!.state).toBe('CANCELLED');
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('NEEDS_HUMAN');
    const live = (await listWorkItems(projectId, { limit: 50 })).filter(
      (item) => item.orchestrationId === stuck.orchestrationId && item.state === 'QUEUED',
    );
    expect(live).toHaveLength(0);
  });

  async function parkedWithCard(stuck: Stuck): Promise<{ missionId: string; requestId: string }> {
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'a bounded question',
      whyNow: 'test',
      idempotencyKey: `park-${stuck.orchestrationId}`,
    });
    await linkMission({ missionId: mission.id, orchestrationId: stuck.orchestrationId });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'NEEDS_HUMAN', waitingOn: 'the filing failed' });
    const { request } = await askHuman({
      projectId,
      missionId: mission.id,
      authorityNeeded: 'whether to continue',
      whyNotRussell: 'the packet stopped',
      choices: [
        { key: 'RECORD_GAPS', label: 'Record', consequence: 'files short' },
        { key: 'STOP', label: 'Stop', consequence: 'stops' },
      ],
      resumeKey: `russell:needs-human:${mission.id}:${stuck.orchestrationId}`,
    });
    return { missionId: mission.id, requestId: request.id };
  }

  it('withdraws the open card about the park before it reissues, so a later STOP cannot strand a running packet', async () => {
    const stuck = await stuckPacket();
    await ledger(stuck.workItemId, STORE_REFUSED);
    const { missionId, requestId } = await parkedWithCard(stuck);

    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'RECOVERED' });
    expect((await getHumanRequest(requestId))!.state).toBe('WITHDRAWN');
    expect((await getMission(missionId))!.state).toBe('RUNNING');
  });

  it('leaves a packet alone when a person has already answered its card, its bin included', async () => {
    const stuck = await stuckPacket({ binAttempts: 3 });
    await ledger(stuck.workItemId, STORE_REFUSED);
    const { missionId, requestId } = await parkedWithCard(stuck);
    const person = await createCredentiallessUser({ email: null, displayName: 'Answerer', createdByType: 'SYSTEM', createdById: 'test' });
    await answerHumanRequest({ requestId, actorUserId: person.id, choice: 'STOP' });

    const out = await recoverFilingFailures(10, { force: true });
    expect(out[0]).toMatchObject({ outcome: 'REFUSED', refusal: 'PERSON_HAS_ANSWERED' });
    expect((await getHumanRequest(requestId))!.state).toBe('ANSWERED');
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');
    expect((await getOrchestration(stuck.orchestrationId))!.status).toBe('NEEDS_HUMAN');
    expect((await getBin(stuck.binId))!.maxAttempts).toBe(3);
  });

  it('asks a withdrawn question again when the same stop comes back, and never reaches an answered one', async () => {
    const stuck = await stuckPacket();
    await ledger(stuck.workItemId, STORE_REFUSED);
    const { requestId } = await parkedWithCard(stuck);
    await recoverFilingFailures(10, { force: true });
    const choices = [{ key: 'STOP', label: 'Stop', consequence: 'stops' }];
    expect(await reopenWithdrawnRequest({ requestId, choices, authorityNeeded: 'a', whyNotRussell: 'b' })).toBe(true);
    expect((await getHumanRequest(requestId))!.state).toBe('OPEN');
    // Twice is once.
    expect(await reopenWithdrawnRequest({ requestId, choices, authorityNeeded: 'a', whyNotRussell: 'b' })).toBe(false);
  });

  it('takes one place per packet, and a permanent refusal does not hold the front of the queue', async () => {
    // An old packet that failed several times and can never be recovered.
    const dead = await stuckPacket({ claims: 0 });
    await ledger(dead.workItemId, STORE_REFUSED);
    for (let i = 0; i < 3; i += 1) {
      const extra = await enqueueWork({
        projectId,
        workType: 'RESEARCH_SYNTHESIZE',
        payload: {},
        orchestrationId: dead.orchestrationId,
        createdByType: 'WORKER',
        createdById: 'test',
      });
      await cancelWork(extra.id, 'refused');
      await ledger(extra.id, STORE_REFUSED);
    }
    const first = await recoverFilingFailures(1, { force: true });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ orchestrationId: dead.orchestrationId, refusal: 'NO_CITABLE_EVIDENCE' });

    // A recoverable packet arrives; a batch of one reaches it next time.
    const live = await stuckPacket();
    await ledger(live.workItemId, STORE_REFUSED);
    const second = await recoverFilingFailures(1, { force: true });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ orchestrationId: live.orchestrationId, outcome: 'RECOVERED' });
  });

  it('is throttled, so a ten-second tick does not rescan the backlog', async () => {
    await recoverFilingFailures(10, { force: true });
    const stuck = await stuckPacket();
    await ledger(stuck.workItemId, STORE_REFUSED);
    expect(await recoverFilingFailures(10)).toEqual([]);
  });
});
