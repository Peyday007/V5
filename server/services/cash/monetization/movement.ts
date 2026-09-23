/**
 * Recording that a position moved, and why.
 *
 * ---------------------------------------------------------------------------
 * Why anything is written at all
 * ---------------------------------------------------------------------------
 *
 * Where a possibility ranks is derived on every request and is therefore always
 * current; writing it down would be a cache, and a stale one within a tick.
 * Where it ranked *yesterday* is a different fact, and it is gone the moment the
 * rows underneath it change — so the brief's "previous rank" and "reason for
 * ranking movement" cannot be answered by any derivation, however good.
 *
 * That is exactly the argument §29 makes for the frontier table: everything
 * about a reading can be re-derived except that it used to read differently. So
 * this appends an observation when the derived position differs from the last
 * one recorded, and writes nothing at all when it does not — which is what
 * keeps the table a history rather than a log of ticks.
 *
 * ---------------------------------------------------------------------------
 * The reason is read, never narrated
 * ---------------------------------------------------------------------------
 *
 * Both halves of "why did this move" come from rows. The *reason* is one of a
 * closed set, decided by comparing timestamps against the last snapshot: a
 * judgement recorded since then, a status that differs, facts that were updated,
 * or none of those — in which case nothing about this path changed and the field
 * around it did. The *criterion* is the first ranking comparison on which it now
 * differs from whatever it passed, which a lexicographic order answers exactly.
 *
 * Nothing here asks a model what happened, and nothing here composes a sentence
 * about it. A reader gets a vocabulary term and a criterion, both of which
 * resolve to something they can go and look at.
 */
import {
  latestSnapshots,
  listJudgments,
  markEvaluated,
  recordSnapshot,
} from '../../../repos/monetization.ts';
import { pathFactsForProject } from '../../../repos/monetization.ts';
import { composeLedger, rankableOf, type Ledger } from './ledger.ts';
import { CRITERIA, explainRanking, type RankableEntry } from './rank.ts';
import type { RankMovementReason } from '../../../domain/types.ts';

export interface Movement {
  pathId: string;
  rank: number;
  previousRank: number | null;
  reason: RankMovementReason;
  criterion: string | null;
}

export interface MovementReport {
  /** Only the positions that actually changed. An unchanged pass reports none. */
  movements: Movement[];
  /** How many paths were looked at, whether or not they moved. */
  evaluated: number;
}

/**
 * Re-read the ledger, and record what moved.
 *
 * Idempotent by its own comparison rather than by a flag: running it twice in a
 * row over unchanged rows produces one set of movements and then none, because
 * the second pass finds the snapshots the first one wrote. A tick that dies
 * halfway leaves the paths it got to recorded and the rest unrecorded, and the
 * next pass finishes them — there is no partial state to repair.
 *
 * It writes two kinds of row and nothing else: a snapshot per movement, and the
 * evaluation timestamp on every path it looked at. It moves no state, refuses
 * nothing, charges no attempt and starts no work.
 */
export async function recordMovements(input: {
  projectId: string;
  now?: string;
  /** The ledger, if the caller has already composed one. Read here otherwise. */
  ledger?: Ledger;
}): Promise<MovementReport> {
  const at = input.now ?? new Date().toISOString();
  const ledger = input.ledger ?? (await composeLedger({ projectId: input.projectId, now: at }));
  if (ledger.entries.length === 0) return { movements: [], evaluated: 0 };

  const previous = await latestSnapshots(input.projectId);

  /*
   * When each path's own rows were last touched, so the reason can distinguish
   * "something about this changed" from "something else did".
   *
   * Read as two project-wide queries rather than per path, which is the same
   * economy every other read on this page makes.
   */
  const factTouched = new Map<string, string>();
  for (const fact of await pathFactsForProject(input.projectId)) {
    const seen = factTouched.get(fact.pathId);
    if (!seen || fact.updatedAt > seen) factTouched.set(fact.pathId, fact.updatedAt);
  }
  const judged = new Map<string, string>();
  for (const judgment of await listJudgments(input.projectId)) {
    judged.set(judgment.pathId, judgment.createdAt);
  }

  const ranked = ledger.entries.map(rankableOf);
  const movements: Movement[] = [];

  for (const entry of ledger.entries) {
    const before = previous.get(entry.path.id) ?? null;
    if (before && before.rank === entry.rank) continue;

    const reason: RankMovementReason = !before
      ? 'ENTERED_THE_LEDGER'
      : (judged.get(entry.path.id) ?? '') > before.evaluatedAt
        ? 'A_PERSON_DECIDED'
        : before.status !== entry.status
          ? 'ITS_STATUS_CHANGED'
          : (factTouched.get(entry.path.id) ?? '') > before.evaluatedAt
            ? 'ITS_OWN_EVIDENCE_CHANGED'
            : 'THE_FIELD_AROUND_IT_CHANGED';

    const movement: Movement = {
      pathId: entry.path.id,
      rank: entry.rank,
      previousRank: before?.rank ?? null,
      reason,
      criterion: before ? criterionAgainstNeighbour(entry.rank, before.rank, ranked) : null,
    };
    movements.push(movement);
    await recordSnapshot({
      projectId: input.projectId,
      pathId: entry.path.id,
      rank: movement.rank,
      previousRank: movement.previousRank,
      reason: movement.reason,
      status: entry.status,
      criterion: movement.criterion,
      evaluatedAt: at,
    });
  }

  await markEvaluated(
    ledger.entries.map((one) => one.path.id),
    at,
  );

  return { movements, evaluated: ledger.entries.length };
}

/**
 * The criterion by which a path now differs from whatever it passed.
 *
 * A path that went up passed the one now directly below it; a path that went
 * down was passed by the one now directly above it. In both cases the first
 * criterion on which the two differ is the whole answer — there is nothing
 * weighted or summed to unpick — and naming it is a reading rather than a story
 * about what happened.
 *
 * Null where there is no neighbour, which is a real answer: the only path in a
 * ledger has nothing to have been ordered against.
 */
function criterionAgainstNeighbour(
  rank: number,
  previousRank: number,
  ranked: readonly RankableEntry[],
): string | null {
  const me = ranked[rank - 1];
  if (!me) return null;
  const neighbour = rank < previousRank ? ranked[rank] : ranked[rank - 2];
  if (!neighbour) return null;
  return explainRanking(me, neighbour).criterion;
}

/** Every criterion the order is decided on, in order, for a reader. */
export function criteriaInOrder(): { id: string; label: string }[] {
  return CRITERIA.map((one) => ({ id: one.id, label: one.label }));
}
