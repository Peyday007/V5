/**
 * What the evidence supports saying about money, and what it does not.
 *
 * Two kinds of number live on the Cash screen and they must never be shown
 * alike. A **fact** is derived from an append-only entry — invariant 37 — and
 * `cashPosition` already produces those. A **forecast** is arithmetic over
 * fields on opportunity rows, and every one of those fields is either answered,
 * with a source, or blank. This module is the second kind and its whole
 * discipline is the one §30 already applies to a margin: **withhold naming
 * which half is missing, rather than estimate.**
 *
 * So every figure here is `{ value, ... }` **or** `{ value: null, unknown,
 * blocking }`. There is no default, no zero standing in for an unknown, and no
 * midpoint of a range nobody stated. An estimate withheld says exactly which
 * card fields are blank and what has to finish before Brain could answer —
 * invariant 39, at the one screen where guessing is most tempting because a
 * blank looks unhelpful.
 *
 * **It reads and writes nothing.** One `listOpportunities` call and arithmetic
 * over what comes back. It never calls the card gate's writer, never transitions
 * an opportunity, and never touches a claim — a forecast that moved a row to
 * make itself look complete is the failure this file exists to avoid.
 *
 * **A range is the sources' own spread, never a confidence interval.** Where
 * several qualified opportunities each carry a figure, the low and the high are
 * the actual lowest and highest, and `basis` says how many rows they came from.
 * Brain invents no distribution: §30's rule that a score needs weights nobody
 * set applies to an error bar exactly as it applies to a rank.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { evidenceCard, type CardFieldKey } from './card.ts';
import type { CashOpportunity } from '../../domain/types.ts';

/** How sure Brain is, expressed as what it counted rather than as a percentage. */
export type ForecastConfidence = 'NONE' | 'SINGLE_ROW' | 'SEVERAL_ROWS';

export interface Estimate {
  /** Cents, or null when the evidence does not support an answer. */
  valueCents: number | null;
  /** The spread across the rows it came from. Null when there is no figure. */
  lowCents: number | null;
  highCents: number | null;
  /** How many opportunity rows carried the figure this was derived from. */
  fromRows: number;
  confidence: ForecastConfidence;
  /** What it is, in a person's words. */
  basis: string;
  /**
   * The card fields that are blank and would have to be answered.
   *
   * Empty when the estimate exists. Non-empty is the answer to "why is this
   * not a number", and it names fields rather than describing them, because
   * those are the things a person or a worker can actually go and settle.
   */
  unknown: string[];
  /** What must finish before Brain could estimate this. Empty when it has. */
  blocking: string;
}

export interface DurationEstimate {
  days: number | null;
  lowDays: number | null;
  highDays: number | null;
  fromRows: number;
  confidence: ForecastConfidence;
  basis: string;
  unknown: string[];
  blocking: string;
}

export interface CashForecast {
  currency: string;
  /** How many opportunities are qualified enough to forecast from, and of how many. */
  qualified: number;
  considered: number;
  upfrontCash: Estimate;
  ongoingCosts: Estimate;
  revenue: Estimate;
  contribution: Estimate;
  timeToFirstDollar: DurationEstimate;
  breakEven: DurationEstimate;
  /**
   * Unpriced effort, reported beside the money rather than multiplied by a rate.
   *
   * §30's rule verbatim: nobody set an hourly rate, so turning hours into a cost
   * would be the invented judgment the whole card gate exists to refuse.
   */
  humanHours: { total: number | null; fromRows: number; unknown: string[] };
}

/** The card's own labels, so a blank is named the way the card names it. */
const FIELD_LABEL: Record<CardFieldKey, string> = {
  payer: 'Payer',
  access: 'Access',
  buyingEvidence: 'Buying evidence',
  offer: 'Offer',
  acceptance: 'Acceptance condition',
  price: 'Price',
  delivery: 'Delivery',
  fulfillment: 'Who does the work',
  cashDates: 'Cash dates',
  economics: 'Economics',
  exposure: 'Exposure',
  nextAction: 'Next action',
};

/** States whose figures describe work that could still produce cash. */
const LIVE: CashOpportunity['state'][] = [
  'EVIDENCE_CARD',
  'READY',
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
];

function confidenceOf(rows: number): ForecastConfidence {
  if (rows === 0) return 'NONE';
  return rows === 1 ? 'SINGLE_ROW' : 'SEVERAL_ROWS';
}

function withheld(input: {
  basis: string;
  unknown: string[];
  blocking: string;
}): Estimate {
  return {
    valueCents: null,
    lowCents: null,
    highCents: null,
    fromRows: 0,
    confidence: 'NONE',
    basis: input.basis,
    unknown: input.unknown,
    blocking: input.blocking,
  };
}

/**
 * Sum one field across the rows that answer it.
 *
 * A row with no figure is **not** counted as zero. Treating a blank as nought
 * is exactly the defect §30 records in `conservativeContribution`: it makes the
 * uncosted piece look like the cheap one, and it fails in the direction that
 * makes something look worth doing.
 */
