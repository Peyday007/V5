/**
 * One deal's first-dollar journey, as its owner reads it: where it is, what
 * its money did, what happens next and who does it — and the few controls that
 * are genuinely a person's.
 *
 * Every figure and every "next" is the server's (`services/cash/journey/`);
 * nothing is totalled or decided here. The controls are only the facts a
 * person holds and Brain cannot: what the buyer said, what was agreed and the
 * evidence for it, which work delivers it, that work done outside Brain was
 * performed, and that the buyer accepted it. There is deliberately no control
 * that marks Brain's own work performed, and none that writes "delivered" or
 * "collected": those follow from rows.
 */
import { useState } from 'react';
import { CashApi } from '../lib/cashApi.ts';
import type { DealView, JourneyView } from '../../../server/services/cash/journey/view.ts';

const STAGE_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  CONTACTED: 'Buyer reached',
  RESPONDED: 'Buyer answered',
  AGREED: 'Agreed',
  INVOICED: 'Invoiced',
  PAID: 'Paid',
  FULFILLING: 'Being delivered',
  DELIVERED: 'Delivered and accepted',
  SETTLED: 'Paid, settled and delivered',
  COMPLETE: 'Complete',
  ENDED_WITHOUT_SALE: 'Ended without a sale',
};

const PAYMENT_LABEL: Record<string, string> = {
  NOTHING_OWED: 'Nothing owed',
  NOT_INVOICED: 'Agreed, not invoiced',
  OUTSTANDING: 'Invoiced, unpaid',
  PAYMENT_PENDING: 'Payment in flight',
  PARTIALLY_PAID: 'Partly paid',
  PAID_UNSETTLED: 'Paid, not yet settled — not cash',
  SETTLED: 'Paid and settled',
};

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cents(typed: string): number | null {
  const cleaned = typed.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function JourneyTotals({ journey, currency }: { journey: JourneyView; currency: string }): JSX.Element {
  const t = journey.totals;
  return (
    <p className="rs-item-meta rs-cash-journey-totals">
      Agreed {money(t.agreedRevenueCents, currency)} · invoiced {money(t.invoicedCents, currency)} · paid{' '}
      {money(t.customerPaymentsCents, currency)} · settled {money(t.settledCashCents, currency)} · owed to you{' '}
      {money(t.owedByBuyersCents, currency)} · contribution {money(t.contributionCents, currency)}
      {t.unsettledCents > 0 ? ` (${money(t.unsettledCents, currency)} paid and not yet settled is not cash)` : ''}
    </p>
  );
}

type Form = null | 'observe' | 'agree' | 'invoice' | 'fulfil' | 'performed' | 'accept' | 'release';

export function DealJourney({
  deal,
  currency,
  projectId,
  mayAct,
  onChanged,
}: {
  deal: DealView;
  currency: string;
  /** Needed only to request an invoice, which is a project-scoped route. */
  projectId?: string;
  mayAct: boolean;
  onChanged(): void;
}): JSX.Element {
  const [form, setForm] = useState<Form>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const p = deal.pnl;
  const set = (key: string) => (event: { target: { value: string } }) =>
    setFields((before) => ({ ...before, [key]: event.target.value }));
  const live = deal.agreements.filter((one) => one.state === 'AGREED');
  const open = deal.fulfilments.filter((one) => one.state === 'CREATED' || one.state === 'PERFORMED');
  const acceptance = [...deal.observations].reverse().find((one) => one.kind === 'DELIVERY_ACCEPTED');

  async function submit(action: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const result =
        action === 'invoice'
          ? await CashApi.requestInvoice(projectId!, deal.opportunityId, body)
          : await CashApi.act(deal.opportunityId, action, body);
      setDone(result.message);
      setForm(null);
      setFields({});
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const field = (key: string, label: string) => (
    <>
      <label className="rs-field-label" htmlFor={`journey-${deal.opportunityId}-${key}`}>
        {label}
      </label>
      <input id={`journey-${deal.opportunityId}-${key}`} value={fields[key] ?? ''} onChange={set(key)} />
    </>
  );

  return (
    <div className="rs-cash-journey" aria-label={`Journey for ${deal.title}`}>
      <p className="rs-badge">{STAGE_LABEL[deal.stage] ?? deal.stage}</p>
      <p className="rs-item-meta">
        {PAYMENT_LABEL[deal.paymentState] ?? deal.paymentState}. Agreed {money(p.agreedRevenueCents, currency)}, invoiced{' '}
        {money(p.invoicedCents, currency)}, paid {money(p.customerPaymentsCents - p.refundsCents, currency)}, settled{' '}
        {money(p.settledCashCents, currency)}; costs {money(p.incrementalCostsCents + p.unpaidCommitmentsCents, currency)};
        contribution {money(p.contributionCents, currency)}.
      </p>
      {p.unbackedAgreedCents > 0 ? (
        <p className="rs-state rs-state-warn">
          {money(p.unbackedAgreedCents, currency)} is recorded as agreed with no agreement behind it, so it is never
          invoiced. Record the agreement below.
        </p>
      ) : null}
      <ul className="rs-list rs-cash-journey-next">
        {deal.next.map((one) => (
          <li key={one.step}>
            <strong>{one.owner === 'BRAIN' ? 'Brain' : one.owner === 'BUYER' ? 'The buyer' : 'You'}:</strong> {one.step}{' '}
            <span className="rs-item-meta">{one.why}</span>
          </li>
        ))}
      </ul>
      {deal.invoices.length > 0 ? (
        <p className="rs-item-meta">
          Invoices:{' '}
          {deal.invoices.map((one) => `${one.providerNumber ?? one.providerInvoiceId ?? 'draft'} ${money(one.amountCents, currency)} (${one.state.toLowerCase()}${one.state === 'ISSUED' ? `, due ${one.dueDate}` : ''})`).join('; ')}
        </p>
      ) : null}
      {deal.fulfilments.length > 0 ? (
        <p className="rs-item-meta">
          Work: {deal.fulfilments.map((one) => `${one.path.toLowerCase().replace(/_/g, ' ')} — ${one.state.toLowerCase()}`).join('; ')}
        </p>
      ) : null}
      {done ? <p className="rs-state rs-state-ok">{done}</p> : null}
      {mayAct ? (
        form === null ? (
          <div className="rs-cash-journey-actions">
            <button type="button" className="rs-button-quiet" onClick={() => setForm('observe')}>
              Record what the buyer said
            </button>
            <button type="button" className="rs-button-quiet" onClick={() => setForm('agree')}>
              Record the agreement
            </button>
            {deal.pnl.invoiceableCents > 0 && projectId ? (
              <button type="button" className="rs-button-quiet" onClick={() => setForm('invoice')}>
                Request the invoice
              </button>
            ) : null}
            {live.length > 0 ? (
              <button type="button" className="rs-button-quiet" onClick={() => setForm('fulfil')}>
                Create the fulfilment
              </button>
            ) : null}
            {open.some((one) => one.state === 'CREATED' && (one.workKind === 'EXTERNAL' || one.workKind === 'CASH_JOB' || one.workKind === 'COMMITMENT')) ? (
              <button type="button" className="rs-button-quiet" onClick={() => setForm('performed')}>
                Record the work was performed
              </button>
            ) : null}
            {open.some((one) => one.state === 'PERFORMED') && acceptance ? (
              <button type="button" className="rs-button-quiet" onClick={() => setForm('accept')}>
                Apply the buyer’s acceptance
              </button>
            ) : null}
            {live.length > 0 ? (
              <button type="button" className="rs-linklike" onClick={() => setForm('release')}>
                Release an agreement
              </button>
            ) : null}
          </div>
        ) : (
          <div className="rs-cash-journey-form">
            {form === 'observe' ? (
              <>
                <label className="rs-field-label" htmlFor={`journey-${deal.opportunityId}-kind`}>
                  What happened
                </label>
                <select id={`journey-${deal.opportunityId}-kind`} value={fields.kind ?? ''} onChange={set('kind')}>
                  <option value="">Choose…</option>
                  <option value="BUYER_REPLIED">The buyer replied</option>
                  <option value="BUYER_ACCEPTED">The buyer accepted the offer</option>
                  <option value="BUYER_COUNTERED">The buyer proposed different terms</option>
                  <option value="BUYER_DECLINED">The buyer declined</option>
                  <option value="CONTACT_UNDELIVERABLE">The message could not be delivered</option>
                  <option value="DELIVERY_ACCEPTED">The buyer accepted the delivered work</option>
                  <option value="DELIVERY_REJECTED">The buyer rejected the delivered work</option>
                  <option value="SUPPLIER_COST_CHANGED">A supplier’s cost changed</option>
                </select>
                {field('evidenceRef', 'Reference somebody can check (a message, a document)')}
                {fields.kind === 'BUYER_COUNTERED' || fields.kind === 'SUPPLIER_COST_CHANGED' ? field('amount', `Amount stated, in ${currency}`) : null}
              </>
            ) : null}
            {form === 'agree' ? (
              <>
                {field('amount', `Agreed amount, in ${currency}`)}
                {field('deliverable', 'What is delivered')}
                {field('acceptanceCondition', 'What counts as acceptance')}
                <label className="rs-field-label" htmlFor={`journey-${deal.opportunityId}-evidenceKind`}>
                  Evidence of agreement
                </label>
                <select id={`journey-${deal.opportunityId}-evidenceKind`} value={fields.evidenceKind ?? ''} onChange={set('evidenceKind')}>
                  <option value="">Choose…</option>
                  <option value="SIGNED_AGREEMENT">A signed agreement</option>
                  <option value="WRITTEN_ACCEPTANCE">A written acceptance</option>
                  <option value="PURCHASE_ORDER">A purchase order</option>
                  <option value="PROVIDER_RECORD">A provider’s record</option>
                </select>
                {field('evidenceRef', 'Its reference')}
              </>
            ) : null}
            {form === 'invoice' ? (
              <>
                <p className="rs-hint">
                  The amount is the agreement’s, {money(deal.pnl.invoiceableCents, currency)}. Brain issues it under your
                  authority once an invoicing provider is connected.
                </p>
                {field('customerName', 'Who is billed')}
                {field('customerEmail', 'Their billing email')}
                <label className="rs-field-label" htmlFor={`journey-${deal.opportunityId}-tax`}>
                  Tax treatment
                </label>
                <select id={`journey-${deal.opportunityId}-tax`} value={fields.taxTreatment ?? ''} onChange={set('taxTreatment')}>
                  <option value="">Choose…</option>
                  <option value="NO_TAX_CHARGED">No tax charged</option>
                  <option value="TAX_EXEMPT">Tax exempt</option>
                  <option value="REVERSE_CHARGE">Reverse charge</option>
                </select>
                {field('dueDate', 'Due date (YYYY-MM-DD)')}
              </>
            ) : null}
            {form === 'fulfil' ? (
              <>
                <label className="rs-field-label" htmlFor={`journey-${deal.opportunityId}-path`}>
                  Who does the work
                </label>
                <select id={`journey-${deal.opportunityId}-path`} value={fields.path ?? ''} onChange={set('path')}>
                  <option value="">Choose…</option>
                  <option value="PERSON">You or another person</option>
                  <option value="CONTRACTOR">A contractor</option>
                  <option value="SUPPLIER">A supplier</option>
                  <option value="OTHER">Somewhere else</option>
                </select>
                {field('workRef', 'Where the work is held (a job, a booking, a supplier order)')}
              </>
            ) : null}
            {form === 'performed' ? field('evidence', 'Evidence the work was performed') : null}
            {form === 'release' ? field('reason', 'Why this agreement will not be billed further') : null}
            {form === 'accept' && acceptance ? <p className="rs-hint">Uses the buyer’s acceptance: {acceptance.evidenceRef}</p> : null}
            <button
              type="button"
              className="rs-button-quiet"
              disabled={busy}
              onClick={() => {
                const agreementId = live[0]?.id;
                const work = open[0]?.id;
                if (form === 'observe') {
                  void submit('observe', {
                    kind: fields.kind,
                    evidenceRef: fields.evidenceRef,
                    ...(fields.amount && cents(fields.amount) !== null ? { amountCents: cents(fields.amount) } : {}),
                  });
                } else if (form === 'agree') {
                  void submit('agree', {
                    amountCents: cents(fields.amount ?? '') ?? 0,
                    deliverable: fields.deliverable,
                    acceptanceCondition: fields.acceptanceCondition,
                    evidenceKind: fields.evidenceKind,
                    evidenceRef: fields.evidenceRef,
                  });
                } else if (form === 'invoice') {
                  void submit('invoice', {
                    customerName: fields.customerName,
                    customerEmail: fields.customerEmail,
                    taxTreatment: fields.taxTreatment,
                    dueDate: fields.dueDate,
                  });
                } else if (form === 'fulfil') {
                  void submit('fulfil', { agreementId, path: fields.path, workKind: 'EXTERNAL', workRef: fields.workRef });
                } else if (form === 'performed') {
                  void submit('performed', { fulfilmentId: open.find((one) => one.state === 'CREATED')?.id ?? work, evidence: fields.evidence });
                } else if (form === 'accept') {
                  void submit('accept-delivery', {
                    fulfilmentId: open.find((one) => one.state === 'PERFORMED')?.id,
                    observationId: acceptance?.id,
                  });
                } else if (form === 'release') {
                  void submit('release-agreement', { agreementId, reason: fields.reason });
                }
              }}
            >
              {busy ? 'Recording…' : 'Confirm'}
            </button>
            <button type="button" className="rs-linklike" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        )
      ) : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}
