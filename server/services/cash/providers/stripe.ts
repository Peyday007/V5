/**
 * Invoicing and payment collection through Stripe.
 *
 * ---------------------------------------------------------------------------
 * Why Stripe
 * ---------------------------------------------------------------------------
 *
 * It is the one payment provider this repository already reasons about:
 * `money.ts` and `docs/CASH.md` both cite Stripe's own payout timing as the
 * reason a `CUSTOMER_PAYMENT` is not a `SETTLEMENT`. An invoice Stripe issues
 * carries a hosted payment page, so issuing an invoice and offering a way to
 * pay it are one provider and one credential rather than two integrations that
 * would have to agree about which invoice a payment is for.
 *
 * ---------------------------------------------------------------------------
 * The invoice is one logical effect made of five requests
 * ---------------------------------------------------------------------------
 *
 *   customer → draft invoice → line item → finalize → send
 *
 * Every request carries its own `Idempotency-Key`, derived from Brain's invoice
 * row id and the step, so a retry of the whole sequence inside Stripe's
 * twenty-four-hour window replays each step rather than creating a second
 * customer or a second invoice. Past that window the engine does not resend at
 * all: the adapter is **EXTERNAL_RECONCILABLE**, every object it creates
 * carries `metadata[brain_invoice]`, and after an ambiguous send the engine
 * asks Stripe's search API what exists under that id instead of sending again.
 *
 * Stripe's search is eventually consistent — an invoice can be absent from it
 * for a short while after creation — so an empty search is reported as
 * **INCONCLUSIVE, never ABSENT**. ABSENT would tell the engine that nothing
 * happened and a retry is safe; an empty eventually-consistent index is not
 * evidence of that, and treating it as such is how a timeout becomes a second
 * invoice. A draft found there is inconclusive too: it was never sent, and
 * finishing it would be a send nobody decided on.
 *
 * ---------------------------------------------------------------------------
 * What Brain never supplies
 * ---------------------------------------------------------------------------
 *
 * The amount, currency, customer, tax treatment and due date all arrive in the
 * payload from rows a person or the ledger wrote (`cash/invoicing.ts`). This
 * module computes none of them and never adds tax: `TAX_TREATMENTS` is the
 * closed set of treatments it can express without calculating anything, and an
 * invoice that has to charge tax is issued outside Brain.
 *
 * The API version is pinned, because the field a payment is read from
 * (`invoice.charge`) moved in later versions and a payment reader that
 * silently stopped finding payments would read as nobody paying.
 */
import type {
  AdapterHealth,
  EffectAdapter,
  EffectRequest,
  ReconcileOutcome,
  SendOutcome,
} from '../../effects/adapter.ts';
import { ADDRESS, STRIPE_KEY_ENV, billingConfig, secretValue } from './config.ts';
import { providerRequest, type FetchLike, type ProviderAnswer } from './http.ts';

export const STRIPE_INVOICE_ADAPTER_NAME = 'stripe.issue_invoice';
export const STRIPE_API = 'https://api.stripe.com';
export const STRIPE_API_VERSION = '2024-06-20';

