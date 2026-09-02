/**
 * Starting a Claude worker, over HTTP, from the Brain.
 *
 * This is the whole of Step 10's outward reach: one POST to one documented
 * endpoint. Everything else in this step is about making that call safe to
 * make twice and safe to make from a machine nobody is watching.
 *
 * ---------------------------------------------------------------------------
 * What the endpoint is, and what it is not
 * ---------------------------------------------------------------------------
 *
 *   POST https://api.anthropic.com/v1/claude_code/routines/{trig_…}/fire
 *
 * It belongs to the Claude Code product surface rather than the Platform API:
 * the credential is a per-routine bearer created in the web UI, not an API key;
 * it is scoped to triggering that one routine and grants no read access; and it
 * bills against the account's Claude Code subscription rather than Platform
 * usage. There is no SDK for it and it ships behind a dated beta header.
 *
 * Three properties of the endpoint decide the design of everything around it:
 *
 *   1. **There is no idempotency key.** The documentation is explicit: "If a
 *      webhook caller retries, the endpoint creates multiple sessions." So
 *      duplicate suppression cannot live here. It lives in the bin's
 *      compare-and-swap, where a duplicate session costs one wasted activation
 *      and can never cost duplicated work.
 *
 *   2. **`text` is untrusted by construction.** Anthropic wraps it in a
 *      `<routine-fire-payload>` block labelled as data, precisely because
 *      anyone holding the token can send it. So Brain sends **no text at all**.
 *      The worker's instructions are its saved prompt; its work comes from an
 *      authenticated check-in. A leaked trigger token can therefore start a
 *      session and nothing else — the session still has to authenticate to
 *      Brain, and Brain still decides what it gets.
 *
 *   3. **429 carries `Retry-After`.** The account has a daily routine-run
 *      allowance and a subscription usage limit, and hitting either is an
 *      ordinary event rather than a fault. It is honoured rather than
 *      backed-off blindly, and it is recorded, because the ceiling it reports
 *      is the measurement Step 10 was asked to take.
 *
 * The token appears in exactly one place — the `Authorization` header built
 * below — and in no log line, no error message, no telemetry row and no
 * response. `describeFireTarget` exists so a diagnostic can say whether firing
 * is configured without going anywhere near the value.
 */
import { recordBinEvent } from '../../repos/bins.ts';

/** The dated beta this endpoint ships under. Requests without it get a 400. */
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE = 'https://api.anthropic.com';

/**
 * How Brain is configured to start a worker.
 *
 * Read from the environment on every call rather than captured at import, so a
 * secret set after boot takes effect without a restart — and so a test can put
 * one in place without reloading the module.
 */
export interface FireConfig {
  baseUrl: string;
  routineId: string | null;
  token: string | null;
  /** Recorded on every dispatch so a run can be attributed to a prompt revision. */
  routineVersion: string | null;
}

export function fireConfig(): FireConfig {
  const routineId = (process.env['BRAIN_ROUTINE_ID'] ?? '').trim() || null;
  const token = (process.env['BRAIN_ROUTINE_TOKEN'] ?? '').trim() || null;
  return {
    baseUrl: (process.env['BRAIN_ROUTINE_BASE_URL'] ?? '').trim() || DEFAULT_BASE,
    routineId,
    token,
    routineVersion: (process.env['BRAIN_ROUTINE_VERSION'] ?? '').trim() || null,
  };
}

export function isFireConfigured(): boolean {
  const config = fireConfig();
  return Boolean(config.routineId && config.token);
}

/**
 * What a diagnostic may say about the trigger.
 *
 * Names the routine and whether a credential is present. Never the credential,
 * and never enough of it to be useful — the same rule the boot banner follows
 * for the database and the bucket.
 */
export function describeFireTarget(): {
  configured: boolean;
  routineId: string | null;
  baseUrl: string;
  tokenPresent: boolean;
  routineVersion: string | null;
} {
  const config = fireConfig();
  return {
    configured: Boolean(config.routineId && config.token),
    routineId: config.routineId,
    baseUrl: config.baseUrl,
    tokenPresent: Boolean(config.token),
    routineVersion: config.routineVersion,
  };
}

export type FireOutcome =
  | { ok: true; sessionRef: string | null; fireEventId: string | null; routineId: string }
  | { ok: false; kind: FireErrorKind; message: string; retryAfterMs: number | null; routineId: string | null };

/**
 * The failure categories worth telling apart.
 *
 * They differ in what the dispatcher should do next, which is the only reason
 * to have categories at all:
 *
 *   NOT_CONFIGURED  nothing to retry; the deployment has no trigger
 *   AUTH            the token is wrong or revoked; retrying will not fix it
 *   NOT_FOUND       the routine is gone; retrying will not fix it
 *   PAUSED          a person paused the routine; retrying will not fix it
 *   RATE_LIMIT      the allowance; honour Retry-After and try again
 *   SERVER          5xx or overloaded; back off and try again
 *   NETWORK         it never arrived; back off and try again
 */
export type FireErrorKind =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'PAUSED'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'NETWORK';

