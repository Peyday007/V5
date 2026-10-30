/**
 * The volume half of discovery: code pulls, free models sort, Brain's rules
 * check, and Claude sees only a short daily list.
 *
 *   1. pull    — every source whose interval has passed is fetched by plain
 *                code and its new items stored (`feed_items`).
 *   2. screen  — each recent item goes to the cheap lane's SCREEN_LEAD task:
 *                two free models, which must agree to keep it.
 *   3. rules   — a kept lead must be recent, name a deliverable Brain proves,
 *                state a need, and not already be an opening Brain holds.
 *   4. shortlist — once a day the best few go to Claude as one discovery
 *                round. Claude verifies each against its page, through the
 *                evidence gate, and only what it verifies becomes an opening.
 *
 * Nothing here is evidence and nothing here contacts anybody. Off entirely
 * until the cheap lane is configured, because without the free models the
 * volume has nowhere to go but Claude.
 */
import { getDb } from '../../db/database.ts';
import { insertFeedItems, markShortlisted, pullState, recordFeedPull, unlistedFeedItems, type StoredFeedItem } from '../../repos/feeds.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { openingsWithSourceUrl } from '../../repos/cashPortfolio.ts';
import { listRounds, openRound } from '../../repos/cashDiscovery.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { isDown, laneConfig, modelHealth, screenLead, type Completer, type LaneConfig, type LeadOutput } from '../cheap/lane.ts';
import { executionFrame, executionFrameSentence } from '../cash/discovery.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { openingSourceKey } from '../cash/duplicates.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { DELIVERABLE_LABEL } from '../cash/deliverables/spec.ts';
import { GENERIC_PARSER, profileFor, seedRows, type FeedItem, type FeedSource } from './sources.ts';
import { addCollectSource, getCheckpoint, listCollectSources, saveCheckpoint, setRobotsStatus } from '../../repos/collectSources.ts';
import { newId } from '../../repos/util.ts';
import { collect, type CollectorKind, type FetchedBody } from '../collect/collectors/index.ts';
import { classifyFailure, fakeClock, HostLimiter, hostOf, systemClock, type Failure } from '../collect/runtime/index.ts';
import type { CollectFailureCause, CollectSource, RobotsStatus, SourceKind } from '../../domain/collect.ts';
import { FEED_SHORTLIST_BUCKET } from './bucket.ts';
import { SITE_SOURCE } from './sites.ts';
import { CODE_SIGNAL_SOURCE, coveredItems, detectionsForLeads } from './detectors.ts';

export type Fetcher = (url: string, headers: Record<string, string>, timeoutMs?: number) => Promise<unknown>;

