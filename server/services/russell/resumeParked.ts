/**
 * Give a park for missing standing authority a way back — on every project.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to remove
 * ---------------------------------------------------------------------------
 *
 * `judgeCandidate` (`./planning.ts`, `standingAuthority`) correctly parks an
 * idea when its project holds no live standing authority covering RESEARCH,
 * with a `judgment.blockedBy` a person can act on. Once that person grants the
 * authority, nothing reconsidered the park: `unjudged()` in `./loop.ts` selects
 * `priority IS NULL` and a park carries `priority = 'PARKED'`, so the candidate
 * could never be judged again.
 *
 * The only resume that existed was `resumeAuthorityParkedCandidates` in
 * `../cash/discoveryAuthority.ts` — called only from Cash Mode's own discovery
 * pass, and gated on a goal named `'Cash Mode internal discovery'` specifically.
 * So the park had a way back on exactly one kind of project and was permanent
 * on every other one, which is recorded as a defect in
 * `docs/STEP-12B-BACKLOG.md` ("a park for missing authority has no way back").
 *
 * ---------------------------------------------------------------------------
 * One rule, asked generically
 * ---------------------------------------------------------------------------
 *
 * `blockedOnStandingAuthority` reads the one key `standingAuthority()` writes
 * and compares it against the exact sentences `checkAuthority` itself produces
 * — never a substring match on "authority" appearing anywhere in the reason,
 * because a candidate parked for a different reason (a prohibition, a missing
 * layer) is a different fact and resuming it would be Brain re-answering a
 * question a person already answered.
 *
 * Eligibility is decided by `checkAuthority({ projectId, workClass: RESEARCH })`
 * — the same generic check `standingAuthority()` itself calls — rather than by
 * looking up a goal with a specific name. A project qualifies because *some*
 * live grant covers RESEARCH, whichever kernel or person created it, so this
 * reaches a park however it came to have one.
 *
 * `resumeParkedForProject` is the project-scoped core: it is what Cash Mode's
 * own `resumeAuthorityParkedCandidates` now calls, so there is one rule rather
 * than two. `resumeParkedAcrossProjects` is the tick-wide sweep, and it
 * deliberately skips a project currently running Cash Mode (any `cash_modes`
 * row not `ARCHIVED`): that project's own discovery pass already calls the
 * project-scoped core every tick and records its own `CASH_DISCOVERY_RESUMED`
 * event for it, so sweeping it here as well would just mean the sweep finds
 * nothing left to do there — the guarded UPDATE below is what makes that safe
 * rather than a source of duplication, but skipping it keeps Cash Mode's own
 * reporting exactly what it was.
 *
 * ---------------------------------------------------------------------------
 * The transition, and what makes two passes produce one result
 * ---------------------------------------------------------------------------
 *
 * The tick runs every few seconds, on more than one instance, and a resume a
 * person triggers by hand can race one already in flight. So the arbiter is
 * the guarded `UPDATE ... WHERE id = ? AND state = 'PARKED' AND priority =
 * 'PARKED'`: it clears `priority`, which is precisely what `unjudged()` selects
 * on, and returns the candidate to `CAPTURED`. A second caller racing for the
 * same row matches nothing and moves on. This codebase's own recurring
 * sentence, applied here for the ninth time: a compare-and-swap has to be on a
 * value the claimant does not supply.
 *
 * A successful resume records one append-only event carrying the previous
 * reason, because a park that was real is history worth keeping even once it
 * has been answered. `project_events` is where a fact about *any* project
 * belongs, and adding it a dedicated `EventType` is the right shape for that —
 * but the `EventType` union lives in `server/domain/types.ts`, which is outside
 * this change's approved mutation scope. `cash_events` carries no foreign key
 * to `cash_modes` and no constraint tying it to a sprint, so it is the nearest
 * already-existing append-only, per-project, free-form ledger available inside
 * this scope, and it is used here as a deliberate, documented substitute rather
 * than a quiet one. A dedicated `project_events` entry for this is worth adding
 * in a later change that can touch the type union.
 */
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from './launch.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { getDb } from '../../db/database.ts';
import { nowIso } from '../../repos/util.ts';

export interface ResumedAuthorityCandidate {
  candidateId: string;
  projectId: string;
  previousReason: string | null;
}

interface ParkedCandidateRow {
  id: string;
  project_id: string;
  reason: string | null;
  judgment: string;
}

/**
 * Was this idea parked because no standing authority covered RESEARCH?
 *
 * Reads the one key `standingAuthority()` writes, and compares it against the
 * exact sentences `checkAuthority` itself produces. It deliberately does not
 * match on "authority" appearing anywhere in the reason: a candidate parked
 * because a commercial grant prohibits an action is a different fact, and
 * resuming it would be Brain answering a question a person had already
 * answered.
 */
export function blockedOnStandingAuthority(judgment: string): boolean {
  let blockedBy: unknown;
  try {
    blockedBy = (JSON.parse(judgment) as Record<string, unknown>)['blockedBy'];
  } catch {
    return false;
  }
  if (typeof blockedBy !== 'string') return false;
  return (
    blockedBy === 'no standing authority exists for this project' ||
    blockedBy === `no live standing authority covers ${RESEARCH_WORK_CLASS} in this project` ||
    blockedBy === 'a standing authority for research on this project'
  );
}

/**
 * The guarded transition, shared by every caller in this module.
 *
 * One `UPDATE` naming the exact state it moves from, so two callers racing on
 * the same row produce exactly one change — the loser's `changes` reads 0 and
 * it is an ordinary outcome, not an error.
 */
