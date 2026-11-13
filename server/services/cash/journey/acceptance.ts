/**
 * A buyer's acceptance becomes the agreement it is, from the terms of the
 * offer it answers (LIFE-29-1).
 *
 * A `BUYER_ACCEPTED` observation — or a `BUYER_COUNTERED` one carrying an
 * amount — that Brain read on a deal after its first action used to wait for a person to press
 * "agree" and re-type a deliverable, an acceptance condition and an amount the
 * sent offer already stated. Nobody did, so no agreement was recorded and the
 * chain of commitments a transaction is (`deliverables/commitments.ts`) never
 * started. The journey tick now answers each such observation once, through
 * the existing `recordAgreement` and nothing beside it.
 *
 * Where the terms come from, and where they do not:
 *
 *   * The offer an observation answers is the last contact made at or before
 *     it. Only a contact Brain sent has its offer on a row: the intent written
 *     before the send carries the digest (`offerVersion`) of the exact words
 *     that went out. The card's offer scope, price and acceptance condition are
 *     the agreement's terms only while composing the card's message
 *     (`composeBuyerMessage`) still reproduces that digest — then the card
 *     states, word for word, what the buyer received.
 *   * A contact recorded by hand carries no offer on any row, and a card edited
 *     since the send states an offer nobody received. Either is a need naming
 *     the missing term, never a guess (invariant 39).
 *   * An acceptance is agreed at the offer's price. An acceptance that states a
 *     different amount is not an acceptance of that offer, so it is a need. A
 *     counter is agreed at the amount countered, and only that amount.
 *   * An offer that did not state its acceptance condition is a need naming it.
 *
 * Only an answer Brain read itself — a provider's reply status (`PROVIDER`) or
 * Brain's own reading (`BRAIN`) — is agreed here. An acceptance a person
 * recorded by hand stays theirs to agree: they are already in the loop, may
 * have settled terms the observation does not carry, and an invoice stays
 * refused until they record the agreement they made.
 *
 * An observation is answered once: by an agreement drawn from it, or by any
 * agreement recorded after the contact it answers (a person's own). Of several
 * acceptances or counters to one contact, only the latest is agreed. The write
 * is idempotent through `recordAgreement`'s request key (terms and evidence),
 * the need through its own key, and a need is resolved from the row once an
 * agreement stands behind its observation. There is no scheduler here: the
 * journey tick calls it.
 */
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, observationsFor } from '../../../repos/cashJourney.ts';
import { getOpportunity, openNeedForKey } from '../../../repos/cashPortfolio.ts';
import { contactOfferVersions } from '../effects.ts';
import { composeBuyerMessage } from '../outreach.ts';
import { offerVersion } from '../perform.ts';
import { closeNeed, raiseNeed } from '../needs.ts';
import { recordAgreement } from './deal.ts';
import type { CashAgreement, CashObservation } from '../../../domain/cashJourney.ts';
import type { CashAction, CashOpportunity } from '../../../domain/types.ts';

const BRAIN = 'BRAIN';
const AFTER_FIRST_ACTION: ReadonlySet<string> = new Set(['EXECUTING', 'DELIVERING']);

export interface AcceptancePass {
  /** Agreements this pass recorded from an acceptance or a counter. */
  recorded: string[];
  /** Observations whose offer does not state a term, with the terms it lacks. */
  needs: { observationId: string; missing: string[] }[];
  /** Agreements `recordAgreement` refused, with its reason. Never silent. */
  refused: { observationId: string; reason: string }[];
}

export function emptyAcceptancePass(): AcceptancePass {
  return { recorded: [], needs: [], refused: [] };
}

export type OfferTerms =
  | { ok: true; amountCents: number; deliverable: string; acceptanceCondition: string }
  | { ok: false; missing: string[] };

/**
 * The agreement an observation makes of an offer, or the terms the offer does
 * not state. Pure: `offer` is the card only once the caller has established
 * that the card states the sent offer.
 */
export function offerTerms(input: {
  observation: Pick<CashObservation, 'kind' | 'amountCents' | 'currency'>;
  offer: Pick<CashOpportunity, 'offerScope' | 'acceptanceCondition' | 'priceCents' | 'currency'>;
  currency: string;
}): OfferTerms {
  const { observation, offer, currency } = input;
  const missing: string[] = [];
  const deliverable = offer.offerScope?.trim() ?? '';
  const acceptanceCondition = offer.acceptanceCondition?.trim() ?? '';
  if (!deliverable) missing.push('the deliverable (the offer stated no scope)');
  if (!acceptanceCondition) missing.push('the acceptance condition (the offer stated none)');
  if (offer.currency && offer.currency !== currency) missing.push(`the amount in ${currency} (the offer was in ${offer.currency})`);
  const price = offer.priceCents !== null && Number.isInteger(offer.priceCents) && offer.priceCents > 0 ? offer.priceCents : null;
  const stated = observation.amountCents !== null && observation.amountCents > 0 ? observation.amountCents : null;
  if (stated !== null && observation.currency && observation.currency !== currency) {
    missing.push(`the amount in ${currency} (the buyer stated ${observation.currency})`);
  }
  let amountCents: number | null;
  if (observation.kind === 'BUYER_COUNTERED') {
    amountCents = stated;
    if (amountCents === null) missing.push('the amount (the counter-offer stated none)');
  } else {
    amountCents = price;
    if (price === null) missing.push('the amount (the offer stated no price)');
    else if (stated !== null && stated !== price) {
      missing.push(`the amount (the buyer accepted ${stated} cents; the offer stated ${price})`);
      amountCents = null;
    }
  }
  if (missing.length > 0 || amountCents === null) return { ok: false, missing };
  return { ok: true, amountCents, deliverable, acceptanceCondition };
}

