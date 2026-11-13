/**
 * A buyer's acceptance becomes the agreement it is, from the terms Brain
 * already holds (LIFE-29-1).
 *
 * Before this, a `BUYER_ACCEPTED` (or a `BUYER_COUNTERED` with an amount)
 * observation on a deal after its first action waited for a person to press
 * "agree" and re-type the deliverable, the acceptance condition and the
 * amount — terms the offer that reached the buyer already stated. Nobody did,
 * so no agreement was ever recorded and the chain of commitments a
 * transaction is (`deliverables/commitments.ts`) never started.
 *
 * The terms are the offer the observation answers: the last contact before it,
 * and the card it was composed from. Where that contact was sent through a
 * provider, its intents carry the digest of the exact words sent, and the card
 * is used only while it still composes those words — a card edited since the
 * send states an offer nobody received. A counter-offer is agreed at the amount
 * the buyer countered, never the card's price. A term the offer did not state
 * is raised as a need naming it, never filled in.
 *
 * Idempotent through `recordAgreement`'s own request key (the terms and the
 * observation id), and through the need's key; no scheduler of its own — the
 * journey tick calls it.
 */
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, observationsFor } from '../../../repos/cashJourney.ts';
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { contactOfferVersions } from '../effects.ts';
import { composeBuyerMessage } from '../outreach.ts';
import { offerVersion } from '../perform.ts';
import { raiseNeed } from '../needs.ts';
import { recordAgreement } from './deal.ts';
import type { CashObservation } from '../../../domain/cashJourney.ts';
import type { CashAction, CashOpportunity } from '../../../domain/types.ts';

const BRAIN = 'BRAIN';
const AFTER_FIRST_ACTION = new Set(['EXECUTING', 'DELIVERING']);

export interface AcceptancePass {
  /** Agreements this pass recorded from an acceptance or a counter. */
  recorded: string[];
  /** Observations whose offer did not state a term, with the terms it lacked. */
  needs: { observationId: string; missing: string[] }[];
  /** Agreements `recordAgreement` refused, with its reason. Never silent. */
  refused: { observationId: string; reason: string }[];
}

/** The terms an offer stated, or the ones it did not. Pure. */
export function offerTerms(input: {
  observation: Pick<CashObservation, 'kind' | 'amountCents'>;
  card: Pick<CashOpportunity, 'offerScope' | 'acceptanceCondition' | 'priceCents' | 'currency'>;
  currency: string;
}):
  | { ok: true; amountCents: number; deliverable: string; acceptanceCondition: string }
  | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const deliverable = input.card.offerScope?.trim() ?? '';
  const acceptanceCondition = input.card.acceptanceCondition?.trim() ?? '';
  if (!deliverable) missing.push('the deliverable (the offer scope)');
  if (!acceptanceCondition) missing.push('the acceptance condition');
  // A counter is agreed at what the buyer countered; an acceptance at what it
  // states, or else at the price the offer named.
  const stated = input.observation.amountCents;
  const amountCents =
    input.observation.kind === 'BUYER_COUNTERED'
      ? stated
      : stated !== null && stated > 0
        ? stated
        : input.card.priceCents;
  if (amountCents === null || !Number.isInteger(amountCents) || amountCents <= 0) missing.push('the amount');
  if (input.card.currency && input.card.currency !== input.currency) {
    missing.push(`the amount in ${input.currency} (the offer is in ${input.card.currency})`);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, amountCents: amountCents as number, deliverable, acceptanceCondition };
}

/** The contact an observation answers: the last one sent at or before it. */
function contactAnswered(contacts: CashAction[], observation: CashObservation): CashAction | null {
  let answered: CashAction | null = null;
  for (const contact of contacts) {
    if (contact.createdAt <= observation.observedAt) answered = contact;
  }
  return answered;
}

