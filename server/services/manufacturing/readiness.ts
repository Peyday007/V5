/**
 * Whether a machine category can be entered, what is missing if not, and which
 * other category would supply it.
 *
 * ---------------------------------------------------------------------------
 * The brief's core principle, expressed as rows rather than as a sentence
 * ---------------------------------------------------------------------------
 *
 *     DO NOT manufacture products merely because we want to manufacture them.
 *     Identify and understand existing demand. Capture or gain meaningful
 *     access to distribution flow. […] THEN manufacture.
 *
 * That is not a rule anybody can enforce by writing it into a prompt. It is
 * enforced here, by what this module is able to derive: `ENTER` requires four
 * conditions and two of them are *demand established* and *a route to the
 * buyer established*, both from dated published evidence. A category nobody has
 * researched cannot reach it, a category full of engineering knowledge and no
 * buyer cannot reach it, and there is no argument, objective or instruction
 * that changes either — because nothing that decides it reads prose.
 *
 * ---------------------------------------------------------------------------
 * Three answers per condition, and UNKNOWN is never MET
 * ---------------------------------------------------------------------------
 *
 * `MET`, `NOT_MET` and `UNKNOWN` are three facts with three different
 * remedies, and the last one is not a polite way of saying no. *Nobody has
 * looked* is answered by asking; *we looked and it is not there* is answered by
 * deciding whether to care. §30 and §37 both had to split those apart, and §32
 * had to again — `MISSING` is what Brain understands and does not have,
 * `UNKNOWN` is what nobody has told Brain.
 *
 * Invariant 39 is the half that matters here: **no unknown read as a favourable
 * assumption.** An unanswered fact is a task, it may never make something
 * ready, and it never ranks higher. In this kernel being wrong in that
 * direction means telling somebody a category is enterable when nobody has
 * established that anyone is buying — which is the error the brief exists to
 * prevent and the one with a factory on the end of it.
 *
 * ---------------------------------------------------------------------------
 * The one that could be got subtly wrong
 * ---------------------------------------------------------------------------
 *
 * `CAPABILITIES_HELD` is "every capability this category requires is held", and
 * the tempting implementation is `requires.every(held)` — which is **true of
 * the empty set**. A category nobody has asked what it takes to build would
 * then report that this company already has everything it needs. So holding is
 * `UNKNOWN` until `CAPABILITIES_KNOWN` is `MET`: you cannot have established
 * that you hold all of a set nobody has established.
 */
import type { Capability, MachineCategory } from '../../domain/types.ts';
import type { CategoryCoverage, LadderSnapshot } from './ladder.ts';

export const CONDITION_ANSWERS = ['MET', 'NOT_MET', 'UNKNOWN'] as const;
export type ConditionAnswer = (typeof CONDITION_ANSWERS)[number];

export const ENTRY_CONDITIONS = [
  /** Published, dated evidence that somebody is buying machines of this kind. */
  'DEMAND_ESTABLISHED',
  /** A published route by which product actually reaches whoever pays. */
  'ROUTE_TO_BUYER_ESTABLISHED',
  /** What producing here requires has been established at all. */
  'REQUIREMENTS_KNOWN',
  /** Every requirement established is one this company is recorded as holding. */
  'CAPABILITIES_HELD',
] as const;
export type EntryCondition = (typeof ENTRY_CONDITIONS)[number];

export interface ConditionReading {
  condition: EntryCondition;
  answer: ConditionAnswer;
  /** The rows it was read from, so it can be argued with. */
  because: string;
}

/**
 * What to do with a category.
 *
 * Six verdicts, taken from the brief's own progression, and every one of them
 * is decided by rows that already exist. Nothing here reads prose, assigns a
 * weight, or produces a number that looks like a measurement — `verdict.ts`
 * settled this for industry subjects and `portfolio.ts` for opportunities, and
 * nothing about machines changes the argument.
 */
