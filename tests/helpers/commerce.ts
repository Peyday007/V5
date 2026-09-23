/**
 * Walk one opportunity through the commercial journey the way a person would:
 * an offer prepared and sent, the buyer's agreement, production, a checked
 * delivery, the buyer's acceptance, an invoice, and the provider's payment and
 * settlement. Every step goes through the real service, so a test using this
 * cannot reach COLLECTED by any path production could not.
 */
import { expect } from 'vitest';
import {
  deliver,
  prepareOffer,
  recordObligationAnswer,
  sendOffer,
  startProduction,
} from '../../server/services/cash/commerce/obligation.ts';
import { issueInvoice, recordInvoiceState } from '../../server/services/cash/commerce/payment.ts';
import type { CashInvoice, CashObligation } from '../../server/domain/commerce.ts';

export async function walkToCollected(input: {
  projectId: string;
  opportunityId: string;
  userId: string;
  priceCents?: number;
  settledCents?: number;
  stopAt?: 'DELIVERING' | 'PAID';
}): Promise<{ obligation: CashObligation; invoice: CashInvoice | null }> {
  const price = input.priceCents ?? 75_000;
  const prepared = await prepareOffer({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    ownerUserId: input.userId,
    actorRef: input.userId,
    terms: {
      buyer: 'The owner, who signs',
      scope: 'One fixed-scope intake repair; excludes redesign',
      priceCents: price,
      acceptanceConditions: ['Form submits and a test enquiry arrives'],
      deliveryPlan: 'One afternoon of configuration by the operator',
      deliveryRoute: 'HUMAN',
    },
  });
  if (!prepared.ok) throw new Error(prepared.reason);
  const id = prepared.value.id;
  const base = { obligationId: id, projectId: input.projectId, actorRef: input.userId };
  const sent = await sendOffer({ ...base, reference: 'mail:offer-1' });
  if (!sent.ok) throw new Error(sent.reason);
  const agreed = await recordObligationAnswer({
    ...base,
    kind: 'AGREED_TO_BUY',
    channel: 'email',
    reference: 'mail:reply-1',
    excerpt: 'Yes, go ahead at that price.',
  });
  if (!agreed.ok) throw new Error(agreed.reason);
  const producing = await startProduction({ ...base, productionReference: 'operator: Sam, Thursday' });
  if (!producing.ok) throw new Error(producing.reason);
  if (input.stopAt === 'DELIVERING') return { obligation: producing.value, invoice: null };
  const delivered = await deliver({
    ...base,
    deliverableReference: 'mail:handover-1',
    checks: [{ condition: 'Form submits and a test enquiry arrives', met: true, evidence: 'enquiry #88 received' }],
  });
  if (!delivered.ok) throw new Error(delivered.reason);
  const accepted = await recordObligationAnswer({
    ...base,
    kind: 'ACCEPTED_DELIVERY',
    channel: 'email',
    reference: 'mail:reply-2',
    excerpt: 'Works, thank you.',
  });
  if (!accepted.ok) throw new Error(accepted.reason);
  const issued = await issueInvoice({ ...base, amountCents: price, provider: 'stripe', providerReference: `in_${id}` });
  if (!issued.ok) throw new Error(issued.reason);
  const paid = await recordInvoiceState({ invoiceId: issued.value.id, projectId: input.projectId, to: 'PAID', reference: 'ch_1', actorRef: input.userId });
  if (!paid.ok) throw new Error(paid.reason);
  if (input.stopAt === 'PAID') return { obligation: accepted.value, invoice: paid.value };
  const settled = await recordInvoiceState({
    invoiceId: issued.value.id,
    projectId: input.projectId,
    to: 'SETTLED',
    reference: 'po_1',
    settledAmountCents: input.settledCents ?? price,
    actorRef: input.userId,
  });
  expect(settled.ok).toBe(true);
  return { obligation: accepted.value, invoice: settled.ok ? settled.value : null };
}
