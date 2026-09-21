/**
 * Which category is the strongest next expansion, and exactly why.
 *
 * ---------------------------------------------------------------------------
 * Avoiding a ladder is not the same as avoiding judgement
 * ---------------------------------------------------------------------------
 *
 * The directive refuses a fixed sequence — *DO NOT blindly follow 1 → 2 → 3 →
 * 4 → 5 → 6* — and in the same breath demands one: *continuously calculate the
 * strongest next expansion*. The first sentence is a refusal of a **stored**
 * order; the second is a requirement for a **derived** one. Reading only the
 * first produces a flat collection of identical `EVALUABLE` verdicts, which is
 * not neutrality — it is handing a person eleven categories and no way to tell
 * them apart, while the machinery quietly has an opinion anyway in whatever
 * order its list happened to come back.
 *
 * So this ranks, and everything about how it ranks is arranged so the ranking
 * can be argued with rather than believed.
 *
 * ---------------------------------------------------------------------------
 * A composite that decomposes, and no magic number
 * ---------------------------------------------------------------------------
 *
 * `verdict.ts` refuses a weighted score for industry subjects and
 * `portfolio.ts` for opportunities, both on the same ground: a score needs
 * weights, weights are a judgement nobody made, and the number then reads like
 * a measurement. That ground is still solid, and this does not cross it.
 *
 * What is produced instead is a **lexicographic order over named factors**,
 * each of which is a fact about rows, each carried on the result with its own
 * value and its own sentence. There is no total, no percentage and no
 * coefficient anywhere. Two categories that differ are separated by exactly
 * one factor, and the reading says which one — so "why is this above that" has
 * a one-line answer that resolves to rows rather than to arithmetic nobody can
 * inspect.
 *
 * `FACTORS` is the declared order, and it is the whole of the judgement. It is
 * a constant in code for §16's reason: nobody supplies the limits their own
 * work is judged against, and a caller that could reorder these could reorder
 * a category to the top.
 *
 * ---------------------------------------------------------------------------
 * An unknown never ranks higher
 * ---------------------------------------------------------------------------
 *
 * Invariant 39, and it is the rule this module is most at risk of breaking.
 * Every factor below is written so that *nobody has established this* scores
 * no better than *we established it and it is bad*: unpriced capital does not
 * beat expensive capital, an unresearched category does not beat one with no
 * demand, and a category with no established requirements does not count as
 * having no missing ones. §30 records the production defect where exactly this
 * went wrong in the other direction — `conservativeContribution` read an
 * unknown exposure as zero, so a piece nobody had costed ranked above one
 * somebody had.
 */
import { VERDICT_ORDER } from './verdictOrder.ts';
import { label } from './capital.ts';
import type { CategoryReading } from './readiness.ts';

/**
 * The factors, strongest first. This order *is* the judgement.
 *
 * Each is a fact derived from rows, and the ordering between them is the
 * directive's own: demand and a route before what it takes to build, what it
 * takes to build before what it costs, and what it unlocks last — because a
 * category that unlocks a great deal and has no buyer is the inversion the
 * directive exists to forbid, not a reason to move it up.
 */
export const FACTORS = [
  /** How far the category is from being enterable at all. */
  'READINESS',
  /** Whether published, dated evidence says somebody is buying. */
  'DEMAND_ESTABLISHED',
  /** Whether a published route reaches them. */
  'ROUTE_ESTABLISHED',
  /** How many established requirements this company does not hold. */
  'CAPABILITY_GAP',
  /** How many of those gaps nothing on the ladder is established to develop. */
  'UNBRIDGED_GAP',
  /** Whether what entering costs is established at all. */
  'ENTRY_COST_KNOWN',
  /** What entering it would create that something else on the ladder needs. */
  'CAPABILITY_UNLOCKED',
  /** How much published evidence stands behind any of it. */
  'EVIDENCE_DEPTH',
] as const;
export type PriorityFactor = (typeof FACTORS)[number];

export interface FactorReading {
  factor: PriorityFactor;
  /**
   * The comparable value. **Lower is stronger**, always, so a reader never has
   * to remember which way a particular factor runs.
   */
  value: number;
  /** What that value is, in words, from the rows it was read from. */
  because: string;
}

