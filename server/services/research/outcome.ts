/**
 * What a judge's verdict means for the packet, as opposed to for the research.
 *
 * These were the same thing until the first live packet finished, and that is
 * how a packet whose own judge had said MORE_RESEARCH came to read as an
 * answer. `brain_submit_audit` set COMPLETE for any validated verdict, so the
 * only terminal state available said "done" whatever the judge had concluded.
 *
 * Three outcomes now, and which one applies is decided from rows rather than
 * from the verdict alone:
 *
 * - **ANSWERED** (`COMPLETE`) — the judge advanced it. Nothing is outstanding.
 * - **REPAIRABLE** (`AWAITING_REPAIR`) — the judge wants more, and there is a
 *   fragment this run may still attempt: it is BLOCKED, it has attempts left,
 *   and the packet is authorized and inside its allowance. The runner mints
 *   that attempt, so the state is backed by claimable work rather than by a
 *   sentence.
 * - **COMPLETE_WITH_GAPS** — the judge wants more and this run has nothing
 *   left to try. Filed, audited, honestly short, and terminal.
 * - **NEEDS_HUMAN** — continuing needs something only a person can give: an
 *   authorization the packet does not have, or a decision about scope.
 */
import type { AuditVerdict, ResearchFragment, ResearchOrchestration } from '../../domain/types.ts';

/** The verdicts that mean the judge was satisfied. */
const ADVANCING: AuditVerdict[] = ['PASS', 'KEEP', 'READY_FOR_SYNTHESIS', 'READY_TO_FREEZE'];

export type PacketOutcome = 'COMPLETE' | 'AWAITING_REPAIR' | 'COMPLETE_WITH_GAPS' | 'NEEDS_HUMAN';

/**
 * A fragment this run may still attempt.
 *
 * BLOCKED rather than any terminal state, because BLOCKED is the one that says
 * "this failed and could be tried differently" — `retryFragment` accepts only
 * that.
 *
 * Counted the way the **repair planner** counts, not the way `retryFragment`
 * does, and that is a correction. `retryFragment` allows an attempt while
 * `attempt <= maxRepairs`; `buildRepairPlan` plans `MARK_UNRESOLVED` once the
 * remaining budget (`maxRepairs - attempt + 1`) is down to one, so on the
 * worker path a fragment at `attempt == maxRepairs` is never repaired. This
 * used to promise that attempt anyway, so the judge path wrote
 * `AWAITING_REPAIR`, `mintRepairs` minted nothing, the empty-queue guard wrote
 * `NEEDS_HUMAN`, and the next advance wrote `AWAITING_REPAIR` again — every
 * tick, on every packet whose fragment was on its last attempt (RES-8). The
 * planner is the stricter of the two and the one that actually decides, so
 * this asks its question.
 *
 * Necessary rather than sufficient: a fragment can pass this and still be
 * refused by the planner (its ladder is spent) or be doomed by a dependency.
 * `assessRepairs` in the packet runner asks those, and passes its answer to
 * `outcomeFor` as `repairableNow` so the two cannot disagree.
 */
export function repairable(fragments: ResearchFragment[]): ResearchFragment[] {
  return fragments.filter(
    (fragment) => fragment.status === 'BLOCKED' && fragment.attempt < fragment.maxRepairs,
  );
}

export function outcomeFor(input: {
  verdict: AuditVerdict;
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
  /**
   * The fragments a repair would actually be minted for, when the caller has
   * asked the planner. Absent, `repairable` is the best a pure function can
   * say — and an advance re-derives with the full answer straight afterwards.
   */
  repairableNow?: ResearchFragment[];
}): PacketOutcome {
  if (ADVANCING.includes(input.verdict)) return 'COMPLETE';

  // The judge asked for more. Can this run honestly give it?
  const now = input.repairableNow ?? repairable(input.fragments);
  if (now.length > 0) return 'AWAITING_REPAIR';

  /**
   * Nothing left to attempt. Whether that is terminal or a question for a
   * person turns on one thing: was this packet allowed to declare its gaps?
   *
   * A packet authorized for RECORD_GAPS was told in advance that filing short
   * is an acceptable outcome, and it has already recorded which requirements it
   * is short on. Filing it is the honest end of the run. A packet with no such
   * authorization was never given that permission, and taking it would be the
   * Brain narrowing a goal nobody agreed to narrow.
   */
  return input.orchestration.unresolvedGapPolicy === 'RECORD_GAPS'
    ? 'COMPLETE_WITH_GAPS'
    : 'NEEDS_HUMAN';
}

/** Terminal for the workflow. `AWAITING_REPAIR` deliberately is not. */
export const TERMINAL_ORCHESTRATION = new Set([
  'COMPLETE',
  'COMPLETE_WITH_GAPS',
  'FAILED',
  'CANCELLED',
]);
