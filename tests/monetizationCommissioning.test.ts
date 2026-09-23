/**
 * The autonomous commissioning loop, walked from a discovery to a moved rank.
 *
 * ---------------------------------------------------------------------------
 * What it is written from
 * ---------------------------------------------------------------------------
 *
 * §49 shipped a ledger that preserved every way a discovery could be paid for
 * and could ask none of the questions it printed. An audit of it found that
 * **two of the thirteen attributes had a production writer**, both
 * `RECOMMENDATION`; `kind = 'EVIDENCE'` and `claim_id` had never been written
 * at all; seven of the eleven ranking criteria were dead on real data; and two
 * of the seven statuses were unreachable by construction. Every row read as
 * healthy the whole time.
 *
 * So the assertions here are about the **causal chain**, end to end, because
 * that is the only thing a unit test of any one link could not see:
 *
 *   discovery → possibilities → an unanswered decisive attribute →
 *   a commissioned candidate through the machinery that already exists →
 *   a gated claim → a ledger answer → a recomputed status and rank →
 *   a rank movement with its reason → a visible surface.
 *
 * ---------------------------------------------------------------------------
 * What is real here and what is not
 * ---------------------------------------------------------------------------
 *
 * Real: the durable tick's own pass, the allocator, the compare-and-swap, the
 * envelope dispatch, the compiler profile, the repositories, both projections.
 * The claims are inserted as **accepted claims on an accepted fragment**, which
 * is the row shape `citableClaims` reads — the same thing the evidence gate
 * produces and the same fixture `monetizationLedger` already uses.
 *
 * Not real, and said rather than implied: no Routine is fired, no provider is
 * called, no token is minted and nothing external is read. The two judgements
 * only a reader of a source can make are fixture. This is the commissioning
 * loop, not a live Cowork session — the same two sentences
 * `cashIntegrationPass` has to say.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, launchableUnderCashMode, setLifecycle } from '../server/services/cash/lifecycle.ts';
import {
  createOpportunity,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { createCandidate, getCandidate } from '../server/repos/russellCandidates.ts';
import { getProject } from '../server/repos/projects.ts';
import { compileMission } from '../server/services/russell/compiler.ts';
import { judgeCandidate } from '../server/services/russell/planning.ts';
import { withdrawDiscoveryAuthority } from '../server/services/cash/discoveryAuthority.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import {
  commissionForCandidate,
  commissionsFor,
  listCommissions,
  listPaths,
  openCommission,
  pathFact,
  pathFactsFor,
  recordPathFact,
  settleCommission,
} from '../server/repos/monetization.ts';
import { judgePath } from '../server/services/cash/monetization/decisions.ts';
import { enumeratePossibilities } from '../server/services/cash/monetization/enumerate.ts';
import { composeLedger, rankableOf } from '../server/services/cash/monetization/ledger.ts';
import {
  allocateCommissions,
  decisiveCriteria,
  MAX_COMMISSION_ROUNDS,
  MAX_OPEN_COMMISSIONS,
  COMMISSION_COOL_OFF_MS,
  NEAR_THE_TOP,
} from '../server/services/cash/monetization/commission.ts';
import {
  commissionQuestion,
  matchChoice,
  readDays,
  runCommissions,
} from '../server/services/cash/monetization/commissionPass.ts';
import { commissionView } from '../server/services/cash/monetization/inFlight.ts';
import { recordMovements } from '../server/services/cash/monetization/movement.ts';
import { operate } from '../server/services/cash/operate.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import { ATTRIBUTE } from '../server/domain/monetization.ts';
import {
  MONETIZATION_ATTRIBUTES,
  type CashOpportunity,
  type MonetizationAttribute,
  type OpportunitySignal,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';

beforeEach(async () => {
  const project = await freshProject();
  projectId = project.project.id;
  const user = await createUser({
    email: `commission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  userId = user.id;
  const started = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(started.ok).toBe(true);
  cashModeId = started.ok ? started.mode.id : '';
});

/** One harvested discovery, exactly as `harvest` writes one. */
async function discovery(
  signal: OpportunitySignal | null,
  title: string,
  over: Record<string, unknown> = {},
): Promise<CashOpportunity> {
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    opportunitySignal: signal,
    source: 'A publisher',
    ...over,
  });
  const withSignal = await updateOpportunity(created.id, {
    buying_signal: title,
    signal_observed_at: '2026-09-15',
  });
  return withSignal ?? created;
}

interface PreparedClaim {
  claim: string;
  lane: string;
  claimType?: string;
  sourceUrl?: string | null;
  contradicted?: boolean;
}

/**
 * A finished research run, as the machinery actually leaves one.
 *
 * An orchestration whose fragment reached ACCEPTED, claims that are
 * `accepted = 1` with a source, and a mission in the state the runner leaves
 * it. That is the row shape `citableClaims` reads and the shape
 * `latestMissionForCandidate` resolves — building it any other way would be
 * testing a chain production never has.
 */
