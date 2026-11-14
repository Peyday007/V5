/**
 * A buyer's acceptance becomes the agreement it evidences (LIFE-29-1).
 *
 * Before this, a BUYER_ACCEPTED (or a BUYER_COUNTERED carrying an amount)
 * observation on a live deal waited for a person to press "agree" and re-type
 * terms Brain already held, so no agreement was recorded and the commitment
 * chain (`deliverables/commitments.ts`) never started.
 *
 * The terms are the offer the observation answers, never composed: the
 * latest contact sent before the answer, and the card's offer only where the
 * card still composes exactly the message every send of that contact carried
 * (its digest on the send intent — the same proof `learning.ts` uses for the
 * offered price). The amount is the offer's price, or the buyer's own figure
 * for a counter. A term the offer does not state, or an offer no row states,
 * raises a need naming it and records nothing.
 *
 * Everything goes through `recordAgreement`, so the agreement and its
 * PIPELINE_AGREED entry are one decision and a second pass is the same
 * request key. It sends nothing.
 */
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, observationsFor } from '../../../repos/cashJourney.ts';
import { getOpportunity, listNeeds, listOpportunities } from '../../../repos/cashPortfolio.ts';
import { agreementAnswering, type CashObservation } from '../../../domain/cashJourney.ts';
import type { CashAction, CashOpportunity } from '../../../domain/types.ts';
import { contactOfferVersions } from '../effects.ts';
import { composeBuyerMessage } from '../outreach.ts';
import { offerVersion } from '../perform.ts';
import { closeNeed, raiseNeed } from '../needs.ts';
import { recordAgreement } from './deal.ts';

const BRAIN = 'BRAIN';
const NEED_PREFIX = 'acceptance-terms:';

export interface AcceptancePass {
  /** Agreements this pass recorded, by observation. */
  agreed: { observationId: string; agreementId: string }[];
  /** Observations whose terms no row states, with the need raised for each. */
  needs: { observationId: string; missing: string }[];
  /** Agreements `recordAgreement` refused, with its reason. Never silent. */
  refused: { observationId: string; reason: string }[];
  needsSettled: string[];
}

export function acceptanceNeedKey(observationId: string): string {
  return `${NEED_PREFIX}${observationId}`;
}

/** Whether this observation is an answer that can carry an agreement. */
export function carriesAgreement(observation: Pick<CashObservation, 'kind' | 'amountCents'>): boolean {
  if (observation.kind === 'BUYER_ACCEPTED') return true;
  return observation.kind === 'BUYER_COUNTERED' && typeof observation.amountCents === 'number' && observation.amountCents > 0;
}

/** The contact an answer answers: the latest one sent at or before it. */
export function contactAnswered(contacts: readonly CashAction[], observedAt: string): CashAction | null {
  let found: CashAction | null = null;
  for (const contact of contacts) if (contact.createdAt <= observedAt) found = contact;
  return found;
}

type Terms =
  | { ok: true; amountCents: number; deliverable: string; acceptanceCondition: string; offer: string }
  | { ok: false; missing: string; why: string };

/** The terms of the offer a contact sent, from the rows, or what no row states. */
async function offerTerms(opportunity: CashOpportunity, contact: CashAction, observation: CashObservation): Promise<Terms> {
  const message = composeBuyerMessage(opportunity);
  if (!message.ok) {
    return { ok: false, missing: message.missing, why: `the card no longer states the offer (${message.reason})` };
  }
  const now = offerVersion(`${message.to}\n${message.subject}\n${message.text}`);
  const occurrence = contact.requestKey?.split(':').at(-1) ?? '';
  const sent = occurrence ? await contactOfferVersions(opportunity.id, occurrence) : [];
  if (sent.length === 0 || !sent.every((one) => one === now)) {
    return {
      ok: false,
      missing: 'the offer that was sent',
      why:
        sent.length === 0
          ? `contact ${contact.id} carries no record of the words that reached the buyer`
          : `the card has changed since contact ${contact.id} was sent, so it is not the offer the buyer answered`,
    };
  }
  const acceptance = opportunity.acceptanceCondition?.trim() ?? '';
  if (!acceptance) {
    return { ok: false, missing: 'acceptanceCondition', why: 'the offer that was sent states no acceptance condition' };
  }
  const amountCents = observation.kind === 'BUYER_COUNTERED' ? observation.amountCents! : opportunity.priceCents!;
  return { ok: true, amountCents, deliverable: opportunity.offerScope!.trim(), acceptanceCondition: acceptance, offer: now };
}