/** Whether trying the same call again could ever succeed. */
export function isRetryable(kind: FireErrorKind): boolean {
  return kind === 'RATE_LIMIT' || kind === 'SERVER' || kind === 'NETWORK';
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60 * 60_000, seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/**
 * Start one worker.
 *
 * Deliberately sends an empty JSON body. See the note at the top of this file:
 * the fire payload is a channel anyone holding the token can write to, so Brain
 * puts nothing in it — not an instruction, not a bin id, not a hint. The worker
 * learns what to do by authenticating to Brain and asking.
 */
/**
 * One resolved surface to fire at.
 *
 * Step 11's router hands this in; Step 10 read it from the environment. The
 * token is resolved from its secret *name* at call time — the registry row
 * holds the name and a digest, never the value — so the credential's lifetime
 * in memory is still one HTTP call and nothing about §22's secret rule changes.
 */
export interface FireTarget {
  routineId: string;
  token: string;
  baseUrl?: string | null;
  routineVersion?: string | null;
}

/**
 * Resolve a registered Routine's credential from the environment.
 *
 * Returns null rather than throwing when the named secret is absent, because a
 * Routine registered against a secret the deployment does not have is an
 * ordinary configuration state the router should skip, not a crash.
 */
export function resolveToken(secretName: string): string | null {
  return (process.env[secretName] ?? '').trim() || null;
}

export async function fireRoutine(
  options: { timeoutMs?: number; target?: FireTarget } = {},
): Promise<FireOutcome> {
  const config = options.target
    ? {
        baseUrl: options.target.baseUrl?.trim() || DEFAULT_BASE,
        routineId: options.target.routineId,
        token: options.target.token,
        routineVersion: options.target.routineVersion ?? null,
      }
    : fireConfig();
  if (!config.routineId || !config.token) {
    return {
      ok: false,
      kind: 'NOT_CONFIGURED',
      message:
        'No routine trigger is configured. Set BRAIN_ROUTINE_ID and BRAIN_ROUTINE_TOKEN as ' +
        'deployment secrets; the token is generated once in the Claude Code web UI and cannot ' +
        'be read back afterwards.',
      retryAfterMs: null,
      routineId: config.routineId,
    };
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/claude_code/routines/${config.routineId}/fire`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // The one place the credential appears.
        Authorization: `Bearer ${config.token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ROUTINE_BETA,
        'Content-Type': 'application/json',
      },
      // No `text`. On purpose, and load-bearing.
      body: '{}',
      signal: controller.signal,
    });

    if (response.status === 200) {
      const body = (await response.json().catch(() => ({}))) as {
        claude_code_session_id?: string;
        type?: string;
      };
      return {
        ok: true,
        sessionRef: body.claude_code_session_id ?? null,
        fireEventId: body.claude_code_session_id ?? null,
        routineId: config.routineId,
      };
    }

    // The body may carry the provider's own message. It is bounded and stored,
    // and it cannot contain the token: the token went out in a header and this
    // endpoint has no read access to echo anything back with.
    const detail = await response.text().catch(() => '');
    const kind: FireErrorKind =
      response.status === 401 || response.status === 403
        ? 'AUTH'
        : response.status === 404
          ? 'NOT_FOUND'
          : response.status === 429
            ? 'RATE_LIMIT'
            : response.status === 400
              ? // 400 is either a missing beta header, an over-long text, or a
                // paused routine. The first two cannot happen here, so in
                // practice this is somebody having paused it.
                'PAUSED'
              : 'SERVER';

    return {
      ok: false,
      kind,
      message: `${response.status} ${detail.slice(0, 400)}`.trim(),
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      routineId: config.routineId,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      kind: 'NETWORK',
      message: aborted
        ? 'The fire request timed out. Whether a session was created is unknown.'
        : error instanceof Error
          ? error.message.slice(0, 400)
          : String(error).slice(0, 400),
      retryAfterMs: null,
      routineId: config.routineId,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record what the provider said about capacity, whether or not it mattered.
 *
 * Step 11 needs the ceiling, and the ceiling is only ever observed at the
 * moment it is hit. Writing it down when it happens is the difference between
 * measuring the limit and guessing it later from a failure count.
 */
export async function recordAllowanceObservation(input: {
  binId: string | null;
  kind: FireErrorKind;
  retryAfterMs: number | null;
  message: string;
  accountId?: string | null;
  routineId?: string | null;
}): Promise<void> {
  if (input.kind !== 'RATE_LIMIT') return;
  await recordBinEvent({
    eventType: 'PROVIDER_ALLOWANCE',
    binId: input.binId,
    accountId: input.accountId ?? null,
    routineId: input.routineId ?? null,
    // The provider refused. That is the one capacity fact nothing Brain infers
    // may overwrite, so it is classified at the moment it is observed.
    evidenceClass: 'PROVIDER_ENFORCED',
    provider: 'claude-routine',
    outcome: 'RATE_LIMITED',
    reason: input.message,
    measures: { retryAfterMs: input.retryAfterMs },
    // The provider tells us we are limited; it does not tell us the balance.
    // Anything inferred about remaining capacity is a proxy and says so.
    isProxy: true,
  });
}
