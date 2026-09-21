/**
 * The design kernel's tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * The sixth time this repository has needed the distinction, and it is written
 * down again because it is the property everything here rests on: **a hook fixes
 * one entrance and a derivation reaches every entrance plus everything already
 * stranded.** A review bin that completed while a tick was dying, a correction
 * recorded through a route nobody thought to hook, a capability that became
 * provable because somebody installed a browser — all of them are read from rows
 * on the next pass, by a tick that knows nothing about how they got there.
 *
 * ---------------------------------------------------------------------------
 * What runs here and what deliberately does not
 * ---------------------------------------------------------------------------
 *
 * Three things run: ingesting judged reviews that came back, learning from
 * cycles that closed, and one pass of the expansion loop.
 *
 * **Rendering does not.** A capture needs a headless browser and a running
 * product, and the deployed Brain has neither — so a tick that tried would
 * either fail on every pass or, worse, quietly decide a surface was fine. The
 * operating loop is started by something that *has* a browser: `npm run design`,
 * the visual harness, or a developer. That is a real boundary and it is reported
 * rather than worked around: `probeRenderRuntime` says so, the cycle closes
 * `NO_RENDER_RUNTIME` with the remedy, and the capability reads accordingly.
 *
 * The expansion loop, on the other hand, needs nothing but rows — which is why
 * it is the half that runs unattended, and why *the kernel gets more capable
 * simply by existing* is a statement about this function rather than an
 * aspiration.
 *
 * ---------------------------------------------------------------------------
 * It never stops the tick it runs on
 * ---------------------------------------------------------------------------
 *
 * Every section is wrapped, for the reason `advanceSources` is: a kernel that
 * could not advance must not stop Russell writing back a mission or reconciling
 * a stranded lease. It is a reading about Brain, never a precondition of Brain.
 */
import { binByCreator } from '../../repos/bins.ts';
import { getDb } from '../../db/database.ts';
import {
  binRequestFor,
  listCaptures,
  listCycles,
  listFindings,
  listReviews,
} from '../../repos/design.ts';
import type { DesignCycle } from '../../domain/design.ts';
import { ingestDesignReview, openDesignReview, reviewCreator, type ReviewLineage } from './judge.ts';
import { ingestDesignRender, openDesignRender, renderCreator } from './render.ts';
import { resolveSurfaces } from './surfaces.ts';
import { settleCycleNow } from './operate.ts';
import { designProject, NO_DESIGN_PROJECT } from './scope.ts';
import { absorbFinishedResearch, type AbsorbedResearch } from './absorb.ts';
import { learnFleetWide, learnFromCycle, type LearningReport } from './learn.ts';
import { runExpansionPass, type ExpansionPass } from './expand.ts';
import { seedDesignCapabilities } from './capabilities.ts';
import { seedDesignPatterns } from './patterns.ts';
import { seedDesignSurfaces } from './surfaces.ts';

export interface DesignKernelPass {
  /** Render bins opened for cycles that were waiting for a machine with a browser. */
  asked: { binId: string; cycleId: string; kind: 'RENDER' | 'REVIEW'; because: string }[];
  /** Renders read back from bins that finished, and what measuring them found. */
  rendered: { binId: string; cycleId: string; captures: number; refused: string | null }[];
  /** Judged reviews read back from bins that finished. */
  ingested: { binId: string; cycleId: string; verdict: string; findings: number }[];
  /** Cycles whose judgement landed and which are now closed, with the reason. */
  settled: { cycleId: string; stopReason: string; unresolved: number }[];
  /** Cycles that closed and have now been learned from. */
  learned: { cycleId: string; report: LearningReport }[];
  /**
   * What was learned across every cycle rather than from one.
   *
   * Separate because a recurrence is a question about three distinct cycles by
   * construction, so asking it per cycle gives the same answer N times.
   */
  fleetWide: Awaited<ReturnType<typeof learnFleetWide>> | null;
  /** Design research that came back and became proposed patterns. */
  absorbed: AbsorbedResearch[];
  expansion: ExpansionPass | null;
  /** Anything a section could not do, so a quiet pass is not a silent one. */
  problems: string[];
}

const EMPTY: DesignKernelPass = {
  asked: [],
  rendered: [],
  ingested: [],
  settled: [],
  learned: [],
  fleetWide: null,
  absorbed: [],
  expansion: null,
  problems: [],
};