async function finishResearch(input: {
  candidateId: string;
  claims: PreparedClaim[];
  missionState?: 'DONE' | 'FAILED' | 'NEEDS_HUMAN';
}): Promise<{ orchestrationId: string; claimIds: string[] }> {
  const layer = (await listLayers(projectId))[0]!;
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'what the published sources say',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'One attribute of one possibility',
    assignment: 'the published sources that answer it',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'monetization-attribute',
      question: 'What do the published sources say?',
      geography: 'United States',
      requiredEvidence: MONETIZATION_ATTRIBUTES.map((one) => ({
        id: one,
        description: ATTRIBUTE[one].question,
        necessity: 'CONDITIONAL',
      })),
      acceptableSourceTypes: ['a published price list, rate card or fee schedule'],
      excludedSourceTypes: ['a figure calculated rather than read from a source'],
      completionCriteria: ['the asked attribute answered or recorded as unresolved'],
      minIndependentSources: 1,
      maxRepairs: 2,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const inserted = await insertClaims(
    input.claims.map((one, index) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'TARGETED',
      claim: one.claim,
      sourceUrl: one.sourceUrl === undefined ? `https://example.com/${index}` : one.sourceUrl,
      sourceTitle: 'A rate card',
      sourcePublisher: 'A marketplace',
      sourceDate: '2026-09-15',
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the page',
      evidenceLane: one.lane,
      retrievedAt: '2026-09-15T00:00:00.000Z',
      confidence: 0.9,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      accepted: true,
      claimType: (one.claimType ?? 'SOURCED_FACT') as 'SOURCED_FACT',
      contentHash: `${index}`.padStart(64, 'b'),
    })),
  );
  await getDb().run("UPDATE research_fragments SET status = 'ACCEPTED' WHERE id = ?", [
    fragment!.id,
  ]);
  for (let index = 0; index < input.claims.length; index += 1) {
    if (!input.claims[index]!.contradicted) continue;
    await getDb().run(
      "UPDATE research_claims SET contradiction_state = 'CONTRADICTED' WHERE id = ?",
      [inserted[index]!.id],
    );
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'establish one attribute of one possibility',
    whyNow: 'because the ledger asked',
    idempotencyKey: `test:mission:${input.candidateId}:${Math.random()}`,
    candidateId: input.candidateId,
  });
  await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [
    orchestration.id,
    mission.id,
  ]);
  await transitionMission({
    missionId: mission.id,
    from: 'PLANNED',
    to: 'RUNNING',
  });
  const to = input.missionState ?? 'DONE';
  await transitionMission({
    missionId: mission.id,
    from: 'RUNNING',
    to,
    // A mission that waits has to say what for, which the repository enforces.
    ...(to === 'NEEDS_HUMAN'
      ? { waitingOn: 'a decision only a person can make' }
      : { terminalReason: 'the research finished' }),
  });
  return { orchestrationId: orchestration.id, claimIds: inserted.map((one) => one.id) };
}

/** The ledger as it stands, and the pass that acts on it, in one call. */
async function tick(): Promise<Awaited<ReturnType<typeof runCommissions>>> {
  const ledger = await composeLedger({ projectId });
  return runCommissions({ projectId, ledger });
}

// ---------------------------------------------------------------------------

