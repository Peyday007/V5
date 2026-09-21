/**
 * Which puzzle question Brain asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason `services/dispatch/router.ts` is pure
 * ---------------------------------------------------------------------------
 *
 * A function over a recorded snapshot, so the decision can be argued with
 * afterwards from an input rather than from a re-run against a database that
 * has moved. Being pure also makes it useless as a safety mechanism, which is
 * deliberate and is the same split the dispatcher draws: the exclusion is the
 * unique index on `puzzle_rounds`, so two ticks both deciding correctly that a
 * format should be asked about produce one round and the loser is an ordinary
 * outcome.
 *
 * It reads `snapshot.at` rather than a clock, so re-running it against the
 * same recorded input gives the same answer — the property §27 had to correct
 * `verify-pool` for taking its own clock inside a pure judgement.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic over rules, never a weighted score
 * ---------------------------------------------------------------------------
 *
 * Six rules in a fixed order. There is no scoring function because a score
 * needs weights, weights are a judgement nobody made, and the resulting number
 * reads like a measurement.
 *
 * The order is CASH NOW ahead of POSITION LATER, and rule 1 is the sharpest
 * form of it: **the most valuable question is the one standing between work
 * already done and money.** A master that has produced validated puzzles and
 * cannot be sold because nobody established what its content stands on is one
 * answer away from a product, and every pound of the effort behind it is
 * already spent. Asking what exists in the world comes far below that.
 */
import { BARREN_ROUNDS, ROUND_COOL_OFF_MS } from '../cash/discovery.ts';
import { unimplementedBlocker } from './registry.ts';
import type { PuzzleSnapshot } from './map.ts';
import type { PuzzleRoundPurpose } from '../../domain/types.ts';

export interface Ask {
  /** Null only for the UNIVERSE question, which names no format. */
  formatId: string | null;
  purpose: PuzzleRoundPurpose;
  round: number;
  /** Which rule admitted it. Lower is stronger, and the numbers are spaced. */
  rank: number;
  /** What this is about, in words a person reads. */
  subject: string;
  /** When Brain came to know about this subject. The tiebreak between equal asks. */
  since: string;
  /** The recorded input, in words, so the decision can be argued with. */
  why: string;
}

/**
 * How many puzzle questions may be open at once.
 *
 * Not an allowance — §24 removed exactly that kind of number from the standing
 * authority and recorded why. It is a *concurrency* bound, which is the one
 * limit here that is real: this kernel competes for the same fleet slots the
 * industry map, the labor map and every deep dive compete for, and a pass that
 * queued a question per format would push work already paid for behind them.
 */
export const MAX_OPEN_PUZZLE_ROUNDS = 3;

export interface Allocation {
  asks: Ask[];
  /** Everything considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
}

export function allocate(input: { snapshot: PuzzleSnapshot; slots: number }): Allocation {
  const { snapshot } = input;
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: Allocation['declined'] = [];
  const candidates: Ask[] = [];
  const now = Date.parse(snapshot.at);

  const byFormat = new Map(snapshot.formats.map((one) => [one.formatId, one]));
  const formatRow = new Map(snapshot.formatRows.map((one) => [one.id, one]));

  /**
   * Whether this exact question may be asked again, and what round it would be.
   *
   * Three conditions, and each is a bound rather than a preference: nothing
   * while one is open, nothing inside the cool-off after one settled, and
   * nothing at all once a subject has been asked this way `BARREN_ROUNDS`
   * times for nothing. The last is §13's rule applied to Brain's own history —
   * Brain has documented that there is nothing there, and asking again spends
   * the allowance to re-learn it.
   */
  const askability = (
    formatId: string | null,
    purpose: PuzzleRoundPurpose,
    subject: string,
  ): { round: number } | { blocked: string } => {
    const mine = snapshot.rounds.filter(
      (one) => one.formatId === formatId && one.purpose === purpose,
    );
    if (mine.some((one) => one.state === 'OPEN')) {
      return { blocked: `a ${purpose} question about ${subject} is already open` };
    }
    const settled = mine.filter((one) => one.state !== 'OPEN');
    const barren = settled.filter((one) => (one.found ?? 0) === 0);
    if (barren.length >= BARREN_ROUNDS) {
      return {
        blocked:
          `${barren.length} ${purpose} question(s) about ${subject} established nothing. Brain ` +
          'has documented that there is nothing there, and asking again would spend the ' +
          'allowance to learn it a third time.',
      };
    }
    const newest = settled
      .map((one) => Date.parse(one.harvestedAt ?? one.openedAt))
      .filter((one) => Number.isFinite(one))
      .sort((a, b) => b - a)[0];
    if (newest !== undefined && now - newest < ROUND_COOL_OFF_MS) {
      const hours = Math.ceil((ROUND_COOL_OFF_MS - (now - newest)) / 3_600_000);
      return { blocked: `the last ${purpose} question about ${subject} settled recently (${hours}h)` };
    }
    return { round: settled.length + 1 };
  };

  const consider = (
    formatId: string | null,
    purpose: PuzzleRoundPurpose,
    rank: number,
    subject: string,
    since: string,
    why: string,
  ) => {
    const verdict = askability(formatId, purpose, subject);
    if ('blocked' in verdict) {
      declined.push({ subject, why: verdict.blocked });
      return;
    }
    candidates.push({ formatId, purpose, round: verdict.round, rank, subject, since, why });
  };

