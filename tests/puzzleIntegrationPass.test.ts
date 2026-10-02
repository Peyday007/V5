/**
 * One puzzle business, walked the whole way, through the entrances a real
 * session uses.
 *
 * ---------------------------------------------------------------------------
 * Why this exists beside the unit suite
 * ---------------------------------------------------------------------------
 *
 * §24 records the lesson at length and §30, §33 and §45 each repeat it:
 * walking the journey finds transitions that exist, are tested, and can be
 * reached by nothing — every one invisible to a test that arranges its own
 * starting state. A test that hands `filePuzzleFindings` a claim row is
 * testing the filing; it cannot tell a mechanism from a function nobody calls.
 *
 * So this file starts from a person activating a sprint and drives the loop
 * the brief asks for:
 *
 *   seed a format → Brain sets up a system → puzzles are made and proved
 *   → a product is compiled → the kernel asks who buys it and how it reaches
 *   them → a worker answers through the real tools → the findings file
 *   → a person reads what the machine made → the product is promoted into
 *   the portfolio
 *
 * ---------------------------------------------------------------------------
 * Only the external edge is simulated
 * ---------------------------------------------------------------------------
 *
 * The worker authenticates as a `WORKER` principal, claims a real item off the
 * durable queue and submits through `brain_submit_claims` and
 * `brain_submit_verification`. So everything a fired Cowork session is held to
 * actually runs: the scope check, the lease and generation proof, the lane
 * validation, Step 6's idempotency scope, the pass records, and Brain's own
 * seven-condition gate.
 *
 * **That is the half that matters most here.** §33 records what happens when a
 * declaration is named in a tool's prose and left out of its schema, and §45
 * records the same fact reaching the tool and not the mapper: in both, a
 * healthy worker, a healthy submission and a healthy row, with the one column
 * that decides whether anything is created silently empty. A test that wrote
 * `puzzle_finding` straight into the claims table would pass against precisely
 * those defects. This one puts every declaration through the wire.
 *
 * **What is not simulated at all is the puzzles.** They are generated,
 * validated and compiled by the real code, so the artifacts this walk produces
 * are real puzzles with real proofs — which is the one thing in this Brain
 * that needs no external anything.
 *
 * Two things this is not, said rather than assumed: not a live Cowork session
 * — no Routine fires, no provider is called, nothing external is read — and
 * the tool *layer* rather than the MCP *transport*, which `tests/mcp.test.ts`
 * and `tests/oauth.test.ts` cover instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { approvePlan, advancePacket } from '../server/services/research/packetRunner.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  listPuzzleDemand,
  listPuzzleEconomics,
  listPuzzleInstances,
  listPuzzleMasters,
  listPuzzleProducts,
  listPuzzleRounds,
  openPuzzleRound,
  listPuzzleRoutes,
} from '../server/repos/puzzle.ts';
import { runPuzzleKernel } from '../server/services/puzzle/kernel.ts';
import { puzzleView } from '../server/services/puzzle/view.ts';
import { observe, seedFormat } from '../server/services/puzzle/seed.ts';
import { renderInstance } from '../server/services/puzzle/generate.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { MAX_OPEN_PUZZLE_ROUNDS } from '../server/services/puzzle/allocate.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  ProjectMembership,
  PuzzleRoundPurpose,
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

const FORMAT = 'word search';

let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');

  const user = await createUser({
    email: `puzzle-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;

  const worker = await createWorker({
    name: `puzzle-worker-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'The puzzle worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'puzzle-worker',
    displayName: 'The puzzle worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_puzzle_walk',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_puzzle_walk',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: SCOPES,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      } as ProjectMembership,
    ],
    requestId: 'req_puzzle_walk',
  } as Principal;
}

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const found = findTool(name);
  if (!found) throw new Error(`no such tool: ${name}`);
  const outcome = await found.run(args, {
    principal: workerPrincipal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, any>;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

async function claimQueued(type: string): Promise<ClaimedWork> {
  const outcome = await tool('brain_claim_work', {
    project_id: projectId,
    work_types: [type],
    limit: 1,
  });
  const [claimed] = (outcome['claimed'] ?? []) as ClaimedWork[];
  if (!claimed) {
    throw new Error(`Brain queued nothing of type ${type}: ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  return claimed;
}

/** What a worker submits for one claim, exactly as it goes over the wire. */
interface WireClaim {
  claim: string;
  puzzle_finding?: string;
  puzzle_subject?: string;
  puzzle_format?: string;
  puzzle_product_class?: string;
  puzzle_value?: string;
  puzzle_amount_cents?: number;
  puzzle_currency?: string;
}

