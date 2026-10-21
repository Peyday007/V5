/**
 * What a commerce finding means, and the one validator both submission doors
 * call (§73).
 *
 * ---------------------------------------------------------------------------
 * The rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * A finding's kind decides what it is about, by a **lookup rather than a
 * reading** — `domain/puzzle.ts`, `domain/dealflow.ts` and
 * `domain/opportunitySignals.ts` make the same argument. The judgement is
 * made once, by the only party that can make it: somebody who read the
 * source. Everything after that is Brain matching a value from a closed set
 * exactly. Nothing here inspects a sentence, and nothing downstream may.
 *
 * ---------------------------------------------------------------------------
 * A retail price, a supplier's unit cost and a fee are three different
 * numbers, and that difference is a column
 * ---------------------------------------------------------------------------
 *
 * The arithmetic this kernel most needs not to get wrong is what one order is
 * worth. A shelf price, the cost of the unit from a supplier, and a payment
 * processor's percentage look alike in a claim sentence and land on opposite
 * sides of the margin. So they are separate findings, a percentage is its own
 * field (`commerce_rate_bps`) rather than a figure somebody has to read as one,
 * and `services/commerce/economics.ts` withholds the margin rather than
 * guessing at a missing line.
 *
 * ---------------------------------------------------------------------------
 * The products are discovered and never declared
 * ---------------------------------------------------------------------------
 *
 * There is no list of products in this repository. A product is on the map
 * because a gated claim named it or a person seeded it — §38's rule that a
 * hardcoded taxonomy answers the question the kernel exists to ask.
 */
import {
  COMMERCE_COST_COMPONENTS,
  COMMERCE_DEMAND_KINDS,
  COMMERCE_FINDINGS,
  COMMERCE_RESTRICTIONS,
  COMMERCE_ROUND_PURPOSES,
  type CommerceCostComponent,
  type CommerceDemandKind,
  type CommerceFinding,
  type CommerceRestriction,
  type CommerceRoundPurpose,
} from './types.ts';

export {
  COMMERCE_COST_COMPONENTS,
  COMMERCE_DEMAND_KINDS,
  COMMERCE_FINDINGS,
  COMMERCE_RESTRICTIONS,
  COMMERCE_ROUND_PURPOSES,
};
export type {
  CommerceCostComponent,
  CommerceDemandKind,
  CommerceFinding,
  CommerceRestriction,
  CommerceRoundPurpose,
};

export function isCommerceFinding(value: unknown): value is CommerceFinding {
  return typeof value === 'string' && (COMMERCE_FINDINGS as readonly string[]).includes(value);
}

export function isCommerceCostComponent(value: unknown): value is CommerceCostComponent {
  return typeof value === 'string' && (COMMERCE_COST_COMPONENTS as readonly string[]).includes(value);
}

export function isCommerceDemandKind(value: unknown): value is CommerceDemandKind {
  return typeof value === 'string' && (COMMERCE_DEMAND_KINDS as readonly string[]).includes(value);
}

export function isCommerceRestriction(value: unknown): value is CommerceRestriction {
  return typeof value === 'string' && (COMMERCE_RESTRICTIONS as readonly string[]).includes(value);
}

export function isCommerceRoundPurpose(value: unknown): value is CommerceRoundPurpose {
  return typeof value === 'string' && (COMMERCE_ROUND_PURPOSES as readonly string[]).includes(value);
}

/**
 * The key two rows naming one product are matched on.
 *
 * Case and whitespace and nothing else — the weakest matcher that could work,
 * for `formatKey`'s reason. It does not know that "LED desk lamp" and "desk
 * lamp, LED" are one thing, and it must not start guessing: an invented match
 * would file one product's supplier cost against another product's retail
 * price, and the margin it produced would be confidently wrong. Products
 * converge instead because every follow-up question names the product
 * **verbatim from Brain's own rows** and asks for it back unchanged.
 */
export function productKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Which closed set a finding's `commerce_value` must come from, or null where
 * the finding carries no value.
 */
export function valueVocabularyFor(finding: CommerceFinding): readonly string[] | null {
  if (finding === 'PRODUCT_DEMAND') return COMMERCE_DEMAND_KINDS;
  if (finding === 'COST_LINE') return COMMERCE_COST_COMPONENTS;
  if (finding === 'RESTRICTION') return COMMERCE_RESTRICTIONS;
  return null;
}