/**
 * Record the agreement each unanswered acceptance or counter on a live deal
 * evidences. Idempotent by row: an observation an agreement already cites,
 * or a contact an agreement already answers, is left alone.
 */
export async function agreeFromAcceptances(projectId: string, currency: string): Promise<AcceptancePass> {
  const pass: AcceptancePass = { agreed: [], needs: [], refused: [], needsSettled: [] };
  const live = await listOpportunities({ projectId, states: ['EXECUTING', 'DELIVERING'] });
  for (const listed of live) {
    const answers = (await observationsFor(listed.id)).filter(carriesAgreement);
    if (answers.length === 0) continue;
    const contacts = (await actionsFor(listed.id)).filter((one) => one.action === 'CONTACT_BUYER');
    for (const observation of answers) {
      const agreements = await agreementsFor(listed.id);
      if (agreements.some((one) => one.observationId === observation.id)) continue;
      const opportunity = (await getOpportunity(listed.id))!;
      const contact = contactAnswered(contacts, observation.observedAt);
      if (contact && agreementAnswering(contact, contacts, agreements, null) !== null) continue;
      const terms: Terms = contact
        ? await offerTerms(opportunity, contact, observation)
        : { ok: false, missing: 'the offer that was sent', why: 'no contact is recorded before this answer' };
      if (!terms.ok) {
        await raiseNeed({
          projectId,
          opportunityId: opportunity.id,
          actorRef: BRAIN,
          blockedAction: `Record the agreement the buyer's ${observation.kind === 'BUYER_COUNTERED' ? 'counter-offer' : 'acceptance'} on "${opportunity.title}" evidences`,
          whyItMatters:
            `The buyer answered (observation ${observation.id}, ${observation.evidenceRef}), and Brain will not ` +
            `write an agreement on terms no row states: ${terms.why}. Missing: ${terms.missing}.`,
          recommendedPath: 'Record the agreement on this piece with the terms the buyer accepted, citing this observation.',
          setupEffort: 'A minute.',
          nextStep: `State ${terms.missing} and record the agreement citing observation ${observation.id}.`,
          completionCondition: `An agreement cites observation ${observation.id}.`,
          requestKey: acceptanceNeedKey(observation.id),
        });
        pass.needs.push({ observationId: observation.id, missing: terms.missing });
        continue;
      }
      const recorded = await recordAgreement({
        opportunityId: opportunity.id,
        amountCents: terms.amountCents,
        currency,
        deliverable: terms.deliverable,
        acceptanceCondition: terms.acceptanceCondition,
        evidenceKind: 'WRITTEN_ACCEPTANCE',
        evidenceRef: observation.evidenceRef,
        observationId: observation.id,
        actorRef: BRAIN,
      });
      if (recorded.ok) pass.agreed.push({ observationId: observation.id, agreementId: recorded.value.id });
      else pass.refused.push({ observationId: observation.id, reason: recorded.reason });
    }
  }

  // Close Brain's own needs once an agreement cites the observation, read from the rows.
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (!need.requestKey?.startsWith(NEED_PREFIX) || !need.opportunityId) continue;
    const observationId = need.requestKey.slice(NEED_PREFIX.length);
    const cited = (await agreementsFor(need.opportunityId)).find((one) => one.observationId === observationId);
    if (!cited) continue;
    const closed = await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: `Agreement ${cited.id} cites observation ${observationId}.`,
      actorUserId: BRAIN,
      verifiedBy: 'BRAIN_READ_THE_ROW',
    });
    if (closed.ok) pass.needsSettled.push(need.id);
  }
  return pass;
}
