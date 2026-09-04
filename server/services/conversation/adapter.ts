/**
 * The provider-independent seam for a streamed reply.
 *
 * One interface, three implementations that matter: a real provider, a
 * scripted one for tests, and the absence of either — which is a first-class
 * answer rather than a crash. Nothing above this layer knows which it is
 * talking to, and nothing below it decides whether it may be called; that is
 * `spend.ts`, and the order is not negotiable: reserve, then call, then settle.
 *
 * **A refusal is a result.** Step 7 settled this at the MCP boundary and it is
 * the same reason here: a refusal delivered as a thrown exception is one the
 * interface cannot show a person. So `stream` never throws for a foreseeable
 * condition — no key, no ceiling, provider limited, provider down — it yields
 * an `ERROR` event carrying which one, and the shell says the true thing.
 *
 * **A usage report is the only evidence of cost.** A stream that ends without
 * one is an unknown outcome, not a free call, and the caller records it as
 * unknown. That is why `DONE` carries usage and why `usage` is not optional on
 * it: an adapter that could omit it would let a caller quietly assume zero.
 */

/** Why an adapter could not answer. A closed set, so a screen can be honest. */
export const ADAPTER_FAILURES = [
  'NO_CREDENTIAL',
  'NOT_AUTHORIZED_TO_SPEND',
  'CEILING_REACHED',
  'MODEL_UNAVAILABLE',
  'PROVIDER_LIMITED',
  'PROVIDER_ERROR',
  'TIMEOUT',
  'CANCELLED',
] as const;
export type AdapterFailure = (typeof ADAPTER_FAILURES)[number];

/** What a person is told for each. Never a provider's own error text. */
export const FAILURE_WORDS: Record<AdapterFailure, string> = {
  NO_CREDENTIAL: 'Russell has no way to answer quickly yet, so this went the slower way.',
  NOT_AUTHORIZED_TO_SPEND: 'Quick answers are switched off until somebody sets a budget.',
  CEILING_REACHED: 'The budget for this period is used up, so this went the slower way.',
  MODEL_UNAVAILABLE: 'The quick model is not available, so this went the slower way.',
  PROVIDER_LIMITED: 'The provider is rate-limiting us at the moment.',
  PROVIDER_ERROR: 'The provider could not answer that one.',
  TIMEOUT: 'That took too long and Russell stopped waiting. Whether it went through is unknown.',
  CANCELLED: 'That was stopped before it finished.',
};

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** The provider's own model identifier, never an alias. */
  modelId: string;
  /** Stable instructions and the assembled context. */
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Aborting is the caller's, so a person navigating away stops the call. */
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatEvent =
  | { kind: 'TEXT'; text: string }
  | { kind: 'DONE'; usage: Usage }
  | { kind: 'ERROR'; failure: AdapterFailure; detail: string; retryable: boolean };

export interface ChatAdapter {
  readonly name: string;
  /**
   * Whether this adapter could answer at all right now.
   *
   * Separate from `stream` because a screen needs to know before a person
   * types, and because "not configured" is a configuration fact rather than a
   * failed request.
   */
  ready(): Promise<{ ready: boolean; failure: AdapterFailure | null }>;
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
}

/**
 * The adapter for a Brain with no key.
 *
 * Not a stub and not a mock: it is the correct implementation of "there is no
 * fast lane here", and it is what the deployed Brain uses today. It answers
 * every request with the same refusal, which is what sends the turn to the
 * Routine fleet — the path that has always worked.
 *
 * It deliberately produces no text. §24 is explicit that a mock response
 * shaped like grounded Russell output must never reach production, and the
 * quickest way to violate that is a placeholder adapter that returns prose.
 */
export function unavailableAdapter(failure: AdapterFailure): ChatAdapter {
  return {
    name: 'unavailable',
    async ready() {
      return { ready: false, failure };
    },
    async *stream() {
      yield { kind: 'ERROR', failure, detail: FAILURE_WORDS[failure], retryable: false };
    },
  };
}

/**
 * An adapter that replays a script.
 *
 * For tests only, and structurally marked: `name` is `'scripted'`, which the
 * turn service refuses in production. §12's rule about the mock provider
 * applies unchanged — canned prose presented as a grounded answer is the one
 * thing this conversation may never produce.
 */
export function scriptedAdapter(script: ChatEvent[]): ChatAdapter {
  return {
    name: 'scripted',
    async ready() {
      return { ready: true, failure: null };
    },
    async *stream() {
      for (const event of script) yield event;
    },
  };
}

/**
 * Collect a stream into one answer.
 *
 * The shape every caller actually wants, and the one place the "a stream that
 * ended without usage is an unknown outcome" rule is applied — rather than in
 * each caller, where one of them would forget.
 */
export async function collect(
  events: AsyncIterable<ChatEvent>,
): Promise<
  | { ok: true; text: string; usage: Usage }
  | { ok: false; failure: AdapterFailure; detail: string; partial: string; usageKnown: false }
> {
  let text = '';
  for await (const event of events) {
    if (event.kind === 'TEXT') text += event.text;
    else if (event.kind === 'DONE') return { ok: true, text, usage: event.usage };
    else {
      return {
        ok: false,
        failure: event.failure,
        detail: event.detail,
        partial: text,
        usageKnown: false,
      };
    }
  }
  // The stream ended without saying it was done. Whether the provider billed
  // for it is not knowable from here, which is exactly the case §20 says must
  // be recorded as unknown rather than assumed away.
  return {
    ok: false,
    failure: 'TIMEOUT',
    detail: 'the stream ended without a completion',
    partial: text,
    usageKnown: false,
  };
}
