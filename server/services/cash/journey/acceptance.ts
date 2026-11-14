/**
 * A buyer's acceptance of an offer Brain sent is the agreement it evidences
 * (LIFE-29-1).
 *
 * Before this, a BUYER_ACCEPTED (or a BUYER_COUNTERED carrying an amount)
 * waited for a person to press "agree" and re-type terms Brain already held,
 * so no agreement was ever recorded and the commitment chain a transaction is
 * read as never started. The tick now answers each such observation itself,
 * through the existing `recordAgreement` and nothing beside it.
 *
 * The terms are the offer's, read from the rows exactly as `learning.ts` reads
 * the offered price: the card's offer, price and acceptance condition count as
 * what was sent only when the card still composes the very message every send
 * of the contact carried (the digest on its intent). Where that cannot be
 * shown — a contact recorded by hand, a card changed since the send, an offer
 * that stated no acceptance condition — a need names the missing term and no
 * agreement is written. A term is never invented.
 *
 * Idempotent by rows: an observation already answered by an agreement (its
 * own, or one a person recorded for the same contact) is skipped, and
 * `recordAgreement`'s request key makes a repeat a no-op. It sends nothing.
 */
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, observationsFor } from '../../../repos/cashJourney.ts';
import { listOpportunities } from '../../../repos/cashPortfolio.ts';
import { agreementAnswering, type CashObservation } from '../../../domain/cashJourney.ts';
import type { CashAction, CashOpportunity } from '../../../domain/types.ts';
import { contactOfferVersions } from '../effects.ts';
import { composeBuyerMessage } from '../outreach.ts';
import { offerVersion } from '../perform.ts';
import { raiseNeed } from '../needs.ts';
import { recordAgreement } from './deal.ts';

const BRAIN = 'BRAIN';
const ANSWERS = new Set(['BUYER_ACCEPTED', 'BUYER_COUNTERED']);

export interface AcceptancePass {
  /** Agreements written this pass, with the observation each answers. */
  agreed: { observationId: string; agreementId: string }[];
  /** Observations whose offer does not state a term, and which terms. */
  needs: { observationId: string; missing: string[] }[];
  /** recordAgreement refused, with its reason. Never silent. */
  refused: { observationId: string; reason: string }[];
}

export interface OfferTerms {
  amountCents: number;
  deliverable: string;
  acceptanceCondition: string;
}

/**
 * The terms of the offer a contact sent, as far as the rows prove them, or the
 * terms they do not state. Pure apart from reading the contact's intents.
 */
export async function sentOfferTerms(
  opportunity: CashOpportunity,
  contact: CashAction,
): Promise<{ ok: true; terms: OfferTerms } | { ok: false; missing: string[] }> {
  const occurrence = contact.requestKey?.split(':').at(-1) ?? '';
  const sent = occurrence ? await contactOfferVersions(opportunity.id, occurrence) : [];
  if (sent.length === 0) {
    return { ok: false, missing: ['the offer as sent (this contact was not sent by Brain, so no row records its words)'] };
  }
  const message = composeBuyerMessage(opportunity);
  const now = message.ok ? offerVersion(`${message.to}\n${message.subject}\n${message.text}`) : null;
  if (!now || !sent.every((one) => one === now)) {
    return { ok: false, missing: ['the offer as sent (the card no longer composes the message that reached the buyer)'] };
  }
  const missing: string[] = [];
  const deliverable = opportunity.offerScope?.trim() ?? '';
  const acceptanceCondition = opportunity.acceptanceCondition?.trim() ?? '';
  const amountCents = opportunity.priceCents ?? 0;
  if (!deliverable) missing.push('the deliverable');
  if (!acceptanceCondition) missing.push('the acceptance condition');
  if (!Number.isInteger(amountCents) || amountCents <= 0) missing.push('the price');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, terms: { amountCents, deliverable, acceptanceCondition } };
}

/** The contact an observation answers: the latest one sent at or before it. */
function contactAnswered(observation: CashObservation, contacts: CashAction[]): CashAction | null {
  let found: CashAction | null = null;
  for (const contact of contacts) if (contact.createdAt <= observation.observedAt) found = contact;
  return found;
}

export async function agreeAcceptedOffers(projectId: string, currency: string): Promise<AcceptancePass> {
  const pass: AcceptancePass = { agreed: [], needs: [], refused: [] };
  for (const opportunity of await listOpportunities({ projectId, states: ['EXECUTING', 'DELIVERING'] })) {
    const answers = (await observationsFor(opportunity.id))
      .filter((one) => ANSWERS.has(one.kind) && (one.kind !== 'BUYER_COUNTERED' || (one.amountCents ?? 0) > 0))
      .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
    if (answers.length === 0) continue;
    const contacts = (await actionsFor(opportunity.id))
      .filter((one) => one.action === 'CONTACT_BUYER')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    // One agreement per offer: the buyer's latest answer to each contact.
    const latest = new Map<string, { observation: CashObservation; contact: CashAction | null }>();
    for (const observation of answers) {
      const contact = contactAnswered(observation, contacts);
      latest.set(contact?.id ?? `none:${observation.id}`, { observation, contact });
    }
    for (const { observation, contact } of latest.values()) {
      const agreements = await agreementsFor(opportunity.id);
      if (agreements.some((one) => one.observationId === observation.id)) continue;
      if (contact && agreementAnswering(contact, contacts, agreements, null) !== null) continue;
      if (!contact && agreements.some((one) => one.createdAt >= observation.createdAt)) continue;

      const read = contact
        ? await sentOfferTerms(opportunity, contact)
        : { ok: false as const, missing: ['the offer it answers (no contact precedes it)'] };
      if (!read.ok) {
        await raiseNeed({
          projectId,
          opportunityId: opportunity.id,
          actorRef: BRAIN,
          blockedAction: `Record the agreement the buyer's ${observation.kind === 'BUYER_COUNTERED' ? 'counter-offer' : 'acceptance'} makes on "${opportunity.title}"`,
          whyItMatters:
            `The buyer answered (${observation.evidenceRef}), and the offer it answers does not state ` +
            `${read.missing.join(', ')} on any row. Brain does not invent a term, so no agreement is recorded ` +
            'and the commitments it would start do not exist yet.',
          recommendedPath: 'Record the agreement on this piece with the terms the buyer agreed to, citing the observation.',
          setupEffort: 'A minute.',
          nextStep: `State ${read.missing.join(', ')} and record the agreement against observation ${observation.id}.`,
          completionCondition: `An agreement on this piece answers observation ${observation.id}.`,
          requestKey: `acceptance-terms:${observation.id}`,
        });
        pass.needs.push({ observationId: observation.id, missing: read.missing });
        continue;
      }
      const amountCents = observation.kind === 'BUYER_COUNTERED' ? observation.amountCents! : read.terms.amountCents;
      const agreed = await recordAgreement({
        opportunityId: opportunity.id,
        amountCents,
        currency,
        deliverable: read.terms.deliverable,
        acceptanceCondition: read.terms.acceptanceCondition,
        evidenceKind: 'WRITTEN_ACCEPTANCE',
        evidenceRef: `observation ${observation.id}: ${observation.evidenceRef}`,
        observationId: observation.id,
        actorRef: BRAIN,
      });
      if (agreed.ok) pass.agreed.push({ observationId: observation.id, agreementId: agreed.value.id });
      else pass.refused.push({ observationId: observation.id, reason: agreed.reason });
    }
  }
  return pass;
}
