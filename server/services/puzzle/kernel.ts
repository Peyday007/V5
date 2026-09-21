/**
 * One project's puzzle pass, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the sixth
 * time this repository has needed that distinction: a hook fixes one entrance,
 * and a derivation reaches every entrance plus everything already stranded. A
 * sprint activated before this kernel existed gets a map on the next tick with
 * nobody pressing anything; a tick that dies halfway leaves rows the next one
 * reads correctly; and two instances running it produce one round, because the
 * arbiter is a partial unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * The order of the three steps is the whole design
 * ---------------------------------------------------------------------------
 *
 * File, observe, allocate — in that order, and each because of the one after
 * it.
 *
 * Filing first means a round that settled on the previous pass has its
 * formats, standards, routes and figures on the map *before* the allocator
 * looks, so a format that has just gained a standard is judged at its real
 * maturity on this pass rather than the next one. Observing before allocating
 * means a defect that has just been derived is on the record before anything
 * decides what to ask. Allocating first would make every discovery a tick
 * late, for ever.
 *
 * ---------------------------------------------------------------------------
 * It refuses to open work where discovery is refused, and only there
 * ---------------------------------------------------------------------------
 *
 * Opening a round is new discovery, so it is behind `discoveryAllowed` — the
 * same gate the buckets, the industry kernel and the dealflow kernel are
 * behind. Filing and observing are **not**: filing what research already found
 * is not new discovery, the spending happened when it ran, and dropping
 * results because the sprint wound down would throw away work already paid
 * for. §30's rule that winding down ends new discovery and never a customer's
 * obligation, applied one kernel along.
 *
 * ---------------------------------------------------------------------------
 * Nothing here produces, compiles, releases or sells
 * ---------------------------------------------------------------------------
 *
 * Worth saying plainly, because this is the one kernel in this Brain whose
 * subject is something Brain can *make*. The tick reads and asks questions. It
 * does not run a generator, compile a product, release one, price one or
 * contact anybody: producing a batch is a person's instruction through
 * `produce.ts`, compiling and releasing are a person's decisions in
 * `declare.ts`, and every commercial effect is a `COMMERCIAL_ACTION` under a
 * grant somebody made separately.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import { recordObservation } from '../../repos/puzzle.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { allocate, awaitingReview, MAX_OPEN_PUZZLE_ROUNDS, type Ask, type Declined } from './allocate.ts';
import { fileFindings, openPuzzleAsks, type Filed, type OpenedPuzzleRound } from './expand.ts';
import { puzzleSnapshot, type PuzzleSnapshot } from './graph.ts';

export interface PuzzlePass {
  filed: Filed;
  opened: OpenedPuzzleRound[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: Declined[];
  /** Defects Brain derived from its own rows this pass. */
  observed: string[];
  /** Set when the directive could not be read, which stops questions and nothing else. */
  blocked: string | null;
  formats: number;
  routes: number;
  openRounds: number;
  /** Formats with a generator nobody has reviewed. A person's decision, never an ask. */
  awaitingReview: { formatKey: string; name: string }[];
}

function emptyPass(): PuzzlePass {
  return {
    filed: {
      formats: [],
      standards: [],
      rights: [],
      routes: [],
      routeEvidence: [],
      economics: [],
      settled: [],
      refused: [],
    },
    opened: [],
    declined: [],
    observed: [],
    blocked: null,
    formats: 0,
    routes: 0,
    openRounds: 0,
    awaitingReview: [],
  };
}

export async function runPuzzleKernel(projectId: string): Promise<PuzzlePass> {
  // One read answers it for the many projects that hold no sprint at all,
  // which is what makes this cheap enough to run for every project every tick.
  const mode = await getCashMode(projectId);
  if (!mode) return emptyPass();

  const filed = await fileFindings({ projectId });
  const snapshot = await puzzleSnapshot(projectId);
  const observed = await observeDefects(projectId, snapshot);

  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) {
    return {
      filed,
      opened: [],
      declined: [{ subject: 'every question this kernel would ask', why: gate.reason }],
      observed,
      blocked: null,
      formats: snapshot.formats.length,
      routes: snapshot.routes.length,
      openRounds: snapshot.openRounds,
      awaitingReview: awaitingReview(snapshot),
    };
  }

  const plan = planFrom(snapshot);
  const { opened, blocked } = await openPuzzleAsks({
    projectId,
    asks: plan.asks,
    snapshot,
  });

  return {
    filed,
    opened,
    declined: plan.declined,
    observed,
    blocked,
    formats: snapshot.formats.length,
    routes: snapshot.routes.length,
    openRounds: snapshot.openRounds,
    awaitingReview: awaitingReview(snapshot),
  };
}

/**
 * The allocation for one snapshot, with the free slots counted from it.
 *
 * Exported separately from the pass that acts on it so a person — or a test —
 * can ask *what would Brain ask next* without anything being created.
 * `services/dealflow/kernel.ts` and `services/industry/kernel.ts` both split
 * reading from applying for the same reason: somebody should be able to look
 * before anything moves.
 */
export function planFrom(snapshot: PuzzleSnapshot): { asks: Ask[]; declined: Declined[] } {
  return allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_PUZZLE_ROUNDS - snapshot.openRounds),
  });
}

/**
 * Notice a validation defect that spans a whole master, once.
 *
 * `produceBatch` already records a `GENERATOR_DEFECT` when a run of failures
 * blocks a batch. This catches the shape that batch cannot see: failures that
 * accumulated across several batches, or after a re-validation, where no
 * single run ever crossed the threshold.
 *
 * Idempotent by the sentence it writes, so a defect that persists is one row
 * rather than one per tick — a log that grew every ten seconds would bury the
 * playtest somebody actually did.
 */
async function observeDefects(projectId: string, snapshot: PuzzleSnapshot): Promise<string[]> {
  const written: string[] = [];
  const byMaster = new Map<string, { failed: number; total: number; check: string | null }>();

  for (const instance of snapshot.instances) {
    const run = snapshot.validations.get(instance.id);
    if (!run) continue;
    const entry = byMaster.get(instance.masterId) ?? { failed: 0, total: 0, check: null };
    entry.total += 1;
    if (run.verdict === 'FAILED') {
      entry.failed += 1;
      entry.check = entry.check ?? run.failedCheck;
    }
    byMaster.set(instance.masterId, entry);
  }

  for (const [masterId, entry] of byMaster) {
    if (entry.total < 3 || entry.failed / entry.total < 0.5) continue;
    const master = snapshot.masters.find((one) => one.id === masterId);
    const statement =
      `${entry.failed} of ${entry.total} puzzles from "${master?.name ?? masterId}" fail ` +
      `validation${entry.check ? ` on ${entry.check}` : ''}. That is the generator rather than ` +
      'the puzzles, and the repair belongs in the engine or the master’s parameters.';

    // Already said. A defect that persists is one row, not one per tick.
    if (
      snapshot.observations.some(
        (one) => one.kind === 'GENERATOR_DEFECT' && one.statement === statement,
      )
    ) {
      continue;
    }
    const observation = await recordObservation({
      projectId,
      kind: 'GENERATOR_DEFECT',
      subjectKey: master?.formatKey ?? null,
      statement,
      observer: 'BRAIN',
      masterId,
    });
    written.push(observation.id);
  }

  return written;
}