/**
 * Write the seed.
 *
 * Idempotent, and separated from the pass because it is a different kind of
 * thing: seeding declares what exists to be looked at and what is already known,
 * and a pass acts on rows. Called at boot and by the operator surface.
 */
export async function seedDesignKernel(): Promise<{
  surfaces: number;
  patterns: number;
  capabilities: number;
}> {
  const surfaces = await seedDesignSurfaces();
  const patterns = await seedDesignPatterns();
  const capabilities = await seedDesignCapabilities();
  return {
    surfaces: surfaces.created.length + surfaces.updated.length,
    patterns: patterns.created.length + patterns.updated.length,
    capabilities: capabilities.created.length + capabilities.updated.length,
  };
}

/**
 * One kernel pass.
 *
 * Ingesting comes before learning and learning before expanding, and the order
 * is the same argument the industry kernel makes for absorbing first: a review
 * that came back changes what there is to learn from, and what was learned
 * changes what the expansion loop sees. Deciding first would make every
 * discovery a tick late, for ever.
 */
export async function runDesignKernel(): Promise<DesignKernelPass> {
  const pass: DesignKernelPass = {
    asked: [],
    rendered: [],
    ingested: [],
    settled: [],
    learned: [],
    fleetWide: null,
    absorbed: [],
    expansion: null,
    problems: [],
  };

  /*
   * Renders first, then reviews, then the settling.
   *
   * The order is the order the work is in: a render that came back this tick
   * produces the captures a review is briefed on, and a review that came back
   * this tick is what lets a cycle close. Reading them in any other order would
   * make each stage a tick late for ever — the industry kernel's argument for
   * absorbing before deciding, at a loop with three stages instead of two.
   */
  try {
    pass.rendered = await ingestFinishedRenders(pass);
  } catch (error) {
    pass.problems.push(`finished renders could not be read back: ${message(error)}`);
  }

  try {
    pass.ingested = await ingestFinishedReviews(pass);
  } catch (error) {
    pass.problems.push(`judged reviews could not be read back: ${message(error)}`);
  }

  try {
    pass.settled = await settleJudgedCycles();
  } catch (error) {
    pass.problems.push(`cycles whose judgement landed could not be closed: ${message(error)}`);
  }

  try {
    await askForRenders(pass);
  } catch (error) {
    pass.problems.push(`cycles waiting for a browser could not be asked about: ${message(error)}`);
  }

  try {
    pass.learned = await learnFromClosedCycles();
  } catch (error) {
    pass.problems.push(`closed cycles could not be learned from: ${message(error)}`);
  }

  try {
    pass.fleetWide = await learnFleetWide();
  } catch (error) {
    pass.problems.push(`what recurred across cycles could not be read: ${message(error)}`);
  }

  /*
   * Research that came back, before the expansion pass decides anything.
   *
   * Absorbing first for the industry kernel's reason: a piece of research that
   * settled has changed what the ranking sees — the expansion it answered is no
   * longer live, so its slot is free — and deciding before reading it would make
   * every discovery a tick late, for ever.
   */
  try {
    pass.absorbed = await absorbFinishedResearch();
  } catch (error) {
    pass.problems.push(`finished design research could not be absorbed: ${message(error)}`);
  }

  try {
    pass.expansion = await runExpansionPass('PROACTIVE');
  } catch (error) {
    pass.problems.push(`the expansion pass could not run: ${message(error)}`);
  }

  return pass;
}

/** Nothing to do on a Brain with no design surfaces registered. */
export async function designKernelIdle(): Promise<DesignKernelPass> {
  return EMPTY;
}

/**
 * Ask somebody with a browser to look at the cycles that are waiting for one.
 *
 * This is the transition the kernel was missing. `requestDesignCycle` opens a
 * cycle where a change integrates — on a server with no browser — and until this
 * existed the only thing that could ever render it was a person running
 * `npm run design resume` against a database that is not the one holding the
 * cycle. §24's sentence at the top of the loop: **a state that says it is
 * waiting for something nobody can supply is not waiting, it is stuck.**
 *
 * A render bin is the answering transition, and it is the machinery that is
 * already there — dispatch, leases, fencing, attempts, a completion contract —
 * rather than a second one beside it.
 *
 * Nothing here decides a screen is fine. A cycle with no surfaces registered, or
 * a Brain with no project to file the work against, is **reported** and left
 * alone; the honest outcome of not being able to ask is not an answer.
 */
