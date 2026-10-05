/**
 * The three commercial providers, against fake provider endpoints — never a
 * real buyer and never real money (§53).
 *
 * Every adapter here is the production adapter, built with an injected
 * `fetch` that plays the provider. So what is tested is the request Brain
 * actually builds, the classification it applies to what comes back, and the
 * effects engine's handling of it — not a test double's idea of those.
 *
 * For each provider the matrix is: SUCCESS, REFUSAL, TIMEOUT, LOST RESPONSE,
 * RETRY, RESTART, DUPLICATE REQUEST, RECOVERY, BAD CREDENTIAL, MISSING CONFIG —
 * and the property under all of them is that one logical attempt reaches the
 * provider's state-changing endpoint at most once.
 */
import { agree } from './helpers/cashDeal.ts';
import { transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import {
  CONTACT_BUYER_NAMESPACE,
  ISSUE_INVOICE_NAMESPACE,
  contactBuyerKey,
  sendContactBuyer,
  sendIssueInvoice,
} from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter } from '../server/services/effects/adapter.ts';
import { createResendAdapter } from '../server/services/cash/providers/resend.ts';
import { createStripeInvoiceAdapter, readStripeInvoice } from '../server/services/cash/providers/stripe.ts';
import { clearPaymentReader, registerPaymentReader } from '../server/services/cash/providers/payments.ts';
import type { FetchLike } from '../server/services/cash/providers/http.ts';
import { commercialProviderStatus } from '../server/services/cash/providers/status.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { requestInvoice, runInvoicing } from '../server/services/cash/invoicing.ts';
import { composeBuyerMessage, recipientFromChannel } from '../server/services/cash/outreach.ts';
import { getInvoice } from '../server/repos/cashInvoices.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';

const RESEND_KEY = 're_test_SECRETVALUE_never_stored_0001';
const STRIPE_KEY = 'sk_test_SECRETVALUE_never_stored_0002';

const MESSAGING_ENV = {
  BRAIN_MESSAGING_PROVIDER: 'resend',
  RESEND_API_KEY: RESEND_KEY,
  BRAIN_MESSAGING_FROM: 'Brain Sales <sales@brain.example>',
} as NodeJS.ProcessEnv;

