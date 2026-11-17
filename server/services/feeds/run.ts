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
import { FEED_SOURCES, pullUrl, type FeedItem, type FeedSource } from './sources.ts';
import { FEED_SHORTLIST_BUCKET } from './bucket.ts';
import { SITE_SOURCE } from './sites.ts';
import { CODE_SIGNAL_SOURCE, coveredItems, detectionsForLeads } from './detectors.ts';
import { EXTRACTOR_VERSION, extractItem, extractItems, MODEL_BATCH_SIZE, type ExtractableItem, type ExtractedFact } from './extract.ts';
import { commitReadings, emptyDeltaIndex, fingerprintOf, foldSlices, planDelta, recordIdentity, sliceOf, type DeltaIndex, type DeltaPlan, type DeltaStatus, type RecordReading } from '../knowledge/delta.ts';
import { nameKeyOf, resolveIdentities, type IdentityCollision, type IdentityLink, type IdentityRecord } from '../knowledge/identity.ts';
import { selectForDeepening, type DeepeningCandidate, type DeepeningDecision, type DeepeningResult } from '../knowledge/deepening.ts';
import { judgeStructure, plannedStage, planProcessing, type Executor, type PlannedStage, type ProcessingPlan, type RouteEvidence, type Stage } from '../knowledge/processingGraph.ts';
import { addFunnelReadings, funnelGain, readFunnel, readStoredFunnel, type FunnelReading, type FunnelRecord } from '../knowledge/funnel.ts';
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
  /** The source answered that nothing changed (304, the same content hash, or every shard already checkpointed): nothing was ingested. */
  notModified?: boolean;
  /** The provider stated it holds no records for what was asked (`FeedSource.emptyBody`): a quiet period, not an empty parse. */
  nothingPublished?: boolean;
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
/**
 * What a pull is recorded as when the provider itself stated that it holds no
 * records for what was asked (`FeedSource.emptyBody`: an EDGAR filing day with
 * `hits.total.value` 0, a weekend or a holiday). A quiet day, not a parser that
 * reads nothing, so health never counts it toward a schema change.
 */
export const NOTHING_PUBLISHED_MARK = 'NOTHING_PUBLISHED';

/**
 * Whether a recorded pull only learned that there was nothing new to read: a
 * 304 or unchanged hash, a sharded read whose every shard was already
 * checkpointed, or a provider that said it holds no records. Such a pull is no
 * evidence about the parser either way, so connector health does not read it
 * (a zero-record streak of these is not a schema change). Pure.
 */
