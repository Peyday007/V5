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
import { sprintGoalLine } from '../../domain/operatingModel.ts';
import { getDb } from '../../db/database.ts';
import { insertFeedItems, markShortlisted, pullState, recordFeedPull, unlistedFeedItems, type StoredFeedItem } from '../../repos/feeds.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { openingsWithSourceUrl } from '../../repos/cashPortfolio.ts';
import { listRounds, openRound } from '../../repos/cashDiscovery.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import {
  httpCompleter,
  inputHash,
  isDown,
  laneConfig,
  modelHealth,
  parseLead,
  screenLead,
  TASKS,
  type Completer,
  type LaneConfig,
  type LeadInput,
  type LeadOutput,
  type ModelHealth,
} from '../cheap/lane.ts';
import { newId, nowIso } from '../../repos/util.ts';
import { executionFrame, executionFrameSentence } from '../cash/discovery.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { openingSourceKey } from '../cash/duplicates.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { DELIVERABLE_LABEL } from '../cash/deliverables/spec.ts';
import { FEED_SOURCES, pullUrl, type FeedSource } from './sources.ts';
import { FEED_SHORTLIST_BUCKET } from './bucket.ts';
import { SITE_SOURCE } from './sites.ts';
import { CODE_SIGNAL_SOURCE, coveredItems, detectionsForLeads } from './detectors.ts';
import { extractItem, extractItems, MODEL_BATCH_SIZE, type ExtractableItem, type ExtractedFact } from './extract.ts';
import { addExtractedItems, currentEventGraph, syncEventGraph, type ExtractedItemsUpdate, type GraphHypothesis } from '../industry/eventGraph.ts';
import { constructFromGraph, type MissingLinkQuestion } from '../cash/construct.ts';
import type { Weakness } from '../../domain/improvement.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import {
  corpusProposalKey,
  corpusToAdd,
  needFromUnknown,
  recordCorporaEvaluation,
  type CorporaEvaluation,
  type CorpusDecision,
  type CorpusNeed,
} from './corpora.ts';
import { conditionalFetcher, contentHashOf, httpTransport, preferredReadable, resolveAccess, type ConditionalResult, type Transport, type Validators } from './access.ts';
import { feedIngestStore, ingestShards, type IngestStore, type ShardedSource } from './ingest.ts';
import type { SourceAcquisition } from './sources.ts';

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
  source: Pick<FeedSource, 'intervalMs'>,
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
/** One shortlist round a day at most while the research fleet is busy. */
export const SHORTLIST_INTERVAL_MS = 20 * 3_600_000;
/**
 * While research surfaces sit idle with nothing waiting, the next shortlist may
 * open this soon after the last one settled, and carries more leads. Production,
 * 2026-11-01: 670 leads kept by the free models, ten a day reaching Claude, and
 * routable research surfaces idle beside them. Spare is zero the moment work
 * queues up, so this binds only while capacity is idle (§78).
 */
export const SHORTLIST_SPARE_INTERVAL_MS = 2 * 3_600_000;
export const SHORTLIST_PER_SPARE = 5;
export const SHORTLIST_MAX_SIZE = 25;

/** The shortlist's size and spacing for this much idle research capacity. Pure. */
export function shortlistPace(spare: number): { size: number; intervalMs: number } {
  const idle = Math.max(0, Math.trunc(spare));
  return idle > 0
    ? { size: Math.min(SHORTLIST_MAX_SIZE, SHORTLIST_SIZE + SHORTLIST_PER_SPARE * idle), intervalMs: SHORTLIST_SPARE_INTERVAL_MS }
    : { size: SHORTLIST_SIZE, intervalMs: SHORTLIST_INTERVAL_MS };
}

export interface FeedPullResult {
  source: string;
  inserted: number;
  error: string | null;
  /** Items the response carried. */
  fetched: number;
  /** Of those, items already stored: dropped by storage, never screened again. */
  duplicates: number;
  /** Whether the request was narrowed to what was published since the source's last success. */
  incremental: boolean;
  /** The source answered that nothing changed (304, or the same content hash): nothing was ingested. */
  notModified?: boolean;
  /** Why the source was not asked at all this pass (its corpus evaluation skipped it, or no permitted access). */
  skipped?: string | null;
  /** Shards a previous, interrupted read had already checkpointed and this one did not fetch again. */
  resumedPast?: string[];
  /** The connector-health outcome recorded after the pull (`superviseConnector`). */
  health?: string | null;
}

// ---------------------------------------------------------------------------
// The acquisition pipeline (ACQ-21-3, ACQ-21-4): every due source with
// acquisition metadata is taken, in order, through corpus evaluation, access
// resolution, a conditional and checkpointed ingest, provenance-bearing
// records, connector health and yield ranking. Every stage is an existing
// owner (`corpora.ts`, `access.ts`, `ingest.ts`, `health.ts`); this function
// only puts them in order. No table, queue or scheduler is added.
// ---------------------------------------------------------------------------

/** The bin event one source's pull is recorded under: its validators, provenance and outcome. */
export const FEED_ACQUISITION_EVENT = 'FEED_ACQUISITION';
/** The bin event one window's per-source yield is recorded under. */
export const FEED_SOURCE_YIELD_EVENT = 'FEED_SOURCE_YIELD';
/** One yield reading per window. */
export const SOURCE_YIELD_WINDOW_MS = 24 * 3_600_000;
/** What a pull answered with a 304 or an unchanged hash is recorded as, so health never reads it as an empty parse. */
export const NOT_MODIFIED_MARK = 'NOT_MODIFIED';
/** The version of this pipeline's ordering, carried on every acquisition row. */
export const ACQUISITION_PIPELINE_VERSION = 'feeds-acquisition/1';

/** One source's yield over a window, read from rows. */
export interface SourceYield {
  source: string;
  /** Items the source's pulls carried in the window. */
  acquired: number;
  /** Stored items the screen kept or a code rule accounted for: accepted information. */
  accepted: number;
  /** Stored items a shortlist round took: commercially usable leads. */
  usable: number;
  acceptedShare: number | null;
  usableShare: number | null;
  /** Marginal decision value per acquired item; null when nothing was acquired (unknown, never favourable). */
  value: number | null;
}

/** Marginal decision value: a usable lead is worth twice an accepted record, and volume alone is worth nothing. Pure. */
export function sourceYieldValue(y: Pick<SourceYield, 'acquired' | 'accepted' | 'usable'>): number | null {
  if (y.acquired <= 0) return null;
  return Math.round(((2 * y.usable + y.accepted) / y.acquired) * 10_000) / 10_000;
}

/**
 * The order to pull sources in: highest marginal decision value first; a source
 * with no reading ranks after every source with one, as if worth nothing
 * (inv. 39); ties keep catalog order. Volume is not an input. Pure.
 */
export function orderByYield<T extends { id: string }>(sources: readonly T[], yields: ReadonlyMap<string, number | null>): T[] {
  return sources
    .map((source, i) => ({ source, i, value: yields.get(source.id) ?? null }))
    .sort((a, b) => {
      const av = a.value ?? -1;
      const bv = b.value ?? -1;
      return bv - av || a.i - b.i;
    })
    .map((one) => one.source);
}

/** Per-source yield over [since, until), read from `feed_pulls`, `feed_items` and the screen's rows. */
export async function readSourceYields(since: string, until: string): Promise<SourceYield[]> {
  const db = getDb();
  const pulls = await db.all<{ source: string; fetched: number | string | null }>(
    `SELECT source, SUM(fetched) AS fetched FROM feed_pulls WHERE ok = 1 AND created_at >= ? AND created_at < ? GROUP BY source`,
    [since, until],
  );
  const items = await db.all<{ id: string; source: string; shortlisted_round_id: string | null }>(
    `SELECT id, source, shortlisted_round_id FROM feed_items WHERE fetched_at >= ? AND fetched_at < ? AND source <> ? AND source <> ?`,
    [since, until, CODE_SIGNAL_SOURCE, SITE_SOURCE],
  );
  const kept = new Set<string>();
  for (let at = 0; at < items.length; at += SUBJECT_PAGE) {
    const chunk = items.slice(at, at + SUBJECT_PAGE).map((one) => one.id);
    const rows = await db.all<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM cheap_results
        WHERE kind = 'SCREEN_LEAD' AND ok = 1 AND output LIKE ? AND subject_id IN (${chunk.map(() => '?').join(',')})`,
      ['%"verdict":"KEEP"%', ...chunk],
    );
    for (const row of rows) kept.add(row.subject_id);
    for (const id of await coveredItems(chunk)) kept.add(id);
  }
  const by = new Map<string, SourceYield>();
  const at = (source: string): SourceYield => {
    let y = by.get(source);
    if (!y) {
      y = { source, acquired: 0, accepted: 0, usable: 0, acceptedShare: null, usableShare: null, value: null };
      by.set(source, y);
    }
    return y;
  };
  for (const row of pulls) at(row.source).acquired += Number(row.fetched ?? 0);
  for (const item of items) {
    const y = at(item.source);
    if (kept.has(item.id) || item.shortlisted_round_id) y.accepted += 1;
    if (item.shortlisted_round_id) y.usable += 1;
  }
  for (const y of by.values()) {
    y.acceptedShare = y.acquired > 0 ? Math.round((y.accepted / y.acquired) * 10_000) / 10_000 : null;
    y.usableShare = y.acquired > 0 ? Math.round((y.usable / y.acquired) * 10_000) / 10_000 : null;
    y.value = sourceYieldValue(y);
  }
  return [...by.values()].sort((a, b) => a.source.localeCompare(b.source));
}

/** The values the latest recorded yield reading gave each source, and when that window ended. */
export async function latestSourceYields(): Promise<{ until: string | null; values: Map<string, number | null> }> {
  const row = await getDb().get<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = ? ORDER BY at DESC, id DESC LIMIT 1`,
    [FEED_SOURCE_YIELD_EVENT],
  );
  const values = new Map<string, number | null>();
  let until: string | null = null;
  try {
    const m = JSON.parse(row?.measures ?? '{}') as { until?: unknown; sources?: unknown };
    if (typeof m.until === 'string') until = m.until;
    if (Array.isArray(m.sources)) {
      for (const one of m.sources as Partial<SourceYield>[]) {
        if (one && typeof one.source === 'string') values.set(one.source, typeof one.value === 'number' ? one.value : null);
      }
    }
  } catch {
    // An unreadable reading ranks nothing: every source keeps catalog order.
  }
  return { until, values };
}

