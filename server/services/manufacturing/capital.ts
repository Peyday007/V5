/**
 * What entering a category costs, read from rows and refused where it is not
 * known.
 *
 * ---------------------------------------------------------------------------
 * The one rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * **A total is withheld whenever any established requirement carries no
 * published figure.** Not estimated, not skipped, not summed over what happens
 * to be priced — withheld, with the unpriced requirements named.
 *
 * §30 settled the same question one section along, and the reason is the
 * direction of the error rather than its size. A sum that quietly steps over
 * an unpriced requirement is *smaller* than anything published says, so it
 * makes a category look cheaper to enter than it is — and a figure that is too
 * low at the number that would start a factory is the shape of error nobody
 * checks, because it reads as a bargain rather than as a mistake. Withholding
 * is loud: a reader sees "not known" and asks.
 *
 * `conservativeContribution` is the recorded precedent, and it is recorded as
 * a *defect*: it treated an unknown exposure as zero, so a piece nobody had
 * costed ranked above an identically-priced one somebody had. The card refused
 * the blank and the ranking rewarded it. Nothing here may reward a blank.
 *
 * ---------------------------------------------------------------------------
 * Scenario, not an average
 * ---------------------------------------------------------------------------
 *
 * The directive asks for a range or a scenario, and both are here because they
 * answer different halves. A **range** is what one source published about one
 * requirement. A **scenario** is which shape of the business a figure is
 * about, and figures from different scenarios are never added: what the first
 * credible machine costs and what volume production costs are two facts, and a
 * number that mixed them would be one nobody could act on.
 *
 * So a reading is produced **per scenario**, and a scenario with nothing in it
 * is absent rather than zero.
 *
 * ---------------------------------------------------------------------------
 * Nothing here converts a currency
 * ---------------------------------------------------------------------------
 *
 * A rate is a fact about a day that nobody has recorded, and applying one
 * would turn published figures into a number Brain made up. Where one
 * scenario's requirements are priced in more than one currency the totals are
 * reported **per currency**, side by side, and the reading says so. That is
 * less convenient and it is the only honest output.
 */
import { CAPITAL_SCENARIOS } from '../../domain/types.ts';
import type {
  CapitalScenario,
  CategoryCapitalEntry,
  MachineCapitalRequirement,
} from '../../domain/types.ts';

/** A total in one currency: low and high, from published ranges only. */
export interface MoneyRange {
  currency: string;
  lowMinor: number;
  highMinor: number;
}

export interface ScenarioReading {
  scenario: CapitalScenario;
  /**
   * The totals, per currency — or **null**, which means a requirement here has
   * no published figure and no total may be reported.
   *
   * Null is the answer rather than the absence of one, and every reader has to
   * handle it: this is the field where a `?? 0` would reintroduce the exact
   * defect the module exists to prevent.
   */
  totals: MoneyRange[] | null;
  /** Requirements established under this scenario with a published figure. */
  priced: CategoryCapitalEntry[];
  /** Requirements established under this scenario with none. Named, not hidden. */
  unpriced: CategoryCapitalEntry[];
  /** One sentence composed from the above. Never a number on its own. */
  because: string;
}

export interface CapitalReading {
  /**
   * Whether anything at all has been established about what entering costs.
   *
   * `UNEXAMINED` is its own answer, because *nobody has looked* and *we looked
   * and it is not published* have different remedies — the first is answered by
   * asking and the second by deciding whether to care.
   */
  state: 'UNEXAMINED' | 'PARTIAL' | 'ESTABLISHED';
  /** Every scenario anything was found for, in the vocabulary's own order. */
  scenarios: ScenarioReading[];
  /**
   * The cheapest *fully priced* scenario, if there is one.
   *
   * "Fully priced" is the whole of it: a scenario with an unpriced requirement
   * can never be the cheapest one, however small its priced figures are,
   * because nobody knows what it costs. A blank may never be the reason
   * something ranks better.
   */
  cheapestFullyPriced: ScenarioReading | null;
  /** Requirements with no figure anywhere, across every scenario. */
  unpricedRequirements: MachineCapitalRequirement[];
  because: string;
}

/**
 * Read the capital rows for one category.
 *
 * Pure over what it is given, for `allocate.ts`' reason: a reading somebody
 * disagrees with has to be answerable from a recorded input rather than from a
 * re-run against a database that has moved.
 */
