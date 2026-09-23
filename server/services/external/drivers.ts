/**
 * The providers Brain can act through, and the promise each can honestly keep.
 *
 * Three, chosen from what the live objective actually hits first rather than
 * from what is fashionable:
 *
 *   NTFY    a push message to the owner's own phone. Self-directed only: its
 *           topic IS its credential, so there is no third party it can reach
 *           that the owner did not subscribe. It is what lets "a decision is
 *           waiting for you" leave Brain at all, and it is the one provider in
 *           this file that needs no account to prove against.
 *
 *   RESEND  email, which is how every buyer on the cash card is reached. It
 *           takes an `Idempotency-Key`, so it is `EXTERNAL_IDEMPOTENT` and a
 *           retry under the same key cannot send twice.
 *
 *   STRIPE  an invoice a buyer can pay, and the three facts after it that must
 *           not be one fact: the invoice was ISSUED, a payment was MADE, and
 *           the funds SETTLED. Also idempotent by key.
 *
 * Nothing here publishes an offer or signs anything. `PUBLISH_EXTERNALLY` and
 * `IDENTITY_BEARING_ACT` are in `ALWAYS_PROHIBITED_COMMERCIAL`, and a connector
 * does not change what a grant may carry (§51).
 *
 * **The credential is read from the deployment, by name, at the moment it is
 * used**, and never stored, logged or returned — the fleet's rule for a
 * Routine's bearer (§23), one table along. A reading of it leaves this file
 * only as a sha-256 digest, which is how a rotated secret is noticed.
 */
import crypto from 'node:crypto';
import type {
  ExternalAction,
  ExternalActionKind,
  ExternalConnection,
  ExternalProvider,
} from '../../domain/types.ts';
import type { EffectAdapter, SendOutcome, ReconcileOutcome } from '../effects/adapter.ts';
import { ProviderTransportError, providerErrorCode, providerRequest } from './http.ts';

export interface HealthReading {
  ok: boolean;
  mode: 'TEST' | 'LIVE' | null;
  /** Safe to show. Never the credential, never a URL. */
  detail: string;
}

export interface Readback {
  /** The provider's state, in Brain's words. */
  state: string;
  detail: string;
  /** True when nothing further will change on the provider's side. */
  final: boolean;
  /** For an invoice: the payment facts, each kept apart. */
  money?: {
    paidCents: number | null;
    settled: boolean;
    /** The balance transaction's id: what makes a settlement verifiable. */
    reference: string | null;
    /** What the provider kept, and what reached the balance. Null until known. */
    feeCents?: number | null;
    netCents?: number | null;
    /**
     * Whether the provider says this object is real money. A test-mode
     * invoice is never a ledger fact, whatever the connection reads.
     */
    livemode: boolean;
  };
}

export interface ProviderDriver {
  provider: ExternalProvider;
  /** The capability ids a healthy LIVE connection makes present. */
  capabilities: readonly string[];
  kinds: readonly ExternalActionKind[];
  title: string;
  /** What connecting it lets Brain do, and what it does not. */
  does: string;
  /** What the deployment secret must hold, described without an example value. */
  secretShape: string;
  /**
   * How long the provider honours an idempotency key, or null when the send is
   * reconciled by asking rather than by a key. Past it, repeating the same key
   * is a second effect, so Brain stops at UNCERTAIN instead of resending.
   */
  keyWindowMs: number | null;
  /** The steps a person takes, in order. */
  setup: readonly string[];
  check(secret: string): Promise<HealthReading>;
  adapter(context: { secret: string; connection: ExternalConnection; action: ExternalAction }): EffectAdapter;
  readback(context: { secret: string; connection: ExternalConnection; action: ExternalAction }): Promise<Readback>;
}