/** The contact an observation answers: the last one made at or before it. */
export function contactAnswered(contacts: readonly CashAction[], observation: Pick<CashObservation, 'observedAt'>): CashAction | null {
  let answered: CashAction | null = null;
  for (const contact of contacts) if (contact.createdAt <= observation.observedAt) answered = contact;
  return answered;
}

/**
 * Whether the card states, word for word, the offer this contact sent. Null
 * when it does; otherwise the term that is not on any row.
 */
async function sentOfferOnCard(opportunity: CashOpportunity, contact: CashAction): Promise<string | null> {
  const prefix = `action:${opportunity.id}:CONTACT_BUYER:`;
  const occurrence = contact.requestKey.startsWith(prefix) ? contact.requestKey.slice(prefix.length) : '';
  const sent = occurrence ? (await contactOfferVersions(opportunity.id, occurrence)).filter((v): v is string => v !== null) : [];
  if (sent.length === 0) return 'the terms the contact carried (it was not sent by Brain, so no row holds the offer the buyer received)';
  const message = composeBuyerMessage(opportunity);
  const now = message.ok ? offerVersion(`${message.to}\n${message.subject}\n${message.text}`) : null;
  if (now === null || !sent.includes(now)) return 'the terms that were sent (the card has changed since the offer went out)';
  return null;
}

function termsNeedKey(observationId: string): string {
  return `agreement-terms:${observationId}`;
}

async function needTerms(opportunity: CashOpportunity, observation: CashObservation, missing: string[], pass: AcceptancePass): Promise<void> {
  pass.needs.push({ observationId: observation.id, missing });
  const what = observation.kind === 'BUYER_COUNTERED' ? 'counter-offer' : 'acceptance';
  await raiseNeed({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    actorRef: BRAIN,
    blockedAction: `Record the agreement the buyer's ${what} makes`,
    whyItMatters:
      `The buyer's ${what} (${observation.evidenceRef}) answers an offer that does not state ${missing.join('; ')}. ` +
      'Brain does not invent a term, so no agreement is recorded and nothing that follows one — invoicing, ' +
      'delivery, settlement — can start.',
    recommendedPath: `Record the agreement with the terms the buyer actually accepted: ${missing.join('; ')}.`,
    setupEffort: 'A minute.',
    nextStep: 'Record the agreement on this opportunity, citing the observation.',
    completionCondition: `An agreement on this opportunity stands behind observation ${observation.id}.`,
    requestKey: termsNeedKey(observation.id),
  });
}

/** A need raised for an observation is settled once an agreement stands behind it. */
async function settleTermsNeed(opportunity: CashOpportunity, observation: CashObservation, agreement: CashAgreement): Promise<void> {
  const open = await openNeedForKey(opportunity.projectId, termsNeedKey(observation.id));
  if (!open) return;
  await closeNeed({
    needId: open.id,
    to: 'RESOLVED',
    resolution: `Agreement ${agreement.id} stands behind observation ${observation.id}.`,
    actorUserId: BRAIN,
    verifiedBy: 'BRAIN_READ_THE_ROW',
  });
}

/** Each acceptance or counter on one opportunity, answered by exactly one agreement or a need. */
export async function agreeFromAcceptances(opportunityId: string, currency: string, pass: AcceptancePass): Promise<void> {
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity || !AFTER_FIRST_ACTION.has(opportunity.state)) return;
  const observations = (await observationsFor(opportunity.id)).filter(
    (one) => one.kind === 'BUYER_ACCEPTED' || one.kind === 'BUYER_COUNTERED',
  );
  if (observations.length === 0) return;
  const contacts = (await actionsFor(opportunity.id))
    .filter((one) => one.action === 'CONTACT_BUYER')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const observation of observations) {
    const agreements = await agreementsFor(opportunity.id);
    const drawn = agreements.find((one) => one.observationId === observation.id);
    if (drawn) { await settleTermsNeed(opportunity, observation, drawn); continue; }
    const contact = contactAnswered(contacts, observation);
    // Answered already: an agreement a person recorded after the contact this observation answers.
    if (contact && agreements.some((one) => one.createdAt >= contact.createdAt)) continue;
    // Of several answers to one contact, only the latest is the buyer's word.
    if (observations.some((other) => other.id !== observation.id && other.observedAt > observation.observedAt
      && contactAnswered(contacts, other)?.id === contact?.id)) continue;
    // A person who recorded the buyer's answer by hand is in the loop and records the agreement they made.
    if (observation.source === 'PERSON') continue;
    if (!contact) {
      await needTerms(opportunity, observation, ['the offer it answers (no contact precedes it)'], pass);
      continue;
    }
    const unsent = await sentOfferOnCard(opportunity, contact);
    if (unsent) { await needTerms(opportunity, observation, [unsent], pass); continue; }
    const terms = offerTerms({ observation, offer: opportunity, currency });
    if (!terms.ok) { await needTerms(opportunity, observation, terms.missing, pass); continue; }
    const agreed = await recordAgreement({
      opportunityId: opportunity.id,
      amountCents: terms.amountCents,
      currency,
      deliverable: terms.deliverable,
      acceptanceCondition: terms.acceptanceCondition,
      evidenceKind: 'WRITTEN_ACCEPTANCE',
      evidenceRef: `observation ${observation.id}: ${observation.evidenceRef}`,
      observationId: observation.id,
      actorRef: BRAIN,
    });
    if (!agreed.ok) { pass.refused.push({ observationId: observation.id, reason: agreed.reason }); continue; }
    pass.recorded.push(agreed.value.id);
    await settleTermsNeed(opportunity, observation, agreed.value);
  }
}
