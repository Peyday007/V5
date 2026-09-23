/**
 * The operator surface: the five worth looking at, and every one that is not.
 *
 * ---------------------------------------------------------------------------
 * The five are a view of the space and are never the space
 * ---------------------------------------------------------------------------
 *
 * The brief's central instruction is that reducing forty possibilities to five
 * and forgetting the rest is the failure. So this composes a *view*: the five
 * are indices into an entry list that carries every path in the project, in
 * rank order, with nothing removed. There is no branch here that drops a row,
 * no threshold below which something stops being sent, and no group that is
 * offered instead of the whole.
 *
 * Every group below is a list of ids rather than a copy of the entries. Two
 * copies of one possibility is how a page comes to render two different
 * readings of it, and the groups overlap by construction — a path can be in the
 * top five, in the newly discovered list and in the recently promoted list at
 * once, and duplicating it three times would make the counts lie.
 *
 * ---------------------------------------------------------------------------
 * Nine answers per top item, and one of them is deliberately not a number
 * ---------------------------------------------------------------------------
 *
 * *Confidence* is asked for, and what is given is a count: how many of this
 * path's answers resolve to a published source, how many are Brain's own
 * proposals, and how many nobody has answered. That is a reading of rows. A
 * percentage would be a figure nobody measured, rendered beside figures that
 * were — the same refusal `probabilityOfSuccess` makes in the vocabulary, at
 * the place a reader is most likely to want one.
 *
 * It writes nothing.
 */
import { explainRanking, entryConditions, type EntryCondition } from './rank.ts';
import { rankableOf, type Ledger, type LedgerAnswer, type LedgerEntry } from './ledger.ts';
import { standingJudgment } from './status.ts';
import type {
  MonetizationAttribute,
  MonetizationMethod,
  MonetizationStatus,
} from '../../../domain/types.ts';

export const TOP_SHOWN = 5;
export const NEXT_BEST_SHOWN = 5;

export interface TopEntry {
  pathId: string;
  rank: number;
  /** 1. What it is. */
  what: string;
  /** 2. Why it ranks highly — against the best possibility not being shown. */
  whyItRanksHighly: string;
  /** 3. Expected economics, with the margin withheld rather than assumed. */
  economics: { revenue: string | null; costs: string | null; margin: string | null; withheld: string | null };
  /** 4. Time to cash, or that nothing has read a payment term for it. */
  timeToCash: string;
  /** 5. The cheapest thing that would move it, from the questions still open. */
  requiredAction: string;
  /**
   * 6. Confidence, as three counts rather than as a number.
   *
   * See this file's header. A percentage here would be the one invented figure
   * this ledger has spent its whole design refusing.
   */
  confidence: { fromASource: number; brainsOwnProposal: number; unanswered: number };
  /** 7. What is actually in its way, named. */
  risks: string[];
  /** 8. What changed recently, from the movement history. */
  whatChanged: string;
  /** 9. Why it outranks the one directly below it. */
  whyItOutranksTheNext: string;
}

export interface Group {
  id: string;
  label: string;
  /** What this group is, so a reader knows what they are looking at. */
  what: string;
  pathIds: string[];
}

export interface MonetizationSurface {
  /** Every possibility, best first. The space itself. */
  entries: LedgerEntry[];
  /** The five, answered the nine ways the brief asks for. */
  top: TopEntry[];
  /** Everything else, grouped. Each group is ids into `entries`. */
  groups: Group[];
  byStatus: Record<MonetizationStatus, number>;
  /** The chains worth looking at. */
  sequences: Ledger['sequences'];
  /**
   * How many possibilities exist at all, said plainly beside the five.
   *
   * The one number that stops the top five reading as the whole of it.
   */
  total: number;
  readAt: string;
}

/** Recently means the last seven days, and it is stated rather than implied. */
export const RECENT_DAYS = 7;

export function composeSurface(input: { ledger: Ledger; now?: string }): MonetizationSurface {
  const ledger = input.ledger;
  const now = input.now ?? ledger.readAt;
  const recentSince = new Date(Date.parse(now) - RECENT_DAYS * 86_400_000).toISOString();

  const live = ledger.entries.filter(
    (one) => one.status !== 'INVALIDATED' && one.status !== 'ARCHIVED',
  );
  const top = live.slice(0, TOP_SHOWN);
  /*
   * The best possibility that is *not* being shown.
   *
   * What "why does this rank highly" is actually asking: not why it beats the
   * one below it in the same list, but why these five rather than the rest. A
   * top five with nothing under it has no such comparison, and the honest
   * answer there is that there is nothing it is being preferred over.
   */
  const bestNotShown = live[TOP_SHOWN] ?? null;

  return {
    entries: ledger.entries,
    top: top.map((entry, at) => describeTop(entry, live[at + 1] ?? null, bestNotShown)),
    groups: groupsFor(ledger, { live, recentSince }),
    byStatus: ledger.byStatus,
    sequences: ledger.sequences,
    total: ledger.entries.length,
    readAt: ledger.readAt,
  };
}