export const httpFetcher: Fetcher = async (url, headers, timeoutMs = 20_000) => {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Name the cause: "fetch failed" alone cannot tell a timeout from a refusal.
    const cause = error instanceof Error ? ((error as Error & { cause?: { code?: string; message?: string } }).cause ?? null) : null;
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError') throw new Error(`timed out after ${timeoutMs}ms`);
    throw new Error(`fetch failed${cause?.code ? ` (${cause.code})` : cause?.message ? ` (${cause.message})` : ''}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/**
 * When a source may be asked again. A success waits its interval; a failure
 * waits a short, doubling backoff instead, so one refusal does not cost the
 * source six hours. Pure.
 */
export function nextPullAt(
  source: { intervalMs: number },
  state: { lastSuccessAt: string | null; failuresSince: number; lastFailureAt: string | null },
): number {
  if (state.failuresSince > 0 && state.lastFailureAt) {
    const backoff = Math.min(source.intervalMs, PULL_RETRY_MS * 2 ** (state.failuresSince - 1));
    return Date.parse(state.lastFailureAt) + backoff;
  }
  return state.lastSuccessAt ? Date.parse(state.lastSuccessAt) + source.intervalMs : 0;
}

/** The first wait after a failed pull. */
export const PULL_RETRY_MS = 20 * 60_000;

/** How far back a lead may have been published and still be worth asking about. */
export const LEAD_MAX_AGE_MS = 21 * 86_400_000;
/** Leads screened per pass, so one tick never spends the day. */
export const SCREENS_PER_PASS = 60;

/**
 * How hard to push the free models this pass, from how they have been
 * answering. Pure, so the rule can be argued with.
 *
 * The healthy models' recent failure rate decides: clean answers push volume
 * up, failures pull it down, and a lane failing most of the time pauses until
 * the window clears. Calls run a few at a time, never all at once.
 */
export function lanePacing(health: Map<string, { total: number; failed: number }>, isDownModel: (h: { total: number; failed: number }) => boolean): {
  perPass: number;
  parallel: number;
  failureRate: number | null;
} {
  let total = 0;
  let failed = 0;
  for (const h of health.values()) {
    if (isDownModel(h)) continue;
    total += h.total;
    failed += h.failed;
  }
  if (total < 20) return { perPass: SCREENS_PER_PASS, parallel: 4, failureRate: null };
  const rate = failed / total;
  if (rate < 0.05) return { perPass: 300, parallel: 8, failureRate: rate };
  if (rate < 0.15) return { perPass: 120, parallel: 6, failureRate: rate };
  if (rate < 0.4) return { perPass: 30, parallel: 2, failureRate: rate };
  return { perPass: 0, parallel: 1, failureRate: rate };
}
/** Leads handed to Claude per shortlist round. */
export const SHORTLIST_SIZE = 10;
/** One shortlist round a day at most. */
export const SHORTLIST_INTERVAL_MS = 20 * 3_600_000;

/** A source ready to pull, whether it came from a registry row or was handed in. */
export interface Runnable {
  slug: string;
  url: string;
  intervalMs: number;
  headers: Record<string, string>;
  timeoutMs?: number;
  /** Requests per minute allowed to this source's host; null is unconstrained. */
  hostRatePerMin: number | null;
  /** The owning project, or null when the source is public. */
  projectId: string | null;
  kind: SourceKind;
  row: { id: string; robotsStatus: RobotsStatus; pagination: string | null } | null;
  /** A bespoke parser, or null when the shared collector for `kind` reads it. */
  parse: ((body: unknown) => FeedItem[]) | null;
}

/** A hardcoded definition, run exactly as it always was. */
export function runnableFromSource(source: FeedSource): Runnable {
  return {
    slug: source.id,
    url: source.url,
    intervalMs: source.intervalMs,
    headers: source.headers ?? {},
    timeoutMs: source.timeoutMs,
    hostRatePerMin: source.spacingMs ? 60_000 / source.spacingMs : null,
    projectId: null,
    kind: 'JSON_API',
    row: null,
    parse: (body) => source.parse(body),
  };
}

/** A registry row, with its parser looked up by id. Null when the row names a parser this code does not have. */
export function runnableFromRow(row: CollectSource): Runnable | null {
  const profile = row.parserId === GENERIC_PARSER ? null : profileFor(row.parserId);
  if (row.parserId !== GENERIC_PARSER && !profile) return null;
  return {
    slug: row.slug,
    url: row.urlTemplate,
    intervalMs: row.intervalMs,
    headers: profile?.headers ?? {},
    timeoutMs: profile?.timeoutMs,
    hostRatePerMin: row.hostRatePerMin,
    projectId: row.projectId,
    kind: row.kind,
    row: { id: row.id, robotsStatus: row.robotsStatus, pagination: row.pagination },
    parse: profile ? profile.parse : null,
  };
}

/** Insert the hardcoded sources and the site sweep as rows, once. A row an operator changed is left alone. */
export async function ensureSeededSources(): Promise<void> {
  const held = new Set((await listCollectSources(null)).map((one) => one.slug));
  for (const seed of seedRows()) {
    if (held.has(seed.slug)) continue;
    const row = await addCollectSource({
      slug: seed.slug,
      label: seed.label,
      kind: seed.kind,
      urlTemplate: seed.urlTemplate,
      parserId: seed.parserId,
      intervalMs: seed.intervalMs,
      hostRatePerMin: seed.hostRatePerMin,
    });
    // These are the publishers' own programmatic interfaces, read within their stated limits.
    if (row.robotsStatus === 'UNCHECKED') {
      await setRobotsStatus(row.id, 'ALLOWED', 'A public programmatic interface, read at the publisher\'s stated interval.');
    }
  }
}

interface RegistryRow {
  id: string; project_id: string | null; slug: string; label: string; kind: string; url_template: string;
  pagination: string | null; parser_id: string; interval_ms: number; host_rate_per_min: number | null;
  robots_status: string; robots_checked_at: string | null; robots_note: string | null; enabled: number;
  created_at: string; updated_at: string;
}

/** Every enabled source of every project: collection is global, reading is not. */
async function enabledRows(): Promise<CollectSource[]> {
  const rows = await getDb().all<RegistryRow>('SELECT * FROM collect_sources WHERE enabled = 1 ORDER BY slug');
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, slug: r.slug, label: r.label, kind: r.kind as SourceKind,
    urlTemplate: r.url_template, pagination: r.pagination, parserId: r.parser_id, intervalMs: r.interval_ms,
    hostRatePerMin: r.host_rate_per_min, robotsStatus: r.robots_status as RobotsStatus,
    robotsCheckedAt: r.robots_checked_at, robotsNote: r.robots_note, enabled: true,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

/** A body as text, with the validators the next conditional request needs. Never throws on a refusal. */
export type TextFetcher = (url: string, headers: Record<string, string>, timeoutMs?: number) => Promise<FetchedBody>;

export const httpTextFetcher: TextFetcher = async (url, headers, timeoutMs = 20_000) => {
  let response: Response;
  try {
    response = await fetch(url, { headers: { 'user-agent': 'brain-feed/1.0', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError') throw new Error(`timed out after ${timeoutMs}ms`);
    const cause = error instanceof Error ? ((error as Error & { cause?: { code?: string } }).cause ?? null) : null;
    throw new Error(`fetch failed${cause?.code ? ` (${cause.code})` : ''}`);
  }
  return {
    status: response.status,
    body: response.status === 304 ? '' : await response.text(),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
};

/**
 * Whether robots.txt lets `agent` fetch `path`. Pure. The longest matching rule
 * wins and Allow beats Disallow on a tie, as the standard says; no rule allows.
 */
export function robotsAllows(robots: string, path: string, agent = 'brain-feed'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; prefix: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: field === 'allow', prefix: value });
    } else lastWasAgent = false;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const applicable = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      const pattern = rule.prefix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      if (!new RegExp(`^${pattern}`).test(path)) continue;
      const len = rule.prefix.length;
      if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
    }
  }
  return best ? best.allow : true;
}

const COLLECTOR_KIND: Record<SourceKind, CollectorKind> = {
  RSS_ATOM: 'RSS_ATOM', JSON_API: 'JSON_API', CSV_DATASET: 'CSV', SITEMAP: 'SITEMAP',
  HTML_LIST: 'HTML_LIST', OVERPASS: 'OVERPASS', PAGE_WATCH: 'PAGE_WATCH',
};

/** What a failure is called on the pull's row. SOURCE_UNREACHABLE and NO_MATCHING_RECORDS are never the same. */
export function failureCauseOf(failure: Failure): CollectFailureCause {
  switch (failure.cause) {
    case 'TIMEOUT': return 'TIMEOUT';
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'SERVER_ERROR': return 'SERVER_ERROR';
    case 'UNAUTHORIZED': case 'FORBIDDEN': case 'GONE': case 'ROBOTS_DISALLOWED': case 'CLIENT_ERROR': case 'NOT_FOUND':
      return 'REFUSED';
    default: return 'SOURCE_UNREACHABLE';
  }
}

async function recordPull(input: {
  source: string; ok: boolean; fetched: number; inserted: number; error: string | null; at: string;
  method: SourceKind; duplicates: number | null; cause: CollectFailureCause | null; wallMs: number; bytes: number | null; memoryBytes: number;
}): Promise<void> {
  // Written here rather than through recordFeedPull because a pull's timestamp is its caller's `now`.
  await getDb().run(
    `INSERT INTO feed_pulls
       (id, source, ok, fetched, inserted, error, created_at, method, duplicates, failure_cause, wall_ms, bytes, memory_bytes,
        cheap_calls, claude_jobs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [newId('fdp'), input.source, input.ok ? 1 : 0, input.fetched, input.inserted, input.error, input.at, input.method,
      input.duplicates, input.cause, input.wallMs, input.bytes, input.memoryBytes],
  );
}

/** One page of a registry source, read by its shared collector. */
async function collectGeneric(job: Runnable, textFetcher: TextFetcher): Promise<{ items: FeedItem[]; bytes: number; unchanged: boolean }> {
  const checkpoint = job.row ? await getCheckpoint(job.row.id) : null;
  const maxPages = Math.min(10, Math.max(1, Number(/^pages:(\d+)$/.exec(job.row?.pagination ?? '')?.[1] ?? 1)));
  const items: FeedItem[] = [];
  let url = job.url;
  let bytes = 0;
  let first: { etag: string | null; lastModified: string | null; contentHash: string } | null = null;
  for (let page = 0; page < maxPages; page++) {
    const conditional: Record<string, string> = { ...job.headers };
    if (page === 0 && checkpoint?.etag) conditional['if-none-match'] = checkpoint.etag;
    if (page === 0 && checkpoint?.lastModified) conditional['if-modified-since'] = checkpoint.lastModified;
    const fetched = await textFetcher(url, conditional, job.timeoutMs);
    bytes += fetched.body.length;
    const outcome = collect(COLLECTOR_KIND[job.kind], fetched, {
      url,
      previous: page === 0 && checkpoint ? { etag: checkpoint.etag, lastModified: checkpoint.lastModified, contentHash: checkpoint.contentHash } : undefined,
    });
    if (outcome.kind === 'REFUSED') {
      // A refusal is recorded with its status, and never worked around.
      throw new Error(`HTTP ${outcome.refusal.status ?? 403}: ${outcome.refusal.reason} - ${outcome.refusal.detail}`);
    }
    if (outcome.kind === 'UNCHANGED') return { items, bytes, unchanged: page === 0 };
    if (page === 0) first = { etag: outcome.kind === 'RECORDS' || outcome.kind === 'NO_MATCHING_RECORDS' ? outcome.etag : null, lastModified: outcome.kind === 'RECORDS' || outcome.kind === 'NO_MATCHING_RECORDS' ? outcome.lastModified : null, contentHash: outcome.contentHash };
    if (outcome.kind === 'NO_MATCHING_RECORDS') break;
    for (const record of outcome.records) {
      if (!record.title) continue;
      items.push({
        externalId: record.externalId,
        url: record.url ?? job.url,
        title: record.title,
        body: record.body,
        organization: record.organization,
        publishedAt: record.publishedAt,
      });
    }
    if (!outcome.nextPage) break;
    url = outcome.nextPage;
  }
  if (job.row && first) await saveCheckpoint(job.row.id, { etag: first.etag, lastModified: first.lastModified, contentHash: first.contentHash });
  return { items, bytes, unchanged: false };
}

/** Whether a source's robots.txt allows us, recorded on its row the first time. False means do not pull. */
async function robotsPermits(job: Runnable, textFetcher: TextFetcher): Promise<boolean> {
  if (!job.row) return true;
  if (job.row.robotsStatus === 'ALLOWED') return true;
  if (job.row.robotsStatus !== 'UNCHECKED') return false;
  try {
    const target = new URL(job.url);
    const fetched = await textFetcher(`${target.origin}/robots.txt`, {}, 10_000);
    if (fetched.status >= 200 && fetched.status < 300 && !robotsAllows(fetched.body, `${target.pathname}${target.search}`)) {
      await setRobotsStatus(job.row.id, 'DISALLOWED', 'robots.txt disallows this path for this client.');
      return false;
    }
    await setRobotsStatus(job.row.id, 'ALLOWED', fetched.status >= 200 && fetched.status < 300 ? 'robots.txt allows this path.' : 'No robots.txt was published.');
    return true;
  } catch {
    // An unanswered robots.txt is not a verdict: leave it unchecked and let the pull itself say what happened.
    return true;
  }
}

export async function pullDueFeeds(input: {
  now?: Date;
  fetcher?: Fetcher;
  textFetcher?: TextFetcher;
  /** Explicit definitions, run as given. Without them the registry decides. */
  sources?: readonly FeedSource[];
} = {}): Promise<{ source: string; inserted: number; error: string | null }[]> {
  const now = input.now ?? new Date();
  const out: { source: string; inserted: number; error: string | null }[] = [];
  let jobs: Runnable[];
  if (input.sources) jobs = input.sources.map(runnableFromSource);
  else {
    await ensureSeededSources();
    jobs = (await enabledRows()).map(runnableFromRow).filter((one): one is Runnable => !!one);
  }
  // Each host's tightest stated rate governs every source on it. Tests and injected fetchers never wait.
  const clock = input.fetcher || input.textFetcher ? fakeClock(now.getTime()) : systemClock;
  const overrides: Record<string, { capacity: number; refillPerSecond: number }> = {};
  for (const job of jobs) {
    if (!job.hostRatePerMin) continue;
    const host = hostOf(job.url);
    const refillPerSecond = job.hostRatePerMin / 60;
    const held = overrides[host];
    if (!held || refillPerSecond < held.refillPerSecond) overrides[host] = { capacity: 1, refillPerSecond };
  }
  const limiter = new HostLimiter(clock, { capacity: 1_000_000, refillPerSecond: 1_000_000 }, overrides);
  const fetcher = input.fetcher ?? httpFetcher;
  const textFetcher = input.textFetcher ?? httpTextFetcher;
  for (const job of jobs) {
    if (now.getTime() < nextPullAt(job, await pullState(job.slug))) continue;
    // One source's failure is its own result; the next one is still asked.
    const started = Date.now();
    try {
      if (!(await robotsPermits(job, textFetcher))) continue;
      await limiter.acquire(hostOf(job.url));
      let items: FeedItem[];
      let bytes: number | null = null;
      if (job.parse) {
        const body = await fetcher(job.url, job.headers, job.timeoutMs);
        items = job.parse(body);
        try { bytes = JSON.stringify(body)?.length ?? null; } catch { bytes = null; }
      } else {
        const read = await collectGeneric(job, textFetcher);
        items = read.items;
        bytes = read.bytes;
      }
      const inserted = await insertFeedItems(job.slug, items);
      // A private source's items are read only by its project.
      if (job.projectId) await getDb().run('UPDATE feed_items SET project_id = ? WHERE source = ? AND project_id IS NULL', [job.projectId, job.slug]);
      await recordPull({
        source: job.slug, ok: true, fetched: items.length, inserted, error: null, at: now.toISOString(), method: job.kind,
        duplicates: items.length - inserted, cause: items.length === 0 ? 'NO_MATCHING_RECORDS' : null,
        wallMs: Date.now() - started, bytes, memoryBytes: process.memoryUsage().rss,
      });
      out.push({ source: job.slug, inserted, error: null });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      const failure = classifyFailure(error);
      await recordPull({
        source: job.slug, ok: false, fetched: 0, inserted: 0, error: message, at: now.toISOString(), method: job.kind,
        duplicates: null, cause: failureCauseOf(failure), wallMs: Date.now() - started, bytes: null, memoryBytes: process.memoryUsage().rss,
      });
      out.push({ source: job.slug, inserted: 0, error: message });
    }
  }
  return out;
}

/** Items a project may read: public sources' and its own. Passing null reads only the public ones. */
export async function feedItemsVisibleTo(projectId: string | null): Promise<StoredFeedItem[]> {
  const rows = await getDb().all<{
    id: string; source: string; external_id: string; url: string; title: string; body: string | null;
    organization: string | null; published_at: string | null; fetched_at: string; shortlisted_round_id: string | null;
  }>(
    'SELECT * FROM feed_items WHERE project_id IS NULL OR project_id = ? ORDER BY fetched_at DESC, id DESC',
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id, source: r.source, externalId: r.external_id, url: r.url, title: r.title, body: r.body,
    organization: r.organization, publishedAt: r.published_at, fetchedAt: r.fetched_at, shortlistedRoundId: r.shortlisted_round_id,
  }));
}

