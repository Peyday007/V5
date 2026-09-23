/**
 * Where every possibility ranks, why, and what would move it.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic, and that is what makes the questions answerable
 * ---------------------------------------------------------------------------
 *
 * The brief asks three questions a ranking has to be able to answer: *why is
 * #17 ranked below #4*, *what would have to become true for #31 to enter the
 * top five*, and *why did this move*. A weighted score cannot answer any of
 * them. It can produce a number and a list of contributions, and the honest
 * response to "why is it lower" would be *because the weights say so* — weights
 * nobody set, over inputs of different kinds, producing a figure that reads like
 * a measurement.
 *
 * A lexicographic order answers all three exactly. The first criterion on which
 * two paths differ **is** the reason one is above the other; there is nothing
 * else to it and nothing is being summarised. What would have to become true is
 * the chain of criteria on which a path is behind, in order, up to the first one
 * where it is already ahead. And a movement's reason is the criterion by which a
 * path now differs from whatever it passed.
 *
 * `placements` already made this argument for the portfolio and §3 makes it for
 * the whole of Cash Mode: no invented probability, no weights, and an unknown
 * never helps. Every criterion below resolves to a counted row or to a figure
 * somebody published, and a blank sorts last on every one of them.
 *
 * ---------------------------------------------------------------------------
 * A low rank is not a verdict
 * ---------------------------------------------------------------------------
 *
 * Ranking is a *view* of the possibility space and is never the space itself.
 * Nothing here deletes, hides or retires anything: `rankLedger` returns every
 * path it was given, in order, and the surface decides how many to put in front
 * of somebody. §22's rule — simplification happens in the presentation, never by
 * information destruction.
 */
import { ATTRIBUTE, statusRank } from '../../../domain/monetization.ts';
import type {
  MonetizationAttribute,
  MonetizationPath,
  MonetizationPathFact,
  MonetizationStatus,
} from '../../../domain/types.ts';

/**
 * What a criterion sees. Deliberately small: a path, its answers and its
 * derived status, and nothing about the account, the balance or the fleet.
 *
 * That smallness is a property rather than an economy. A ranking that read the
 * deployable balance would order the possibility space differently for a
 * member than for the owner, and the shared frontier could not carry it — the
 * same reason `rank()` in `portfolio.ts` reads only properties of the piece.
 */
export interface RankableEntry {
  path: MonetizationPath;
  status: MonetizationStatus;
  facts: ReadonlyMap<MonetizationAttribute, MonetizationPathFact>;
}

export interface Criterion {
  id: string;
  label: string;
  /**
   * Lower is better, and every one of these is a number over rows.
   *
   * `null` means *this path has no reading for it*, and a null always sorts
   * last whichever direction the criterion runs — which is the one rule that
   * keeps a blank from being the reason something rises. It is separated from
   * the number rather than encoded as one so the explanation can say *unknown*
   * instead of quoting a sentinel.
   */
  order(entry: RankableEntry): number | null;
  /** The value as a reader sees it, for the explanation. */
  describe(entry: RankableEntry): string;
  /** What would have to change, for a path that is behind on this one. */
  wouldHaveToBecomeTrue(behind: RankableEntry, ahead: RankableEntry): string;
}

function figure(entry: RankableEntry, attribute: MonetizationAttribute): number | null {
  const fact = entry.facts.get(attribute);
  return fact?.amountCents ?? null;
}