export interface PriorityEntry {
  categoryId: string;
  path: string[];
  /** 1-based, and only meaningful beside `separatedBy`. */
  position: number;
  factors: FactorReading[];
  /**
   * Which single factor put this below the entry above it, and null for the
   * first.
   *
   * This is what makes the order inspectable rather than merely ordered. A
   * list with no answer to "why is this one second" is a ranking a person can
   * only accept or ignore.
   */
  separatedBy: { factor: PriorityFactor; because: string } | null;
  /** The whole comparison as one sentence. Never a score. */
  because: string;
}

/**
 * Rank the live categories.
 *
 * Pure over readings that are themselves pure over a snapshot, so the order is
 * reproducible from a recorded input — `services/dispatch/router.ts`' property,
 * and the reason "why did Brain rank it there" has an answer after the
 * database has moved on.
 */
export function rankCategories(readings: readonly CategoryReading[]): PriorityEntry[] {
  const live = readings.filter((one) => one.verdict !== 'RETIRED');
  const scored = live.map((reading) => ({ reading, factors: factorsFor(reading) }));

  scored.sort((a, b) => {
    for (let index = 0; index < FACTORS.length; index += 1) {
      const left = a.factors[index];
      const right = b.factors[index];
      if (!left || !right) continue;
      if (left.value !== right.value) return left.value - right.value;
    }
    /*
     * Everything Brain can measure says these are the same.
     *
     * The tiebreak is the name, which is meaningless and *deterministic* — and
     * saying so is the point. §38 records the industry allocator falling
     * through to a generated node id, which was equally deterministic and left
     * the same subjects at the back of the queue for ever with nothing
     * admitting it. Here the ties are visible: two entries with no
     * `separatedBy` between them are two Brain cannot tell apart, which is a
     * finding a person can act on.
     */
    return a.reading.path.join(' → ').localeCompare(b.reading.path.join(' → '));
  });

  return scored.map((entry, index) => {
    const previous = scored[index - 1];
    const separatedBy = previous ? firstDifference(previous.factors, entry.factors) : null;
    return {
      categoryId: entry.reading.categoryId,
      path: entry.reading.path,
      position: index + 1,
      factors: entry.factors,
      separatedBy,
      because: explain(entry.reading, entry.factors, separatedBy, index === 0),
    };
  });
}

function firstDifference(
  above: readonly FactorReading[],
  here: readonly FactorReading[],
): PriorityEntry['separatedBy'] {
  for (let index = 0; index < FACTORS.length; index += 1) {
    const left = above[index];
    const right = here[index];
    if (!left || !right || left.value === right.value) continue;
    return { factor: right.factor, because: right.because };
  }
  return null;
}

/**
 * Every factor for one category, in the declared order.
 *
 * Built as the full list rather than as whichever ones apply, so the shape is
 * the same for every entry and a reader comparing two of them is comparing
 * like with like. A factor that cannot be answered says so in `because` and
 * takes the value an unknown takes — never the value a good answer takes.
 */
