/**
 * The journey, advanced from rows on the durable tick.
 *
 * Everything a deal can do by itself after its first real action is here, and
 * every step is derived from what the rows already say rather than hooked to
 * the moment something changed — which is what reaches a process that died
 * between a receipt and its record, a restart mid-journey, and the deals
 * already stranded. Each step is idempotent by a row, never by a flag:
 *
 *   0. a buyer's acceptance (or counter-offer) of an offer Brain sent becomes an
 *      agreement on that offer's own terms — the card's, only while the card
 *      still composes the exact words every send of that contact carried — and
 *      a term the sent offer did not state is a need, never a guess (LIFE-29-1);
 *   1. an agreement's ledger entries exist (and its release, if released);
 *   2. (invoices are issued and read back by `invoicing.ts`, just before this);
 *   3. each agreement's obligation advances (`fulfillment.ts`): its work is
 *      created once per attempt, a refund is taken as far as Brain can, and
 *      the needs it raises are settled from rows;
 *   4. (delivery and acceptance are recorded against the obligation, never
 *      inferred here);
 *   5. a contact with no reply inside the window is recorded as BUYER_SILENT;
 *   6. (an unpaid invoice past its due date is reported, never rewritten);
 *   7. EXECUTING → DELIVERING once something agreed was delivered,
 *      DELIVERING → COLLECTED once `collectable` holds;
 *   8. what the deal taught is recorded as outcomes (`learning.ts`);
 *   9. an exception its commitments show — a missed date, a failed payment, a rejected
 *      delivery, a released commitment — is detected, its consequence quantified and its
 *      remedy worked out inside the authority held, and recorded once
 *      (`deliverables/exceptions.ts`); a refund that would remedy it is asked
 *      for as a person's approval, and a sourced case is traced as a rehearsal
 *      whenever it changed. Nothing is carried out here;
 *  10. the deal's realization is read from its rows — delivery steps derived from
 *      the agreed scope, delivery and acceptance evidence, open redo obligations,
 *      the accounting result — and recorded when it changed, with each repeat-
 *      business signal the rows show (`deliverables/realization.ts`).
 *
 * It sends nothing. Every external effect is still a person's press or a
 * granted tick through `perform.ts`, and nothing here calls an adapter.
 */
import { getOpportunity, transitionOpportunity, listOpportunities } from '../../../repos/cashPortfolio.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { actionsFor } from '../../../repos/cashActions.ts';
import {
  agreementsFor,
  agreementsInProject,
  insertObservation,
  observationsFor,
  opportunitiesInJourney,
} from '../../../repos/cashJourney.ts';
import { ensureAgreementLedger, recordAgreement } from './deal.ts';
import { raiseNeed } from '../needs.ts';
import { contactOfferVersions } from '../effects.ts';
import { composeBuyerMessage } from '../outreach.ts';
import { offerVersion } from '../perform.ts';
import type { CashAction, CashOpportunity } from '../../../domain/types.ts';
import type { CashObservation } from '../../../domain/cashJourney.ts';
import { agreementAnswering } from '../../../domain/cashJourney.ts';
import { advanceFulfillment, moveToDelivering, type FulfillmentPass } from './fulfillment.ts';
import { collectable, dealPosition } from './position.ts';
import { recordOutcomes } from './learning.ts';
import { recordDetectedExceptions, rehearseCaseOnTick } from '../deliverables/exceptions.ts';
import { recordRealization } from '../deliverables/realization.ts';
import { recordRowDependencies } from '../deliverables/commitments.ts';

const BRAIN = 'BRAIN';