const BILLING_ENV = {
  BRAIN_BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: STRIPE_KEY,
} as NodeJS.ProcessEnv;

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  clearPaymentReader();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `providers-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect(
    (
      await activate({
        projectId,
        ownerUserId: userId,
        actorUserId: userId,
        objective: 'Maximize additional usable cash over the next few weeks.',
      })
    ).ok,
  ).toBe(true);
});

async function granted(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/** Every value a test stored anywhere, as one string, to look for a key in. */
async function everythingStored(): Promise<string> {
  const tables = ['idempotency_operations', 'effect_attempts', 'cash_invoices', 'cash_money_entries', 'cash_actions', 'cash_events', 'cash_needs'];
  const out: string[] = [];
  for (const table of tables) out.push(JSON.stringify(await getDb().all(`SELECT * FROM ${table}`)));
  return out.join('\n');
}

/* ------------------------------------------------------------------------- */
/* A fake Resend                                                              */
/* ------------------------------------------------------------------------- */

type Behaviour = 'OK' | 'REFUSE_422' | 'BAD_KEY_401' | 'RATE_429' | 'TIMEOUT' | 'LOST' | 'SERVER_500';

function fakeResend(script: Behaviour[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, headers, body: JSON.parse(String(init.body ?? '{}')) });
    const behaviour = script[Math.min(calls.length - 1, script.length - 1)]!;
    switch (behaviour) {
      case 'OK':
        return new Response(JSON.stringify({ id: `email_${calls.length}` }), { status: 200 });
      case 'REFUSE_422':
        return new Response(JSON.stringify({ name: 'validation_error', message: `bad ${RESEND_KEY}` }), { status: 422 });
      case 'BAD_KEY_401':
        return new Response(JSON.stringify({ name: 'invalid_api_key', message: `key ${RESEND_KEY} invalid` }), { status: 401 });
      case 'RATE_429':
        return new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), { status: 429 });
      case 'SERVER_500':
        return new Response('oops', { status: 500 });
      case 'LOST':
        return new Response('{"id": "email_trunc', { status: 200 });
      case 'TIMEOUT': {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
    }
  };
  return { calls, fetchImpl };
}

function contactRequest(occurrence = '1') {
  return {
    occurrence,
    authorityId: 'cau_fixed',
    stateAtSend: 'READY',
    projectId,
    opportunityId: 'cop_fixed',
    payer: 'The operations manager',
    channel: 'ops@buyer.example',
    message: { to: 'ops@buyer.example', subject: 'Re: intake repair', text: 'We can do it for 1200.00 USD.' },
  };
}

function registerResend(fetchImpl: FetchLike, env: NodeJS.ProcessEnv = MESSAGING_ENV): void {
  registerAdapter(createResendAdapter({ fetch: fetchImpl, env, namespace: CONTACT_BUYER_NAMESPACE.name }));
}

describe('MESSAGING — Resend, one email to one published address', () => {
  it('SUCCESS: sends once, with the key as Idempotency-Key and the credential only in the header', async () => {
    const resend = fakeResend(['OK']);
    registerResend(resend.fetchImpl);
    const outcome = await sendContactBuyer(contactRequest());
    expect(outcome.status).toBe('CONFIRMED');
    expect(outcome.status === 'CONFIRMED' && outcome.receiptRef).toBe('email_1');
    expect(resend.calls).toHaveLength(1);
    const call = resend.calls[0]!;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.url).not.toContain(RESEND_KEY);
    expect(call.headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(call.headers['Idempotency-Key']).toBe(contactBuyerKey('cop_fixed', '1'));
    expect(call.body.to).toEqual(['ops@buyer.example']);
    expect(String((call.body.headers as Record<string, string>)['List-Unsubscribe'])).toContain('sales@brain.example');
    expect(await everythingStored()).not.toContain(RESEND_KEY);
  });

  it('DUPLICATE REQUEST: the same attempt twice, and concurrently, reaches the provider once', async () => {
    const resend = fakeResend(['OK']);
    registerResend(resend.fetchImpl);
    const [a, b] = await Promise.allSettled([sendContactBuyer(contactRequest()), sendContactBuyer(contactRequest())]);
    const third = await sendContactBuyer(contactRequest());
    expect(resend.calls).toHaveLength(1);
    expect([a.status, b.status]).toContain('fulfilled');
    expect(third.status).toBe('REPLAYED');
  });

  it('REFUSAL: a 422 is terminal, and a retry of that attempt sends nothing', async () => {
    const resend = fakeResend(['REFUSE_422', 'OK']);
    registerResend(resend.fetchImpl);
    expect((await sendContactBuyer(contactRequest())).status).toBe('FAILED');
    expect((await sendContactBuyer(contactRequest())).status).toBe('FAILED');
    expect(resend.calls).toHaveLength(1);
    expect(await everythingStored()).not.toContain(RESEND_KEY);
  });

  it('BAD CREDENTIAL: a 401 is NOT_AUTHORIZED and terminal, and the echoed key is stored nowhere', async () => {
    const resend = fakeResend(['BAD_KEY_401']);
    registerResend(resend.fetchImpl);
    const outcome = await sendContactBuyer(contactRequest());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.operation.failureCategory).toBe('NOT_AUTHORIZED');
    expect(await everythingStored()).not.toContain(RESEND_KEY);
  });

  it('RETRY: a 429 processed nothing, so the next attempt under the same key may send', async () => {
    const resend = fakeResend(['RATE_429', 'OK']);
    registerResend(resend.fetchImpl);
    expect((await sendContactBuyer(contactRequest())).status).toBe('FAILED');
    const second = await sendContactBuyer(contactRequest());
    expect(second.status).toBe('CONFIRMED');
    expect(resend.calls).toHaveLength(2);
    // Both requests carried the same Idempotency-Key, so even had the first
    // landed, Resend would have answered with the same email.
    expect(new Set(resend.calls.map((one) => one.headers['Idempotency-Key'])).size).toBe(1);
  });

  for (const behaviour of ['TIMEOUT', 'LOST', 'SERVER_500'] as const) {
    it(`${behaviour === 'LOST' ? 'LOST RESPONSE' : behaviour}: the outcome is UNCERTAIN and nothing ever resends it`, async () => {
      const resend = fakeResend([behaviour, 'OK']);
      registerResend(resend.fetchImpl);
      expect((await sendContactBuyer(contactRequest())).status).toBe('UNCERTAIN');
      expect((await sendContactBuyer(contactRequest())).status).toBe('UNCERTAIN');
      expect(resend.calls).toHaveLength(1);
    });
  }

  it('RESTART and RECOVERY: a fresh process with a fresh adapter still does not resend an unknown email', async () => {
    const before = fakeResend(['TIMEOUT']);
    registerResend(before.fetchImpl);
    expect((await sendContactBuyer(contactRequest())).status).toBe('UNCERTAIN');

    // The process restarts: the registry is rebuilt and the adapter is new.
    // Resend cannot be asked about the email, so the only honest recovery is
    // the one a person performs; the operation stays UNCERTAIN.
    clearAdapters();
    const after = fakeResend(['OK']);
    registerResend(after.fetchImpl);
    expect((await sendContactBuyer(contactRequest())).status).toBe('UNCERTAIN');
    expect(after.calls).toHaveLength(0);
  });

  it('MISSING CONFIG: registered without a key reads MISSING, names the setting, and never its value', async () => {
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('MISSING');
    registerResend(fakeResend(['OK']).fetchImpl, { BRAIN_MESSAGING_PROVIDER: 'resend' } as NodeJS.ProcessEnv);
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('MISSING');
    clearAdapters();
    registerResend(fakeResend(['OK']).fetchImpl);
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('PRESENT');

    // A deployment with nothing configured: no adapter registered, no setting.
    clearAdapters();
    const lines = await commercialProviderStatus({} as NodeJS.ProcessEnv);
    const messaging = lines.find((one) => one.area === 'MESSAGING')!;
    expect(messaging.state).toBe('MISSING');
    expect(messaging.nextAction).toContain('RESEND_API_KEY');
    expect(lines.map((one) => one.state)).toEqual(['MISSING', 'MISSING', 'MISSING']);

    // Configured and registered: CONNECTED, and still no value anywhere.
    registerResend(fakeResend(['OK']).fetchImpl);
    const connected = await commercialProviderStatus(MESSAGING_ENV);
    expect(connected.find((one) => one.area === 'MESSAGING')!.state).toBe('CONNECTED');
    expect(JSON.stringify(connected)).not.toContain(RESEND_KEY);
  });

  it('refuses more than one recipient before building any request', async () => {
    const resend = fakeResend(['OK']);
    registerResend(resend.fetchImpl);
    const request = contactRequest();
    await expect(
      sendContactBuyer({ ...request, message: { ...request.message, to: 'a@x.example, b@y.example' } }),
    ).rejects.toThrow();
    expect(resend.calls).toHaveLength(0);
  });
});

describe('MESSAGING — the message is the card, never an invention', () => {
  it('reads exactly one published address and refuses none or two', () => {
    expect(recipientFromChannel('Email ops@buyer.example about the notice')).toEqual({ ok: true, to: 'ops@buyer.example' });
    expect(recipientFromChannel('The address on the notice').ok).toBe(false);
    expect(recipientFromChannel('a@x.example or b@y.example').ok).toBe(false);
  });

  it('composes the offer, price and an opt-out from the card', async () => {
    const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Intake repair', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
    if (!captured.ok) throw new Error(captured.reason);
    const piece = {
      ...(await getOpportunity(captured.value.id))!,
      payer: 'The operations manager',
      reachableChannel: 'ops@buyer.example',
      offerScope: 'Repair the intake valve within a week.',
      priceCents: 120_000,
    };
    const message = composeBuyerMessage(piece);
    expect(message.ok).toBe(true);
    if (!message.ok) return;
    expect(message.to).toBe('ops@buyer.example');
    expect(message.text).toContain('Repair the intake valve within a week.');
    expect(message.text).toContain('1200.00 USD');
    expect(message.text).toContain('no thanks');
    expect(composeBuyerMessage({ ...piece, priceCents: null }).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* A fake Stripe                                                              */
/* ------------------------------------------------------------------------- */

interface StripeInvoice {
  id: string;
  status: string;
  metadata: Record<string, string>;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string;
  number: string;
  charge: Record<string, unknown> | null;
  status_transitions: { paid_at: number | null };
}

function fakeStripe() {
  const state = {
    invoices: new Map<string, StripeInvoice>(),
    idempotency: new Map<string, unknown>(),
    posts: [] as { path: string; key: string | undefined }[],
    reads: 0,
    /** Answer this path with this behaviour once, then behave. */
    failOnce: new Map<string, Behaviour>(),
    searchLags: false,
    badKey: false,
  };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    expect(url).not.toContain(STRIPE_KEY);
    expect(headers['Stripe-Version']).toBe('2024-06-20');
    if (state.badKey) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'api_key_invalid' } }), { status: 401 });
    const path = new URL(url).pathname;
    if (init.method === 'GET') {
      state.reads += 1;
      if (path === '/v1/invoices/search') {
        if (state.searchLags) return ok({ data: [] });
        const query = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
        const id = /'([^']+)'$/.exec(query)?.[1];
        return ok({ data: [...state.invoices.values()].filter((one) => one.metadata.brain_invoice === id) });
      }
      const invoice = state.invoices.get(path.split('/').pop()!);
      return invoice ? ok(invoice) : new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }), { status: 404 });
    }

    const key = headers['Idempotency-Key'];
    state.posts.push({ path, key });
    const scripted = state.failOnce.get(path);
    if (scripted) state.failOnce.delete(path);
    if (scripted === 'REFUSE_422') return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'parameter_invalid' } }), { status: 400 });

    // Stripe's own idempotency: a repeated key returns the stored response.
    if (key && state.idempotency.has(key)) return ok(state.idempotency.get(key));
    const params = new URLSearchParams(String(init.body ?? ''));
    let body: unknown;
    if (path === '/v1/customers') body = { id: `cus_${state.posts.length}` };
    else if (path === '/v1/invoices') {
      const id = `in_${state.invoices.size + 1}`;
      const invoice: StripeInvoice = {
        id,
        status: 'draft',
        metadata: { brain_invoice: params.get('metadata[brain_invoice]') ?? '' },
        amount_paid: 0,
        currency: params.get('currency') ?? 'usd',
        hosted_invoice_url: `https://invoice.stripe.example/${id}`,
        number: `N-${id}`,
        charge: null,
        status_transitions: { paid_at: null },
      };
      state.invoices.set(id, invoice);
      body = invoice;
    } else if (path === '/v1/invoiceitems') body = { id: 'ii_1' };
    else {
      const id = path.split('/')[3]!;
      const invoice = state.invoices.get(id)!;
      invoice.status = 'open';
      body = invoice;
    }
    if (key) state.idempotency.set(key, body);
    // A scripted transport failure happens *after* Stripe acted, which is
    // exactly the case that makes a timeout not evidence of nothing.
    if (scripted === 'TIMEOUT') {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    if (scripted === 'LOST') return new Response('{"id":', { status: 200 });
    return ok(body);
  };

  function pay(id: string, balance: 'pending' | 'available' | null) {
    const invoice = state.invoices.get(id)!;
    invoice.status = 'paid';
    invoice.amount_paid = 120_000;
    invoice.status_transitions.paid_at = 1_790_000_000;
    invoice.charge = {
      id: 'ch_1',
      balance_transaction: balance
        ? { id: 'txn_1', status: balance, amount: 120_000, fee: 3_510, currency: 'usd', available_on: 1_790_500_000 }
        : null,
    };
  }

  return { state, fetchImpl, pay };
}