export const ENTRY_VERDICTS = [
  /** A person decided not to pursue it. The one verdict no derivation reaches. */
  'RETIRED',
  /** Nothing has been asked about it. */
  'UNEXAMINED',
  /** Questions are running and nothing has settled yet. */
  'INVESTIGATING',
  /** Looked at, and nothing published says anybody is buying. */
  'NO_DEMAND_FOUND',
  /**
   * Buyers are established and nothing published says how product reaches them.
   *
   * Its own verdict rather than folded into the one above, because the brief
   * names distribution as its own step — *capture or gain meaningful access to
   * distribution flow* — and the two have different remedies. "Nobody is
   * buying" is answered by looking elsewhere; "nobody has established how it
   * gets to them" is answered by asking again, or by a person deciding a route
   * can be built. Collapsing them would send somebody to abandon a category
   * over a question that had not been settled.
   */
  'NO_ROUTE_FOUND',
  /** Demand and a route are established; what it takes is not, or is not held. */
  'BUILD_CAPABILITY_FIRST',
  /** Every condition is met: demand, a route, known requirements, all held. */
  'ENTER',
] as const;
export type EntryVerdict = (typeof ENTRY_VERDICTS)[number];

export interface CapabilityGap {
  capability: Capability;
  /**
   * Categories already established to develop it.
   *
   * The brief's capability chain, derived rather than declared: everything that
   * teaches what this category requires is a predecessor of it, and there can
   * be several, which is why a tree could never have held this. Retired
   * categories are excluded — a path a person killed is not a way to get
   * something.
   */
  taughtBy: MachineCategory[];
}

export interface CategoryReading {
  categoryId: string;
  path: string[];
  verdict: EntryVerdict;
  /** The four conditions, always all four, in their declared order. */
  conditions: ConditionReading[];
  /** Requirements established and not held, each with what would supply it. */
  missing: CapabilityGap[];
  /** Requirements established and held. */
  held: Capability[];
  /** What entering would create that nothing else on the ladder teaches yet. */
  wouldTeach: Capability[];
  /** The barriers established, which are never capital and never capabilities. */
  barriers: string[];
  /** One sentence composed from the above. Never a score. */
  because: string;
}

/**
 * Read one category against the four conditions.
 *
 * `taughtElsewhere` is the whole snapshot's TEACHES edges, passed in rather
 * than fetched, because the chain is a fact about the ladder rather than about
 * this category — and a function that fetched it per category would make one
 * reading cost as many queries as there are categories.
 */
export function readCategory(input: {
  coverage: CategoryCoverage;
  teachersByCapabilityId: ReadonlyMap<string, MachineCategory[]>;
  allRequiredCapabilityIds: ReadonlySet<string>;
}): CategoryReading {
  const { coverage } = input;
  const path = coverage.path;

  /*
   * The requirements reading is named rather than indexed, because the one
   * below depends on it.
   *
   * `conditions[2]` would be correct today and silently wrong the moment
   * somebody reorders the array — and wrong in the direction that matters:
   * `heldCondition` handed the *route* reading would answer MET for a category
   * whose requirements nobody has established.
   */
  const requirements = requirementsCondition(coverage);
  const conditions: ConditionReading[] = [
    demandCondition(coverage),
    routeCondition(coverage),
    requirements,
    // Last, because "every requirement is held" is only answerable once there
    // are requirements to have established.
    heldCondition(coverage, requirements),
  ];

  const held = coverage.requires.filter((one) => one.heldAt !== null);
  const missing: CapabilityGap[] = coverage.requires
    .filter((one) => one.heldAt === null)
    .map((capability) => ({
      capability,
      taughtBy: (input.teachersByCapabilityId.get(capability.id) ?? []).filter(
        (one) => one.id !== coverage.category.id && one.retiredAt === null,
      ),
    }));

  /*
   * What entering this would create that nothing else needs yet.
   *
   * Deliberately *not* "everything it teaches". The brief asks what adjacent
   * products become easier afterwards, and a capability nothing on the ladder
   * requires makes nothing easier that Brain can currently name — reporting it
   * as strategic value would be an encouraging number with nothing behind it.
   * As the ladder grows and something requires it, it appears here by itself.
   */
  const wouldTeach = coverage.teaches.filter(
    (one) => one.heldAt === null && input.allRequiredCapabilityIds.has(one.id),
  );

  const verdict = verdictFrom(coverage, conditions);
  return {
    categoryId: coverage.category.id,
    path,
    verdict,
    conditions,
    missing,
    held,
    wouldTeach,
    barriers: coverage.barriers.map((one) => one.subject),
    because: explain({ coverage, verdict, conditions, missing }),
  };
}