export function credentialDigest(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A tag that lets an action be found again on the provider without naming it. */
export function businessTag(businessId: string): string {
  return 'brn-' + crypto.createHash('sha256').update(businessId, 'utf8').digest('hex').slice(0, 16);
}

function rejected(
  status: number,
  json: unknown,
  retryable: boolean,
  operation: string,
): SendOutcome {
  const code = providerErrorCode(json);
  return {
    kind: 'REJECTED',
    category: status === 401 || status === 403 ? 'NOT_AUTHORIZED' : 'PROVIDER_REJECTED',
    retryable,
    detail: `${operation} answered HTTP ${status}${code ? ` (${code})` : ''}`,
  };
}

/* ------------------------------------------------------------------------- */
/* ntfy                                                                       */
/* ------------------------------------------------------------------------- */

const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

/**
 * `topic`, or `https://server/topic` for a self-hosted server.
 *
 * At least sixteen characters, because the topic is the only thing keeping a
 * public ntfy topic private: a short one is a guessable one, and a guessable
 * one is a message anybody can read.
 */
function parseNtfy(secret: string): { server: string; topic: string } | null {
  const value = secret.trim();
  let server = NTFY_DEFAULT_SERVER;
  let topic = value;
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      server = `${url.protocol}//${url.host}`;
      topic = url.pathname.replace(/^\/+|\/+$/g, '');
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(topic)) return null;
  return { server, topic };
}

interface NtfyMessage {
  id?: string;
  time?: number;
  event?: string;
  tags?: string[];
}

async function ntfyPoll(secret: string, since: string): Promise<NtfyMessage[] | null> {
  const parsed = parseNtfy(secret);
  if (!parsed) return null;
  const reply = await providerRequest({
    provider: 'ntfy',
    operation: 'read back',
    url: `${parsed.server}/${parsed.topic}/json?poll=1&since=${encodeURIComponent(since)}`,
    method: 'GET',
  });
  if (reply.status !== 200) return null;
  return reply.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as NtfyMessage;
      } catch {
        return {} as NtfyMessage;
      }
    })
    .filter((one) => one.event === 'message');
}

/**
 * The identifier names an object this action did not make.
 *
 * Reachable when a person resolves an UNCERTAIN send as having happened and
 * supplies an identifier: that is a claim, and the read-back is what tests it.
 * Every send tags its object with this action's business tag (or, for email,
 * is addressed to this action's recipient), so an object without it is some
 * other message, email or invoice — and reading its state, let alone its money,
 * onto this action would be recording somebody else's effect as this one.
 */
function notThisAction(what: string, ref: string | null): Readback {
  return {
    state: 'NOT_THIS_ACTION',
    detail: `The ${what} ${ref ?? ''} exists but was not made by this action, so nothing about it is recorded here.`,
    final: true,
  };
}