/**
 * One kernel round answered by a worker, through the real tools.
 *
 * The orchestration is attached to the round's own candidate through a
 * mission, which is how the filing knows which round a set of claims belongs
 * to — a round whose candidate no mission names belongs to nothing, and its
 * claims are correctly ignored.
 */
async function workerAnswers(input: {
  candidateId: string;
  question: string;
  claims: WireClaim[];
}): Promise<void> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: input.question,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: input.question,
    assignment: input.question,
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      requiredEvidence: [
        {
          id: 'puzzle',
          description: 'what the sources establish about this part of the puzzle trade',
          necessity: 'REQUIRED' as const,
        },
      ],
      acceptableSourceTypes: ['a published page a source identifies by URL'],
      excludedSourceTypes: ['an article about the trade that names no party'],
      completionCriteria: ['every finding declared on its own claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: `puzzle-${Math.random().toString(36).slice(2, 8)}`,
      question: input.question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const approved = await approvePlan({
    orchestrationId: orchestration.id,
    approvedByUserId: userId,
  });
  expect(approved.enqueued.length).toBeGreaterThan(0);

  const researching = await claimQueued('RESEARCH_FRAGMENT');
  const submitted = await tool('brain_submit_claims', {
    ...proof(researching),
    claims: input.claims.map((one, index) => ({
      claim: one.claim,
      claim_type: 'SOURCED_FACT',
      source_url: `https://example.test/puzzle/${index}`,
      source_title: 'A published page',
      source_publisher: 'A publisher',
      source_date: '2026-08-01',
      evidence_excerpt: one.claim,
      evidence_locator: 'the page body',
      evidence_lane: 'puzzle',
      retrieved_at: '2026-09-22',
      confidence: 0.9,
      primary_source: true,
      ...(one.puzzle_finding ? { puzzle_finding: one.puzzle_finding } : {}),
      ...(one.puzzle_subject ? { puzzle_subject: one.puzzle_subject } : {}),
      ...(one.puzzle_format ? { puzzle_format: one.puzzle_format } : {}),
      ...(one.puzzle_product_class ? { puzzle_product_class: one.puzzle_product_class } : {}),
      ...(one.puzzle_value ? { puzzle_value: one.puzzle_value } : {}),
      ...(one.puzzle_amount_cents !== undefined
        ? { puzzle_amount_cents: one.puzzle_amount_cents }
        : {}),
      ...(one.puzzle_currency ? { puzzle_currency: one.puzzle_currency } : {}),
    })),
    search_queries: [input.question],
  });
  // The worker never decides acceptance, and nothing here pretends otherwise.
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];
  expect(stored.length).toBe(input.claims.length);

  await tool('brain_complete_work', {
    ...proof(researching),
    result_ref: String(submitted['recorded']),
    summary: 'claims submitted',
  });

  await advancePacket(orchestration.id);
  const verifying = await claimQueued('RESEARCH_VERIFY');
  await tool('brain_submit_verification', {
    ...proof(verifying),
    verdicts: stored.map((row) => ({
      claim_id: row.claimId,
      supports_claim: true,
      geography: 'MATCH',
      timeframe: 'MATCH',
      population: 'MATCH',
      definitions: 'MATCH',
      geography_basis: 'Judged against the market the fragment declares.',
      timeframe_basis: 'Judged against the timeframe the fragment declares.',
      population_basis: 'Judged against the population the fragment declares.',
      definitions_basis: 'Judged against the definitions the fragment declares.',
      note: 'Read the page.',
    })),
    sufficiency: 'SUFFICIENT',
    missing_lanes: [],
    unresolved_gaps: [],
  });
  await tool('brain_complete_work', {
    ...proof(verifying),
    result_ref: 'gated',
    summary: 'verified and gated',
  });

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: input.question,
    whyNow: 'the kernel asked',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
}

async function openRound(purpose: PuzzleRoundPurpose): Promise<{ candidateId: string }> {
  const rounds = await listPuzzleRounds(projectId);
  const open = rounds.find((one) => one.state === 'OPEN' && one.purpose === purpose);
  if (!open) {
    throw new Error(
      `no open ${purpose} round; open rounds are ` +
        rounds
          .filter((one) => one.state === 'OPEN')
          .map((one) => one.purpose)
          .join(', '),
    );
  }
  return { candidateId: open.candidateId };
}