function demandCondition(coverage: CategoryCoverage): ConditionReading {
  if (coverage.demand.length > 0) {
    const newest = coverage.demand
      .map((one) => one.observedOn)
      .filter((one): one is string => one !== null)
      .sort()
      .at(-1);
    return {
      condition: 'DEMAND_ESTABLISHED',
      answer: 'MET',
      because:
        `${coverage.demand.length} published observation` +
        (coverage.demand.length === 1 ? '' : 's') +
        ` that somebody is buying here${newest ? `, the most recent observed ${newest}` : ''}.`,
    };
  }
  if (coverage.settled.DEMAND > 0) {
    return {
      condition: 'DEMAND_ESTABLISHED',
      answer: 'NOT_MET',
      because:
        `${coverage.settled.DEMAND} question${coverage.settled.DEMAND === 1 ? ' has' : 's have'} ` +
        'asked who is buying here and nothing published came back.',
    };
  }
  return {
    condition: 'DEMAND_ESTABLISHED',
    answer: 'UNKNOWN',
    because: 'Nothing has asked whether anybody is buying machines of this kind.',
  };
}

function routeCondition(coverage: CategoryCoverage): ConditionReading {
  if (coverage.distribution.length > 0) {
    return {
      condition: 'ROUTE_TO_BUYER_ESTABLISHED',
      answer: 'MET',
      because: `Product reaches a buyer here by ${coverage.distribution
        .map((one) => one.subject)
        .join(', ')}.`,
    };
  }
  if (coverage.settled.DEMAND > 0) {
    return {
      condition: 'ROUTE_TO_BUYER_ESTABLISHED',
      answer: 'NOT_MET',
      because:
        'The demand question has been asked and nothing published established how product ' +
        'actually reaches whoever pays for it.',
    };
  }
  return {
    condition: 'ROUTE_TO_BUYER_ESTABLISHED',
    answer: 'UNKNOWN',
    because: 'Nothing has asked how product in this category reaches a buyer.',
  };
}

function requirementsCondition(coverage: CategoryCoverage): ConditionReading {
  if (coverage.requires.length > 0) {
    return {
      condition: 'REQUIREMENTS_KNOWN',
      answer: 'MET',
      because:
        `${coverage.requires.length} capabilit${coverage.requires.length === 1 ? 'y is' : 'ies are'} ` +
        'established as needed to produce here.',
    };
  }
  if (coverage.settled.CAPABILITY > 0) {
    return {
      condition: 'REQUIREMENTS_KNOWN',
      answer: 'NOT_MET',
      because:
        'The capability question has been asked and nothing published named what producing ' +
        'here requires.',
    };
  }
  return {
    condition: 'REQUIREMENTS_KNOWN',
    answer: 'UNKNOWN',
    because: 'Nothing has asked what producing in this category requires.',
  };
}

/**
 * Every requirement established is one this company is recorded as holding.
 *
 * The condition with the subtle failure, and the reason it takes the previous
 * reading rather than looking at the same rows again: `requires.every(held)` is
 * `true` for a category nobody has asked what it takes to build, so a
 * completely unexamined category would report that this company already has
 * everything it needs. Holding is therefore `UNKNOWN` until the requirements
 * are known — you cannot have established that you hold all of a set nobody
 * has established.
 */
