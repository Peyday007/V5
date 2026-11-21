/**
 * A keyed web-search provider in front of the DuckDuckGo scraper (`discover.ts`).
 *
 * Production, 2026-11-20: DuckDuckGo's html and lite endpoints refused Brain
 * 650 times in 24 hours (html 318, lite 332). A fragment whose search came back
 * empty was filled from the model's remembered pages and Wikipedia, and 166
 * claims were refused in 48 hours — "local payphone calls cost 50 cents CAD"
 * offered for a goal's price question. Earlier, 64% of GPU research fragments
 * failed "no readable source" while search starved. Brain had no search of its
 * own; the owner already holds a Google Programmable Search key pair.
 *
 * The rules:
 *
 *  - **Inert until its secret is set.** With no key and engine id in the
 *    deployment's environment, `keyedSearch` answers null and `webSearch` is
 *    exactly the DuckDuckGo path it was (§54: a provider is a deployment secret,
 *    never a boolean someone flips).
 *  - **A daily ceiling, counted before each query is sent** (invariant 18). The
 *    default is the registry's `dailyCeiling` — Google's free 100 a day — so no
 *    money is spent until the owner raises `BRAIN_SEARCH_DAILY_CEILING` himself.
 *    A query that timed out is still counted: an unknown outcome is not a free
 *    one (invariant 26). Reaching the ceiling is recorded once a day, never
 *    silent, and every search after it goes to DuckDuckGo.
 *  - **A refusal rests the provider and falls back.** 429 (quota) and 400/401/
 *    403 (a key Google will not take, an API not enabled, a daily limit) rest it
 *    for a quarter hour doubling to six hours; a 5xx, timeout or unreadable
 *    answer rests it a minute. The query that met the refusal goes to DuckDuckGo
 *    unchanged.
 *  - **The key never leaves the request** (invariant 22). Google takes it only
 *    as a query parameter, so the request URL is never logged, recorded or put
 *    in an error; every detail this module produces names a status and Google's
 *    reason code, and is passed through `redact` against the configured secrets
 *    in case a library put the URL into an error message.
 *
 * Adding a keyed provider is one more entry in `KEYED_SEARCH_PROVIDERS` and one
 * more integration in the registry (§103). The second is Firecrawl (2026-11-21):
 * its key travels in an `Authorization` header, its ceiling is counted in
 * credits (`BRAIN_FIRECRAWL_DAILY_CEILING`, shared with the FIRECRAWL scrape
 * route in `firecrawl.ts` through `claimKeyedCredits`), and a 402 — credits
 * exhausted — rests it like any other refusal.
 */
import { integration } from '../integrations/registry.ts';

export const SEARCH_API_KEY_ENV = 'BRAIN_SEARCH_API_KEY';
export const SEARCH_ENGINE_ID_ENV = 'BRAIN_SEARCH_ENGINE_ID';
export const SEARCH_DAILY_CEILING_ENV = 'BRAIN_SEARCH_DAILY_CEILING';
export const FIRECRAWL_API_KEY_ENV = 'FIRECRAWL_API_KEY';
export const FIRECRAWL_DAILY_CEILING_ENV = 'BRAIN_FIRECRAWL_DAILY_CEILING';
/** The id Firecrawl's search events and its shared daily credit count are recorded under. */
export const FIRECRAWL_PROVIDER_ID = 'firecrawl';

const MAX_RESULTS = 8;
const TIMEOUT_MS = 12_000;