/**
 * Whether a finding is a figure.
 *
 * `COST_LINE` is a figure *or* a percentage and is handled on its own: a
 * payment processor publishes a rate, a carrier publishes an amount, and
 * turning either into the other would need a price nobody declared.
 */
export function findingRequiresAmount(finding: CommerceFinding): boolean {
  return finding === 'RETAIL_PRICE' || finding === 'SUPPLIER_OFFER' || finding === 'COMPETITOR';
}

/** One line per finding, for the tool description that asks a worker to choose. */
export const COMMERCE_FINDING_GUIDE: Readonly<Record<CommerceFinding, string>> = Object.freeze({
  PRODUCT_DEMAND:
    'a specific product visibly selling now — a best-seller rank, a stated order count, an ' +
    'advert that has been running for weeks, a rising search trend, social traction or a burst ' +
    'of recent reviews — dated by the source; commerce_value says which kind of signal',
  RETAIL_PRICE:
    'what a named seller charges a shopper for the product, as published, with its currency',
  SUPPLIER_OFFER:
    'a named supplier or wholesale listing that would ship the product, with its published ' +
    'unit cost, and the delivery days in commerce_days where it states them',
  COST_LINE:
    'one published line of what selling one order costs — shipping to the customer, payment ' +
    'processing, a platform fee, advertising cost per order, a returns allowance or import ' +
    'duty — as an amount, or as a percentage in commerce_rate_bps',
  COMPETITOR:
    'a named seller already selling the product, with its published price',
  CUSTOMER_COMPLAINT:
    'a published complaint theme about the product or products like it — what buyers say is ' +
    'wrong — which is where a better version or a niche comes from',
  NICHE_SIGNAL:
    'a published sub-audience or use case asking for the product — a community, an occasion, ' +
    'a profession or a hobby — named as the source names it',
  RESTRICTION:
    'a published rule bearing on whether the product may be sold or advertised — an advertising ' +
    'policy, a prohibited-item rule, a safety certification, an intellectual-property position, ' +
    'an import rule or a platform rule',
});

export interface CommerceDeclaration {
  finding: CommerceFinding | null;
  product: string | null;
  subject: string | null;
  value: string | null;
  amountCents: number | null;
  rateBps: number | null;
  currency: string | null;
  days: number | null;
}

export type CommerceCheck =
  | { ok: true; value: CommerceDeclaration }
  | { ok: false; error: string };

const ABSENT: CommerceDeclaration = Object.freeze({
  finding: null,
  product: null,
  subject: null,
  value: null,
  amountCents: null,
  rateBps: null,
  currency: null,
  days: null,
});

/** The most delivery days a supplier offer may carry; past it the claim is about something else. */
export const MAX_DELIVERY_DAYS = 120;

/**
 * Validate one claim's commerce declaration.
 *
 * Called by the MCP tool and by the provider-path parser, and by nothing else.
 * Every failure refuses the submission rather than dropping the field, for
 * §27's reason: a silently dropped declaration is the one outcome a worker
 * cannot recover from, because it is delivered as success.
 */
