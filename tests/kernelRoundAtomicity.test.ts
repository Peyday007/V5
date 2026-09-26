/**
 * A candidate and its round commit together, at all six opening sites.
 *
 * Every kernel's `openAsks` (and cash discovery's `openDiscovery`) used to
 * create a Russell candidate first and record the kernel's round second, with
 * a plain `ON CONFLICT DO NOTHING` insert on the round and a losing insert
 * simply `continue`d past the candidate it had just created. The candidate is
 * `SHARED` with a project, and Russell's tick judges and can launch any
 * unjudged `SHARED` candidate — orphan or not — so a losing insert used to
 * leave behind a research mission Brain pays for that nothing would ever
 * absorb the answer to.
 *
 * The fix wraps the candidate write and the round write in one transaction at
 * each site, so a losing round insert rolls the candidate back too. This file
 * proves that property directly, two ways, at every site that has the shape:
 *
 *   A01 — the round already exists at the exact key an opening call would use
 *         (a round some other pass already committed). The call must create
 *         no surviving candidate: whatever it created inside its transaction
 *         must have been rolled back, leaving the candidate count for the
 *         project exactly where it started.
 *   A02 — the opening call is fired twice concurrently for the identical
 *         ask. Exactly one round and exactly one candidate for it must exist
 *         afterward, never two.
 *
 * Cash discovery is the one exception to having two separate tests for this.
 * `openDiscovery` does not take an `ask` — it derives what to open from
 * `listRounds` read at the top of its own call, so a *sequential* second call
 * always sees the first call's committed round and never re-attempts the same
 * key at all (that is `cashDiscovery.test.ts`'s own idempotency test, and it
 * says nothing about the transaction this file is pinning). The only way to
 * make two calls compute the same next round for the same bucket is to run
 * them concurrently, so its A01 and A02 properties are proved by the one
 * concurrent test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `kernel-atomicity-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

async function candidateCount(): Promise<number> {
  return (await listCandidates({ projectId })).length;
}

// ---------------------------------------------------------------------------
// Industry
// ---------------------------------------------------------------------------

describe('industry: openAsks commits a candidate and its round together', () => {
  it('A01: a round already at the key leaves no surviving candidate', async () => {
    await activated();
    const { seedSubject } = await import('../server/services/industry/seed.ts');
    const { graphSnapshot } = await import('../server/services/industry/graph.ts');
    const { openAsks } = await import('../server/services/industry/expand.ts');
    const { openIndustryRound } = await import('../server/repos/industry.ts');

    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const mode = (await getCashMode(projectId))!;
    const ask = {
      purpose: 'MAP' as const,
      nodeId: seed.node.id,
      bucketId: null,
      opportunityId: null,
      round: 1,
      rank: 0,
      subject: 'A sector',
      since: new Date().toISOString(),
      why: 'test',
    };
    // A round already committed at the exact key this ask would use.
    await openIndustryRound({
      projectId,
      cashModeId: mode.id,
      nodeId: ask.nodeId,
      purpose: ask.purpose,
      bucketId: ask.bucketId,
      opportunityId: ask.opportunityId,
      round: ask.round,
      candidateId: 'rcn_preexisting',
    });

    const before = await candidateCount();
    const snapshot = await graphSnapshot(projectId);
    const opened = await openAsks({ projectId, asks: [ask], snapshot });

    expect(opened).toHaveLength(0);
    expect(await candidateCount()).toBe(before); // no orphan left behind
  });

  it('A02: two concurrent calls for the same ask produce one round and one candidate', async () => {
    await activated();
    const { seedSubject } = await import('../server/services/industry/seed.ts');
    const { graphSnapshot } = await import('../server/services/industry/graph.ts');
    const { openAsks } = await import('../server/services/industry/expand.ts');
    const { listIndustryRounds } = await import('../server/repos/industry.ts');

    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const ask = {
      purpose: 'MAP' as const,
      nodeId: seed.node.id,
      bucketId: null,
      opportunityId: null,
      round: 1,
      rank: 0,
      subject: 'A sector',
      since: new Date().toISOString(),
      why: 'test',
    };
    const before = await candidateCount();
    const snapshot = await graphSnapshot(projectId);
    const [a, b] = await Promise.all([
      openAsks({ projectId, asks: [ask], snapshot }),
      openAsks({ projectId, asks: [ask], snapshot }),
    ]);

    const opened = [...a, ...b];
    expect(opened).toHaveLength(1); // one call won, the other found nothing to open
    const rounds = (await listIndustryRounds(projectId)).filter((one) => one.nodeId === seed.node.id);
    expect(rounds).toHaveLength(1);
    expect(await candidateCount()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Manufacturing
// ---------------------------------------------------------------------------

describe('manufacturing: openAsks commits a candidate and its round together', () => {
  async function started(): Promise<void> {
    const { startProgramme } = await import('../server/services/manufacturing/program.ts');
    const outcome = await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective:
        'Build the capability to manufacture progressively harder machines, beginning from ' +
        'powered equipment and following demand rather than ambition.',
    });
    expect(outcome.ok).toBe(true);
  }

  it('A01: a round already at the key leaves no surviving candidate', async () => {
    await started();
    const { seedCategory } = await import('../server/services/manufacturing/declare.ts');
    const { getProgram, openManufacturingRound } = await import('../server/repos/manufacturing.ts');
    const { ladderSnapshot } = await import('../server/services/manufacturing/ladder.ts');
    const { openAsks } = await import('../server/services/manufacturing/expand.ts');

    const seeded = await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    if ('error' in seeded) throw new Error(seeded.error);
    const program = (await getProgram(projectId))!;
    const ask = {
      purpose: 'MAP' as const,
      categoryId: seeded.category.id,
      round: 1,
      rank: 0,
      subject: 'test',
      since: new Date().toISOString(),
      why: 'test',
    };
    await openManufacturingRound({
      programId: program.id,
      projectId,
      categoryId: ask.categoryId,
      purpose: ask.purpose,
      round: ask.round,
      candidateId: 'rcn_preexisting',
    });

    const before = await candidateCount();
    const snapshot = (await ladderSnapshot(projectId))!;
    const opened = await openAsks({ projectId, asks: [ask], snapshot, directive: null });

    expect(opened).toHaveLength(0);
    expect(await candidateCount()).toBe(before);
  });

  it('A02: two concurrent calls for the same ask produce one round and one candidate', async () => {
    await started();
    const { seedCategory } = await import('../server/services/manufacturing/declare.ts');
    const { listManufacturingRounds } = await import('../server/repos/manufacturing.ts');
    const { ladderSnapshot } = await import('../server/services/manufacturing/ladder.ts');
    const { openAsks } = await import('../server/services/manufacturing/expand.ts');

    const seeded = await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    if ('error' in seeded) throw new Error(seeded.error);
    const ask = {
      purpose: 'MAP' as const,
      categoryId: seeded.category.id,
      round: 1,
      rank: 0,
      subject: 'test',
      since: new Date().toISOString(),
      why: 'test',
    };
    const before = await candidateCount();
    const snapshot = (await ladderSnapshot(projectId))!;
    const [a, b] = await Promise.all([
      openAsks({ projectId, asks: [ask], snapshot, directive: null }),
      openAsks({ projectId, asks: [ask], snapshot, directive: null }),
    ]);

    expect([...a, ...b]).toHaveLength(1);
    const rounds = (await listManufacturingRounds(snapshot.program.id)).filter(
      (one) => one.categoryId === seeded.category.id,
    );
    expect(rounds).toHaveLength(1);
    expect(await candidateCount()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Dealflow
// ---------------------------------------------------------------------------

describe('dealflow: openDealAsks commits a candidate and its round together', () => {
  function seedAsk() {
    return {
      purpose: 'SEED_EQUIPMENT' as const,
      equipmentClass: null,
      destination: null,
      partyId: null,
      dealId: null,
      round: 1,
      rank: 0,
      why: 'test',
    };
  }

  it('A01: a round already at the key leaves no surviving candidate', async () => {
    await activated();
    const { dealflowSnapshot } = await import('../server/services/dealflow/graph.ts');
    const { openDealAsks } = await import('../server/services/dealflow/expand.ts');
    const { openDealRound } = await import('../server/repos/dealflow.ts');

    const mode = (await getCashMode(projectId))!;
    const ask = seedAsk();
    await openDealRound({
      projectId,
      cashModeId: mode.id,
      purpose: ask.purpose,
      equipmentClass: ask.equipmentClass,
      destination: ask.destination,
      partyId: ask.partyId,
      dealId: ask.dealId,
      round: ask.round,
      candidateId: 'rcn_preexisting',
    });

    const before = await candidateCount();
    const snapshot = await dealflowSnapshot(projectId);
    const opened = await openDealAsks({ projectId, asks: [ask], snapshot });

    expect(opened).toHaveLength(0);
    expect(await candidateCount()).toBe(before);
  });

  it('A02: two concurrent calls for the same ask produce one round and one candidate', async () => {
    await activated();
    const { dealflowSnapshot } = await import('../server/services/dealflow/graph.ts');
    const { openDealAsks } = await import('../server/services/dealflow/expand.ts');
    const { listDealRounds } = await import('../server/repos/dealflow.ts');

    const ask = seedAsk();
    const before = await candidateCount();
    const snapshot = await dealflowSnapshot(projectId);
    const [a, b] = await Promise.all([
      openDealAsks({ projectId, asks: [ask], snapshot }),
      openDealAsks({ projectId, asks: [ask], snapshot }),
    ]);

    expect([...a, ...b]).toHaveLength(1);
    const rounds = (await listDealRounds(projectId)).filter((one) => one.purpose === 'SEED_EQUIPMENT');
    expect(rounds).toHaveLength(1);
    expect(await candidateCount()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Puzzle
// ---------------------------------------------------------------------------

describe('puzzle: openPuzzleAsks commits a candidate and its round together', () => {
  // ECONOMICS is the one purpose whose CHECK constraint requires a non-null
  // productClass (`(purpose = 'ECONOMICS') = (product_class IS NOT NULL)`).
  // Every other purpose *forbids* one, which matters here because the round's
  // own unique index — (project, purpose, format_key, product_class, round) —
  // has no COALESCE, unlike the other kernels'. SQLite treats each NULL in a
  // unique index as distinct from every other NULL, so the index alone cannot
  // detect a duplicate at any purpose whose product_class is always NULL.
  // ECONOMICS is the only purpose where both columns are real values, so A01
  // and A02 below use it to pin the transaction-rollback property against a
  // unique index that actually works.
  //
  // `lockPuzzleRoundKey` (server/services/puzzle/expand.ts) is what makes the
  // same property hold for every other purpose too, on the backend where the
  // gap is live: a Postgres transaction-scoped advisory lock on the round's
  // own natural key, taken before the candidate or the round is written, so a
  // second concurrent caller for the identical key blocks until the first
  // commits or rolls back rather than racing it. `demandAsk`'s A02 below
  // exercises that for a purpose whose productClass is always NULL. It cannot
  // fail *here* — this suite runs on SQLite, whose adapter already serialises
  // every transaction on one connection, and the lock is a deliberate no-op
  // there — but it is what this project's Postgres suite exercises for real,
  // and it is the reason this test is worth having at all: losing the lock
  // would not turn it red on this backend.
  function economicsAsk() {
    return {
      purpose: 'ECONOMICS' as const,
      formatKey: 'sudoku',
      formatName: 'Sudoku',
      productClass: 'DIGITAL_DOWNLOAD' as const,
      round: 1,
      rank: 0,
      why: 'test',
    };
  }

  it('A01: a round already at the key leaves no surviving candidate', async () => {
    await activated();
    const { puzzleSnapshot } = await import('../server/services/puzzle/graph.ts');
    const { openPuzzleAsks } = await import('../server/services/puzzle/expand.ts');
    const { openPuzzleRound } = await import('../server/repos/puzzle.ts');

    const mode = (await getCashMode(projectId))!;
    const ask = economicsAsk();
    await openPuzzleRound({
      projectId,
      cashModeId: mode.id,
      purpose: ask.purpose,
      formatKey: ask.formatKey,
      productClass: ask.productClass,
      candidateId: 'rcn_preexisting',
      round: ask.round,
    });

    const before = await candidateCount();
    const snapshot = await puzzleSnapshot(projectId);
    const opened = await openPuzzleAsks({ projectId, asks: [ask], snapshot });

    expect(opened).toHaveLength(0);
    expect(await candidateCount()).toBe(before);
  });

  it('A02: two concurrent calls for the same ask produce one round and one candidate', async () => {
    await activated();
    const { puzzleSnapshot } = await import('../server/services/puzzle/graph.ts');
    const { openPuzzleAsks } = await import('../server/services/puzzle/expand.ts');
    const { listPuzzleRounds } = await import('../server/repos/puzzle.ts');

    const ask = economicsAsk();
    const before = await candidateCount();
    const snapshot = await puzzleSnapshot(projectId);
    const [a, b] = await Promise.all([
      openPuzzleAsks({ projectId, asks: [ask], snapshot }),
      openPuzzleAsks({ projectId, asks: [ask], snapshot }),
    ]);

    expect([...a, ...b]).toHaveLength(1);
    const rounds = (await listPuzzleRounds(projectId)).filter((one) => one.formatKey === 'sudoku');
    expect(rounds).toHaveLength(1);
    expect(await candidateCount()).toBe(before + 1);
  });

  // productClass is always null here (DEMAND forbids one), which is exactly
  // the shape `puzzle_rounds_unique` cannot constrain on its own.
  function demandAsk() {
    return {
      purpose: 'DEMAND' as const,
      formatKey: 'maze',
      formatName: 'Maze',
      productClass: null,
      round: 1,
      rank: 0,
      why: 'test',
    };
  }

  it('A02 (productClass always null): two concurrent calls for the same ask still produce one round and one candidate', async () => {
    await activated();
    const { puzzleSnapshot } = await import('../server/services/puzzle/graph.ts');
    const { openPuzzleAsks } = await import('../server/services/puzzle/expand.ts');
    const { listPuzzleRounds } = await import('../server/repos/puzzle.ts');

    const ask = demandAsk();
    const before = await candidateCount();
    const snapshot = await puzzleSnapshot(projectId);
    const [a, b] = await Promise.all([
      openPuzzleAsks({ projectId, asks: [ask], snapshot }),
      openPuzzleAsks({ projectId, asks: [ask], snapshot }),
    ]);

    expect([...a, ...b]).toHaveLength(1);
    const rounds = (await listPuzzleRounds(projectId)).filter((one) => one.formatKey === 'maze');
    expect(rounds).toHaveLength(1);
    expect(await candidateCount()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Labor
// ---------------------------------------------------------------------------

describe('labor: openAsks commits a candidate and its round together', () => {
  async function seededTask(): Promise<{ id: string }> {
    const { createWorkflow, createTask } = await import('../server/repos/labor.ts');
    const workflow = await createWorkflow({
      projectId,
      name: `A workflow ${Math.random().toString(36).slice(2, 8)}`,
      origin: 'SEED',
      declaredByRef: userId,
    });
    const task = await createTask({
      projectId,
      workflowId: workflow.workflow.id,
      name: 'Write the summary',
      output: 'A one-page summary of what the buyer asked for.',
      origin: 'SEED',
      capabilityId: null,
      declaredByRef: userId,
    });
    return task.task;
  }

  it('A01: a round already at the key leaves no surviving candidate', async () => {
    const task = await seededTask();
    const { laborSnapshot } = await import('../server/services/labor/map.ts');
    const { openAsks } = await import('../server/services/labor/expand.ts');
    const { openLaborRound } = await import('../server/repos/labor.ts');

    const ask = {
      taskId: task.id,
      purpose: 'NECESSITY' as const,
      round: 1,
      rank: 0,
      subject: 'test',
      since: new Date().toISOString(),
      why: 'test',
    };
    await openLaborRound({
      projectId,
      taskId: ask.taskId,
      purpose: ask.purpose,
      round: ask.round,
      candidateId: 'rcn_preexisting',
    });

    const before = await candidateCount();
    const snapshot = await laborSnapshot(projectId);
    const opened = await openAsks({ projectId, asks: [ask], snapshot });

    expect(opened).toHaveLength(0);
    expect(await candidateCount()).toBe(before);
  });

  it('A02: two concurrent calls for the same ask produce one round and one candidate', async () => {
    const task = await seededTask();
    const { laborSnapshot } = await import('../server/services/labor/map.ts');
    const { openAsks } = await import('../server/services/labor/expand.ts');
    const { listLaborRounds } = await import('../server/repos/labor.ts');

    const ask = {
      taskId: task.id,
      purpose: 'NECESSITY' as const,
      round: 1,
      rank: 0,
      subject: 'test',
      since: new Date().toISOString(),
      why: 'test',
    };
    const before = await candidateCount();
    const snapshot = await laborSnapshot(projectId);
    const [a, b] = await Promise.all([
      openAsks({ projectId, asks: [ask], snapshot }),
      openAsks({ projectId, asks: [ask], snapshot }),
    ]);

    expect([...a, ...b]).toHaveLength(1);
    const rounds = (await listLaborRounds(projectId)).filter((one) => one.taskId === task.id);
    expect(rounds).toHaveLength(1);
    expect(await candidateCount()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Cash discovery
// ---------------------------------------------------------------------------

describe('cash discovery: openDiscovery commits a candidate and its round together', () => {
  it('A01+A02: two concurrent calls produce one round and one candidate for the first bucket', async () => {
    await activated();
    const { openDiscovery, SEARCH_BUCKETS } = await import('../server/services/cash/discovery.ts');
    const { listRounds } = await import('../server/repos/cashDiscovery.ts');

    /*
     * `openDiscovery` derives what to open from `listRounds`, read fresh at
     * the top of its own call, so a sequential second call always sees the
     * first call's committed round and never re-attempts the same key. Only
     * two calls racing before either commits can make both compute the same
     * next round for the same bucket, which is exactly what this fires.
     *
     * The loser of that race does not simply give up: its loop over
     * `SEARCH_BUCKETS` continues past the bucket it lost, and — since its own
     * `history` snapshot was read before either call committed anything — it
     * will usually go on to open the *next* bucket uncontested. So the
     * combined `opened` total across both calls is not itself the property
     * under test; what matters is (a) the contested bucket ends with exactly
     * one round, never two, and (b) every round that *did* get created has
     * exactly one candidate pointing at it — no orphan left by a rolled-back
     * loser, however many buckets ended up opened.
     */
    const before = await candidateCount();
    const [a, b] = await Promise.all([
      openDiscovery({ projectId, limit: 1 }),
      openDiscovery({ projectId, limit: 1 }),
    ]);

    const opened = [...a, ...b];
    expect(opened.some((one) => one.bucketId === SEARCH_BUCKETS[0]!.id)).toBe(true);

    const contested = (await listRounds(projectId)).filter(
      (one) => one.bucketId === SEARCH_BUCKETS[0]!.id,
    );
    expect(contested).toHaveLength(1); // the race at the exact key produced one round, never two

    const allRounds = await listRounds(projectId);
    expect(await candidateCount()).toBe(before + allRounds.length); // no orphan candidate, whatever else opened
  });
});