export const NTFY_DRIVER: ProviderDriver = {
  provider: 'NTFY',
  capabilities: ['NOTIFY_OWNER'],
  kinds: ['NOTIFY_OWNER'],
  title: 'Push messages to your own phone (ntfy)',
  does:
    'Lets Brain tell you, on your phone, when a decision is waiting or an action finished. It ' +
    'can only reach whoever subscribed to your private topic, so it never contacts a third party.',
  secretShape:
    'A private topic name of 16–64 letters, digits, dashes or underscores (or https://your-server/topic ' +
    'for a self-hosted ntfy). The topic is the password: anyone who knows it can read the messages.',
  setup: [
    'Install the ntfy app on your phone and subscribe to a new topic with a long random name.',
    'Set that topic as the deployment secret named below (flyctl secrets set NAME=topic). It is never typed into Brain.',
    'Press Check. Brain reads the server’s health; the first message it sends is read back from the topic to prove delivery.',
  ],
  // Reconciled by reading the topic, never by a key.
  keyWindowMs: null,
  async check(secret) {
    const parsed = parseNtfy(secret);
    if (!parsed) {
      return {
        ok: false,
        mode: null,
        detail: 'The secret is not a usable topic: it needs 16–64 letters, digits, dashes or underscores.',
      };
    }
    try {
      const reply = await providerRequest({
        provider: 'ntfy',
        operation: 'health',
        url: `${parsed.server}/v1/health`,
        method: 'GET',
      });
      const healthy =
        reply.status === 200 &&
        !!reply.json &&
        typeof reply.json === 'object' &&
        (reply.json as Record<string, unknown>)['healthy'] === true;
      return healthy
        ? { ok: true, mode: 'LIVE', detail: 'The ntfy server answered healthy, and the topic is well formed.' }
        : { ok: false, mode: null, detail: `The ntfy server answered HTTP ${reply.status}, not healthy.` };
    } catch (error) {
      return {
        ok: false,
        mode: null,
        detail: error instanceof ProviderTransportError ? error.message : 'The ntfy server could not be reached.',
      };
    }
  },
  adapter({ secret, action }) {
    const parsed = parseNtfy(secret);
    return {
      name: 'ntfy.publish',
      effectClass: 'EXTERNAL_RECONCILABLE',
      namespace: 'external.notify',
      validate(payload) {
        if (!parsed) throw new Error('The ntfy connection has no usable topic.');
        return payload as Record<string, unknown>;
      },
      fingerprintInputs: (payload) => payload,
      async send(request) {
        try {
          const reply = await providerRequest({
            provider: 'ntfy',
            operation: 'publish',
            url: `${parsed!.server}/`,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The topic travels in the body, not the URL, on the send path.
            body: JSON.stringify({
              topic: parsed!.topic,
              title: String(action.content.subject ?? 'Brain').slice(0, 200),
              message: String(action.content.body ?? '').slice(0, 3_500),
              tags: [businessTag(request.businessId)],
            }),
          });
          if (reply.status === 200 && reply.json && typeof reply.json === 'object') {
            const id = (reply.json as NtfyMessage).id;
            if (typeof id === 'string' && id) {
              return { kind: 'CONFIRMED', receiptRef: id, receiptMeta: { provider: 'ntfy' } };
            }
          }
          if (reply.status === 429) return rejected(429, reply.json, true, 'ntfy publish');
          if (reply.status >= 500) return { kind: 'UNCERTAIN', reason: `ntfy publish answered HTTP ${reply.status}` };
          return rejected(reply.status, reply.json, false, 'ntfy publish');
        } catch (error) {
          return { kind: 'UNCERTAIN', reason: error instanceof Error ? error.message : 'ntfy publish failed' };
        }
      },
      /*
       * Asked about THIS action, whatever the engine passes.
       *
       * The engine's two resume paths hand `reconcile` the operation id rather
       * than the business id the send was tagged with. Matching on the
       * argument would search for a tag nothing ever carried, answer ABSENT,
       * and let a message that did arrive be sent again — the one error this
       * class exists to prevent. The adapter is built per action, so the
       * action it is about is in scope and is the only honest thing to ask.
       */
      async reconcile(): Promise<ReconcileOutcome> {
        const businessId = action.id;
        try {
          const messages = await ntfyPoll(secret, '12h');
          if (messages === null) return { kind: 'INCONCLUSIVE', reason: 'the topic could not be read back' };
          const tag = businessTag(businessId);
          const found = messages.find((one) => one.tags?.includes(tag) && typeof one.id === 'string');
          /*
           * Never ABSENT. ntfy writes to its cache a moment after it answers a
           * publish — measured at about a second on 2026-09-23 — so "not in
           * the topic yet" is not evidence it never arrived, and ABSENT is the
           * answer that licenses a resend. Not found stays inconclusive, the
           * action stays UNCERTAIN, and the next tick asks again.
           */
          return found
            ? { kind: 'FOUND', receiptRef: found.id! }
            : { kind: 'INCONCLUSIVE', reason: 'not visible in the topic yet' };
        } catch {
          return { kind: 'INCONCLUSIVE', reason: 'the topic could not be read back' };
        }
      },
    };
  },
  async readback({ secret, action }) {
    const messages = await ntfyPoll(secret, '12h');
    if (messages === null) {
      return { state: 'UNREADABLE', detail: 'The topic could not be read back just now.', final: false };
    }
    const found = messages.find((one) => one.id === action.providerRef);
    if (found && !found.tags?.includes(businessTag(action.id))) {
      return notThisAction('ntfy message', action.providerRef);
    }
    if (found) {
      return {
        state: 'PUBLISHED',
        detail:
          `Read back from the topic: message ${found.id} is there` +
          (found.time ? `, published at ${new Date(found.time * 1000).toISOString()}` : '') +
          '. ntfy does not report whether a phone displayed it.',
        final: true,
      };
    }
    const age = Date.now() - Date.parse(action.updatedAt);
    return age > 11 * 3600_000
      ? { state: 'NOT_READABLE_ANY_MORE', detail: 'The topic keeps twelve hours of messages and this one is older than that.', final: true }
      : { state: 'NOT_VISIBLE_YET', detail: 'The provider accepted it, and it is not yet visible when the topic is read.', final: false };
  },
};