export function isQuietPull(pull: { ok: boolean; error: string | null }): boolean {
  if (!pull.ok) return false;
  const error = pull.error ?? '';
  return error.startsWith(NOT_MODIFIED_MARK) || error.startsWith(NOTHING_PUBLISHED_MARK);
}
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
    `SELECT measures FROM bin_events WHERE event_type = ? AND provider = ? AND outcome IN ('INGESTED', 'NOT_MODIFIED', 'NOTHING_PUBLISHED')
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

/** A source's own completion of its parsed items (`FeedSource.complete`); never fails the pull — a source without one, or one that throws, keeps what it parsed. */
async function completeParsed(source: FeedSource, items: FeedItem[], getJson: (url: string) => Promise<unknown>): Promise<FeedItem[]> {
  if (!source.complete || items.length === 0) return items;
  try {
    return await source.complete(items, getJson);
  } catch {
    return items;
  }
}

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
      // Shards whose provider stated it holds no records: a quiet day, never a parser that read nothing.
      const emptyShards = new Set<string>();
      const sharded: ShardedSource = {
        id: source.id,
        snapshot: plan.snapshot,
        shards: plan.keys,
        spacingMs: source.spacingMs ?? 0,
        fetchShard: async (key) => {
          const got = await deps.read(plan.url(key), null, headers, source.timeoutMs);
          if (got.status !== 'MODIFIED') return [];
          const body = parseJsonBody(got.body);
          const items = source.parse(body);
          if (items.length === 0 && source.emptyBody?.(body)) emptyShards.add(key);
          return items;
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
      if (run.completed.length === 0) {
        // Every shard was already checkpointed: nothing was asked, so nothing is known about the parser.
        outcome = 'NOT_MODIFIED';
        result.notModified = true;
        await recordFeedPull({ source: source.id, ok: true, fetched: 0, inserted: 0, error: `${NOT_MODIFIED_MARK}: every shard (${run.resumedPast.join(', ')}) already checkpointed`.slice(0, 300), at });
      } else if (fetched === 0 && run.completed.every((c) => emptyShards.has(c.shard))) {
        // The provider said each shard read holds no records (a weekend or holiday filing day).
        outcome = NOTHING_PUBLISHED_MARK;
        result.nothingPublished = true;
        await recordFeedPull({ source: source.id, ok: true, fetched: 0, inserted: 0, error: `${NOTHING_PUBLISHED_MARK}: the provider reports no records for ${run.completed.map((c) => c.shard).join(', ')}`.slice(0, 300), at });
      } else {
        await recordFeedPull({ source: source.id, ok: true, fetched, inserted, error: null, at });
      }
    } else {
      const prior = await deps.validators(source.id);
      const got = await deps.read(url, prior, headers, source.timeoutMs);
      validators = got.validators;
      if (got.status === 'NOT_MODIFIED') {
        outcome = 'NOT_MODIFIED';
        result = { ...base, notModified: true };
        await recordFeedPull({ source: source.id, ok: true, fetched: 0, inserted: 0, error: `${NOT_MODIFIED_MARK}: ${got.reason}`.slice(0, 300), at });
      } else {
        const body = parseJsonBody(got.body);
        const items = await completeParsed(source, source.parse(body), async (followUp) => {
          const more = await deps.read(followUp, null, headers, source.timeoutMs);
          if (more.status !== 'MODIFIED') throw new Error(`no body for ${followUp}`);
          return parseJsonBody(more.body);
        });
        if (items.length === 0 && source.emptyBody?.(body)) {
          outcome = NOTHING_PUBLISHED_MARK;
          result = { ...base, nothingPublished: true };
          await recordFeedPull({ source: source.id, ok: true, fetched: 0, inserted: 0, error: `${NOTHING_PUBLISHED_MARK}: the provider reports no records`, at });
        } else {
          const inserted = await insertFeedItems(source.id, items);
          result = { ...base, fetched: items.length, inserted, duplicates: Math.max(0, items.length - inserted) };
          await recordFeedPull({ source: source.id, ok: true, fetched: items.length, inserted, error: null, at });
        }
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
    reason: `${source.id}: ${outcome === 'FAILED' ? result.error : `${result.fetched} read, ${result.inserted} stored${result.notModified ? ' (not modified)' : ''}${result.nothingPublished ? ' (provider reports no records)' : ''}`}`.slice(0, 480),
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

/** Pull history for health, without the quiet pulls that only learned there was nothing new (`isQuietPull`). */
export async function historyWithoutNotModified(source: string) {
  const { readPullHistory } = await import('./health.ts');
  return (await readPullHistory(source)).filter((p) => !isQuietPull(p));
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
      const fetcher = input.fetcher ?? httpFetcher;
      const body = await fetcher(ask.url, source.headers ?? {}, source.timeoutMs);
      const items = await completeParsed(source, source.parse(body), (followUp) => fetcher(followUp, source.headers ?? {}, source.timeoutMs));
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
  /** The processing graph Brain judged for each source in the pass (KNOW-25-1): which stages, CODE or LLM, and why. */
  processingGraph?: ProcessingPlan[];
  /** Delta classification against the fingerprint index the previous pass carried: only NEW, CHANGED and REPARSE records are read. */
  delta?: ExtractionDelta;
  /** Identity resolution of the pass's entities: corroborated links, and collisions kept apart. */
  identity?: { links: IdentityLink[]; collisions: IdentityCollision[]; uncorroborated: number };
  /** Selective deepening of the unreadable and contested candidates, against measured capacity. */
  deepening?: {
    capacity: number;
    threshold: number | null;
    promoted: DeepeningDecision[];
    held: DeepeningDecision[];
    /**
     * The promoted contested keys, entity collisions and cross-source links, each as the verification
     * question the next feed shortlist round puts to research (`pendingDeepeningQuestions`). A promoted
     * unreadable record is not here: the free-model screen reads it (`routeEscalation`).
     */
    questions?: MissingLinkQuestion[];
  };
  /** The intelligence funnel for this pass, and what it gained: raw intake beside usable intelligence. */
  funnel?: {
    /** This pass alone: its records at each stage, with evidence and decisions recorded since the previous pass. */
    reading: FunnelReading;
    /** The previous pass's cumulative reading plus this one: what Brain has understood across passes. */
    cumulative: FunnelReading;
    /** Start of the window the downstream stages (evidence accepted, goal decisions) were read over. */
    since: string;
    /** `cumulative` against the previous pass's cumulative reading. */
    gain: { raw: number; usableIntelligence: number; falseSpeed: boolean };
  };
  /** A stage that failed this pass; the pass is still recorded and the stage is named. */
  stageFailures?: { stage: string; error: string }[];
  /**
   * This pass's slice of the fingerprint index (`sliceOf`): the records the batch presented, each at its
   * latest version, and the mappings they set — never the whole index. The row is append-only, so a full
   * copy here would be written again on every pass; the next pass folds the recent slices instead
   * (`foldSlices`, over at most `DELTA_LOOKBACK_PASSES` rows and `DELTA_INDEX_MAX_RECORDS` records).
   */
  deltaIndex?: DeltaIndex;
  /**
   * What each source's plan actually ran this pass, with the executor the plan gave it and how many
   * records it ran over: the plan decides, and this is the record that it did. `planned` is false only
   * when the planner failed and the source ran as code.
   */
  stagesRun?: StageRun[];
  /** The parser's measured record per source under one parser version, which the next pass's plans read. */
  parserHistory?: { parserVersion: string; sources: ParserHistory };
}

export interface StageRun {
  sourceId: string;
  stage: Stage;
  executor: Executor;
  records: number;
  planned: boolean;
}

/** Per source: records the parser read, records it could read, the value they put at stake, and whether they carried quantities. */
export type ParserHistory = Record<string, { runs: number; successes: number; decisionValue: number; reconstructs: boolean }>;

/**
 * The carried parser history, or empty when it is absent, malformed or from another parser version:
 * a new parser has no record yet, and an old parser's record is never credited to it.
 */
export function readParserHistory(raw: unknown, parserVersion: string): ParserHistory {
  if (!raw || typeof raw !== 'object') return {};
  const { parserVersion: version, sources } = raw as { parserVersion?: unknown; sources?: unknown };
  if (version !== parserVersion || !sources || typeof sources !== 'object') return {};
  const out: ParserHistory = {};
  for (const [id, one] of Object.entries(sources as Record<string, unknown>)) {
    const h = one as { runs?: unknown; successes?: unknown; decisionValue?: unknown; reconstructs?: unknown };
    if (typeof h?.runs !== 'number' || typeof h.successes !== 'number' || h.runs < 0 || h.successes < 0 || h.successes > h.runs) continue;
    out[id] = {
      runs: h.runs,
      successes: h.successes,
      decisionValue: typeof h.decisionValue === 'number' && h.decisionValue > 0 ? h.decisionValue : 1,
      reconstructs: h.reconstructs === true,
    };
  }
  return out;
}

export interface ExtractionDelta {
  parserVersion: string;
  counts: Record<DeltaStatus, number>;
  /** Item ids per status. */
  newItems: string[];
  changedItems: string[];
  unchangedItems: string[];
  reparsedItems: string[];
  /** Fact keys recomputed this pass: what the previous versions of changed records produced, plus what was read now. */
  recomputedKeys: string[];
  /**
   * Stored records (not re-read this pass) whose observations of a recomputed key were reconciled with
   * what was read: the recomputation ran against them, so a contradiction across passes is seen.
   */
  reconciledAgainst?: string[];
  affectedEntities: string[];
}

/** Stored records a pass reloads to recompute its affected keys against; bounded so a pass never reads the store. */
export const STORED_OBSERVATIONS_MAX = 500;

/**
 * The records whose observations a recomputation needs and this pass did not re-read: the batch's own
 * unchanged records, and earlier passes' records the index says produced one of the keys, each at the
 * exact version the index holds (same fingerprint, read by the current parser). A record being re-read
 * now is never its own context: its previous version is superseded, not contradicted.
 */
async function storedObservationsFor(input: {
  items: readonly ExtractableItem[];
  identityOfItem: ReadonlyMap<string, string>;
  toRead: ReadonlySet<string>;
  priorIndex: DeltaIndex;
  keys: ReadonlySet<string>;
}): Promise<ExtractableItem[]> {
  const out: ExtractableItem[] = [];
  const taken = new Set<string>();
  for (const item of input.items) {
    const identity = input.identityOfItem.get(item.id)!;
    if (input.toRead.has(identity) || taken.has(identity)) continue;
    taken.add(identity);
    out.push(item);
  }
  const wanted = Object.values(input.priorIndex.records)
    .filter((h) => !taken.has(h.identity) && !input.toRead.has(h.identity))
    .map((h) => ({ identity: h.identity, latest: h.versions[h.versions.length - 1] }))
    .filter((r): r is { identity: string; latest: NonNullable<typeof r.latest> } =>
      !!r.latest && r.latest.parserVersion === EXTRACTOR_VERSION && r.latest.factKeys.some((k) => input.keys.has(k)),
    )
    .slice(0, Math.max(0, STORED_OBSERVATIONS_MAX - out.length));
  out.push(...(await storedAtIndexedVersion(wanted, taken)));
  return out;
}

/**
 * The stored rows of indexed records, each at exactly the version the index holds (same fingerprint):
 * a row with other content is a version that reading never saw. `taken` identities are skipped and
 * filled in as rows are taken.
 */
async function storedAtIndexedVersion(
  wanted: readonly { identity: string; latest: { fingerprint: string } }[],
  taken: Set<string>,
): Promise<ExtractableItem[]> {
  const bySource = new Map<string, Map<string, string>>();
  for (const r of wanted) {
    const at = r.identity.indexOf('\u0000');
    if (at < 0) continue;
    const source = r.identity.slice(0, at);
    bySource.set(source, new Map([...(bySource.get(source) ?? []), [r.identity.slice(at + 1), r.latest.fingerprint]]));
  }
  const out: ExtractableItem[] = [];
  const db = getDb();
  for (const [source, records] of bySource) {
    const ids = [...records.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const marks = chunk.map(() => '?').join(', ');
      const rows = await db.all<{ id: string; source: string; url: string; title: string; body: string | null; organization: string | null; published_at: string | null; fetched_at: string }>(
        `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
          WHERE source = ? AND (url IN (${marks}) OR id IN (${marks}))
          ORDER BY fetched_at DESC, id DESC`,
        [source, ...chunk, ...chunk],
      );
      for (const row of rows) {
        const item: ExtractableItem = {
          id: row.id, source: row.source, url: row.url, title: row.title, body: row.body,
          organization: row.organization, publishedAt: row.published_at, fetchedAt: row.fetched_at,
        };
        const record = deltaRecordOf(item);
        const identity = recordIdentity(record.source, record.recordId);
        if (taken.has(identity) || records.get(record.recordId) !== fingerprintOf(record.content)) continue;
        taken.add(identity);
        out.push(item);
      }
    }
  }
  return out;
}

/** Stored records a pass re-presents because an older parser read them; bounded so a parser change is absorbed over passes. */
export const REPARSE_PER_PASS = 100;

/**
 * Records the index says an older parser read, re-presented from their stored rows at exactly the
 * version that parser read (same fingerprint), so the delta classifies them REPARSE and the current
 * parser reads them again (KNOW-25-1: "a parser change re-reads exactly the records that parser read").
 * Intake never brings an unchanged record back, so without this a parser change would re-read nothing.
 * A record the cursor batch already carries is not re-presented twice.
 */
async function storedForReparse(input: {
  priorIndex: DeltaIndex;
  exclude: ReadonlySet<string>;
  limit: number;
}): Promise<ExtractableItem[]> {
  const wanted = Object.values(input.priorIndex.records)
    .filter((h) => !input.exclude.has(h.identity))
    .map((h) => ({ identity: h.identity, latest: h.versions[h.versions.length - 1] }))
    .filter((r): r is { identity: string; latest: NonNullable<typeof r.latest> } =>
      !!r.latest && r.latest.parserVersion !== null && r.latest.parserVersion !== EXTRACTOR_VERSION,
    )
    .slice(0, Math.max(0, input.limit));
  return storedAtIndexedVersion(wanted, new Set());
}

/** Records the folded fingerprint index keeps, most recently seen first. */
export const DELTA_INDEX_MAX_RECORDS = 5000;
/**
 * Extraction rows the next pass folds its index from. Each row holds only its own pass's slice, so the
 * read is bounded by this many passes of at most `EXTRACTION_ITEMS_PER_PASS` records each, and nothing
 * is rewritten.
 */
export const DELTA_LOOKBACK_PASSES = Math.ceil(DELTA_INDEX_MAX_RECORDS / EXTRACTION_ITEMS_PER_PASS);

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** What a record says, for its fingerprint: never when or where it was fetched. */
function deltaRecordOf(item: ExtractableItem) {
  return {
    source: item.source,
    recordId: item.url || item.id,
    content: { title: item.title, body: item.body, organization: item.organization, publishedAt: item.publishedAt },
  };
}

/** The route a stored source is pulled through, as the processing graph reads it. */
function routeOf(sourceId: string, items: readonly ExtractableItem[]): RouteEvidence {
  const source = FEED_SOURCES.find((s) => s.id === sourceId);
  if (!source) return { url: items[0]?.url ?? sourceId, kind: 'DOCUMENT', updateMechanism: 'UNKNOWN', automatable: true };
  if (source.shards) return { url: source.url, kind: 'BULK', updateMechanism: 'BULK_SNAPSHOT', automatable: true };
  return { url: source.url, kind: source.cursorUrl ? 'API' : 'FEED', updateMechanism: 'CONDITIONAL_FETCH', automatable: true };
}

/** The largest money figure an item's facts state, in major units: the decision value at stake, or 1 when none is stated. */
function statedValue(facts: readonly ExtractedFact[]): number {
  let best = 0;
  for (const f of facts) if (f.currency && typeof f.value === 'number' && f.value > best) best = f.value;
  return best > 0 ? best / 100 : 1;
}

/** Measured idle research capacity for the project; unknown is zero, never a favourable assumption. */
async function measuredDeepeningCapacity(projectId: string): Promise<number> {
  try {
    const { spareResearchSurfaces } = await import('../cash/researchRoom.ts');
    return (await spareResearchSurfaces(projectId)) ?? 0;
  } catch {
    return 0;
  }
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
/** Rows read per downstream funnel stage per pass; a longer window is read on the next pass. */
export const FUNNEL_DOWNSTREAM_LIMIT = 5_000;

/**
 * The funnel's downstream stages, each from its own rows over (since, until]:
 * evidence accepted is a lead screen's answer (verified only when a model said
 * KEEP) or a detector's coverage, one record per item; a goal-impacting
 * decision is a shortlist round taking a stored record into research.
 */
export async function downstreamFunnelRecords(since: string, until: string): Promise<{ evidence: FunnelRecord[]; decisions: FunnelRecord[] }> {
  const db = getDb();
  const screens = await db.all<{ subject_id: string; output: string | null; created_at: string }>(
    `SELECT subject_id, output, created_at FROM cheap_results
      WHERE kind = 'SCREEN_LEAD' AND ok = 1 AND subject_id IS NOT NULL AND created_at > ? AND created_at <= ?
      ORDER BY created_at, id LIMIT ?`,
    [since, until, FUNNEL_DOWNSTREAM_LIMIT],
  );
  const covered = await db.all<{ item_id: string; covered_at: string }>(
    `SELECT item_id, covered_at FROM feed_item_coverage WHERE covered_at > ? AND covered_at <= ? ORDER BY covered_at, item_id LIMIT ?`,
    [since, until, FUNNEL_DOWNSTREAM_LIMIT],
  );
  const byItem = new Map<string, { observedAt: string; verified: boolean }>();
  const accept = (id: string, at: string, verified: boolean) => {
    const held = byItem.get(id);
    byItem.set(id, { observedAt: held && held.observedAt > at ? held.observedAt : at, verified: (held?.verified ?? false) || verified });
  };
  for (const row of screens) accept(row.subject_id, row.created_at, (row.output ?? '').includes('"verdict":"KEEP"'));
  for (const row of covered) accept(row.item_id, row.covered_at, true);
  const evidence: FunnelRecord[] = [...byItem.entries()].map(([id, e]) => ({ id, fingerprint: `evidence:${id}`, observedAt: e.observedAt, verified: e.verified }));
  const shortlisted = await db.all<{ id: string; shortlisted_round_id: string; shortlisted_at: string }>(
    `SELECT id, shortlisted_round_id, shortlisted_at FROM feed_items
      WHERE shortlisted_round_id IS NOT NULL AND shortlisted_at > ? AND shortlisted_at <= ?
      ORDER BY shortlisted_at, id LIMIT ?`,
    [since, until, FUNNEL_DOWNSTREAM_LIMIT],
  );
  const decisions: FunnelRecord[] = shortlisted.map((row) => ({
    id: row.id,
    fingerprint: `${row.shortlisted_round_id}:${row.id}`,
    observedAt: row.shortlisted_at,
  }));
  return { evidence, decisions };
}

export async function recordFeedExtraction(input: {
  projectId: string;
  now?: Date;
  limit?: number;
  /** Deepening capacity to use instead of measuring it (tests). */
  capacity?: number;
  /** Stages to fail on purpose (tests of the stage-failure record). */
  failStages?: readonly string[];
}): Promise<ExtractionPass | null> {
  const now = input.now ?? new Date();
  const db = getDb();
  const recent = await db.all<{ detail: string | null; created_at: string }>(
    `SELECT detail, created_at FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [input.projectId, EXTRACTION_EVENT, DELTA_LOOKBACK_PASSES],
  );
  let from: { fetchedAt: string; id: string } | null = null;
  let priorHistory: ParserHistory = {};
  // The funnel the previous pass ended at (cumulative), and when it was recorded: this pass's gain is measured against it.
  let priorFunnel: FunnelReading = readFunnel({});
  const priorPassAt: string | null = recent[0]?.created_at ?? null;
  const slices: unknown[] = [];
  for (const [i, row] of recent.entries()) {
    try {
      const parsed = JSON.parse(row.detail ?? '{}') as {
        cursor?: { to?: { fetchedAt?: unknown; id?: unknown } };
        deltaIndex?: unknown;
        parserHistory?: unknown;
        funnel?: { reading?: unknown; cumulative?: unknown };
      };
      slices.push(parsed.deltaIndex);
      if (i !== 0) continue;
      const to = parsed.cursor?.to;
      if (to && typeof to.fetchedAt === 'string' && typeof to.id === 'string') from = { fetchedAt: to.fetchedAt, id: to.id };
      priorHistory = readParserHistory(parsed.parserHistory, EXTRACTOR_VERSION);
      // A row from before the cumulative reading existed carries only its own pass: that is where the total starts.
      priorFunnel = readStoredFunnel(parsed.funnel?.cumulative) ?? readStoredFunnel(parsed.funnel?.reading) ?? priorFunnel;
    } catch {
      // An unreadable row contributes no slice; when it is the newest, the cursor starts again at the lead window.
    }
  }
  // The index is folded from the recent passes' slices, newest first; no row holds the whole of it.
  const priorIndex: DeltaIndex = foldSlices(slices, DELTA_INDEX_MAX_RECORDS);
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
  const fromRows: ExtractableItem[] = rows.map((row) => ({
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    body: row.body,
    organization: row.organization,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
  }));
  // Records an older parser read come back from their stored rows: intake never re-sends an unchanged
  // record, so this is the only way a parser change reaches what that parser read.
  const reparse = await storedForReparse({
    priorIndex,
    exclude: new Set(fromRows.map((item) => recordIdentity(item.source, deltaRecordOf(item).recordId))),
    limit: REPARSE_PER_PASS,
  });
  if (fromRows.length === 0 && reparse.length === 0) return null;
  const items: ExtractableItem[] = [...fromRows, ...reparse];
  const nowIsoText = now.toISOString();
  const stageFailures: { stage: string; error: string }[] = [];
  const stage = <T,>(name: string, fallback: T, fn: () => T): T => {
    try {
      if (input.failStages?.includes(name)) throw new Error(`stage ${name} failed on request`);
      return fn();
    } catch (error) {
      stageFailures.push({ stage: name, error: errorText(error) });
      return fallback;
    }
  };

  // Delta: classify the batch against the index the previous pass carried; only what is new,
  // changed or read by an older parser is read again, and only its facts are recomputed.
  const identityOfItem = new Map(items.map((item) => [item.id, recordIdentity(item.source, deltaRecordOf(item).recordId)]));
  const deltaPlan = stage<DeltaPlan | null>('delta', null, () =>
    planDelta({ index: priorIndex, batch: items.map(deltaRecordOf), parserVersion: EXTRACTOR_VERSION, now: nowIsoText }),
  );
  const statusOfIdentity = new Map((deltaPlan?.changes ?? []).map((c) => [c.identity, c.status]));
  const toRead = deltaPlan ? new Set(deltaPlan.toRead) : null;
  const claimed = new Set<string>();
  const deltaItems = toRead
    ? items.filter((item) => {
        const identity = identityOfItem.get(item.id)!;
        if (!toRead.has(identity) || claimed.has(identity)) return false;
        claimed.add(identity);
        return true;
      })
    : items;

  // Processing graph, judged before anything is read: one plan per source, from that source's own
  // evidence (its declared format and route, its checkpoint and delta, its parser's measured history,
  // the names its records carry), and the plan decides which stages run on its records and whether a
  // stage goes to code or to the model (KNOW-25-1). A source the planner could not judge runs as code
  // did before, and the failure is named.
  const capacity = input.capacity ?? (await measuredDeepeningCapacity(input.projectId));
  const bySource = new Map<string, ExtractableItem[]>();
  for (const item of items) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item]);
  const nameOf = (item: ExtractableItem) => ((item.organization ?? '').trim() === '' ? '' : nameKeyOf('ENTITY', item.organization!));
  const recordsByName = new Map<string, number>();
  const sourcesByName = new Map<string, Set<string>>();
  for (const item of deltaItems) {
    const key = nameOf(item);
    if (!key) continue;
    recordsByName.set(key, (recordsByName.get(key) ?? 0) + 1);
    sourcesByName.set(key, new Set([...(sourcesByName.get(key) ?? []), item.source]));
  }
  const plans = stage<ProcessingPlan[] | null>('processingGraph', null, () =>
    [...bySource.entries()].map(([sourceId, sourceItems]) => {
      const feed = FEED_SOURCES.find((s) => s.id === sourceId);
      const pending = sourceItems.filter((item) => deltaItems.includes(item));
      const hasCheckpoint = Object.values(priorIndex.records).some((h) => h.identity.startsWith(`${sourceId}\u0000`));
      const statuses = sourceItems.map((item) => statusOfIdentity.get(identityOfItem.get(item.id) ?? ''));
      const history = priorHistory[sourceId] ?? null;
      const establishedEntityMappings = Object.values(priorIndex.entityMappings).some((m) => m.setBy.startsWith(`${sourceId}\u0000`));
      const names = pending.map(nameOf).filter((key) => key !== '');
      return planProcessing(
        {
          sourceId,
          structure: judgeStructure(feed?.acquisition?.access.format, sourceItems),
          // The publisher is the authority for what it states only when the source names it and the terms it publishes under.
          authoritative: !!(feed?.acquisition?.provenance.publisher && feed.acquisition.provenance.license),
          routes: [routeOf(sourceId, sourceItems)],
          hasCheckpoint,
          contentChanged: deltaPlan ? statuses.some((st) => st !== 'UNCHANGED') : null,
          // The parser's measured record on this source under the current parser version, never this pass's own result.
          priorParserRuns: history?.runs ?? 0,
          priorParserSuccesses: history?.successes ?? 0,
          establishedEntityMappings,
          // One name on several records must be told apart or joined before anything is matched.
          identityCollisionsSuspected: names.some((key) => (recordsByName.get(key) ?? 0) > 1),
          timeSeries: sourceItems.some((item) => !!item.publishedAt),
        },
        {
          questionId: `feed-extraction:${sourceId}`,
          decision: 'which stored records reach research through the shortlist',
          // What this source's records last put at stake; with no history, the unit value, never a favourable guess.
          decisionValue: history?.decisionValue ?? 1,
          uncertainty: history && history.runs > 0 ? 1 - history.successes / history.runs : 1,
          needsReconstruction: history ? history.reconstructs : (feed?.acquisition?.factKinds.length ?? 0) > 0,
          needsRelationships: names.some((key) => (sourcesByName.get(key)?.size ?? 0) > 1),
          novel: !hasCheckpoint,
        },
        { llmIdleShare: capacity > 0 ? 1 : 0 },
      );
    }),
  );
  const planOf = new Map((plans ?? []).map((p) => [p.sourceId, p]));
  /** The stage as the source's plan runs it; UNPLANNED when the planner failed; null when the plan leaves it out. */
  const planned = (sourceId: string, name: Stage): PlannedStage | 'UNPLANNED' | null => {
    if (!plans) return 'UNPLANNED';
    const plan = planOf.get(sourceId);
    return plan ? plannedStage(plan, name) : null;
  };
  const executorOf = (sourceId: string, name: Stage): Executor | null => {
    const one = planned(sourceId, name);
    return one === null ? null : one === 'UNPLANNED' ? 'CODE' : one.executor;
  };
  const stagesRun: StageRun[] = [];
  const ran = (sourceId: string, name: Stage, count: number) => {
    if (count === 0) return;
    const executor = executorOf(sourceId, name) ?? 'CODE';
    const plan = planOf.get(sourceId);
    stagesRun.push({ sourceId, stage: name, executor, records: count, planned: !!plan });
  };
  const countBy = (list: readonly ExtractableItem[]) => {
    const counts = new Map<string, number>();
    for (const item of list) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
    return counts;
  };
  for (const plan of plans ?? []) {
    if (plan.status === 'UNCHANGED') ran(plan.sourceId, 'CHANGE_DATA_CAPTURE', bySource.get(plan.sourceId)!.length);
  }

  // Parse and normalize only the records whose source's plan runs that stage; the rest are not read.
  const readItems = deltaItems.filter((item) => planned(item.source, 'PARSE_NORMALIZE') !== null);
  for (const [sourceId, count] of countBy(readItems)) {
    if (planned(sourceId, 'CHANGE_DATA_CAPTURE') !== null && plans) ran(sourceId, 'CHANGE_DATA_CAPTURE', count);
    ran(sourceId, 'PARSE_NORMALIZE', count);
    // Code extraction reconciles every fact against the others and keeps its exact span: the next two stages.
    ran(sourceId, 'CONTRADICTION_FRESHNESS', count);
    ran(sourceId, 'EVIDENCE_ATTACHMENT', count);
  }
  // Recompute the affected keys against stored observations, not only against what was read now: the
  // records this pass did not re-read (unchanged, already read by this parser) — in this batch, and from
  // earlier passes through the index — are reloaded for exactly the keys being recomputed, so a changed
  // record is contested against an unchanged one, and a key a changed record stopped stating is
  // re-derived from the observations that remain. Nothing else is reloaded.
  let stored: ExtractableItem[] = [];
  const recomputing = new Set([...(deltaPlan?.affectedFactKeys ?? []), ...readItems.flatMap((item) => extractItem(item)).map((f) => f.key)]);
  if (deltaPlan && toRead && recomputing.size > 0) {
    try {
      if (input.failStages?.includes('storedObservations')) throw new Error('stage storedObservations failed on request');
      stored = await storedObservationsFor({ items, identityOfItem, toRead, priorIndex, keys: recomputing });
    } catch (error) {
      stageFailures.push({ stage: 'storedObservations', error: errorText(error) });
    }
  }
  const run = extractItems(readItems, now, { items: stored, affectedKeys: deltaPlan?.affectedFactKeys ?? [] });
  // Structure feeds Connect: what was just read goes into the event graph that construction reads,
  // under the ids the graph's own sync gives these rows, so neither path makes a second fact. Only
  // records whose plan detects events are handed over; the graph's own sync still reads every row.
  const eventItems = readItems.filter((item) => planned(item.source, 'EVENT_DETECTION') !== null);
  let graph: ExtractedItemsUpdate | null = null;
  // Per record, the neighborhoods its own facts recomputed: what the delta index carries as that
  // record's dependents, so a record never carries the batch's whole set.
  const dependentsOfItem = new Map<string, string[]>();
  try {
    if (eventItems.length > 0) {
      // One record at a time, in order: the graph takes the same facts in the same order as one batch call.
      const affected = new Set<string>();
      let facts = 0;
      let added = 0;
      for (const item of eventItems) {
        const one = addExtractedItems([item]);
        facts += one.facts;
        added += one.added;
        dependentsOfItem.set(item.id, one.affected);
        for (const hood of one.affected) affected.add(hood);
      }
      graph = { facts, added, affected: [...affected].sort() };
    }
    if (graph) for (const [sourceId, count] of countBy(eventItems)) ran(sourceId, 'EVENT_DETECTION', count);
  } catch (error) {
    console.warn(`[feeds] extraction pass could not reach the event graph: ${String((error as Error)?.message ?? error)}`);
  }
  // The cursor moves over the rows intake brought; a pass that only re-read records stays where it was.
  const lastRow = rows[rows.length - 1];
  const cursorTo = lastRow ? { fetchedAt: lastRow.fetched_at, id: lastRow.id } : (from ?? { fetchedAt: floor, id: '' });
  const unreadable = new Set(run.needsModel.flat().map((one) => one.id));
  // A record the code parser could not read goes to the model only when its source's plan gives parsing to
  // the model (no tested parser for content that needs interpreting). Under a tested parser of structured
  // content, an unreadable record carries no signal the model would add, and it is held, not spent on.
  const needsModel = run.needsModel
    .map((batch) => batch.filter((one) => executorOf(one.source, 'PARSE_NORMALIZE') === 'LLM').map((one) => one.id))
    .filter((batch) => batch.length > 0);
  const toModel = new Set(needsModel.flat());
  const factsByItem = new Map<string, ExtractedFact[]>();
  for (const f of run.facts) factsByItem.set(f.evidence.itemId, [...(factsByItem.get(f.evidence.itemId) ?? []), f]);

  // Identity: the named entities of records whose plan identifies entities, linked only when an attribute
  // corroborates it; collisions are kept apart.
  const identityRecords: IdentityRecord[] = readItems
    .filter((item) => (item.organization ?? '').trim() !== '' && planned(item.source, 'ENTITY_IDENTIFICATION') !== null)
    .map((item) => {
      const place = (factsByItem.get(item.id) ?? []).map((f) => f.scope.jurisdiction).find((j): j is string => !!j) ?? null;
      return { ref: item.id, source: item.source, kind: 'ENTITY' as const, name: item.organization!, location: place };
    });
  const established: Record<string, string> = {};
  for (const r of identityRecords) {
    const held = priorIndex.entityMappings[identityOfItem.get(r.ref)!];
    if (held) established[r.ref] = held.entityId;
  }
  const resolution = stage('identity', null as ReturnType<typeof resolveIdentities> | null, () => resolveIdentities({ records: identityRecords, established }));
  if (resolution) for (const [sourceId, count] of countBy(readItems.filter((item) => identityRecords.some((r) => r.ref === item.id)))) ran(sourceId, 'ENTITY_IDENTIFICATION', count);
  const sourceOfItem = new Map(readItems.map((item) => [item.id, item.source]));
  // A cross-source link is a relationship update only for a source whose plan extracts relationships.
  const relationshipLinks = (resolution?.links ?? []).filter(
    (l) => l.sources.length > 1 && l.refs.some((ref) => planned(sourceOfItem.get(ref) ?? '', 'RELATIONSHIP_EXTRACTION') !== null),
  );
  for (const [sourceId, count] of countBy(readItems.filter((item) => relationshipLinks.some((l) => l.refs.includes(item.id))))) ran(sourceId, 'RELATIONSHIP_EXTRACTION', count);

  // Selective deepening: what the plans gave the model — unreadable records under a model parse, identity
  // the plan judged ambiguous, relationships the plan judged consequential — and contested keys, promoted
  // by value of information within measured capacity.
  const noveltyOf = (itemId: string) => {
    const status = statusOfIdentity.get(identityOfItem.get(itemId) ?? '');
    return status === 'NEW' ? 1 : status === 'CHANGED' ? 0.5 : status === 'REPARSE' ? 0.25 : 0;
  };
  const llmFor = (refs: readonly string[], name: Stage) => refs.some((ref) => executorOf(sourceOfItem.get(ref) ?? '', name) === 'LLM');
  const candidates: DeepeningCandidate[] = [
    ...readItems.filter((item) => toModel.has(item.id)).map((item) => ({ id: `item:${item.id}`, decisionValue: 1, uncertainty: 1, novelty: noveltyOf(item.id) })),
    ...(resolution?.collisions ?? [])
      .filter((c) => llmFor(c.refs, 'ENTITY_IDENTIFICATION'))
      .map((c) => ({ id: `entity:${c.refs.join('+')}`, decisionValue: 1, uncertainty: 0.5, novelty: Math.max(...c.refs.map(noveltyOf)), contradicted: true })),
    ...relationshipLinks
      .filter((l) => llmFor(l.refs, 'RELATIONSHIP_EXTRACTION'))
      .map((l) => ({ id: `link:${l.entityId}`, decisionValue: statedValue(l.refs.flatMap((id) => factsByItem.get(id) ?? [])), uncertainty: 0.5, novelty: Math.max(0, ...l.refs.map(noveltyOf)) })),
    ...run.reconciled
      .filter((r) => r.status === 'CONTESTED')
      .map((r) => {
        const ids = [...new Set(r.observations.map((o) => o.evidence.itemId))];
        return {
          id: `key:${r.key}`,
          decisionValue: statedValue(ids.flatMap((id) => factsByItem.get(id) ?? [])),
          uncertainty: 0.5,
          novelty: Math.max(0, ...ids.map(noveltyOf)),
          contradicted: true,
        };
      }),
  ];
  const deepened = stage('deepening', null as ReturnType<typeof selectForDeepening> | null, () => selectForDeepening(candidates, { capacity }));
  // What deepening promoted beyond the unreadable records goes to costly verification: each promoted
  // contested key, entity collision and cross-source link becomes a question the next shortlist round
  // puts to research, with the records it rests on. The question is built from code's own structure
  // (the fact's field, the attribute that kept two names apart, the sources) and the records' URLs,
  // never from a record's words.
  const urlOfItem = new Map([...stored, ...readItems].map((item) => [item.id, item.url]));
  const refsOfCandidate = new Map<string, { refs: string[]; condition: string; question: string }>();
  for (const c of resolution?.collisions ?? []) {
    refsOfCandidate.set(`entity:${c.refs.join('+')}`, {
      refs: [...c.refs],
      condition: `two records carry the same name but differ on ${c.attribute}`,
      question: `Two records carry the same organization name but differ on ${c.attribute}. Open both pages and report whether they are one organization or two, quoting what decides it.`,
    });
  }
  for (const l of relationshipLinks) {
    refsOfCandidate.set(`link:${l.entityId}`, {
      refs: [...l.refs],
      condition: `records from ${l.sources.length} sources were linked as one entity`,
      question: `Records from ${l.sources.length} different sources were linked as one organization. Open each page and confirm or refute that they describe the same organization, quoting the page.`,
    });
  }
  for (const r of run.reconciled) {
    if (r.status !== 'CONTESTED') continue;
    const field = r.observations[0]?.field ?? 'value';
    refsOfCandidate.set(`key:${r.key}`, {
      refs: [...new Set(r.observations.map((o) => o.evidence.itemId))],
      condition: `records state different values for one ${field}`,
      question: `Records state different values for the same ${field}. Open each page and report which value the page itself states, quoting it, or say that it cannot be settled.`,
    });
  }
  const deepeningQuestions: MissingLinkQuestion[] = (deepened?.decisions ?? [])
    .filter((d) => d.promote && refsOfCandidate.has(d.id))
    .map((d) => {
      const one = refsOfCandidate.get(d.id)!;
      return {
        key: `deepen:${d.id}`,
        neighborhood: d.id,
        condition: one.condition,
        question: one.question,
        constructionKeys: [],
        structures: [],
        evidenceUrls: [...new Set(one.refs.map((ref) => urlOfItem.get(ref)).filter((u): u is string => !!u))],
        value: d.score,
      };
    })
    // One question per candidate: the same pair can be found as a collision more than once.
    .filter((q, i, all) => all.findIndex((other) => other.key === q.key) === i)
    .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // The parser's record on each source, carried to the next pass's plan: what it read, what it could read,
  // and what the records put at stake.
  const parserHistory: ParserHistory = { ...priorHistory };
  for (const [sourceId, count] of countBy(readItems)) {
    const read = readItems.filter((item) => item.source === sourceId);
    const facts = read.flatMap((item) => factsByItem.get(item.id) ?? []);
    const before = priorHistory[sourceId];
    parserHistory[sourceId] = {
      runs: (before?.runs ?? 0) + count,
      successes: (before?.successes ?? 0) + read.filter((item) => !unreadable.has(item.id)).length,
      decisionValue: statedValue(facts),
      reconstructs: facts.some((f) => f.measureKind !== null),
    };
  }

  // Commit what was read to the index the next pass classifies against.
  const readings: RecordReading[] = readItems.map((item) => {
    const facts = factsByItem.get(item.id) ?? [];
    const entityId = resolution?.mappings[item.id];
    const identity = identityOfItem.get(item.id)!;
    return {
      identity,
      parserVersion: EXTRACTOR_VERSION,
      factKeys: facts.map((f) => f.key),
      entities: entityId ? [entityId] : [],
      dependents: dependentsOfItem.get(item.id) ?? [],
      entityMappings: entityId ? { [identity]: entityId } : {},
    };
  });
  const nextIndex = deltaPlan ? stage<DeltaIndex | null>('deltaCommit', null, () => commitReadings(deltaPlan.index, readings, nowIsoText)) : null;
  const readWith = (status: DeltaStatus) => readItems.filter((item) => statusOfIdentity.get(identityOfItem.get(item.id)!) === status).map((item) => item.id);
  const delta: ExtractionDelta | undefined = deltaPlan
    ? {
        parserVersion: EXTRACTOR_VERSION,
        counts: deltaPlan.counts,
        newItems: readWith('NEW'),
        changedItems: readWith('CHANGED'),
        unchangedItems: items.filter((item) => !readItems.includes(item)).map((item) => item.id),
        reparsedItems: readWith('REPARSE'),
        recomputedKeys: [...new Set([...deltaPlan.affectedFactKeys, ...run.reconciled.map((r) => r.key)])].sort(),
        reconciledAgainst: [...new Set(run.reconciled.flatMap((r) => r.observations.map((o) => o.evidence.itemId)))].filter((id) => stored.some((item) => item.id === id)).sort(),
        affectedEntities: deltaPlan.affectedEntities,
      }
    : undefined;

  // Evidence accepted and goal-impacting decisions are read from their own rows, recorded since the previous
  // pass: a screen's verdict or a detector's coverage, and a shortlist round taking a record into research.
  const sinceFunnel = priorPassAt ?? floor;
  let downstream: { evidence: FunnelRecord[]; decisions: FunnelRecord[] } | null = null;
  try {
    if (input.failStages?.includes('funnelRecords')) throw new Error('stage funnelRecords failed on request');
    downstream = await downstreamFunnelRecords(sinceFunnel, nowIsoText);
  } catch (error) {
    stageFailures.push({ stage: 'funnelRecords', error: errorText(error) });
  }

  // The funnel: raw intake beside what this pass actually understood.
  const funnel = stage('funnel', undefined as ExtractionPass['funnel'], () => {
    const fingerprintOfItem = new Map((deltaPlan?.changes ?? []).map((c) => [c.identity, c.fingerprint]));
    const itemRecord = (item: ExtractableItem): FunnelRecord => ({ id: item.id, fingerprint: fingerprintOfItem.get(identityOfItem.get(item.id)!) ?? item.id, observedAt: item.publishedAt });
    const reconciledStatus = new Map(run.reconciled.map((r) => [r.key, r.status]));
    const reading = readFunnel(
      {
        RAW_INTAKE: items.map(itemRecord),
        PARSED: readItems.filter((item) => !unreadable.has(item.id)).map(itemRecord),
        NORMALIZED_FACTS: run.facts.map((f) => ({
          id: `${f.evidence.itemId}:${f.key}`,
          fingerprint: `${f.key}=${String(f.value)}@${f.evidence.itemId}`,
          observedAt: f.observedAt,
          status: (reconciledStatus.get(f.key) ?? null) as FunnelRecord['status'],
        })),
        EVIDENCE_ACCEPTED: downstream?.evidence ?? [],
        RELATIONSHIPS_UPDATED: relationshipLinks.map((l) => ({ id: l.entityId, fingerprint: `${l.entityId}:${l.refs.join(',')}` })),
        GOAL_DECISIONS: downstream?.decisions ?? [],
      },
      { now },
    );
    // Gain is measured against the reading the previous pass ended at, never against nothing.
    const cumulative = addFunnelReadings(priorFunnel, reading);
    return { reading, cumulative, since: sinceFunnel, gain: funnelGain(priorFunnel, cumulative) };
  });

  const pass: ExtractionPass = {
    cursor: { from, to: cursorTo },
    items: items.length,
    readable: readItems.length - unreadable.size,
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
    processingGraph: plans ?? [],
    stagesRun,
    ...(delta ? { delta } : {}),
    identity: resolution ? { links: resolution.links, collisions: resolution.collisions, uncorroborated: resolution.uncorroborated.length } : { links: [], collisions: [], uncorroborated: 0 },
    deepening: deepened
      ? {
          capacity,
          threshold: deepened.threshold,
          promoted: deepened.decisions.filter((d) => d.promote),
          held: deepened.decisions.filter((d) => !d.promote),
          questions: deepeningQuestions,
        }
      : { capacity, threshold: null, promoted: [], held: [], questions: [] },
    ...(funnel ? { funnel } : {}),
    stageFailures,
    // Only this pass's slice: the records it saw, at their latest version. When the commit failed nothing new
    // is written, and the earlier slices still within the lookback carry the index.
    deltaIndex: nextIndex ? sliceOf(nextIndex, (deltaPlan?.changes ?? []).map((c) => c.identity)) : emptyDeltaIndex(),
    parserHistory: { parserVersion: EXTRACTOR_VERSION, sources: parserHistory },
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
      `${unreadable.size} the parser could not read, ${needsModel.flat().length} of them given to the model by their source's processing graph, in ${needsModel.length} batch(es) of up to ${MODEL_BATCH_SIZE}: ` +
      'the free-model screen takes those first, one call per batch and model for every batch of two or more, ' +
      'and asks record by record only about what a batch answer left unanswered. ' +
      `${pass.demand.statedRequest} fact(s) from a record stating a request; none is a confirmed buyer. ` +
      (graph
        ? `${graph.facts} graph fact(s) handed to the event graph, ${graph.added} new, ${graph.affected.length} neighborhood(s) recomputed; every hypothesis is still only a hypothesis.`
        : 'The event graph could not take them this pass; its own sync reads the same rows.') +
      (delta ? ` Delta: ${delta.counts.NEW} new, ${delta.counts.CHANGED} changed, ${delta.counts.REPARSE} re-parsed, ${delta.unchangedItems.length} unchanged and not re-read; ${delta.recomputedKeys.length} fact key(s) recomputed.` : '') +
      ` Identity: ${pass.identity!.links.length} link(s), ${pass.identity!.collisions.length} collision(s) kept apart.` +
      ` Deepening: ${pass.deepening!.promoted.length} promoted, ${pass.deepening!.held.length} held at capacity ${capacity}; ` +
      `${deepeningQuestions.length} contested fact(s), identity collision(s) or cross-source link(s) queued for verification in the next shortlist round.` +
      (funnel ? ` Usable intelligence gained: ${funnel.gain.usableIntelligence} from ${funnel.reading.stages[0]!.raw} raw record(s)${funnel.gain.falseSpeed ? ' (raw intake without usable gain)' : ''}.` : '') +
      (stageFailures.length > 0 ? ` Stage(s) failed and named: ${stageFailures.map((f) => f.stage).join(', ')}.` : ''),
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

/** Records whose words would narrow a round or read as Brain's own action are kept out of a question. */
function safeQuestion(q: MissingLinkQuestion): boolean {
  const rendered = `- verify: ${q.question} Start from: ${q.evidenceUrls.join(', ')}.`;
  if (statesNamedIn(rendered).length > 0) return false;
  return Object.values(APPROVAL_ENVELOPES).every((envelope) => !describesOwnAction(rendered, envelope.forbiddenActions));
}

/**
 * The verification questions selective deepening promoted in the recent
 * extraction passes (KNOW-25-1, S-0358) that no round has taken recently,
 * highest value of information first. Read from the `FEED_EXTRACTION` rows'
 * `deepening.questions` and the `FEED_LOOP_QUESTIONS_ASKED` rows the shortlist
 * wrote, so a promotion is consumed once and an unsettled one may be asked
 * again after `LOOP_QUESTION_REASK_MS`. Writes nothing.
 */
export async function pendingDeepeningQuestions(projectId: string, now: Date = new Date(), limit: number = LOOP_QUESTIONS_PER_ROUND): Promise<MissingLinkQuestion[]> {
  const db = getDb();
  const passes = await db.all<{ detail: string | null }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [projectId, EXTRACTION_EVENT, DELTA_LOOKBACK_PASSES],
  );
  const byKey = new Map<string, MissingLinkQuestion>();
  for (const row of passes) {
    try {
      const questions = (JSON.parse(row.detail ?? '{}') as { deepening?: { questions?: unknown } }).deepening?.questions;
      if (!Array.isArray(questions)) continue;
      for (const q of questions as MissingLinkQuestion[]) {
        if (!q || typeof q.key !== 'string' || typeof q.question !== 'string' || !Array.isArray(q.evidenceUrls) || typeof q.value !== 'number') continue;
        // Newest pass first: a key promoted again keeps its newest reading.
        if (!byKey.has(q.key)) byKey.set(q.key, q);
      }
    } catch {
      // An unreadable row promotes nothing.
    }
  }
  if (byKey.size === 0) return [];
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
  return [...byKey.values()]
    .filter((q) => !taken.has(q.key) && safeQuestion(q))
    .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, Math.max(0, limit));
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
 * How the free-model screen routes a pass's records (KNOW-25-1, S-0358). The
 * model is the escalation for what code cannot read, and an unreadable record
 * reaches it only when selective deepening promotes it: each one is a
 * deepening candidate scored by value of information, and `selectForDeepening`
 * admits the highest-scoring within `capacity` — the reads the model lane can
 * afford this pass (`lanePacing`), the same number the pass is cut to. A held
 * record is not sent to a model this pass and is not marked either: it stays
 * unscreened, so the next pass judges it again against that pass's capacity.
 *
 * Its value is the money its facts state (`statedValue`, 1 when none) times
 * the share of its lead window still left to act in: a lead whose window has
 * passed is worth no read, however many of them arrive. Code could not read it,
 * so its uncertainty is whole, and nothing Brain holds understands it, so it is
 * wholly novel. Wording never enters (§18.1).
 *
 * Readable records still need the lead judgement the shortlist gate asks for,
 * so they follow the promoted ones; they are not deepening, since code already
 * read them. Pure.
 */
