/**
 * One project's manufacturing kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the sixth
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. A
 * programme started before a rule existed gets the rule on the next tick with
 * nobody pressing anything; a tick that dies halfway leaves rows the next one
 * reads correctly; and two instances running it produce one round, because the
 * arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * Absorb first, deliberately
 * ---------------------------------------------------------------------------
 *
 * A round that settled on the previous pass has categories, capabilities or
 * evidence to file, and filing them changes what the allocator sees: a category
 * that has just gained its first demand signal should be having its capability
 * question asked on *this* pass rather than the next one. Allocating first
 * would make every decision a tick late, for ever.
 *
 * ---------------------------------------------------------------------------
 * It refuses to ask where asking is refused
 * ---------------------------------------------------------------------------
 *
 * Opening a round is new research, so it is behind `programmeMayAsk`. Absorbing
 * is not: filing what research already found is not new discovery, the spending
 * happened when it ran, and dropping results because somebody paused the
 * programme would throw away work already paid for. §30's rule that winding a
 * section down ends new discovery and never an obligation already incurred,
 * applied one table along.
 */
import { getProgram } from '../../repos/manufacturing.ts';
import { allocate, MAX_OPEN_PROGRAMME_ROUNDS, type Ask } from './allocate.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { ladderSnapshot, type LadderSnapshot } from './ladder.ts';
import { ensureProgrammeAuthority, programmeMayAsk } from './program.ts';

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  /** The ladder as it stood when the decision was made. */
  categories: number;
  capabilitiesHeld: number;
  openRounds: number;
}

const EMPTY: KernelPass = {
  opened: [],
  absorbed: { categories: [], capabilities: [], edges: [], evidence: [], settled: [], refused: [] },
  declined: [],
  categories: 0,
  capabilitiesHeld: 0,
  openRounds: 0,
};

export async function runManufacturingKernel(projectId: string): Promise<KernelPass> {
  // One read answers it for the many projects that hold no programme at all,
  // which is what makes this cheap enough to run for every project every tick.
  if (!(await getProgram(projectId))) return EMPTY;

  /*
   * The grant, reconciled from rows.
   *
   * Idempotent by its index, and here rather than only at activation for the
   * reason `ensureDiscoveryAuthority` is called from the tick: a programme
   * started before this existed, or one whose grant was revoked and whose
   * programme was then resumed, has nothing to run under and no hook would
   * reach it.
   */
  await ensureProgrammeAuthority(projectId);

  const absorbed = await absorb({ projectId });

  const snapshot = await ladderSnapshot(projectId);
  if (!snapshot) return { ...EMPTY, absorbed };

  const counts = {
    categories: snapshot.categories.filter((one) => one.retiredAt === null).length,
    capabilitiesHeld: snapshot.capabilities.filter((one) => one.heldAt !== null).length,
    openRounds: snapshot.rounds.filter((one) => one.state === 'OPEN').length,
  };

  const gate = await programmeMayAsk(projectId);
  if (!gate.allowed) {
    return {
      opened: [],
      absorbed,
      declined: [{ subject: 'every category on the ladder', why: gate.reason }],
      ...counts,
    };
  }

  const plan = planFrom(snapshot);
  const opened = await openAsks({ projectId, asks: plan.asks, snapshot });

  return { opened, absorbed, declined: plan.declined, ...counts };
}

/**
 * The allocation for one snapshot, with the free slots counted from it.
 *
 * Exported separately from the pass that acts on it so that a person — or a
 * test — can ask *what would Brain do next* without anything being created.
 * `services/realize/prove.ts` splits reading from applying for the same reason:
 * somebody should be able to look before anything moves.
 */
export function planFrom(snapshot: LadderSnapshot): { asks: Ask[]; declined: { subject: string; why: string }[] } {
  const openRounds = snapshot.rounds.filter((one) => one.state === 'OPEN').length;
  return allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_PROGRAMME_ROUNDS - openRounds),
  });
}
