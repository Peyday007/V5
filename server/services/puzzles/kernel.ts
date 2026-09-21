/**
 * One project's puzzle kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the seventh
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. A
 * master declared before this kernel ran gets a batch on the next tick with
 * nobody pressing anything; a tick that dies halfway leaves rows the next one
 * reads correctly; and two instances running it produce one round, because the
 * arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * Producing is free and asking is not, so only one of them is behind authority
 * ---------------------------------------------------------------------------
 *
 * Generating and checking a puzzle spends no allowance, calls no provider,
 * reads nothing external and publishes nothing — it is arithmetic on this
 * machine. So it runs whatever the standing authority says, and a project with
 * no research grant still builds its catalog and still learns whether its
 * generators work.
 *
 * Opening a round fires a worker, so it is behind the grant. §41 records why
 * that check belongs *here* rather than being left to `launch`: a candidate
 * that parks for want of authority launches no mission, so its round would
 * stay OPEN for ever, and an open round is exactly what stops that question
 * being asked again.
 *
 * ---------------------------------------------------------------------------
 * What it will not do
 * ---------------------------------------------------------------------------
 *
 * It declares no format, no master and no edition — those are a person's, for
 * §41's reason about `SEED`: deciding what this operation makes is a design
 * act rather than a derivation. It compiles nothing, because compiling makes a
 * file somebody might send to a buyer. It unblocks nothing, because a block
 * means the generator is wrong and only a code change makes it right. And it
 * sells nothing, contacts nobody and spends nothing.
 */
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../russell/launch.ts';
import { allocate, MAX_OPEN_PUZZLE_ROUNDS } from './allocate.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { puzzleSnapshot } from './map.ts';
import { produceBatch } from './produce.ts';
import type { PuzzleInstance } from '../../domain/types.ts';

/**
 * How many puzzles the tick produces from one master in one pass.
 *
 * Small and deliberately so. The tick runs every few seconds and its job is to
 * keep a declared master from sitting idle, not to fill a book — that is what
 * `POST .../produce` is for, where a person asks for a batch and waits for it.
 * A tick that generated two hundred puzzles would spend its whole pass inside
 * one solver while the rest of the Brain waited.
 */
export const TICK_BATCH = 5;

/**
 * How many puzzles a master may hold before the tick stops topping it up.
 *
 * Not a ceiling on the master: `produce` will make as many as asked for. It is
 * the point past which *unattended* production stops being obviously useful,
 * because nothing yet consumes them — the honest signal is a catalog of
 * unvalidated-into-nothing puzzles, and the reading says how many are waiting
 * in an edition rather than growing a pile.
 */
export const TICK_STOCK = 40;

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Puzzles produced this pass, and what checking them said. */
  produced: {
    masterId: string;
    created: PuzzleInstance[];
    duplicates: number;
    failures: number;
    unsupported: number;
    blocked: string | null;
  }[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  formats: number;
  openRounds: number;
}

const EMPTY: KernelPass = {
  opened: [],
  absorbed: { formats: [], facts: [], settled: [], refused: [] },
  produced: [],
  declined: [],
  formats: 0,
  openRounds: 0,
};

export async function runPuzzleKernel(projectId: string): Promise<KernelPass> {
  /*
   * Absorb first, so a format a finished round discovered is on the map before
   * anything is decided about it. Allocating first would make every arriving
   * finding a tick late, for ever.
   */
  const absorbed = await absorb({ projectId });

  const snapshot = await puzzleSnapshot(projectId);
  if (snapshot.formatRows.length === 0) {
    return { ...EMPTY, absorbed };
  }

  /*
   * Keep the declared masters producing.
   *
   * Ahead of the allocator so that a master which has just produced its first
   * validated puzzle is visible to the rules that decide what to ask about —
   * rule 2 reads exactly that, and a pass that allocated first would ask about
   * a format whose evidence arrived one line later.
   */
  const produced: KernelPass['produced'] = [];
  for (const reading of snapshot.masters) {
    if (reading.blocked || reading.master.retiredAt) continue;
    if (reading.instances >= TICK_STOCK) continue;

    const outcome = await produceBatch({
      projectId,
      masterId: reading.master.id,
      count: Math.min(TICK_BATCH, TICK_STOCK - reading.instances),
    });
    if (!outcome.ok) continue;
    if (
      outcome.value.created.length === 0 &&
      outcome.value.duplicates === 0 &&
      outcome.value.refused.length === 0
    ) {
      continue;
    }
    produced.push({
      masterId: reading.master.id,
      created: outcome.value.created,
      duplicates: outcome.value.duplicates,
      failures: outcome.value.failures.length,
      unsupported: outcome.value.unsupported.length,
      blocked: outcome.value.blocked?.reason ?? null,
    });
  }

  const openRounds = snapshot.rounds.filter((one) => one.state === 'OPEN').length;

  const grant = await checkAuthority({ projectId, workClass: RESEARCH_WORK_CLASS });
  if (!grant.ok) {
    return {
      opened: [],
      absorbed,
      produced,
      declined: [
        {
          subject: 'every format on the map',
          why:
            `Nothing may be spent asking about this project: ${grant.reason}. Producing and ` +
            'checking puzzles is unaffected — that spends nothing and is arithmetic on this ' +
            'machine — and so is every reading.',
        },
      ],
      formats: snapshot.formatRows.length,
      openRounds,
    };
  }

  /*
   * Re-read the snapshot if anything was produced.
   *
   * The allocator decides on validated counts, and the batch above has just
   * changed them. Passing it the stale reading would make rule 2 blind to the
   * puzzles this very pass created — the ordering defect §41's kernel had to
   * correct, arriving one module along.
   */
  const current = produced.length > 0 ? await puzzleSnapshot(projectId) : snapshot;

  const planned = allocate({
    snapshot: current,
    slots: Math.max(0, MAX_OPEN_PUZZLE_ROUNDS - openRounds),
  });
  const opened = await openAsks({ projectId, asks: planned.asks, snapshot: current });

  return {
    opened,
    absorbed,
    produced,
    declined: planned.declined,
    formats: current.formatRows.length,
    openRounds,
  };
}