/** How long a contact may go unanswered before its silence is recorded. */
export const RESPONSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface JourneyTickReport {
  /**
   * Acceptances answered this pass: agreements recorded from them, needs raised
   * for terms the sent offer did not state, and agreements refused, with why.
   */
  acceptances: { agreed: number; needs: number; refused: { observationId: string; reason: string }[] };
  ledgerChecked: number;
  /** Agreements whose ledger entry could not be written, with why. Never silent. */
  ledgerRefused: { agreementId: string; reason: string }[];
  fulfillment: FulfillmentPass;
  silences: number;
  delivering: number;
  collected: number;
  outcomes: number;
  /** Exceptions the commitment rows show, and the new ones recorded this pass. */
  exceptions: { detected: number; recorded: number; rehearsed: number };
  /** Realization readings recorded this pass, and repeat-business signals newly on record. */
  realization: { recorded: number; aftercare: number };
}

export async function advanceJourney(
  projectId: string,
  now: Date = new Date(),
): Promise<JourneyTickReport> {
  const report: JourneyTickReport = {
    acceptances: { agreed: 0, needs: 0, refused: [] },
    ledgerChecked: 0,
    ledgerRefused: [],
    fulfillment: { workCreated: [], needsRaised: [], needsSettled: [], refundsSettled: [] },
    silences: 0,
    delivering: 0,
    collected: 0,
    outcomes: 0,
    exceptions: { detected: 0, recorded: 0, rehearsed: 0 },
    realization: { recorded: 0, aftercare: 0 },
  };
  const mode = await getCashMode(projectId);
  if (!mode) return report;

  // 0. An acceptance of a sent offer is an agreement on that offer's terms.
  report.acceptances = await agreeFromAcceptances(projectId);

  // 1. The ledger counts every agreement exactly once, and every release.
  for (const agreement of await agreementsInProject(projectId)) {
    const counted = await ensureAgreementLedger(agreement);
    if (!counted.ok) report.ledgerRefused.push({ agreementId: agreement.id, reason: counted.reason });
    report.ledgerChecked += 1;
  }

  // 3. Each agreement's obligation: work created once, refunds taken as far as
  // Brain can, needs raised and settled (`fulfillment.ts`).
  report.fulfillment = await advanceFulfillment(projectId);

  // Bounded to the pieces a journey can be on: live ones, plus ended ones that
  // have journey rows to learn from. A portfolio of a hundred signals costs
  // this tick nothing.
  const live = await listOpportunities({ projectId, states: ['READY', 'EXECUTING', 'DELIVERING'] });
  const inJourney = new Set(await opportunitiesInJourney(projectId));
  const ended = (await listOpportunities({ projectId, states: ['COLLECTED', 'DECLINED', 'ARCHIVED'] })).filter(
    (one) => inJourney.has(one.id),
  );
  for (const listed of live) {
    // 5. Silence, derived once per contact, never inferred at read time.
    {
      const contacts = (await actionsFor(listed.id)).filter((one) => one.action === 'CONTACT_BUYER');
      const observed = await observationsFor(listed.id);
      const agreements = await agreementsFor(listed.id);
      for (const contact of contacts) {
        // The agreement that answers this contact answers it, observation or not.
        const answered = agreementAnswering(contact, contacts, agreements, null) !== null || observed.some(
          (one) => one.kind !== 'BUYER_SILENT' && one.kind.startsWith('BUYER_') && one.observedAt >= contact.createdAt,
        ) || observed.some((one) => one.kind === 'CONTACT_UNDELIVERABLE' && one.observedAt >= contact.createdAt);
        const age = now.getTime() - new Date(contact.createdAt).getTime();
        if (!answered && age >= RESPONSE_WINDOW_MS) {
          const written = await insertObservation({
            projectId,
            opportunityId: listed.id,
            kind: 'BUYER_SILENT',
            source: 'BRAIN',
            channel: listed.reachableChannel,
            evidenceRef: `contact ${contact.id} (${contact.reference ?? 'no reference'}) unanswered after ${Math.round(RESPONSE_WINDOW_MS / 86_400_000)} days`,
            observedAt: now.toISOString(),
            recordedBy: BRAIN,
            requestKey: `silent:${contact.id}`,
          });
          if (written.created) report.silences += 1;
        }
      }
    }
  }

  // 7 and 8. The state follows the rows, and what happened is learned.
  for (const listed of [...live, ...ended]) {
    if (listed.state === 'EXECUTING' && (await moveToDelivering(listed.id, BRAIN))) {
      report.delivering += 1;
    }
    const opportunity = (await getOpportunity(listed.id))!;
    if (opportunity.state === 'DELIVERING') {
      const position = await dealPosition({ opportunity, currency: mode.currency });
      if (collectable(position).ok) {
        const moved = await transitionOpportunity({
          id: opportunity.id,
          from: ['DELIVERING'],
          to: 'COLLECTED',
          outcome: 'Paid, settled and accepted.',
        });
        if (moved) {
          report.collected += 1;
          await recordCashEvent({
            projectId,
            opportunityId: opportunity.id,
            kind: 'CASH_COLLECTED',
            actorRef: BRAIN,
            summary: 'The money is in and the delivery is done.',
            detail: { contributionCents: position.pnl.contributionCents },
          });
        }
      }
    }
    report.outcomes += await recordOutcomes((await getOpportunity(listed.id))!, mode.currency);
    if ((await agreementsFor(listed.id)).length > 0) {
      // Brain records the external dependencies the rows imply, once each time they change (LIFE-29-1).
      await recordRowDependencies({ projectId, opportunityId: listed.id, currency: mode.currency });
      const found = await recordDetectedExceptions({ projectId, opportunityId: listed.id, currency: mode.currency, now: now.toISOString() });
      report.exceptions.detected += found.detected;
      report.exceptions.recorded += found.recorded;
      const rehearsed = await rehearseCaseOnTick({ projectId, opportunityId: listed.id, currency: mode.currency, now: now.toISOString() });
      if (rehearsed.rehearsed) report.exceptions.rehearsed += 1;
      const realized = await recordRealization({ projectId, opportunityId: listed.id, currency: mode.currency });
      if (realized.recorded) report.realization.recorded += 1;
      report.realization.aftercare += realized.aftercare;
    }
  }
  return report;
}

