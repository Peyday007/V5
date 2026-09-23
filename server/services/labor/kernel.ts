/**
 * One project's labor kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the sixth
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. A
 * portfolio that was qualified before this kernel existed gets a labor map on
 * the next tick with nobody pressing anything; a tick that dies halfway leaves
 * rows the next one reads correctly; and two instances running it produce one
 * round, because the arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * What bounds it, and what deliberately does not
 * ---------------------------------------------------------------------------
 *
 * The standing research authority bounds it, because that is what authorizes
 * spending anything at all, and the concurrency ceiling bounds it, because
 * fleet slots are genuinely scarce. There is no lifetime quota: §24 removed
 * exactly that kind of number and recorded why.
 *
 * A cash sprint winding down does **not** bound it, and that is a decision
 * rather than an oversight. A labor question asks how work Brain has already
 * committed to is actually produced; it finds no opening and creates no
 * obligation. §30 records its own correction on this exact point — an off
 * switch that stopped work it did not own reached past the thing it owns — and
 * a kernel that stopped asking whether a delivery still needs a person, at the
 * moment somebody decided to stop finding new work, would be the same defect
 * one table along.
 *
 * ---------------------------------------------------------------------------
 * The one thing it writes for itself
 * ---------------------------------------------------------------------------
 *
 * Brain records an allocation only where the necessity test settles it, in
 * either direction. On `NOT_ESTABLISHED` — which is most tasks, most of the
 * time — it writes nothing and the task reads as undecided, because that is
 * what it is.
 */
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../russell/launch.ts';
import { deriveFromPortfolio, type Derived } from './derive.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { assignByBrain } from './assign.ts';
import { allocate, MAX_OPEN_LABOR_ROUNDS } from './allocate.ts';
import { laborSnapshot } from './map.ts';
import type { LaborAllocation } from '../../domain/types.ts';

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Workflows and tasks the portfolio produced this pass. */
  derived: Derived;
  /** Allocations Brain recorded because the test settled them. */
  decided: LaborAllocation[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  tasks: number;
  openRounds: number;
}

const EMPTY: KernelPass = {
  opened: [],
  absorbed: { answers: [], options: [], settled: [], refused: [] },
  derived: { workflows: [], tasks: [], unrecognized: [], collided: [] },
  decided: [],
  declined: [],
  tasks: 0,
  openRounds: 0,
};

export async function runLaborKernel(projectId: string): Promise<KernelPass> {
  /*
   * Derive first, so a task that appeared this pass is assessed this pass.
   *
   * `absorb` then files what finished rounds established, and only after both
   * does the allocator see the map. Allocating first would make every new task
   * and every arriving answer a tick late, for ever — the ordering `absorb`
   * already has one kernel along, for the same reason.
   */
  const derived = await deriveFromPortfolio(projectId);
  const absorbed = await absorb({ projectId });

  const snapshot = await laborSnapshot(projectId);
  if (snapshot.coverage.length === 0) {
    return { ...EMPTY, derived, absorbed };
  }

  /*
   * What the test now settles, recorded before anything is asked.
   *
   * A task that has just become defensible for Brain should not also be
   * queued for another question about whether it needs a person. Deciding
   * first means the allocator sees the decision, which is the same argument
   * for absorbing before allocating one paragraph up.
   */
  const decided: LaborAllocation[] = [];
  for (const coverage of snapshot.coverage) {
    if (coverage.necessity.verdict === 'NOT_ESTABLISHED') continue;
    const outcome = await assignByBrain({
      projectId,
      task: coverage.task,
      reading: coverage.necessity,
    });
    if (outcome.ok && outcome.changed) decided.push(outcome.allocation);
  }

  const openRounds = snapshot.rounds.filter((one) => one.state === 'OPEN').length;

  /*
   * Opening a round spends the allowance, so it is behind the standing
   * authority — and nothing else here is.
   *
   * Deriving, absorbing and deciding all run whatever that authority says:
   * they read rows Brain already holds, and refusing them because nothing is
   * authorized to be *spent* would leave a project unable to read its own map.
   */
  const grant = await checkAuthority({ projectId, workClass: RESEARCH_WORK_CLASS });
  if (!grant.ok) {
    /*
     * Asked here rather than left to `launch`, and that is the difference
     * between parking and stranding.
     *
     * A round is written when its candidate is created and settles when the
     * mission that candidate launched finishes. A candidate that parks for
     * want of authority launches no mission, so its round would stay `OPEN`
     * for ever — and an open round is precisely what stops that purpose being
     * asked again. §24's *waiting nobody can resolve*, arriving through a
     * table nobody would think to look at.
     */
    return {
      opened: [],
      absorbed,
      derived,
      decided,
      declined: [
        {
          subject: 'every task on the map',
          why:
            `Nothing may be spent asking about this project: ${grant.reason}. The map, the ` +
            'decisions Brain can settle from its own rows, and every reading are unaffected.',
        },
      ],
      tasks: snapshot.coverage.length,
      openRounds,
    };
  }

  const planned = allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_LABOR_ROUNDS - openRounds),
  });
  const opened = await openAsks({ projectId, asks: planned.asks, snapshot });

  return {
    opened,
    absorbed,
    derived,
    decided,
    declined: planned.declined,
    tasks: snapshot.coverage.length,
    openRounds,
  };
}