async function resumeRow(row: ParkedCandidateRow): Promise<ResumedAuthorityCandidate | null> {
  const at = nowIso();
  const moved = await getDb().run(
    `UPDATE russell_candidates
        SET state = 'CAPTURED', priority = NULL, ordinal = NULL, reason = NULL, updated_at = ?
      WHERE id = ? AND state = 'PARKED' AND priority = 'PARKED'`,
    [at, row.id],
  );
  if (moved.changes !== 1) return null;
  return { candidateId: row.id, projectId: row.project_id, previousReason: row.reason };
}

/**
 * Put back one project's ideas parked for want of the authority it now holds.
 *
 * The condition is narrow on purpose and every part of it is a fact Brain
 * wrote: the candidate is `PARKED` with `priority = 'PARKED'`, which is the
 * state `judgeCandidate` records and nothing else writes; its
 * `judgment.blockedBy` names the missing authority, composed by
 * `standingAuthority()` rather than by any model; and a live grant now covers
 * RESEARCH on this project, decided by `checkAuthority` — generically, by
 * whichever goal actually covers it, never by a goal's name.
 *
 * What it does is the minimum that lets the ordinary path take over: clear
 * `priority`, which is exactly what `unjudged()` selects on, and return the
 * candidate to `CAPTURED`. It creates no candidate, no round, no mission and no
 * duplicate of anything, and it never runs for a candidate parked for some
 * other reason. Records nothing itself — a caller that knows what kind of
 * project this is (Cash Mode, or not) is the one that can record the right
 * kind of event for it.
 */
export async function resumeParkedForProject(input: {
  projectId: string;
  limit?: number;
}): Promise<ResumedAuthorityCandidate[]> {
  const decision = await checkAuthority({
    projectId: input.projectId,
    workClass: RESEARCH_WORK_CLASS,
  });
  if (!decision.ok) return [];

  const rows = await getDb().all<ParkedCandidateRow>(
    `SELECT id, project_id, reason, judgment FROM russell_candidates
      WHERE project_id = ? AND state = 'PARKED' AND priority = 'PARKED'
      ORDER BY created_at, rowid
      LIMIT ?`,
    [input.projectId, Math.max(1, input.limit ?? 25)],
  );

  const out: ResumedAuthorityCandidate[] = [];
  for (const row of rows) {
    if (!blockedOnStandingAuthority(row.judgment)) continue;
    const resumed = await resumeRow(row);
    if (resumed) out.push(resumed);
  }
  return out;
}

/**
 * Put back every project's parks for missing authority, on the durable tick.
 *
 * Selects across every project in one query, the same shape `unjudged()` and
 * `retiredPlanning()` already use, rather than looping `listProjects()` and
 * asking each one — most projects hold no such park at all, and a global
 * selection reaches exactly the rows that matter.
 *
 * A project currently running Cash Mode (any `cash_modes` row that is not
 * `ARCHIVED`) is skipped here: `runDiscovery` already calls
 * `resumeAuthorityParkedCandidates` — which now delegates to
 * `resumeParkedForProject` — for that project on every tick, and records its
 * own `CASH_DISCOVERY_RESUMED` event. Sweeping it here too would be safe (the
 * guarded update makes a second attempt an ordinary no-op) and would just mean
 * Cash Mode's own event is the one that actually gets written, so excluding it
 * keeps that reporting exactly as it was rather than leaving it to depend on
 * which of two passes happens to run first.
 *
 * `checkAuthority` is asked at most once per distinct project in the batch,
 * because most parks that share a project share an answer to "does this
 * project have a live grant".
 */
export async function resumeParkedAcrossProjects(
  limit?: number,
): Promise<ResumedAuthorityCandidate[]> {
  const rows = await getDb().all<ParkedCandidateRow>(
    `SELECT id, project_id, reason, judgment FROM russell_candidates
      WHERE state = 'PARKED' AND priority = 'PARKED' AND project_id IS NOT NULL
      ORDER BY created_at, rowid
      LIMIT ?`,
    [Math.max(1, limit ?? 25)],
  );

  const authorized = new Map<string, boolean>();
  const runningCashMode = new Map<string, boolean>();
  const out: ResumedAuthorityCandidate[] = [];

  for (const row of rows) {
    if (!blockedOnStandingAuthority(row.judgment)) continue;

    let cashMode = runningCashMode.get(row.project_id);
    if (cashMode === undefined) {
      const mode = await getCashMode(row.project_id);
      cashMode = mode !== null && mode.state !== 'ARCHIVED';
      runningCashMode.set(row.project_id, cashMode);
    }
    if (cashMode) continue;

    let ok = authorized.get(row.project_id);
    if (ok === undefined) {
      ok = (
        await checkAuthority({ projectId: row.project_id, workClass: RESEARCH_WORK_CLASS })
      ).ok;
      authorized.set(row.project_id, ok);
    }
    if (!ok) continue;

    const resumed = await resumeRow(row);
    if (!resumed) continue;

    await recordCashEvent({
      projectId: row.project_id,
      kind: 'RUSSELL_AUTHORITY_PARK_RESUMED',
      actorRef: 'BRAIN',
      summary:
        'An idea that had nothing to run under is back in the queue now that this project ' +
        'holds a standing authority covering research.',
      detail: { candidateId: row.id, previousReason: row.reason },
    });
    out.push(resumed);
  }

  return out;
}