function sumField(input: {
  opportunities: CashOpportunity[];
  pick: (one: CashOpportunity) => number | null;
  basis: string;
  blockingField: CardFieldKey;
  blocking: string;
}): Estimate {
  const values: number[] = [];
  const unknown = new Set<string>();

  for (const one of input.opportunities) {
    const value = input.pick(one);
    if (value === null) {
      for (const key of evidenceCard(one).readiness.missing) unknown.add(FIELD_LABEL[key]);
      unknown.add(FIELD_LABEL[input.blockingField]);
      continue;
    }
    values.push(value);
  }

  if (values.length === 0) {
    return withheld({
      basis: input.basis,
      unknown: [...unknown].sort(),
      blocking: input.blocking,
    });
  }

  return {
    valueCents: values.reduce((total, value) => total + value, 0),
    lowCents: Math.min(...values),
    highCents: Math.max(...values),
    fromRows: values.length,
    confidence: confidenceOf(values.length),
    basis: input.basis,
    // Still reported when *some* rows answered: a total over four of six rows
    // is a real total and an incomplete one, and both halves have to be said.
    unknown: [...unknown].sort(),
    blocking: unknown.size === 0 ? '' : input.blocking,
  };
}

/**
 * The money picture's forecast half, read from opportunity rows only.
 *
 * `ongoingCosts` has no column, and that is reported rather than approximated:
 * the row carries `peakFundingCents` — the most cash out at once — and nothing
 * that separates a recurring cost from a one-off. Deriving a monthly figure
 * from a peak would be arithmetic on a field that does not mean that.
 */
export async function cashForecast(input: {
  projectId: string;
  currency: string;
}): Promise<CashForecast> {
  const all = await listOpportunities({ projectId: input.projectId });
  const live = all.filter((one) => LIVE.includes(one.state));

  /*
   * Only rows in this sprint's own currency contribute. §30 refuses a
   * conversion at a rate nobody chose, and a forecast that silently added two
   * currencies would be doing exactly that one layer up.
   */
  const opportunities = live.filter((one) => one.currency === input.currency);

  const revenue = sumField({
    opportunities,
    pick: (one) => one.priceCents,
    basis: 'The prices stated on qualified opportunities.',
    blockingField: 'price',
    blocking: 'A price has to be read from a source or proposed on each card before Brain can total it.',
  });

  const upfrontCash = sumField({
    opportunities,
    pick: (one) => one.peakFundingCents,
    basis: 'The most cash out at once, summed across qualified opportunities.',
    blockingField: 'exposure',
    blocking: 'Each card needs its exposure answered — the most cash out before any comes back.',
  });

  /*
   * Contribution needs *both* halves on the same row, which is §30's rule about
   * a margin restated: a margin against an unknown cost fails in the direction
   * that makes a piece look worth doing.
   */
  const pairs = opportunities.filter(
    (one) => one.priceCents !== null && one.peakFundingCents !== null,
  );
  const contribution: Estimate =
    pairs.length === 0
      ? withheld({
          basis: 'Price minus exposure, on the opportunities that answer both.',
          unknown: [...new Set(
            opportunities.flatMap((one) =>
              evidenceCard(one).readiness.missing.map((key) => FIELD_LABEL[key]),
            ),
          )].sort(),
          blocking:
            'No opportunity yet answers both its price and its exposure. A margin against an unknown cost is the estimate that makes something look worth doing.',
        })
      : (() => {
          const margins = pairs.map((one) => one.priceCents! - one.peakFundingCents!);
          return {
            valueCents: margins.reduce((total, value) => total + value, 0),
            lowCents: Math.min(...margins),
            highCents: Math.max(...margins),
            fromRows: margins.length,
            confidence: confidenceOf(margins.length),
            basis: 'Price minus exposure, on the opportunities that answer both.',
            unknown:
              pairs.length === opportunities.length
                ? []
                : [`${opportunities.length - pairs.length} opportunit${opportunities.length - pairs.length === 1 ? 'y does' : 'ies do'} not answer both`],
            blocking:
              pairs.length === opportunities.length
                ? ''
                : 'The rest need a price and an exposure before they can be included.',
          };
        })();

  const hoursRows = opportunities.filter((one) => one.humanHours !== null);

  const noDates = withheld({
    basis: 'Read from the payment terms and deadline on qualified opportunities.',
    unknown: [...new Set(
      opportunities.flatMap((one) =>
        evidenceCard(one).readiness.missing.map((key) => FIELD_LABEL[key]),
      ),
    )].sort(),
    blocking:
      'No opportunity yet states when cash would arrive. Brain reads that from a card, and will not derive it from a deadline that means something else.',
  });

  return {
    currency: input.currency,
    qualified: opportunities.length,
    considered: all.length,
    upfrontCash,
    ongoingCosts: withheld({
      basis: 'Recurring cost of running a qualified opportunity.',
      unknown: opportunities.length === 0 ? [] : [FIELD_LABEL.economics],
      blocking:
        'Nothing recorded separates a recurring cost from a one-off, so there is no figure to total. Exposure is the most cash out at once and is reported as that instead.',
    }),
    revenue,
    contribution,
    /*
     * Both durations are withheld for the same reason and it is a real one: the
     * row holds `paymentTerms` as free text and `deadline` as a date that means
     * "this opening closes", not "cash lands". Turning either into days would be
     * reading a field as something it does not say.
     */
    timeToFirstDollar: { days: null, lowDays: null, highDays: null, fromRows: 0, confidence: 'NONE', basis: noDates.basis, unknown: noDates.unknown, blocking: noDates.blocking },
    breakEven: {
      days: null,
      lowDays: null,
      highDays: null,
      fromRows: 0,
      confidence: 'NONE',
      basis: 'When cumulative contribution covers the cash put in.',
      unknown: noDates.unknown,
      blocking:
        'Break-even needs both a dated cash-in and a recurring cost, and neither is recorded yet.',
    },
    humanHours: {
      total: hoursRows.length === 0 ? null : hoursRows.reduce((t, one) => t + (one.humanHours ?? 0), 0),
      fromRows: hoursRows.length,
      unknown:
        hoursRows.length === opportunities.length ? [] : [FIELD_LABEL.economics],
    },
  };
}