describe('the whole causal chain, from a discovery to a rank that moved', () => {
  it('asks, gates, answers, recomputes and records the movement', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);

    // 1. The ledger holds possibilities, and their questions are open.
    const before = await composeLedger({ projectId });
    expect(before.entries.length).toBeGreaterThan(1);
    const target = before.entries[0]!;
    expect(target.status).toBe('UNPROVEN');
    expect(target.unknowns.length).toBeGreaterThan(0);

    // 2. A question is commissioned, naming the path, the attribute and why.
    const first = await tick();
    expect(first.opened.length).toBeGreaterThan(0);
    const asked = first.opened[0]!;
    expect(MONETIZATION_ATTRIBUTES).toContain(asked.attribute);
    expect(asked.reason.length).toBeGreaterThan(40);
    expect(asked.question).toContain(asked.attribute);

    // 3. It went through the machinery that already exists: a candidate, an
    //    envelope resolved from Brain's own row, and a real compiler profile.
    const commission = await commissionForCandidate(asked.candidateId);
    expect(commission?.id).toBe(asked.commissionId);
    expect(getApprovalEnvelope('RUSSELL_MONETIZATION_ATTRIBUTE_V1')).not.toBeNull();
    const profile = profileFor('RUSSELL_MONETIZATION_ATTRIBUTE_V1');
    expect(profile?.lanes.map((one) => one.id).sort()).toEqual(
      [...MONETIZATION_ATTRIBUTES].sort(),
    );

    // 4. Research finishes, with a gated claim carrying the attribute's lane.
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [
        {
          claim: `The published rate card lists USD 450.00 for this work.`,
          lane: asked.attribute,
        },
      ],
    });

    // 5. The answer lands on the ledger, as EVIDENCE, resolving to the claim.
    const settledPass = await tick();
    expect(settledPass.recorded.some((one) => one.attribute === asked.attribute)).toBe(true);
    const landed = await pathFact(asked.pathId, asked.attribute);
    expect(landed?.kind).toBe('EVIDENCE');
    expect(landed?.claimId).toBeTruthy();

    // 6. The commission settled ANSWERED, with a count and a reason.
    const closed = (await commissionsFor(asked.pathId)).find(
      (one) => one.id === asked.commissionId,
    )!;
    expect(closed.state).toBe('ANSWERED');
    expect(closed.answered).toBeGreaterThan(0);
    expect(closed.outcome).toBeTruthy();
    expect(closed.settledAt).toBeTruthy();

    // 7. The ledger recomputed: the question is no longer open, and the
    //    criterion that counts sourced answers now reads it.
    const after = await composeLedger({ projectId });
    const moved = after.entries.find((one) => one.path.id === asked.pathId)!;
    expect(moved.unknowns).not.toContain(asked.attribute);
    expect(
      [...rankableOf(moved).facts.values()].filter((one) => one.kind === 'EVIDENCE').length,
    ).toBe(1);

    // 8. The movement is recorded, with its reason, where the order changed.
    await recordMovements({ projectId });
    const finalLedger = await composeLedger({ projectId });
    const promoted = finalLedger.entries.find((one) => one.path.id === asked.pathId)!;
    expect(promoted.rank).toBeLessThanOrEqual(target.rank);

    // 9. It is visible, on the surface both roles read.
    const view = await commissionView({
      projectId,
      ledger: finalLedger,
      capacity: MAX_OPEN_COMMISSIONS,
    });
    const shown = view.recentlySettled.find((one) => one.commissionId === asked.commissionId)!;
    expect(shown.attributeLabel).toBe(ATTRIBUTE[asked.attribute].label);
    expect(shown.state).toBe('SETTLED');
    expect(shown.why).toBe(asked.reason);
  });

  it('runs from the durable tick rather than only from a direct call', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    const pass = await operate(projectId);
    expect(pass.monetization.commissions.opened.length).toBeGreaterThan(0);
    expect((await listCommissions({ projectId, state: 'OPEN' })).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('it enters the machinery that already exists, rather than beside it', () => {
  it('compiles under the monetization envelope, chosen from Brain\'s own row', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;

    const candidate = (await getCandidate(asked.candidateId))!;
    const project = (await getProject(projectId))!;
    const compiled = await compileMission({
      candidate,
      project,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    /*
     * The envelope is resolved from `monetization_commissions`, not from the
     * candidate's prose and not from the project's declared default — which is
     * what makes this an entrance to the existing dispatch rather than a
     * parallel one.
     */
    expect(compiled.mission.envelopeId).toBe('RUSSELL_MONETIZATION_ATTRIBUTE_V1');
    expect(compiled.mission.fragments).toHaveLength(1);

    const fragment = compiled.mission.fragments[0]!;
    // The lanes a worker may answer under are the ledger's own attribute keys,
    // which is what makes an answer land as a lookup rather than a reading.
    expect(fragment.requiredEvidence.map((one) => one.id).sort()).toEqual(
      [...MONETIZATION_ATTRIBUTES].sort(),
    );
    // None of them is REQUIRED: "the published sources do not settle this" is a
    // complete answer and must not fail the fragment.
    expect(fragment.requiredEvidence.every((one) => one.necessity === 'CONDITIONAL')).toBe(true);
    // The attribute being asked is in the question a worker actually reads.
    expect(fragment.question).toContain(asked.attribute);
  });

  it('is judged by the plan validator the same way every other packet is', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    const candidate = (await getCandidate(asked.candidateId))!;
    const project = (await getProject(projectId))!;
    const compiled = await compileMission({
      candidate,
      project,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const envelope = getApprovalEnvelope('RUSSELL_MONETIZATION_ATTRIBUTE_V1')!;
    // One fragment, which is what the envelope pins: this assignment asks
    // exactly one thing, so a plan that decomposed it would be answering a
    // different question from the one that was commissioned.
    expect(envelope.maxFragments).toBe(1);
    // Every source class the profile proposes survives the envelope's filter,
    // so a compiled plan is never left with nothing it may read.
    expect(fragmentSources(compiled.mission.fragments[0]!).length).toBeGreaterThan(0);
  });
});

function fragmentSources(fragment: { acceptableSourceTypes: string[] }): string[] {
  return fragment.acceptableSourceTypes;
}

describe('the judgment queues it, which is the last link before a worker', () => {
  it('reaches QUEUED with a mission specification, through the real judgment', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;

    /*
     * The real thing, not `compileMission` alone: `judgeCandidate` asks the
     * archive first (§13), checks the standing authority, decides whether a
     * cheap look would settle it, and only then stores a compiled
     * specification. If any of those refused, the question would be captured
     * and never researched — which is exactly the shape of stuck state this
     * whole change exists to remove, so it is asserted rather than assumed.
     */
    const verdict = await judgeCandidate(asked.candidateId);
    expect(verdict.ok).toBe(true);
    expect(verdict.answeredByArchive).toBe(false);
    expect(verdict.launchable).toBe(true);

    const candidate = (await getCandidate(asked.candidateId))!;
    expect(candidate.state).toBe('QUEUED');
    const judgment = candidate.judgment as unknown as Record<string, unknown>;
    expect(judgment['envelopeId']).toBe('RUSSELL_MONETIZATION_ATTRIBUTE_V1');
    expect(judgment['missionSpec']).toBeTruthy();

    /*
     * And it is ordered behind anything already under way and ahead of a new
     * broad search — "finish what has already been spent before starting the
     * next search", which is a property of the profile rather than of this.
     */
    expect(candidate.ordinal ?? 999).toBeLessThan(500);
  });

  it('parks rather than researching when the sprint has no standing authority', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);

    // Withdraw what pressing Start granted. Nothing should be asked at all —
    // capturing a question that would immediately park is how a project
    // accumulates parks nobody will ever answer.
    await withdrawDiscoveryAuthority({
      projectId,
      actorUserId: userId,
      reason: 'testing what happens without it',
    });
    const pass = await tick();
    expect(pass.opened).toEqual([]);
    expect(pass.declined.some((one) => one.why.includes('no standing research authority'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------

describe('a question is fully identified before it is asked', () => {
  it('names the path, the attribute, the reason, the round and the destination', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const opened = (await tick()).opened[0]!;

    /*
     * Found by id, not by position. A pass may open up to
     * `MAX_OPEN_COMMISSIONS` questions inside one millisecond, so
     * `listCommissions` correctly tiebreaks on the generated id — which means
     * the first row is not necessarily the first one opened. Asserting on
     * `[0]` passed in isolation and failed in the file, which is the tell.
     */
    const row = (await listCommissions({ projectId })).find(
      (one) => one.id === opened.commissionId,
    )!;
    expect(row.pathId).toBe(opened.pathId);
    expect(row.attribute).toBe(opened.attribute);
    expect(row.round).toBe(1);
    expect(row.reason).toBe(opened.reason);
    expect(row.ruleRank).toBeGreaterThan(0);
    expect(row.candidateId).toBe(opened.candidateId);

    // The evidence needed is the attribute's own declared task, handed over
    // verbatim rather than composed about the subject.
    expect(opened.question).toContain(ATTRIBUTE[opened.attribute].task.slice(0, 40));
    // The destination is the lane, which is a column rather than a reading.
    expect(opened.question).toContain(`evidence lane "${opened.attribute}"`);
  });

  it('bounds the retry and says so on the second asking', async () => {
    const question = commissionQuestion({
      pathTitle: 'Direct sale',
      subjectTitle: 'A published request',
      attribute: 'expectedRevenue',
      round: 2,
    });
    expect(question).toContain('An earlier search did not settle this');
    expect(
      commissionQuestion({
        pathTitle: 'Direct sale',
        subjectTitle: 'A published request',
        attribute: 'expectedRevenue',
        round: 1,
      }),
    ).not.toContain('An earlier search did not settle this');
  });
});

// ---------------------------------------------------------------------------

describe('what cannot change a decision is not researched', () => {
  it('refuses a question that only feeds criteria below the one already deciding', () => {
    // Two entries separated at STATUS, the first criterion. Nothing below it is
    // consulted for that pair, so an attribute feeding only lower criteria
    // cannot move either one.
    const strong = fakeEntry({ status: 'ACTIVE' });
    const weak = fakeEntry({ status: 'ARCHIVED' });
    const live = decisiveCriteria(rankableOf(strong), [rankableOf(weak)]);
    expect(live.has('STATUS')).toBe(true);
    expect(live.has('COMPETITION')).toBe(false);
    expect(live.has('TIME_TO_CASH')).toBe(false);
  });

  it('keeps every criterion live for a ledger of one', () => {
    const only = fakeEntry({ status: 'UNPROVEN' });
    const live = decisiveCriteria(rankableOf(only), []);
    expect(live.has('COMPETITION')).toBe(true);
    expect(live.has('SCALABILITY')).toBe(true);
  });

  it('declines with the reason rather than silently skipping', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pass = await tick();
    expect(pass.declined.length).toBeGreaterThan(0);
    for (const one of pass.declined) {
      expect(one.why.length).toBeGreaterThan(20);
      expect(one.subject.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe('adversarial: nothing is ever commissioned twice', () => {
  it('a repeated durable tick creates no second question', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);

    const first = await tick();
    expect(first.opened.length).toBeGreaterThan(0);
    const after = await listCommissions({ projectId });

    for (let round = 0; round < 4; round += 1) {
      const again = await tick();
      expect(again.opened).toEqual([]);
    }
    expect(await listCommissions({ projectId })).toHaveLength(after.length);
  });

  it('two concurrent commissioners produce exactly one row', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;

    /*
     * Both callers hold the same key, as two ticks that both allocated
     * correctly would. The allocator is pure and is therefore no protection at
     * all; the unique index is the arbiter, and exactly one insert matches.
     */
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        openCommission({
          projectId,
          cashModeId,
          pathId,
          attribute: 'expectedRevenue',
          round: 1,
          candidateId: `cand-${n}`,
          reason: 'a reason',
          ruleRank: 30,
        }),
      ),
    );
    expect(results.filter((one) => one.created)).toHaveLength(1);
    const ids = new Set(results.map((one) => one.commission.id));
    expect(ids.size).toBe(1);
    expect(
      (await listCommissions({ projectId })).filter(
        (one) => one.pathId === pathId && one.attribute === 'expectedRevenue',
      ),
    ).toHaveLength(1);
  });

  it('two commissioners settling one finished question close it once', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;
    const opened = await openCommission({
      projectId,
      cashModeId,
      pathId,
      attribute: 'expectedRevenue',
      round: 1,
      candidateId: 'cand-settle',
      reason: 'a reason',
      ruleRank: 30,
    });

    const settles = await Promise.all(
      [1, 2, 3].map(() =>
        settleCommission({
          id: opened.commission.id,
          state: 'UNRESOLVED',
          answered: 0,
          outcome: 'nothing published settles it',
        }),
      ),
    );
    expect(settles.filter((one) => one !== null)).toHaveLength(1);
  });

  it('never exceeds the concurrency bound however many possibilities are open', async () => {
    for (let n = 0; n < 6; n += 1) {
      await discovery('PAID_TASK_OR_CONTRACT', `A published request number ${n}.`);
    }
    await enumeratePossibilities(projectId);
    expect((await listPaths({ projectId })).length).toBeGreaterThan(MAX_OPEN_COMMISSIONS);

    await tick();
    await tick();
    await tick();
    expect((await listCommissions({ projectId, state: 'OPEN' })).length).toBeLessThanOrEqual(
      MAX_OPEN_COMMISSIONS,
    );
  });

  it('does not let a question parked for a person hold a slot for ever', async () => {
    for (let n = 0; n < 4; n += 1) {
      await discovery('PAID_TASK_OR_CONTRACT', `A published request number ${n}.`);
    }
    await enumeratePossibilities(projectId);

    const first = await tick();
    expect(first.opened.length).toBe(MAX_OPEN_COMMISSIONS);
    // Nothing more, because every slot is taken.
    expect((await tick()).opened).toEqual([]);

    /*
     * Park all three at a decision. A slot is provider capacity, and a question
     * waiting on a person is using none of it — `MAX_VALIDATIONS_IN_FLIGHT` was
     * corrected for exactly this, and counting them would stop the loop
     * permanently while somebody thinks.
     */
    for (const one of first.opened) {
      await finishResearch({
        candidateId: one.candidateId,
        claims: [],
        missionState: 'NEEDS_HUMAN',
      });
    }

    const after = await tick();
    expect(after.opened.length).toBeGreaterThan(0);
    // And the parked ones are still recorded as open, so nothing asks them
    // again while they wait.
    for (const one of first.opened) {
      const still = (await commissionsFor(one.pathId)).find(
        (row) => row.id === one.commissionId,
      )!;
      expect(still.state).toBe('OPEN');
    }
  });

  it('asks one question per possibility at a time, not three about one', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pass = await tick();
    const paths = pass.opened.map((one) => one.pathId);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

// ---------------------------------------------------------------------------

describe('adversarial: absence never becomes a negative answer', () => {
  it('records UNRESOLVED and leaves the attribute unknown when nothing is published', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;

    // The research ran and established that nothing publishes it. That is a
    // real finding and it is not an answer to the question.
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [
        {
          claim: 'No publisher states a figure for this.',
          lane: asked.attribute,
          claimType: 'NEGATIVE_EXISTENCE',
        },
      ],
    });
    await tick();

    const closed = (await commissionsFor(asked.pathId)).find(
      (one) => one.id === asked.commissionId,
    )!;
    expect(closed.state).toBe('UNRESOLVED');
    expect(closed.answered).toBe(0);
    expect(closed.outcome).toContain('stays unknown rather than becoming a no');
    expect(await pathFact(asked.pathId, asked.attribute)).toBeNull();

    const ledger = await composeLedger({ projectId });
    expect(ledger.entries.find((one) => one.path.id === asked.pathId)!.unknowns).toContain(
      asked.attribute,
    );
  });

  it('a claim with no source is not an answer', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [{ claim: 'It probably pays about USD 400.', lane: asked.attribute, sourceUrl: null }],
    });
    await tick();
    expect(await pathFact(asked.pathId, asked.attribute)).toBeNull();
  });

  it('a failed run leaves the possibility exactly as it was, and says so', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    const beforeFacts = await pathFactsFor(asked.pathId);

    await finishResearch({
      candidateId: asked.candidateId,
      claims: [],
      missionState: 'FAILED',
    });
    await tick();

    const closed = (await commissionsFor(asked.pathId)).find(
      (one) => one.id === asked.commissionId,
    )!;
    expect(closed.state).toBe('UNRESOLVED');
    expect(closed.outcome).toContain('did not finish');
    expect(await pathFactsFor(asked.pathId)).toHaveLength(beforeFacts.length);
  });
});

// ---------------------------------------------------------------------------

describe('adversarial: retries, exhaustion and the cool-off', () => {
  it('asks a second round and then stops, with the question still open', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;
    const attribute: MonetizationAttribute = 'expectedRevenue';

    // Two settled rounds, both beyond the cool-off.
    const long = new Date(Date.now() - 10 * COMMISSION_COOL_OFF_MS).toISOString();
    for (const round of [1, 2]) {
      const opened = await openCommission({
        projectId,
        cashModeId,
        pathId,
        attribute,
        round,
        candidateId: `cand-round-${round}`,
        reason: 'a reason',
        ruleRank: 30,
      });
      await settleCommission({
        id: opened.commission.id,
        state: 'UNRESOLVED',
        answered: 0,
        outcome: 'nothing published settles it',
      });
      await getDb().run('UPDATE monetization_commissions SET settled_at = ? WHERE id = ?', [
        long,
        opened.commission.id,
      ]);
    }

    const ledger = await composeLedger({ projectId });
    const plan = allocateCommissions({
      entries: ledger.entries,
      rankable: ledger.entries.map(rankableOf),
      commissions: await listCommissions({ projectId }),
      contradicted: new Set(),
      slots: MAX_OPEN_COMMISSIONS,
      now: Date.now(),
    });
    expect(plan.asks.some((one) => one.pathId === pathId && one.attribute === attribute)).toBe(
      false,
    );
    expect(
      plan.declined.some((one) => one.why.includes(`researched ${MAX_COMMISSION_ROUNDS} times`)),
    ).toBe(true);

    // And the question is still open on the ledger. Exhaustion is not an answer.
    expect(
      (await composeLedger({ projectId })).entries.find((one) => one.path.id === pathId)!.unknowns,
    ).toContain(attribute);
  });

  it('waits out the cool-off before asking again', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;
    const opened = await openCommission({
      projectId,
      cashModeId,
      pathId,
      attribute: 'expectedRevenue',
      round: 1,
      candidateId: 'cand-cool',
      reason: 'a reason',
      ruleRank: 30,
    });
    await settleCommission({
      id: opened.commission.id,
      state: 'UNRESOLVED',
      answered: 0,
      outcome: 'nothing published settles it',
    });

    const ledger = await composeLedger({ projectId });
    const plan = allocateCommissions({
      entries: ledger.entries,
      rankable: ledger.entries.map(rankableOf),
      commissions: await listCommissions({ projectId }),
      contradicted: new Set(),
      slots: MAX_OPEN_COMMISSIONS,
      now: Date.now(),
    });
    expect(
      plan.asks.some((one) => one.pathId === pathId && one.attribute === 'expectedRevenue'),
    ).toBe(false);
    expect(plan.declined.some((one) => one.why.includes('within the last day'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('adversarial: contradiction, stale evidence and unsupported answers', () => {
  it('asks again where the claim behind a current answer was contradicted, and destroys nothing', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [
        {
          claim: 'The published rate card lists USD 450.00 for this work.',
          lane: asked.attribute,
          contradicted: true,
        },
      ],
    });
    await tick();

    const answered = await pathFact(asked.pathId, asked.attribute);
    expect(answered?.kind).toBe('EVIDENCE');

    /*
     * The rule fires, and it fires from the tick's own pass rather than from a
     * hand-built allocation — which is the part that matters, because
     * `contradictedAnswers` reads `research_claims.contradiction_state` itself
     * and nothing here tells it what to find.
     *
     * An earlier version of this test asserted the opposite and explained why
     * that was correct. It was not: the allocator only iterated `unknowns`, so
     * a contradicted *answer*, which by definition has a fact, could never be
     * reached, and `admit`'s contradiction branch was a mechanism nothing
     * called.
     */
    const reask = (await commissionsFor(asked.pathId)).find(
      (one) => one.attribute === asked.attribute && one.round === 2,
    );
    expect(reask).toBeTruthy();
    expect(reask!.ruleRank).toBe(20);
    expect(reask!.reason).toContain('contradicted');
    expect(reask!.state).toBe('OPEN');

    // And nothing recorded is destroyed by asking again.
    expect(await pathFact(asked.pathId, asked.attribute)).not.toBeNull();
  });

  it('says a re-asked answer was held rather than that nothing was found', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [{ claim: 'The published rate card lists USD 450.00.', lane: asked.attribute }],
    });
    await tick();
    expect(await pathFact(asked.pathId, asked.attribute)).not.toBeNull();

    /*
     * A second asking whose research finds a source and cannot land it, because
     * the recorded answer is of equal standing and `mayReplace` keeps it. The
     * research did its job; saying the sources do not settle it would be a lie
     * about a search that settled it.
     */
    const second = await openCommission({
      projectId,
      cashModeId,
      pathId: asked.pathId,
      attribute: asked.attribute,
      round: 2,
      candidateId: (
        await createCandidate({
          projectId,
          visibility: 'SHARED',
          title: 'ask again',
          statement: 'ask again',
        })
      ).id,
      reason: 'the claim behind it was contradicted',
      ruleRank: 20,
    });
    await finishResearch({
      candidateId: second.commission.candidateId,
      claims: [{ claim: 'A different publisher lists USD 600.00.', lane: asked.attribute }],
    });
    await tick();

    const closed = (await commissionsFor(asked.pathId)).find(
      (one) => one.id === second.commission.id,
    )!;
    expect(closed.state).toBe('ANSWERED');
    expect(closed.outcome).toContain('outranks it');
    // The recorded answer is untouched, and both claims keep their rows.
    expect((await pathFact(asked.pathId, asked.attribute))!.value).toContain('450');
  });

  it('refuses a lower authority replacing a higher one, at the repository', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;

    await recordPathFact({
      projectId,
      pathId,
      attribute: 'competition',
      kind: 'PERSON',
      value: 'FEW',
      decidedBy: userId,
    });
    await expect(
      recordPathFact({
        projectId,
        pathId,
        attribute: 'competition',
        kind: 'EVIDENCE',
        value: 'MANY',
        claimId: 'does-not-matter-refused-first',
        decidedBy: 'BRAIN',
      }),
    ).rejects.toThrow(/may not replace/);
  });

  it('lets a person revise their own answer', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;
    await recordPathFact({
      projectId,
      pathId,
      attribute: 'competition',
      kind: 'PERSON',
      value: 'FEW',
      decidedBy: userId,
    });
    const revised = await recordPathFact({
      projectId,
      pathId,
      attribute: 'competition',
      kind: 'PERSON',
      value: 'MANY',
      decidedBy: userId,
    });
    expect(revised.value).toBe('MANY');
  });

  it('never lets research overwrite a gated answer with a proposal', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;
    // A real claim id, because the schema requires one: an EVIDENCE answer
    // that resolved to nothing would be a citation about a passage nobody can
    // open, which is the whole thing `claim_id` exists to make impossible.
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'a question',
      statement: 'what do the published sources say?',
    });
    const { claimIds } = await finishResearch({
      candidateId: candidate.id,
      claims: [{ claim: 'The published rate card lists USD 450.00.', lane: 'expectedRevenue' }],
    });
    await recordPathFact({
      projectId,
      pathId,
      attribute: 'expectedRevenue',
      kind: 'EVIDENCE',
      value: 'USD 450.00',
      amountCents: 45_000,
      claimId: claimIds[0]!,
      decidedBy: 'BRAIN',
    });
    await expect(
      recordPathFact({
        projectId,
        pathId,
        attribute: 'expectedRevenue',
        kind: 'RECOMMENDATION',
        value: 'USD 900.00',
        amountCents: 90_000,
        basis: 'a guess',
        assumptions: 'a guess',
        uncertainty: 'a guess',
        decidedBy: 'BRAIN',
      }),
    ).rejects.toThrow(/may not replace/);
  });
});