/** What Brain can say about tax without computing any. */
export const TAX_TREATMENTS = ['NO_TAX_CHARGED', 'TAX_EXEMPT', 'REVERSE_CHARGE'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

const STRIPE_TAX_EXEMPT: Record<TaxTreatment, 'none' | 'exempt' | 'reverse'> = {
  NO_TAX_CHARGED: 'none',
  TAX_EXEMPT: 'exempt',
  REVERSE_CHARGE: 'reverse',
};

function authHeaders(key: string, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': STRIPE_API_VERSION,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

function form(fields: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) params.append(name, String(value));
  return params.toString();
}

/** The end of a calendar day, in UTC seconds — which is what Stripe takes. */
export function dueDateSeconds(dueDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  const at = Date.parse(`${dueDate}T23:59:59.000Z`);
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

export function validateInvoicePayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('An invoice request must be an object.');
  }
  const record = payload as Record<string, unknown>;
  const amount = record.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('An invoice amount is a positive whole number of cents.');
  }
  const currency = record.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('An invoice currency is a three-letter code.');
  }
  const email = record.customerEmail;
  if (typeof email !== 'string' || !ADDRESS.test(email)) {
    throw new Error('An invoice is sent to one customer email address.');
  }
  const name = record.customerName;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 200) {
    throw new Error('An invoice names the customer it bills.');
  }
  const tax = record.taxTreatment;
  if (typeof tax !== 'string' || !(TAX_TREATMENTS as readonly string[]).includes(tax)) {
    throw new Error(`An invoice states its tax treatment as one of ${TAX_TREATMENTS.join(', ')}.`);
  }
  const due = record.dueDate;
  if (typeof due !== 'string' || dueDateSeconds(due) === null) {
    throw new Error('An invoice due date is a calendar date, YYYY-MM-DD.');
  }
  const description = record.description;
  if (typeof description !== 'string' || description.trim() === '' || description.length > 500) {
    throw new Error('An invoice line says what it is for.');
  }
  return {
    amountCents: amount,
    currency,
    customerEmail: email,
    customerName: name.trim(),
    taxTreatment: tax,
    dueDate: due,
    description: description.trim(),
  };
}

function refusalOf(answer: Exclude<ProviderAnswer, { kind: 'OK' }>): SendOutcome {
  return answer.kind === 'REFUSED'
    ? { kind: 'REJECTED', category: answer.category, retryable: answer.retryable, detail: answer.detail }
    : { kind: 'UNCERTAIN', reason: answer.reason };
}