export function validateCommerceFinding(input: {
  where: string;
  finding: unknown;
  product: unknown;
  subject: unknown;
  value: unknown;
  amountCents: unknown;
  rateBps: unknown;
  currency: unknown;
  days: unknown;
}): CommerceCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const product = tidy(input.product);
  const subject = tidy(input.subject);
  const value = tidy(input.value);
  const currencyRaw = tidy(input.currency).toUpperCase();

  if (absent(input.finding)) {
    for (const [name, given] of [
      ['commerce_product', product],
      ['commerce_subject', subject],
      ['commerce_value', value],
      ['commerce_currency', currencyRaw],
    ] as const) {
      if (given) {
        return {
          ok: false,
          error:
            `${where}: ${name} was given with no commerce_finding. Say which kind of fact about ` +
            'the product this establishes, or leave the field out.',
        };
      }
    }
    for (const name of ['amountCents', 'rateBps', 'days'] as const) {
      if (!absent(input[name])) {
        return { ok: false, error: `${where}: a commerce figure was given with no commerce_finding.` };
      }
    }
    return { ok: true, value: ABSENT };
  }

  if (!isCommerceFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: commerce_finding must be one of ${COMMERCE_FINDINGS.join(', ')}, or omitted ` +
        'when the claim says nothing about a product.',
    };
  }
  const finding = input.finding;

  if (!product) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set commerce_product — which product it is about. ` +
        'Where the assignment names a product, copy that string verbatim: a different wording ' +
        'is a different product to Brain and joins with nothing.',
    };
  }
  if (!subject) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set commerce_subject — ` +
        `${COMMERCE_FINDING_GUIDE[finding]}. It is the name of the seller, supplier, platform, ` +
        'community or rule as the source writes it, not a sentence about it.',
    };
  }

  const vocabulary = valueVocabularyFor(finding);
  if (vocabulary) {
    if (!value || !vocabulary.includes(value)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding must set commerce_value to one of ` +
          `${vocabulary.join(', ')}.` +
          (value ? ` "${value}" is not one of them.` : ''),
      };
    }
  } else if (value) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding takes no commerce_value. A field nothing reads looks ` +
        'like it worked, which is worse than refusing it.',
    };
  }

  const whole = (raw: unknown, name: string, min: number, max: number): number | string => {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      return `${where}: ${name} must be a whole number.`;
    }
    if (raw < min || raw > max) return `${where}: ${name} must be between ${min} and ${max}.`;
    return raw;
  };

  let amountCents: number | null = null;
  let rateBps: number | null = null;

  if (finding === 'COST_LINE') {
    const hasAmount = !absent(input.amountCents);
    const hasRate = !absent(input.rateBps);
    if (hasAmount === hasRate) {
      return {
        ok: false,
        error:
          `${where}: a COST_LINE must carry exactly one of commerce_amount_cents (a published ` +
          'amount per order) or commerce_rate_bps (a published percentage, in basis points: 2.9% ' +
          'is 290). Never both, and never neither — a line with no figure makes the economics ' +
          'look complete while contributing nothing.',
      };
    }
    if (hasAmount) {
      const parsed = whole(input.amountCents, 'commerce_amount_cents', 0, 1_000_000_000);
      if (typeof parsed === 'string') return { ok: false, error: parsed };
      amountCents = parsed;
    } else {
      const parsed = whole(input.rateBps, 'commerce_rate_bps', 0, 10_000);
      if (typeof parsed === 'string') return { ok: false, error: parsed };
      rateBps = parsed;
    }
  } else {
    if (!absent(input.rateBps)) {
      return {
        ok: false,
        error: `${where}: only a COST_LINE carries commerce_rate_bps.`,
      };
    }
    if (findingRequiresAmount(finding)) {
      if (absent(input.amountCents)) {
        return {
          ok: false,
          error:
            `${where}: a ${finding} finding must set commerce_amount_cents, the published figure ` +
            'in minor units. A published zero is a figure and is declared as 0.',
        };
      }
      const parsed = whole(input.amountCents, 'commerce_amount_cents', 0, 1_000_000_000);
      if (typeof parsed === 'string') return { ok: false, error: parsed };
      amountCents = parsed;
    } else if (!absent(input.amountCents)) {
      return {
        ok: false,
        error: `${where}: a ${finding} finding carries no figure, so commerce_amount_cents is refused.`,
      };
    }
  }

  let currency: string | null = null;
  if (amountCents !== null) {
    if (!/^[A-Z]{3}$/.test(currencyRaw)) {
      return {
        ok: false,
        error:
          `${where}: a figure must carry commerce_currency, a three-letter ISO 4217 code as ` +
          'published. Brain never converts currencies, so a figure with no currency is one ' +
          'nobody can check.',
      };
    }
    currency = currencyRaw;
  } else if (currencyRaw) {
    return {
      ok: false,
      error: `${where}: commerce_currency describes an amount, and this finding carries none.`,
    };
  }

  let days: number | null = null;
  if (!absent(input.days)) {
    if (finding !== 'SUPPLIER_OFFER') {
      return { ok: false, error: `${where}: only a SUPPLIER_OFFER carries commerce_days.` };
    }
    const parsed = whole(input.days, 'commerce_days', 0, MAX_DELIVERY_DAYS);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    days = parsed;
  }

  return {
    ok: true,
    value: { finding, product, subject, value: value || null, amountCents, rateBps, currency, days },
  };
}
