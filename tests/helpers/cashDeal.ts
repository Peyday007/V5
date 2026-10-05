/**
 * Walk a piece that is being executed through the parts of the post-sale
 * journey a test is not about: an agreement with evidence, and an obligation a
 * person performed, delivered and had accepted.
 *
 * Every step goes through the real service, so a test that uses this proves
 * the same guards a person meets. It records no money beyond the agreement's
 * own `PIPELINE_AGREED`; payments and settlements stay the test's to write,
 * because those are what most tests are about.
 */
import { recordAgreement } from '../../server/services/cash/journey/deal.ts';
import { answerRefund, authorizeRefund, declare, recordEvent } from '../../server/services/cash/journey/fulfillment.ts';
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

/** A person performs the agreement's obligation, delivers all of it, and the buyer accepts. */
export async function fulfil(agreement: CashAgreement, actorRef: string): Promise<void> {
  const steps: [string, () => Promise<{ ok: boolean; reason?: string }>][] = [
    [
      'declaration',
      () =>
        declare({
          projectId: agreement.projectId,
          agreementId: agreement.id,
          kind: 'PERSON',
          performer: 'The operator',
          actorRef,
        }),
    ],
    ['work complete', () => event(agreement, 'WORK_COMPLETE', `work file ${agreement.id}`, actorRef)],
    ['delivery', () => event(agreement, 'DELIVERED', `delivered file ${agreement.id}.zip`, actorRef)],
    ['acceptance', () => event(agreement, 'ACCEPTED', `acceptance-${agreement.id}`, actorRef)],
  ];
  for (const [name, step] of steps) {
    const done = await step();
    if (!done.ok) throw new Error(`${name} refused: ${done.reason}`);
  }
}

function event(agreement: CashAgreement, kind: string, evidenceRef: string, actorRef: string) {
  return recordEvent({
    projectId: agreement.projectId,
    agreementId: agreement.id,
    kind,
    detail: `${kind.toLowerCase()} for ${agreement.deliverable}`,
    evidenceRef,
    actorRef,
  });
}

/** Agree, then have a person perform, deliver and the buyer accept the work. */
export async function agreeAndDeliver(
  opportunityId: string,
  amountCents: number,
  actorRef: string,
  currency = 'USD',
): Promise<CashAgreement> {
  const agreement = await agree(opportunityId, amountCents, actorRef, currency);
  await fulfil(agreement, actorRef);
  return agreement;
}

/**
 * Refund through the agreement's obligation — the only refund path on an
 * agreed deal — and confirm it with the provider's reference, as a person who
 * paid it out would.
 */
export async function refundConfirmed(
  agreement: CashAgreement,
  amountCents: number,
  reference: string,
  actorRef: string,
): Promise<void> {
  const authorized = await authorizeRefund({
    projectId: agreement.projectId,
    agreementId: agreement.id,
    amountCents,
    reason: `refund ${reference}`,
    actorRef,
  });
  if (!authorized.ok) throw new Error(`refund refused: ${authorized.reason}`);
  const pending = authorized.value.refunds.find((one) => one.state === 'PENDING');
  if (!pending) return;
  const answered = await answerRefund({
    projectId: agreement.projectId,
    agreementId: agreement.id,
    refundKey: pending.refundKey,
    answer: 'confirm',
    reference,
    actorRef,
  });
  if (!answered.ok) throw new Error(`refund confirmation refused: ${answered.reason}`);
}