function describeTop(
  entry: LedgerEntry,
  next: LedgerEntry | null,
  bestNotShown: LedgerEntry | null,
): TopEntry {
  const answer = (key: MonetizationAttribute): LedgerAnswer | null =>
    entry.answers.find((one) => one.attribute === key) ?? null;

  const revenue = answer('expectedRevenue');
  const costs = answer('directCosts');
  const days = answer('timeToCash');

  const open = entry.answers.filter((one) => one.value === null && one.loadBearing);
  const fromASource = entry.answers.filter((one) => one.kind === 'FACT').length;
  const proposals = entry.answers.filter((one) => one.kind === 'ESTIMATE').length;

  return {
    pathId: entry.path.id,
    rank: entry.rank,
    what:
      `${entry.method.label}: ${entry.method.what}` +
      (entry.subject ? ` — on "${entry.subject.title}".` : '.') +
      (entry.path.thesis ? ` ${entry.path.thesis}` : ''),
    whyItRanksHighly: bestNotShown
      ? explainRanking(rankableOf(entry), rankableOf(bestNotShown)).sentence
      : 'Nothing is ranked below it, so it is not being preferred over anything.',
    economics: {
      revenue: revenue?.value ?? null,
      costs: costs?.value ?? null,
      margin: entry.margin.value === null ? null : (entry.margin.value / 100).toFixed(2),
      withheld: entry.margin.withheld,
    },
    timeToCash:
      days?.days !== null && days?.days !== undefined
        ? `${days.days} day${days.days === 1 ? '' : 's'} from the published terms`
        : 'Unknown — nothing has read a payment term, payout schedule or decision date for this.',
    requiredAction:
      open.length > 0
        ? open[0]!.task
        : 'Everything load-bearing is answered. What is left is a decision only a person can make.',
    confidence: {
      fromASource,
      brainsOwnProposal: proposals,
      unanswered: entry.unknowns.length,
    },
    risks: risksFor(entry),
    whatChanged: changeFor(entry),
    whyItOutranksTheNext: next
      ? explainRanking(rankableOf(entry), rankableOf(next)).sentence
      : 'There is nothing below it in this list.',
  };
}

function risksFor(entry: LedgerEntry): string[] {
  const out: string[] = [];
  if (entry.status === 'BLOCKED' || entry.status === 'WEAK') out.push(entry.statusBecause);
  for (const key of ['legalRequirements', 'externalDependencies', 'competition'] as const) {
    const answer = entry.answers.find((one) => one.attribute === key);
    if (answer?.value) out.push(`${answer.label}: ${answer.value}`);
  }
  for (const edge of entry.edges) {
    if (edge.kind !== 'REQUIRES' || edge.toPathId !== entry.path.id) continue;
    /*
     * A derived requirement and a recorded one read identically and are not the
     * same fact, so each says which it is.
     *
     * `ledger.ts` treats only a recorded one as a blocker, correctly: a derived
     * REQUIRES exists wherever exactly one peer produces something this method
     * needs, and none of them is proven on day one — treating those as blockers
     * made every possibility in a fresh ledger read BLOCKED. This list is risks
     * rather than blockers, so both belong on it; what was wrong is that the
     * two readers of one edge presented them alike, and a structural
     * consequence rendered as a finding is what §21's own `source` column
     * exists to prevent.
     */
    out.push(
      edge.source === 'DERIVED'
        ? `${edge.rationale} (a consequence of what this shape of transaction needs, ` +
          'not something anybody established about this situation)'
        : edge.rationale,
    );
  }
  if (entry.margin.withheld) out.push(entry.margin.withheld);
  return out;
}

function changeFor(entry: LedgerEntry): string {
  if (!entry.movedAt || entry.previousRank === null) {
    return entry.movementReason === 'ENTERED_THE_LEDGER'
      ? 'It entered the ledger and has not moved since.'
      : 'Nothing has moved it since it was first read.';
  }
  const direction = entry.rank < entry.previousRank ? 'up' : 'down';
  return (
    `It moved ${direction} from ${entry.previousRank} to ${entry.rank} on ${entry.movedAt}, ` +
    `because ${readableReason(entry.movementReason)}.`
  );
}