export interface EscalationRoute<T> {
  /** Unreadable records the deepening selection promoted, highest score first. */
  promoted: T[];
  /** Unreadable records it held, with the decision that held each. */
  held: { item: T; decision: DeepeningDecision }[];
  /** Records code could read. */
  readable: T[];
  deepening: DeepeningResult;
}

export function routeEscalation<T extends ExtractableItem>(items: readonly T[], now: Date, capacity: number): EscalationRoute<T> {
  const run = extractItems(items, now);
  const unreadable = new Set(run.needsModel.flat().map((one) => one.id));
  const factsByItem = new Map<string, ExtractedFact[]>();
  for (const f of run.facts) factsByItem.set(f.evidence.itemId, [...(factsByItem.get(f.evidence.itemId) ?? []), f]);
  const candidates: DeepeningCandidate[] = items
    .filter((one) => unreadable.has(one.id))
    .map((one) => {
      const published = Date.parse(one.publishedAt ?? one.fetchedAt);
      const left = Number.isFinite(published) ? Math.min(1, Math.max(0, 1 - (now.getTime() - published) / LEAD_MAX_AGE_MS)) : 1;
      return { id: one.id, decisionValue: statedValue(factsByItem.get(one.id) ?? []) * left, uncertainty: 1, novelty: 1 };
    });
  const deepening = selectForDeepening(candidates, { capacity });
  const byId = new Map(items.map((one) => [one.id, one]));
  const promotedDecisions = deepening.decisions
    .map((decision, index) => ({ decision, index }))
    .filter((one) => one.decision.promote)
    .sort((a, b) => b.decision.score - a.decision.score || a.index - b.index);
  return {
    promoted: promotedDecisions.map((one) => byId.get(one.decision.id)!),
    held: deepening.decisions.filter((d) => !d.promote).map((decision) => ({ item: byId.get(decision.id)!, decision })),
    readable: items.filter((one) => !unreadable.has(one.id)),
    deepening,
  };
}

