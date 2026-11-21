/**
 * The FIRECRAWL route of `readSource` (`access.ts`): Firecrawl's v1 scrape, asked
 * for a page only after DIRECT and BROWSER failed or came back thin.
 *
 * It is a keyed provider like Firecrawl's search (`keyedSearch.ts`), and spends
 * from the same daily credit count, under the same rules:
 *
 *  - inert until `FIRECRAWL_API_KEY` is set (§54);
 *  - one credit counted before each scrape is sent, a timeout included
 *    (invariants 18, 26), against `BRAIN_FIRECRAWL_DAILY_CEILING`; reaching it is
 *    recorded once a day and the read falls through to the next route;
 *  - a refusal (400/401/402/403/429) rests the provider, a 5xx or a failure rests
 *    it briefly, and the read falls through;
 *  - the key travels only in the Authorization header, and every detail is
 *    passed through `redact` (invariant 22).
 *
 * What it returns is the page under the page's own address: Firecrawl is how the
 * text was fetched, not what is cited, and the route is recorded on the read
 * (`SourceRead.method = 'FIRECRAWL'`). A target status Firecrawl reports as an
 * HTTP error is returned as that error, never as the page; the access layer's
 * challenge check still applies to what it does return. The text enters the
 * same verification and gate as any other read.
 */
import { createHash } from 'node:crypto';
import { recordBinEvent } from '../../repos/bins.ts';
import { MAX_TEXT_CHARS, type SourceFetch } from './fetchForWorker.ts';
import {
  claimKeyedCredits,
  dailySearchCeiling,
  firecrawlSearch,
  FIRECRAWL_PROVIDER_ID,
  firstCeilingToday,
  keyedProviderResting,
  noteKeyedOutcome,
  redact,
} from './keyedSearch.ts';

export const FIRECRAWL_SCRAPE_EVENT = 'FIRECRAWL_SCRAPE';
/** Credits one scrape spends. */
export const FIRECRAWL_SCRAPE_COST = 1;
const SCRAPE_TIMEOUT_MS = 45_000;

/** What one scrape did, for the record. Never carries a secret. */
export interface FirecrawlScrapeEvent {
  outcome: 'READ' | 'UNREADABLE' | 'REFUSED' | 'ERROR' | 'CEILING';
  status: number | null;
  url: string;
  detail: string;
}

export interface FirecrawlDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  record?: (event: FirecrawlScrapeEvent) => Promise<void> | void;
}

/** Whether the deployment holds a Firecrawl key. Pure. */
export function firecrawlConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return firecrawlSearch.credentials(env) !== null;
}

async function defaultRecord(event: FirecrawlScrapeEvent): Promise<void> {
  await recordBinEvent({
    eventType: FIRECRAWL_SCRAPE_EVENT,
    provider: FIRECRAWL_PROVIDER_ID,
    outcome: event.outcome,
    reason: `${event.detail} ${event.url}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { url: event.url.slice(0, 400), status: event.status },
  });
}

/**
 * The page's markdown through Firecrawl, under the page's own address; an
 * unreadable read when Firecrawl or the site refused; or null when the route
 * could not run (no key, resting, ceiling). Never throws.
 */
export async function firecrawlScrape(url: string, deps: FirecrawlDeps = {}): Promise<SourceFetch | null> {
  const env = deps.env ?? process.env;
  const credentials = firecrawlSearch.credentials(env);
  if (!credentials) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now;
  const record = async (event: FirecrawlScrapeEvent): Promise<void> => {
    try {
      await (deps.record ?? defaultRecord)({ ...event, detail: redact(event.detail, env) });
    } catch {
      // A record that cannot be written never fails the read.
    }
  };
  const now = nowMs();
  if (keyedProviderResting(FIRECRAWL_PROVIDER_ID, now)) return null;
  const ceiling = dailySearchCeiling(firecrawlSearch, env);
  // Counted before it is sent: a scrape whose answer never arrived may still be billed.
  const claim = claimKeyedCredits(FIRECRAWL_PROVIDER_ID, FIRECRAWL_SCRAPE_COST, ceiling, now);
  if (!claim.ok) {
    if (firstCeilingToday(FIRECRAWL_PROVIDER_ID, now)) {
      await record({
        outcome: 'CEILING', status: null, url,
        detail: `firecrawl reached its daily ceiling of ${ceiling} credits (${firecrawlSearch.ceilingEnv}); reads fall through until 00:00 UTC`,
      });
    }
    return null;
  }
  const spent = `${claim.used} of ${ceiling} credits today`;
  const retrievedAt = new Date(now).toISOString();
  const unreadable = (reason: 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'EMPTY', status: number | null, detail: string): SourceFetch => ({
    readable: false, requestedUrl: url, finalUrl: null, status, retrievedAt, reason, detail: redact(detail, env),
  });
  try {
    const response = await fetchImpl('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credentials['key'] ?? ''}` },
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const refused = [400, 401, 402, 403, 429].includes(response.status);
      noteKeyedOutcome(FIRECRAWL_PROVIDER_ID, refused ? 'REFUSED' : 'ERROR', nowMs());
      const reason = firecrawlSearch.refusalReason(body);
      const detail = `firecrawl answered ${response.status}${reason ? ` (${reason})` : ''}; ${spent}; it rests`;
      await record({ outcome: refused ? 'REFUSED' : 'ERROR', status: response.status, url, detail });
      // Firecrawl's own refusal says nothing about the page, so it is not reported as the site's status.
      return unreadable('NETWORK_ERROR', null, detail);
    }
    noteKeyedOutcome(FIRECRAWL_PROVIDER_ID, 'OK', nowMs());
    const data = (body as { data?: { markdown?: unknown; metadata?: { statusCode?: unknown } } } | null)?.data;
    const siteStatus = typeof data?.metadata?.statusCode === 'number' ? data.metadata.statusCode : 200;
    if (siteStatus >= 400) {
      const detail = `firecrawl reached the page and the site answered ${siteStatus}; ${spent}`;
      await record({ outcome: 'UNREADABLE', status: siteStatus, url, detail });
      return unreadable('HTTP_ERROR', siteStatus, detail);
    }
    const whole = typeof data?.markdown === 'string' ? data.markdown : '';
    if (whole.trim().length === 0) {
      const detail = `firecrawl returned no text; ${spent}`;
      await record({ outcome: 'UNREADABLE', status: siteStatus, url, detail });
      return unreadable('EMPTY', siteStatus, detail);
    }
    const text = whole.slice(0, MAX_TEXT_CHARS);
    await record({ outcome: 'READ', status: siteStatus, url, detail: `firecrawl read ${whole.length} chars; ${spent}` });
    return {
      readable: true,
      requestedUrl: url,
      // The citation is the page's own address, never Firecrawl's.
      finalUrl: url,
      status: siteStatus,
      contentType: 'text/markdown; source=firecrawl',
      retrievedAt,
      sha256: createHash('sha256').update(whole).digest('hex'),
      text,
      truncated: text.length < whole.length,
      totalChars: whole.length,
    };
  } catch (error) {
    noteKeyedOutcome(FIRECRAWL_PROVIDER_ID, 'ERROR', nowMs());
    const name = error instanceof Error ? error.name : 'Error';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const detail = `firecrawl request failed (${name}); ${spent}; it rests`;
    await record({ outcome: 'ERROR', status: null, url, detail });
    return unreadable(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', null, detail);
  }
}