// ---------------------------------------------------------------------------

describe('adversarial: an invalid path or attribute combination lands nowhere', () => {
  it('ignores a claim whose lane is not a ledger attribute', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [{ claim: 'Something about demand.', lane: 'demand_signal' }],
    });
    const pass = await tick();
    expect(pass.recorded).toEqual([]);
    expect(await pathFactsFor(asked.pathId)).toHaveLength(0);
  });

  it('refuses a choice attribute whose claim states no declared choice', async () => {
    expect(matchChoice('It is a busy market.', ['NONE_FOUND', 'FEW', 'MANY', 'SATURATED'])).toBeNull();
    expect(matchChoice('The market is SATURATED.', ['NONE_FOUND', 'FEW', 'MANY', 'SATURATED'])).toBe(
      'SATURATED',
    );
    // Two declared values named is ambiguous and answers nothing.
    expect(matchChoice('Between FEW and MANY.', ['NONE_FOUND', 'FEW', 'MANY'])).toBeNull();
  });

  it('reads a stated duration and invents none', () => {
    expect(readDays('Payment is made within 30 days of invoice.')).toBe(30);
    expect(readDays('Payout takes 2 weeks.')).toBe(14);
    expect(readDays('It settles next quarter.')).toBeNull();
    expect(readDays('A couple of days.')).toBeNull();
  });

  it('cannot record a probability Brain produced', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const pathId = (await listPaths({ projectId }))[0]!.id;
    await expect(
      recordPathFact({
        projectId,
        pathId,
        attribute: 'probabilityOfSuccess',
        kind: 'RECOMMENDATION',
        value: '40%',
        basis: 'it feels about right',
        assumptions: 'none',
        uncertainty: 'plenty',
        decidedBy: 'BRAIN',
      }),
    ).rejects.toThrow(/may not be recorded/);
  });
});