/** One keyed search API. Generic over the provider. */
export interface KeyedSearchProvider {
  /** Recorded as the search event's provider, and the key of its daily count. */
  id: string;
  /** The registry integration that declares its credentials (§103). */
  integrationId: string;
  /** The setting the owner raises the daily ceiling with. */
  ceilingEnv: string;
  /** What one query spends against the ceiling (queries for Google, credits for Firecrawl). */
  cost: number;
  /** Its credentials from the environment, or null when it is not configured. */
  credentials(env: NodeJS.ProcessEnv): Record<string, string> | null;
  /** The request for a query. Its URL may carry a secret: it is never logged. */
  request(query: string, credentials: Record<string, string>): { url: string; init: RequestInit };
  /** Result pages from an answered body, in order. */
  parse(body: unknown): string[];
  /** The provider's own reason code for a refusal, if its body names one (no free text). */
  refusalReason(body: unknown): string | null;
}

/** Google Programmable Search (Custom Search JSON API). */
export const googleProgrammableSearch: KeyedSearchProvider = {
  id: 'google-cse',
  integrationId: 'google-search',
  ceilingEnv: SEARCH_DAILY_CEILING_ENV,
  cost: 1,
  credentials(env) {
    const key = (env[SEARCH_API_KEY_ENV] ?? '').trim();
    const cx = (env[SEARCH_ENGINE_ID_ENV] ?? '').trim();
    return key && cx ? { key, cx } : null;
  },
  request(query, credentials) {
    const params = new URLSearchParams({ key: credentials['key'] ?? '', cx: credentials['cx'] ?? '', q: query, num: '10' });
    return {
      url: `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
      init: { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    };
  },
  parse(body) {
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items.map((item) => (item as { link?: unknown } | null)?.link).filter((link): link is string => typeof link === 'string');
  },
  refusalReason(body) {
    const errors = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
    const reason = errors?.errors?.[0]?.reason ?? errors?.status;
    return typeof reason === 'string' && /^[A-Za-z_]{1,64}$/.test(reason) ? reason : null;
  },
};

/**
 * Firecrawl search (API v1). Billed in credits — about 2 for a result set — so
 * a query is counted as 2 against `BRAIN_FIRECRAWL_DAILY_CEILING`. Its key is a
 * header, never part of the URL.
 */
export const firecrawlSearch: KeyedSearchProvider = {
  id: FIRECRAWL_PROVIDER_ID,
  integrationId: 'firecrawl',
  ceilingEnv: FIRECRAWL_DAILY_CEILING_ENV,
  cost: 2,
  credentials(env) {
    const key = (env[FIRECRAWL_API_KEY_ENV] ?? '').trim();
    return key ? { key } : null;
  },
  request(query, credentials) {
    return {
      url: 'https://api.firecrawl.dev/v1/search',
      init: {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credentials['key'] ?? ''}` },
        body: JSON.stringify({ query, limit: MAX_RESULTS }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    };
  },
  parse(body) {
    const data = (body as { success?: unknown; data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    return data.map((item) => (item as { url?: unknown } | null)?.url).filter((url): url is string => typeof url === 'string');
  },
  refusalReason(body) {
    // Firecrawl's `error` is free text that may echo the request; only a code-shaped one is kept.
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[A-Za-z_]{1,64}$/.test(code) ? code : null;
  },
};

/**
 * The order keyed providers are asked in. Each one that is unconfigured, resting,
 * over its ceiling, refused, failed or found nothing passes the query to the
 * next; after the last, `webSearch` asks DuckDuckGo (`discover.ts`), so a search
 * is never stranded on a keyed provider. Google leads (100 free queries a day);
 * Firecrawl's credits are scarcer and spent only when Google cannot answer.
 */
export const KEYED_SEARCH_PROVIDERS: KeyedSearchProvider[] = [googleProgrammableSearch, firecrawlSearch];

/** What a keyed search did, for the search event recorder. Never carries a secret. */
export interface KeyedSearchEvent {
  provider: string;
  outcome: 'ANSWERED' | 'EMPTY' | 'REFUSED' | 'ERROR' | 'CEILING';
  status: number | null;
  results: number;
  detail: string;
}

export interface KeyedSearchDeps {
  fetchImpl: typeof fetch;
  nowMs: () => number;
  env: NodeJS.ProcessEnv;
  emit: (event: KeyedSearchEvent) => void;
}

interface ProviderState {
  day: string;
  used: number;
  ceilingRecorded: boolean;
  pausedUntil: number;
  streak: number;
}
const state = new Map<string, ProviderState>();

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function stateFor(provider: string, now: number): ProviderState {
  const day = utcDay(now);
  let one = state.get(provider);
  if (!one) {
    one = { day, used: 0, ceilingRecorded: false, pausedUntil: 0, streak: 0 };
    state.set(provider, one);
  }
  if (one.day !== day) {
    one.day = day;
    one.used = 0;
    one.ceilingRecorded = false;
  }
  return one;
}

/** What Brain may spend a day on a provider: the owner's setting, else the registry's ceiling. Pure. */
export function dailySearchCeiling(provider: Pick<KeyedSearchProvider, 'ceilingEnv' | 'integrationId'>, env: NodeJS.ProcessEnv): number {
  const set = (env[provider.ceilingEnv] ?? '').trim();
  if (/^\d+$/.test(set)) return Number(set);
  return integration(provider.integrationId).dailyCeiling ?? 0;
}

/**
 * Spend `units` of a provider's daily ceiling, before the request is sent
 * (invariant 18). True when they were spent; false when they would pass the
 * ceiling, in which case nothing is spent. Shared by every caller that bills
 * against the same account — Firecrawl's search and its scrape route.
 */
export function claimKeyedCredits(providerId: string, units: number, ceiling: number, now: number): { ok: boolean; used: number } {
  const one = stateFor(providerId, now);
  if (one.used + units > ceiling) return { ok: false, used: one.used };
  one.used += units;
  return { ok: true, used: one.used };
}

/** Whether a provider is resting after a refusal or error. */
export function keyedProviderResting(providerId: string, now: number): boolean {
  return stateFor(providerId, now).pausedUntil > now;
}

/** Rest a provider after a refusal or error (its streak doubles the rest); a success clears the streak. */
export function noteKeyedOutcome(providerId: string, outcome: 'OK' | 'REFUSED' | 'ERROR', now: number): void {
  const one = stateFor(providerId, now);
  if (outcome === 'OK') {
    one.streak = 0;
    return;
  }
  one.streak += 1;
  one.pausedUntil = now + keyedPauseMs(outcome, one.streak);
}

/** Records reaching the ceiling once a UTC day: true the first time it is asked today. */
export function firstCeilingToday(providerId: string, now: number): boolean {
  const one = stateFor(providerId, now);
  if (one.ceilingRecorded) return false;
  one.ceilingRecorded = true;
  return true;
}

/** How long the provider rests after a refusal or error streak. Pure. */
export function keyedPauseMs(kind: 'REFUSED' | 'ERROR', streak: number): number {
  const base = kind === 'REFUSED' ? 15 * 60_000 : 60_000;
  return Math.min(6 * 60 * 60_000, base * 2 ** Math.max(0, streak - 1));
}

/** `text` with every configured secret of every keyed provider removed. Pure. */
export function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const provider of KEYED_SEARCH_PROVIDERS) {
    for (const value of Object.values(provider.credentials(env) ?? {})) {
      if (value.length < 4) continue;
      for (const form of new Set([value, encodeURIComponent(value)])) out = out.split(form).join('[redacted]');
    }
  }
  return out;
}

