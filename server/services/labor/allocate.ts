/**
 * Which labor question Brain asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason `services/dispatch/router.ts` is pure
 * ---------------------------------------------------------------------------
 *
 * A function over a recorded snapshot, so "why did Brain research that" is
 * answerable afterwards from an input rather than from a re-run against a
 * database that has moved on. Being pure also makes it useless as a safety
 * mechanism, which is deliberate and is the same split the dispatcher draws:
 * the exclusion is the unique index on `labor_rounds`, so two ticks both
 * deciding correctly that a task should be asked about produce one round.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic over rules, never a weighted score
 * ---------------------------------------------------------------------------
 *
 * Five rules in a fixed order. There is no scoring function because a score
 * needs weights, weights are a judgement nobody made, and the resulting number
 * reads like a measurement — `portfolio.ts` settled this for opportunities,
 * `allocate.ts` settled it for subjects, and nothing about tasks changes it.
 *
 * The order is the brief's own priority, and it is worth stating because it is
 * the opposite of the obvious one. **The most valuable question is about work
 * a person is doing today**, not about work nobody is doing at all: §7 asks
 * Brain to keep re-running the necessity test on roles that already exist,
 * because that is where a role can actually be compressed and where the money
 * is already going out. Blind spots come after that, and re-asking what has
 * gone quiet comes last.
 */
import { BARREN_ROUNDS, ROUND_COOL_OFF_MS } from '../cash/discovery.ts';
import { layerIsHuman } from '../../domain/labor.ts';
import type { LaborSnapshot, TaskCoverage } from './map.ts';
import type { LaborRoundPurpose } from '../../domain/types.ts';

export interface Ask {
  taskId: string;
  purpose: LaborRoundPurpose;
  round: number;
  /** Which rule admitted it. Lower is stronger, and the numbers are spaced. */
  rank: number;
  /**
   * What this is about, in words a person reads.
   *
   * Carried on the ask rather than resolved by each reader, for the reason
   * §38's allocator had to learn: the first version of that one left every
   * decline reading as a bare id, and §29 records what a status nobody can
   * read costs — they stop reading it.
   */
  subject: string;
  /** When Brain came to know about this task. The tiebreak between equal asks. */
  since: string;
  /** The recorded input, in words, so the decision can be argued with. */
  why: string;
}

/**
 * How many labor questions may be open at once.
 *
 * Not an allowance — §24 removed exactly that kind of number from the standing
 * authority and recorded why. It is a *concurrency* bound, which is the one
 * limit here that is real: this kernel competes for the same fleet slots the
 * industry map and every deep dive compete for, and a labor pass that queued
 * thirty tasks at once would push work already paid for behind them.
 *
 * Deliberately smaller than the industry kernel's. A labor question is the
 * newest and least proven of the three things that can spend a slot, and the
 * honest place for something unproven is behind the things that are not.
 */
export const MAX_OPEN_LABOR_ROUNDS = 3;

export interface AllocationInput {
  snapshot: LaborSnapshot;
  /** How many more rounds may be opened now. Never negative. */
  slots: number;
}

export interface Allocation {
  asks: Ask[];
  /** Everything considered and not asked, with the reason. Reported, not acted on. */
  declined: { subject: string; why: string }[];
}

