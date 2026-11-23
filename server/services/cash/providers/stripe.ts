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

/* ------------------------------------------------------------------------- */
/* A Payment Link: one offer, one price, many buyers                          */
/* ------------------------------------------------------------------------- */

/**
 * A Stripe Payment Link for one fixed-price offer (`offerExperiment.ts`).
 *
 * An invoice bills one named customer for an agreed scope; an offer sent to a
 * list has no customer until somebody pays, so the way to be paid is a link
 * every recipient can use. Creating it is an effect — a price and a link exist
 * at Stripe afterwards, and the link takes money from whoever opens it — so it
 * is an adapter the effects engine runs under the ACCEPT_PAYMENT grant, never
 * a call made beside it.
 *
 * Two requests, each with an `Idempotency-Key` derived from Brain's own
 * business id, so a retry inside Stripe's window replays rather than creating a
 * second price or link. Every object carries `metadata[brain_payment_link]`,
 * and the payments the link takes carry it on their PaymentIntent. The list
 * endpoint is read for reconciliation (payment links have no search), and an
 * absence there is INCONCLUSIVE, never ABSENT: a link past the first page, or
 * one created a moment ago, is not evidence that nothing was created.
 *
 * `paymentLinkRequests` builds the exact request bodies and is shared with the
 * dry-run preview, so what the preview says Brain *would* send is what the
 * adapter sends.
 */
export const STRIPE_PAYMENT_LINK_ADAPTER_NAME = 'stripe.payment_link';
export const PAYMENT_LINK_METADATA = 'brain_payment_link';
const PRICE_PLACEHOLDER = '{{price}}';

export interface PaymentLinkRequest {
  method: 'POST';
  path: string;
  idempotencyKey: string;
  /** The form fields; `{{price}}` stands for the price id the first request returns. */
  body: Record<string, string | number>;
}

export function validatePaymentLinkPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('A payment link request must be an object.');
  }
  const record = payload as Record<string, unknown>;
  const amount = record.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('A payment link price is a positive whole number of cents.');
  }
  const currency = record.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('A payment link currency is a three-letter code.');
  }
  const productName = record.productName;
  if (typeof productName !== 'string' || productName.trim() === '' || productName.length > 250) {
    throw new Error('A payment link names the product it sells.');
  }
  const confirmation = record.confirmationMessage;
  if (typeof confirmation !== 'string' || confirmation.trim() === '' || confirmation.length > 500) {
    throw new Error('A payment link tells the buyer what happens after they pay.');
  }
  return { amountCents: amount, currency, productName: productName.trim(), confirmationMessage: confirmation.trim() };
}

/** The exact requests a payment link is created with. Pure; nothing is sent. */
export function paymentLinkRequests(payload: Record<string, unknown>, tag: string): [PaymentLinkRequest, PaymentLinkRequest] {
  const p = validatePaymentLinkPayload(payload);
  const metadata = { [`metadata[${PAYMENT_LINK_METADATA}]`]: tag };
  return [
    {
      method: 'POST',
      path: '/v1/prices',
      idempotencyKey: `brain-${tag}-price`,
      body: {
        currency: String(p.currency).toLowerCase(),
        unit_amount: Number(p.amountCents),
        'product_data[name]': String(p.productName),
        ...metadata,
      },
    },
    {
      method: 'POST',
      path: '/v1/payment_links',
      idempotencyKey: `brain-${tag}-link`,
      body: {
        'line_items[0][price]': PRICE_PLACEHOLDER,
        'line_items[0][quantity]': 1,
        'after_completion[type]': 'hosted_confirmation',
        'after_completion[hosted_confirmation][custom_message]': String(p.confirmationMessage),
        [`payment_intent_data[metadata][${PAYMENT_LINK_METADATA}]`]: tag,
        ...metadata,
      },
    },
  ];
}