/**
 * Record the yield of every source for the window since the last reading, once
 * per window: the share of what each source acquired that became accepted
 * information and commercially usable leads. The next pulls are ordered by it.
 */
export async function recordSourceYields(now: Date, record: typeof recordBinEvent = recordBinEvent): Promise<SourceYield[] | null> {
  const last = await latestSourceYields();
  const since = last.until ?? new Date(now.getTime() - SOURCE_YIELD_WINDOW_MS).toISOString();
  if (last.until && now.getTime() - Date.parse(last.until) < SOURCE_YIELD_WINDOW_MS) return null;
  const until = now.toISOString();
  const yields = await readSourceYields(since, until);
  await record({
    eventType: FEED_SOURCE_YIELD_EVENT,
    workloadClass: 'acquisition',
    outcome: 'MEASURED',
    reason: `Per-source yield ${since} to ${until}: ${yields.map((y) => `${y.source} ${y.accepted}/${y.usable} of ${y.acquired}`).join('; ')}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { since, until, pipeline: ACQUISITION_PIPELINE_VERSION, sources: yields },
  });
  return yields;
}

/** The validators the last successful read of a source stored. */
async function readValidators(source: string): Promise<Validators | null> {
  const row = await getDb().get<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = ? AND provider = ? AND outcome IN ('INGESTED', 'NOT_MODIFIED')
      ORDER BY at DESC, id DESC LIMIT 1`,
    [FEED_ACQUISITION_EVENT, source],
  );
  try {
    const v = (JSON.parse(row?.measures ?? '{}') as { validators?: Validators }).validators;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** A conditional read of a JSON resource, as the pipeline fetcher sees it. */
export type ConditionalRead = (url: string, prior: Validators | null, headers: Record<string, string>, timeoutMs?: number) => Promise<ConditionalResult>;

/** The dependencies of the acquisition stages. Production uses the real owners; tests inject. */
export interface AcquisitionDeps {
  /** The network call under the conditional reader. */
  transport?: Transport;
  /** Corpus evaluation, recorded (`recordCorporaEvaluation`). */
  evaluate?: (need: CorpusNeed) => Promise<CorporaEvaluation>;
  /** The store sharded reads checkpoint into; absent, a sharded source is read whole into `feed_items`. */
  ingestStore?: IngestStore | null;
  /** Connector supervision after each pull. */
  supervise?: (source: string, intervalMs: number) => Promise<{ outcome: string }>;
  validators?: (source: string) => Promise<Validators | null>;
  record?: typeof recordBinEvent;
  /** Per-source marginal decision values to order pulls by; absent, the latest recorded reading. */
  yields?: () => Promise<ReadonlyMap<string, number | null>>;
  /** Record the window's yield reading (default `recordSourceYields`). */
  recordYields?: (now: Date) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

const ACCEPT_JSON = { accept: 'application/json' };

/** Parse a JSON body; a body that is not JSON throws the parser's own SyntaxError, which health reads as a broken parser. */
function parseJsonBody(body: string): unknown {
  return JSON.parse(body);
}

/** Resolve the real content behind a catalog listing. Null when every resource states a constraint. */
async function resolvedUrl(
  read: ConditionalRead,
  acq: SourceAcquisition & { listingUrl: string },
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<{ url: string | null; reason: string }> {
  const listing = await read(acq.listingUrl, null, headers, timeoutMs);
  if (listing.status !== 'MODIFIED') return { url: null, reason: 'the listing returned no body' };
  const access = resolveAccess(parseJsonBody(listing.body), acq.listingUrl);
  if (!access.preferred) return { url: null, reason: access.handoff ?? 'the listing names no resource that carries the data' };
  // The resource this source's parser can read, in the ranking resolveAccess made: a bulk ZIP is never handed to a JSON parser.
  const readable = preferredReadable(access, acq.access.format);
  if (!readable) {
    return { url: null, reason: `the listing names no automatable resource readable as ${acq.access.format} (resources: ${access.resources.map((r) => `${r.format ?? '?'} ${r.kind}`).join(', ') || 'none'})` };
  }
  const query = acq.resourceQuery ? `${readable.url.includes('?') ? '&' : '?'}${acq.resourceQuery.replace(/^[?&]/, '')}` : '';
  return { url: `${readable.url}${query}`, reason: readable.note };
}

/**
 * Pull one due source through the pipeline. Returns its result; never throws
 * for a source fault (the fault is the result, and health classifies it).
 */
async function acquireSource(
  source: FeedSource & { acquisition: SourceAcquisition },
  ask: { url: string; incremental: boolean },
  now: Date,
  deps: Required<Pick<AcquisitionDeps, 'evaluate' | 'supervise' | 'validators' | 'record'>> & { read: ConditionalRead; ingestStore: IngestStore | null; sleep: (ms: number) => Promise<void> },
): Promise<FeedPullResult> {
  const acq = source.acquisition;
  const base: FeedPullResult = { source: source.id, inserted: 0, error: null, fetched: 0, duplicates: 0, incremental: ask.incremental };
  const at = now.toISOString();

  // 1. Corpus evaluation, before the source is asked: is this corpus (or domain class) the right one for the need?
  const evaluation = await deps.evaluate({ purpose: `${source.label} (${source.id})`, factKinds: acq.factKinds, maxAgeDays: acq.maxAgeDays, intendedUse: 'commercial', connected: [source.id] });
  const decision = evaluation.decisions.find((d) => d.corpusId === acq.corpus) ?? null;
  if (!decision || decision.outcome !== 'APPLIED') {
    const reason = decision ? decision.reason : `corpus ${acq.corpus} is not in the catalog`;
    await deps.record({ eventType: FEED_ACQUISITION_EVENT, provider: source.id, workloadClass: 'acquisition', outcome: 'SKIPPED_BY_EVALUATION', reason: reason.slice(0, 480), evidenceClass: 'MEASURED', measures: { corpus: acq.corpus, pipeline: ACQUISITION_PIPELINE_VERSION } });
    return { ...base, skipped: reason.slice(0, 300) };
  }

  // 2. Access: the real content, never a catalog listing; a stated constraint is honoured, never routed around.
  const headers = { ...ACCEPT_JSON, ...(source.headers ?? {}) };
  if (acq.access.authentication === 'REQUIRED') {
    const reason = `${source.id} requires authentication: an authorized account or key must be granted; it is not read around`;
    await deps.record({ eventType: FEED_ACQUISITION_EVENT, provider: source.id, workloadClass: 'acquisition', outcome: 'PERMISSION_NEED', reason, evidenceClass: 'MEASURED', measures: { corpus: acq.corpus } });
    return { ...base, skipped: reason };
  }

  let outcome = 'INGESTED';
  let result: FeedPullResult = base;
  let validators: Validators | null = null;
  let resolvedFrom: string | null = null;
  let url = ask.url;
  try {
    if (acq.listingUrl) {
      const resolved = await resolvedUrl(deps.read, acq as SourceAcquisition & { listingUrl: string }, headers, source.timeoutMs);
      if (!resolved.url) {
        await deps.record({ eventType: FEED_ACQUISITION_EVENT, provider: source.id, workloadClass: 'acquisition', outcome: 'PERMISSION_NEED', reason: resolved.reason.slice(0, 480), evidenceClass: 'MEASURED', measures: { corpus: acq.corpus, listingUrl: acq.listingUrl } });
        return { ...base, skipped: resolved.reason.slice(0, 300) };
      }
      resolvedFrom = acq.listingUrl;
      url = resolved.url;
    }

    // 3. Conditional, checkpointed ingest.
    if (source.shards) {
      const plan = source.shards(now);
      const sharded: ShardedSource = {
        id: source.id,
        snapshot: plan.snapshot,
        shards: plan.keys,
        spacingMs: source.spacingMs ?? 0,
        fetchShard: async (key) => {
          const got = await deps.read(plan.url(key), null, headers, source.timeoutMs);
          return got.status === 'MODIFIED' ? source.parse(parseJsonBody(got.body)) : [];
        },
      };
      const store: IngestStore = deps.ingestStore ?? {
        checkpoints: async () => [],
        saveCheckpoint: async () => undefined,
        store: (id, items) => insertFeedItems(id, items),
      };
      const run = await ingestShards(sharded, store, { sleep: deps.sleep, now: () => now });
      const fetched = run.completed.reduce((n, c) => n + c.read, 0);
      const inserted = run.completed.reduce((n, c) => n + c.stored, 0);
      if (run.interruptedAt) throw Object.assign(new Error(run.interruptedAt.error), { partial: { fetched, inserted, resumedPast: run.resumedPast } });
      result = { ...base, fetched, inserted, duplicates: Math.max(0, fetched - inserted), resumedPast: run.resumedPast };
      await recordFeedPull({ source: source.id, ok: true, fetched, inserted, error: null, at });
    } else {
      const prior = await deps.validators(source.id);
      const got = await deps.read(url, prior, headers, source.timeoutMs);
      validators = got.validators;
      if (got.status === 'NOT_MODIFIED') {
        outcome = 'NOT_MODIFIED';
        result = { ...base, notModified: true };
        await recordFeedPull({ source: source.id, ok: true, fetched: 0, inserted: 0, error: `${NOT_MODIFIED_MARK}: ${got.reason}`.slice(0, 300), at });
      } else {
        const items = source.parse(parseJsonBody(got.body));
        const inserted = await insertFeedItems(source.id, items);
        result = { ...base, fetched: items.length, inserted, duplicates: Math.max(0, items.length - inserted) };
        await recordFeedPull({ source: source.id, ok: true, fetched: items.length, inserted, error: null, at });
      }
    }
  } catch (error) {
    const message = (error instanceof Error ? `${error.name === 'SyntaxError' ? 'SyntaxError: ' : ''}${error.message}` : String(error)).slice(0, 300);
    const partial = (error as { partial?: { fetched: number; inserted: number; resumedPast: string[] } }).partial;
    outcome = 'FAILED';
    result = { ...base, error: message, fetched: partial?.fetched ?? 0, inserted: partial?.inserted ?? 0, ...(partial ? { resumedPast: partial.resumedPast } : {}) };
    await recordFeedPull({ source: source.id, ok: false, fetched: partial?.fetched ?? 0, inserted: partial?.inserted ?? 0, error: message, at });
  }

  // 4. Provenance of the pull itself: where, when, which version, format, licence and parser — beside the per-fact provenance extraction attaches.
  await deps.record({
    eventType: FEED_ACQUISITION_EVENT,
    provider: source.id,
    workloadClass: 'acquisition',
    outcome,
    reason: `${source.id}: ${outcome === 'FAILED' ? result.error : `${result.fetched} read, ${result.inserted} stored${result.notModified ? ' (not modified)' : ''}`}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: {
      corpus: acq.corpus,
      corpusScore: decision.score,
      location: url,
      resolvedFrom,
      retrievedAt: at,
      validators,
      format: acq.access.format,
      updateMechanism: acq.access.updateMechanism,
      usage: acq.access.usage,
      publisher: acq.provenance.publisher,
      license: acq.provenance.license,
      parserVersion: acq.provenance.parserVersion,
      pipeline: ACQUISITION_PIPELINE_VERSION,
      fetched: result.fetched,
      inserted: result.inserted,
      resumedPast: result.resumedPast ?? [],
    },
  });

  // 5. Connector health: outage, broken parser, schema change and revoked permission are told apart and routed.
  try {
    result.health = (await deps.supervise(source.id, source.intervalMs)).outcome;
  } catch (error) {
    console.warn(`[feeds] connector health for ${source.id} could not be judged: ${String((error as Error)?.message ?? error)}`);
    result.health = null;
  }
  return result;
}

/** Pull history for health, without the pulls that only learned nothing changed. */
async function historyWithoutNotModified(source: string) {
  const { readPullHistory } = await import('./health.ts');
  return (await readPullHistory(source)).filter((p) => !(p.ok && (p.error ?? '').startsWith(NOT_MODIFIED_MARK)));
}

/** The production dependencies of the pipeline. */
function productionDeps(): Required<Omit<AcquisitionDeps, 'transport' | 'ingestStore'>> & { transport: Transport; ingestStore: IngestStore | null } {
  return {
    transport: httpTransport,
    evaluate: (need) => recordCorporaEvaluation(need, { caller: 'feeds' }),
    ingestStore: null,
    supervise: async (source, intervalMs) => (await import('./health.ts')).superviseConnector(source, intervalMs, { history: historyWithoutNotModified }),
    validators: readValidators,
    record: recordBinEvent,
    yields: async () => (await latestSourceYields()).values,
    recordYields: (now) => recordSourceYields(now),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Pull every due source once. A source that takes a start date is asked only
 * for what was published since its own last success (`pullUrl`); every item is
 * stored once, by its source key, so a repeat costs no storage and no screen.
 *
 * Without a test `fetcher`, every source that declares its acquisition goes
 * through the pipeline above, in yield order: corpus evaluation, access
 * resolution, a conditional and checkpointed ingest, a provenance row, health
 * classification; and the window's per-source yield is recorded. A `fetcher`
 * alone keeps the plain path (one JSON request per source).
 */
export async function pullDueFeeds(input: {
  now?: Date;
  fetcher?: Fetcher;
  sources?: readonly FeedSource[];
  /** Run the acquisition pipeline with these dependencies (the production ones by default when no `fetcher` is given). */
  acquisition?: AcquisitionDeps;
  /** The project a sharded read checkpoints on; resolved from the shortlist project when absent. */
  projectId?: string | null;
} = {}): Promise<FeedPullResult[]> {
  const now = input.now ?? new Date();
  const out: FeedPullResult[] = [];
  const pipelined = input.acquisition !== undefined || !input.fetcher;
  const prod = pipelined ? productionDeps() : null;
  const deps = prod ? { ...prod, ...(input.acquisition ?? {}) } : null;
  let sources = input.sources ?? FEED_SOURCES;
  if (deps) {
    try {
      sources = orderByYield(sources, await deps.yields());
    } catch (error) {
      console.warn(`[feeds] source yields unreadable; catalog order kept: ${String((error as Error)?.message ?? error)}`);
    }
  }
  let ingestStore: IngestStore | null | undefined = deps?.ingestStore ?? undefined;
  for (const source of sources) {
    const state = await pullState(source.id);
    if (now.getTime() < nextPullAt(source, state)) continue;
    const spacing = source.spacingMs && out.length > 0;
    if (spacing && deps) await deps.sleep(source.spacingMs!);
    else if (spacing && !input.fetcher) await new Promise((resolve) => setTimeout(resolve, source.spacingMs));
    const ask = pullUrl(source, state.lastSuccessAt);
    if (deps && source.acquisition) {
      if (source.shards && ingestStore == null) {
        const projectId = input.projectId ?? (await shortlistProject((await getDb().all<{ id: string }>('SELECT id FROM projects ORDER BY created_at')).map((p) => p.id)));
        ingestStore = projectId ? feedIngestStore(projectId) : null;
      }
      const fetcherRead: ConditionalRead | null =
        input.fetcher && !input.acquisition?.transport
          ? async (url, _prior, headers, timeoutMs) => {
              const body = JSON.stringify(await input.fetcher!(url, headers, timeoutMs));
              return { status: 'MODIFIED', httpStatus: 200, body, validators: { contentHash: contentHashOf(body) }, contentHash: contentHashOf(body) };
            }
          : null;
      out.push(
        await acquireSource(source as FeedSource & { acquisition: SourceAcquisition }, ask, now, {
          evaluate: deps.evaluate,
          supervise: deps.supervise,
          validators: deps.validators,
          record: deps.record,
          sleep: deps.sleep,
          ingestStore: ingestStore ?? null,
          read: fetcherRead ?? conditionalFetcher(deps.transport),
        }),
      );
      continue;
    }
    try {
      const body = await (input.fetcher ?? httpFetcher)(ask.url, source.headers ?? {}, source.timeoutMs);
      const items = source.parse(body);
      const inserted = await insertFeedItems(source.id, items);
      await recordFeedPull({ source: source.id, ok: true, fetched: items.length, inserted, error: null, at: now.toISOString() });
      out.push({ source: source.id, inserted, error: null, fetched: items.length, duplicates: Math.max(0, items.length - inserted), incremental: ask.incremental });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await recordFeedPull({ source: source.id, ok: false, fetched: 0, inserted: 0, error: message, at: now.toISOString() });
      out.push({ source: source.id, inserted: 0, error: message, fetched: 0, duplicates: 0, incremental: ask.incremental });
    }
  }
  // 6. Yield, once per window: the share of what each source acquired that became accepted information and usable leads.
  if (deps && out.length > 0) {
    try {
      await deps.recordYields(now);
    } catch (error) {
      console.warn(`[feeds] source yield could not be recorded: ${String((error as Error)?.message ?? error)}`);
    }
  }
  return out;
}

/**
 * What the code-first lane saved and made over a window, read from rows (§45):
 * nothing is stored to compute it, so it cannot drift from what happened.
 *
 *   * notScreened — items that never cost a model call: repeats storage
 *     dropped, items a code rule covers (`coveredItems`), items code itself
 *     proved (a broken site, a code detection's own lead), and items whose
 *     subject the screen already answered for another record (`coalesced`:
 *     the same record kind, entity and deliverable — a repost or the same
 *     posting on a second feed — reads the one answer, never a second call);
 *   * screenCalls — the SCREEN_LEAD model calls actually made, a batched
 *     call counted once however many records it answered (`batchCalls`),
 *     and the distinct items they were about;
 *   * workCreated — what code produced that no single record showed: code
 *     detections and code-proved site leads, and the cross-source joins
 *     themselves (ALGO-19-3): fact keys the deterministic extractor read from
 *     items of two or more different sources in the window (one entity's price,
 *     quantity, date or place seen on separate feeds), event-graph hypotheses
 *     whose raw evidence spans two or more sources and was observed in the
 *     window, and the distinct transaction designs the graph constructor builds
 *     from those hypotheses before any goal's constraints. A graph figure is
 *     null — never zero — when the graph could not be read.
 *
 * Every lead counted here is still only a lead: it reaches Claude on the same
 * evidence gate as any other, and nothing in this reading is a buyer.
 */
export interface ScreeningEconomy {
  since: string;
  until: string;
  fetched: number;
  stored: number;
  notScreened: { duplicates: number; covered: number; provedByCode: number; coalesced: number; total: number };
  screenCalls: number;
  /** Of `screenCalls`, the ones that asked about a whole needsModel batch in one call. */
  batchCalls: number;
  itemsScreened: number;
  workCreated: {
    codeDetections: number;
    siteLeads: number;
    /** Extracted fact keys observed on two or more distinct sources in the window. */
    crossSourceFacts: number;
    /** Event-graph hypotheses whose evidence spans two or more sources, observed in the window; null when the graph could not be read. */
    graphHypotheses: number | null;
    /** Graph constructions kept from those hypotheses, before any goal's constraints; null when the graph could not be read. */
    graphConstructions: number | null;
    total: number;
  };
}

/** Feed items read per page when the window's cross-source joins are counted. */
const CROSS_SOURCE_PAGE = 500;

/**
 * Fact keys the deterministic extractor reads from items of at least two
 * different sources in [since, until). A key carries its entity and
 * deliverable (`extract.ts`), and a record without an entity keys by its own
 * id, so a key two sources share is the same entity's fact seen separately —
 * a join no single record showed. Code-made items are left out: they are
 * counted as code detections and site leads already. Paged, never one read.
 */
async function crossSourceFacts(since: string, until: string): Promise<number> {
  const sources = new Map<string, Set<string>>();
  let after: { fetchedAt: string; id: string } | null = null;
  for (;;) {
    const rows: { id: string; source: string; url: string; title: string; body: string | null; organization: string | null; published_at: string | null; fetched_at: string }[] =
      await getDb().all(
        after
          ? `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
              WHERE fetched_at < ? AND source <> ? AND source <> ? AND (fetched_at > ? OR (fetched_at = ? AND id > ?))
              ORDER BY fetched_at, id LIMIT ${CROSS_SOURCE_PAGE}`
          : `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
              WHERE fetched_at < ? AND source <> ? AND source <> ? AND fetched_at >= ?
              ORDER BY fetched_at, id LIMIT ${CROSS_SOURCE_PAGE}`,
        after
          ? [until, CODE_SIGNAL_SOURCE, SITE_SOURCE, after.fetchedAt, after.fetchedAt, after.id]
          : [until, CODE_SIGNAL_SOURCE, SITE_SOURCE, since],
      );
    for (const row of rows) {
      const facts = extractItem({
        id: row.id,
        source: row.source,
        url: row.url,
        title: row.title,
        body: row.body,
        organization: row.organization,
        publishedAt: row.published_at,
        fetchedAt: row.fetched_at,
      });
      for (const fact of facts) {
        const seen = sources.get(fact.key) ?? new Set<string>();
        seen.add(row.source);
        sources.set(fact.key, seen);
      }
    }
    if (rows.length < CROSS_SOURCE_PAGE) break;
    const last = rows[rows.length - 1]!;
    after = { fetchedAt: last.fetched_at, id: last.id };
  }
  let joined = 0;
  for (const seen of sources.values()) if (seen.size >= 2) joined += 1;
  return joined;
}

/** A graph hypothesis is cross-source work in a window when its evidence spans two sources and some of it was observed there. */
export function crossSourceHypothesis(h: GraphHypothesis, since: string, until: string): boolean {
  if (new Set(h.evidence.map((e) => e.source)).size < 2) return false;
  return h.evidence.some((e) => e.observedAt >= since && e.observedAt < until);
}

/** The event graph's cross-source hypotheses and constructions in a window, or nulls when it cannot be read. */
async function crossSourceGraph(since: string, until: string): Promise<{ hypotheses: number | null; constructions: number | null }> {
  try {
    await syncEventGraph(new Date(until));
  } catch {
    return { hypotheses: null, constructions: null };
  }
  const joined = currentEventGraph()
    .hypotheses()
    .filter((h) => crossSourceHypothesis(h, since, until));
  // No goal's ceiling, deliverables or exclusions: the designs the joins make possible, not one goal's shortlist.
  const built = constructFromGraph(joined, { capitalCeilingCents: null, delivers: [] });
  return { hypotheses: joined.length, constructions: built.kept.length };
}

export async function screeningEconomy(input: { since: string; until?: string }): Promise<ScreeningEconomy> {
  const until = input.until ?? new Date().toISOString();
  const db = getDb();
  const pulls = await db.get<{ fetched: number | string | null; inserted: number | string | null }>(
    `SELECT SUM(fetched) AS fetched, SUM(inserted) AS inserted FROM feed_pulls WHERE ok = 1 AND created_at >= ? AND created_at < ?`,
    [input.since, until],
  );
  const items = await db.all<{ id: string; source: string }>(
    `SELECT id, source FROM feed_items WHERE fetched_at >= ? AND fetched_at < ?`,
    [input.since, until],
  );
  // A per-record screen is one row per model call. A batched screen (`screenLeadBatch`) is one
  // SCREEN_LEAD_BATCH row per call, and the per-record answers it gave are rows marked as its own
  // (`BATCH_ROW_PREFIX`), so they are items screened but not calls made.
  const calls = await db.get<{ n: number | string; items: number | string }>(
    `SELECT SUM(CASE WHEN id LIKE ? THEN 0 ELSE 1 END) AS n, COUNT(DISTINCT subject_id) AS items FROM cheap_results
      WHERE kind = 'SCREEN_LEAD' AND created_at >= ? AND created_at < ?`,
    [`${BATCH_ROW_PREFIX}%`, input.since, until],
  );
  const batchCalls = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM cheap_results WHERE kind = ? AND created_at >= ? AND created_at < ?`,
    [SCREEN_LEAD_BATCH_KIND, input.since, until],
  );
  const fetched = Number(pulls?.fetched ?? 0);
  const duplicates = Math.max(0, fetched - Number(pulls?.inserted ?? 0));
  const codeDetections = items.filter((one) => one.source === CODE_SIGNAL_SOURCE).length;
  const siteLeads = items.filter((one) => one.source === SITE_SOURCE).length;
  const screenable = items.filter((one) => one.source !== CODE_SIGNAL_SOURCE && one.source !== SITE_SOURCE);
  let covered = 0;
  for (let at = 0; at < screenable.length; at += 500) covered += (await coveredItems(screenable.slice(at, at + 500).map((one) => one.id))).size;
  const coalesced = await coalescedItems(input.since, until);
  const joinedFacts = await crossSourceFacts(input.since, until);
  const graph = await crossSourceGraph(input.since, until);
  return {
    since: input.since,
    until,
    fetched,
    stored: items.length,
    notScreened: {
      duplicates,
      covered,
      provedByCode: codeDetections + siteLeads,
      coalesced,
      total: duplicates + covered + codeDetections + siteLeads + coalesced,
    },
    screenCalls: Number(calls?.n ?? 0) + Number(batchCalls?.n ?? 0),
    batchCalls: Number(batchCalls?.n ?? 0),
    itemsScreened: Number(calls?.items ?? 0),
    workCreated: {
      codeDetections,
      siteLeads,
      crossSourceFacts: joinedFacts,
      graphHypotheses: graph.hypotheses,
      graphConstructions: graph.constructions,
      total: codeDetections + siteLeads + joinedFacts + (graph.hypotheses ?? 0) + (graph.constructions ?? 0),
    },
  };
}

/** The cash event that carries one screening-economy reading for a project. */
export const SCREENING_ECONOMY_EVENT = 'FEED_SCREENING_ECONOMY';

/** How often the reading is taken: one window per day, back to back. */
export const SCREENING_ECONOMY_INTERVAL_MS = 24 * 3_600_000;

/**
 * Take the screening-economy reading for the window since the last one and
 * record it on the project's cash ledger (`cash_events`), so what the
 * code-first lane saved and made is a row anyone can read rather than a
 * function nobody calls. Windows are back to back: each starts where the last
 * one ended, so no call or item is counted twice. A window shorter than the
 * interval writes nothing. Returns the reading written, or null.
 */
export async function recordScreeningEconomy(input: { projectId: string; now?: Date }): Promise<ScreeningEconomy | null> {
  const now = input.now ?? new Date();
  const last = await getDb().get<{ detail: string | null }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [input.projectId, SCREENING_ECONOMY_EVENT],
  );
  let since: string | null = null;
  try {
    const until = (JSON.parse(last?.detail ?? '{}') as { until?: unknown }).until;
    if (typeof until === 'string' && Number.isFinite(Date.parse(until))) since = until;
  } catch {
    since = null;
  }
  if (since === null) since = new Date(now.getTime() - SCREENING_ECONOMY_INTERVAL_MS).toISOString();
  if (now.getTime() - Date.parse(since) < SCREENING_ECONOMY_INTERVAL_MS) return null;
  const reading = await screeningEconomy({ since, until: now.toISOString() });
  await recordCashEvent({
    projectId: input.projectId,
    kind: SCREENING_ECONOMY_EVENT,
    actorRef: 'BRAIN',
    summary:
      `Code-first lane, ${reading.since} to ${reading.until}: ${reading.notScreened.total} item(s) never sent to a model ` +
      `(${reading.notScreened.duplicates} repeat(s), ${reading.notScreened.covered} covered by a code rule, ${reading.notScreened.provedByCode} proved by code); ` +
      `${reading.screenCalls} model screen call(s) on ${reading.itemsScreened} item(s); ${reading.workCreated.total} piece(s) of work code made that no single record showed ` +
      `(${reading.workCreated.codeDetections} code detection(s), ${reading.workCreated.siteLeads} site lead(s), ${reading.workCreated.crossSourceFacts} fact(s) joined across sources, ` +
      `${reading.workCreated.graphHypotheses ?? 'unread'} cross-source graph hypothes(es), ${reading.workCreated.graphConstructions ?? 'unread'} graph construction(s)). ` +
      'Every lead, join and construction is still only a hypothesis.',
    detail: { ...reading },
  });
  return reading;
}

/** The cash event that carries one deterministic-extraction pass for a project (ALGO-16-1 item 2). */
export const EXTRACTION_EVENT = 'FEED_EXTRACTION';
/** Stored items read per pass, so one row stays a readable size; the cursor carries the rest to the next tick. */
export const EXTRACTION_ITEMS_PER_PASS = 100;

export interface ExtractionPass {
  /** Where this pass began and ended in `feed_items` (fetched_at, id): the next pass starts after `to`. */
  cursor: { from: { fetchedAt: string; id: string } | null; to: { fetchedAt: string; id: string } };
  items: number;
  /** Items the parser read: they are not escalated for extraction help. */
  readable: number;
  /** Every normalized fact, each with its item id, field, exact text and URL. */
  facts: ExtractedFact[];
  /** Per fact key: OBSERVED, CONTESTED or STALE — never established — and which items said it. */
  reconciled: { key: string; status: string; value: string | number | null; itemIds: string[] }[];
  /** Item ids the parser could not read, in the batches the free-model screen asks about whole, one call per batch (`screenLeadBatch`). */
  needsModel: string[][];
  /** Facts by what their record is: a job posting, advert or listing is never demand. */
  demand: { statedRequest: number; notDemand: number };
  /**
   * What the pass handed the event graph (`addExtractedItems`): the records it read, as graph
   * facts, and the neighborhoods recomputed for them — Structure feeding Connect and Derive on
   * the same tick. Null when the graph could not take them; the pass is still recorded.
   */
  graph: ExtractedItemsUpdate | null;
}

/**
 * Run deterministic extraction over the stored items that arrived since the
 * last pass and record the facts on the project's cash ledger, so every
 * normalized fact is a row that links to the exact `feed_items` row and text
 * it was read from. Incremental: the pass starts after the last one's cursor
 * (or at the lead window on the first pass), so no item is read twice. Code
 * detections are derived leads, not raw records, and are not re-read. Pure
 * code: it runs when every model provider is down. Returns the pass written, or
 * null when nothing new arrived.
 */
export async function recordFeedExtraction(input: { projectId: string; now?: Date; limit?: number }): Promise<ExtractionPass | null> {
  const now = input.now ?? new Date();
  const db = getDb();
  const last = await db.get<{ detail: string | null }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [input.projectId, EXTRACTION_EVENT],
  );
  let from: { fetchedAt: string; id: string } | null = null;
  try {
    const to = (JSON.parse(last?.detail ?? '{}') as { cursor?: { to?: { fetchedAt?: unknown; id?: unknown } } }).cursor?.to;
    if (to && typeof to.fetchedAt === 'string' && typeof to.id === 'string') from = { fetchedAt: to.fetchedAt, id: to.id };
  } catch {
    from = null;
  }
  const floor = new Date(now.getTime() - LEAD_MAX_AGE_MS).toISOString();
  const rows = await db.all<{
    id: string;
    source: string;
    url: string;
    title: string;
    body: string | null;
    organization: string | null;
    published_at: string | null;
    fetched_at: string;
  }>(
    from
      ? `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
          WHERE source <> ? AND (fetched_at > ? OR (fetched_at = ? AND id > ?))
          ORDER BY fetched_at, id LIMIT ?`
      : `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
          WHERE source <> ? AND fetched_at >= ?
          ORDER BY fetched_at, id LIMIT ?`,
    from
      ? [CODE_SIGNAL_SOURCE, from.fetchedAt, from.fetchedAt, from.id, input.limit ?? EXTRACTION_ITEMS_PER_PASS]
      : [CODE_SIGNAL_SOURCE, floor, input.limit ?? EXTRACTION_ITEMS_PER_PASS],
  );
  if (rows.length === 0) return null;
  const items: ExtractableItem[] = rows.map((row) => ({
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    body: row.body,
    organization: row.organization,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
  }));
  const run = extractItems(items, now);
  // Structure feeds Connect: what was just read goes into the event graph that construction reads,
  // under the ids the graph's own sync gives these rows, so neither path makes a second fact.
  let graph: ExtractedItemsUpdate | null = null;
  try {
    graph = addExtractedItems(items);
  } catch (error) {
    console.warn(`[feeds] extraction pass could not reach the event graph: ${String((error as Error)?.message ?? error)}`);
  }
  const lastRow = rows[rows.length - 1]!;
  const needsModel = run.needsModel.map((batch) => batch.map((one) => one.id));
  const pass: ExtractionPass = {
    cursor: { from, to: { fetchedAt: lastRow.fetched_at, id: lastRow.id } },
    items: items.length,
    readable: items.length - needsModel.flat().length,
    facts: run.facts,
    reconciled: run.reconciled.map((r) => ({
      key: r.key,
      status: r.status,
      value: r.value,
      itemIds: [...new Set(r.observations.map((o) => o.evidence.itemId))],
    })),
    needsModel,
    demand: {
      statedRequest: run.facts.filter((f) => f.demand === 'STATED_REQUEST').length,
      notDemand: run.facts.filter((f) => f.demand === 'NOT_DEMAND').length,
    },
    graph,
  };
  const contested = pass.reconciled.filter((r) => r.status === 'CONTESTED').length;
  const stale = pass.reconciled.filter((r) => r.status === 'STALE').length;
  await recordCashEvent({
    projectId: input.projectId,
    kind: EXTRACTION_EVENT,
    actorRef: 'BRAIN',
    summary:
      `Deterministic extraction over ${pass.items} stored item(s): ${pass.facts.length} normalized fact(s), each linked to its item and text; ` +
      `${pass.reconciled.length} fact key(s), ${contested} contested and ${stale} stale; ${pass.readable} item(s) read by code, ` +
      `${needsModel.flat().length} the parser could not read, in ${needsModel.length} batch(es) of up to ${MODEL_BATCH_SIZE}: ` +
      'the free-model screen takes those first, one call per batch and model for every batch of two or more, ' +
      'and asks record by record only about what a batch answer left unanswered. ' +
      `${pass.demand.statedRequest} fact(s) from a record stating a request; none is a confirmed buyer. ` +
      (graph
        ? `${graph.facts} graph fact(s) handed to the event graph, ${graph.added} new, ${graph.affected.length} neighborhood(s) recomputed; every hypothesis is still only a hypothesis.`
        : 'The event graph could not take them this pass; its own sync reads the same rows.'),
    detail: { ...pass },
  });
  return pass;
}

// ---------------------------------------------------------------------------
// The feed loop's Act and Codify (ALGO-19-4): what Derive ranked reaches
// research, and what code keeps failing to read becomes a rule proposal.
// ---------------------------------------------------------------------------

/** The event one feed-loop cycle is recorded under (`russell/loop.ts` writes it, the shortlist reads it). */
export const FEED_LOOP_CYCLE_EVENT = 'FEED_LOOP_CYCLE';
/** The event that records which derived missing-link questions a shortlist round took, and into which round. */
export const LOOP_QUESTIONS_ASKED_EVENT = 'FEED_LOOP_QUESTIONS_ASKED';
/** Missing-link questions one shortlist round carries beside its leads. */
export const LOOP_QUESTIONS_PER_ROUND = 5;
/** A question asked this recently is not asked again; after it, an unanswered gap may be asked once more. */
export const LOOP_QUESTION_REASK_MS = 7 * 24 * 3_600_000;

/**
 * The missing-link questions the feed loop's latest cycle derived that no
 * round has taken recently, in the cycle's own ranking. Read from the
 * `FEED_LOOP_CYCLE` row the loop wrote and the `FEED_LOOP_QUESTIONS_ASKED`
 * rows the shortlist wrote, so the ranking is a row's and never recomputed
 * here. Writes nothing.
 */
export async function pendingLoopQuestions(projectId: string, now: Date = new Date(), limit: number = LOOP_QUESTIONS_PER_ROUND): Promise<MissingLinkQuestion[]> {
  const db = getDb();
  const latest = await db.get<{ detail: string | null }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId, FEED_LOOP_CYCLE_EVENT],
  );
  let questions: MissingLinkQuestion[] = [];
  try {
    const derived = (JSON.parse(latest?.detail ?? '{}') as { derive?: { questions?: unknown } | null }).derive?.questions;
    if (Array.isArray(derived)) {
      questions = derived.filter(
        (q): q is MissingLinkQuestion => !!q && typeof (q as MissingLinkQuestion).key === 'string' && typeof (q as MissingLinkQuestion).question === 'string',
      );
    }
  } catch {
    questions = [];
  }
  if (questions.length === 0) return [];
  const since = new Date(now.getTime() - LOOP_QUESTION_REASK_MS).toISOString();
  const asked = await db.all<{ detail: string | null }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? AND created_at >= ?`,
    [projectId, LOOP_QUESTIONS_ASKED_EVENT, since],
  );
  const taken = new Set<string>();
  for (const row of asked) {
    try {
      const keys = (JSON.parse(row.detail ?? '{}') as { keys?: unknown }).keys;
      if (Array.isArray(keys)) for (const key of keys) if (typeof key === 'string') taken.add(key);
    } catch {
      // An unreadable row takes nothing.
    }
  }
  return questions.filter((q) => !taken.has(q.key)).slice(0, Math.max(0, limit));
}

/** The corpora the connected feed sources are instances of: what Brain can already read. */
export function connectedCorpora(sources: readonly FeedSource[] = FEED_SOURCES): Set<string> {
  return new Set(sources.flatMap((source) => (source.acquisition ? [source.acquisition.corpus] : [])));
}

/**
 * The weakness an unconnected corpus that answers a real unknown is. Pure.
 *
 * It asks Factory, through the improvement loop that owns turning a weakness
 * into an objective (§87), for the connector: a feed source in
 * `sources.ts` with its acquisition metadata, read through the existing
 * pipeline and judged by the same corpus evaluation, with a test. A domain
 * class asks for the specific source of that class to be discovered first.
 * Nothing here opens the corpus or trusts it.
 */
export function corpusConnectorWeakness(decision: CorpusDecision, need: CorpusNeed, questionKey: string): Weakness {
  const what = decision.kind === 'DOMAIN_CLASS'
    ? `Discover the specific ${decision.label.toLowerCase()} source that answers it, judge its terms and freshness, and connect it`
    : `Connect ${decision.label}`;
  return {
    key: corpusProposalKey(decision.corpusId),
    kind: 'CORPUS_UNCONNECTED',
    title: `${decision.label} answers a research unknown no connected source answers as well`,
    problem:
      `The feed loop's research unknown ${questionKey} ("${need.purpose}") consumes ${need.factKinds.join(', ')}. ` +
      `Corpus evaluation ranked ${decision.label} first (score ${decision.score}): ${decision.reason}. ` +
      `No connected feed source answers it as well. ${what} as a feed source in server/services/feeds/sources.ts with its ` +
      `acquisition metadata (corpus ${decision.corpusId}), read through the existing acquisition pipeline in run.ts, with a test. ` +
      `Keep its caveats: ${decision.caveats.join('; ') || 'none stated'}` +
      (decision.needsCorroboration.length ? `; it is not evidence of ${decision.needsCorroboration.join(', ')} alone.` : '.'),
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'server/services/feeds/sources.ts',
    mutationScope: ['server/services/feeds/**', 'tests/**'],
    frequency: 1,
    denominator: 1,
    scope: 'LOCAL',
    severity: 'MEDIUM',
    researchQuestion: `How is ${decision.label} accessed for ${need.factKinds.join(', ')}, under what terms and pacing?`,
    samples: [need.purpose.slice(0, 200)],
    knownCause: `no feed source is an instance of corpus ${decision.corpusId}`,
  };
}

export interface CorpusDiscovery {
  questionKey: string;
  factKinds: readonly string[];
  applied: string[];
  /** The corpus proposed for connection, when one pays; null otherwise. */
  proposed: string | null;
}

/**
 * Discover the best corpus for each research unknown the feed loop is about to
 * ask (ACQ-21-3), before any crawler or round. Each unknown becomes a need in
 * its own words, every corpus and domain class is evaluated against it and the
 * decision recorded (`CORPUS_EVALUATION`), and the unconnected corpus that
 * answers it best — when it pays — is registered with the improvement loop,
 * which turns it into a Factory objective. Idempotent per corpus (the loop
 * keys a weakness), and each step is caught: discovery never stops a round.
 */
export async function discoverCorporaForUnknowns(input: {
  projectId: string;
  unknowns: readonly { key: string; question: string; condition: string }[];
  now?: Date;
  sources?: readonly FeedSource[];
  evaluate?: (need: CorpusNeed) => Promise<CorporaEvaluation>;
  register?: (weakness: Weakness, at: Date, options: { evidence: Record<string, unknown> }) => Promise<unknown>;
}): Promise<CorpusDiscovery[]> {
  const now = input.now ?? new Date();
  const connected = connectedCorpora(input.sources);
  const evaluate = input.evaluate ?? ((need: CorpusNeed) => recordCorporaEvaluation(need, { caller: 'feeds-discovery', projectId: input.projectId }));
  const register =
    input.register ??
    (async (w: Weakness, at: Date, options: { evidence: Record<string, unknown> }) => (await import('../improvement/loop.ts')).registerDirected(w, at, options));
  const out: CorpusDiscovery[] = [];
  for (const unknown of input.unknowns) {
    const need = needFromUnknown(unknown, [...connected].sort());
    const evaluation = await evaluate(need);
    const add = corpusToAdd(evaluation, connected);
    if (add) {
      await register(corpusConnectorWeakness(add, need, unknown.key), now, {
        evidence: { corpusDiscovery: { questionKey: unknown.key, corpus: add.corpusId, score: add.score, factKinds: need.factKinds } },
      });
    }
    out.push({ questionKey: unknown.key, factKinds: need.factKinds, applied: evaluation.applied, proposed: add?.corpusId ?? null });
  }
  return out;
}

/** Items one source must leave unreadable in a single pass before a parser for it is proposed. */
export const PARSER_PROPOSAL_MIN = 5;

/** The weakness key a source's unreadable records are registered under. */
export function unreadableSourceKey(source: string): string {
  return `EXTRACTION_UNREADABLE:${source}`;
}

/**
 * The weakness a source's unreadable records are, or null when too few. Pure.
 *
 * This is the loop compiling its own reasoning into a rule (ALGO-19-3 item 2):
 * every record code could not read goes to a model one by one, so a source
 * that keeps producing them is a format a model should read once and a
 * versioned parser should read afterwards. The objective asks Factory for that
 * parser; it lands as code with a test from the samples, and nothing here
 * installs or trusts it. No source or industry is a whitelist: which formats
 * get a parser is decided by what code failed to read.
 */
export function unreadableSourceWeakness(source: string, unreadable: number, items: number, samples: readonly string[]): Weakness | null {
  if (unreadable < PARSER_PROPOSAL_MIN) return null;
  return {
    key: unreadableSourceKey(source),
    kind: 'EXTRACTION_UNREADABLE',
    title: `Deterministic extraction cannot read records from feed source ${source}`,
    problem:
      `The feed loop's extraction pass left ${unreadable} of ${items} stored record(s) from source ${source} unreadable by code, ` +
      'so each one waits for a model to read it. Read the samples below once, and propose the parser or normaliser that reads this format, ' +
      'in server/services/feeds/extract.ts, with a test built from these records. Every fact it extracts must keep its link to the exact ' +
      'raw text, a posting or advert must stay NOT_DEMAND, and nothing it reads may be stated as established.',
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'server/services/feeds/extract.ts',
    mutationScope: ['server/services/feeds/**', 'tests/**'],
    frequency: unreadable,
    denominator: Math.max(items, 1),
    scope: 'LOCAL',
    severity: unreadable * 2 > items ? 'HIGH' : 'MEDIUM',
    researchQuestion: `What structure do records from feed source ${source} follow, and what deterministic parser reads them?`,
    samples: samples.slice(0, 5),
    knownCause: null,
  };
}

/**
 * Codify what one extraction pass could not read: per source, register the
 * unreadable records with the improvement loop (§87), which owns turning a
 * weakness into a Factory objective. Idempotent per source. Returns the keys
 * registered.
 */
export async function proposeParsersForUnreadable(pass: Pick<ExtractionPass, 'items' | 'needsModel'>, now: Date = new Date()): Promise<string[]> {
  const ids = pass.needsModel.flat();
  if (ids.length < PARSER_PROPOSAL_MIN) return [];
  const bySource = new Map<string, string[]>();
  for (let at = 0; at < ids.length; at += SUBJECT_PAGE) {
    const chunk = ids.slice(at, at + SUBJECT_PAGE);
    const rows = await getDb().all<{ id: string; source: string; url: string; title: string }>(
      `SELECT id, source, url, title FROM feed_items WHERE id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`,
      chunk,
    );
    for (const row of rows) {
      const list = bySource.get(row.source) ?? [];
      list.push(`${row.title.slice(0, 120)} (${row.url})`);
      bySource.set(row.source, list);
    }
  }
  const registered: string[] = [];
  const { registerDirected } = await import('../improvement/loop.ts');
  for (const [source, samples] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const weakness = unreadableSourceWeakness(source, samples.length, pass.items, samples);
    if (!weakness) continue;
    const { candidate } = await registerDirected(weakness, now, {
      evidence: { feedLoopCodify: { source, unreadable: samples.length, items: pass.items } },
    });
    registered.push(candidate.weaknessKey);
  }
  return registered;
}

/** The latest SCREEN_LEAD answers, per item, already combined. */
async function screenedLeads(ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let at = 0; at < ids.length; at += SUBJECT_PAGE) {
    const chunk = ids.slice(at, at + SUBJECT_PAGE);
    const rows = await getDb().all<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM cheap_results
        WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const row of rows) out.add(row.subject_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One screen per subject (ALGO-16-2): code decides which records are the same
// question, so the free models are asked it once.
// ---------------------------------------------------------------------------

/** Ids per statement when screen rows are read for a window. */
const SUBJECT_PAGE = 500;
/** Stored records read when a window's subjects are grouped. */
export const SUBJECT_WINDOW_LIMIT = 5_000;

/**
 * The question a record's lead screen answers, as a key: its record kind, the
 * entity it is from and the deliverable it is about, all read by the
 * deterministic extractor. Two records with one key — a repost, the same
 * posting on a second feed, the same employer's opening under a seniority
 * variant — ask the free models the same thing, so one answer serves both.
 * Null when the extractor cannot name both the entity and the deliverable: a
 * record that cannot be told apart is never merged into another. Pure.
 */
export function screenSubject(item: ExtractableItem): string | null {
  const facts = extractItem(item);
  const entity = facts.find((f) => f.entityKey)?.entityKey ?? null;
  const deliverable = facts.find((f) => f.field === 'deliverable');
  if (!entity || !deliverable) return null;
  return `${deliverable.recordKind}|${entity}|${String(deliverable.value)}`;
}

/**
 * Which candidates the free models are asked about, and which read an answer
 * already given for their subject. In `screenOrder` (the extractor's
 * unreadable batches first); the first candidate of each subject not already
 * settled is asked, every later one is coalesced onto it. A record with no
 * subject is always asked on its own. Drops nothing: a coalesced record keeps
 * every gate, reading its subject's answer through `leadScreens`. Pure.
 */
export function planScreens<T extends ExtractableItem>(
  candidates: readonly T[],
  settled: ReadonlySet<string>,
  now: Date,
  subjectOf: (item: T) => string | null = screenSubject,
): { ask: T[]; coalesced: T[] } {
  const ask: T[] = [];
  const coalesced: T[] = [];
  const asked = new Set<string>();
  for (const item of screenOrder(candidates, now)) {
    const subject = subjectOf(item);
    if (subject && (settled.has(subject) || asked.has(subject))) {
      coalesced.push(item);
      continue;
    }
    if (subject) asked.add(subject);
    ask.push(item);
  }
  return { ask, coalesced };
}

interface SubjectWindow {
  /** Subject of each stored record in the window that has one. */
  subjectOf: Map<string, string>;
  /** Records per subject, newest first. */
  members: Map<string, string[]>;
  /** Subjects a shortlist round has already taken a record of. */
  listed: Set<string>;
}

/** The stored records fetched in [since, until), grouped by subject. Code-made leads are not records and are left out. */
async function subjectWindow(since: string, until?: string): Promise<SubjectWindow> {
  const rows = await getDb().all<{
    id: string;
    source: string;
    url: string;
    title: string;
    body: string | null;
    organization: string | null;
    published_at: string | null;
    fetched_at: string;
    shortlisted_round_id: string | null;
  }>(
    `SELECT id, source, url, title, body, organization, published_at, fetched_at, shortlisted_round_id FROM feed_items
      WHERE fetched_at >= ?${until ? ' AND fetched_at < ?' : ''} AND source <> ? AND source <> ?
      ORDER BY fetched_at DESC, id DESC LIMIT ${SUBJECT_WINDOW_LIMIT}`,
    until ? [since, until, CODE_SIGNAL_SOURCE, SITE_SOURCE] : [since, CODE_SIGNAL_SOURCE, SITE_SOURCE],
  );
  const out: SubjectWindow = { subjectOf: new Map(), members: new Map(), listed: new Set() };
  for (const row of rows) {
    const subject = screenSubject({
      id: row.id,
      source: row.source,
      url: row.url,
      title: row.title,
      body: row.body,
      organization: row.organization,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
    });
    if (!subject) continue;
    out.subjectOf.set(row.id, subject);
    out.members.set(subject, [...(out.members.get(subject) ?? []), row.id]);
    if (row.shortlisted_round_id) out.listed.add(subject);
  }
  return out;
}

/** Subjects in a window that the screen has answered for at least one record. */
async function screenedSubjects(window: SubjectWindow): Promise<Set<string>> {
  const screened = await screenedLeads([...window.subjectOf.keys()]);
  const out = new Set<string>();
  for (const id of screened) {
    const subject = window.subjectOf.get(id);
    if (subject) out.add(subject);
  }
  return out;
}

/** Records fetched in [since, until) that were never screened themselves because their subject's answer was read instead. */
async function coalescedItems(since: string, until: string): Promise<number> {
  const window = await subjectWindow(since, until);
  const screened = await screenedLeads([...window.subjectOf.keys()]);
  const answered = new Set<string>();
  for (const id of screened) answered.add(window.subjectOf.get(id)!);
  let n = 0;
  for (const [id, subject] of window.subjectOf) if (answered.has(subject) && !screened.has(id)) n += 1;
  return n;
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

/**
 * The order the free-model screen takes items in. The model is the escalation
 * for what code cannot read: the extractor's needsModel batches go first, whole
 * and in order, and only then the records code could read, which still need the
 * lead judgement the shortlist gate asks for. Nothing is dropped, so no gate is
 * lost; under a tight pace the unreadable records are the ones a model sees.
 * The order alone saves no call: `screenFeedLeads` asks about each needsModel
 * batch in one call per model (`screenLeadBatch`). Pure.
 */
export function screenOrder<T extends ExtractableItem>(items: readonly T[], now: Date): T[] {
  const unreadable = new Set(extractItems(items, now).needsModel.flat().map((one) => one.id));
  return [...items.filter((one) => unreadable.has(one.id)), ...items.filter((one) => !unreadable.has(one.id))];
}

// ---------------------------------------------------------------------------
// Batched escalation (ALGO-16-1 item 5): what code cannot read goes to the
// free models together, one call per batch and model, not one call per record.
// ---------------------------------------------------------------------------

/** The cheap_results kind of one batched screen call: one row per call, whatever it answered. */
export const SCREEN_LEAD_BATCH_KIND = 'SCREEN_LEAD_BATCH';
/** Id prefix of a SCREEN_LEAD answer a batched call gave: an item screened, not a call made. */
export const BATCH_ROW_PREFIX = 'chpb_';

/** What the per-record screen is asked about an item: the same object, so a batch answer is that screen's cache. */
function leadInputOf(item: ExtractableItem): LeadInput {
  return {
    source: item.source,
    title: item.title,
    organization: item.organization,
    publishedAt: item.publishedAt,
    body: item.body,
    url: item.url,
  };
}

/**
 * The needsModel batches among the records a pass will screen: the
 * extractor's own unreadable batches (`extractItems(...).needsModel`), cut at
 * `MODEL_BATCH_SIZE`, keeping only those of two or more records — one record
 * asked alone is the per-record screen. Pure.
 */
export function leadBatches<T extends ExtractableItem>(items: readonly T[], now: Date): T[][] {
  const byId = new Map(items.map((one) => [one.id, one]));
  return extractItems(items, now)
    .needsModel.map((batch) => batch.map((one) => byId.get(one.id)).filter((one): one is T => !!one))
    .filter((batch) => batch.length >= 2);
}

/**
 * The question for one batch: the per-record screen's own question, read from
 * the task (so there is one wording), followed by each post numbered, and a
 * reply with one answer per post. Pure.
 */
export function leadBatchPrompt(items: readonly ExtractableItem[]): string {
  const single = TASKS.SCREEN_LEAD.prompt(leadInputOf(items[0]!)).split('\n');
  const cut = single.findIndex((line) => line.startsWith('Source:'));
  const question = (cut > 0 ? single.slice(0, cut) : single).filter((line, i, all) => !(i === all.length - 1 && line === ''));
  const posts = items.map((item, i) =>
    [
      `Post ${i + 1}:`,
      `Source: ${item.source}`,
      `Title: ${item.title}`,
      `Organization: ${item.organization ?? 'unknown'}`,
      `Published: ${item.publishedAt ?? 'unknown'}`,
      `Text: ${(item.body ?? '').slice(0, 800)}`,
    ].join('\n'),
  );
  return [
    ...question,
    `Answer that question separately for each of the ${items.length} posts below; one post's answer never decides another's.`,
    '',
    ...posts.flatMap((post) => [post, '']),
    `Reply exactly: {"answers":[{"post":1,"verdict":"KEEP|DROP|UNSURE","window":"SHORT|ONGOING|UNKNOWN","deliverable":"KIND","need":"a few words","payer":"a few words or empty","reason":"one sentence"}, ...]} with one answer per post, ${items.length} in all.`,
  ].join('\n');
}

/**
 * One batch answer, per post. Each post's answer is validated exactly as the
 * per-record screen validates one (`parseLead`); a post with no answer, a
 * repeated post number or an off-shape answer is left unanswered, never
 * guessed. Pure.
 */
export function parseLeadBatch(text: string, size: number): Map<number, LeadOutput> {
  const out = new Map<number, LeadOutput>();
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return out;
  let value: unknown;
  try {
    value = JSON.parse(match[0]);
  } catch {
    return out;
  }
  const answers = value && typeof value === 'object' && !Array.isArray(value) ? (value as { answers?: unknown }).answers : null;
  if (!Array.isArray(answers)) return out;
  const repeated = new Set<number>();
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) continue;
    const { post, ...rest } = answer as Record<string, unknown>;
    const n = typeof post === 'number' ? post : typeof post === 'string' ? Number(post) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > size) continue;
    if (out.has(n) || repeated.has(n)) {
      out.delete(n);
      repeated.add(n);
      continue;
    }
    const parsed = parseLead(JSON.stringify(rest));
    if (parsed) out.set(n, parsed);
  }
  return out;
}

