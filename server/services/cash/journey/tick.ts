/**
 * The journey, advanced from rows on the durable tick.
 *
 * Everything a deal can do by itself after its first real action is here, and
 * every step is derived from what the rows already say rather than hooked to
 * the moment something changed — which is what reaches a process that died
 * between a receipt and its record, a restart mid-journey, and the deals
 * already stranded. Each step is idempotent by a row, never by a flag:
 *
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
 *   8. what the deal taught is recorded as outcomes (`learning.ts`).
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
import { ensureAgreementLedger } from './deal.ts';
import { agreementAnswering } from '../../../domain/cashJourney.ts';
import { advanceFulfillment, moveToDelivering, type FulfillmentPass } from './fulfillment.ts';
import { collectable, dealPosition } from './position.ts';
import { recordOutcomes } from './learning.ts';

const BRAIN = 'BRAIN';

/** How long a contact may go unanswered before its silence is recorded. */
export const RESPONSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface JourneyTickReport {
  ledgerChecked: number;
  /** Agreements whose ledger entry could not be written, with why. Never silent. */
  ledgerRefused: { agreementId: string; reason: string }[];
  fulfillment: FulfillmentPass;
  silences: number;
  delivering: number;
  collected: number;
  outcomes: number;
}

export async function advanceJourney(
  projectId: string,
  now: Date = new Date(),
): Promise<JourneyTickReport> {
  const report: JourneyTickReport = {
    ledgerChecked: 0,
    ledgerRefused: [],
    fulfillment: { workCreated: [], needsRaised: [], needsSettled: [], refundsSettled: [] },
    silences: 0,
    delivering: 0,
    collected: 0,
    outcomes: 0,
  };
  const mode = await getCashMode(projectId);
  if (!mode) return report;

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
  }
  return report;
}
