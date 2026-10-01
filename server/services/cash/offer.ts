/**
 * The offer a person could actually send, composed from the card and nothing else.
 *
 * A piece reaches READY when its card answers what a bounded test turns on, and
 * `execution.ts`' first step then says *"Write the offer as one page"*. Nothing
 * wrote it. The answers were all on the page — the scope and its edges, the
 * acceptance condition, the price, the delivery path, who fulfils it, the payer
 * and the channel that reaches them — scattered across a card, an engine card
 * and a provenance list, so the last step before a first commercial attempt was
 * a person re-assembling Brain's own rows into a message by hand, and copying
 * one of them wrong.
 *
 * Three rules, each the one this file could most easily have broken.
 *
 * **It composes; it never writes a term.** Every line is a recorded value
 * quoted verbatim — a column, or the recorded fact behind it — with its label
 * and nothing in between. There is no greeting, no persuasion and no sentence
 * Brain made up for the occasion, because an offer that reads better than its
 * card is an offer whose extra words nobody checked, and the buyer cannot tell
 * which ones those were.
 *
 * **A blank refuses the whole draft.** Where a load-bearing field is empty the
 * answer is the named list of what is missing and **no text at all** — not a
 * draft with a placeholder, because a placeholder is the one thing that gets
 * sent by accident. §30's rule that an unknown is never a favourable
 * assumption, at the field a buyer reads.
 *
 * **It computes nothing.** The price is the card's own integer, formatted;
 * there is no total, no discount, no deposit and no date arithmetic, because a
 * figure derived here would be a figure no card ever held.
 *
 * Derived on the read path and stored nowhere, for `execution.ts`' reason. It
 * sends nothing and authorizes nothing: contacting a buyer is still a
 * `COMMERCIAL_ACTION`, refused without a live grant and recorded only as a
 * `cash_actions` row. And it is the owner's alone — every line is a private
 * commercial term (§34), so it is built into the FULL view and the shared
 * projection, which names its columns, has no way to reach it.
 */
import type { CashCardFact, CashOpportunity } from '../../domain/types.ts';

/** The states an offer is drafted for: ready to test, or already being pursued. */
export const OFFER_STATES = ['READY', 'EXECUTING'] as const;

/**
 * Where a line's value came from.
 *
 * The three fact kinds are `CashCardFact['kind']` verbatim. `RECORDED` is a
 * column with no fact behind it — typed in by a person, or carried at
 * promotion — and is named apart so the draft never claims a source it does
 * not have.
 */
export type OfferLineSource = CashCardFact['kind'] | 'RECORDED';

export interface OfferLine {
  /** The card field key, so a reader can find the answer on the card. */
  key: string;
  label: string;
  /** Verbatim from the card. Never composed. */
  value: string;
  source: OfferLineSource;
  claimId: string | null;
}

export interface OfferGap {
  key: string;
  label: string;
}

export interface OfferDraft {
  opportunityId: string;
  /** True only when every required line is answered. */
  sendable: boolean;
  /** Who it would go to and how — the two lines a sender acts on rather than sends. */
  recipient: { payer: OfferLine; channel: OfferLine } | null;
  /** What the buyer reads, in order. Empty when the draft is refused. */
  lines: OfferLine[];
  /** Required and unanswered. Non-empty means there is no text. */
  missing: OfferGap[];
  /** Optional and unanswered: said, and blocking nothing. */
  unstated: OfferGap[];
  /** The copyable message, or null when anything required is missing. */
  text: string | null;
}

interface Slot {
  key: string;
  label: string;
  value: (o: CashOpportunity) => string | null;
  required: boolean;
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** `card.ts`' formatting, so the draft and the card print one figure the same way. */
function money(cents: number | null, currency: string): string | null {
  if (cents === null) return null;
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/*
 * The keys are the card's own (`card.ts`, `answers.ts`' COLUMN map), so a gap
 * here names the same field the card shows blank. Timing and payment terms are
 * optional because the card does not require them for READY; requiring them
 * here would make a READY piece unsendable for a reason its card never stated.
 */
const RECIPIENT: Slot[] = [
  { key: 'payer', label: 'Payer', value: (o) => text(o.payer), required: true },
  { key: 'access', label: 'Contact channel', value: (o) => text(o.reachableChannel), required: true },
];

const BODY: Slot[] = [
  { key: 'offer', label: 'Offer', value: (o) => text(o.offerScope), required: true },
  {
    key: 'acceptance',
    label: 'Accepted when',
    value: (o) => text(o.acceptanceCondition),
    required: true,
  },
  { key: 'price', label: 'Price', value: (o) => money(o.priceCents, o.currency), required: true },
  { key: 'paymentTerms', label: 'Payment terms', value: (o) => text(o.paymentTerms), required: false },
  { key: 'delivery', label: 'Delivery', value: (o) => text(o.deliveryMethod), required: true },
  {
    key: 'fulfillment',
    label: 'Fulfilled by',
    value: (o) => text(o.fulfillmentOwner),
    required: true,
  },
  { key: 'cashDates', label: 'Timing', value: (o) => text(o.deadline), required: false },
];

/** The newest fact per field: the one `mayReplace` let stand. */
function latestFacts(facts: CashCardFact[]): Map<string, CashCardFact> {
  const out = new Map<string, CashCardFact>();
  for (const fact of facts) {
    const seen = out.get(fact.field);
    if (!seen || fact.updatedAt > seen.updatedAt) out.set(fact.field, fact);
  }
  return out;
}

export function composeOffer(input: {
  opportunity: CashOpportunity;
  facts: CashCardFact[];
}): OfferDraft {
  const { opportunity } = input;
  const facts = latestFacts(input.facts.filter((f) => f.opportunityId === opportunity.id));
  const missing: OfferGap[] = [];
  const unstated: OfferGap[] = [];

  const read = (slot: Slot): OfferLine | null => {
    const value = slot.value(opportunity);
    if (value === null) {
      (slot.required ? missing : unstated).push({ key: slot.key, label: slot.label });
      return null;
    }
    const fact = facts.get(slot.key);
    /*
     * A fact names the source only while it still describes the column. A
     * person who later typed a different value is the column's author now, and
     * crediting the old fact's claim would cite a source for words it never
     * said.
     */
    const describes =
      fact !== undefined &&
      (slot.key === 'price'
        ? // A price fact is a sentence and the column is an integer; it describes
          // the column only while it still states that figure.
          opportunity.priceCents !== null &&
          fact.value.includes((opportunity.priceCents / 100).toLocaleString('en-US'))
        : fact.value.trim() === value);
    return {
      key: slot.key,
      label: slot.label,
      value,
      source: describes ? fact.kind : 'RECORDED',
      claimId: describes ? fact.claimId : null,
    };
  };

  const payer = read(RECIPIENT[0]!);
  const channel = read(RECIPIENT[1]!);
  const body = BODY.map(read).filter((line): line is OfferLine => line !== null);
  const sendable = missing.length === 0;

  return {
    opportunityId: opportunity.id,
    sendable,
    recipient: payer && channel ? { payer, channel } : null,
    lines: sendable ? body : [],
    missing,
    unstated,
    text: sendable
      ? [
          `To: ${payer!.value}`,
          `Via: ${channel!.value}`,
          `Re: ${opportunity.title}`,
          '',
          ...body.map((line) => `${line.label}: ${line.value}`),
        ].join('\n')
      : null,
  };
}
