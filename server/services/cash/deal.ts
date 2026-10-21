/**
 * Who holds each execution job: dealt evenly across the people who have joined.
 *
 * ---------------------------------------------------------------------------
 * The plate that was missing
 * ---------------------------------------------------------------------------
 *
 * Discovery is one shared frontier (`root.ts`), and separation begins when a
 * validated opening becomes an execution job. `reconcileCashJobs` prepared
 * every job owned by `opportunity.ownerUserId`, which is the sprint's owner — so
 * however many people had joined, one of them held every job and the others had
 * an empty plate. The job row already carries an owner, PRIVATE visibility and a
 * compare-and-swap assignment; nothing chose the owner.
 *
 * The owner's rule (2026-10-21): every account gets an even mix of every kind of
 * job, dealt out like cards, no two accounts ever hold the same job, and what
 * each person earns should differ only by how hard they work — never by which
 * jobs they were given.
 *
 * ---------------------------------------------------------------------------
 * The rule, and why it is not a score
 * ---------------------------------------------------------------------------
 *
 * Lexicographic over three facts, each read from rows:
 *
 *   1. fewest jobs of this opening's mechanism (the "kind" — 4 lead jobs is one each);
 *   2. then fewest jobs in all (a kind that runs short is made up with another kind);
 *   3. then the order of the user id, so the answer is the same on every call.
 *
 * No weight, no probability: the first criterion two people differ on is the
 * whole reason the job went where it did, and that sentence is recorded.
 *
 * "Jobs" means every job that is not RELEASED — a collected deal still counts,
 * because the mix is about what each person was given over the sprint, not
 * what happens to be open this minute.
 *
 * No two accounts ever hold the same job because a job is one row per opening
 * (the partial unique index on live jobs) and it has exactly one owner.
 *
 * ---------------------------------------------------------------------------
 * Who is dealt to
 * ---------------------------------------------------------------------------
 *
 * The people who have joined: `peopleReading`'s READY members — real people who
 * can sign in, system identities excluded — which is the one derivation the
 * People page and readiness already read. A person still holding an unused link
 * is not dealt work they cannot open. With nobody READY the job stays with the
 * opening's owner, exactly as before.
 *
 * It decides an owner and nothing else: it contacts nobody, spends nothing and
 * moves no opportunity.
 */
import type { CashMechanism } from '../../domain/types.ts';

/** One job as the dealer counts it. */
export interface DealtJob {
  ownerUserId: string | null;
  mechanism: CashMechanism | string;
}

export interface DealChoice {
  userId: string;
  /** Why this person, in the words of the first criterion that decided it. */
  because: string;
  sameKind: number;
  total: number;
}

/**
 * The person the next job of `mechanism` goes to, or null with nobody to deal to.
 *
 * Pure over what it is handed, so "why did this job go to that person" is
 * answerable from the recorded counts rather than from a re-run.
 */
export function chooseHolder(
  mechanism: CashMechanism | string,
  seats: readonly string[],
  jobs: readonly DealtJob[],
): DealChoice | null {
  const ordered = [...new Set(seats)].sort();
  if (ordered.length === 0) return null;

  const tally = ordered.map((userId) => {
    let sameKind = 0;
    let total = 0;
    for (const job of jobs) {
      if (job.ownerUserId !== userId) continue;
      total += 1;
      if (job.mechanism === mechanism) sameKind += 1;
    }
    return { userId, sameKind, total };
  });

  const sorted = [...tally].sort(
    (a, b) => a.sameKind - b.sameKind || a.total - b.total || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  const pick = sorted[0]!;
  const next = sorted[1];

  let because: string;
  if (ordered.length === 1) {
    because = 'they are the only person who has joined';
  } else if (next && pick.sameKind < next.sameKind) {
    because = `they held the fewest ${String(mechanism).toLowerCase()} jobs (${pick.sameKind})`;
  } else if (next && pick.total < next.total) {
    because = `they held as few ${String(mechanism).toLowerCase()} jobs as anybody and the fewest jobs in all (${pick.total})`;
  } else {
    because = `everybody held the same mix (${pick.sameKind} of this kind, ${pick.total} in all), so it went in turn`;
  }
  return { userId: pick.userId, because, sameKind: pick.sameKind, total: pick.total };
}
