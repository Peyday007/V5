/**
 * One deal's first-dollar journey, as its owner reads it: where it is, what
 * its money did, what happens next and who does it — and the few controls that
 * are genuinely a person's.
 *
 * Every figure and every "next" is the server's (`services/cash/journey/`);
 * nothing is totalled or decided here. The controls are only the facts a
 * person holds and Brain cannot: what the buyer said, what was agreed and the
 * evidence for it, who performs each agreement's obligation, what was
 * delivered and whether the buyer accepted it, what the work cost, and — for
 * whoever administers the operation's money — a refund and its outcome.
 * There is deliberately no control that marks Brain's own work complete, and
 * none that writes "collected": those follow from rows.
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
      {money(t.paidNetCents, currency)} · settled {money(t.settledCashCents, currency)} · owed to you{' '}
      {money(t.owedByBuyersCents, currency)} · contribution {money(t.contributionCents, currency)}
      {t.unsettledCents > 0 ? ` (${money(t.unsettledCents, currency)} paid and not yet settled is not cash)` : ''}
    </p>
  );
}

type Form = null | 'observe' | 'agree' | 'invoice' | 'release';

export function DealJourney({
  deal,
  currency,
  projectId,
  mayAct,
  mayRefund = false,
  onChanged,
}: {
  deal: DealView;
  currency: string;
  /** Needed only to request an invoice, which is a project-scoped route. */
  projectId?: string;
  mayAct: boolean;
  /** Refunds pay money out, so they are offered only to whoever may (ADMIN). */
  mayRefund?: boolean;
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
        {money(p.invoicedCents, currency)}, paid {money(p.paidNetCents, currency)}, settled{' '}
        {money(p.settledCashCents, currency)}; costs {money(p.incrementalCostsCents + p.unpaidCommitmentsCents, currency)};
        contribution {money(p.contributionCents, currency)}.
      </p>
      {p.owedBackCents > 0 ? (
        <p className="rs-state rs-state-warn">
          {money(p.owedBackCents, currency)} is owed back to the buyer — a second payment of a paid invoice, or
          payment on an agreement since released. It is not payment toward any agreement, and the deal is not
          collected until it is refunded.
        </p>
      ) : null}
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
      {mayAct
        ? deal.invoices
            .filter((invoice) => invoice.state === 'ISSUED' && !invoice.paymentEntryId)
            .flatMap((invoice) =>
              (deal.unattributedPayments ?? [])
                .filter((payment) => payment.amountCents === invoice.amountCents)
                .map((payment) => (
                  <p key={`${invoice.id}:${payment.id}`} className="rs-item-meta">
                    A payment you recorded ({payment.reference ?? payment.id}, {money(payment.amountCents, currency)}) is not
                    tied to any invoice.{' '}
                    <button
                      type="button"
                      className="rs-button-quiet"
                      disabled={busy}
                      onClick={() => void submit('attribute-payment', { entryId: payment.id, invoiceId: invoice.id })}
                    >
                      It paid invoice {invoice.providerNumber ?? invoice.providerInvoiceId ?? invoice.id}
                    </button>
                  </p>
                )),
            )
        : null}
      {deal.obligations.map((one) => (
        <Obligation
          key={one.agreement.id}
          obligation={one}
          opportunityId={deal.opportunityId}
          currency={currency}
          mayAct={mayAct}
          mayRefund={mayRefund}
          onChanged={onChanged}
        />
      ))}
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
                </select>
                {field('evidenceRef', 'Reference somebody can check (a message, a document)')}
                {fields.kind === 'BUYER_COUNTERED' ? field('amount', `Amount stated, in ${currency}`) : null}
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
            {form === 'release' ? (
              <>
                {live.length > 1 ? (
                  <>
                    <label className="rs-field-label" htmlFor={`journey-${deal.opportunityId}-agreementId`}>
                      Which agreement
                    </label>
                    <select id={`journey-${deal.opportunityId}-agreementId`} value={fields.agreementId ?? ''} onChange={set('agreementId')}>
                      {live.map((one) => (
                        <option key={one.id} value={one.id}>
                          {one.deliverable}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                {field('reason', 'Why this agreement will not be billed further')}
              </>
            ) : null}
            <button
              type="button"
              className="rs-button-quiet"
              disabled={busy}
              onClick={() => {
                const agreementId = fields.agreementId || live[0]?.id;
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

const OBLIGATION_STAGE: Record<string, string> = {
  REQUIRED: 'Nobody has said how this is fulfilled',
  IN_PROGRESS: 'Being worked on',
  DELIVERED: 'Delivered, not yet accepted',
  REJECTED: 'The buyer rejected the delivery',
  ACCEPTED: 'Accepted',
  FAILED: 'Failed',
  COMPLETE: 'Complete',
  RELEASED: 'Agreement released',
};

type ObligationForm = null | 'declare' | 'event' | 'cost' | 'retry' | 'refund' | 'answer';

/**
 * One agreement's obligation: who performs it, where the work is, what was
 * delivered and accepted, and its refunds — every word the server's reading
 * (`journey/fulfillment.ts`). The controls are a person's facts only, and a
 * refund control appears only for whoever may authorize one, because offering
 * a control the server refuses teaches a person the refusal is arbitrary (§35).
 */
export function Obligation({
  obligation,
  opportunityId,
  currency,
  mayAct,
  mayRefund,
  onChanged,
}: {
  obligation: DealView['obligations'][number];
  opportunityId: string;
  currency: string;
  mayAct: boolean;
  mayRefund: boolean;
  onChanged(): void;
}): JSX.Element {
  const [form, setForm] = useState<ObligationForm>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (key: string) => (event: { target: { value: string } }) =>
    setFields((before) => ({ ...before, [key]: event.target.value }));
  const id = (key: string) => `obligation-${obligation.agreement.id}-${key}`;
  const field = (key: string, label: string) => (
    <>
      <label className="rs-field-label" htmlFor={id(key)}>
        {label}
      </label>
      <input id={id(key)} value={fields[key] ?? ''} onChange={set(key)} />
    </>
  );
  const o = obligation;
  const live = o.agreement.state === 'AGREED';
  const closed = o.complete || Boolean(o.failure && o.failure.kind !== 'WORK_FAILED');
  const unresolved = o.refunds.filter((one) => one.state === 'PENDING' || one.state === 'UNKNOWN');

  async function submit(action: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const result = await CashApi.act(opportunityId, action, { agreementId: o.agreement.id, ...body });
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

  function confirm(): void {
    if (form === 'declare') {
      void submit('fulfil', {
        kind: fields.kind,
        performer: fields.performer,
        ...(fields.repositoryRemote ? { repositoryRemote: fields.repositoryRemote } : {}),
        ...(fields.supplierName ? { supplierName: fields.supplierName } : {}),
      });
    } else if (form === 'event') {
      void submit('obligation-event', { kind: fields.kind, detail: fields.detail, evidenceRef: fields.evidenceRef });
    } else if (form === 'cost') {
      void submit('obligation-cost', {
        kind: fields.kind,
        amountCents: cents(fields.amount ?? '') ?? 0,
        detail: fields.detail,
        reference: fields.reference,
      });
    } else if (form === 'retry') {
      void submit('obligation-retry', { reason: fields.reason });
    } else if (form === 'refund') {
      void submit('refund', { amountCents: cents(fields.amount ?? '') ?? 0, reason: fields.reason });
    } else if (form === 'answer') {
      void submit('refund-answer', { refundKey: fields.refundKey, answer: fields.answer, reference: fields.reference });
    }
  }

  return (
    <div className="rs-cash-obligation" aria-label={`Obligation: ${o.agreement.deliverable}`}>
      <p className="rs-item-meta">
        <strong>{o.agreement.deliverable}</strong> — {OBLIGATION_STAGE[o.stage] ?? o.stage}
        {o.fulfillment ? ` · ${o.fulfillment.kind.toLowerCase()}, by ${o.fulfillment.performer}` : ''}
      </p>
      <p className="rs-item-meta">
        Work: {o.work.detail}
        {o.work.artifact ? ` (${o.work.artifact})` : ''}. Delivery: {o.delivery.state.toLowerCase().replace(/_/g, ' ')}
        {o.delivery.portions.length > 0 ? ` (${o.delivery.portions.length} part${o.delivery.portions.length === 1 ? '' : 's'})` : ''}.
        Accepted when: {o.acceptance.condition}
      </p>
      {o.refunds.length > 0 ? (
        <p className="rs-item-meta">
          Refunds:{' '}
          {o.refunds
            .map((one) => `${money(one.amountCents, currency)} ${one.state.toLowerCase()}${one.reference ? ` (${one.reference})` : ''}`)
            .join('; ')}
        </p>
      ) : null}
      {o.outstanding.length > 0 && !o.complete ? (
        <p className="rs-item-meta">Not complete: {o.outstanding.join('; ')}.</p>
      ) : null}
      {done ? <p className="rs-state rs-state-ok">{done}</p> : null}
      {mayAct && form === null ? (
        <div className="rs-cash-journey-actions">
          {live && !o.fulfillment ? (
            <button type="button" className="rs-button-quiet" onClick={() => setForm('declare')}>
              Say who fulfils this
            </button>
          ) : null}
          {live && o.fulfillment && !closed ? (
            <button type="button" className="rs-button-quiet" onClick={() => setForm('event')}>
              Record what happened
            </button>
          ) : null}
          {o.fulfillment ? (
            <button type="button" className="rs-button-quiet" onClick={() => setForm('cost')}>
              Record a cost
            </button>
          ) : null}
          {o.failure?.kind === 'WORK_FAILED' && live ? (
            <button type="button" className="rs-button-quiet" onClick={() => setForm('retry')}>
              Retry the work
            </button>
          ) : null}
          {mayRefund && o.fulfillment ? (
            <button type="button" className="rs-linklike" onClick={() => setForm('refund')}>
              Authorize a refund
            </button>
          ) : null}
          {mayRefund && unresolved.length > 0 ? (
            <button
              type="button"
              className="rs-linklike"
              onClick={() => {
                setFields({ refundKey: unresolved[0]!.refundKey, answer: 'confirm' });
                setForm('answer');
              }}
            >
              Answer a refund
            </button>
          ) : null}
        </div>
      ) : null}
      {mayAct && form !== null ? (
        <div className="rs-cash-journey-form">
          {form === 'declare' ? (
            <>
              <label className="rs-field-label" htmlFor={id('kind')}>
                Who does the work
              </label>
              <select id={id('kind')} value={fields.kind ?? ''} onChange={set('kind')}>
                <option value="">Choose…</option>
                <option value="SOFTWARE">The Software Factory builds it</option>
                <option value="RESEARCH">Brain researches it</option>
                <option value="PERSON">A person does it</option>
                <option value="SUPPLIER">A supplier or contractor does it</option>
              </select>
              {field('performer', 'Who performs it, by name')}
              {fields.kind === 'SOFTWARE' ? field('repositoryRemote', 'Which repository (owner/name)') : null}
              {fields.kind === 'SUPPLIER' ? field('supplierName', 'The supplier') : null}
            </>
          ) : null}
          {form === 'event' ? (
            <>
              <label className="rs-field-label" htmlFor={id('kind')}>
                What happened
              </label>
              <select id={id('kind')} value={fields.kind ?? ''} onChange={set('kind')}>
                <option value="">Choose…</option>
                {o.fulfillment?.kind === 'PERSON' || o.fulfillment?.kind === 'SUPPLIER' ? (
                  <option value="WORK_COMPLETE">The work is done</option>
                ) : null}
                <option value="PARTIALLY_DELIVERED">Part of it was delivered</option>
                <option value="DELIVERED">All of it was delivered</option>
                <option value="ACCEPTED">The buyer accepted it</option>
                <option value="REJECTED">The buyer rejected it</option>
                {o.fulfillment?.kind === 'SUPPLIER' ? <option value="SUPPLIER_FAILED">The supplier failed</option> : null}
                <option value="FAILED">It failed</option>
                <option value="ABANDONED">It was abandoned</option>
              </select>
              {field('detail', 'What happened, in words somebody can check')}
              {field('evidenceRef', 'Evidence (a delivery, the buyer’s message, a document)')}
            </>
          ) : null}
          {form === 'cost' ? (
            <>
              <label className="rs-field-label" htmlFor={id('kind')}>
                Which cost
              </label>
              <select id={id('kind')} value={fields.kind ?? ''} onChange={set('kind')}>
                <option value="">Choose…</option>
                {o.fulfillment?.kind === 'SUPPLIER' ? (
                  <>
                    <option value="SUPPLIER_COMMITMENT">The supplier is owed this</option>
                    <option value="SUPPLIER_COST_REDUCED">The supplier now costs less</option>
                    <option value="SUPPLIER_PAYMENT">The supplier was paid</option>
                  </>
                ) : null}
                <option value="INTERNAL_COST">An internal cost was paid</option>
              </select>
              {field('amount', `Amount, in ${currency}`)}
              {field('detail', 'What it was for')}
              {field('reference', 'Reference (required for a payment)')}
            </>
          ) : null}
          {form === 'retry' ? field('reason', 'What changed, so the next attempt is not the same') : null}
          {form === 'refund' ? (
            <>
              {field('amount', `Refund, in ${currency}`)}
              {field('reason', 'Why the buyer is owed this')}
            </>
          ) : null}
          {form === 'answer' ? (
            <>
              <label className="rs-field-label" htmlFor={id('refundKey')}>
                Which refund
              </label>
              <select id={id('refundKey')} value={fields.refundKey ?? ''} onChange={set('refundKey')}>
                {unresolved.map((one) => (
                  <option key={one.refundKey} value={one.refundKey}>
                    {money(one.amountCents, currency)} — {one.state.toLowerCase()}
                  </option>
                ))}
              </select>
              <label className="rs-field-label" htmlFor={id('answer')}>
                What the provider says
              </label>
              <select id={id('answer')} value={fields.answer ?? 'confirm'} onChange={set('answer')}>
                <option value="confirm">It was refunded</option>
                <option value="not-sent">It did not happen</option>
              </select>
              {field('reference', 'The provider’s reference')}
            </>
          ) : null}
          <button type="button" className="rs-button-quiet" disabled={busy} onClick={confirm}>
            {busy ? 'Recording…' : 'Confirm'}
          </button>
          <button type="button" className="rs-linklike" onClick={() => setForm(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}