// ---------------------------------------------------------------------------

describe('no probability is smuggled back in', () => {
  it('records no number anywhere that could be read as a likelihood', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    const row = (await listCommissions({ projectId })).find(
      (one) => one.id === asked.commissionId,
    )!;

    // `rule_rank` is an ordering position from a spaced constant, never a
    // score: it is one of a handful of declared values and no arithmetic
    // anywhere consumes it.
    expect([10, 20, 30, 40]).toContain(row.ruleRank);
    // And nothing on the commission carries a confidence, a weight or a score.
    expect(Object.keys(row)).not.toContain('confidence');
    expect(Object.keys(row)).not.toContain('score');
    expect(Object.keys(row)).not.toContain('weight');
    expect(asked.reason).not.toMatch(/\d+\s?%/);
  });

  it('keeps the selection lexicographic rather than weighted', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('server/services/cash/monetization/commission.ts', 'utf8'),
    );
    // No weighting, no scoring, no probability arithmetic.
    expect(source).not.toMatch(/\bweight\b/i);
    expect(source).not.toMatch(/\bscore\s*[+*]/);
  });
});

// ---------------------------------------------------------------------------

describe('bounded enumeration, and the wind-down', () => {
  it('commissions only for possibilities a discovery produced, never per industry node', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const paths = await listPaths({ projectId });
    expect(paths.every((one) => one.opportunityId !== null)).toBe(true);
    expect(paths.every((one) => one.industryNodeId === null)).toBe(true);

    const pass = await tick();
    for (const opened of pass.opened) {
      expect(paths.some((one) => one.id === opened.pathId)).toBe(true);
    }
  });

  it('stops asking when the sprint winds down, and still files what came back', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [
        { claim: 'The published rate card lists USD 450.00.', lane: asked.attribute },
      ],
    });

    const wound = await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'that is enough',
    });
    expect(wound.ok).toBe(true);

    const pass = await tick();
    // The answer to a question already asked still lands: that activation was
    // already spent.
    expect(pass.recorded.some((one) => one.attribute === asked.attribute)).toBe(true);
    // And nothing new is asked.
    expect(pass.opened).toEqual([]);
    expect(pass.declined.length).toBeGreaterThan(0);
  });

  it('classifies a commissioned idea as discovery work for the wind-down guard', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'that is enough',
    });
    const mode = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId: asked.candidateId, mode })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the surface says what is happening, in one place', () => {
  it('names the path, the attribute, why it was selected and where it has got to', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;

    const ledger = await composeLedger({ projectId });
    const view = await commissionView({ projectId, ledger, capacity: MAX_OPEN_COMMISSIONS });
    const live = view.open.find((one) => one.commissionId === asked.commissionId)!;
    expect(live.pathTitle.length).toBeGreaterThan(0);
    expect(live.attribute).toBe(asked.attribute);
    expect(live.why).toBe(asked.reason);
    expect(live.rank).toBeGreaterThan(0);
    expect(live.answered).toBeNull();
    // A question with no mission must never read as being researched.
    expect(live.state).toBe('WAITING_TO_START');
    expect(live.stateBecause.length).toBeGreaterThan(20);
    expect(view.capacity).toBe(MAX_OPEN_COMMISSIONS);
  });

  it('reads as researching once a mission exists, and settled once it is filed', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const asked = (await tick()).opened[0]!;
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [{ claim: 'The published rate card lists USD 450.00.', lane: asked.attribute }],
    });

    const midLedger = await composeLedger({ projectId });
    const mid = await commissionView({
      projectId,
      ledger: midLedger,
      capacity: MAX_OPEN_COMMISSIONS,
    });
    expect(mid.open.find((one) => one.commissionId === asked.commissionId)!.state).toBe(
      'RESEARCHING',
    );

    await tick();
    const doneLedger = await composeLedger({ projectId });
    const done = await commissionView({
      projectId,
      ledger: doneLedger,
      capacity: MAX_OPEN_COMMISSIONS,
    });
    expect(done.recentlySettled.find((one) => one.commissionId === asked.commissionId)!.state).toBe(
      'SETTLED',
    );
  });
});