export function createStripePaymentLinkAdapter(options: {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  namespace: string;
}): EffectAdapter {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const call = async (
    key: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string | number>,
    idempotencyKey?: string,
  ): Promise<ProviderAnswer> =>
    await providerRequest({
      fetch: doFetch,
      url: `${STRIPE_API}${path}`,
      method,
      headers: authHeaders(key, idempotencyKey),
      body: body ? form(body) : undefined,
      uncertainStatuses: [409],
    });

  return {
    name: STRIPE_PAYMENT_LINK_ADAPTER_NAME,
    effectClass: 'EXTERNAL_RECONCILABLE',
    namespace: options.namespace,
    validate: validatePaymentLinkPayload,
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
        return { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: `${STRIPE_KEY_ENV} is not configured, so nothing was sent` };
      }
      const [priceRequest, linkRequest] = paymentLinkRequests(request.payload, request.businessId);
      const price = await call(key, 'POST', priceRequest.path, priceRequest.body, priceRequest.idempotencyKey);
      if (price.kind !== 'OK') return refusalOf(price);
      const priceId = String(price.body.id ?? '');
      if (!priceId) return { kind: 'UNCERTAIN', reason: 'Stripe created a price and returned no id' };
      const body = Object.fromEntries(Object.entries(linkRequest.body).map(([k, v]) => [k, v === PRICE_PLACEHOLDER ? priceId : v]));
      const link = await call(key, 'POST', linkRequest.path, body, linkRequest.idempotencyKey);
      // A price alone takes no money: a refused link created nothing a buyer can pay.
      if (link.kind !== 'OK') return refusalOf(link);
      const linkId = String(link.body.id ?? '');
      const url = typeof link.body.url === 'string' ? link.body.url : null;
      if (!linkId || !url) return { kind: 'UNCERTAIN', reason: 'Stripe created a payment link and returned no id or url' };
      return { kind: 'CONFIRMED', receiptRef: linkId, receiptMeta: { provider: 'stripe', url } };
    },

    async reconcile(businessId: string): Promise<ReconcileOutcome> {
      const key = secretValue(STRIPE_KEY_ENV, env());
      if (!key) return { kind: 'INCONCLUSIVE', reason: `${STRIPE_KEY_ENV} is not configured` };
      const answer = await call(key, 'GET', '/v1/payment_links?limit=100');
      if (answer.kind !== 'OK') return { kind: 'INCONCLUSIVE', reason: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
      const data = Array.isArray(answer.body.data) ? (answer.body.data as Record<string, unknown>[]) : [];
      const found = data.find((one) => {
        const meta = one.metadata && typeof one.metadata === 'object' ? (one.metadata as Record<string, unknown>) : {};
        return meta[PAYMENT_LINK_METADATA] === businessId && typeof one.id === 'string';
      });
      if (found) {
        return { kind: 'FOUND', receiptRef: String(found.id), receiptMeta: { provider: 'stripe', url: typeof found.url === 'string' ? found.url : null } };
      }
      return { kind: 'INCONCLUSIVE', reason: "no payment link carrying this id is on the first page of Stripe's list, which is not evidence that none was created" };
    },

    redactReceipt: (meta) => ({
      provider: 'stripe',
      // A payment link's URL is public by design: it is what every recipient is sent.
      url: typeof meta.url === 'string' && /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_/-]{1,200}$/.test(meta.url) ? meta.url : null,
    }),
  };
}

/** One completed, paid checkout through a payment link, as Stripe states it. */
export interface LinkPayment {
  /** The PaymentIntent, else the Checkout Session: the provider's reference for this payment. */
  reference: string;
  sessionId: string;
  amountCents: number;
  currency: string;
  paidAt: string | null;
  /** Where the deliverable goes; null when Stripe recorded none. */
  buyerEmail: string | null;
}

/**
 * The paid checkouts a payment link has taken. A read, never an effect. Only
 * sessions Stripe reports `complete` and `paid` count, and only those whose
 * own `payment_link` is the link asked about.
 */
export async function readStripePaymentLinkPayments(
  linkId: string,
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<{ kind: 'READ'; payments: LinkPayment[]; complete: boolean } | { kind: 'UNREADABLE'; reason: string }> {
  const env = options.env ?? process.env;
  const key = secretValue(STRIPE_KEY_ENV, env);
  if (!key) return { kind: 'UNREADABLE', reason: `${STRIPE_KEY_ENV} is not configured` };
  if (!/^plink_[A-Za-z0-9]+$/.test(linkId)) return { kind: 'UNREADABLE', reason: 'that is not a payment link id' };
  const answer = await providerRequest({
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    url: `${STRIPE_API}/v1/checkout/sessions?payment_link=${encodeURIComponent(linkId)}&status=complete&limit=100`,
    method: 'GET',
    headers: authHeaders(key),
  });
  if (answer.kind !== 'OK') return { kind: 'UNREADABLE', reason: answer.kind === 'REFUSED' ? answer.detail : answer.reason };
  const data = Array.isArray(answer.body.data) ? (answer.body.data as Record<string, unknown>[]) : [];
  const payments: LinkPayment[] = [];
  for (const one of data) {
    if (one.payment_link !== linkId || one.status !== 'complete' || one.payment_status !== 'paid') continue;
    if (typeof one.id !== 'string' || typeof one.amount_total !== 'number' || one.amount_total <= 0) continue;
    const details = one.customer_details && typeof one.customer_details === 'object' ? (one.customer_details as Record<string, unknown>) : {};
    payments.push({
      reference: typeof one.payment_intent === 'string' ? one.payment_intent : one.id,
      sessionId: one.id,
      amountCents: one.amount_total,
      currency: String(one.currency ?? '').toUpperCase(),
      paidAt: isoFromSeconds(one.created),
      buyerEmail: typeof details.email === 'string' && ADDRESS.test(details.email) ? details.email : null,
    });
  }
  return { kind: 'READ', payments, complete: answer.body.has_more !== true };
}