/** SCREEN_LEAD rows written today, the per-record screen's own daily budget measure. */
async function leadRowsToday(now: Date): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND created_at >= ?`,
    [`${now.toISOString().slice(0, 10)}T00:00:00.000Z`],
  );
  return Number(row?.n ?? 0);
}

/**
 * Ask the free models about a whole needsModel batch: one call per model that
 * is not down, never one per record. Every call is one SCREEN_LEAD_BATCH row
 * (ok when it answered at least one post), and every post it answered is a
 * SCREEN_LEAD row under the same input hash the per-record screen would use —
 * so that answer is the per-record screen's cache, and every gate after it
 * (two models agreeing, `leadPassesRules`, the shortlist) runs unchanged.
 * A post a model left unanswered has no row from it, so the per-record screen
 * still asks that model about that post: nothing is dropped, and a model
 * answer is still only a screen, never a fact. Returns how many calls it made.
 */
export async function screenLeadBatch(
  items: readonly ExtractableItem[],
  options: { config: LaneConfig; completer?: Completer; now: Date; health: Map<string, ModelHealth> },
): Promise<number> {
  if (items.length < 2) return 0;
  const db = getDb();
  const hashes = items.map((item) => inputHash('SCREEN_LEAD', leadInputOf(item)));
  const prompt = leadBatchPrompt(items);
  let calls = 0;
  for (const model of options.config.models) {
    if (isDown(options.health.get(model))) continue;
    const cached = await db.all<{ input_hash: string }>(
      `SELECT input_hash FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND model = ? AND input_hash IN (${hashes.map(() => '?').join(',')})`,
      [model, ...hashes],
    );
    const have = new Set(cached.map((row) => row.input_hash));
    const open = items.map((item, i) => ({ item, hash: hashes[i]! })).filter((one) => !have.has(one.hash));
    if (open.length < 2) continue;
    // The same daily budget the per-record screen keeps; a batch that would cross it is left to that screen.
    if ((await leadRowsToday(options.now)) + open.length > options.config.dailyBudget) continue;
    const asked = open.length === items.length ? prompt : leadBatchPrompt(open.map((one) => one.item));
    let text = '';
    let error: string | null = null;
    try {
      text = await (options.completer ?? httpCompleter)(options.config, model, TASKS.SCREEN_LEAD.system, asked, { maxTokens: 4000 });
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : 'failed';
    }
    calls += 1;
    const answers = error ? new Map<number, LeadOutput>() : parseLeadBatch(text, open.length);
    const callId = newId(BATCH_ROW_PREFIX.slice(0, -1));
    const at = nowIso();
    await db.transaction(async () => {
      await db.run(
        `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          callId,
          SCREEN_LEAD_BATCH_KIND,
          inputHash('SCREEN_LEAD', { batch: callId, hashes: open.map((one) => one.hash) }),
          null,
          model,
          answers.size > 0 ? 1 : 0,
          JSON.stringify({ items: open.map((one) => one.item.id), answered: answers.size }),
          error ?? (answers.size === open.length ? null : `answered ${answers.size} of ${open.length}: ${text.slice(0, 200)}`),
          at,
        ],
      );
      for (const [n, answer] of answers) {
        const one = open[n - 1]!;
        await db.run(
          `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
           VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)
           ON CONFLICT (kind, input_hash, model) DO NOTHING`,
          [`${callId}_${n}`, one.hash, one.item.id, model, JSON.stringify(answer), at],
        );
      }
    });
  }
  return calls;
}