/* ------------------------------------------------------------------------- */
/* Resend                                                                     */
/* ------------------------------------------------------------------------- */

const RESEND_API = 'https://api.resend.com';

function resendHeaders(secret: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...extra };
}

export const RESEND_DRIVER: ProviderDriver = {
  provider: 'RESEND',
  capabilities: ['SEND_A_MESSAGE'],
  kinds: ['SEND_EMAIL'],
  title: 'Email (Resend)',
  does:
    'Lets Brain send an email a person approved, from an address on a domain you verified, and ' +
    'read back whether it was delivered. It does not let Brain contact anybody on its own: every ' +
    'email to somebody other than you waits for your approval, and contacting a buyer also needs ' +
    'a standing commercial authority that covers it.',
  secretShape: 'A Resend API key (it starts re_). A sending-only key is enough.',
  setup: [
    'Create a Resend account and verify the domain you will send from.',
    'Create an API key, and set it as the deployment secret named below. It is never typed into Brain.',
    'Enter the From address on that domain, and your own address as the self-test destination.',
    'Press Check. Brain calls Resend with the key and records what it answered.',
  ],
  // Resend de-duplicates an Idempotency-Key for 24 hours.
  keyWindowMs: 24 * 3600_000,
  async check(secret) {
    if (!/^re_[A-Za-z0-9_]{8,}$/.test(secret.trim())) {
      return { ok: false, mode: null, detail: 'The secret does not have the shape of a Resend API key.' };
    }
    try {
      const reply = await providerRequest({
        provider: 'resend',
        operation: 'check',
        url: `${RESEND_API}/domains`,
        method: 'GET',
        headers: resendHeaders(secret.trim()),
      });
      if (reply.status === 200) {
        const data = (reply.json as { data?: Array<{ status?: string }> } | null)?.data ?? [];
        const verified = data.filter((one) => one.status === 'verified').length;
        return verified > 0
          ? { ok: true, mode: 'LIVE', detail: `Resend accepted the key; ${verified} verified sending domain(s).` }
          : { ok: false, mode: 'LIVE', detail: 'Resend accepted the key, and no sending domain is verified yet.' };
      }
      // A sending-only key cannot list domains; Resend says so by name.
      if (reply.status === 401 && providerErrorCode(reply.json) === 'restricted_api_key') {
        return {
          ok: true,
          mode: 'LIVE',
          detail: 'Resend accepted a sending-only key. Domain verification is not readable with it and is proved by the first delivery read back.',
        };
      }
      return { ok: false, mode: null, detail: `Resend answered HTTP ${reply.status}${providerErrorCode(reply.json) ? ` (${providerErrorCode(reply.json)})` : ''}.` };
    } catch (error) {
      return { ok: false, mode: null, detail: error instanceof Error ? error.message : 'Resend could not be reached.' };
    }
  },
  adapter({ secret, connection, action }) {
    return {
      name: 'resend.email',
      effectClass: 'EXTERNAL_IDEMPOTENT',
      namespace: 'external.email',
      providerKeyLimit: 256,
      validate(payload) {
        if (!connection.sender) throw new Error('The email connection has no From address.');
        return payload as Record<string, unknown>;
      },
      fingerprintInputs: (payload) => payload,
      async send(request) {
        try {
          const reply = await providerRequest({
            provider: 'resend',
            operation: 'send',
            url: `${RESEND_API}/emails`,
            method: 'POST',
            headers: resendHeaders(secret.trim(), { 'idempotency-key': request.providerKey ?? '' }),
            body: JSON.stringify({
              from: connection.sender,
              to: [action.destination],
              subject: String(action.content.subject ?? ''),
              text: String(action.content.body ?? ''),
              tags: [{ name: 'brain', value: businessTag(request.businessId) }],
            }),
          });
          const id = (reply.json as { id?: string } | null)?.id;
          if (reply.status === 200 && typeof id === 'string') {
            return { kind: 'CONFIRMED', receiptRef: id, receiptMeta: { provider: 'resend' } };
          }
          // Same key, so repeating is safe: Resend de-duplicates on it for 24h.
          if (reply.status === 429 || reply.status >= 500 || reply.status === 409) {
            return rejected(reply.status, reply.json, true, 'Resend send');
          }
          return rejected(reply.status, reply.json, false, 'Resend send');
        } catch (error) {
          // Native idempotency is exactly what makes this repeatable: the same
          // key resent inside Resend's window returns the original email.
          return {
            kind: 'REJECTED',
            category: 'TIMEOUT',
            retryable: true,
            detail: `${error instanceof Error ? error.message : 'no reply'}; safe to repeat under the same idempotency key`,
          };
        }
      },
    };
  },
  async readback({ secret, action }) {
    const reply = await providerRequest({
      provider: 'resend',
      operation: 'read back',
      url: `${RESEND_API}/emails/${encodeURIComponent(action.providerRef ?? '')}`,
      method: 'GET',
      headers: resendHeaders(secret.trim()),
    });
    if (reply.status !== 200) {
      return { state: 'UNREADABLE', detail: `Resend answered HTTP ${reply.status} when asked.`, final: false };
    }
    const email = reply.json as { last_event?: string; to?: string[] | string } | null;
    const to = (Array.isArray(email?.to) ? email!.to : [email?.to ?? '']).map((one) => String(one).toLowerCase());
    if (!to.includes(action.destination.toLowerCase())) return notThisAction('Resend email', action.providerRef);
    return resendReading(String(email?.last_event ?? 'unknown'));
  },
};

