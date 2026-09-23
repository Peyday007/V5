/**
 * The live commercial path: what we are doing to make money, what has actually
 * happened, what is blocked, what happens next, and the decisions that need the
 * owner — every sentence the server's, from one derivation.
 *
 * Its controls record what a person did or what a buyer said, each with the
 * reference that makes it checkable. None of them grants authority: an action
 * the standing grant does not cover is refused by the server in its own words,
 * and the decision it needs is listed above with everything already prepared.
 * Nothing here composes a status of its own, and no figure is rendered that the
 * briefing did not compute.
 */
import { useState } from 'react';
import { useAsync } from './useAsync.ts';
import {
  CommerceApi,
  type CashInvoice,
  type CashObligation,
  type CommercialReading,
  type CommercialTest,
} from '../lib/commerceApi.ts';

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CommercialPath({ projectId }: { projectId: string }): JSX.Element {
  const reading = useAsync(() => CommerceApi.read(projectId), [projectId]);
  const [message, setMessage] = useState<string | null>(null);

  if (!reading.data) {
    return (
      <div className="rs-cash-commercial">
        <h4>The commercial path</h4>
        <p className="rs-hint">
          {reading.error ? `The commercial records could not be read: ${reading.error.message}` : 'Reading the commercial records…'}
        </p>
      </div>
    );
  }
  const data: CommercialReading = reading.data;
  const b = data.briefing;
  const act = async (run: () => Promise<{ message: string }>): Promise<void> => {
    try {
      setMessage((await run()).message);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
    reading.reload();
  };

  return (
    <div className="rs-cash-commercial">
      <h4>The commercial path</h4>
      <p className="rs-item-meta">{b.grant.summary}</p>
      {message ? <p className="rs-hint" role="status">{message}</p> : null}

      <h5>What we are doing to make money</h5>
      {b.doing.length === 0 ? (
        <p className="rs-hint">Nothing is being sold yet: no demand test and no offer is live.</p>
      ) : (
        <ul className="rs-list">{b.doing.map((one, i) => <li key={i}><strong>{one.subject}</strong> — {one.text}</li>)}</ul>
      )}

      <h5>What has actually happened</h5>
      {b.happened.length === 0 ? (
        <p className="rs-hint">No buyer has been contacted, no reply recorded, nothing invoiced, nothing collected.</p>
      ) : (
        <ul className="rs-list">{b.happened.slice(0, 15).map((one, i) => <li key={i}><strong>{one.subject}</strong> — {one.text}</li>)}</ul>
      )}
      {b.money ? (
        <dl className="rs-cash-commercial-money">
          <dt>Pipeline (agreed, unpaid)</dt><dd>{money(b.money.pipelineCents, b.money.currency)}</dd>
          <dt>Invoiced, unpaid</dt><dd>{money(b.money.invoicedUnpaidCents, b.money.currency)}</dd>
          <dt>Customer payments</dt><dd>{money(b.money.customerPaymentsCents, b.money.currency)}</dd>
          <dt>Paid, not yet settled</dt><dd>{money(b.money.paidNotSettledCents, b.money.currency)}</dd>
          <dt>Available funds</dt><dd>{money(b.money.availableFundsCents, b.money.currency)}</dd>
          <dt>Costs</dt><dd>{money(b.money.costsCents, b.money.currency)}</dd>
          <dt>Contribution</dt><dd>{money(b.money.contributionCents, b.money.currency)}</dd>
          <dt>Unpaid commitments</dt><dd>{money(b.money.unpaidCommitmentsCents, b.money.currency)}</dd>
        </dl>
      ) : null}

      <h5>What is blocked</h5>
      {b.blocked.length === 0 ? <p className="rs-hint">Nothing.</p> : (
        <ul className="rs-list">{b.blocked.map((one, i) => <li key={i}><strong>{one.subject}</strong> — {one.text}</li>)}</ul>
      )}

      <h5>What should happen next</h5>
      {b.next.length === 0 ? <p className="rs-hint">Nothing is scheduled.</p> : (
        <ul className="rs-list">
          {b.next.slice(0, 8).map((one, i) => (
            <li key={i}>
              <span className="rs-badge">{one.owner}{one.due ? ` · due ${one.due.slice(0, 10)}` : ''}{one.overdue ? ' · overdue' : ''}</span>{' '}
              <strong>{one.subject}</strong> — {one.action}
            </li>
          ))}
        </ul>
      )}

      <h5>Decisions that need your authority</h5>
      {b.decisions.length === 0 ? <p className="rs-hint">None right now.</p> : (
        <ul className="rs-list rs-cash-commercial-decisions">
          {b.decisions.map((one) => (
            <li key={one.key} className="rs-group">
              <p className="rs-item-title">{one.action}</p>
              <p className="rs-item-meta">Recipient: {one.recipient}</p>
              <p className="rs-item-meta">Amount: {money(one.amountCents, one.currency)}</p>
              <p className="rs-item-meta">Scope: {one.scope}</p>
              <p className="rs-item-meta">Consequence: {one.consequence}</p>
              <p className="rs-item-meta">Prepared: {one.prepared}</p>
              <p className="rs-hint">Needs {one.authorityAction} — {one.where}</p>
            </li>
          ))}
        </ul>
      )}

      {data.tests.filter((one) => one.state === 'PREPARED' || one.state === 'RUNNING').map((test) => (
        <TestControls key={test.id} test={test} projectId={projectId} act={act} />
      ))}
      {data.obligations
        .filter((one) => !['CLOSED', 'LOST', 'CANCELLED'].includes(one.state))
        .map((obligation) => (
          <ObligationControls
            key={obligation.id}
            obligation={obligation}
            invoices={data.invoices.filter((one) => one.obligationId === obligation.id)}
            act={act}
          />
        ))}

      {b.continuing.length > 0 ? (
        <>
          <h5>Obligations that continue if the sprint winds down</h5>
          <ul className="rs-list">{b.continuing.map((one, i) => <li key={i}><strong>{one.subject}</strong> — {one.text}</li>)}</ul>
        </>
      ) : null}
      {b.learned.length > 0 ? (
        <>
          <h5>What finished work taught</h5>
          <ul className="rs-list">{b.learned.map((one, i) => <li key={i}>{one}</li>)}</ul>
        </>
      ) : null}
    </div>
  );
}

type Act = (run: () => Promise<{ message: string }>) => Promise<void>;

function Field(props: { label: string; value: string; onChange(v: string): void }): JSX.Element {
  return (
    <label className="rs-field">
      <span>{props.label}</span>
      <input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

const REPLY_KINDS = ['INTEREST', 'QUESTION', 'OBJECTION', 'DECLINED', 'AGREED_TO_BUY', 'PAYMENT_PROMISED'];
const ANSWER_KINDS = ['AGREED_TO_BUY', 'DECLINED', 'QUESTION', 'OBJECTION', 'REVISION_REQUESTED', 'ACCEPTED_DELIVERY', 'REJECTED_DELIVERY', 'PAYMENT_PROMISED'];

function TestControls({ test, projectId, act }: { test: CommercialTest; projectId: string; act: Act }): JSX.Element {
  const [recipient, setRecipient] = useState('');
  const [reference, setReference] = useState('');
  const [who, setWho] = useState('');
  const [kind, setKind] = useState('INTEREST');
  const [said, setSaid] = useState('');
  const [where, setWhere] = useState('');
  return (
    <div className="rs-group rs-cash-commercial-test">
      <p className="rs-item-title">Demand test: {test.offer}</p>
      <p className="rs-item-meta">
        {test.audience} via {test.channel} — {test.counts.contacts}/{test.maxContacts} asked, {test.counts.interested} interested,{' '}
        {test.counts.agreed} agreed to buy. Draft: “{test.draftMessage}”
      </p>
      <form onSubmit={(event) => { event.preventDefault(); void act(() => CommerceApi.contact(test.id, { recipient, reference })); }}>
        <Field label="Asked (who)" value={recipient} onChange={setRecipient} />
        <Field label="Where the sent message is" value={reference} onChange={setReference} />
        <button type="submit">Record that this person was asked</button>
      </form>
      <form onSubmit={(event) => {
        event.preventDefault();
        void act(() => CommerceApi.respond(projectId, { opportunityId: test.opportunityId, testId: test.id, respondent: who, kind, channel: test.channel, reference: where, excerpt: said }));
      }}>
        <Field label="Who replied" value={who} onChange={setWho} />
        <label className="rs-field"><span>What it was</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>{REPLY_KINDS.map((one) => <option key={one}>{one}</option>)}</select>
        </label>
        <Field label="What they said, verbatim" value={said} onChange={setSaid} />
        <Field label="Where it can be read" value={where} onChange={setWhere} />
        <button type="submit">Record the reply</button>
      </form>
    </div>
  );
}

function ObligationControls({ obligation, invoices, act }: { obligation: CashObligation; invoices: CashInvoice[]; act: Act }): JSX.Element {
  const [reference, setReference] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [kind, setKind] = useState('AGREED_TO_BUY');
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState('');
  const send = (action: string, body: Record<string, unknown>) => act(() => CommerceApi.obligation(obligation.id, action, body));
  return (
    <div className="rs-group rs-cash-commercial-obligation">
      <p className="rs-item-title">{obligation.buyer} — {obligation.scope}</p>
      <p className="rs-item-meta">{obligation.state} · {money(obligation.priceCents, obligation.currency)} · next: {obligation.nextStep} ({obligation.nextStepOwner})</p>
      <Field label="Reference (message, file, provider id)" value={reference} onChange={setReference} />
      {obligation.state === 'OFFER_PREPARED' ? <button type="button" onClick={() => void send('send', { reference })}>Record the offer as sent</button> : null}
      {obligation.state === 'AGREED' || obligation.state === 'REVISION_REQUESTED' ? (
        <button type="button" onClick={() => void send('produce', { productionReference: reference })}>Record production started</button>
      ) : null}
      {obligation.state === 'IN_PRODUCTION' ? (
        <>
          {obligation.acceptanceConditions.map((condition) => (
            <Field key={condition} label={`Evidence that “${condition}” is met`} value={evidence[condition] ?? ''} onChange={(v) => setEvidence({ ...evidence, [condition]: v })} />
          ))}
          <button type="button" onClick={() => void send('deliver', {
            deliverableReference: reference,
            checks: obligation.acceptanceConditions.map((condition) => ({ condition, met: Boolean(evidence[condition]?.trim()), evidence: evidence[condition] ?? '' })),
          })}>Record the delivery</button>
        </>
      ) : null}
      {['OFFER_SENT', 'DELIVERED', 'AGREED', 'IN_PRODUCTION', 'ACCEPTED'].includes(obligation.state) ? (
        <>
          <label className="rs-field"><span>The buyer said</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>{ANSWER_KINDS.map((one) => <option key={one}>{one}</option>)}</select>
          </label>
          <Field label="Verbatim" value={excerpt} onChange={setExcerpt} />
          <button type="button" onClick={() => void send('answer', { kind, channel: 'recorded', reference, excerpt })}>Record the buyer’s answer</button>
        </>
      ) : null}
      {['AGREED', 'IN_PRODUCTION', 'DELIVERED', 'ACCEPTED'].includes(obligation.state) ? (
        <>
          <Field label="Payment provider" value={provider} onChange={setProvider} />
          <button type="button" onClick={() => void send('invoice', { provider, providerReference: reference })}>Record the invoice issued</button>
        </>
      ) : null}
      {invoices.map((invoice) => (
        <p key={invoice.id} className="rs-item-meta">
          Invoice {invoice.provider} {invoice.providerReference}: {invoice.state} {money(invoice.amountCents, invoice.currency)}{' '}
          {invoice.state === 'ISSUED' || invoice.state === 'PAYMENT_PENDING' || invoice.state === 'FAILED' ? (
            <button type="button" onClick={() => void act(() => CommerceApi.invoiceState(invoice.id, { to: 'PAID', reference }))}>Provider reports paid</button>
          ) : null}
          {invoice.state === 'PAID' ? (
            <button type="button" onClick={() => void act(() => CommerceApi.invoiceState(invoice.id, { to: 'SETTLED', reference }))}>Funds settled</button>
          ) : null}
        </p>
      ))}
    </div>
  );
}