/* ------------------------------------------------------------------------- */
/* Acceptance → agreement                                                     */
/* ------------------------------------------------------------------------- */

type SentTerms =
  | { ok: true; deliverable: string; acceptanceCondition: string; priceCents: number; version: string }
  | { ok: false; missing: string[]; why: string };

/**
 * The terms of the offer one contact carried, read from rows.
 *
 * The card states them only while it still composes exactly the message every
 * send of that contact was made with (the digest on each intent, as
 * `learning.ts` reads the offered price): a contact recorded by hand, sent
 * before intents carried the message, or whose card has changed since, offered
 * terms no row states, and they are named rather than assumed.
 */
async function sentOfferTerms(opportunity: CashOpportunity, contact: CashAction): Promise<SentTerms> {
  const occurrence = contact.requestKey?.split(':').at(-1) ?? '';
  const sent = occurrence ? await contactOfferVersions(opportunity.id, occurrence) : [];
  if (sent.length === 0) {
    return {
      ok: false,
      missing: ['the amount', 'the deliverable', 'the acceptance condition'],
      why: 'Brain did not send this offer, so the words that reached the buyer are on no row',
    };
  }
  const message = composeBuyerMessage(opportunity);
  const now = message.ok ? offerVersion(`${message.to}\n${message.subject}\n${message.text}`) : null;
  if (!now || !sent.every((one) => one === now)) {
    return {
      ok: false,
      missing: ['the amount', 'the deliverable', 'the acceptance condition'],
      why: 'the card has changed since the offer was sent, so its terms today are not provably the terms the buyer accepted',
    };
  }
  const deliverable = (opportunity.offerScope ?? '').trim();
  const acceptanceCondition = (opportunity.acceptanceCondition ?? '').trim();
  const priceCents = opportunity.priceCents ?? 0;
  const missing = [
    ...(priceCents > 0 ? [] : ['the amount']),
    ...(deliverable ? [] : ['the deliverable']),
    ...(acceptanceCondition ? [] : ['the acceptance condition']),
  ];
  if (missing.length > 0) return { ok: false, missing, why: 'the offer as sent did not state it' };
  return { ok: true, deliverable, acceptanceCondition, priceCents, version: now };
}