const INVOICE_REQUEST = (invoiceId: string) => ({
  projectId,
  invoiceId,
  amountCents: 120_000,
  currency: 'USD',
  customerEmail: 'accounts@buyer.example',
  customerName: 'Buyer Ltd',
  taxTreatment: 'NO_TAX_CHARGED',
  dueDate: '2099-01-31',
  description: 'Repair the intake valve.',
});

function registerStripe(fetchImpl: FetchLike, env: NodeJS.ProcessEnv = BILLING_ENV): void {
  registerAdapter(createStripeInvoiceAdapter({ fetch: fetchImpl, env, namespace: ISSUE_INVOICE_NAMESPACE.name }));
  registerPaymentReader({
    name: 'stripe.test',
    provider: 'stripe',
    health: () => ({ usable: !!env.STRIPE_SECRET_KEY, reason: 'test' }),
    read: (id) => readStripeInvoice(id, { fetch: fetchImpl, env }),
  });
}

const STATE_CHANGING = (posts: { path: string }[]) => posts.filter((one) => one.path === '/v1/invoices').length;

describe('INVOICING — Stripe, one invoice per agreed amount', () => {
  it('SUCCESS: customer, draft, line, finalize, send — each with its own stable key', async () => {
    const stripe = fakeStripe();
    registerStripe(stripe.fetchImpl);
    expect((await readCapability('ISSUE_AN_INVOICE')).state).toBe('PRESENT');
    const outcome = await sendIssueInvoice(INVOICE_REQUEST('cin_one'));
    expect(outcome.status).toBe('CONFIRMED');
    expect(outcome.status === 'CONFIRMED' && outcome.receiptRef).toBe('in_1');
    expect(stripe.state.posts.map((one) => one.path)).toEqual([
      '/v1/customers',
      '/v1/invoices',
      '/v1/invoiceitems',
      '/v1/invoices/in_1/finalize',
      '/v1/invoices/in_1/send',
    ]);
    expect(stripe.state.posts.every((one) => one.key?.startsWith('brain-cin_one-'))).toBe(true);
    expect(stripe.state.invoices.get('in_1')!.status).toBe('open');
    expect(await everythingStored()).not.toContain(STRIPE_KEY);
  });

  it('DUPLICATE REQUEST: the same invoice twice is one invoice', async () => {
    const stripe = fakeStripe();
    registerStripe(stripe.fetchImpl);
    await sendIssueInvoice(INVOICE_REQUEST('cin_dup'));
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_dup'))).status).toBe('REPLAYED');
    expect(stripe.state.invoices.size).toBe(1);
    expect(STATE_CHANGING(stripe.state.posts)).toBe(1);
  });

  it('REFUSAL: a 400 is terminal and a retry sends nothing', async () => {
    const stripe = fakeStripe();
    stripe.state.failOnce.set('/v1/customers', 'REFUSE_422');
    registerStripe(stripe.fetchImpl);
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_bad'))).status).toBe('FAILED');
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_bad'))).status).toBe('FAILED');
    expect(stripe.state.posts).toHaveLength(1);
  });

  it('BAD CREDENTIAL: a 401 is NOT_AUTHORIZED, and the key is stored nowhere', async () => {
    const stripe = fakeStripe();
    stripe.state.badKey = true;
    registerStripe(stripe.fetchImpl);
    const outcome = await sendIssueInvoice(INVOICE_REQUEST('cin_key'));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.operation.failureCategory).toBe('NOT_AUTHORIZED');
    expect(await everythingStored()).not.toContain(STRIPE_KEY);
  });

  it('TIMEOUT and RECOVERY: Stripe acted, the reply was lost, and Brain asks instead of resending', async () => {
    const stripe = fakeStripe();
    stripe.state.failOnce.set('/v1/invoices/in_1/finalize', 'TIMEOUT');
    registerStripe(stripe.fetchImpl);
    // Stripe finalized the invoice and the reply never arrived. The search
    // finds it as open, so the engine records the provider's own answer.
    const outcome = await sendIssueInvoice(INVOICE_REQUEST('cin_timeout'));
    expect(outcome.status).toBe('RECONCILED');
    expect(outcome.status === 'RECONCILED' && outcome.receiptRef).toBe('in_1');
    expect(STATE_CHANGING(stripe.state.posts)).toBe(1);
  });

  it('LOST RESPONSE, then RESTART: an empty search is not "nothing happened", and a later process recovers it', async () => {
    const stripe = fakeStripe();
    stripe.state.failOnce.set('/v1/invoices/in_1/send', 'LOST');
    stripe.state.searchLags = true;
    registerStripe(stripe.fetchImpl);
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_lost'))).status).toBe('UNCERTAIN');
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_lost'))).status).toBe('UNCERTAIN');

    // A restart: a fresh registry, and Stripe's index has caught up.
    clearAdapters();
    stripe.state.searchLags = false;
    registerStripe(stripe.fetchImpl);
    const recovered = await sendIssueInvoice(INVOICE_REQUEST('cin_lost'));
    expect(recovered.status).toBe('RECONCILED');
    expect(STATE_CHANGING(stripe.state.posts)).toBe(1);
    expect(stripe.state.invoices.size).toBe(1);
  });

  it('RETRY: a 429 processed nothing, so the same invoice may go on a later attempt', async () => {
    const stripe = fakeStripe();
    let first = true;
    const limited: FetchLike = async (url, init) => {
      if (first && init.method === 'POST') {
        first = false;
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429 });
      }
      return await stripe.fetchImpl(url, init);
    };
    registerStripe(limited);
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_rate'))).status).toBe('FAILED');
    expect((await sendIssueInvoice(INVOICE_REQUEST('cin_rate'))).status).toBe('CONFIRMED');
    expect(stripe.state.invoices.size).toBe(1);
  });

  it('MISSING CONFIG: an unchosen or keyless provider reads MISSING, and boot registers nothing unchosen', async () => {
    expect((await readCapability('ISSUE_AN_INVOICE')).state).toBe('MISSING');
    expect((await readCapability('TAKE_A_PAYMENT')).state).toBe('MISSING');
    expect(registerCommercialProviders({} as NodeJS.ProcessEnv)).toEqual({ messaging: null, billing: null });
    expect((await readCapability('ISSUE_AN_INVOICE')).state).toBe('MISSING');
    registerStripe(fakeStripe().fetchImpl, { BRAIN_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'not-a-key' } as NodeJS.ProcessEnv);
    expect((await readCapability('ISSUE_AN_INVOICE')).state).toBe('MISSING');
  });
});

