/**
 * What a commerce finding means, what shape of figure it carries, and what it
 * may create.
 *
 * ---------------------------------------------------------------------------
 * The one rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * A finding's kind decides everything about it by a **lookup rather than a
 * reading**. `domain/industry.ts` makes the same argument and
 * `domain/opportunitySignals.ts` made it first: the judgement is made once, by
 * the only party that can make it — somebody who read the source — and
 * everything after that is Brain matching a value from a closed set exactly.
 * Nothing here inspects a sentence.
 *
 * ---------------------------------------------------------------------------
 * Four figure columns, not one
 * ---------------------------------------------------------------------------
 *
 * A platform fee of 8, a selling price of 8, a delivery time of 8 and a
 * minimum order of 8 are four different 8s. One nullable number would
 * eventually be summed with another, and nothing downstream could tell,
 * because the result would still be a number. So the shape is declared per
 * kind and a figure in the wrong field refuses the submission — never
 * converted, because choosing a conversion is choosing what somebody meant.
 *
 * ---------------------------------------------------------------------------
 * Refused here, where the worker can still fix it
 * ---------------------------------------------------------------------------
 *
 * Every failure below refuses the whole submission rather than dropping the
 * field. §27 records why: truncation and silent dropping are the outcomes a
 * worker cannot recover from, because they are reported as success.
 */
import {
  COMMERCE_FINDINGS,
  type CommerceBasis,
  type CommerceEvidenceOrigin,
  type CommerceFigure,
  type CommerceFinding,
} from './types.ts';

export { COMMERCE_FINDINGS };
export type { CommerceFinding };

export function isCommerceFinding(value: unknown): value is CommerceFinding {
  return typeof value === 'string' && (COMMERCE_FINDINGS as readonly string[]).includes(value);
}

/**
 * What each finding is, in the one place that decides it.
 *
 * A `Record` over the whole union rather than several `Set`s, so a kind added
 * later is a compile error until somebody says what it creates, what figure it
 * carries and what a worker should look for. §27 records what two `Set`s that
 * must be total between them cost: a refusal fell into the exhausting branch
 * by default, because neither of them named it.
 */
export interface CommerceFindingSpec {
  /**
   * What this finding adds to the kernel's own tables, or null for the many
   * that are evidence about something already named.
   */
  creates: 'CHANNEL' | 'PROPOSITION' | null;
  /** Which figure column it may carry. `NONE` means it carries none. */
  figure: CommerceFigure;
  /**
   * Whether a figure is required rather than merely permitted.
   *
   * It never is, and that is deliberate rather than an omission. A source that
   * establishes a supplier exists without publishing its lead time is worth
   * filing; a rule that demanded the number would make the worker either drop
   * the claim or invent one, and §30 records which of those actually happens.
   * The absence of a figure is itself read — it withholds the margin.
   */
  figureRequired: false;
  /** One line a worker reads on the assignment, before they go looking. */
  guide: string;
}