describe('one puzzle business, from an activated sprint to the portfolio', () => {
  it('walks the loop the brief asks for, with every declaration through the wire', async () => {
    // ---------------------------------------------------------------
    // A person activates the sprint and names one kind of puzzle.
    // Brain may not name one: the schema refuses a SEED row with no
    // claim, so there is no code path by which it could.
    // ---------------------------------------------------------------
    expect(
      (
        await activate({
          projectId,
          ownerUserId: userId,
          actorUserId: userId,
          objective: 'Maximize additional usable cash over the next few weeks.',
        })
      ).ok,
    ).toBe(true);

    const seeded = await seedFormat({
      projectId,
      actorRef: userId,
      name: FORMAT,
      note: 'The operator named it.',
    });
    expect(seeded.created).toBe(true);
    expect(seeded.format.origin).toBe('SEED');

    // ---------------------------------------------------------------
    // 1. BRAIN MAKES AND PROVES.
    //
    // Nothing external is involved: the system is set up because a
    // generator, a validator and a rights-cleared corpus all exist,
    // which are facts about code rather than judgements.
    // ---------------------------------------------------------------
    const first = await runPuzzleKernel(projectId);
    expect(first.systems).toHaveLength(1);
    expect(first.batches[0]?.made.length).toBeGreaterThan(0);

    const masters = await listPuzzleMasters(projectId);
    expect(masters[0]?.formatKey).toBe(FORMAT);

    const made = await listPuzzleInstances({ projectId, state: 'VALID' });
    expect(made.length).toBeGreaterThanOrEqual(20);
    for (const instance of made) {
      // Every stored instance was checked before it was written, and the
      // checks travel with it — an INVALID one whose reason nobody kept is
      // one nobody can fix the generator from.
      expect(instance.checks.every((check) => check.ok)).toBe(true);
      expect(instance.canonicalHash).not.toBeNull();
      expect(instance.measuredDifficulty).not.toBeNull();
    }

    // No two of them are the same puzzle. That is the canonical form doing
    // work rather than the seeds happening to differ.
    const canonical = new Set(made.map((one) => one.canonicalHash));
    expect(canonical.size).toBe(made.length);

    // And the specification really is the storage: re-rendering any of them
    // reproduces the recorded hash, which is what makes the grid, the
    // solution and the answer key incapable of disagreeing.
    const rendered = await renderInstance(made[0] as (typeof made)[number]);
    expect('artifact' in rendered && rendered.reproduced).toBe(true);

    // ---------------------------------------------------------------
    // 2. A PRODUCT IS COMPILED, and the kernel asks what it needs next.
    // ---------------------------------------------------------------
    const products = await listPuzzleProducts(projectId);
    expect(products).toHaveLength(1);
    expect(products[0]?.instanceCount).toBe(20);

    expect(first.opened.map((one) => one.purpose)).toContain('CHANNEL');

    // ---------------------------------------------------------------
    // 3. A WORKER ANSWERS, through the real tools and the real gate.
    // ---------------------------------------------------------------
    const channelRound = await openRound('CHANNEL');
    await workerAnswers({
      candidateId: channelRound.candidateId,
      question: 'How do word searches reach buyers, and on what terms?',
      claims: [
        {
          claim:
            'The marketplace publishes a 30% share of list price on downloadable activity ' +
            'files, with no exclusivity and payment 60 days after month end.',
          puzzle_finding: 'CHANNEL',
          puzzle_subject: 'An activity-file marketplace',
          puzzle_format: FORMAT,
        },
        {
          claim: 'The marketplace states a 30% commission on every sale.',
          puzzle_finding: 'PRODUCTION_COST',
          puzzle_subject: 'one file sold',
          puzzle_format: FORMAT,
          puzzle_product_class: 'DIGITAL_DOWNLOAD',
          puzzle_value: 'CHANNEL_FEE',
          puzzle_amount_cents: 150,
          puzzle_currency: 'USD',
        },
        {
          claim:
            'Comparable activity packs on that marketplace list at five dollars, of which the ' +
            'seller receives three dollars and fifty cents after the stated commission.',
          puzzle_finding: 'PRICE_POINT',
          puzzle_subject: 'one file sold',
          puzzle_format: FORMAT,
          puzzle_product_class: 'DIGITAL_DOWNLOAD',
          puzzle_value: 'NET_RECEIPT_PER_UNIT',
          puzzle_amount_cents: 350,
          puzzle_currency: 'USD',
        },
      ],
    });

    const second = await runPuzzleKernel(projectId);
    expect(second.filed.settled.length).toBeGreaterThan(0);

    const routes = await listPuzzleRoutes(projectId);
    expect(routes.map((one) => one.kind)).toContain('CHANNEL');
    expect(routes[0]?.terms).toContain('30%');

    const figures = await listPuzzleEconomics(projectId);
    expect(figures.map((one) => one.component).sort()).toEqual([
      'CHANNEL_FEE',
      'NET_RECEIPT_PER_UNIT',
    ]);

    // The money reads as money, from rows a worker declared over the wire.
    const view = await puzzleView(projectId);
    const reading = view.economics.find((one) => one.productClass === 'DIGITAL_DOWNLOAD');
    expect(reading?.withheld).toBeNull();
    expect(reading?.receiptsPerUnitCents).toBe(350);
    expect(reading?.contributionPerUnitCents).toBe(200);

    // ---------------------------------------------------------------
    // 4. THE PRODUCT IS NOT SELLABLE YET, and the reason is a person.
    // ---------------------------------------------------------------
    const beforeEdit = view.maturity.find((one) => one.formatKey === FORMAT);
    expect(beforeEdit?.rung).toBe('PRODUCTIZABLE');
    expect(beforeEdit?.remedy).toBe('PERSON');
    expect(products[0]?.opportunityId ?? null).toBeNull();

    // ---------------------------------------------------------------
    // 5. A PERSON READS WHAT THE MACHINE MADE. There is no flag that
    // stands in for it, which is why this is the transition.
    // ---------------------------------------------------------------
    const recorded = await observe({
      projectId,
      actorRef: userId,
      kind: 'HUMAN_EDIT_PASSED',
      formatName: FORMAT,
      statement: 'Read twenty of them. The fill is ordinary and nothing is ambiguous.',
    });
    expect('observation' in recorded).toBe(true);

    // ---------------------------------------------------------------
    // 6. THE PRODUCT BECOMES PORTFOLIO WORK, through Cash Mode's own
    // machinery rather than a second lifecycle.
    // ---------------------------------------------------------------
    const third = await runPuzzleKernel(projectId);
    expect(third.promoted.length).toBeGreaterThan(0);

    /*
     * Every qualified product is promoted, and the count is whatever the
     * catalog holds rather than a number written here. The second pass made
     * more puzzles and compiled a second product from them, which is the
     * leverage this kernel exists for — one system producing distinct
     * outputs — and pinning it to one would pin the batch size instead of
     * the property.
     */
    const all = await listPuzzleProducts(projectId);
    const after = await puzzleView(projectId);
    const qualified = after.leverage.qualifiedOutputs;
    expect(qualified).toBe(all.length);
    expect(after.leverage.reskins).toBe(0);
    for (const one of all) expect(one.opportunityId).not.toBeNull();

    const promoted = all[0];
    const opportunity = await getOpportunity(promoted?.opportunityId as string);
    expect(opportunity?.title).toBe(promoted?.title);
    // What we are paid, from a published receipt figure. Never the list
    // price, which is what a shopper pays and is most of the margin away.
    expect(opportunity?.priceCents).toBe(350);

    expect(after.maturity.find((one) => one.formatKey === FORMAT)?.rung).toBe('SELLABLE');
    // And the next rung needs a settlement, which no agreement and no
    // acceptance can supply.
    expect(after.maturity.find((one) => one.formatKey === FORMAT)?.remedy).toBe('MONEY');
    expect(after.rightNow.promoted).toBe(all.length);
    expect(after.rightNow.collectedCents).toBe(0);
  }, 120_000);

  it('a buyer arrives through the wire and reaches the map', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    await seedFormat({ projectId, actorRef: userId, name: FORMAT, note: null });
    await runPuzzleKernel(projectId);

    const demand = await openRound('DEMAND');
    await workerAnswers({
      candidateId: demand.candidateId,
      question: 'Who publishes a need for word searches?',
      claims: [
        {
          claim:
            'The magazine publishes contributor guidelines inviting word-search submissions ' +
            'and states what it pays per accepted puzzle.',
          puzzle_finding: 'DEMAND_SIGNAL',
          puzzle_subject: 'A regional magazine',
          puzzle_format: FORMAT,
        },
      ],
    });

    await runPuzzleKernel(projectId);
    const buyers = await listPuzzleDemand(projectId);
    expect(buyers).toHaveLength(1);
    expect(buyers[0]?.buyer).toBe('A regional magazine');
    // Dated from the source, because an undated buying signal cannot be told
    // apart from one somebody remembers from years ago.
    expect(buyers[0]?.observedOn).toBe('2026-08-01');
    expect(buyers[0]?.sourceClaimId).toBeTruthy();
  }, 120_000);

  it('winding the sprint down stops making and asking, and stops nothing else', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    await seedFormat({ projectId, actorRef: userId, name: FORMAT, note: null });
    await runPuzzleKernel(projectId);

    const { setLifecycle } = await import('../server/services/cash/lifecycle.ts');
    const wound = await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'The sprint is over.',
    });
    expect(wound.ok).toBe(true);

    const madeBefore = (await listPuzzleInstances({ projectId, state: 'VALID' })).length;
    const pass = await runPuzzleKernel(projectId);

    // Nothing new was started.
    expect(pass.opened).toHaveLength(0);
    expect(pass.systems).toHaveLength(0);
    expect(pass.batches).toHaveLength(0);
    expect(pass.compiled).toHaveLength(0);
    expect(pass.declined[0]?.why).toBeTruthy();

    // And nothing already made was destroyed or hidden.
    expect((await listPuzzleInstances({ projectId, state: 'VALID' })).length).toBe(madeBefore);
    expect((await listPuzzleProducts(projectId)).length).toBeGreaterThan(0);
    const view = await puzzleView(projectId);
    expect(view.rightNow.validPuzzles).toBe(madeBefore);
  }, 120_000);
});