/** Result pages without duplicates or fragments, http(s) only, at most eight. Pure. */
export function cleanResults(links: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!/^https?:\/\//i.test(link)) continue;
    try {
      new URL(link);
    } catch {
      continue;
    }
    const key = link.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** The first configured provider that is under its ceiling and not resting, or null. */
export function availableKeyedProvider(env: NodeJS.ProcessEnv, now: number): KeyedSearchProvider | null {
  for (const provider of KEYED_SEARCH_PROVIDERS) {
    if (!provider.credentials(env)) continue;
    const one = stateFor(provider.id, now);
    if (one.pausedUntil > now) continue;
    if (one.used + provider.cost > dailySearchCeiling(provider, env)) continue;
    return provider;
  }
  return null;
}

/**
 * Up to eight result pages from the first keyed provider that can answer, or
 * null when none did and the caller should search DuckDuckGo. Never throws.
 */
export async function keyedSearch(query: string, deps: KeyedSearchDeps): Promise<string[] | null> {
  for (const provider of KEYED_SEARCH_PROVIDERS) {
    const credentials = provider.credentials(deps.env);
    if (!credentials) continue;
    const now = deps.nowMs();
    const one = stateFor(provider.id, now);
    if (one.pausedUntil > now) continue;
    const ceiling = dailySearchCeiling(provider, deps.env);
    // Counted before it is sent, so concurrent searches cannot overshoot and a
    // query whose answer never arrived is still a query the provider may bill.
    const claim = claimKeyedCredits(provider.id, provider.cost, ceiling, now);
    if (!claim.ok) {
      if (firstCeilingToday(provider.id, now)) {
        deps.emit({
          provider: provider.id, outcome: 'CEILING', status: null, results: 0,
          detail: `${provider.id} reached its daily ceiling of ${ceiling} (${provider.ceilingEnv}); its searches go to the next provider until 00:00 UTC`,
        });
      }
      continue;
    }
    const used = `${claim.used} of ${ceiling} spent today`;
    try {
      const { url, init } = provider.request(query, credentials);
      const response = await deps.fetchImpl(url, init);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        // 402 is Firecrawl's "credits exhausted": a refusal, not an outage.
        const refused = [400, 401, 402, 403, 429].includes(response.status);
        const kind = refused ? 'REFUSED' : 'ERROR';
        one.streak += 1;
        one.pausedUntil = deps.nowMs() + keyedPauseMs(kind, one.streak);
        const reason = provider.refusalReason(body);
        deps.emit({
          provider: provider.id, outcome: kind, status: response.status, results: 0,
          detail: redact(`${provider.id} answered ${response.status}${reason ? ` (${reason})` : ''}; ${used}; it rests and the next provider answers`, deps.env),
        });
        continue;
      }
      one.streak = 0;
      const urls = cleanResults(provider.parse(body));
      if (urls.length === 0) {
        // An empty keyed answer is not a reason to give the fragment nothing.
        deps.emit({ provider: provider.id, outcome: 'EMPTY', status: response.status, results: 0, detail: `${provider.id} found nothing; ${used}; the next provider is asked` });
        continue;
      }
      deps.emit({ provider: provider.id, outcome: 'ANSWERED', status: response.status, results: urls.length, detail: `${provider.id} answered ${urls.length} page(s); ${used}` });
      return urls;
    } catch (error) {
      one.streak += 1;
      one.pausedUntil = deps.nowMs() + keyedPauseMs('ERROR', one.streak);
      const name = error instanceof Error ? error.name : 'Error';
      deps.emit({
        provider: provider.id, outcome: 'ERROR', status: null, results: 0,
        detail: redact(`${provider.id} request failed (${name}); ${used}; it rests and the next provider answers`, deps.env),
      });
    }
  }
  return null;
}

/**
 * After a restart, what was already spent today (read from recorded events) so
 * the ceiling holds across processes' lifetimes. Never lowers a count.
 */
export function seedKeyedSearchUsage(provider: string, used: number, nowMs = Date.now()): void {
  const one = stateFor(provider, nowMs);
  one.used = Math.max(one.used, Math.max(0, Math.floor(used)));
}

/** Today's count for a provider, for tests and `sources search`. */
export function keyedSearchUsed(provider: string, nowMs = Date.now()): number {
  return stateFor(provider, nowMs).used;
}

export function resetKeyedSearchState(): void {
  state.clear();
}
