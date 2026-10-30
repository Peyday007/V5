/**
 * Per-provider capacity for the free-model lane: when a provider may next be
 * called, read from what it actually did.
 *
 * Two things are tracked per provider+model, in this process:
 *   * a cooldown, set by a rate-limit or outage answer and lasting until its
 *     retry time (the provider's own Retry-After when it gave one, otherwise a
 *     doubling backoff). Nothing is sent before that time.
 *   * a rate limit, only when a person stored one (`BRAIN_CHEAP_LLM_RPM`). A
 *     burst above it is deferred to the moment the oldest call leaves the
 *     window, never sent. With none stored there is no limit: Brain does not
 *     invent allowance numbers for a provider that has not stated them.
 *
 * State is per process and lost on restart, which errs towards asking the
 * provider again — it cannot hide a recovered provider. A deferral is not a
 * failure and writes nothing to the lane's health rows.
 */
export type Deferral = { allowed: true } | { allowed: false; reason: 'COOLDOWN' | 'RATE_LIMIT_DEFERRED'; retryAt: Date };

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
const WINDOW_MS = 60_000;

/** A provider answer that says how to treat the provider. */
export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`cheap lane HTTP ${status}`);
  }
}

/** Retry-After as seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
}

/** Statuses that mean the provider, not this input, is the problem. */
export function isProviderFault(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return error.status === 429 || error.status >= 500 || error.status === 408;
  // Timeouts and refused connections carry no status and are the provider's too;
  // any other error is not known to be, and so never starts a cooldown.
  if (!(error instanceof Error)) return false;
  const code = String((error as { cause?: { code?: unknown } }).cause?.code ?? '');
  return error.name === 'TimeoutError' || error.name === 'AbortError' || /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|UND_ERR)/.test(code);
}

/** Requests per minute from the stored setting, or null when none was stored. */
export function storedRateLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env['BRAIN_CHEAP_LLM_RPM']);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

interface State { failures: number; until: number; calls: number[] }

export class ProviderCapacity {
  private readonly state = new Map<string, State>();

  constructor(private readonly limitPerMinute: () => number | null = () => storedRateLimit()) {}

  private get(key: string): State {
    let s = this.state.get(key);
    if (!s) { s = { failures: 0, until: 0, calls: [] }; this.state.set(key, s); }
    return s;
  }

  /** Ask before calling. A permitted call is counted against the window. */
  reserve(key: string, now: Date = new Date()): Deferral {
    const s = this.get(key);
    const t = now.getTime();
    if (s.until > t) return { allowed: false, reason: 'COOLDOWN', retryAt: new Date(s.until) };
    s.calls = s.calls.filter((at) => at > t - WINDOW_MS);
    const limit = this.limitPerMinute();
    if (limit !== null && s.calls.length >= limit) {
      return { allowed: false, reason: 'RATE_LIMIT_DEFERRED', retryAt: new Date(s.calls[0]! + WINDOW_MS) };
    }
    s.calls.push(t);
    return { allowed: true };
  }

  success(key: string): void {
    const s = this.get(key);
    s.failures = 0;
    s.until = 0;
  }

  /** The provider failed or refused: no further call before the returned time. */
  failure(key: string, error: unknown, now: Date = new Date()): Date | null {
    if (!isProviderFault(error)) return null;
    const s = this.get(key);
    s.failures += 1;
    const stated = error instanceof ProviderHttpError ? error.retryAfterMs : null;
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (s.failures - 1));
    s.until = now.getTime() + Math.min(BACKOFF_MAX_MS * 4, stated ?? backoff);
    return new Date(s.until);
  }

  reading(now: Date = new Date()): { provider: string; cooldownUntil: string | null; recentCalls: number }[] {
    const t = now.getTime();
    return [...this.state].map(([provider, s]) => ({
      provider,
      cooldownUntil: s.until > t ? new Date(s.until).toISOString() : null,
      recentCalls: s.calls.filter((at) => at > t - WINDOW_MS).length,
    }));
  }
}

export const providerCapacity = new ProviderCapacity();

export function providerKey(url: string, model: string): string {
  try { return `${new URL(url).host}|${model}`; } catch { return `${url}|${model}`; }
}