/**
 * The sentence about what happens next must agree with the capability block
 * printed above it.
 *
 * Found by reading the report against a seeded Brain with no fleet: it said
 * `RESEARCH_A_QUESTION  MISSING` and then, four lines later, "3 question(s)
 * are already being researched ... the next thing happens when one of them
 * settles." Both came from real rows and they cannot both be acted on — and
 * the condition that produces it is a fleet with no healthy surface, which is
 * exactly when an operator reads this.
 *
 * §29's rule: a status that contradicts the control beside it is worse than no
 * status, because it teaches a person to stop reading it.
 */
describe('what happens next, when nothing can answer a question', () => {
  it('names the surface rather than claiming the open rounds are being worked on', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    await seedFormat({ projectId, actorRef: userId, name: FORMAT, note: null });
    await runPuzzleKernel(projectId);

    const view = await puzzleView(projectId);

    // The precondition this exists for: rounds are open, and no surface.
    expect(view.beingMade.openQuestions.length).toBeGreaterThan(0);
    expect(
      view.capabilities.commercial.find((one) => one.id === 'RESEARCH_A_QUESTION')?.state,
    ).not.toBe('PRESENT');

    // It must not say the open rounds are in progress ...
    expect(view.nextAction).not.toMatch(/already being researched/i);
    expect(view.nextAction).not.toMatch(/when one of them settles/i);

    // ... and it must name the condition and whose it is to fix.
    expect(view.nextAction).toMatch(/nothing can answer them|could answer it/i);
    expect(view.nextAction).toMatch(/execution surface/i);
  });

  /*
   * And with a surface that *can* answer, it names the refusal that actually
   * happened rather than a second opinion about it.
   *
   * The first production reading printed *"2 question(s) are already being
   * researched and no slot is free"* against a `MAX_OPEN_PUZZLE_ROUNDS` of
   * three. A slot was free; the slot was never the bound. What had actually
   * stopped the pass is on `plan.declined`, in the allocator's own words and
   * naming the row — with nothing on the map, the one question this kernel can
   * ask already had a live round.
   *
   * An operator reading the old sentence would raise the slot ceiling, and a
   * third slot would have changed nothing. §47 settled the same question the
   * same way one kernel along: the report prints the refusal the producer
   * recorded, because a report with its own copy of the rule is the copy that
   * drifts.
   */
  it('names the refusal the allocator recorded, not a slot that was never the bound', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });

    // One enabled Routine with a secret and a bound worker, which is exactly
    // what `RESEARCH_A_QUESTION` reads — so this reaches the branch the
    // no-surface test above deliberately cannot.
    const account = await createAccount({ name: 'puzzle-capacity' });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_puzzle_capacity',
      name: 'puzzle-capacity',
      tokenSecretName: 'SECRET_PUZZLE_CAPACITY',
      tokenDigest: 'digest_puzzle_capacity',
      workerId,
    });
    expect(
      (await puzzleView(projectId)).capabilities.commercial.find(
        (one) => one.id === 'RESEARCH_A_QUESTION',
      )?.state,
    ).toBe('PRESENT');

    // The first pass opens the one question a bare map can ask; the second
    // finds it live and declines. Two passes rather than one, because what is
    // being pinned is the *decline*.
    await runPuzzleKernel(projectId);
    await runPuzzleKernel(projectId);

    const view = await puzzleView(projectId);
    const open = view.beingMade.openQuestions;
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(MAX_OPEN_PUZZLE_ROUNDS);

    // The bound it must not claim, and the one it must: the allocator's own
    // sentence, naming the round that is already open.
    expect(view.nextAction).not.toMatch(/no slot is free/i);
    expect(view.nextAction).toMatch(/already being asked/i);
    expect(view.nextAction).toContain(open[0]!.roundId);
  });
});