/**
 * Whether the card still states the offer this contact carried. A contact
 * with no provider intent was recorded by a person against the card, which is
 * then the only record of its terms; one sent through a provider is held to
 * the digest of the words that went out.
 */
async function cardStatesSentOffer(opportunity: CashOpportunity, contact: CashAction): Promise<boolean> {
  const occurrence = contact.requestKey?.split(':').at(-1) ?? '';
  const sent = occurrence ? await contactOfferVersions(opportunity.id, occurrence) : [];
  if (sent.length === 0) return true;
  const message = composeBuyerMessage(opportunity);
  if (!message.ok) return false;
  const now = offerVersion(`${message.to}\n${message.subject}\n${message.text}`);
  return sent.every((one) => one === now);
}

async function needTerms(opportunity: CashOpportunity, observation: CashObservation, missing: string[]): Promise<void> {
  await raiseNeed({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    actorRef: BRAIN,
    blockedAction: `Record the agreement the buyer's ${observation.kind === 'BUYER_COUNTERED' ? 'counter-offer' : 'acceptance'} makes`,
    whyItMatters:
      `The buyer ${observation.kind === 'BUYER_COUNTERED' ? 'countered' : 'accepted'} (${observation.evidenceRef}), ` +
      `but the offer it answers does not state ${missing.join(', ')}. Brain does not invent a term, so no ` +
      'agreement is recorded and nothing downstream of one — invoicing, delivery, settlement — can start.',
    recommendedPath: `State ${missing.join(', ')} as it was offered, or record the agreement with the terms the buyer accepted.`,
    setupEffort: 'A minute.',
    nextStep: `Fill ${missing.join(', ')} on the card, or record the agreement by hand.`,
    completionCondition: `An agreement on this opportunity stands behind observation ${observation.id}.`,
    requestKey: `agreement-terms:${observation.id}`,
  });
}

/** One opportunity's acceptances and counters, each answered by one agreement. */
export async function agreeFromAcceptances(opportunityId: string, currency: string, pass: AcceptancePass): Promise<void> {
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity || !AFTER_FIRST_ACTION.has(opportunity.state)) return;
  const observations = (await observationsFor(opportunity.id)).filter(
    (one) => one.kind === 'BUYER_ACCEPTED' || (one.kind === 'BUYER_COUNTERED' && one.amountCents !== null && one.amountCents > 0),
  );
  if (observations.length === 0) return;
  const contacts = (await actionsFor(opportunity.id)).filter((one) => one.action === 'CONTACT_BUYER');
  for (const observation of observations) {
    const agreements = await agreementsFor(opportunity.id);
    // Already answered: an agreement drawn from it, or one a person recorded
    // after it (which is the agreement it led to).
    if (agreements.some((one) => one.observationId === observation.id || one.createdAt >= observation.observedAt)) continue;
    // A later acceptance or counter supersedes this one; only the last of a run is agreed.
    if (observations.some((other) => other.observedAt > observation.observedAt)) continue;
    const contact = contactAnswered(contacts, observation);
    if (!contact) {
      pass.needs.push({ observationId: observation.id, missing: ['the offer it answers (no contact precedes it)'] });
      await needTerms(opportunity, observation, ['the offer it answers (no contact precedes it)']);
      continue;
    }
    if (!(await cardStatesSentOffer(opportunity, contact))) {
      const missing = ['the terms that were sent (the card has changed since the offer went out)'];
      pass.needs.push({ observationId: observation.id, missing });
      await needTerms(opportunity, observation, missing);
      continue;
    }
    const terms = offerTerms({ observation, card: opportunity, currency });
    if (!terms.ok) {
      pass.needs.push({ observationId: observation.id, missing: terms.missing });
      await needTerms(opportunity, observation, terms.missing);
      continue;
    }
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
    if (!agreed.ok) pass.refused.push({ observationId: observation.id, reason: agreed.reason });
    else if (agreed.message.startsWith('Agreement recorded')) pass.recorded.push(agreed.value.id);
  }
}