function choiceIndex(entry: RankableEntry, attribute: MonetizationAttribute): number | null {
  const fact = entry.facts.get(attribute);
  if (!fact) return null;
  const choices = ATTRIBUTE[attribute].choices ?? [];
  const at = choices.indexOf(fact.value);
  return at < 0 ? null : at;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * The contribution, and zero wherever either half is unknown.
 *
 * `conservativeContribution`'s rule, at a new table, and it was a recorded
 * defect there: treating an unknown cost as zero makes the contribution come
 * out as the whole price, so a path nobody had costed ranked above an
 * identically-priced one somebody had. A blank cannot be the reason something
 * rises.
 */
function contribution(entry: RankableEntry): number | null {
  const revenue = figure(entry, 'expectedRevenue');
  const costs = figure(entry, 'directCosts');
  if (revenue === null || costs === null) return null;
  return revenue - costs;
}

/**
 * The plan's criteria, in the plan's order.
 *
 * Status first, because the criteria below are about *which* possibility to
 * take and an invalidated one is not a candidate for that question at all —
 * `rank()`'s own reasoning about tiers, one table along. Then how much is
 * actually established, then what it is worth and what it costs, then how hard
 * and how contested it is, then how often it happens.
 */
export const CRITERIA: readonly Criterion[] = Object.freeze([
  {
    id: 'STATUS',
    label: 'where it stands',
    order: (entry) => statusRank(entry.status),
    describe: (entry) => entry.status.toLowerCase(),
    wouldHaveToBecomeTrue: (behind, ahead) =>
      `its status would have to reach ${ahead.status.toLowerCase()}, and it is currently ` +
      `${behind.status.toLowerCase()}`,
  },
  {
    id: 'EVIDENCE_DEPTH',
    label: 'how much of it rests on a source',
    order: (entry) =>
      -[...entry.facts.values()].filter((one) => one.kind === 'EVIDENCE').length,
    describe: (entry) => {
      const count = [...entry.facts.values()].filter((one) => one.kind === 'EVIDENCE').length;
      return `${count} answer${count === 1 ? '' : 's'} resolving to a source`;
    },
    wouldHaveToBecomeTrue: (behind, ahead) => {
      const mine = [...behind.facts.values()].filter((one) => one.kind === 'EVIDENCE').length;
      const theirs = [...ahead.facts.values()].filter((one) => one.kind === 'EVIDENCE').length;
      return `${theirs - mine} more of its answers would have to resolve to a published source`;
    },
  },
  {
    id: 'ANSWERED',
    label: 'how many of its questions are answered at all',
    order: (entry) => -entry.facts.size,
    describe: (entry) => `${entry.facts.size} of ${Object.keys(ATTRIBUTE).length} answered`,
    wouldHaveToBecomeTrue: (behind, ahead) =>
      `${ahead.facts.size - behind.facts.size} more of its questions would have to be answered`,
  },
  {
    id: 'TIME_TO_CASH',
    label: 'how soon the money would be usable',
    order: (entry) => entry.facts.get('timeToCash')?.days ?? null,
    describe: (entry) => {
      const days = entry.facts.get('timeToCash')?.days;
      return days === undefined || days === null
        ? 'unknown, and an unknown sorts last'
        : `${days} day${days === 1 ? '' : 's'}`;
    },
    wouldHaveToBecomeTrue: (behind, ahead) => {
      const theirs = ahead.facts.get('timeToCash')?.days;
      const mine = behind.facts.get('timeToCash')?.days;
      if (mine === undefined || mine === null) {
        return 'its time to cash would have to be established at all — nothing has read a payment term for it';
      }
      return `its money would have to be usable within ${theirs ?? 0} days rather than ${mine}`;
    },
  },
  {
    id: 'CONTRIBUTION',
    label: 'what it would leave after its direct costs',
    order: (entry) => {
      const value = contribution(entry);
      return value === null ? null : -value;
    },
    describe: (entry) => {
      const value = contribution(entry);
      return value === null
        ? 'withheld, because a price or a cost is unknown'
        : money(value);
    },
    wouldHaveToBecomeTrue: (behind, ahead) => {
      const theirs = contribution(ahead);
      const mine = contribution(behind);
      if (mine === null) {
        return 'both its revenue and its direct costs would have to be established — a margin ' +
          'against an unknown cost is withheld rather than assumed';
      }
      return `it would have to leave more than ${money(theirs ?? 0)} after costs, and it leaves ${money(mine)}`;
    },
  },
  {
    id: 'CAPITAL_REQUIRED',
    label: 'how much has to go out first',
    order: (entry) => figure(entry, 'requiredCapital'),
    describe: (entry) => {
      const value = figure(entry, 'requiredCapital');
      return value === null ? 'unknown, and an unknown sorts last' : money(value);
    },
    wouldHaveToBecomeTrue: (behind, ahead) => {
      const mine = figure(behind, 'requiredCapital');
      if (mine === null) {
        return 'the cash it needs up front would have to be established at all';
      }
      return `it would have to need less than ${money(figure(ahead, 'requiredCapital') ?? 0)} up front, and it needs ${money(mine)}`;
    },
  },
  {
    id: 'EXECUTION_DIFFICULTY',
    label: 'how hard it is to do',
    order: (entry) => choiceIndex(entry, 'executionDifficulty'),
    describe: (entry) =>
      entry.facts.get('executionDifficulty')?.value.toLowerCase() ?? 'unknown, and an unknown sorts last',
    wouldHaveToBecomeTrue: (behind, ahead) =>
      `it would have to be no harder than ${
        ahead.facts.get('executionDifficulty')?.value.toLowerCase() ?? 'the one above it'
      }`,
  },
  {
    id: 'COMPETITION',
    label: 'how contested it is',
    order: (entry) => choiceIndex(entry, 'competition'),
    describe: (entry) =>
      entry.facts.get('competition')?.value.toLowerCase().replace('_', ' ') ??
      'unknown, and an unknown sorts last',
    wouldHaveToBecomeTrue: (behind, ahead) =>
      `it would have to be less contested than ${
        ahead.facts.get('competition')?.value.toLowerCase().replace('_', ' ') ?? 'the one above it'
      }`,
  },
  {
    id: 'REPEATABILITY',
    label: 'whether it happens again',
    /*
     * The one criterion whose choices run *best last*. `ONE_OFF`, `REPEATABLE`,
     * `RECURRING` is the order a reader expects to see them in — weakest first,
     * as every choice list in this vocabulary is declared — so the ordering
     * flips the index rather than the list, and the list stays readable.
     */
    order: (entry) => {
      const at = choiceIndex(entry, 'repeatability');
      return at === null ? null : -at;
    },
    describe: (entry) =>
      entry.facts.get('repeatability')?.value.toLowerCase().replace('_', ' ') ??
      'unknown, and an unknown sorts last',
    wouldHaveToBecomeTrue: (behind, ahead) =>
      `it would have to recur at least as often as ${
        ahead.facts.get('repeatability')?.value.toLowerCase().replace('_', ' ') ?? 'the one above it'
      }`,
  },
  {
    id: 'SCALABILITY',
    label: 'whether the second one is cheaper',
    order: (entry) => {
      const at = choiceIndex(entry, 'scalability');
      return at === null ? null : -at;
    },
    describe: (entry) =>
      entry.facts.get('scalability')?.value.toLowerCase() ?? 'unknown, and an unknown sorts last',
    wouldHaveToBecomeTrue: (behind, ahead) =>
      `it would have to scale at least as well as ${
        ahead.facts.get('scalability')?.value.toLowerCase() ?? 'the one above it'
      }`,
  },
  {
    id: 'DISCOVERED',
    label: 'how long it has been in the ledger',
    /*
     * The deterministic tail, so two reads of an unchanged ledger produce the
     * same order. A ranking that shuffled equivalents would make "why did this
     * move" unanswerable, and this ledger records every movement — so it would
     * also fill the history with movements nothing caused.
     */
    order: (entry) => Date.parse(entry.path.createdAt) || 0,
    describe: (entry) => `in the ledger since ${entry.path.createdAt}`,
    wouldHaveToBecomeTrue: () =>
      'nothing: they are equal on everything that can be established, and the older one goes first',
  },
]);

/** Sorted best first, and every path that was handed in comes back. */
export function rankLedger(entries: readonly RankableEntry[]): RankableEntry[] {
  return [...entries].sort(compareEntries);
}

export function compareEntries(a: RankableEntry, b: RankableEntry): number {
  for (const criterion of CRITERIA) {
    const decided = compareOn(criterion, a, b);
    if (decided !== 0) return decided;
  }
  return a.path.id < b.path.id ? -1 : a.path.id > b.path.id ? 1 : 0;
}

/** Lower first, and a null last whichever way the criterion runs. */
/**
 * Where two entries stand on one criterion, with a null always last.
 *
 * Exported because `commission.ts` reads the sort function backwards to decide
 * which questions could still change an order: the criteria at or above the
 * first one two neighbours differ on are the only ones anything consults. A
 * second copy of this comparison there would be the two-readers-of-one-fact
 * defect this repository records more than any other.
 */
export function compareOn(criterion: Criterion, a: RankableEntry, b: RankableEntry): number {
  const left = criterion.order(a);
  const right = criterion.order(b);
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

export interface RankExplanation {
  /** The criterion that decided it, or null where nothing did. */
  criterion: string | null;
  label: string | null;
  higher: { pathId: string; reading: string } | null;
  lower: { pathId: string; reading: string } | null;
  sentence: string;
}

/**
 * Why one path is above another — exactly, rather than approximately.
 *
 * The first criterion on which they differ is the whole answer. Nothing is
 * weighted, nothing is summed and nothing below the deciding criterion was
 * consulted, which is why this can name one thing and be complete.
 */
export function explainRanking(a: RankableEntry, b: RankableEntry): RankExplanation {
  for (const criterion of CRITERIA) {
    const decided = compareOn(criterion, a, b);
    if (decided === 0) continue;
    const higher = decided < 0 ? a : b;
    const lower = decided < 0 ? b : a;
    return {
      criterion: criterion.id,
      label: criterion.label,
      higher: { pathId: higher.path.id, reading: criterion.describe(higher) },
      lower: { pathId: lower.path.id, reading: criterion.describe(lower) },
      sentence:
        `"${higher.path.title}" is above "${lower.path.title}" on ${criterion.label}: ` +
        `${criterion.describe(higher)} against ${criterion.describe(lower)}. Nothing below that ` +
        'was consulted, because the order is decided by the first thing they differ on.',
    };
  }
  return {
    criterion: null,
    label: null,
    higher: null,
    lower: null,
    sentence:
      'Nothing separates these two: every criterion reads the same for both, so the order ' +
      'between them is their identifiers and means nothing.',
  };
}

export interface EntryCondition {
  criterion: string;
  label: string;
  /** What this path reads now. */
  now: string;
  /** What the path it is trying to pass reads. */
  needed: string;
  sentence: string;
}

/**
 * What would have to become true for one path to pass another.
 *
 * The chain, in order, and it stops where it should. Because the order is
 * lexicographic, a path behind on the first criterion is behind whatever else
 * is true of it — so the conditions are read from the top down and the walk
 * ends at the first criterion where this path is already *ahead*: once
 * everything above it is equal, that one settles the comparison in its favour
 * and nothing below it is consulted.
 *
 * An empty list is a real answer rather than a failure: it means this path
 * already outranks the one it was compared with, and something else is keeping
 * it where it is.
 */
export function entryConditions(behind: RankableEntry, ahead: RankableEntry): EntryCondition[] {
  const out: EntryCondition[] = [];
  for (const criterion of CRITERIA) {
    const decided = compareOn(criterion, behind, ahead);
    if (decided < 0) break;
    if (decided === 0) continue;
    out.push({
      criterion: criterion.id,
      label: criterion.label,
      now: criterion.describe(behind),
      needed: criterion.describe(ahead),
      sentence: criterion.wouldHaveToBecomeTrue(behind, ahead),
    });
  }
  return out;
}