/*
 * The one question that carries no format, asked once rather than once a tick.
 *
 * This is a production reading rather than a hypothesis. On the first tick
 * after the kernel was released, `pzq_b04df7d4c4574c59ad1d` and
 * `pzq_6e4bc50e9a2046b28c52` were both open on one project, both SEED_FORMATS,
 * both round 1 — two of the three concurrent research slots spent asking one
 * question twice.
 *
 * The allocator is not what was wrong: within one pass it finds the live round
 * and declines, because `null === null` holds in JavaScript. §38 states what is
 * supposed to catch the race between two passes — "being pure makes it useless
 * as a safety mechanism… the exclusion is the unique index" — and the index
 * `089` wrote keyed on `format_key` and `product_class` directly, which are
 * NULL for exactly this question and therefore distinct from each other on both
 * backends.
 *
 * So the test drives the repository rather than the kernel: what has to be
 * proved is that the **second insert loses**, and a test that ran two ticks
 * would prove the allocator's filter instead and pass either way.
 *
 * ---------------------------------------------------------------------------
 * Why nothing reported it, which writing this guard is what established
 * ---------------------------------------------------------------------------
 *
 * `created` is not the discriminator, and asserting it alone would have been a
 * guard that passes against the very defect it names. `openPuzzleRound` reads
 * back by the natural key and answers `created: rows[0].id === id` — so with
 * two rows present the read matches **both**, `rows[0]` is the earlier one, and
 * the pass that genuinely *did* write a duplicate is told it lost. Its caller
 * then does exactly what a loser should: `if (!opened.created) continue`, with
 * no `cash_events` row written.
 *
 * Which is why production ran one question twice with its own append-only
 * history recording a single opening. The row count is therefore the assertion
 * that binds, and `created` is kept beside it as the ordinary-outcome contract
 * rather than as the proof.
 */