/**
 * What Resend's last event establishes, in Brain's words.
 *
 * The one distinction this exists for: Resend accepting an email is not the
 * email arriving. `sent` means Resend handed it to the receiving server's
 * queue and nothing more, so it reads ACCEPTED — never DELIVERED. Only
 * `delivered` (or an event that implies it: opened, clicked, complained) is a
 * delivery, and an event this reader does not know is reported verbatim as
 * unknown rather than rounded to either.
 */
export function resendReading(last: string): Readback {
  switch (last) {
    case 'queued':
    case 'scheduled':
    case 'sent':
      return { state: 'ACCEPTED', detail: `Resend accepted it ("${last}"); it has not reported a delivery.`, final: false };
    case 'delivery_delayed':
      return { state: 'DELAYED', detail: 'Resend reports the delivery is delayed; it has not arrived yet.', final: false };
    case 'delivered':
      return { state: 'DELIVERED', detail: 'Resend reports the receiving server accepted delivery.', final: true };
    case 'opened':
    case 'clicked':
      return { state: 'DELIVERED', detail: `Delivered, and Resend has since seen it ${last}.`, final: true };
    case 'complained':
      return { state: 'COMPLAINED', detail: 'Delivered, and the recipient marked it as spam.', final: true };
    case 'bounced':
      return { state: 'BOUNCED', detail: 'The receiving server refused it: not delivered.', final: true };
    case 'failed':
      return { state: 'FAILED', detail: 'Resend reports it failed: not delivered.', final: true };
    case 'canceled':
      return { state: 'CANCELED', detail: 'Cancelled on Resend before it was sent.', final: true };
    default:
      return { state: 'UNKNOWN_EVENT', detail: `Resend reported "${last}", which this reader does not interpret; not treated as delivered.`, final: false };
  }
}