function heldCondition(
  coverage: CategoryCoverage,
  requirements: ConditionReading,
): ConditionReading {
  if (requirements.answer !== 'MET') {
    return {
      condition: 'CAPABILITIES_HELD',
      answer: 'UNKNOWN',
      because:
        'What producing here requires has not been established, so whether this company holds ' +
        'it cannot be answered. An empty list of requirements is not a list that is satisfied.',
    };
  }
  const missing = coverage.requires.filter((one) => one.heldAt === null);
  if (missing.length === 0) {
    return {
      condition: 'CAPABILITIES_HELD',
      answer: 'MET',
      because: `All ${coverage.requires.length} established requirements are recorded as held.`,
    };
  }
  return {
    condition: 'CAPABILITIES_HELD',
    answer: 'NOT_MET',
    because:
      `${missing.length} of ${coverage.requires.length} established requirements are not ` +
      `recorded as held: ${missing.map((one) => one.name).join(', ')}.`,
  };
}

function verdictFrom(
  coverage: CategoryCoverage,
  conditions: readonly ConditionReading[],
): EntryVerdict {
  if (coverage.category.retiredAt !== null) return 'RETIRED';

  const answer = (condition: EntryCondition) =>
    conditions.find((one) => one.condition === condition)?.answer ?? 'UNKNOWN';

  if (conditions.every((one) => one.answer === 'MET')) return 'ENTER';

  if (answer('DEMAND_ESTABLISHED') === 'NOT_MET') return 'NO_DEMAND_FOUND';

  if (answer('DEMAND_ESTABLISHED') === 'MET') {
    /*
     * Buyers, and the route decides which of the two this is.
     *
     * `NOT_MET` is its own verdict rather than falling through to
     * `INVESTIGATING`: the demand round has *settled*, so describing it as
     * still being researched would be a status that contradicts the rows
     * underneath it — §29's defect, and the reason this branch exists at all.
     */
    if (answer('ROUTE_TO_BUYER_ESTABLISHED') === 'MET') return 'BUILD_CAPABILITY_FIRST';
    if (answer('ROUTE_TO_BUYER_ESTABLISHED') === 'NOT_MET') return 'NO_ROUTE_FOUND';
  }

  const anythingAsked =
    coverage.settled.MAP +
      coverage.settled.DEMAND +
      coverage.settled.CAPABILITY +
      coverage.settled.INTEGRATION >
      0 ||
    coverage.open.MAP ||
    coverage.open.DEMAND ||
    coverage.open.CAPABILITY ||
    coverage.open.INTEGRATION;

  return anythingAsked ? 'INVESTIGATING' : 'UNEXAMINED';
}