/* ------------------------------------------------------------------------- */
/* The whole journey through the tick: request → issue → paid → settled       */
/* ------------------------------------------------------------------------- */

async function agreedOpportunity(): Promise<string> {
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Intake repair', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  // An invoice bills an agreement (amount, deliverable, acceptance, evidence),
  // and an agreement follows a real action — so the fixture puts the piece
  // where an agreement can exist, and records one through the real service.
  await transitionOpportunity({ id: captured.value.id, from: ['DISCOVERED'], to: 'EXECUTING' });
  await agree(captured.value.id, 120_000, userId);
  return captured.value.id;
}

const TERMS = { customerName: 'Buyer Ltd', customerEmail: 'accounts@buyer.example', taxTreatment: 'NO_TAX_CHARGED', dueDate: '2099-01-31' };

describe('PAYMENTS — a payment and a settlement are two entries, each recorded once', () => {
  it('Brain invents no term: no agreed amount, no tax treatment, a past due date are each refused', async () => {
    const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Nothing agreed', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
    if (!captured.ok) throw new Error(captured.reason);
    const none = await requestInvoice({ projectId, opportunityId: captured.value.id, actorRef: userId, ...TERMS });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toContain('Record the agreement');

    const opportunityId = await agreedOpportunity();
    expect((await requestInvoice({ projectId, opportunityId, actorRef: userId, ...TERMS, taxTreatment: 'SOME_TAX' })).ok).toBe(false);
    expect((await requestInvoice({ projectId, opportunityId, actorRef: userId, ...TERMS, dueDate: '2001-01-01' })).ok).toBe(false);
  });

  it('without authority or a provider the draft waits, saying why, and nothing is sent', async () => {
    const opportunityId = await agreedOpportunity();
    const drafted = await requestInvoice({ projectId, opportunityId, actorRef: userId, ...TERMS });
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    const stripe = fakeStripe();
    registerStripe(stripe.fetchImpl);
    let pass = await runInvoicing(projectId);
    expect(pass.withheld[0]!.because).toContain('QUOTE_AND_INVOICE');
    expect(stripe.state.posts).toHaveLength(0);

    await granted();
    clearAdapters();
    clearPaymentReader();
    pass = await runInvoicing(projectId);
    expect(pass.withheld[0]!.because).toContain('ISSUE_AN_INVOICE');
    expect((await getInvoice(drafted.value.id))!.state).toBe('DRAFTED');
  });

  it('issues, reads paid → CUSTOMER_PAYMENT, reads available → SETTLEMENT and the fee, once each', async () => {
    await granted();
    const opportunityId = await agreedOpportunity();
    const stripe = fakeStripe();
    registerStripe(stripe.fetchImpl);
    const drafted = await requestInvoice({ projectId, opportunityId, actorRef: userId, ...TERMS });
    if (!drafted.ok) throw new Error(drafted.reason);
    // The amount is the agreed entry's, never chosen here.
    expect(drafted.value.amountCents).toBe(120_000);

    let now = new Date('2026-10-04T12:00:00Z');
    const minutes = (n: number) => (now = new Date(now.getTime() + n * 60_000));
    let pass = await runInvoicing(projectId, now);
    expect(pass.issued).toEqual([drafted.value.id]);
    let invoice = (await getInvoice(drafted.value.id))!;
    expect(invoice.state).toBe('ISSUED');
    expect(invoice.providerInvoiceId).toBe('in_1');
    expect(invoice.hostedUrl).toBe('https://invoice.stripe.example/in_1');

    // Open and unpaid: nothing recorded.
    pass = await runInvoicing(projectId, minutes(10));
    expect(pass.paid).toEqual([]);

    // Paid, funds pending: a payment, and no settlement.
    stripe.pay('in_1', 'pending');
    pass = await runInvoicing(projectId, minutes(10));
    expect(pass.paid).toEqual([drafted.value.id]);
    let entries = await listMoneyEntries({ projectId, opportunityId });
    expect(entries.filter((one) => one.kind === 'CUSTOMER_PAYMENT')).toHaveLength(1);
    expect(entries.filter((one) => one.kind === 'SETTLEMENT')).toHaveLength(0);
    let position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.customerPaymentsCents).toBe(120_000);
    expect(position.availableFundsCents).toBe(0);

    // Available: the settlement for the gross, the fee as a cost, once.
    stripe.pay('in_1', 'available');
    pass = await runInvoicing(projectId, minutes(10));
    expect(pass.settled).toEqual([drafted.value.id]);
    await runInvoicing(projectId, minutes(10));
    await runInvoicing(projectId, minutes(10));
    entries = await listMoneyEntries({ projectId, opportunityId });
    expect(entries.filter((one) => one.kind === 'CUSTOMER_PAYMENT')).toHaveLength(1);
    expect(entries.filter((one) => one.kind === 'SETTLEMENT')).toHaveLength(1);
    expect(entries.filter((one) => one.kind === 'COST')).toHaveLength(1);
    position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.availableFundsCents).toBe(120_000 - 3_510);

    invoice = (await getInvoice(drafted.value.id))!;
    expect(invoice.state).toBe('SETTLED');
    expect(STATE_CHANGING(stripe.state.posts)).toBe(1);
    expect(await everythingStored()).not.toContain(STRIPE_KEY);
  });

  it('an uncertain issue is asked about on the next pass, never sent again', async () => {
    await granted();
    const opportunityId = await agreedOpportunity();
    const stripe = fakeStripe();
    stripe.state.failOnce.set('/v1/invoices/in_1/send', 'LOST');
    stripe.state.searchLags = true;
    registerStripe(stripe.fetchImpl);
    const drafted = await requestInvoice({ projectId, opportunityId, actorRef: userId, ...TERMS });
    if (!drafted.ok) throw new Error(drafted.reason);

    let pass = await runInvoicing(projectId);
    expect(pass.uncertain).toEqual([drafted.value.id]);
    expect((await getInvoice(drafted.value.id))!.state).toBe('UNCERTAIN');

    stripe.state.searchLags = false;
    pass = await runInvoicing(projectId);
    expect(pass.issued).toEqual([drafted.value.id]);
    expect((await getInvoice(drafted.value.id))!.state).toBe('ISSUED');
    expect(STATE_CHANGING(stripe.state.posts)).toBe(1);
  });
});