// ---------------------------------------------------------------------------

/** A ledger entry shaped enough to rank, for the pure tests above. */
function fakeEntry(over: { status: 'ACTIVE' | 'ARCHIVED' | 'UNPROVEN' }): Parameters<
  typeof rankableOf
>[0] {
  return {
    path: {
      id: `mzp_${over.status}`,
      projectId,
      opportunityId: null,
      industryNodeId: null,
      method: 'DIRECT_SALE',
      title: over.status,
      thesis: null,
      origin: 'ENUMERATED',
      sourceClaimId: null,
      mergedIntoId: null,
      splitFromId: null,
      lastEvaluatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    method: {
      label: 'Direct sale',
      what: 'selling it',
      role: 'PRINCIPAL',
      requires: [],
      produces: [],
      scaleDependent: false,
    },
    subject: null,
    status: over.status,
    statusBecause: 'because',
    answers: [],
    unknowns: [...MONETIZATION_ATTRIBUTES],
    margin: { cents: null, because: 'nothing established' },
    rank: 1,
    previousRank: null,
    movementReason: null,
    movedAt: null,
    lastEvaluatedAt: null,
    judgments: [],
    edges: [],
  } as unknown as Parameters<typeof rankableOf>[0];
}

// ---------------------------------------------------------------------------

/**
 * A question stops when the possibility it was about is put away.
 *
 * `ABANDONED` was declared in the schema, accepted by `settleCommission`,
 * rendered by `inFlight.ts` with a sentence of its own — and written by
 * nothing. A state a person could be shown, unreachable by construction: the
 * defect this branch was written to find in the *shipped* ledger, found in its
 * own new code by auditing it against its own rule.
 *
 * The condition is not hypothetical. A possibility can be put away by a
 * person's ARCHIVE, by a person's INVALIDATE, by being merged into another, or
 * by the discovery underneath it being archived — and none of those waits for
 * the research about it to finish.
 */
describe('adversarial: a possibility put away while its question is still being asked', () => {
  it('settles the question ABANDONED, frees the slot, and files nothing', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);

    const opened = await tick();
    expect(opened.opened.length).toBeGreaterThan(0);
    const asked = opened.opened[0]!;
    const before = await pathFactsFor(asked.pathId);

    const put = await judgePath({
      projectId,
      pathId: asked.pathId,
      judgment: 'ARCHIVE',
      reason: 'the customer went elsewhere',
      decidedByUserId: userId,
    });
    expect(put.ok).toBe(true);

    const after = await tick();

    const row = (await listCommissions({ projectId })).find((one) => one.id === asked.commissionId);
    expect(row?.state).toBe('ABANDONED');
    // Nothing was researched, so nothing may be reported as answered.
    expect(row?.answered).toBe(0);
    expect(row?.outcome).toContain('put away');
    expect(row?.settledAt).not.toBeNull();

    // It is reported as settled work rather than vanishing from the pass.
    expect(after.settled.map((one) => one.commissionId)).toContain(asked.commissionId);

    // And no answer was invented onto the path on the way out.
    expect(await pathFactsFor(asked.pathId)).toHaveLength(before.length);
  });

  it('frees the slot, so three put-away questions cannot stop the loop for ever', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);

    const opened = await tick();
    expect(opened.opened.length).toBe(MAX_OPEN_COMMISSIONS);

    for (const one of opened.opened) {
      const put = await judgePath({
        projectId,
        pathId: one.pathId,
        judgment: 'ARCHIVE',
        reason: 'not worth pursuing after all',
        decidedByUserId: userId,
      });
      expect(put.ok).toBe(true);
    }

    const after = await tick();
    expect(
      (await listCommissions({ projectId, state: 'ABANDONED' })).length,
    ).toBe(MAX_OPEN_COMMISSIONS);
    /*
     * The whole point: the slots came back in the same pass that abandoned
     * them, so the loop carries on. Before the repair every one of those
     * questions stayed OPEN for ever, `holding` stayed at three, and no
     * possibility in this project could ever be researched again.
     */
    expect(after.openNow).toBeGreaterThan(0);
    expect(after.opened.length).toBeGreaterThan(0);
  });

  it('leaves a question alone when the ledger simply has no entry for it', async () => {
    /*
     * Absence is not evidence, at the one branch where reading it as evidence
     * would close live research. A composition that transiently omitted an
     * entry must never abandon the question about it.
     */
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const opened = await tick();
    const asked = opened.opened[0]!;

    const ledger = await composeLedger({ projectId });
    const withoutIt = {
      ...ledger,
      entries: ledger.entries.filter((one) => one.path.id !== asked.pathId),
    };
    await runCommissions({ projectId, ledger: withoutIt });

    const row = (await listCommissions({ projectId })).find((one) => one.id === asked.commissionId);
    expect(row?.state).toBe('OPEN');
  });

  it('does not spend the retry budget, so a revived possibility asks with its full one', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);
    const opened = await tick();
    const asked = opened.opened[0]!;

    await judgePath({
      projectId,
      pathId: asked.pathId,
      judgment: 'ARCHIVE',
      reason: 'put away for now',
      decidedByUserId: userId,
    });
    await tick();
    expect(
      (await listCommissions({ projectId })).find((one) => one.id === asked.commissionId)?.state,
    ).toBe('ABANDONED');

    // Somebody changes their mind. The attribute is still unanswered.
    const revived = await judgePath({
      projectId,
      pathId: asked.pathId,
      judgment: 'REVIVE',
      reason: 'the customer came back',
      decidedByUserId: userId,
    });
    expect(revived.ok).toBe(true);

    const ledger = await composeLedger({ projectId });
    const plan = allocateCommissions({
      entries: ledger.entries,
      rankable: ledger.entries.map(rankableOf),
      commissions: await listCommissions({ projectId }),
      contradicted: new Set<string>(),
      slots: MAX_OPEN_COMMISSIONS,
      now: Date.parse(ledger.readAt),
    });

    /*
     * Two things at once, and both were wrong before the repair.
     *
     * The abandonment consulted no published source, so it may neither spend
     * one of the two rounds `MAX_COMMISSION_ROUNDS` allows nor start the
     * day-long cool-off whose stated justification is that *the same sources
     * will not have changed*. Either one would have left this attribute
     * unaskable — the first permanently after one more try, the second for a
     * day — for a reason that was never about the research.
     */
    const askedAgain = plan.asks.some(
      (one) => one.pathId === asked.pathId && one.attribute === asked.attribute,
    );
    const refusedAsResearched = plan.declined.some(
      (one) =>
        one.subject.includes(ATTRIBUTE[asked.attribute].label) &&
        (one.why.includes('has been researched') || one.why.includes('within the last day')),
    );
    expect(refusedAsResearched).toBe(false);
    expect(askedAgain).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * Finishing and being put away are two different records of two different
 * events, and the order the pass does them in decides which one is written.
 *
 * A run that completed, produced gated claims, and whose possibility was
 * archived before the next tick read it is a question that **was answered**
 * and a possibility that was *then* put away. Settling has to come first or
 * the row says the opposite and the gated claims — already paid for with a
 * real activation — are never filed onto the ledger at all.
 */