const SPECS: Readonly<Record<CommerceFinding, CommerceFindingSpec>> = Object.freeze({
  CHANNEL: {
    creates: 'CHANNEL',
    figure: 'NONE',
    figureRequired: false,
    guide:
      'the source names a platform or surface where things are discovered and sold — set ' +
      'commerce_subject to the platform\'s own name for itself',
  },
  PRODUCT_CANDIDATE: {
    creates: 'PROPOSITION',
    figure: 'NONE',
    figureRequired: false,
    guide:
      'the source establishes a specific product being sold or asked for on a named channel — ' +
      'set commerce_subject to the product and commerce_qualifier to the channel',
  },

  PURCHASE_EVIDENCE: {
    creates: null,
    figure: 'COUNT',
    figureRequired: false,
    guide:
      'the source shows somebody actually bought: units sold, orders placed, a sold-out ' +
      'notice, a published revenue figure. Views are not this',
  },
  ATTENTION_EVIDENCE: {
    creates: null,
    figure: 'COUNT',
    figureRequired: false,
    guide:
      'the source shows attention and not buying: views, likes, follows, watch time. File it ' +
      'as this rather than as demand — Brain counts it against a proposition, not for it',
  },
  COMPETING_OFFER: {
    creates: null,
    figure: 'MONEY',
    figureRequired: false,
    guide: 'the source shows somebody already selling this, at a published price where it says one',
  },
  CREATOR_ACTIVITY: {
    creates: null,
    figure: 'COUNT',
    figureRequired: false,
    guide: 'the source shows creators promoting this, and how many or how much they are paid',
  },
  TREND_DURABILITY: {
    creates: null,
    figure: 'DAYS',
    figureRequired: false,
    guide:
      'the source establishes how long demand for this has persisted, in days where it says — ' +
      'a first-observed date and a still-current date are what make this checkable',
  },
  SATURATION: {
    creates: null,
    figure: 'COUNT',
    figureRequired: false,
    guide: 'the source establishes how many sellers are already doing this',
  },

  SUPPLIER_AVAILABLE: {
    creates: null,
    figure: 'COUNT',
    figureRequired: false,
    guide:
      'the source names a supplier that will actually supply this, and the stock it publishes ' +
      'where it publishes one',
  },
  SUPPLIER_RELIABILITY: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide:
      'the source publishes how reliably a named supplier delivers — an on-time rate, a defect ' +
      'rate, a dispute rate — as parts per million',
  },
  DELIVERY_TIME: {
    creates: null,
    figure: 'DAYS',
    figureRequired: false,
    guide: 'the source publishes how long delivery to the buyer actually takes, in days',
  },
  RETURN_TERMS: {
    creates: null,
    figure: 'DAYS',
    figureRequired: false,
    guide: 'the source publishes the returns window and who pays for a return',
  },

  SELLING_PRICE: {
    creates: null,
    figure: 'MONEY',
    figureRequired: false,
    guide: 'the source publishes what this actually sells for to an end buyer',
  },
  LANDED_UNIT_COST: {
    creates: null,
    figure: 'MONEY',
    figureRequired: false,
    guide:
      'the source publishes what one unit costs delivered to wherever it ships from, including ' +
      'duty where the source says',
  },
  SHIPPING_COST: {
    creates: null,
    figure: 'MONEY',
    figureRequired: false,
    guide: 'the source publishes what it costs to get one unit to the buyer',
  },
  PLATFORM_FEE: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide:
      "the channel's own published commission or referral fee, as parts per million of the " +
      'selling price — read it from the platform itself, not from a summary of it',
  },
  PAYMENT_FEE: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide: 'the published payment-processing rate, as parts per million',
  },
  CREATOR_COMMISSION: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide: 'the published commission a creator or affiliate takes, as parts per million',
  },
  CONTENT_COST: {
    creates: null,
    figure: 'MONEY',
    figureRequired: false,
    guide: 'what producing the content this needs actually costs, where a source publishes it',
  },
  ADVERTISING_COST: {
    creates: null,
    figure: 'MONEY',
    figureRequired: false,
    guide: 'a published cost per acquisition, per click or per thousand on this channel',
  },
  RETURN_RATE: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide: 'the published proportion of units returned, as parts per million',
  },
  REFUND_RATE: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide: 'the published proportion of orders refunded, as parts per million',
  },
  CHARGEBACK_RATE: {
    creates: null,
    figure: 'RATE',
    figureRequired: false,
    guide: 'the published proportion of orders charged back, as parts per million',
  },
  MINIMUM_ORDER: {
    creates: null,
    figure: 'COUNT',
    figureRequired: false,
    guide: "the supplier's published minimum order quantity, in units",
  },
  PAYOUT_DELAY: {
    creates: null,
    figure: 'DAYS',
    figureRequired: false,
    guide:
      "the channel's published delay between a buyer paying and the seller being paid, in days",
  },

  PLATFORM_ELIGIBILITY: {
    creates: null,
    figure: 'NONE',
    figureRequired: false,
    guide:
      'what the channel requires before anything may be sold on it — registration, a business ' +
      'entity, a deposit, a country, a category approval',
  },
  FULFILMENT_REQUIREMENT: {
    creates: null,
    figure: 'DAYS',
    figureRequired: false,
    guide:
      'what the channel obliges a seller to do about dispatch, tracking or delivery windows, ' +
      'in days where it states one',
  },
  PROHIBITED_PRODUCT: {
    creates: null,
    figure: 'NONE',
    figureRequired: false,
    guide: 'the channel publishes that this category may not be sold, or may not be sold this way',
  },
});