/** Of these item ids, the ones another project owns and this one may not read. */
async function foreignItemIds(ids: readonly string[], projectId: string | null): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM feed_items WHERE project_id IS NOT NULL AND (project_id <> ? OR ? IS NULL)
        AND id IN (${ids.map(() => '?').join(',')})`,
    [projectId ?? '', projectId, ...ids],
  );
  return new Set(rows.map((r) => r.id));
}

/** The latest SCREEN_LEAD answers, per item, already combined. */
async function screenedLeads(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb().all<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM cheap_results
      WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${ids.map(() => '?').join(',')})`,
    [...ids],
  );
  return new Set(rows.map((row) => row.subject_id));
}

/** The rules a free model's KEEP must also pass. Pure, so it can be argued with. */
export function leadPassesRules(item: StoredFeedItem, screen: LeadOutput | null, now: Date): boolean {
  if (!screen || screen.verdict !== 'KEEP') return false;
  if (screen.deliverable === 'NONE') return false;
  if (screen.need.length < 4) return false;
  const published = Date.parse(item.publishedAt ?? item.fetchedAt);
  if (!Number.isFinite(published) || now.getTime() - published > LEAD_MAX_AGE_MS) return false;
  return true;
}

/** Screen recent, unscreened leads with the free models. Bounded per pass. */
export async function screenFeedLeads(input: {
  now?: Date;
  config?: LaneConfig | null;
  completer?: Completer;
} = {}): Promise<number> {
  const now = input.now ?? new Date();
  const config = input.config === undefined ? laneConfig() : input.config;
  if (!config) return 0;
  const since = new Date(now.getTime() - LEAD_MAX_AGE_MS).toISOString();
  const recent = await unlistedFeedItems({ since, limit: 2_000 });
  const done = await screenedLeads(recent.map((one) => one.id));
  const health = await modelHealth('SCREEN_LEAD', now);
  const pace = lanePacing(health, isDown);
  // A record a code rule already accounts for is not asked about one by one.
  const covered = await coveredItems(recent.map((one) => one.id));
  const todo = recent
    .filter((item) => item.source !== SITE_SOURCE && item.source !== CODE_SIGNAL_SOURCE && !covered.has(item.id) && !done.has(item.id))
    .filter((item) => {
      const published = Date.parse(item.publishedAt ?? item.fetchedAt);
      return !Number.isFinite(published) || now.getTime() - published <= LEAD_MAX_AGE_MS;
    })
    .slice(0, pace.perPass);
  let screened = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const item = todo[next++]!;
      await screenLead(
        item.id,
        {
          source: item.source,
          title: item.title,
          organization: item.organization,
          publishedAt: item.publishedAt,
          body: item.body,
          url: item.url,
        },
        { config, completer: input.completer, now, health },
      );
      screened += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, pace.parallel) }, () => worker()));
  return screened;
}

