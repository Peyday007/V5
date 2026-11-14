/**
 * A buyer's acceptance of a sent offer becomes the agreement it is (LIFE-29-1).
 *
 * Before this, a `BUYER_ACCEPTED` (or a `BUYER_COUNTERED` carrying an amount)
 * waited for a person to press "agree" and re-type terms Brain already held —
 * so on production no agreement was ever recorded and the commitment chain an
 * agreement starts never began.
 *
 * The terms are the offer the observation answers, never the card as it reads
 * today: they are taken only when the card still composes exactly the message
 * every send of that contact carried (the digest on its intents, as
 * `learning.ts` reads the offered price), so the card's offer scope, price and
 * acceptance condition provably are the words that reached the buyer. A term
 * the sent offer did not state, or an offer no row records, raises a need that
 * names it; nothing is invented. A counter-offer is agreed at the countered
 * amount and nothing else.
 *
 * Idempotent by rows: an observation already answered by an agreement (its own,
 * or one recorded against the same contact) is skipped, and `recordAgreement`'s
 * request key makes one set of terms one agreement and one `PIPELINE_AGREED`.
 * It runs on the journey tick and adds no scheduler.
 *
 * An acceptance a person typed in by hand (`source = PERSON`) is left to that
 * person: they are already at the deal, the "agree" they record next carries
 * the terms they settled, and an agreement written by the tick between their
 * two presses would stand beside theirs as a second commitment for one yes.
 * What reaches Brain with nobody at the deal — a provider's stated answer, an
 * answer Brain read itself — is what used to wait forever, and is agreed here.
 */
import type { CashAction, CashOpportunity } from '../../../domain/types.ts';
import { agreementAnswering, type CashAgreement, type CashObservation } from '../../../domain/cashJourney.ts';
import { actionsFor } from '../../../repos/cashActions.ts';
import { agreementsFor, observationsFor } from '../../../repos/cashJourney.ts';
import { openNeedForKey } from '../../../repos/cashPortfolio.ts';
import { contactOfferVersions } from '../effects.ts';
import { composeBuyerMessage } from '../outreach.ts';
import { offerVersion } from '../perform.ts';
import { closeNeed, raiseNeed } from '../needs.ts';
import { recordAgreement } from './deal.ts';

const BRAIN = 'BRAIN';
const AGREEABLE = new Set(['BUYER_ACCEPTED', 'BUYER_COUNTERED']);

export interface AcceptancePass {
  /** Agreements this pass recorded, by observation. */
  agreed: { observationId: string; agreementId: string }[];
  /** Needs raised because the sent offer did not state a term, by observation. */
  needs: { observationId: string; missing: string }[];
}

/** The key of the need raised when an acceptance cannot become an agreement. */
export function acceptanceNeedKey(observationId: string): string {
  return `acceptance-terms:${observationId}`;
}

/** The terms an acceptance agrees to, or the term the sent offer did not state. Pure. */
export function termsAccepted(input: {
  observation: Pick<CashObservation, 'kind' | 'amountCents' | 'currency'>;
  opportunity: Pick<CashOpportunity, 'offerScope' | 'priceCents' | 'acceptanceCondition'>;
  /** True when the card provably composes the offer that was sent. */
  offerIsSent: boolean;
  currency: string;
}):
  | { ok: true; amountCents: number; deliverable: string; acceptanceCondition: string }
  | { ok: false; missing: string } {
  const { observation, opportunity } = input;
  if (!input.offerIsSent) return { ok: false, missing: 'the offer as sent (no row records the words that reached the buyer)' };
  const deliverable = opportunity.offerScope?.trim() ?? '';
  if (!deliverable) return { ok: false, missing: 'the deliverable' };
  const acceptanceCondition = opportunity.acceptanceCondition?.trim() ?? '';
  if (!acceptanceCondition) return { ok: false, missing: 'the acceptance condition' };
  if (observation.kind === 'BUYER_COUNTERED') {
    if (!observation.amountCents || observation.amountCents <= 0) return { ok: false, missing: 'the countered amount' };
    if (observation.currency && observation.currency !== input.currency) {
      return { ok: false, missing: `the countered amount in ${input.currency} (the buyer stated ${observation.currency})` };
    }
    return { ok: true, amountCents: observation.amountCents, deliverable, acceptanceCondition };
  }
  if (!opportunity.priceCents || opportunity.priceCents <= 0) return { ok: false, missing: 'the amount' };
  return { ok: true, amountCents: opportunity.priceCents, deliverable, acceptanceCondition };
}

/** The contact an observation answers: the latest one made at or before it. */
function contactAnswered(observation: CashObservation, contacts: readonly CashAction[]): CashAction | null {
  const at = observation.observedAt > observation.createdAt ? observation.observedAt : observation.createdAt;
  let found: CashAction | null = null;
  for (const contact of contacts) if (contact.createdAt <= at) found = contact;
  return found;
}