function readableReason(reason: string | null): string {
  switch (reason) {
    case 'ENTERED_THE_LEDGER':
      return 'it entered the ledger';
    case 'ITS_OWN_EVIDENCE_CHANGED':
      return 'something about it was established or changed';
    case 'ITS_STATUS_CHANGED':
      return 'where it stands changed';
    case 'THE_FIELD_AROUND_IT_CHANGED':
      return 'nothing about it changed and something else did';
    case 'A_PERSON_DECIDED':
      return 'somebody recorded a judgement about it';
    default:
      return 'no reason was recorded';
  }
}

function groupsFor(
  ledger: Ledger,
  context: { live: LedgerEntry[]; recentSince: string },
): Group[] {
  const withStatus = (...statuses: MonetizationStatus[]): string[] =>
    ledger.entries.filter((one) => statuses.includes(one.status)).map((one) => one.path.id);

  return [
    {
      id: 'TOP_5_NOW',
      label: 'Top 5 now',
      what: 'The five best-ranked possibilities that are neither invalidated nor put away.',
      pathIds: context.live.slice(0, TOP_SHOWN).map((one) => one.path.id),
    },
    {
      id: 'NEXT_BEST',
      label: 'Next best',
      what: 'The five immediately below them. Nothing separates these from the five above except rank.',
      pathIds: context.live
        .slice(TOP_SHOWN, TOP_SHOWN + NEXT_BEST_SHOWN)
        .map((one) => one.path.id),
    },
    {
      id: 'ALL_ACTIVE',
      label: 'All active',
      what: 'Every possibility whose load-bearing questions are answered and whose way is clear.',
      pathIds: withStatus('ACTIVE'),
    },
    {
      id: 'WATCHLIST',
      label: 'Watchlist',
      what: 'Possibilities somebody asked to be kept informed about rather than to act on.',
      pathIds: withStatus('WATCH'),
    },
    {
      id: 'BLOCKED',
      label: 'Blocked',
      what: 'Something named has to happen first. Each one says what.',
      pathIds: withStatus('BLOCKED'),
    },
    {
      id: 'WEAK',
      label: 'Weak',
      what:
        'Answered, and what it answers is not good. Kept in full, because what makes something ' +
        'weak is a fact that can change.',
      pathIds: withStatus('WEAK'),
    },
    {
      id: 'UNPROVEN',
      label: 'Unproven',
      what: 'Nothing has established enough about these yet. Most of a fresh ledger is here.',
      pathIds: withStatus('UNPROVEN'),
    },
    {
      id: 'INVALIDATED_OR_ARCHIVED',
      label: 'Invalidated or archived',
      what:
        'Put away or established as not working, with the reason on each. Never deleted: what ' +
        'made one of these wrong is a fact, and a fact can stop being true.',
      pathIds: withStatus('INVALIDATED', 'ARCHIVED'),
    },
    {
      id: 'NEWLY_DISCOVERED',
      label: 'Newly discovered',
      what: `Possibilities that entered the ledger in the last ${RECENT_DAYS} days.`,
      pathIds: ledger.entries
        .filter((one) => one.path.createdAt >= context.recentSince)
        .map((one) => one.path.id),
    },
    {
      id: 'RECENTLY_PROMOTED',
      label: 'Recently promoted',
      what: `Possibilities that moved up in the last ${RECENT_DAYS} days, with what moved them.`,
      pathIds: ledger.entries
        .filter(
          (one) =>
            one.movedAt !== null &&
            one.movedAt >= context.recentSince &&
            one.previousRank !== null &&
            one.rank < one.previousRank,
        )
        .map((one) => one.path.id),
    },
    {
      id: 'RECENTLY_DEMOTED',
      label: 'Recently demoted',
      what: `Possibilities that moved down in the last ${RECENT_DAYS} days. A demotion is not a verdict.`,
      pathIds: ledger.entries
        .filter(
          (one) =>
            one.movedAt !== null &&
            one.movedAt >= context.recentSince &&
            one.previousRank !== null &&
            one.rank > one.previousRank,
        )
        .map((one) => one.path.id),
    },
    {
      id: 'WORTH_RECONSIDERING',
      label: 'Worth reconsidering',
      what:
        'Put away or invalidated, and then something about them was established. Derived rather ' +
        'than remembered: the judgement is older than the evidence that arrived after it.',
      pathIds: reconsiderable(ledger).map((one) => one.path.id),
    },
  ];
}

/**
 * The ones somebody said no to, and then something changed.
 *
 * The brief asks for this by name — *paths that were previously rejected but
 * should now be reconsidered* — and it is derived rather than remembered: a
 * standing judgement that put a path away, and at least one answer recorded
 * after it. Nothing here re-opens anything or argues that the judgement was
 * wrong; it says that the evidence is no longer the evidence the judgement was
 * made on, which is a fact about two timestamps.
 */