export function commerceSpec(finding: CommerceFinding): CommerceFindingSpec {
  return SPECS[finding];
}

/**
 * The basis a figure carries, derived from where the row came from.
 *
 * Stored nowhere, because storing it would be two fields that must agree
 * about one row — and this repository has recorded four separate times what
 * happens to the one nobody reads.
 *
 * A gated claim is an `ESTIMATE` and never a `MEASURED` result, however good
 * its source. A published platform fee is a fact about the platform and an
 * estimate about *our* economics, because nothing has yet charged us one. Only
 * a settled test measures anything, and a person's figure is an assumption
 * however confident they are.
 */
export function basisOf(origin: CommerceEvidenceOrigin): CommerceBasis {
  if (origin === 'TEST') return 'MEASURED';
  if (origin === 'CLAIM') return 'ESTIMATE';
  return 'ASSUMPTION';
}

/** Weakest wins: a margin built from one assumption is an assumption. */
const BASIS_STRENGTH: Readonly<Record<CommerceBasis, number>> = Object.freeze({
  ASSUMPTION: 0,
  ESTIMATE: 1,
  MEASURED: 2,
});

export function weakestBasis(bases: readonly CommerceBasis[]): CommerceBasis | null {
  let out: CommerceBasis | null = null;
  for (const basis of bases) {
    if (!out || BASIS_STRENGTH[basis] < BASIS_STRENGTH[out]) out = basis;
  }
  return out;
}

export function strongerBasis(a: CommerceBasis, b: CommerceBasis): CommerceBasis {
  return BASIS_STRENGTH[a] >= BASIS_STRENGTH[b] ? a : b;
}

/** One line per finding, for the assignment a worker actually reads. */
export const COMMERCE_GUIDE: Readonly<Record<CommerceFinding, string>> = Object.freeze(
  Object.fromEntries(
    COMMERCE_FINDINGS.map((finding) => [finding, SPECS[finding].guide]),
  ) as Record<CommerceFinding, string>,
);

export interface CommerceDeclaration {
  finding: CommerceFinding | null;
  subject: string | null;
  qualifier: string | null;
  amountMinor: number | null;
  ratePpm: number | null;
  days: number | null;
  count: number | null;
}

export type CommerceCheck =
  | { ok: true; value: CommerceDeclaration }
  | { ok: false; error: string };

const EMPTY: CommerceDeclaration = Object.freeze({
  finding: null,
  subject: null,
  qualifier: null,
  amountMinor: null,
  ratePpm: null,
  days: null,
  count: null,
});

/**
 * The commerce declaration on one claim, validated once.
 *
 * Two readers check it — `services/research/schema.ts` for a pass a provider
 * returned, and `mcp/researchTools.ts` for a claim a worker submitted over the
 * wire. This repository has had to write *a rule applied by one of two readers
 * is worse than none* five times, and every instance was two implementations
 * that agreed on the day they were written. So both call this, and it is the
 * only thing that decides.
 */