/** Whether every send of this contact carried exactly the offer the card composes now. */
async function sentOfferIsCard(opportunity: CashOpportunity, contact: CashAction): Promise<boolean> {
  const occurrence = contact.requestKey?.split(':').at(-1) ?? '';
  if (!occurrence) return false;
  const sent = await contactOfferVersions(opportunity.id, occurrence);
  if (sent.length === 0) return false;
  const message = composeBuyerMessage(opportunity);
  if (!message.ok) return false;
  const now = offerVersion(`${message.to}\n${message.subject}\n${message.text}`);
  return sent.every((one) => one === now);
}

/**
 * For each contact on this deal, the latest acceptance or counter answering it
 * — unless the buyer declined after it, or an agreement already answers the
 * contact — is recorded as the agreement on the sent offer's terms.
 */
export async function agreeAcceptances(
  opportunity: CashOpportunity,
  currency: string,
): Promise<AcceptancePass> {
  const pass: AcceptancePass = { agreed: [], needs: [] };
  if (opportunity.state !== 'EXECUTING' && opportunity.state !== 'DELIVERING') return pass;
  const contacts = (await actionsFor(opportunity.id)).filter((one) => one.action === 'CONTACT_BUYER');
  if (contacts.length === 0) return pass;
  const observed = await observationsFor(opportunity.id);
  const answers = observed.filter((one) => AGREEABLE.has(one.kind) && one.source !== 'PERSON');
  if (answers.length === 0) return pass;
  let agreements: CashAgreement[] = await agreementsFor(opportunity.id);

  const latestByContact = new Map<string, { contact: CashAction; observation: CashObservation }>();
  for (const observation of answers) {
    const contact = contactAnswered(observation, contacts);
    if (!contact) continue;
    const held = latestByContact.get(contact.id);
    if (!held || held.observation.observedAt <= observation.observedAt) latestByContact.set(contact.id, { contact, observation });
  }

  for (const { contact, observation } of latestByContact.values()) {
    const key = acceptanceNeedKey(observation.id);
    const answered =
      agreements.some((one) => one.observationId === observation.id) ||
      agreementAnswering(contact, contacts, agreements, null) !== null;
    const declinedAfter = observed.some(
      (one) => one.kind === 'BUYER_DECLINED' && one.observedAt > observation.observedAt,
    );
    if (answered || declinedAfter) {
      await settleNeed(opportunity.projectId, key, answered ? 'An agreement answers this acceptance.' : 'The buyer declined after accepting.');
      continue;
    }
    const terms = termsAccepted({
      observation,
      opportunity,
      offerIsSent: await sentOfferIsCard(opportunity, contact),
      currency,
    });
    if (!terms.ok) {
      await raiseNeed({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: 'Record the agreement the buyer accepted',
        whyItMatters:
          `The buyer ${observation.kind === 'BUYER_COUNTERED' ? 'countered' : 'accepted'} (${observation.evidenceRef}), ` +
          `but the offer they answered does not state ${terms.missing}. Brain does not invent a term the buyer never saw.`,
        recommendedPath: 'Record the agreement with the terms the buyer actually accepted.',
        setupEffort: 'A minute.',
        nextStep: `Record the agreement on this piece, citing observation ${observation.id}.`,
        completionCondition: `An agreement on this piece answers observation ${observation.id}.`,
        requestKey: key,
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
      evidenceRef: `observation ${observation.id}: ${observation.evidenceRef}`,
      observationId: observation.id,
      actorRef: BRAIN,
    });
    if (!recorded.ok) {
      await raiseNeed({
        projectId: opportunity.projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: 'Record the agreement the buyer accepted',
        whyItMatters: `The buyer accepted (${observation.evidenceRef}) and the agreement was refused: ${recorded.reason}`,
        recommendedPath: 'Resolve what the refusal names; the next tick records the agreement.',
        setupEffort: 'Depends on the refusal.',
        nextStep: recorded.reason,
        completionCondition: `An agreement on this piece answers observation ${observation.id}.`,
        requestKey: key,
      });
      pass.needs.push({ observationId: observation.id, missing: recorded.reason });
      continue;
    }
    agreements = await agreementsFor(opportunity.id);
    pass.agreed.push({ observationId: observation.id, agreementId: recorded.value.id });
    await settleNeed(opportunity.projectId, key, `Agreement ${recorded.value.id} answers this acceptance.`);
  }
  return pass;
}

async function settleNeed(projectId: string, key: string, resolution: string): Promise<void> {
  const open = await openNeedForKey(projectId, key);
  if (!open) return;
  await closeNeed({ needId: open.id, to: 'RESOLVED', resolution, actorUserId: BRAIN, verifiedBy: 'BRAIN_READ_THE_ROW' });
}