/** The contact an observation answers: the latest one made at or before it. */
function contactAnswered(observation: CashObservation, contacts: CashAction[]): CashAction | null {
  let found: CashAction | null = null;
  for (const contact of contacts) if (contact.createdAt <= observation.observedAt) found = contact;
  return found;
}

/**
 * Every acceptance or counter-offer on a piece being pursued that no agreement
 * answers yet becomes one, through `recordAgreement` and nothing beside it —
 * its request key makes a second tick the same agreement, and its
 * `PIPELINE_AGREED` entry is written in the same transaction. A counter agrees
 * the countered amount, never the offered one. Nothing is sent.
 */
async function agreeFromAcceptances(projectId: string): Promise<JourneyTickReport['acceptances']> {
  const out: JourneyTickReport['acceptances'] = { agreed: 0, needs: 0, refused: [] };
  for (const opportunity of await listOpportunities({ projectId, states: ['EXECUTING', 'DELIVERING'] })) {
    const answers = (await observationsFor(opportunity.id)).filter(
      (one) => one.kind === 'BUYER_ACCEPTED' || (one.kind === 'BUYER_COUNTERED' && (one.amountCents ?? 0) > 0),
    );
    if (answers.length === 0) continue;
    const contacts = (await actionsFor(opportunity.id)).filter((one) => one.action === 'CONTACT_BUYER');
    let agreements = await agreementsFor(opportunity.id);
    for (const observation of answers) {
      if (agreements.some((one) => one.observationId === observation.id)) continue;
      const contact = contactAnswered(observation, contacts);
      if (!contact) continue; // an acceptance before any offer answers nothing Brain sent
      // Somebody already recorded the agreement this offer led to.
      if (agreementAnswering(contact, contacts, agreements, null) !== null) continue;
      const terms = await sentOfferTerms(opportunity, contact);
      if (!terms.ok) {
        const raised = await raiseNeed({
          projectId,
          opportunityId: opportunity.id,
          actorRef: BRAIN,
          blockedAction: `Record the agreement the buyer's ${observation.kind === 'BUYER_COUNTERED' ? 'counter-offer' : 'acceptance'} (${observation.evidenceRef}) answers`,
          whyItMatters:
            `The buyer said yes, and Brain cannot state ${terms.missing.join(', ')}: ${terms.why}. ` +
            'Until an agreement is recorded no commitment, invoice or delivery follows from it.',
          recommendedPath: 'Record the agreement with the terms the buyer accepted, citing the message that carried them.',
          setupEffort: 'A few minutes.',
          nextStep: `State ${terms.missing.join(', ')} as the buyer accepted them and record the agreement against observation ${observation.id}.`,
          completionCondition: `An agreement on this piece names observation ${observation.id}.`,
          requestKey: `agreement-terms:${observation.id}`,
        });
        if (raised.ok) out.needs += 1;
        else out.refused.push({ observationId: observation.id, reason: raised.reason });
        continue;
      }
      const agreed = await recordAgreement({
        opportunityId: opportunity.id,
        amountCents: observation.kind === 'BUYER_COUNTERED' ? observation.amountCents! : terms.priceCents,
        currency: opportunity.currency,
        deliverable: terms.deliverable,
        acceptanceCondition: terms.acceptanceCondition,
        evidenceKind: 'WRITTEN_ACCEPTANCE',
        evidenceRef: `${observation.evidenceRef} (observation ${observation.id}; offer ${terms.version})`,
        observationId: observation.id,
        actorRef: BRAIN,
      });
      if (!agreed.ok) {
        out.refused.push({ observationId: observation.id, reason: agreed.reason });
        continue;
      }
      if (!agreements.some((one) => one.id === agreed.value.id)) out.agreed += 1;
      agreements = await agreementsFor(opportunity.id);
    }
  }
  return out;
}