export function createStripeInvoiceAdapter(options: {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  namespace: string;
}): EffectAdapter {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;

  async function call(
    key: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string | number>,
    idempotencyKey?: string,
  ): Promise<ProviderAnswer> {
    return await providerRequest({
      fetch: doFetch,
      url: `${STRIPE_API}${path}`,
      method,
      headers: authHeaders(key, idempotencyKey),
      body: body ? form(body) : undefined,
      // Stripe's 409 is "a request with this key is still in flight".
      uncertainStatuses: [409],
    });
  }

  return {
    name: STRIPE_INVOICE_ADAPTER_NAME,
    effectClass: 'EXTERNAL_RECONCILABLE',
    namespace: options.namespace,
    validate: validateInvoicePayload,
    fingerprintInputs: (payload) => payload,
    health(): AdapterHealth {
      const reading = billingConfig(env());
      return reading.configured
        ? { usable: true, reason: `Stripe is configured (${reading.mode} mode).` }
        : { usable: false, reason: `Stripe is not usable: missing or malformed ${reading.problems.join(', ')}.` };
    },

    async send(request: EffectRequest): Promise<SendOutcome> {
      const key = secretValue(STRIPE_KEY_ENV, env());
      if (!key || !billingConfig(env()).configured) {
        return {
          kind: 'REJECTED',
          category: 'DEPENDENCY_UNAVAILABLE',
          retryable: true,
          detail: `${STRIPE_KEY_ENV} is not configured, so nothing was sent`,
        };
      }
      const p = request.payload;
      const tag = request.businessId;
      const metadata = { 'metadata[brain_invoice]': tag };
      const currency = String(p.currency).toLowerCase();

      const customer = await call(
        key,
        'POST',
        '/v1/customers',
        {
          email: String(p.customerEmail),
          name: String(p.customerName),
          tax_exempt: STRIPE_TAX_EXEMPT[p.taxTreatment as TaxTreatment],
          ...metadata,
        },
        `brain-${tag}-customer`,
      );
      if (customer.kind !== 'OK') return refusalOf(customer);
      const customerId = String(customer.body.id ?? '');

      const draft = await call(
        key,
        'POST',
        '/v1/invoices',
        {
          customer: customerId,
          currency,
          collection_method: 'send_invoice',
          due_date: dueDateSeconds(String(p.dueDate)) ?? 0,
          auto_advance: 'false',
          pending_invoice_items_behavior: 'exclude',
          ...metadata,
        },
        `brain-${tag}-invoice`,
      );
      // Past the customer, anything that goes wrong has left an object at
      // Stripe. A refusal there is still a refusal — a draft nobody sent bills
      // nobody — but it is reported, and reconciliation will find it.
      if (draft.kind !== 'OK') return refusalOf(draft);
      const invoiceId = String(draft.body.id ?? '');
      if (!invoiceId) return { kind: 'UNCERTAIN', reason: 'Stripe created an invoice and returned no id' };

      const item = await call(
        key,
        'POST',
        '/v1/invoiceitems',
        {
          customer: customerId,
          invoice: invoiceId,
          amount: Number(p.amountCents),
          currency,
          description: String(p.description),
          ...metadata,
        },
        `brain-${tag}-item`,
      );
      if (item.kind !== 'OK') return refusalOf(item);

      const finalized = await call(key, 'POST', `/v1/invoices/${encodeURIComponent(invoiceId)}/finalize`, {}, `brain-${tag}-finalize`);
      if (finalized.kind !== 'OK') return refusalOf(finalized);

      const sent = await call(key, 'POST', `/v1/invoices/${encodeURIComponent(invoiceId)}/send`, {}, `brain-${tag}-send`);
      if (sent.kind !== 'OK') {
        // The invoice exists and is finalized; whether Stripe emailed it is
        // the open question, and the hosted page is payable either way.
        return sent.kind === 'REFUSED'
          ? { kind: 'UNCERTAIN', reason: `the invoice was finalized and sending it was refused: ${sent.detail}` }
          : { kind: 'UNCERTAIN', reason: sent.reason };
      }
      return {
        kind: 'CONFIRMED',
        receiptRef: invoiceId,
        receiptMeta: { provider: 'stripe', status: String(sent.body.status ?? 'open') },
      };
    },

    async reconcile(businessId: string): Promise<ReconcileOutcome> {
      const key = secretValue(STRIPE_KEY_ENV, env());
      if (!key) return { kind: 'INCONCLUSIVE', reason: `${STRIPE_KEY_ENV} is not configured` };
      if (!/^[A-Za-z0-9_-]+$/.test(businessId)) {
        return { kind: 'INCONCLUSIVE', reason: 'the invoice id cannot be searched for safely' };
      }
      const query = encodeURIComponent(`metadata['brain_invoice']:'${businessId}'`);
      const answer = await call(key, 'GET', `/v1/invoices/search?query=${query}`);
      if (answer.kind !== 'OK') {
        return { kind: 'INCONCLUSIVE', reason: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
      }
      const data = Array.isArray(answer.body.data) ? (answer.body.data as Record<string, unknown>[]) : [];
      const issued = data.find((one) => one.status !== 'draft' && typeof one.id === 'string');
      if (issued) {
        return {
          kind: 'FOUND',
          receiptRef: String(issued.id),
          receiptMeta: { provider: 'stripe', status: String(issued.status ?? '') },
        };
      }
      return {
        kind: 'INCONCLUSIVE',
        reason:
          data.length > 0
            ? 'Stripe holds a draft for this invoice that was never finalized or sent'
            : "Stripe's search shows nothing yet, and its index can lag a new invoice",
      };
    },

    redactReceipt: (meta) => ({
      provider: 'stripe',
      status: typeof meta.status === 'string' && /^[a-z_]{1,32}$/.test(meta.status) ? meta.status : null,
    }),
  };
}

/* ------------------------------------------------------------------------- */
/* Reading what happened to an invoice: payment, and settlement               */
/* ------------------------------------------------------------------------- */

/**
 * What Stripe says about one invoice's money, classified.
 *
 * A read, never an effect: asking costs nothing and changes nothing, which is
 * why it is safe on every tick and after every restart.
 */
export type InvoiceReading =
  | {
      kind: 'READ';
      /** Stripe's own status: draft, open, paid, uncollectible or void. */
      status: string;
      hostedUrl: string | null;
      number: string | null;
      amountPaidCents: number;
      currency: string;
      /** The charge that paid it, where a card or bank payment did. */
      chargeId: string | null;
      paidAt: string | null;
      /** The balance transaction the money landed in, once there is one. */
      balance: {
        id: string;
        /** pending until the funds are usable, then available. */
        status: string;
        /** The currency the money landed in, which may differ from the invoice's. */
        currency: string;
        amountCents: number;
        feeCents: number;
        availableOn: string | null;
      } | null;
    }
  | { kind: 'UNREADABLE'; reason: string };

function isoFromSeconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

export async function readStripeInvoice(
  invoiceId: string,
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<InvoiceReading> {
  const env = options.env ?? process.env;
  const key = secretValue(STRIPE_KEY_ENV, env);
  if (!key) return { kind: 'UNREADABLE', reason: `${STRIPE_KEY_ENV} is not configured` };
  const answer = await providerRequest({
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    url: `${STRIPE_API}/v1/invoices/${encodeURIComponent(invoiceId)}?expand[]=charge.balance_transaction`,
    method: 'GET',
    headers: authHeaders(key),
  });
  if (answer.kind !== 'OK') {
    return { kind: 'UNREADABLE', reason: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
  }
  const body = answer.body;
  const charge = body.charge && typeof body.charge === 'object' ? (body.charge as Record<string, unknown>) : null;
  const bt =
    charge && charge.balance_transaction && typeof charge.balance_transaction === 'object'
      ? (charge.balance_transaction as Record<string, unknown>)
      : null;
  const transitions =
    body.status_transitions && typeof body.status_transitions === 'object'
      ? (body.status_transitions as Record<string, unknown>)
      : {};
  return {
    kind: 'READ',
    status: String(body.status ?? ''),
    hostedUrl: typeof body.hosted_invoice_url === 'string' ? body.hosted_invoice_url : null,
    number: typeof body.number === 'string' ? body.number : null,
    amountPaidCents: typeof body.amount_paid === 'number' ? body.amount_paid : 0,
    currency: String(body.currency ?? '').toUpperCase(),
    chargeId: charge && typeof charge.id === 'string' ? charge.id : null,
    paidAt: isoFromSeconds(transitions.paid_at),
    balance:
      bt && typeof bt.id === 'string'
        ? {
            id: bt.id,
            status: String(bt.status ?? ''),
            currency: String(bt.currency ?? '').toUpperCase(),
            amountCents: typeof bt.amount === 'number' ? bt.amount : 0,
            feeCents: typeof bt.fee === 'number' ? bt.fee : 0,
            availableOn: isoFromSeconds(bt.available_on),
          }
        : null,
  };
}

/** A live check of the key for an operator: reading the balance moves nothing. */
export async function probeStripe(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<{
  verdict: 'VERIFIED' | 'BAD_CREDENTIAL' | 'NOT_CONFIGURED' | 'UNREACHABLE';
  detail: string;
}> {
  const env = options.env ?? process.env;
  const reading = billingConfig(env);
  const key = secretValue(STRIPE_KEY_ENV, env);
  if (!reading.configured || !key) return { verdict: 'NOT_CONFIGURED', detail: reading.problems.join(', ') };
  const answer = await providerRequest({
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    url: `${STRIPE_API}/v1/balance`,
    method: 'GET',
    headers: authHeaders(key),
  });
  if (answer.kind === 'OK') return { verdict: 'VERIFIED', detail: `Stripe accepted the key (${reading.mode} mode).` };
  if (answer.kind === 'REFUSED' && answer.category === 'NOT_AUTHORIZED') {
    return { verdict: 'BAD_CREDENTIAL', detail: answer.detail };
  }
  return { verdict: 'UNREACHABLE', detail: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
}
