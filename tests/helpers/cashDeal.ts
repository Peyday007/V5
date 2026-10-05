/**
 * Walk a piece that is being executed through the parts of the first-dollar
 * journey a test is not about: an agreement with evidence, and work that was
 * performed and accepted by the buyer.
 *
 * Every step goes through the real service, so a test that uses this proves
 * the same guards a person meets. It records no money beyond the agreement's
 * own `PIPELINE_AGREED`; payments and settlements stay the test's to write,
 * because those are what most tests are about.
 */
import {
  acceptDelivery,
  createFulfilment,
  recordAgreement,
  recordObservation,
  recordPerformed,
} from '../../server/services/cash/journey/deal.ts';
import type { CashAgreement } from '../../server/domain/cashJourney.ts';

export async function agree(
  opportunityId: string,
  amountCents: number,
  actorRef: string,
  currency = 'USD',
): Promise<CashAgreement> {
  const agreed = await recordAgreement({
    opportunityId,
    amountCents,
    currency,
    deliverable: 'The work described on the card.',
    acceptanceCondition: 'The buyer confirms in writing that it meets the card.',
    evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `email-${opportunityId}-${amountCents}`,
    actorRef,
  });
  if (!agreed.ok) throw new Error(`agreement refused: ${agreed.reason}`);
  return agreed.value;
}

/** Agree, then create, perform and have the buyer accept the work. */
export async function agreeAndDeliver(
  opportunityId: string,
  amountCents: number,
  actorRef: string,
  currency = 'USD',
): Promise<CashAgreement> {
  const agreement = await agree(opportunityId, amountCents, actorRef, currency);
  const work = await createFulfilment({
    opportunityId,
    agreementId: agreement.id,
    path: 'PERSON',
    workKind: 'EXTERNAL',
    workRef: `the operator's own delivery for ${opportunityId}`,
    actorRef,
  });
  if (!work.ok) throw new Error(`fulfilment refused: ${work.reason}`);
  const done = await recordPerformed({
    fulfilmentId: work.value.id,
    evidence: `delivered file ${opportunityId}.zip`,
    actorRef,
  });
  if (!done.ok) throw new Error(`performed refused: ${done.reason}`);
  const seen = await recordObservation({
    opportunityId,
    kind: 'DELIVERY_ACCEPTED',
    source: 'PERSON',
    evidenceRef: `acceptance-${opportunityId}`,
    actorRef,
  });
  if (!seen.ok) throw new Error(`observation refused: ${seen.reason}`);
  const accepted = await acceptDelivery({
    fulfilmentId: work.value.id,
    observationId: seen.value.id,
    actorRef,
  });
  if (!accepted.ok) throw new Error(`acceptance refused: ${accepted.reason}`);
  return agreement;
}