/** Combined screen answers for these items, read back from rows. */
async function leadScreens(items: readonly StoredFeedItem[]): Promise<Map<string, LeadOutput>> {
  const out = new Map<string, LeadOutput>();
  if (items.length === 0) return out;
  const { parseLead, combineLeads } = await import('../cheap/lane.ts');
  const rows = await getDb().all<{ subject_id: string; model: string; ok: number; output: string | null }>(
    `SELECT subject_id, model, ok, output FROM cheap_results
      WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${items.map(() => '?').join(',')})
      ORDER BY created_at DESC`,
    items.map((one) => one.id),
  );
  const by = new Map<string, (LeadOutput | null)[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.subject_id}\n${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    by.set(row.subject_id, [...(by.get(row.subject_id) ?? []), row.ok && row.output ? parseLead(row.output) : null]);
  }
  for (const [id, answers] of by) {
    const merged = combineLeads(answers);
    if (merged) out.set(id, merged);
  }
  // A code detection is recognised by a rule, so it needs no model to keep it —
  // and it is still only a lead: Claude verifies it on the shortlist like any other.
  const detections = await detectionsForLeads(items.filter((one) => one.source === CODE_SIGNAL_SOURCE).map((one) => one.id));
  for (const item of items) {
    const detection = detections.get(item.id);
    if (!detection || !detection.deliverable) continue;
    out.set(item.id, {
      verdict: 'KEEP',
      window: 'ONGOING',
      deliverable: detection.deliverable,
      need: detection.label,
      payer: item.organization ?? '',
      reason: 'Recognised by a code rule; a pattern, not a confirmed buyer.',
    });
  }
  // A broken site is proved by code, so it needs no model to keep it.
  for (const item of items) {
    if (item.source !== SITE_SOURCE) continue;
    const need = item.title.split(': ').slice(1).join(': ') || 'a broken website';
    out.set(item.id, { verdict: 'KEEP', window: 'SHORT', deliverable: 'WEBSITE', need, payer: 'the business owner', reason: 'Shown twice by a code check.' });
  }
  return out;
}

