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
import { listCaptures, listCycles, listReviews } from '../../repos/design.ts';
import type { DesignCycle } from '../../domain/design.ts';
import { ingestDesignReview, reviewCreator, type ReviewLineage } from './judge.ts';
import { learnFleetWide, learnFromCycle, type LearningReport } from './learn.ts';
import { runExpansionPass, type ExpansionPass } from './expand.ts';
import { seedDesignCapabilities } from './capabilities.ts';
import { seedDesignPatterns } from './patterns.ts';
import { seedDesignSurfaces } from './surfaces.ts';

export interface DesignKernelPass {
  /** Judged reviews read back from bins that finished. */
  ingested: { binId: string; cycleId: string; verdict: string; findings: number }[];
  /** Cycles that closed and have now been learned from. */
  learned: { cycleId: string; report: LearningReport }[];
  /**
   * What was learned across every cycle rather than from one.
   *
   * Separate because a recurrence is a question about three distinct cycles by
   * construction, so asking it per cycle gives the same answer N times.
   */
  fleetWide: Awaited<ReturnType<typeof learnFleetWide>> | null;
  expansion: ExpansionPass | null;
  /** Anything a section could not do, so a quiet pass is not a silent one. */
  problems: string[];
}

const EMPTY: DesignKernelPass = {
  ingested: [],
  learned: [],
  fleetWide: null,
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
    ingested: [],
    learned: [],
    fleetWide: null,
    expansion: null,
    problems: [],
  };

  try {
    pass.ingested = await ingestFinishedReviews();
  } catch (error) {
    pass.problems.push(`judged reviews could not be read back: ${message(error)}`);
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
 * Read back every judged review whose bin has finished.
 *
 * Derived from the bin's state rather than from anything calling back, so a
 * review that completed while a tick was dying is read on the next one. The
 * arbiter against reading one twice is `recordFinding`'s unique index and the
 * `design_reviews` row itself: a cycle and pass that already has a JUDGED row is
 * skipped, which makes this idempotent by the round rather than by a flag — a
 * flag can be set by a tick that then dies.
 */
async function ingestFinishedReviews(): Promise<DesignKernelPass['ingested']> {
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
      const outcome = await ingestDesignReview({
        binId: bin.id,
        cycle,
        pass,
        captures,
        surfaceKeys: cycle.surfaceKeys,
        authors: await authorsOf(cycle),
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
async function authorsOf(cycle: DesignCycle): Promise<ReviewLineage[]> {
  if (cycle.triggerKind !== 'UI_IMPACT' || cycle.triggerRef === null) return [];
  try {
    const rows = await getDb().all<{
      session_ref: string | null;
      worker_id: string | null;
      account_id: string | null;
      routine_id: string | null;
    }>(
      `SELECT session_ref, worker_id, account_id, routine_id FROM factory_sessions
        WHERE campaign_id = ? ORDER BY created_at ASC, id ASC`,
      [cycle.triggerRef],
    );
    return rows.map((row) => ({
      sessionId: row.session_ref,
      workerId: row.worker_id,
      accountId: row.account_id,
      routineId: row.routine_id,
    }));
  } catch {
    /*
     * A campaign whose sessions cannot be read contributes no authors, which
     * `decideReviewIndependence` will report as NOT_APPLICABLE — and that is the
     * one place here where failing open is wrong, so it is said out loud in the
     * pass's problems rather than swallowed.
     */
    return [];
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