/**
 * The order the free-model screen takes items in: the unreadable records
 * selective deepening promotes (`routeEscalation`), highest value of
 * information first, then the records code could read. A held unreadable
 * record is left out — it waits for a pass with capacity for it. With the
 * default capacity (every record) nothing is held. Pure.
 */
export function screenOrder<T extends ExtractableItem>(items: readonly T[], now: Date, capacity: number = items.length): T[] {
  const route = routeEscalation(items, now, capacity);
  return [...route.promoted, ...route.readable];
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
 * Unreadable records reach a model only when selective deepening promotes
 * them within the pass's capacity (`screenOrder`, `routeEscalation`).
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
  // Selective deepening routes the model reads: an unreadable record is escalated only when its
  // value of information earns one of the reads this pass can afford; a held one waits unscreened.
  const todo = screenOrder(planScreens(todoAll, settled, now).ask, now, pace.perPass).slice(0, pace.perPass);
  // Escalation in batches: what the parser could not read, and deepening promoted, is asked about together.
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
  // What selective deepening promoted in the extraction passes (contested facts, identity collisions,
  // cross-source links) is verified in the same round: the costly read deepening selected them for.
  const verify = await pendingDeepeningQuestions(input.projectId, now).catch((error: unknown) => {
    console.warn(`[feeds] deepening questions unreadable for ${input.projectId}: ${String((error as Error)?.message ?? error)}`);
    return [] as MissingLinkQuestion[];
  });
  if (chosen.length === 0 && questions.length === 0 && verify.length === 0) return null;

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
    verify.length
      ? '\nCode found these records disagreeing or linked across sources, and judged settling them worth a read. ' +
        'Settle each from the pages themselves, quoting them; one that cannot be settled is reported as unsettled.'
      : '',
    ...verify.map((q) => `\n- verify: ${q.question}${q.evidenceUrls.length ? ` Start from: ${q.evidenceUrls.join(', ')}.` : ''}`),
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
  if (questions.length || verify.length) {
    const asked = [...questions, ...verify];
    await recordCashEvent({
      projectId: input.projectId,
      kind: LOOP_QUESTIONS_ASKED_EVENT,
      actorRef: 'BRAIN',
      summary:
        `Feed loop: ${questions.length} derived missing-link question(s) and ${verify.length} deepening verification question(s) put to research in shortlist round ${roundNo}; ` +
        'each stays open until a quoted source answers it.',
      detail: {
        roundId: round.id,
        candidateId: round.candidateId,
        keys: asked.map((q) => q.key),
        questions: asked.map((q) => ({ key: q.key, neighborhood: q.neighborhood, condition: q.condition, constructionKeys: q.constructionKeys, value: q.value })),
        deepening: verify.map((q) => q.key),
      },
    });
  }
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'CASH_DISCOVERY_OPENED',
    actorRef: 'BRAIN',
    summary: `Feed shortlist opened: ${chosen.length} lead(s) for Claude to verify${questions.length ? ` and ${questions.length} missing-link question(s) to answer` : ''}${verify.length ? `, ${verify.length} deepening question(s) to settle` : ''} (round ${roundNo}).`,
    detail: {
      bucketId: FEED_SHORTLIST_BUCKET.id,
      candidateId: round.candidateId,
      cashModeId: mode.id,
      round: roundNo,
      leads: chosen.map(({ item }) => item.id),
      questions: questions.map((q) => q.key),
      deepening: verify.map((q) => q.key),
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
