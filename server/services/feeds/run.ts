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
import { isDown, laneConfig, modelHealth, screenLead, type Completer, type LaneConfig, type LeadOutput } from '../cheap/lane.ts';
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
import { extractItem, extractItems, type ExtractableItem, type ExtractedFact } from './extract.ts';
import { addExtractedItems, currentEventGraph, syncEventGraph, type ExtractedItemsUpdate, type GraphHypothesis } from '../industry/eventGraph.ts';
import { constructFromGraph, type MissingLinkQuestion } from '../cash/construct.ts';
import type { Weakness } from '../../domain/improvement.ts';

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
}

/**
 * Pull every due source once. A source that takes a start date is asked only
 * for what was published since its own last success (`pullUrl`); every item is
 * stored once, by its source key, so a repeat costs no storage and no screen.
 */
export async function pullDueFeeds(input: {
  now?: Date;
  fetcher?: Fetcher;
  sources?: readonly FeedSource[];
} = {}): Promise<FeedPullResult[]> {
  const now = input.now ?? new Date();
  const out: FeedPullResult[] = [];
  for (const source of input.sources ?? FEED_SOURCES) {
    const state = await pullState(source.id);
    if (now.getTime() < nextPullAt(source, state)) continue;
    if (source.spacingMs && out.length > 0 && !input.fetcher) {
      await new Promise((resolve) => setTimeout(resolve, source.spacingMs));
    }
    const ask = pullUrl(source, state.lastSuccessAt);
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
 *   * screenCalls — the SCREEN_LEAD model calls actually made, and the
 *     distinct items they were about;
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
  const calls = await db.get<{ n: number | string; items: number | string }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT subject_id) AS items FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND created_at >= ? AND created_at < ?`,
    [input.since, until],
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
    screenCalls: Number(calls?.n ?? 0),
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
  /** Item ids the parser could not read, in the batches the free-model screen takes first. */
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
      `${needsModel.flat().length} in ${needsModel.length} batch(es) sent to the free-model screen first. ` +
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
 * Pure.
 */
export function screenOrder<T extends ExtractableItem>(items: readonly T[], now: Date): T[] {
  const unreadable = new Set(extractItems(items, now).needsModel.flat().map((one) => one.id));
  return [...items.filter((one) => unreadable.has(one.id)), ...items.filter((one) => !unreadable.has(one.id))];
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