export function allocate(input: AllocationInput): Allocation {
  const { snapshot } = input;
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: Allocation['declined'] = [];
  const candidates: Ask[] = [];

  const now = Date.parse(snapshot.at);

  for (const coverage of snapshot.coverage) {
    const { task } = coverage;
    const human = coverage.allocation ? layerIsHuman(coverage.allocation.productionLayer) : false;

    /*
     * Rule 1 — a person is doing this and nothing has established that they
     * must.
     *
     * The brief's §7 in one rule. This is the only question whose answer can
     * take a cost off the books, and the whole point of a kernel that re-runs
     * rather than a decision made once is that the answer changes as Brain
     * changes. It outranks the blind spots deliberately: a task nobody is
     * doing costs nothing today.
     *
     * `verdict !== 'HUMAN_REQUIRED'` is load-bearing and the first version of
     * this file did not have it. A role whose reason a published source has
     * already established is not a role with an open question, so asking again
     * spends a slot to learn what the rows say — and worse, it takes the slot
     * ahead of rule 2, which is the question that actually follows from an
     * established one. The suite found it by asserting the sequence rather
     * than the first ask.
     */
    if (
      human &&
      coverage.necessity.verdict !== 'HUMAN_REQUIRED' &&
      !coverage.purposesAsked.has('NECESSITY')
    ) {
      candidates.push(
        ask(coverage, 'NECESSITY', 100, 1, `This is being produced by a person and nothing has established that it has to be.`),
      );
      continue;
    }

    /*
     * Rule 2 — a person is established as necessary and nobody has asked where
     * that person could come from.
     *
     * §4: establishing that a human is needed settles nothing about whether
     * that human is domestic, full-time or employed at all, and the brief is
     * explicit that the default answer to both is usually wrong.
     */
    if (
      coverage.necessity.verdict === 'HUMAN_REQUIRED' &&
      !coverage.purposesAsked.has('MARKET')
    ) {
      candidates.push(
        ask(
          coverage,
          'MARKET',
          200,
          1,
          'A person is established as necessary here, and nothing published has been read about ' +
            'where that capability is actually sourced or what it costs.',
        ),
      );
      continue;
    }

    /*
     * Rule 3 — neither case is established and nothing has been asked.
     *
     * The blind spots. Cheapest question of the three, because a published
     * rule about who may perform work of this kind either exists or does not,
     * and a documented search of the places it would be is an answer either
     * way — §14's own standard for a negative.
     */
    if (
      coverage.necessity.verdict === 'NOT_ESTABLISHED' &&
      !coverage.purposesAsked.has('NECESSITY')
    ) {
      candidates.push(
        ask(
          coverage,
          'NECESSITY',
          300,
          1,
          'Neither a reason for a person nor a case for Brain is established here, and the ' +
            'question has never been asked.',
        ),
      );
      continue;
    }

    /*
     * Rule 4 — Brain is held back by something a precedent could move.
     *
     * Only where the blocker is one a published precedent bears on. A task
     * blocked on a licence is not helped by somebody else having automated
     * something, and asking would spend a slot to learn what the rows already
     * say.
     */
    const movable = coverage.necessity.blockers.some(
      (one) => one.kind === 'QUALITY_UNPROVEN' || one.kind === 'CAPABILITY_MISSING',
    );
    if (movable && !coverage.purposesAsked.has('PRECEDENT')) {
      candidates.push(
        ask(
          coverage,
          'PRECEDENT',
          400,
          1,
          `Brain is held back here by ${describeBlockers(coverage)}, and nothing has been read ` +
            'about whether this work is published as being done without a person.',
        ),
      );
      continue;
    }

    /*
     * Rule 5 — what has gone quiet, past its cool-off.
     *
     * The bounds are all here rather than scattered through the rules above,
     * because every one of them is about a purpose that has already been asked
     * at least once — and a rule that had to restate them would eventually
     * restate one of them differently.
     */
    for (const purpose of ['NECESSITY', 'MARKET', 'PRECEDENT'] as LaborRoundPurpose[]) {
      if (!coverage.purposesAsked.has(purpose)) continue;
      if (coverage.purposesOpen.has(purpose)) {
        declined.push({
          subject: coverage.path,
          why: `Its ${purpose.toLowerCase()} question is already running, and asking again would duplicate its spending.`,
        });
        continue;
      }
      const settled = coverage.roundsByPurpose[purpose];
      const found = coverage.foundByPurpose[purpose];
      /*
       * Barrenness is counted in rounds that actually *ran*, and this read
       * `roundsByPurpose` — the correction is recorded rather than quietly
       * applied.
       *
       * A round settles on any terminal mission, a failed or cancelled one
       * included, which is right: a round left OPEN for ever is the state
       * nothing can leave. But `roundsByPurpose` then counts a mission that
       * crashed exactly as it counts one that read the sources and found
       * nothing — so three abandoned missions retired the question permanently,
       * and the sentence written on the decline said "nothing published has
       * answered it. Brain has documented that there is nothing there" about a
       * question Brain had never once looked at. **A wrong answer confidently
       * derived is worse than no answer**, and this one was recorded as the
       * reason work stopped.
       *
       * Three abandonments in a row is not exotic on a fleet whose dispatch is
       * failing: §23 records eighteen consecutive `AUTH 401`s against one
       * Routine. The remedy for that is to fix the surface, and this would have
       * retired the questions before anybody did.
       *
       * `roundsByPurpose` still numbers the next round, and has to: numbering
       * from the harvested count alone would reuse a round number an abandoned
       * round already holds, collide on the unique index, and re-ask nothing
       * for ever — which is the same stranding by the other route.
       */
      const looked = coverage.harvestedByPurpose[purpose];
      if (looked >= BARREN_ROUNDS && found === 0) {
        /*
         * Not because looking is forbidden — because Brain has now documented
         * that there is nothing published there, and §13's rule about the
         * archive applies to Brain's own history exactly as it applies to a
         * project's.
         */
        declined.push({
          subject: coverage.path,
          why:
            `Its ${purpose.toLowerCase()} question has been answered ${looked} times and nothing ` +
            'published has settled it. Brain has documented that there is nothing there.',
        });
        continue;
      }
      const since = coverage.lastSettledAt ? Date.parse(coverage.lastSettledAt) : null;
      if (since !== null && Number.isFinite(since) && now - since < ROUND_COOL_OFF_MS) {
        declined.push({
          subject: coverage.path,
          why: `Its ${purpose.toLowerCase()} question settled recently and is still inside its cool-off.`,
        });
        continue;
      }
      candidates.push(
        ask(
          coverage,
          purpose,
          500,
          settled + 1,
          `It has been asked ${settled} time${settled === 1 ? '' : 's'} and has produced ` +
            `${found} finding${found === 1 ? '' : 's'}; what is published may have changed.`,
        ),
      );
    }
  }

  /*
   * Rank first, then age. Equal-ranked asks are genuinely equal, and the first
   * version of §38's allocator broke that tie on a generated id — which is
   * deterministic, meaningless, and leaves the same subjects at the back of the
   * queue for ever. Oldest first is the order the map grew in, so every task
   * gets a turn.
   */
  candidates.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : a.since < b.since ? -1 : a.since > b.since ? 1 : 0,
  );

  const asks = candidates.slice(0, slots);
  for (const skipped of candidates.slice(slots)) {
    declined.push({
      subject: skipped.subject,
      why: `${skipped.why} There is no free slot this pass; it keeps its place.`,
    });
  }
  return { asks, declined };
}

function ask(
  coverage: TaskCoverage,
  purpose: LaborRoundPurpose,
  rank: number,
  round: number,
  why: string,
): Ask {
  return {
    taskId: coverage.task.id,
    purpose,
    round,
    rank,
    subject: coverage.path,
    since: coverage.task.createdAt,
    why,
  };
}

function describeBlockers(coverage: TaskCoverage): string {
  const names = coverage.necessity.blockers
    .filter((one) => one.kind === 'QUALITY_UNPROVEN' || one.kind === 'CAPABILITY_MISSING')
    .map((one) => (one.kind === 'QUALITY_UNPROVEN' ? 'unproven quality' : 'a missing capability'));
  return names.length > 0 ? names.join(' and ') : 'something a precedent could move';
}
