/**
 * One project's industry kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the fifth
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. A
 * sprint that was activated before this kernel existed gets a map on the next
 * tick with nobody pressing anything; a tick that dies halfway leaves rows the
 * next one reads correctly; and two instances running it produce one round,
 * because the arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * It is bounded by concurrency, and by nothing else
 * ---------------------------------------------------------------------------
 *
 * There is no lifetime quota on how many subjects Brain may map or scan. §24
 * removed exactly that kind of number from the standing authority and recorded
 * why: nothing it rationed was scarce, so it measured a starting point and
 * then became a permanent ceiling. What bounds this is how many questions may
 * be *open at once*, which is real — provider capacity, and the same slot the
 * deep dives compete for.
 *
 * ---------------------------------------------------------------------------
 * It refuses to run where discovery is refused
 * ---------------------------------------------------------------------------
 *
 * Opening a kernel round is new discovery, so it is behind `discoveryAllowed`
 * — the same gate the buckets are behind. Absorbing is not: filing what
 * research already found is not new discovery, the spending happened when it
 * ran, and dropping results because the sprint wound down would throw away
 * work already paid for. §30's rule that winding down ends new discovery and
 * never a customer's obligation, applied one table along.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import { listCapitalForProject } from '../../repos/industry.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { allocate, MAX_OPEN_KERNEL_ROUNDS, type Ask } from './allocate.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { graphSnapshot, type GraphSnapshot } from './graph.ts';

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  /** The map as it stood when the decision was made. */
  nodes: number;
  openRounds: number;
}

const EMPTY: KernelPass = {
  opened: [],
  absorbed: { nodes: [], constraints: [], capital: [], settled: [], refused: [] },
  declined: [],
  nodes: 0,
  openRounds: 0,
};

export async function runIndustryKernel(projectId: string): Promise<KernelPass> {
  // One read answers it for the many projects that hold no sprint at all,
  // which is what makes this cheap enough to run for every project every tick.
  if (!(await getCashMode(projectId))) return EMPTY;

  /*
   * Absorb first, deliberately.
   *
   * A round that settled on the previous pass has children, constraints or
   * capital entries to file, and filing them changes what the allocator sees:
   * a subject that has just gained five sub-industries should be deciding
   * about those on this pass rather than on the next one. Allocating first
   * would make every discovery a tick late, for ever.
   */
  const absorbed = await absorb({ projectId });

  const snapshot = await graphSnapshot(projectId);
  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) {
    return {
      opened: [],
      absorbed,
      declined: [{ subject: 'every subject on the map', why: gate.reason }],
      nodes: snapshot.nodes.filter((one) => one.retiredAt === null).length,
      openRounds: snapshot.rounds.filter((one) => one.state === 'OPEN').length,
    };
  }

  const plan = await planFrom(snapshot);
  const opened = await openAsks({ projectId, asks: plan.asks, snapshot });

  return {
    opened,
    absorbed,
    declined: plan.declined,
    nodes: snapshot.nodes.filter((one) => one.retiredAt === null).length,
    openRounds: snapshot.rounds.filter((one) => one.state === 'OPEN').length,
  };
}

/**
 * The allocation for one snapshot, with the free slots counted from it.
 *
 * Exported separately from the pass that acts on it so that a person — or a
 * test — can ask *what would Brain do next* without anything being created.
 * `services/realize/prove.ts` splits reading from applying for the same
 * reason: somebody should be able to look before anything moves.
 */
export async function planFrom(
  snapshot: GraphSnapshot,
): Promise<{ asks: Ask[]; declined: { subject: string; why: string }[] }> {
  const openRounds = snapshot.rounds.filter((one) => one.state === 'OPEN').length;
  const capital = await listCapitalForProject(snapshot.projectId);
  return allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_KERNEL_ROUNDS - openRounds),
    capitalDecomposed: new Set(capital.map((one) => one.opportunityId)),
  });
}