/* ------------------------------------------------------------------------- */
/* Stripe                                                                     */
/* ------------------------------------------------------------------------- */

const STRIPE_API = 'https://api.stripe.com/v1';
/** Pinned so `invoice.charge` and the balance transaction mean what this reads. */
const STRIPE_VERSION = '2024-06-20';

function form(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

async function stripe(
  secret: string,
  operation: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, string | number>,
  idempotencyKey?: string,
) {
  return await providerRequest({
    provider: 'stripe',
    operation,
    url: `${STRIPE_API}${path}`,
    method,
    headers: {
      authorization: `Bearer ${secret.trim()}`,
      'stripe-version': STRIPE_VERSION,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body ? form(body) : undefined,
  });
}

export function stripeMode(secret: string): 'TEST' | 'LIVE' | null {
  const value = secret.trim();
  if (/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(value)) return 'TEST';
  if (/^(sk|rk)_live_[A-Za-z0-9]{10,}$/.test(value)) return 'LIVE';
  return null;
}

export const STRIPE_DRIVER: ProviderDriver = {
  provider: 'STRIPE',
  capabilities: ['ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT'],
  kinds: ['ISSUE_INVOICE'],
  title: 'Invoices and payments (Stripe)',
  does:
    'Lets Brain issue an invoice you approved and read back, separately, whether it was issued, ' +
    'whether it was paid, and whether the funds settled. A test-mode key proves the whole path ' +
    'without money moving, and reads as test-only: it never makes invoicing a real customer ' +
    'available.',
  secretShape:
    'A Stripe secret or restricted key (sk_test_…/rk_test_… for the test environment, sk_live_…/rk_live_… for live).',
  setup: [
    'In Stripe, create a restricted key with write access to Customers, Invoices and Invoice items and read access to Balance.',
    'Start with the test-mode key. Set it as the deployment secret named below. It is never typed into Brain.',
    'Press Check. Brain calls Stripe and records the mode Stripe itself reports.',
    'Issue a test invoice to your own address, pay it with Stripe’s test card, and watch Brain read back issued → paid → settled.',
    'Only then replace the secret with the live key; nothing else changes, and the check runs again.',
  ],
  // Stripe prunes an idempotency key after at least 24 hours.
  keyWindowMs: 24 * 3600_000,
  async check(secret) {
    const shape = stripeMode(secret);
    if (!shape) return { ok: false, mode: null, detail: 'The secret does not have the shape of a Stripe key.' };
    try {
      const reply = await stripe(secret, 'check', 'GET', '/balance');
      if (reply.status !== 200) {
        return { ok: false, mode: shape, detail: `Stripe answered HTTP ${reply.status}${providerErrorCode(reply.json) ? ` (${providerErrorCode(reply.json)})` : ''}.` };
      }
      const live = (reply.json as { livemode?: boolean } | null)?.livemode === true;
      const mode = live ? 'LIVE' : 'TEST';
      return {
        ok: true,
        mode,
        detail: live
          ? 'Stripe accepted the key and reports live mode.'
          : 'Stripe accepted the key and reports TEST mode: the path can be proved, and no real customer can be invoiced through it.',
      };
    } catch (error) {
      return { ok: false, mode: null, detail: error instanceof Error ? error.message : 'Stripe could not be reached.' };
    }
  },
  adapter({ secret, action }) {
    return {
      name: 'stripe.invoice',
      effectClass: 'EXTERNAL_IDEMPOTENT',
      namespace: 'external.invoice',
      providerKeyLimit: 200,
      validate(payload) {
        const lines = action.content.lines ?? [];
        if (lines.length === 0 || !action.currency) throw new Error('An invoice needs lines and a currency.');
        return payload as Record<string, unknown>;
      },
      fingerprintInputs: (payload) => payload,
      /*
       * Five calls, each under its own key derived from the one stable
       * provider key. A retry repeats the same five keys, so Stripe returns
       * the objects it already made instead of making a second customer, a
       * second invoice or a second line.
       */
      async send(request) {
        const key = request.providerKey ?? '';
        const tag = businessTag(request.businessId);
        const currency = String(action.currency).toLowerCase();
        try {
          const customer = await stripe(secret, 'create customer', 'POST', '/customers', {
            email: action.destination,
            'metadata[brain]': tag,
          }, `${key}-customer`);
          const customerId = (customer.json as { id?: string } | null)?.id;
          if (customer.status !== 200 || !customerId) return classify(customer.status, customer.json, 'Stripe customer');

          const invoice = await stripe(secret, 'create invoice', 'POST', '/invoices', {
            customer: customerId,
            collection_method: 'send_invoice',
            days_until_due: Math.max(1, Math.min(90, action.content.daysUntilDue ?? 14)),
            auto_advance: 'false',
            currency,
            pending_invoice_items_behavior: 'exclude',
            'metadata[brain]': tag,
          }, `${key}-invoice`);
          const invoiceId = (invoice.json as { id?: string } | null)?.id;
          if (invoice.status !== 200 || !invoiceId) return classify(invoice.status, invoice.json, 'Stripe invoice');

          const lines = action.content.lines ?? [];
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!;
            const item = await stripe(secret, 'add invoice line', 'POST', '/invoiceitems', {
              customer: customerId,
              invoice: invoiceId,
              amount: line.amountCents,
              currency,
              description: line.description.slice(0, 500),
            }, `${key}-item-${index}`);
            if (item.status !== 200) return classify(item.status, item.json, 'Stripe invoice line');
          }

          const finalized = await stripe(secret, 'finalize invoice', 'POST', `/invoices/${invoiceId}/finalize`, {}, `${key}-finalize`);
          if (finalized.status !== 200) return classify(finalized.status, finalized.json, 'Stripe finalize');
          const sent = await stripe(secret, 'send invoice', 'POST', `/invoices/${invoiceId}/send`, {}, `${key}-send`);
          if (sent.status !== 200) return classify(sent.status, sent.json, 'Stripe send');
          const number = (sent.json as { number?: string } | null)?.number ?? null;
          return {
            kind: 'CONFIRMED',
            receiptRef: invoiceId,
            receiptMeta: { provider: 'stripe', number, livemode: (sent.json as { livemode?: boolean } | null)?.livemode ?? null },
          };
        } catch (error) {
          return {
            kind: 'REJECTED',
            category: 'TIMEOUT',
            retryable: true,
            detail: `${error instanceof Error ? error.message : 'no reply'}; safe to repeat under the same idempotency keys`,
          };
        }
      },
    };
  },
  async readback({ secret, action }) {
    const reply = await stripe(
      secret,
      'read back',
      'GET',
      `/invoices/${encodeURIComponent(action.providerRef ?? '')}?expand[]=charge.balance_transaction`,
    );
    if (reply.status !== 200) {
      return { state: 'UNREADABLE', detail: `Stripe answered HTTP ${reply.status} when asked.`, final: false };
    }
    const invoice = reply.json as {
      status?: string;
      amount_paid?: number;
      amount_due?: number;
      attempted?: boolean;
      attempt_count?: number;
      paid_out_of_band?: boolean;
      livemode?: boolean;
      charge?: { balance_transaction?: { id?: string; status?: string; fee?: number; net?: number } | null } | null;
      metadata?: Record<string, string>;
    };
    if (invoice.metadata?.['brain'] !== businessTag(action.id)) return notThisAction('Stripe invoice', action.providerRef);
    const livemode = invoice.livemode === true;
    const mode = livemode ? '' : ' (test mode)';
    switch (invoice.status) {
      case 'open':
        /*
         * Issued and unpaid, and — separately — whether anybody has tried to
         * pay it. A declined card is an attempt, not a payment: it moves no
         * money and must never read as one.
         */
        if (invoice.attempted) {
          return {
            state: 'PAYMENT_ATTEMPTED',
            detail: `Issued; a payment was attempted ${invoice.attempt_count ?? 1} time(s) and has not succeeded, ${invoice.amount_due} minor units still due${mode}.`,
            final: false,
            money: { paidCents: null, settled: false, reference: null, livemode },
          };
        }
        return { state: 'ISSUED', detail: `Issued and awaiting payment of ${invoice.amount_due} minor units${mode}.`, final: false, money: { paidCents: null, settled: false, reference: null, livemode } };
      case 'draft':
        return { state: 'DRAFT', detail: `Still a draft on Stripe${mode}; it has not been issued.`, final: false };
      case 'void':
        return { state: 'VOID', detail: `Voided on Stripe${mode}.`, final: true };
      case 'uncollectible':
        return { state: 'UNCOLLECTIBLE', detail: `Marked uncollectible on Stripe${mode}.`, final: true };
      case 'paid': {
        if (invoice.paid_out_of_band) {
          return {
            state: 'PAID_OUTSIDE_STRIPE',
            detail: `Marked paid outside Stripe${mode}: no funds passed through it, so nothing settles here.`,
            final: true,
            money: { paidCents: invoice.amount_paid ?? null, settled: false, reference: null, livemode },
          };
        }
        const txn = invoice.charge?.balance_transaction ?? null;
        const settled = txn?.status === 'available';
        const feeCents = typeof txn?.fee === 'number' ? txn.fee : null;
        const netCents = typeof txn?.net === 'number' ? txn.net : null;
        const split = feeCents !== null && netCents !== null ? ` Stripe kept ${feeCents} and ${netCents} reached the balance.` : '';
        return {
          state: settled ? 'FUNDS_SETTLED' : 'PAYMENT_MADE',
          detail: (settled
            ? `Paid, and the funds are available in the Stripe balance${mode}.`
            : `Paid; the funds are ${txn?.status ?? 'not yet'} available in the Stripe balance${mode}.`) + split,
          final: settled,
          money: { paidCents: invoice.amount_paid ?? null, settled, reference: txn?.id ?? null, feeCents, netCents, livemode },
        };
      }
      default:
        return { state: String(invoice.status ?? 'UNKNOWN').toUpperCase(), detail: 'Stripe reported a state this reader does not interpret.', final: false };
    }
  },
};

function classify(status: number, json: unknown, operation: string): SendOutcome {
  // Every step is keyed, so a rate limit or a server error is safe to repeat.
  if (status === 429 || status >= 500 || status === 409) return rejected(status, json, true, operation);
  return rejected(status, json, false, operation);
}

export const DRIVERS: Readonly<Record<ExternalProvider, ProviderDriver>> = Object.freeze({
  NTFY: NTFY_DRIVER,
  RESEND: RESEND_DRIVER,
  STRIPE: STRIPE_DRIVER,
});

export function driverFor(provider: ExternalProvider): ProviderDriver {
  return DRIVERS[provider];
}

/** Which provider serves an action kind. One each, by construction. */
export function providerForKind(kind: ExternalActionKind): ExternalProvider {
  for (const driver of Object.values(DRIVERS)) {
    if (driver.kinds.includes(kind)) return driver.provider;
  }
  throw new Error(`No provider serves ${kind}.`);
}