  /* ---------------------------------------------------------------------
   * Rule 1 — work already done that cannot be sold for want of a rights
   * answer. The shortest distance between spent effort and money.
   * ------------------------------------------------------------------- */
  for (const master of snapshot.masters) {
    if (master.publishable || master.validated === 0 || !master.format) continue;
    consider(
      master.format.id,
      'RIGHTS',
      10,
      master.format.name,
      master.master.createdAt,
      `${master.master.name} has produced ${master.validated} validated puzzle(s) and none of ` +
        'them may be sold, because nobody has established what its content stands on. That is ' +
        'one answer between work already done and a product.',
    );
  }

  /* ---------------------------------------------------------------------
   * Rule 2 — a format Brain can actually make, with no idea who buys it.
   * ------------------------------------------------------------------- */
  for (const format of snapshot.formats) {
    const row = formatRow.get(format.formatId);
    if (!row) continue;
    if (format.counts.validated === 0) continue;
    const asked = snapshot.rounds.some(
      (one) => one.formatId === format.formatId && one.purpose === 'DEMAND',
    );
    if (asked) continue;
    consider(
      format.formatId,
      'DEMAND',
      20,
      format.name,
      row.createdAt,
      `Brain can produce and check ${format.name} — ${format.counts.validated} validated ` +
        'puzzle(s) exist — and nothing published has been established about who buys work of ' +
        'this kind or what it sells for.',
    );
  }

  /* ---------------------------------------------------------------------
   * Rule 3 — demand established, and no route to reach it.
   * ------------------------------------------------------------------- */
  for (const format of snapshot.formats) {
    const row = formatRow.get(format.formatId);
    if (!row) continue;
    const demand = snapshot.rounds.some(
      (one) =>
        one.formatId === format.formatId &&
        one.purpose === 'DEMAND' &&
        one.state === 'HARVESTED' &&
        (one.found ?? 0) > 0,
    );
    if (!demand) continue;
    consider(
      format.formatId,
      'CHANNEL',
      30,
      format.name,
      row.createdAt,
      `Buyers for ${format.name} are established and no published route to one is. A buyer ` +
        'nobody can reach is not a buyer.',
    );
  }

  /* ---------------------------------------------------------------------
   * Rule 4 — a format Brain cannot build because of a rights question.
   *
   * This is where the crossword sits: the grid is not what is missing, a
   * rights-established lexicon and clue bank are. Answering it is what would
   * let a generator be built at all, which is why it outranks asking what
   * else exists in the world.
   * ------------------------------------------------------------------- */
  for (const format of snapshot.formats) {
    const row = formatRow.get(format.formatId);
    if (!row) continue;
    if (format.rungs.find((one) => one.rung === 'GENERATABLE')?.state === 'MET') continue;
    /*
     * Read from a declared value rather than matched against the sentence.
     *
     * The first version tested a regular expression against the blocker's
     * prose, which is deciding from prose at the function that spends a
     * research slot — and rewording the sentence would have silently stopped
     * the rule firing. An unclassified format answers `CODE`, so it is never
     * asked a rights question it has no use for.
     */
    if (unimplementedBlocker(format.slug) !== 'RIGHTS') continue;
    const blocker = format.rungs.find((one) => one.rung === 'GENERATABLE')?.why ?? '';
    consider(
      format.formatId,
      'RIGHTS',
      40,
      format.name,
      row.createdAt,
      `Brain cannot produce ${format.name}, and what stops it is a rights question rather than ` +
        `a coding one: ${blocker}`,
    );
  }

  /* ---------------------------------------------------------------------
   * Rule 5 — what else is out there. The universe question names no format.
   * ------------------------------------------------------------------- */
  consider(
    null,
    'UNIVERSE',
    50,
    'the puzzle universe',
    snapshot.formatRows[0]?.createdAt ?? snapshot.at,
    `${snapshot.formatRows.length} format(s) are on the map. The brief asks the universe to ` +
      'keep expanding from evidence — obscure formats, underserved audiences, new mechanics, ' +
      'other languages, accessibility needs and emerging channels.',
  );

  /* ---------------------------------------------------------------------
   * Rule 6 — what a qualified product would cost to make physically.
   *
   * Last, and deliberately. It is the POSITION LATER question, and asking it
   * before anything qualifies would be costing a print run for a book that
   * does not exist.
   * ------------------------------------------------------------------- */
  for (const format of snapshot.formats) {
    const row = formatRow.get(format.formatId);
    if (!row || format.counts.qualifiedEditions === 0) continue;
    consider(
      format.formatId,
      'PRODUCTION',
      60,
      format.name,
      row.createdAt,
      `${format.counts.qualifiedEditions} qualified edition(s) of ${format.name} exist, so ` +
        'what producing one physically costs is now a question about something real rather ' +
        'than about a plan.',
    );
  }

  /*
   * Rank, then oldest subject first, then the id — so every subject gets a
   * turn and the order is stable. §38 records what the alternative cost: an
   * allocator whose tie fell through to a generated id left the same subjects
   * at the back of the queue for ever.
   */
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      Date.parse(a.since) - Date.parse(b.since) ||
      (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0),
  );

  const asks = candidates.slice(0, slots);
  for (const skipped of candidates.slice(slots)) {
    declined.push({
      subject: skipped.subject,
      why:
        `There is no free slot: at most ${MAX_OPEN_PUZZLE_ROUNDS} puzzle question(s) may be ` +
        'open at once, and stronger ones were chosen. Nothing about it was refused.',
    });
  }

  return { asks, declined };
}