export function validateCommerce(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  qualifier: unknown;
  amountMinor: unknown;
  ratePpm: unknown;
  days: unknown;
  count: unknown;
}): CommerceCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const qualifier = tidy(input.qualifier);
  const figures: { name: string; field: CommerceFigure; raw: unknown }[] = [
    { name: 'commerce_amount_minor', field: 'MONEY', raw: input.amountMinor },
    { name: 'commerce_rate_ppm', field: 'RATE', raw: input.ratePpm },
    { name: 'commerce_days', field: 'DAYS', raw: input.days },
    { name: 'commerce_count', field: 'COUNT', raw: input.count },
  ];
  const given = figures.filter((one) => !absent(one.raw));

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing about selling anything, which is
     * most claims. Its companions must then be absent too: a figure with no
     * finding is a number nothing will ever read, and storing it would look
     * like it had done something.
     */
    if (subject) {
      return {
        ok: false,
        error:
          `${where}: commerce_subject was given with no commerce_finding. Say which kind of ` +
          'commercial fact this establishes, or leave the subject out.',
      };
    }
    if (qualifier) {
      return { ok: false, error: `${where}: commerce_qualifier was given with no commerce_finding.` };
    }
    if (given[0]) {
      return { ok: false, error: `${where}: ${given[0].name} was given with no commerce_finding.` };
    }
    return { ok: true, value: { ...EMPTY } };
  }

  if (!isCommerceFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: commerce_finding must be one of ${COMMERCE_FINDINGS.join(', ')}, or omitted ` +
        'when the claim says nothing about selling something to somebody on a channel.',
    };
  }
  const finding = input.finding;
  const spec = SPECS[finding];

  if (!subject) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set commerce_subject — ${spec.guide}. Nothing ` +
        'else can supply it, and reading it out of the claim sentence would be Brain guessing ' +
        'what the source was about.',
    };
  }

  /*
   * Only a product candidate names something else, and it must.
   *
   * A product with no channel is not a proposition: the same product on two
   * channels has two fee structures, two audiences and two sets of eligibility
   * rules, and filing it under neither would make the comparison the brief
   * asks for impossible. Every other finding is about itself, so a qualifier
   * on one would be a value nothing reads — worse than refusing it, because it
   * looks like it did something.
   */
  if (finding === 'PRODUCT_CANDIDATE') {
    if (!qualifier) {
      return {
        ok: false,
        error:
          `${where}: a PRODUCT_CANDIDATE must set commerce_qualifier to the channel it is sold ` +
          'on. A product with no channel has no fees, no audience and no eligibility rules, so ' +
          'there is nothing to work out about it.',
      };
    }
  } else if (qualifier) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding is about itself, so commerce_qualifier must be ` +
        'omitted. Only PRODUCT_CANDIDATE names another thing.',
    };
  }

  if (spec.figure === 'NONE' && given[0]) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding carries no figure, so ${given[0].name} must be ` +
        'omitted. Put what the source said in the claim itself.',
    };
  }
  const wrong = given.find((one) => one.field !== spec.figure);
  if (wrong) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding carries a ${spec.figure} figure, so it goes in ` +
        `${nameFor(spec.figure)} and not in ${wrong.name}. Brain will not convert one into the ` +
        'other, because choosing a conversion is choosing what you meant.',
    };
  }
  if (given.length > 1) {
    return {
      ok: false,
      error: `${where}: a ${finding} finding carries one figure, and ${given.length} were given.`,
    };
  }

  const value = given[0];
  if (value) {
    const raw = value.raw;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return {
        ok: false,
        error:
          `${where}: ${value.name} must be a whole number and not negative — minor units for ` +
          'money, parts per million for a rate, whole days for a duration, units for a count. ' +
          'Leave it out where no source publishes one: an unknown is recorded as unknown and ' +
          'withholds the margin, which is the correct outcome.',
      };
    }
    if (value.field === 'RATE' && raw > 1_000_000) {
      return {
        ok: false,
        error:
          `${where}: ${value.name} is parts per million, so 1000000 is all of it. ${raw} would ` +
          'be more than the whole selling price — check whether that is a percentage.',
      };
    }
  }

  return {
    ok: true,
    value: {
      finding,
      subject,
      qualifier: qualifier || null,
      amountMinor: pick(given, 'MONEY'),
      ratePpm: pick(given, 'RATE'),
      days: pick(given, 'DAYS'),
      count: pick(given, 'COUNT'),
    },
  };
}

function pick(
  given: readonly { field: CommerceFigure; raw: unknown }[],
  field: CommerceFigure,
): number | null {
  const found = given.find((one) => one.field === field);
  return typeof found?.raw === 'number' ? found.raw : null;
}

function nameFor(figure: CommerceFigure): string {
  if (figure === 'MONEY') return 'commerce_amount_minor';
  if (figure === 'RATE') return 'commerce_rate_ppm';
  if (figure === 'DAYS') return 'commerce_days';
  if (figure === 'COUNT') return 'commerce_count';
  return 'no figure field';
}