describe('the bootstrap question opens once, because NULL is not a key', () => {
  it('refuses a second live round for the question that carries no format', async () => {
    expect(
      (
        await activate({
          projectId,
          ownerUserId: userId,
          actorUserId: userId,
          objective: 'Maximize additional usable cash over the next few weeks.',
        })
      ).ok,
    ).toBe(true);

    const mode = await getCashMode(projectId);
    expect(mode).not.toBeNull();

    const ask = {
      projectId,
      cashModeId: mode!.id,
      purpose: 'SEED_FORMATS' as const,
      formatKey: null,
      productClass: null,
      round: 1,
    };

    // Two passes that each read a snapshot with no open round and each decided
    // correctly. Different candidates, because each pass captured its own.
    const first = await openPuzzleRound({ ...ask, candidateId: 'rcn_first_pass' });
    const second = await openPuzzleRound({ ...ask, candidateId: 'rcn_second_pass' });

    // The assertion that binds: one row, whichever pass got there first, and
    // it is the first pass's candidate that the surviving round points at —
    // so the second pass's candidate is the orphan `openPuzzleAsks` describes
    // rather than a second live question.
    const opened = (await listPuzzleRounds(projectId)).filter(
      (one) => one.purpose === 'SEED_FORMATS',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.candidateId).toBe('rcn_first_pass');

    // And the ordinary-outcome contract beside it: a loser reads back the round
    // that won rather than reporting a failure, which is what the natural-key
    // read-back exists for. Passes against the defect too — see the note above.
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.round.id).toBe(first.round.id);
  });
});