function factorsFor(reading: CategoryReading): FactorReading[] {
  const answer = (condition: string) =>
    reading.conditions.find((one) => one.condition === condition)?.answer ?? 'UNKNOWN';

  const unbridged = reading.missing.filter((gap) => gap.taughtBy.length === 0);

  return [
    {
      factor: 'READINESS',
      value: VERDICT_ORDER[reading.verdict],
      because: reading.because,
    },
    {
      /*
       * MET beats NOT_MET beats UNKNOWN, and the last two are not the same.
       *
       * *We asked and nobody is buying* is a settled fact that should rank
       * below *nobody has asked*, because the second can still turn out well
       * and the first cannot. That is not an unknown ranking higher than a
       * known-good — it ranks below MET, which is the rule.
       */
      factor: 'DEMAND_ESTABLISHED',
      value: answer('DEMAND_ESTABLISHED') === 'MET' ? 0 : answer('DEMAND_ESTABLISHED') === 'UNKNOWN' ? 1 : 2,
      because:
        reading.conditions.find((one) => one.condition === 'DEMAND_ESTABLISHED')?.because ??
        'Nothing has asked whether anybody is buying.',
    },
    {
      factor: 'ROUTE_ESTABLISHED',
      value: answer('ROUTE_TO_BUYER_ESTABLISHED') === 'MET' ? 0 : answer('ROUTE_TO_BUYER_ESTABLISHED') === 'UNKNOWN' ? 1 : 2,
      because:
        reading.conditions.find((one) => one.condition === 'ROUTE_TO_BUYER_ESTABLISHED')
          ?.because ?? 'Nothing has asked how product reaches a buyer.',
    },
    {
      /*
       * A category nobody has asked what it takes to build is **not** a
       * category with no gaps.
       *
       * `requires.every(held)` is true of the empty set, which is the defect
       * `heldCondition` already had to refuse once at the verdict. Here the
       * same mistake would put an entirely unexamined category at the top of
       * the frontier with a perfect score — the most expensive place on this
       * surface for an unknown to read as good news. So unknown sorts behind
       * every category whose requirements are actually established, however
       * many of them are missing.
       */
      factor: 'CAPABILITY_GAP',
      value:
        answer('REQUIREMENTS_KNOWN') === 'MET'
          ? reading.missing.length
          : Number.MAX_SAFE_INTEGER,
      because:
        answer('REQUIREMENTS_KNOWN') === 'MET'
          ? `${reading.missing.length} of ${reading.missing.length + reading.held.length} ` +
            'established requirements are not held.'
          : 'What producing here requires has not been established, so the size of the gap is ' +
            'not known — which ranks behind every category where it is.',
    },
    {
      factor: 'UNBRIDGED_GAP',
      value:
        answer('REQUIREMENTS_KNOWN') === 'MET' ? unbridged.length : Number.MAX_SAFE_INTEGER,
      because:
        answer('REQUIREMENTS_KNOWN') === 'MET'
          ? unbridged.length === 0
            ? 'Everything missing is developed by something already on the ladder.'
            : `Nothing on the ladder is established to develop ${unbridged
                .map((gap) => gap.capability.name)
                .join(', ')}.`
          : 'Not known, because the requirements are not established.',
    },
    {
      /*
       * Established beats partial beats unexamined, and partial is **not**
       * treated as established.
       *
       * A category with three priced requirements and one blank knows less
       * about what entering costs than one with four priced, and a ranking
       * that counted it as known would let a missing figure improve a
       * position. `capital.ts` makes the same refusal one layer down by
       * withholding the total.
       */
      factor: 'ENTRY_COST_KNOWN',
      value:
        reading.capital.state === 'ESTABLISHED' ? 0 : reading.capital.state === 'PARTIAL' ? 1 : 2,
      because: reading.capital.because,
    },
    {
      // Negated, because more unlocked is stronger and lower is stronger.
      factor: 'CAPABILITY_UNLOCKED',
      value: -reading.wouldTeach.length,
      because:
        reading.wouldTeach.length === 0
          ? 'Nothing else on the ladder is established to need what producing here would develop.'
          : `Producing here would develop ${reading.wouldTeach
              .map((one) => one.name)
              .join(', ')}, which something else on the ladder requires.`,
    },
    {
      factor: 'EVIDENCE_DEPTH',
      value: -(reading.held.length + reading.missing.length + reading.barriers.length),
      because:
        `${reading.held.length + reading.missing.length} established requirement` +
        (reading.held.length + reading.missing.length === 1 ? '' : 's') +
        ` and ${reading.barriers.length} established barrier` +
        (reading.barriers.length === 1 ? '' : 's') +
        ' stand behind this reading.',
    },
  ];
}

function explain(
  reading: CategoryReading,
  factors: readonly FactorReading[],
  separatedBy: PriorityEntry['separatedBy'],
  first: boolean,
): string {
  const where = reading.path.join(' → ');
  if (first) {
    return (
      `${where} is the strongest next expansion Brain can currently derive. ${reading.because}`
    );
  }
  if (!separatedBy) {
    return (
      `${where} is level with the category above it on every factor Brain measures, so the ` +
      'order between them is alphabetical and means nothing. Establishing anything about ' +
      'either would separate them.'
    );
  }
  return (
    `${where} sits here because of ${label(separatedBy.factor)}: ${separatedBy.because} ` +
    `Everything stronger than that factor is level with the category above it. ` +
    `${factors[0]?.because ?? ''}`
  );
}