async function askForRenders(pass: DesignKernelPass): Promise<void> {
  const projectId = await designProject();

  for (const cycle of await listCycles({ state: 'OPEN', limit: 50 })) {
    // A pass that already has pictures does not need to be rendered again, and a
    // pass already waiting on one must not be asked twice.
    const captures = await listCaptures({ cycleId: cycle.id, pass: cycle.passes, limit: 1 });
    if (captures.length > 0) continue;
    if (await binRequestFor({ cycleId: cycle.id, pass: cycle.passes, kind: 'RENDER' })) continue;

    const { surfaces, unknown } = await resolveSurfaces(cycle.surfaceKeys);
    if (surfaces.length === 0) {
      pass.problems.push(
        `${cycle.id} names no registered surface${unknown.length > 0 ? ` (${unknown.join(', ')})` : ''}, ` +
          'so there is nothing to render. Registering one, or abandoning the cycle, is the remedy.',
      );
      continue;
    }
    if (!projectId) {
      pass.problems.push(`${cycle.id} is waiting for a render and ${NO_DESIGN_PROJECT}`);
      continue;
    }

    const binId = await openDesignRender({ cycle, pass: cycle.passes, projectId, surfaces });
    pass.asked.push({
      binId,
      cycleId: cycle.id,
      kind: 'RENDER',
      because:
        `pass ${cycle.passes} of ${cycle.id} has no capture of ` +
        `${surfaces.map((one) => one.surfaceKey).join(', ')}, and this Brain cannot take one`,
    });
  }
}

/**
 * Read back every render whose bin has finished, and ask for the judgement next.
 *
 * Derived from the bin's state, so a render that completed while a tick was
 * dying is read on the next one. Idempotent by the captures it writes: a pass
 * that already holds captures is skipped inside `ingestDesignRender`, because a
 * second copy would change the set's digest and every finding on it would
 * reappear under a new capture id.
 *
 * A refused render is **reported and the bin is left as it is**. The attempt it
 * spent is already on the row, and reopening the cycle here would be this
 * module deciding that a worker's honest failure deserves another activation —
 * a decision the bin's own attempt budget already makes.
 */
async function ingestFinishedRenders(pass: DesignKernelPass): Promise<DesignKernelPass['rendered']> {
  const out: DesignKernelPass['rendered'] = [];
  const projectId = await designProject();

  for (const cycle of await listCycles({ state: 'OPEN', limit: 50 })) {
    const request = await binRequestFor({
      cycleId: cycle.id,
      pass: cycle.passes,
      kind: 'RENDER',
    });
    if (!request) continue;

    const bin = await binByCreator(renderCreator(cycle, cycle.passes));
    if (!bin || bin.state !== 'COMPLETE') continue;

    const { surfaces } = await resolveSurfaces(cycle.surfaceKeys);
    const existing = await listCaptures({ cycleId: cycle.id, pass: cycle.passes, limit: 200 });
    const outcome = await ingestDesignRender({
      binId: bin.id,
      cycle,
      pass: cycle.passes,
      surfaces,
      existing,
    });

    out.push({
      binId: bin.id,
      cycleId: cycle.id,
      captures: outcome.captures.length,
      refused: outcome.refused,
    });
    if (outcome.refused !== null) {
      pass.problems.push(`${cycle.id}: ${outcome.refused}`);
      continue;
    }
    if (outcome.captures.length === 0) continue;

    /*
     * The captures exist, so the half measurement cannot settle can be asked.
     *
     * Opened here rather than inside the render ingest, because opening a review
     * needs a project and the ingest needs none — and a function that took a
     * project id only so it could open a different bin would be two decisions in
     * one place.
     */
    if (await binRequestFor({ cycleId: cycle.id, pass: cycle.passes, kind: 'REVIEW' })) continue;
    if (!projectId) {
      pass.problems.push(`${cycle.id} has been rendered and ${NO_DESIGN_PROJECT}`);
      continue;
    }
    const reviewBin = await openDesignReview({
      cycle,
      pass: cycle.passes,
      projectId,
      surfaces,
      captures: outcome.captures,
    });
    pass.asked.push({
      binId: reviewBin,
      cycleId: cycle.id,
      kind: 'REVIEW',
      because:
        `${outcome.captures.length} capture(s) of pass ${cycle.passes} have been measured, and ` +
        'what is left is the half a reader has to answer',
    });
  }
  return out;
}