export function readCapital(entries: readonly CategoryCapitalEntry[]): CapitalReading {
  if (entries.length === 0) {
    return {
      state: 'UNEXAMINED',
      scenarios: [],
      cheapestFullyPriced: null,
      unpricedRequirements: [],
      because: 'Nothing has established what entering this category costs.',
    };
  }

  const scenarios: ScenarioReading[] = [];
  for (const scenario of CAPITAL_SCENARIOS) {
    const mine = entries.filter((one) => one.scenario === scenario);
    if (mine.length === 0) continue;
    scenarios.push(readScenario(scenario, mine));
  }

  const fullyPriced = scenarios.filter((one) => one.totals !== null && one.unpriced.length === 0);
  /*
   * The cheapest is the first fully-priced one in the vocabulary's own order.
   *
   * Deliberately not "the one with the smallest number". Comparing across
   * currencies needs a rate nobody recorded, and comparing across scenarios
   * compares two different businesses — so the order that decides is the
   * declared one, smallest shape of business first, which is a fact about the
   * vocabulary rather than an arithmetic claim.
   */
  const cheapestFullyPriced = fullyPriced[0] ?? null;

  const unpricedRequirements = [
    ...new Set(
      entries.filter((one) => one.amountLowMinor === null).map((one) => one.requirement),
    ),
  ].sort();

  const state = unpricedRequirements.length === 0 ? 'ESTABLISHED' : 'PARTIAL';

  return {
    state,
    scenarios,
    cheapestFullyPriced,
    unpricedRequirements,
    because: explain({ state, scenarios, cheapestFullyPriced, unpricedRequirements }),
  };
}

function readScenario(
  scenario: CapitalScenario,
  entries: readonly CategoryCapitalEntry[],
): ScenarioReading {
  const priced = entries.filter((one) => one.amountLowMinor !== null);
  const unpriced = entries.filter((one) => one.amountLowMinor === null);

  if (unpriced.length > 0) {
    return {
      scenario,
      totals: null,
      priced,
      unpriced,
      because:
        `${unpriced.length} of ${entries.length} established requirement` +
        (entries.length === 1 ? '' : 's') +
        ` here ${unpriced.length === 1 ? 'has' : 'have'} no published figure — ` +
        `${unpriced.map((one) => label(one.requirement)).join(', ')} — so no total is ` +
        'reported. A sum over what happens to be priced would be smaller than anything ' +
        'published says entering costs.',
    };
  }

  const byCurrency = new Map<string, MoneyRange>();
  for (const entry of priced) {
    // Every priced entry carries a currency: the validator refuses an amount
    // without one, and the schema refuses the pair being half-null.
    const currency = entry.currency ?? '';
    const low = entry.amountLowMinor ?? 0;
    const high = entry.amountHighMinor ?? 0;
    const existing = byCurrency.get(currency);
    if (existing) {
      existing.lowMinor += low;
      existing.highMinor += high;
    } else {
      byCurrency.set(currency, { currency, lowMinor: low, highMinor: high });
    }
  }
  const totals = [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    scenario,
    totals,
    priced,
    unpriced,
    because:
      `All ${priced.length} established requirement` +
      (priced.length === 1 ? ' is' : 's are') +
      ' published with a figure, so a total can be reported: ' +
      totals.map((one) => describeRange(one)).join(' plus ') +
      (totals.length > 1
        ? '. They are reported side by side because converting between them needs a rate ' +
          'nobody recorded, and a converted figure would be a number Brain made up.'
        : '.'),
  };
}

function explain(input: {
  state: CapitalReading['state'];
  scenarios: readonly ScenarioReading[];
  cheapestFullyPriced: ScenarioReading | null;
  unpricedRequirements: readonly MachineCapitalRequirement[];
}): string {
  const asked = input.scenarios.length;
  if (input.state === 'ESTABLISHED' && input.cheapestFullyPriced) {
    const cheapest = input.cheapestFullyPriced;
    return (
      `Every established requirement carries a published figure. The smallest shape of entry ` +
      `anything has been established for is ${label(cheapest.scenario)}, at ` +
      `${(cheapest.totals ?? []).map(describeRange).join(' plus ')}.`
    );
  }
  const missing = input.unpricedRequirements.map(label).join(', ');
  return (
    `What entering costs is established across ${asked} shape${asked === 1 ? '' : 's'} of ` +
    `entry and is not complete: nothing published gives a figure for ${missing}. No total is ` +
    'reported, because a sum that stepped over those would be smaller than anything published ' +
    'says — and too low is the direction nobody checks.'
  );
}

/** A closed-set value as a person reads it. Presentation only. */
export function label(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

export function describeRange(range: MoneyRange): string {
  const low = major(range.lowMinor);
  const high = major(range.highMinor);
  return low === high
    ? `${range.currency} ${low}`
    : `${range.currency} ${low} to ${high}`;
}

/**
 * Minor units as a readable figure.
 *
 * Two decimal places, because every currency this could carry is stored in
 * minor units by the same rule and a reading that guessed an exponent per
 * currency would be inventing precision. It is presentation: nothing decides
 * anything from this string.
 */
function major(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return `${whole.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}