/**
 * Whether a line can go into the question as written. A post's own words are
 * untrusted: a title naming a state would narrow the round's jurisdiction
 * (§25), and one an envelope reads as Brain's own action would get the whole
 * round refused. Checked in the form it is rendered in.
 */
export function safeLeadLine(line: string): boolean {
  const rendered = `- lead: ${line}`;
  if (statesNamedIn(rendered).length > 0) return false;
  return Object.values(APPROVAL_ENVELOPES).every((envelope) => !describesOwnAction(rendered, envelope.forbiddenActions));
}

/** One line of the shortlist question, or null when it cannot be said safely. */
function shortlistLine(item: StoredFeedItem, screen: LeadOutput): string | null {
  const clean = (value: string, max: number) => value.replace(/[.,;:!?—–\n"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const line =
    `"${clean(item.title, 90)}" at ${item.url} — the need as read: ${clean(screen.need, 80)}; ` +
    `the work it could take: ${DELIVERABLE_LABEL[screen.deliverable as keyof typeof DELIVERABLE_LABEL] ?? screen.deliverable}`;
  if (safeLeadLine(line)) return line;
  const bare = `${item.url} — the work it could take: ${screen.deliverable}`;
  return safeLeadLine(bare) ? bare : null;
}

/**
 * Open today's shortlist round for one project, when it is due.
 *
 * It is the one Claude discovery round that `BRAIN_CLAUDE_DISCOVERY=off` does
 * not stop, because it is not bulk finding: it is a strong model verifying a
 * short list the free models and the rules already narrowed.
 */
export async function openFeedShortlist(input: { projectId: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed || !gate.mode) return null;
  const mode = gate.mode;
  const history = (await listRounds(input.projectId)).filter((one) => one.bucketId === FEED_SHORTLIST_BUCKET.id);
  if (history.some((one) => one.state === 'OPEN')) return null;
  const latest = history.reduce<string | null>((max, one) => (!max || one.openedAt > max ? one.openedAt : max), null);
  if (latest && now.getTime() - Date.parse(latest) < SHORTLIST_INTERVAL_MS) return null;

  const { chosen } = await shortlistFunnel(input.projectId, now);
  if (chosen.length === 0) return null;

  const frame = await executionFrame(input.projectId, mode.currency);
  const statement = [
    FEED_SHORTLIST_BUCKET.question,
    `This is for a short cash sprint whose goal is: ${mode.objective}`,
    frame ? executionFrameSentence(frame) : '',
    'Free models read these public posts and kept them; nothing about them is established yet. ' +
      'Open each page. Report as an opening only what the page itself shows, quoting it, and say ' +
      'plainly for each one that does not hold up.',
    ...chosen.map(({ line }) => `\n- lead: ${line}`),
  ]
    .filter(Boolean)
    .join(' ');

  const roundNo = history.reduce((max, one) => Math.max(max, one.round), 0) + 1;
  const round = await getDb().transaction(async () => {
    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: roundNo === 1 ? FEED_SHORTLIST_BUCKET.title : `${FEED_SHORTLIST_BUCKET.title} (round ${roundNo})`,
      statement,
    });
    const result = await openRound({
      projectId: input.projectId,
      cashModeId: mode.id,
      bucketId: FEED_SHORTLIST_BUCKET.id,
      mechanism: FEED_SHORTLIST_BUCKET.mechanism,
      round: roundNo,
      candidateId: candidate.id,
    });
    if (!result.created) throw new ShortlistLost();
    return result.round;
  }).catch((error: unknown) => {
    if (error instanceof ShortlistLost) return null;
    throw error;
  });
  if (!round) return null;
  await markShortlisted(chosen.map(({ item }) => item.id), round.id);
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'CASH_DISCOVERY_OPENED',
    actorRef: 'BRAIN',
    summary: `Feed shortlist opened: ${chosen.length} lead(s) for Claude to verify (round ${roundNo}).`,
    detail: {
      bucketId: FEED_SHORTLIST_BUCKET.id,
      candidateId: round.candidateId,
      cashModeId: mode.id,
      round: roundNo,
      leads: chosen.map(({ item }) => item.id),
    },
  });
  return round.id;
}