/**
 * Close a cycle whose judgement has landed.
 *
 * The other half of the answering transition. A cycle sits `OPEN` while its
 * review bin is outstanding — correctly, because the judgement is part of the
 * pass — and something has to notice when the answer arrives, or the cycle waits
 * for ever with every row reading healthy. That is the defect this kernel was
 * built to avoid and had at its own centre.
 *
 * The stop reason is **derived from what is open**, never chosen: nothing open
 * is `SETTLED`, and anything open is `NEEDS_PERSON`, because the only repair
 * strategy this kernel has prepares a change somebody authorizes on Build.
 * `REPAIR_EXHAUSTED` is deliberately not reachable from here — a pass ended by a
 * judgement has not spent a ceiling, and reporting it as though it had would
 * send somebody to look at a loop that did not run.
 */
async function settleJudgedCycles(): Promise<DesignKernelPass['settled']> {
  const out: DesignKernelPass['settled'] = [];

  for (const cycle of await listCycles({ state: 'OPEN', limit: 50 })) {
    const request = await binRequestFor({
      cycleId: cycle.id,
      pass: cycle.passes,
      kind: 'REVIEW',
    });
    if (!request) continue;

    const judged = (await listReviews(cycle.id)).find(
      (one) => one.lane === 'JUDGED' && one.pass === cycle.passes,
    );
    if (!judged) continue;

    const open = await listFindings({ cycleId: cycle.id, state: 'OPEN', limit: 500 });

    /*
     * A REFUSED review is not a judgement, and the first version of this treated
     * it as one.
     *
     * `design_reviews` records a refusal as a row — deliberately, because §8's
     * rule is that a failure and its raw response are still persisted — so
     * "there is a JUDGED row for this pass" is true of a review that established
     * nothing at all. Closing on it read a cycle whose evidence had moved
     * underneath its reviewer as *rendered, measured and judged*, which is the
     * silent success this whole kernel exists not to produce. The walk found it;
     * no unit test could, because none of them had a refusal and a cycle in the
     * same story.
     *
     * It still closes, and that is the other half. Leaving it open would be a
     * park: `ingestFinishedReviews` skips a pass that already has a JUDGED row,
     * so nothing would ever ask again and the cycle would wait for a judgement
     * that could not arrive. `NEEDS_PERSON` with the refusal's own words is the
     * honest state — somebody has to decide, and the reason is on the row.
     */
    const stopReason = judged.verdict === 'REFUSED' ? 'NEEDS_PERSON' : open.length === 0 ? 'SETTLED' : 'NEEDS_PERSON';
    const stopDetail =
      judged.verdict === 'REFUSED'
        ? `Pass ${cycle.passes} was rendered and measured, and the judgement was refused: ` +
          `${judged.detail ?? 'no reason was recorded, which is itself the problem'} ` +
          `${open.length} finding(s) stay open — nothing judged this screen, so nothing may be ` +
          'closed as though something had.'
        : open.length === 0
          ? `Pass ${cycle.passes} was rendered, measured and judged ${judged.verdict}, and nothing ` +
            `is open. Capture set ${judged.captureDigest.slice(0, 12)}…, ` +
            `independence ${judged.independenceTier ?? 'unrecorded'}.`
          : `Pass ${cycle.passes} was rendered, measured and judged ${judged.verdict}. ` +
            `${open.length} finding(s) are open and every repair for them is a change to code, ` +
            'which is a person’s to authorize on Build. They stay open rather than being closed ' +
            'to make this cycle read as finished.';

    const unresolved = await settleCycleNow(cycle, stopReason, stopDetail);
    out.push({ cycleId: cycle.id, stopReason, unresolved: unresolved.length });
  }
  return out;
}

/**
 * Read back every judged review whose bin has finished.
 *
 * Derived from the bin's state rather than from anything calling back, so a
 * review that completed while a tick was dying is read on the next one. The
 * arbiter against reading one twice is `recordFinding`'s unique index and the
 * `design_reviews` row itself: a cycle and pass that already has a JUDGED row is
 * skipped, which makes this idempotent by the round rather than by a flag — a
 * flag can be set by a tick that then dies.
 */
