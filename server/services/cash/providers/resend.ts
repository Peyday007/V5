/**
 * Outbound buyer messaging through Resend — one email, to one published
 * address, under a key that stops a retry becoming a second email.
 *
 * ---------------------------------------------------------------------------
 * Why Resend, and why this effect class
 * ---------------------------------------------------------------------------
 *
 * Nothing in this repository or its deployment named a messaging provider, so
 * the choice is the owner's and is made by setting `BRAIN_MESSAGING_PROVIDER`.
 * Resend is implemented because its send endpoint takes an `Idempotency-Key`
 * header and is a single JSON call, which keeps the effect one request.
 *
 * It is declared **EXTERNAL_OPAQUE**, which is the honest class and the
 * strictest one. Resend keeps an idempotency key for twenty-four hours and
 * offers no way to look an email up by the identity Brain sent it under, so it
 * is neither natively idempotent for ever nor reconcilable. Opaque means one
 * automated attempt: a timeout, a reset or a 5xx leaves the operation
 * `UNCERTAIN`, a need names it, and nothing here ever sends that message again
 * by itself. The key is still sent, because inside its window it turns an
 * accidental duplicate request into the same email rather than a second one —
 * a belt, worn under the braces the engine already provides.
 *
 * ---------------------------------------------------------------------------
 * What it will not send
 * ---------------------------------------------------------------------------
 *
 * Exactly one recipient. No CC, no BCC, no list. A payload naming anything else
 * is refused before a request is built, so this adapter cannot be turned into
 * bulk mail by whoever composes its payload. Every message carries a
 * `List-Unsubscribe` header pointing at the sender, and a provider refusal —
 * Resend refuses suppressed and bounced addresses — is terminal, so a buyer
 * who has opted out is not asked again by a retry.
 */
import type { AdapterHealth, EffectAdapter, EffectRequest, SendOutcome } from '../../effects/adapter.ts';
import {
  ADDRESS,
  MESSAGING_FROM_ENV,
  RESEND_KEY_ENV,
  messagingConfig,
  secretValue,
  senderAddress,
} from './config.ts';
import { providerRequest, type FetchLike } from './http.ts';

export const RESEND_ADAPTER_NAME = 'resend.contact_buyer';
const RESEND_API = 'https://api.resend.com';

/** Bounds on what one message may be, so a payload cannot be a newsletter. */
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 8_000;

function requireString(payload: Record<string, unknown>, field: string, max: number): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`A buyer message needs "${field}".`);
  }
  if (value.length > max) {
    throw new Error(`A buyer message's "${field}" is longer than ${max} characters.`);
  }
  return value;
}

/** The validation every contact-buyer adapter applies, real or not. */
export function validateBuyerMessage(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('A buyer message must be an object.');
  }
  const record = payload as Record<string, unknown>;
  for (const field of ['cc', 'bcc', 'recipients']) {
    if (field in record) throw new Error(`A buyer message has exactly one recipient; "${field}" is refused.`);
  }
  const to = requireString(record, 'to', 320);
  if (!ADDRESS.test(to)) throw new Error('A buyer message goes to exactly one email address.');
  return {
    requestKey: requireString(record, 'requestKey', 256),
    to,
    subject: requireString(record, 'subject', MAX_SUBJECT_CHARS),
    text: requireString(record, 'text', MAX_BODY_CHARS),
    payer: typeof record.payer === 'string' ? record.payer : null,
    channel: typeof record.channel === 'string' ? record.channel : null,
  };
}

export function createResendAdapter(options: {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  namespace: string;
}): EffectAdapter {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;

  return {
    name: RESEND_ADAPTER_NAME,
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: options.namespace,
    validate: validateBuyerMessage,
    // The message itself is the operation: the same recipient, subject and
    // body under the same key is a retry, anything else is a conflict.
    fingerprintInputs: (payload) => ({
      requestKey: payload.requestKey,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
    }),
    health(): AdapterHealth {
      const reading = messagingConfig(env());
      return reading.configured
        ? { usable: true, reason: 'Resend is configured with a key and a sender address.' }
        : { usable: false, reason: `Resend is not usable: missing or malformed ${reading.problems.join(', ')}.` };
    },
    async send(request: EffectRequest): Promise<SendOutcome> {
      const key = secretValue(RESEND_KEY_ENV, env());
      const from = secretValue(MESSAGING_FROM_ENV, env());
      if (!key || !from || !senderAddress(from)) {
        // Nothing left the process, so this is a refusal and not an unknown.
        return {
          kind: 'REJECTED',
          category: 'DEPENDENCY_UNAVAILABLE',
          retryable: true,
          detail: `${RESEND_KEY_ENV} or ${MESSAGING_FROM_ENV} is not configured, so nothing was sent`,
        };
      }
      const payload = request.payload;
      const answer = await providerRequest({
        fetch: doFetch,
        url: `${RESEND_API}/emails`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': String(payload.requestKey),
        },
        body: JSON.stringify({
          from,
          to: [payload.to],
          subject: payload.subject,
          text: payload.text,
          headers: { 'List-Unsubscribe': `<mailto:${senderAddress(from)}?subject=unsubscribe>` },
          tags: [{ name: 'brain_opportunity', value: request.businessId.replace(/[^A-Za-z0-9_-]/g, '_') }],
        }),
        // 409 is "this key is in use by another request, or was used for a
        // different body" — neither says whether an email went.
        uncertainStatuses: [409],
      });
      if (answer.kind === 'OK') {
        const id = answer.body.id;
        if (typeof id !== 'string' || id === '') {
          return { kind: 'UNCERTAIN', reason: 'Resend accepted the request and returned no email id' };
        }
        return { kind: 'CONFIRMED', receiptRef: id, receiptMeta: { provider: 'resend' } };
      }
      if (answer.kind === 'REFUSED') {
        return {
          kind: 'REJECTED',
          category: answer.category,
          retryable: answer.retryable,
          detail: answer.detail,
        };
      }
      return { kind: 'UNCERTAIN', reason: answer.reason };
    },
    redactReceipt: (meta) => ({ provider: meta.provider === 'resend' ? 'resend' : null }),
  };
}

/**
 * A live check of the key, for an operator — never for a capability reading.
 *
 * Listing domains costs nothing and sends nothing. A key restricted to sending
 * cannot list domains, so a refusal here is reported as inconclusive rather
 * than as a bad key: saying a working key is broken would send somebody to
 * rotate a credential that is fine.
 */
export async function probeResend(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<{
  verdict: 'VERIFIED' | 'INCONCLUSIVE' | 'NOT_CONFIGURED' | 'UNREACHABLE';
  detail: string;
}> {
  const env = options.env ?? process.env;
  const key = secretValue(RESEND_KEY_ENV, env);
  if (!messagingConfig(env).configured || !key) {
    return { verdict: 'NOT_CONFIGURED', detail: messagingConfig(env).problems.join(', ') };
  }
  const answer = await providerRequest({
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    url: `${RESEND_API}/domains`,
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (answer.kind === 'OK') return { verdict: 'VERIFIED', detail: 'Resend accepted the key.' };
  if (answer.kind === 'REFUSED') {
    return {
      verdict: 'INCONCLUSIVE',
      detail: `${answer.detail}. A sending-only key reads this way too; the first real send is the proof.`,
    };
  }
  return { verdict: 'UNREACHABLE', detail: answer.reason };
}