export function reconsiderable(ledger: Ledger): LedgerEntry[] {
  return ledger.entries.filter((entry) => {
    if (entry.status !== 'INVALIDATED' && entry.status !== 'ARCHIVED') return false;
    const standing = standingJudgment(entry.judgments);
    if (!standing) return false;
    return entry.answers.some(
      (answer) => answer.value !== null && answer.updatedAt !== null && answer.updatedAt > standing.createdAt,
    );
  });
}

/* --------------------------------------------------------------------------
 * The operator's own questions
 * ------------------------------------------------------------------------ */

export interface LedgerQuery {
  /** Only possibilities needing no more than this up front. */
  maxCapitalCents?: number;
  /** Only possibilities whose money would be usable within this many days. */
  maxDaysToCash?: number;
  /** Only possibilities that entered the ledger since this instant. */
  discoveredSince?: string;
  /** Only possibilities whose position moved since this instant. */
  movedSince?: string;
  statuses?: MonetizationStatus[];
  methods?: MonetizationMethod[];
  /** Only possibilities about one discovery. */
  subjectId?: string;
}

/**
 * The brief's own questions, answered from the retained ledger.
 *
 * "Show me everything under five thousand dollars", "everything that could pay
 * inside a week", "everything discovered this week", "everything that moved
 * today". Every one of them reads the rows that are already there rather than
 * reconstructing a possibility space — which is what the brief means by
 * answering from retained state, and what the ledger exists for.
 *
 * **An unknown never passes a bound.** A path with no established capital
 * requirement is not returned by "under five thousand dollars", because it is
 * not known to be under five thousand dollars — the favourable assumption here
 * would put an uncosted possibility in front of somebody who asked for cheap
 * ones. Pure, so the same ledger and the same query always give the same
 * answer.
 */
export function filterLedger(entries: readonly LedgerEntry[], query: LedgerQuery): LedgerEntry[] {
  return entries.filter((entry) => {
    if (query.statuses && !query.statuses.includes(entry.status)) return false;
    if (query.methods && !query.methods.includes(entry.path.method)) return false;
    if (query.subjectId && entry.subject?.id !== query.subjectId) return false;
    if (query.discoveredSince && entry.path.createdAt < query.discoveredSince) return false;
    if (query.movedSince && (entry.movedAt === null || entry.movedAt < query.movedSince)) {
      return false;
    }
    if (query.maxCapitalCents !== undefined) {
      const capital = entry.answers.find((one) => one.attribute === 'requiredCapital')?.amountCents;
      if (capital === null || capital === undefined || capital > query.maxCapitalCents) return false;
    }
    if (query.maxDaysToCash !== undefined) {
      const days = entry.answers.find((one) => one.attribute === 'timeToCash')?.days;
      if (days === null || days === undefined || days > query.maxDaysToCash) return false;
    }
    return true;
  });
}

/**
 * What would have to become true for one possibility to enter the top five.
 *
 * Against the fifth, because that is the position being competed for. An empty
 * list means it already outranks the fifth — which happens when it is not in
 * the five because it is invalidated or put away, and the answer there is the
 * judgement rather than a criterion.
 */
export function conditionsToEnterTop(
  ledger: Ledger,
  pathId: string,
): { conditions: EntryCondition[]; against: string | null; note: string | null } {
  const live = ledger.entries.filter(
    (one) => one.status !== 'INVALIDATED' && one.status !== 'ARCHIVED',
  );
  const entry = ledger.entries.find((one) => one.path.id === pathId) ?? null;
  if (!entry) return { conditions: [], against: null, note: null };
  if (live.slice(0, TOP_SHOWN).some((one) => one.path.id === pathId)) {
    return { conditions: [], against: null, note: 'It is already in the top five.' };
  }
  const fifth = live[TOP_SHOWN - 1] ?? null;
  if (!fifth) {
    return {
      conditions: [],
      against: null,
      note: 'There are fewer than five live possibilities, so nothing is keeping it out.',
    };
  }
  if (entry.status === 'INVALIDATED' || entry.status === 'ARCHIVED') {
    return {
      conditions: [],
      against: fifth.path.id,
      note:
        'It is out of the five because somebody put it away, not because of anything it ranks ' +
        'on. Reviving it is the answer, and its ranking is computed either way.',
    };
  }
  return {
    conditions: entryConditions(rankableOf(entry), rankableOf(fifth)),
    against: fifth.path.id,
    note: null,
  };
}