/**
 * Screen recent, unscreened leads with the free models. Bounded per pass.
 * The needsModel batches among them are asked about whole first
 * (`screenLeadBatch`); every record then goes through the per-record screen,
 * which reads a batch answer as its cache and asks only what is still open.
 */
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
  const todoAll = recent
    .filter((item) => item.source !== SITE_SOURCE && item.source !== CODE_SIGNAL_SOURCE && !covered.has(item.id) && !done.has(item.id))
    .filter((item) => {
      const published = Date.parse(item.publishedAt ?? item.fetchedAt);
      return !Number.isFinite(published) || now.getTime() - published <= LEAD_MAX_AGE_MS;
    });
  // One question, one screen: a record whose subject is already answered (or asked first in this
  // pass) reads that answer instead of costing its own call. The window includes listed records,
  // so a subject a shortlist already took is not asked again under another record.
  const window = await subjectWindow(since);
  const settled = await screenedSubjects(window);
  const todo = planScreens(todoAll, settled, now).ask.slice(0, pace.perPass);
  // Escalation in batches: what the parser could not read is asked about together.
  const batches = leadBatches(todo, now);
  let nextBatch = 0;
  const batchWorker = async (): Promise<void> => {
    while (nextBatch < batches.length) {
      const batch = batches[nextBatch++]!;
      await screenLeadBatch(batch, { config, completer: input.completer, now, health });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(pace.parallel, batches.length)) }, () => batchWorker()));
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
async function ownLeadScreens(ids: readonly string[]): Promise<Map<string, LeadOutput>> {
  const out = new Map<string, LeadOutput>();
  if (ids.length === 0) return out;
  const { parseLead, combineLeads } = await import('../cheap/lane.ts');
  const by = new Map<string, (LeadOutput | null)[]>();
  const seen = new Set<string>();
  for (let at = 0; at < ids.length; at += SUBJECT_PAGE) {
    const chunk = ids.slice(at, at + SUBJECT_PAGE);
    const rows = await getDb().all<{ subject_id: string; model: string; ok: number; output: string | null }>(
      `SELECT subject_id, model, ok, output FROM cheap_results
        WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at DESC`,
      chunk,
    );
    for (const row of rows) {
      const key = `${row.subject_id}\n${row.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      by.set(row.subject_id, [...(by.get(row.subject_id) ?? []), row.ok && row.output ? parseLead(row.output) : null]);
    }
  }
  for (const [id, answers] of by) {
    const merged = combineLeads(answers);
    if (merged) out.set(id, merged);
  }
  return out;
}

async function leadScreens(items: readonly StoredFeedItem[], window: SubjectWindow | null = null): Promise<Map<string, LeadOutput>> {
  const out = await ownLeadScreens(items.map((one) => one.id));
  if (items.length === 0) return out;
  // A record coalesced onto its subject reads the answer given for that subject's screened record.
  // It is the same question, so it is the same answer; every rule after this still runs on the record itself.
  if (window) {
    const missing = items.filter((one) => !out.has(one.id) && window.subjectOf.has(one.id));
    const siblings = [...new Set(missing.flatMap((one) => window.members.get(window.subjectOf.get(one.id)!) ?? []))].filter((id) => !out.has(id));
    const answers = new Map([...out, ...(await ownLeadScreens(siblings))]);
    for (const item of missing) {
      const subject = window.subjectOf.get(item.id)!;
      const answeredBy = (window.members.get(subject) ?? []).find((id) => id !== item.id && answers.has(id));
      if (answeredBy) out.set(item.id, answers.get(answeredBy)!);
    }
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
    `the work it could take: ${screen.deliverable === 'BROKERED_SERVICE' ? 'a service an independent contractor performs and this operation sells and coordinates' : (DELIVERABLE_LABEL[screen.deliverable as keyof typeof DELIVERABLE_LABEL] ?? screen.deliverable)}`;
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
export async function openFeedShortlist(input: { projectId: string; now?: Date; spare?: number }): Promise<string | null> {
  const pace = shortlistPace(input.spare ?? 0);
  const now = input.now ?? new Date();
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed || !gate.mode) return null;
  const mode = gate.mode;
  // The daily reading of what the code-first lane saved and made (ALGO-19-3), on the same tick that
  // decides the shortlist. Its own catch: a reading that cannot be taken never stops discovery.
  await recordScreeningEconomy({ projectId: input.projectId, now }).catch((error: unknown) => {
    console.warn(`[feeds] screening economy unreadable for ${input.projectId}: ${String((error as Error)?.message ?? error)}`);
  });
  // Deterministic extraction of what arrived since the last pass (ALGO-16-1 item 2), on the same tick.
  // Its own catch: a pass that cannot be recorded never stops discovery.
  await recordFeedExtraction({ projectId: input.projectId, now }).catch((error: unknown) => {
    console.warn(`[feeds] extraction pass failed for ${input.projectId}: ${String((error as Error)?.message ?? error)}`);
  });
  const history = (await listRounds(input.projectId)).filter((one) => one.bucketId === FEED_SHORTLIST_BUCKET.id);
  if (history.some((one) => one.state === 'OPEN')) return null;
  const latest = history.reduce<string | null>((max, one) => (!max || one.openedAt > max ? one.openedAt : max), null);
  const settled = history.reduce<string | null>((max, one) => {
    const at = one.harvestedAt ?? one.openedAt;
    return !max || at > max ? at : max;
  }, null);
  if (latest && now.getTime() - Date.parse(latest) < SHORTLIST_INTERVAL_MS) {
    // Idle capacity shortens the wait, measured from when the last one settled.
    if (pace.intervalMs >= SHORTLIST_INTERVAL_MS) return null;
    if (settled && now.getTime() - Date.parse(settled) < pace.intervalMs) return null;
  }

  const { chosen } = await shortlistFunnel(input.projectId, now, pace.size);
  // What the feed loop derived and ranked (ALGO-19-4 act): the gaps between its constructions and an
  // opening go to Claude in the same round as the leads, so a ranking is research, not a ledger line.
  const questions = await pendingLoopQuestions(input.projectId, now).catch((error: unknown) => {
    console.warn(`[feeds] feed-loop questions unreadable for ${input.projectId}: ${String((error as Error)?.message ?? error)}`);
    return [] as MissingLinkQuestion[];
  });
  // Before research is asked, the large corpora are weighed for each unknown, and one that pays is proposed (ACQ-21-3).
  // Its own catch: discovery that cannot be recorded never stops the round.
  if (questions.length > 0) {
    await discoverCorporaForUnknowns({ projectId: input.projectId, unknowns: questions, now }).catch((error: unknown) => {
      console.warn(`[feeds] corpus discovery failed for ${input.projectId}: ${String((error as Error)?.message ?? error)}`);
    });
  }
  if (chosen.length === 0 && questions.length === 0) return null;

  const frame = await executionFrame(input.projectId, mode.currency);
  const statement = [
    FEED_SHORTLIST_BUCKET.question,
    sprintGoalLine(mode.objective),
    frame ? executionFrameSentence(frame) : '',
    'Free models read these public posts and kept them; nothing about them is established yet. ' +
      'Open each page. Report as an opening only what the page itself shows, quoting it, and say ' +
      'plainly for each one that does not hold up.',
    ...chosen.map(({ line }) => `\n- lead: ${line}`),
    questions.length
      ? '\nCode joined these records into designs that are still hypotheses, and derived what stands between them and an opening. ' +
        'Answer each from a source you can quote; an unanswered gap is reported as unanswered, never assumed.'
      : '',
    ...questions.map((q) => `\n- missing link: ${q.question}${q.evidenceUrls.length ? ` Start from: ${q.evidenceUrls.join(', ')}.` : ''}`),
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
  if (questions.length) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: LOOP_QUESTIONS_ASKED_EVENT,
      actorRef: 'BRAIN',
      summary: `Feed loop: ${questions.length} derived missing-link question(s) put to research in shortlist round ${roundNo}; each stays open until a quoted source answers it.`,
      detail: { roundId: round.id, candidateId: round.candidateId, keys: questions.map((q) => q.key), questions: questions.map((q) => ({ key: q.key, neighborhood: q.neighborhood, condition: q.condition, constructionKeys: q.constructionKeys, value: q.value })) },
    });
  }
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'CASH_DISCOVERY_OPENED',
    actorRef: 'BRAIN',
    summary: `Feed shortlist opened: ${chosen.length} lead(s) for Claude to verify${questions.length ? ` and ${questions.length} missing-link question(s) to answer` : ''} (round ${roundNo}).`,
    detail: {
      bucketId: FEED_SHORTLIST_BUCKET.id,
      candidateId: round.candidateId,
      cashModeId: mode.id,
      round: roundNo,
      leads: chosen.map(({ item }) => item.id),
      questions: questions.map((q) => q.key),
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
export async function shortlistFunnel(
  projectId: string,
  now: Date = new Date(),
  size: number = SHORTLIST_SIZE,
): Promise<ShortlistFunnel> {
  const since = new Date(now.getTime() - LEAD_MAX_AGE_MS).toISOString();
  const pool = await unlistedFeedItems({ since, limit: 2_000 });
  const window = await subjectWindow(since);
  const screens = await leadScreens(pool, window);
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
      all.filter((one) => screens.get(one.id)?.window === 'SHORT').length < size)
    .filter((item) => {
      const key = openingSourceKey(item.url);
      return !key || !held.has(key);
    })
    // A subject a shortlist already took is not put to Claude again under another record.
    .filter((item) => {
      const subject = window.subjectOf.get(item.id);
      return !subject || !window.listed.has(subject);
    })
    .sort((a, b) => {
      const wa = screens.get(a.id)?.window === 'SHORT' ? 0 : 1;
      const wb = screens.get(b.id)?.window === 'SHORT' ? 0 : 1;
      if (wa !== wb) return wa - wb;
      return (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt);
    });
  const chosen: { item: StoredFeedItem; line: string }[] = [];
  const subjects = new Set<string>();
  for (const item of ranked) {
    if (chosen.length >= size) break;
    // One record per subject: its reposts are the same lead, not more of them.
    const subject = window.subjectOf.get(item.id);
    if (subject && subjects.has(subject)) continue;
    const line = shortlistLine(item, screens.get(item.id)!);
    if (line) {
      chosen.push({ item, line });
      if (subject) subjects.add(subject);
    }
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