async function ingestFinishedReviews(report: DesignKernelPass): Promise<DesignKernelPass['ingested']> {
  const out: DesignKernelPass['ingested'] = [];

  for (const cycle of await listCycles({ limit: 100 })) {
    const reviews = await listReviews(cycle.id);
    const judgedPasses = new Set(
      reviews.filter((one) => one.lane === 'JUDGED').map((one) => one.pass),
    );

    /*
     * Asked pass by pass rather than by a prefix query, because `created_by_id`
     * is the exact key `openDesignReview` wrote and `binByCreator` reads it
     * exactly. A `LIKE` over a prefix would be a second way to identify a bin,
     * and the two would eventually disagree about which pass a bin belongs to.
     */
    for (let pass = 0; pass <= cycle.passes; pass += 1) {
      if (judgedPasses.has(pass)) continue;
      const bin = await binByCreator(reviewCreator(cycle, pass));
      if (!bin || bin.state !== 'COMPLETE') continue;

      const captures = await listCaptures({ cycleId: cycle.id, pass, limit: 200 });
      const written = await authorsOf(cycle);
      if (written.problem) report.problems.push(written.problem);
      const outcome = await ingestDesignReview({
        binId: bin.id,
        cycle,
        pass,
        captures,
        surfaceKeys: cycle.surfaceKeys,
        authors: written.authors,
      });
      if (outcome.review) {
        out.push({
          binId: bin.id,
          cycleId: cycle.id,
          verdict: outcome.review.verdict,
          findings: outcome.findings.length,
        });
      }
    }
  }
  return out;
}


/**
 * The sessions that made the change this cycle is about.
 *
 * Read from the factory campaign a `UI_IMPACT` cycle names, so the reviewer is
 * held against the sessions that actually wrote the code. Empty for a cycle with
 * no such trigger, which `decideReviewIndependence` reports as `NOT_APPLICABLE`
 * rather than as separation it did not achieve.
 */
async function authorsOf(
  cycle: DesignCycle,
): Promise<{ authors: ReviewLineage[]; problem: string | null }> {
  if (cycle.triggerKind !== 'UI_IMPACT' || cycle.triggerRef === null) {
    return { authors: [], problem: null };
  }
  try {
    /*
     * The columns `factory_sessions` actually has, which is a correction.
     *
     * The first version selected `session_ref, worker_id, account_id,
     * routine_id`. Three of those four do not exist on that table: migration 037
     * declares `external_session_id`, `worker_id` and `account_ref`, and records
     * no Routine at all. So the statement threw on every UI-impact cycle, the
     * `catch` below returned no authors, and `decideReviewIndependence` reported
     * `NOT_APPLICABLE` — *nobody for the reviewer to be independent of* — about
     * a change that a session had demonstrably written.
     *
     * That is the guard silently never running, which is worse than the guard
     * being absent: the tier was recorded, it read as a deliberate answer, and
     * it was wrong in the direction that admits a self-review. The old comment
     * on the `catch` even said this must be said out loud rather than swallowed,
     * and it was swallowed; the comment described behaviour the code did not
     * have.
     *
     * `routineId` is null because that table holds no Routine. Null is the
     * honest value: `decideReviewIndependence` reads it as unknown and declines
     * to claim ROUTINE_SEPARATED, rather than inventing a separation.
     */
    const rows = await getDb().all<{
      external_session_id: string | null;
      worker_id: string | null;
      account_ref: string | null;
    }>(
      `SELECT external_session_id, worker_id, account_ref FROM factory_sessions
        WHERE campaign_id = ? ORDER BY created_at ASC, id ASC`,
      [cycle.triggerRef],
    );
    return {
      authors: rows.map((row) => ({
        sessionId: row.external_session_id,
        workerId: row.worker_id,
        accountId: row.account_ref,
        routineId: null,
      })),
      problem: null,
    };
  } catch (error) {
    /*
     * A campaign whose sessions cannot be read contributes no authors, and
     * `decideReviewIndependence` would then report NOT_APPLICABLE — which is
     * exactly the wrong answer, because the sessions exist and could not be
     * read. So it is said out loud in the pass's problems, which is what the
     * previous version of this comment promised and did not do.
     */
    return { authors: [], problem: `the authors of ${cycle.id} could not be read: ${message(error)}` };
  }
}

/**
 * Learn from cycles that closed and have not been learned from yet.
 *
 * "Have not been learned from" is derived rather than flagged: a cycle whose
 * findings have all been settled and whose recurrences are already compiled
 * produces an empty report, so running it again is cheap and correct. That is
 * the shape §27 records as the difference between idempotent-by-effect and
 * idempotent-by-flag — a flag can be set by a tick that then dies.
 */
async function learnFromClosedCycles(): Promise<DesignKernelPass['learned']> {
  const out: DesignKernelPass['learned'] = [];
  for (const cycle of await listCycles({ state: 'CLOSED', limit: 20 })) {
    const report = await learnFromCycle(cycle);
    if (report.limitations.length > 0) out.push({ cycleId: cycle.id, report });
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
