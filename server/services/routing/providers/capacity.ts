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
 * The cooldown is also written to `provider_capacity` and read back before
 * every call (`CapacityStore`), so a restart, a deploy or another machine does
 * not call a provider that is known to be down; a success clears it. The
 * per-minute window stays per process. A deferral is not a failure and writes
 * nothing to the lane's health rows.
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

interface State { failures: number; until: number; calls: number[]; stored: boolean }

/**
 * Where a cooldown outlives this process: the `provider_capacity` row
 * (`repos/workRouting.ts`). Read before every call, so a cooldown another
 * machine or an earlier process recorded is honoured; written on every
 * provider fault, so a restart or a deploy does not call a known-down provider
 * again. Only the cooldown is shared — the per-minute window stays per process,
 * because a burst count is not a fact any row states.
 */
export interface CapacityStore {
  cooldownUntil(provider: string, model: string): Promise<string | null>;
  recordFault(provider: string, model: string, failure: string, cooldownUntil: string): Promise<void>;
  clearCooldown(provider: string, model: string): Promise<void>;
}

/** The provider (host) and model a key names. */
export function keyParts(key: string): { provider: string; model: string } {
  const at = key.indexOf('|');
  return at < 0 ? { provider: key, model: '' } : { provider: key.slice(0, at), model: key.slice(at + 1) };
}

export class ProviderCapacity {
  private readonly state = new Map<string, State>();

  constructor(
    private readonly limitPerMinute: () => number | null = () => storedRateLimit(),
    private readonly store: CapacityStore | null = null,
  ) {}

  /**
   * Adopt the durable cooldown for `key` before asking `reserve`. A store that
   * cannot be read leaves this process's own state in charge, which errs towards
   * asking the provider again rather than inventing an outage.
   */
  async sync(key: string): Promise<void> {
    if (!this.store) return;
    const { provider, model } = keyParts(key);
    let until: string | null = null;
    try {
      until = await this.store.cooldownUntil(provider, model);
    } catch {
      return;
    }
    const at = until ? Date.parse(until) : Number.NaN;
    const s = this.get(key);
    if (Number.isFinite(at) && at > s.until) {
      s.until = at;
      s.stored = true;
    }
  }

  /** `failure`, and the cooldown it set written where every process reads it. */
  async fail(key: string, error: unknown, now: Date = new Date()): Promise<Date | null> {
    const until = this.failure(key, error, now);
    if (until && this.store) {
      const { provider, model } = keyParts(key);
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.store.recordFault(provider, model, message, until.toISOString());
        this.get(key).stored = true;
      } catch {
        // The in-process cooldown still holds; the row is written on the next fault.
      }
    }
    return until;
  }

  /** `success`, and a stored cooldown cleared so other processes ask again too. */
  async succeed(key: string): Promise<void> {
    const s = this.get(key);
    const hadStored = s.stored;
    this.success(key);
    if (hadStored && this.store) {
      const { provider, model } = keyParts(key);
      try {
        await this.store.clearCooldown(provider, model);
        s.stored = false;
      } catch {
        // A stale row expires at its own time; it never outlasts the provider's stated retry.
      }
    }
  }

  private get(key: string): State {
    let s = this.state.get(key);
    if (!s) { s = { failures: 0, until: 0, calls: [], stored: false }; this.state.set(key, s); }
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

/** The `provider_capacity` table as the store (`repos/workRouting.ts`). */
export const providerCapacityStore: CapacityStore = {
  async cooldownUntil(provider, model) {
    const { getProviderCapacity } = await import('../../../repos/workRouting.ts');
    return (await getProviderCapacity(provider, model))?.cooldownUntil ?? null;
  },
  async recordFault(provider, model, failure, cooldownUntil) {
    const { recordProviderFailure } = await import('../../../repos/workRouting.ts');
    await recordProviderFailure({ provider, model, failure, cooldownUntil });
  },
  async clearCooldown(provider, model) {
    const { clearProviderCooldown } = await import('../../../repos/workRouting.ts');
    await clearProviderCooldown(provider, model);
  },
};

/** The lane's capacity: cooldowns persist in `provider_capacity`, so they survive restarts and span machines. */
export const providerCapacity = new ProviderCapacity(() => storedRateLimit(), providerCapacityStore);

export function providerKey(url: string, model: string): string {
  try { return `${new URL(url).host}|${model}`; } catch { return `${url}|${model}`; }
}