class ShortlistLost extends Error {}

export interface ShortlistFunnel {
  /** Recent leads no shortlist has taken. */
  pool: number;
  /** Of those, screened by the free models at all. */
  screened: number;
  /** Combined verdict KEEP. */
  kept: number;
  /** KEEP, deliverable, stated need, recent. */
  passedRules: number;
  /** Not already an opening, and its line can be said safely. */
  chosen: { item: StoredFeedItem; line: string }[];
}

/** Which leads would go to Claude now, with the count at every step. Writes nothing. */
export async function shortlistFunnel(projectId: string, now: Date = new Date()): Promise<ShortlistFunnel> {
  const since = new Date(now.getTime() - LEAD_MAX_AGE_MS).toISOString();
  const unfiltered = await unlistedFeedItems({ since, limit: 2_000 });
  const foreign = await foreignItemIds(unfiltered.map((one) => one.id), projectId);
  const pool = unfiltered.filter((one) => !foreign.has(one.id));
  const screens = await leadScreens(pool);
  const held = new Set(
    (await openingsWithSourceUrl(projectId))
      .map(({ sourceUrl }) => openingSourceKey(sourceUrl))
      .filter((key): key is string => !!key),
  );
  const ranked = pool
    .filter((item) => leadPassesRules(item, screens.get(item.id) ?? null, now))
    // Fast cash: a lead with no near window waits until the short ones run out.
    .filter((item, _i, all) =>
      screens.get(item.id)?.window === 'SHORT' ||
      all.filter((one) => screens.get(one.id)?.window === 'SHORT').length < SHORTLIST_SIZE)
    .filter((item) => {
      const key = openingSourceKey(item.url);
      return !key || !held.has(key);
    })
    .sort((a, b) => {
      const wa = screens.get(a.id)?.window === 'SHORT' ? 0 : 1;
      const wb = screens.get(b.id)?.window === 'SHORT' ? 0 : 1;
      if (wa !== wb) return wa - wb;
      return (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt);
    });
  const chosen: { item: StoredFeedItem; line: string }[] = [];
  for (const item of ranked) {
    if (chosen.length >= SHORTLIST_SIZE) break;
    const line = shortlistLine(item, screens.get(item.id)!);
    if (line) chosen.push({ item, line });
  }
  return {
    pool: pool.length,
    screened: pool.filter((item) => screens.has(item.id)).length,
    kept: pool.filter((item) => screens.get(item.id)?.verdict === 'KEEP').length,
    passedRules: pool.filter((item) => leadPassesRules(item, screens.get(item.id) ?? null, now)).length,
    chosen,
  };
}


/** The project feeds shortlist into: the oldest active sprint. */
export async function shortlistProject(projectIds: readonly string[]): Promise<string | null> {
  for (const id of projectIds) {
    const mode = await getCashMode(id);
    if (mode && mode.state === 'ACTIVE') return id;
  }
  return null;
}
