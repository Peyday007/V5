/**
 * One manufacturing programme, walked the whole way through the entrances
 * production actually uses.
 *
 * ---------------------------------------------------------------------------
 * Why a walk rather than more unit tests
 * ---------------------------------------------------------------------------
 *
 * §24 and §30 both record the same lesson at the same altitude: walking the
 * journey found transitions that existed, were tested, and could be reached by
 * nothing — because a test that arranges its own starting state cannot tell a
 * mechanism from a function nobody calls. `tests/manufacturingKernel.test.ts`
 * arranges its own orchestrations; this one lets Brain build them.
 *
 * It found two defects that every unit test passed through. The compiler read
 * the project's declared envelope **before** the round that asked the question,
 * so on a project declaring `PUBLIC_RECORDS` the question *"Who is actually
 * buying commercial pressure washers?"* compiled with geography `Michigan` and
 * sources *"county register of deeds"* — §25's Westbrook defect, with every row
 * around it healthy. And `found` was tallied from what a pass wrote rather than
 * derived from what was filed.
 *
 * ---------------------------------------------------------------------------
 * What is simulated, said rather than assumed
 * ---------------------------------------------------------------------------
 *
 * **Only the external edge.** The worker authenticates as a real `WORKER`
 * principal, claims a real item off the durable queue that *Brain* enqueued,
 * and submits through `brain_submit_claims` and `brain_submit_verification` —
 * so the scope check, the lease and generation proof, the lane validation,
 * Step 6's idempotency and Brain's own evidence gate all run. The items are not
 * the test's either: the tick's own `launch()` created them, which is the point.
 *
 * What stays fixture is the sentences a worker found and the two judgements
 * only a reader of a source can make. Two things this is **not**: not a live
 * Cowork session — no Routine fires, no provider is called, nothing external is
 * read — and the tool *layer* rather than the MCP *transport*, which
 * `tests/mcp.test.ts` covers instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { claimWork } from '../server/repos/workQueue.ts';
import type { ClaimedWork } from '../server/domain/types.ts';
import { findTool } from '../server/mcp/tools.ts';
import { tick } from '../server/services/russell/loop.ts';
import { parseResearchPass } from '../server/services/research/schema.ts';
import { getDb } from '../server/db/database.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { listMissions, transitionMission } from '../server/repos/russellMissions.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import {
  getProgram,
  listCapabilities,
  listCategories,
  listCategoryEvidence,
  listEdges,
  listManufacturingRounds,
} from '../server/repos/manufacturing.ts';
import { startProgramme, moveProgramme } from '../server/services/manufacturing/program.ts';
import { declareHeld, seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import type { Layer, Principal, WorkerScope } from '../server/domain/types.ts';

const OBJECTIVE =
  'Build a general-purpose manufacturing company able to move from powered equipment into ' +
  'mobility, industrial machinery and eventually aerospace, entering each category only where ' +
  'demand and a route to buyers are already demonstrated.';

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

let fixture: TestProject;
let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `mfg-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
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
  const worker = await createWorker({
    name: `mfg-worker-${Math.random().toString(36).slice(2, 10)}`,
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

function principalFor(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'mfg-worker',
    displayName: 'The research worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_mfg',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_mfg_worker',
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
    requestId: 'req_mfg',
  };
}

/** One MCP tool call, as the worker. This is the wire validation door. */
async function asWorker(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: principalFor(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

/** The same call, expecting the door to refuse it. */
async function asWorkerRefused(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    await asWorker(name, args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${name} accepted something it should have refused`);
}

/**
 * Claim whatever Brain has queued of this type.
 *
 * It does not enqueue. The tick's own `launch()` did, for a fragment Brain
 * compiled — an item the test created would only prove the tools accept a proof
 * the test also wrote.
 */
async function claimQueued(type: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId, scopes: WORKER_SCOPES }],
    workTypes: [type],
  });
  if (!claimed) throw new Error(`Brain queued nothing of type ${type}`);
  return claimed;
}

/** Whether Brain has anything of this type waiting, read from the queue. */
async function queued(type: string): Promise<boolean> {
  const rows = await getDb().all<{ total: number }>(
    `SELECT COUNT(*) AS total FROM work_items WHERE work_type = ? AND state = 'QUEUED'`,
    [type],
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

/** Run the tick until something is true, or give up loudly. */
async function tickUntil(
  what: string,
  predicate: () => Promise<boolean>,
  rounds = 30,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (await predicate()) return;
    await tick(`walk-${i}`);
  }
  if (await predicate()) return;
  const missions = await listMissions({ projectId });
  const frags = await getDb().all<{ fragment_key: string; status: string }>(
    'SELECT fragment_key, status FROM research_fragments',
  );
  const cands = await listCandidates({ projectId });
  throw new Error(
    `the tick never reached: ${what}\n` +
      `missions: ${missions.map((one) => `${one.state}`).join(',')}\n` +
      `fragments: ${frags.map((one) => `${one.fragment_key}/${one.status}`).join(',')}\n` +
      `candidates: ${cands.map((one) => `${one.state}/${one.priority ?? '-'}/${one.reason ?? ''}`).join(' | ')}`,
  );
}

interface Declared {
  claim: string;
  lane: string;
  finding: string;
  subject: string;
  observedOn?: string;
}

/**
 * The worker answers one queued fragment, through the tools, with declarations.
 *
 * Returns the orchestration so the caller can advance the packet exactly as the
 * runner does.
 */
async function workerAnswers(input: {
  /**
   * The declarations, built from the lanes **Brain compiled** rather than from
   * lane ids this test invented. A fixture that named its own lanes would pass
   * against a compiler that declared none.
   */
  pick: (context: { fragmentKey: string; laneIds: string[] }) => Declared[];
}): Promise<{ orchestrationId: string; laneIds: string[]; fragmentKey: string }> {
  // The tick launches at most one mission per cycle, so the second question is
  // queued a pass later. Waiting for it is the honest shape: a worker arrives
  // when there is something to do.
  await tickUntil('a research fragment on the queue', () => queued('RESEARCH_FRAGMENT'));
  const researching = await claimQueued('RESEARCH_FRAGMENT');

  // The worker reads the declaration the gate will judge it against. The lane
  // ids a claim must name come from Brain's compiled fragment, never from here.
  const assignment = (await asWorker('brain_get_assignment', {
    work_item_id: researching.workItemId,
  }))['assignment'] as Record<string, unknown>;
  const fragment = assignment['fragment'] as Record<string, unknown>;
  const laneIds = fragment['evidenceLaneIds'] as string[];
  const fragmentKey = String(fragment['key'] ?? '');
  const orchestrationId = String(
    (assignment['orchestration'] as Record<string, unknown>)['id'],
  );

  const declared = input.pick({ fragmentKey, laneIds });
  // Every lane a claim names is one Brain actually declared.
  for (const one of declared) expect(laneIds).toContain(one.lane);

  const submitted = await asWorker('brain_submit_claims', {
    ...proof(researching),
    claims: declared.map((one) => ({
      claim: one.claim,
      claim_type: 'SOURCED_FACT',
      source_url: 'https://example.test/trade-body/statistics',
      source_title: 'A published statistic',
      source_publisher: 'example.test',
      source_date: '2026-09-10',
      evidence_excerpt: one.claim,
      evidence_locator: 'the table body',
      evidence_lane: one.lane,
      retrieved_at: '2026-09-12',
      confidence: 0.9,
      primary_source: true,
      capability_finding: one.finding,
      capability_subject: one.subject,
      ...(one.observedOn ? { capability_observed_on: one.observedOn } : {}),
    })),
    search_queries: ['what the sources publish'],
  });
  // Stored, and none of them accepted: the worker never decides that.
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];

  await asWorker('brain_complete_work', {
    ...proof(researching),
    result_ref: String(submitted['recorded']),
    summary: 'claims submitted',
  });

  // Completing that item advances the packet, and the packet decides the
  // verification is next.
  await advancePacket(orchestrationId);
  await tickUntil('a verification on the queue', () => queued('RESEARCH_VERIFY'));
  const verifying = await claimQueued('RESEARCH_VERIFY');
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
  expect(gate['acceptedClaims']).toBeGreaterThan(0);
  await asWorker('brain_complete_work', {
    ...proof(verifying),
    result_ref: String(gate['acceptedClaims']),
    summary: 'verified and gated',
  });

  /*
   * The mission ends through the production transition, which is what makes
   * the round settle on the next pass.
   *
   * Deliberately not a raw UPDATE, and the first version of this walk used one.
   * `transitionMission` is what calls `settleReservation`, so writing the state
   * directly left every mission's concurrency slot `HELD` for ever — three
   * missions in, the standing authority refused the fourth and the walk stalled
   * with every row looking healthy. A fixture that reaches past a transition
   * does not test the transition; it tests around it.
   */
  const mission = (await listMissions({ projectId })).find(
    (one) => one.orchestrationId === orchestrationId && one.state === 'RUNNING',
  );
  expect(mission, 'no running mission for that orchestration').toBeTruthy();
  expect(
    await transitionMission({ missionId: mission!.id, from: 'RUNNING', to: 'DONE' }),
  ).toBe(true);

  return { orchestrationId, laneIds, fragmentKey };
}

/**
 * Keep a worker answering whatever Brain has queued, until something is true.
 *
 * The realistic shape: workers arrive, take the oldest thing waiting, and
 * answer it. Which question that is, is Brain's ordering — `launchOrdinal` puts
 * a demand question ahead of a capability one, so the capability question is
 * reached by working through the queue rather than by the test reaching past it.
 */
async function drainUntil(what: string, predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    if (await predicate()) return;
    await tick(`drain-${i}`);
    if (await queued('RESEARCH_FRAGMENT')) {
      await workerAnswers({ pick: declarationsFor });
    }
  }
  if (await predicate()) return;
  const frags = await getDb().all<{ fragment_key: string; status: string }>(
    'SELECT fragment_key, status FROM research_fragments',
  );
  const missions = await listMissions({ projectId });
  const goal = await getDb().all<{ max_concurrent: number; name: string }>(
    'SELECT name, max_concurrent FROM russell_goals',
  );
  throw new Error(
    `draining the queue never reached: ${what}\n` +
      `fragments: ${frags.map((one) => `${one.fragment_key}/${one.status}`).join(',')}\n` +
      `missions: ${missions.map((one) => one.state).join(',')}\n` +
      `goals: ${goal.map((one) => `${one.name}=${one.max_concurrent}`).join(',')}`,
  );
}

// ---------------------------------------------------------------------------

describe('one manufacturing programme, from a person starting it to a verdict', () => {
  it('walks the whole journey through the entrances production uses', async () => {
    /* --------------------------------------------------------------------
     * 1. A person starts it, which is also what authorizes the research.
     * ------------------------------------------------------------------ */
    const started = await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    expect(started.ok).toBe(true);

    /* --------------------------------------------------------------------
     * 2. A person names a category to start from. `SEED` is the one origin
     *    Brain may not write.
     * ------------------------------------------------------------------ */
    const seeded = await seedCategory({
      projectId,
      name: 'Commercial pressure washers',
      actorRef: userId,
    });
    expect('category' in seeded).toBe(true);
    const categoryId = (seeded as { category: { id: string } }).category.id;

    /* --------------------------------------------------------------------
     * 3. Brain decides what to ask next, and demand comes first.
     * ------------------------------------------------------------------ */
    await runManufacturingKernel(projectId);
    const program = await getProgram(projectId);
    const opened = await listManufacturingRounds(program!.id);
    expect(opened.map((one) => one.purpose).sort()).toEqual(['BOOTSTRAP', 'DEMAND']);
    // Every round is a Russell candidate; nothing bypasses the pipeline.
    expect((await listCandidates({ projectId })).length).toBe(2);

    /* --------------------------------------------------------------------
     * 4. The tick judges, compiles and launches it — the real path.
     * ------------------------------------------------------------------ */
    await tickUntil(
      'a mission with an orchestration',
      async () =>
        (await listMissions({ projectId })).some((one) => one.orchestrationId !== null),
    );

    /* --------------------------------------------------------------------
     * 5. It compiled into the right envelope, which is the defect this walk
     *    found. A question about who buys machines must not be judged by a
     *    public-records completion standard.
     * ------------------------------------------------------------------ */
    const fragments = await getDb().all<{ fragment_key: string; geography: string }>(
      'SELECT fragment_key, geography FROM research_fragments',
    );
    expect(fragments.length).toBeGreaterThan(0);
    for (const one of fragments) {
      expect(['machine-ladder', 'machine-demand']).toContain(one.fragment_key);
      expect(one.geography).not.toBe('Michigan');
    }

    /* --------------------------------------------------------------------
     * 6. A worker claims what Brain queued and reads its assignment.
     * ------------------------------------------------------------------ */
    const answered = await workerAnswers({ pick: declarationsFor });
    expect(['machine-ladder', 'machine-demand']).toContain(answered.fragmentKey);

    // Both questions were queued, so answer the other one too. Which arrives
    // first is Brain's ordering, not this test's.
    await workerAnswers({ pick: declarationsFor });

    /* --------------------------------------------------------------------
     * 7. Brain absorbs what the gate accepted, and only that.
     * ------------------------------------------------------------------ */
    await tickUntil(
      'the evidence filed onto the ladder',
      async () => (await listCategoryEvidence(program!.id)).length >= 2,
    );
    const evidence = await listCategoryEvidence(program!.id);
    expect(evidence.map((one) => one.kind).sort()).toEqual([
      'DEMAND_EVIDENCE',
      'DISTRIBUTION_CHANNEL',
    ]);
    // Filed against the category the round was about, never a guess.
    expect(evidence.every((one) => one.categoryId === categoryId)).toBe(true);

    /* --------------------------------------------------------------------
     * 8. Absorbing again changes nothing, and the round keeps what it found.
     * ------------------------------------------------------------------ */
    const before = (await listCategoryEvidence(program!.id)).length;
    await runManufacturingKernel(projectId);
    await runManufacturingKernel(projectId);
    expect((await listCategoryEvidence(program!.id)).length).toBe(before);
    const demandRound = (await listManufacturingRounds(program!.id)).find(
      (one) => one.purpose === 'DEMAND' && one.categoryId === categoryId,
    )!;
    expect(demandRound.state).toBe('HARVESTED');
    expect(demandRound.found).toBe(2);

    /* --------------------------------------------------------------------
     * 9. The verdict moved, and it moved to the honest one: buyers and a
     *    route, and nothing yet about what building it takes.
     * ------------------------------------------------------------------ */
    let view = await programmeView(projectId);
    let reading = view!.ladder.find((one) => one.categoryId === categoryId)!;
    expect(reading.verdict).toBe('BUILD_CAPABILITY_FIRST');
    expect(
      reading.conditions.find((one) => one.condition === 'DEMAND_ESTABLISHED')!.answer,
    ).toBe('MET');
    expect(
      reading.conditions.find((one) => one.condition === 'CAPABILITIES_HELD')!.answer,
    ).toBe('UNKNOWN');

    /* --------------------------------------------------------------------
     * 10. Which is exactly what Brain asked next, with the reason recorded
     *     beside it. The tick opens it on its own — nothing here asks.
     * ------------------------------------------------------------------ */
    await tickUntil('the capability question opened', async () => {
      const rounds = await listManufacturingRounds(program!.id);
      return rounds.some((one) => one.purpose === 'CAPABILITY' && one.categoryId === categoryId);
    });
    const capabilityRound = (await listManufacturingRounds(program!.id)).find(
      (one) => one.purpose === 'CAPABILITY' && one.categoryId === categoryId,
    )!;
    const why = await getDb().all<{ payload: string }>(
      `SELECT payload FROM project_events
        WHERE event_type = 'MANUFACTURING_ROUND_OPENED' AND entity_id = ?`,
      [capabilityRound.id],
    );
    expect(String(why[0]?.payload ?? '')).toContain('published route');

    /* --------------------------------------------------------------------
     * 11. The capability question runs the same way, through the same door.
     * ------------------------------------------------------------------ */
    await drainUntil(
      'the capability filed onto the ladder',
      async () => (await listEdges(program!.id)).length > 0,
    );

    /* --------------------------------------------------------------------
     * 12. Research established what producing requires. It established
     *     nothing about what this company can do, and that is the rule the
     *     whole kernel rests on.
     * ------------------------------------------------------------------ */
    const capabilities = await listCapabilities(program!.id);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.heldAt).toBeNull();
    expect(capabilities[0]!.heldEvidence).toBeNull();

    view = await programmeView(projectId);
    reading = view!.ladder.find((one) => one.categoryId === categoryId)!;
    expect(reading.verdict).toBe('BUILD_CAPABILITY_FIRST');
    expect(reading.missing.map((one) => one.capability.name)).toEqual([
      'small engine integration',
    ]);
    expect(view!.enterable).toEqual([]);

    /* --------------------------------------------------------------------
     * 13. Only a person can close that gap, and then the verdict moves.
     * ------------------------------------------------------------------ */
    await declareHeld({
      projectId,
      capabilityId: capabilities[0]!.id,
      note: 'Two engine engineers hired in March, and a running prototype.',
      actorRef: userId,
    });
    view = await programmeView(projectId);
    reading = view!.ladder.find((one) => one.categoryId === categoryId)!;
    expect(reading.verdict).toBe('ENTER');
    expect(view!.enterable.map((one) => one.categoryId)).toEqual([categoryId]);

    /* --------------------------------------------------------------------
     * 14. And the whole thing advanced with nobody editing a row.
     * ------------------------------------------------------------------ */
    expect((await listCategories(program!.id)).length).toBeGreaterThanOrEqual(1);
  }, 240000);
});

/**
 * What a worker would report for whichever question Brain actually asked.
 *
 * Keyed off the fragment Brain compiled, so the test never decides which
 * question is being answered — and every lane named is one the assignment
 * declared. These are the sentences a reader of a source would have written;
 * everything about whether they are accepted is Brain's.
 */
function declarationsFor(context: { fragmentKey: string; laneIds: string[] }): Declared[] {
  if (context.fragmentKey === 'machine-demand') {
    return [
      {
        claim: 'The association reported 41,800 units shipped in the year to June 2026.',
        lane: 'buying',
        finding: 'DEMAND_EVIDENCE',
        subject: 'UNIT_SHIPMENTS',
        observedOn: '2026-06-30',
      },
      {
        claim: 'Machines of this kind reach contractors through franchised dealers.',
        lane: 'route',
        finding: 'DISTRIBUTION_CHANNEL',
        subject: 'DEALER_NETWORK',
      },
    ];
  }
  if (context.fragmentKey === 'machine-capability') {
    return [
      {
        claim: 'Producing one requires integrating a small engine with a pump and a frame.',
        lane: 'requires',
        finding: 'CAPABILITY_REQUIRED',
        subject: 'small engine integration',
      },
    ];
  }
  return [
    {
      claim: 'The association recognises portable generators as a category of its own.',
      lane: 'inside',
      finding: 'PRODUCT_CATEGORY',
      subject: 'Portable generators',
    },
  ];
}

describe('both validation doors, and every honest stop', () => {
  /**
   * The wire door refuses, and the refusal is where a worker can still act on
   * it.
   *
   * §27 records why a refusal beats a dropped field: truncation and silent
   * dropping are the outcomes a worker cannot recover from, because they are
   * reported as success. Refused, the worker corrects one value and submits the
   * same claims again on the same item, with the attempt still there to spend.
   */
  it('refuses an undated demand signal at the wire door, and stores nothing', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await runManufacturingKernel(projectId);
    await tickUntil('a research fragment on the queue', () => queued('RESEARCH_FRAGMENT'));
    const researching = await claimQueued('RESEARCH_FRAGMENT');

    const message = await asWorkerRefused('brain_submit_claims', {
      ...proof(researching),
      claims: [
        {
          claim: 'The market for these is understood to be large.',
          claim_type: 'SOURCED_FACT',
          source_url: 'https://example.test/trade/overview',
          source_title: 'An overview',
          source_publisher: 'example.test',
          source_date: '2026-09-10',
          evidence_excerpt: 'large',
          evidence_locator: 'the page',
          evidence_lane: 'inside',
          retrieved_at: '2026-09-12',
          confidence: 0.9,
          primary_source: true,
          capability_finding: 'DEMAND_EVIDENCE',
          capability_subject: 'UNIT_SHIPMENTS',
          // and no capability_observed_on
        },
      ],
      search_queries: ['how big is this'],
    });
    expect(message).toContain('capability_observed_on');

    // Nothing was stored, so the attempt is still there to spend.
    const stored = await getDb().all<{ total: number }>(
      'SELECT COUNT(*) AS total FROM research_claims',
    );
    expect(Number(stored[0]!.total)).toBe(0);
  }, 120000);

  /**
   * And the provider door applies the identical rule, because it is the
   * identical function.
   *
   * Two readers of one rule is how they come to disagree, and this repository
   * has had to record that five times. This asserts they agree by exercising
   * both against the same bad declaration.
   */
  it('refuses the same declaration at the provider door, in the same words', () => {
    const pass = parseResearchPass(
      JSON.stringify({
        claims: [
          {
            claim: 'The market for these is understood to be large.',
            claimType: 'SOURCED_FACT',
            sourceUrl: 'https://example.test/trade/overview',
            capabilityFinding: 'DEMAND_EVIDENCE',
            capabilitySubject: 'UNIT_SHIPMENTS',
          },
        ],
        searchQueries: [],
        unresolved: [],
        notes: '',
      }),
    );
    expect(pass.ok).toBe(false);
    expect((pass as { error: string }).error).toContain('capability_observed_on');
  });

  /**
   * A programme with no live research grant opens nothing, and says so in
   * words naming what would change the answer.
   */
  it('stops honestly when the research authority is gone, and resumes when it returns', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });

    // Archived: the grant is withdrawn and nothing new is asked.
    await moveProgramme({
      projectId,
      actorUserId: userId,
      to: 'ARCHIVED',
      reason: 'Not this quarter.',
    });
    const stopped = await runManufacturingKernel(projectId);
    expect(stopped.opened).toHaveLength(0);
    expect(stopped.declined[0]!.why).toContain('archived');

    // The exact event that re-arms it: a person reactivating the programme.
    await moveProgramme({ projectId, actorUserId: userId, to: 'ACTIVE' });
    const resumed = await runManufacturingKernel(projectId);
    expect(resumed.opened.length).toBeGreaterThan(0);
  }, 120000);

  /**
   * Nothing on the ladder is reported as enterable while a required capability
   * is unheld, however much research has been accepted about it — and the
   * snapshot says which, and why.
   */
  it('produces a snapshot that explains itself', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await runManufacturingKernel(projectId);

    const view = await programmeView(projectId);
    expect(view!.program.objective).toBe(OBJECTIVE);
    expect(view!.authorized).toBe(true);
    expect(view!.enterable).toEqual([]);
    const reading = view!.ladder.find(
      (one) => one.path.at(-1) === 'Commercial pressure washers',
    )!;
    // Four conditions, always all four, each with the rows it was read from.
    expect(reading.conditions).toHaveLength(4);
    for (const condition of reading.conditions) {
      expect(condition.because.length).toBeGreaterThan(10);
    }
    // And what Brain would ask next, with the reason it chose it.
    expect(view!.plan.asks.length + view!.open.length).toBeGreaterThan(0);
  }, 120000);
});
