/**
 * The message Brain sends a buyer, composed from the card — and the refusal
 * when the card cannot support one.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is invented
 * ---------------------------------------------------------------------------
 *
 * The recipient is read out of `reachableChannel`, which is the channel the
 * buyer themselves published and which the evidence card records. It must name
 * **exactly one** email address: none means Brain has no address to write to,
 * and two means Brain would be choosing between them, and choosing is
 * guessing. Either is a refusal naming what is missing, never a fallback.
 *
 * The body is the offer on the card — its title, scope, price and acceptance
 * condition — in a fixed, plain template. No model writes it and no adjective
 * is added to it, because a sentence Brain composed about value it has not
 * established is the invented claim the evidence gate exists to refuse, and
 * here it would be sent to a stranger under the owner's name. Every message
 * ends with a plain way to say no, and the sender's `List-Unsubscribe` header
 * carries the same.
 */
import type { CashOpportunity } from '../../domain/types.ts';
import { ADDRESS } from './providers/config.ts';

export type BuyerMessage =
  | { ok: true; to: string; subject: string; text: string }
  | { ok: false; reason: string; missing: string };

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The single address a published channel names, or why there is not one. */
export function recipientFromChannel(
  channel: string | null,
): { ok: true; to: string } | { ok: false; reason: string } {
  if (!channel || channel.trim() === '') {
    return { ok: false, reason: 'the card records no channel the buyer published' };
  }
  const found = [...new Set((channel.match(EMAIL_IN_TEXT) ?? []).map((one) => one.toLowerCase()))];
  if (found.length === 0) {
    return { ok: false, reason: 'the channel the buyer published names no email address' };
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason: `the channel the buyer published names ${found.length} email addresses, and choosing one would be a guess`,
    };
  }
  const to = found[0]!;
  return ADDRESS.test(to) ? { ok: true, to } : { ok: false, reason: 'the published address is not one Brain can send to' };
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function composeBuyerMessage(opportunity: CashOpportunity): BuyerMessage {
  const recipient = recipientFromChannel(opportunity.reachableChannel);
  if (!recipient.ok) return { ok: false, reason: recipient.reason, missing: 'reachableChannel' };
  if (!opportunity.offerScope || opportunity.offerScope.trim() === '') {
    return { ok: false, reason: 'the card states no offer to make', missing: 'offerScope' };
  }
  if (opportunity.priceCents === null || opportunity.priceCents <= 0) {
    return { ok: false, reason: 'the card states no price to offer', missing: 'priceCents' };
  }

  const lines = [
    opportunity.payer ? `Hello ${opportunity.payer},` : 'Hello,',
    '',
    `We saw your published request: "${opportunity.title}".`,
    '',
    `What we can do: ${opportunity.offerScope.trim()}`,
    `Price: ${money(opportunity.priceCents, opportunity.currency)}`,
  ];
  if (opportunity.acceptanceCondition) lines.push(`It is done when: ${opportunity.acceptanceCondition.trim()}`);
  if (opportunity.deliveryMethod) lines.push(`How it is delivered: ${opportunity.deliveryMethod.trim()}`);
  if (opportunity.paymentTerms) lines.push(`Payment terms: ${opportunity.paymentTerms.trim()}`);
  lines.push(
    '',
    'If this is useful, reply to this email and we will confirm the details before any work begins.',
    '',
    'If you would rather not hear from us, reply "no thanks" and we will not write again.',
  );

  const subject = `Re: ${opportunity.title}`.slice(0, 200);
  return { ok: true, to: recipient.to, subject, text: lines.join('\n') };
}