function explain(input: {
  coverage: CategoryCoverage;
  verdict: EntryVerdict;
  conditions: readonly ConditionReading[];
  missing: readonly CapabilityGap[];
}): string {
  const where = input.coverage.path.join(' → ');
  switch (input.verdict) {
    case 'RETIRED':
      return input.coverage.category.retiredReason ?? 'A person retired this category.';
    case 'UNEXAMINED':
      return `Nothing has been asked about ${where}.`;
    case 'INVESTIGATING':
      return `${where} is being researched and no condition has settled either way yet.`;
    case 'NO_DEMAND_FOUND':
      return (
        `${where} has been asked who is buying and nothing published came back. Manufacturing ` +
        'here would be looking for demand afterwards.'
      );
    case 'NO_ROUTE_FOUND':
      return (
        `Somebody is buying in ${where}, and nothing published establishes how product of this ` +
        'kind actually reaches them. Producing before that is settled would be producing with ' +
        'nowhere to sell.'
      );
    case 'BUILD_CAPABILITY_FIRST': {
      const bridged = input.missing.filter((one) => one.taughtBy.length > 0);
      const unbridged = input.missing.filter((one) => one.taughtBy.length === 0);
      const parts = [`Somebody is buying in ${where} and there is a published route to them.`];
      if (input.missing.length === 0) {
        parts.push('What producing here requires has not been established yet.');
      } else {
        parts.push(
          `${input.missing.length} established requirement` +
            (input.missing.length === 1 ? ' is' : 's are') +
            ' not held.',
        );
      }
      if (bridged.length > 0) {
        parts.push(
          `${bridged.length} of them ${bridged.length === 1 ? 'is' : 'are'} developed by ` +
            'something already on the ladder: ' +
            bridged
              .map((one) => `${one.capability.name} ← ${one.taughtBy.map((c) => c.name).join(', ')}`)
              .join('; ') +
            '.',
        );
      }
      if (unbridged.length > 0) {
        parts.push(
          `Nothing on the ladder is established to develop ${unbridged
            .map((one) => one.capability.name)
            .join(', ')}.`,
        );
      }
      return parts.join(' ');
    }
    case 'ENTER':
      return (
        `Somebody is buying in ${where}, there is a published route to them, what producing ` +
        'there requires is established, and every one of those requirements is recorded as ' +
        'held by this company.'
      );
  }
}

/**
 * Every live category's reading, and the chain index both it and the allocator
 * need.
 *
 * Built once over the snapshot for the reason `coverageOf` is: a per-category
 * fetch would make one reading cost a query per category, and the chain is a
 * fact about the whole ladder rather than about any one rung.
 */
export function readLadder(snapshot: LadderSnapshot): CategoryReading[] {
  const byId = new Map(snapshot.categories.map((one) => [one.id, one]));

  const teachersByCapabilityId = new Map<string, MachineCategory[]>();
  const allRequiredCapabilityIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edge.relation === 'REQUIRES') {
      allRequiredCapabilityIds.add(edge.capabilityId);
      continue;
    }
    const category = byId.get(edge.categoryId);
    if (!category) continue;
    teachersByCapabilityId.set(edge.capabilityId, [
      ...(teachersByCapabilityId.get(edge.capabilityId) ?? []),
      category,
    ]);
  }

  return snapshot.coverage.map((coverage) =>
    readCategory({ coverage, teachersByCapabilityId, allRequiredCapabilityIds }),
  );
}

/**
 * Categories that would supply what a target is missing, nearest first.
 *
 * The brief's *"think in capability chains"* as a query. It returns categories
 * rather than a sequence, deliberately: a sequence would be the rigid roadmap,
 * and which of several bridges to take depends on their own readings — which
 * the caller already has and this function must not second-guess.
 */
export function bridgesTo(
  target: CategoryReading,
  readings: readonly CategoryReading[],
): { category: MachineCategory; supplies: Capability[] }[] {
  if (target.missing.length === 0) return [];
  const byCategoryId = new Map<string, { category: MachineCategory; supplies: Capability[] }>();
  for (const gap of target.missing) {
    for (const category of gap.taughtBy) {
      const existing = byCategoryId.get(category.id);
      if (existing) existing.supplies.push(gap.capability);
      else byCategoryId.set(category.id, { category, supplies: [gap.capability] });
    }
  }
  const readingById = new Map(readings.map((one) => [one.categoryId, one]));
  return [...byCategoryId.values()].sort(
    (a, b) =>
      // Most of what the target needs first; then whichever bridge is itself
      // closest to being enterable, read from its own verdict rather than from
      // anything this function decides.
      b.supplies.length - a.supplies.length ||
      rank(readingById.get(a.category.id)) - rank(readingById.get(b.category.id)) ||
      a.category.name.localeCompare(b.category.name),
  );
}

function rank(reading: CategoryReading | undefined): number {
  if (!reading) return 99;
  return ENTRY_VERDICTS.length - ENTRY_VERDICTS.indexOf(reading.verdict);
}