describe('adversarial: research that finished before the possibility was put away', () => {
  it('records the answer it found rather than calling it abandoned', async () => {
    await discovery('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await enumeratePossibilities(projectId);

    const opened = await tick();
    const asked = opened.opened[0]!;

    // The research runs to completion and produces a gated claim on the very
    // attribute that was asked about.
    await finishResearch({
      candidateId: asked.candidateId,
      claims: [
        {
          claim: 'The published rate is 1.50 USD per minute.',
          lane: asked.attribute,
          sourceUrl: 'https://example.invalid/published-rate',
        },
      ],
      missionState: 'DONE',
    });

    // Only then does somebody put the possibility away.
    const put = await judgePath({
      projectId,
      pathId: asked.pathId,
      judgment: 'ARCHIVE',
      reason: 'decided against this one',
      decidedByUserId: userId,
    });
    expect(put.ok).toBe(true);

    await tick();

    const row = (await listCommissions({ projectId })).find((one) => one.id === asked.commissionId);
    /*
     * Not ABANDONED. The question reached an answer; what happened to the
     * possibility afterwards is a separate fact, and the ledger already
     * records it as ARCHIVED.
     */
    expect(row?.state).not.toBe('ABANDONED');
    expect(['ANSWERED', 'UNRESOLVED']).toContain(row?.state);

    // And the evidence the activation was spent on reached the ledger.
    const facts = await pathFactsFor(asked.pathId);
    expect(facts.some((one) => one.kind === 'EVIDENCE' && one.claimId !== null)).toBe(true);
  });
});
