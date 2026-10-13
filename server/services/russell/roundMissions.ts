/**
 * What a kernel round's own idea has become, read by key.
 *
 * Every kernel that asks the world a question does it the same way: a round
 * row names the Russell candidate it created, the candidate becomes a mission,
 * the mission launches an orchestration, and the round settles when that
 * mission ends. Four kernels and three Cash passes each found "the mission for
 * this round" by reading `listMissions({ projectId })` — the hundred most
 * recently updated missions of the project — and treating a round whose
 * mission was not in that window as still running. Cash Mode 1 holds hundreds
 * of missions, so a round's mission fell out of the window and the round held
 * its slot for ever (RES-2). And three of the four kernels settled only on
 * `DONE`, so a mission that FAILED — about three in four, there — left its
 * round OPEN for ever too.
 *
 * This is the one answer they all read now. It is keyed by the rounds' own
 * candidate ids, so its cost is the rounds asked about rather than the
 * project's history, and it never infers anything from a row being absent:
 * no mission is "not finished yet", never "failed".
 *
 * The outcome is decided by the idea's **latest** mission (by attempt), because
 * a redo supersedes the attempt before it: an earlier FAILED attempt beside a
 * RUNNING one is a round still being worked on. Every attempt's orchestration
 * is returned, because each one may have filed claims the round asked for.
 *
 * - latest mission DONE → `HARVESTED`
 * - latest mission FAILED or CANCELLED → `ABANDONED`
 * - no mission, and the idea was REJECTED (the archive already answered it) →
 *   `ABANDONED`: a positive terminal row, not an absence, and nothing will
 *   ever launch for it
 * - anything else — no mission yet, PLANNED, RUNNING, WAITING, NEEDS_HUMAN, a
 *   PARKED idea that has a way back — → `null`, and the round stays OPEN
 *
 * Labor's `absorb` settles correctly on both outcomes and still reads the
 * window; it is not this module's to change, and the integration note names it.
 */
import { missionsForCandidates } from '../../repos/russellMissions.ts';
import { candidateStates } from '../../repos/russellCandidates.ts';
import type { RussellMission } from '../../domain/types.ts';

export type RoundOutcome = 'HARVESTED' | 'ABANDONED';

export interface RoundMissions {
  candidateId: string;
  /** Every orchestration any attempt launched, oldest attempt first. */
  orchestrationIds: string[];
  /** The attempt that decides the outcome, or null when nothing launched. */
  latest: RussellMission | null;
  /** How the round settles now, or null when it must stay OPEN. */
  outcome: RoundOutcome | null;
}

/** The pure half, so the rule can be read and tested without a database. */
export function roundOutcome(input: {
  latest: RussellMission | null;
  candidateState: string | null;
}): RoundOutcome | null {
  const { latest } = input;
  if (latest) {
    if (latest.state === 'DONE') return 'HARVESTED';
    if (latest.state === 'FAILED' || latest.state === 'CANCELLED') return 'ABANDONED';
    return null;
  }
  return input.candidateState === 'REJECTED' ? 'ABANDONED' : null;
}

export async function missionsForRounds(
  candidateIds: readonly string[],
): Promise<Map<string, RoundMissions>> {
  const out = new Map<string, RoundMissions>();
  if (candidateIds.length === 0) return out;
  const [missions, states] = await Promise.all([
    missionsForCandidates(candidateIds),
    candidateStates(candidateIds),
  ]);
  for (const candidateId of new Set(candidateIds)) {
    const list = missions.get(candidateId) ?? [];
    const latest = list.length ? (list[list.length - 1] ?? null) : null;
    out.set(candidateId, {
      candidateId,
      orchestrationIds: list
        .map((one) => one.orchestrationId)
        .filter((one): one is string => one !== null),
      latest,
      outcome: roundOutcome({ latest, candidateState: states.get(candidateId) ?? null }),
    });
  }
  return out;
}

/**
 * Every row a paged read returns, one bounded page at a time.
 *
 * A round settles once, and `found` is what the allocator decides the next
 * round against — so the read a round settles on has to be complete. The claim
 * reads are bounded per call and oldest-first; a round with more claims than
 * one page would otherwise settle having filed the first page and counted only
 * that (RES-2's window, one table along). Paging costs the claims of the rounds
 * settling this pass, which is the work settlement genuinely needs.
 */
export async function everyPage<T>(
  page: (offset: number, limit: number) => Promise<T[]>,
  size = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += size) {
    const rows = await page(offset, size);
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

/**
 * Claims gathered from several rounds, in the order they were written.
 *
 * Filing order is observable — the first spelling of a subject to arrive is
 * the one a reader sees — so claims from rounds settling in one pass are filed
 * oldest first across all of them, exactly as the single windowed read used to
 * order them, rather than round by round.
 */
export function byClaimTime<T extends { claim: { createdAt: string; id: string } }>(
  entries: readonly T[],
): T[] {
  /*
   * Stable on the timestamp alone. Each claim read is already ordered
   * `created_at, rowid`, which is insertion order; breaking a same-millisecond
   * tie by the claim's random id instead reordered claims one submission wrote
   * together, so a capital restructuring could be filed before the requirement
   * it names and be refused for naming nothing (industryKernel "capital and
   * constraints reach the right table").
   */
  return [...entries].sort((a, b) =>
    a.claim.createdAt < b.claim.createdAt ? -1 : a.claim.createdAt > b.claim.createdAt ? 1 : 0,
  );
}
