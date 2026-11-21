/**
 * Resource-aware acquisition measurement (CAP-21-7), extending the feed owner.
 *
 * Per source and window it measures what acquisition actually produced — records
 * visited, new unique useful documents, refreshed records, parser coverage,
 * structured facts, code-derived matches, AI jobs avoided and escalated, AI
 * calls per useful finding, failure and recovery, provider saturation — and
 * raw bytes of the records acquired, accepted evidence, verified
 * buyer/price/fulfillment links, time to goal impact, dollars per useful
 * finding and revenue. The last six are attributed to the source through the
 * rows that already carry the chain: a feed item's URL is the `source_url` of
 * the research claims read from it, an accepted claim is the `claim_id` of a
 * monetization path's evidence fact and the `source_claim_id` of an opening,
 * an opening is the `opportunity_id` of the money entries it earned, and a
 * blueprint fact names its `source_url` (`attributePage`). A figure the
 * window's rows do not settle — no item shortlisted, a pod hour RunPod
 * returned no price for — says `NOT_MEASURED` with that reason, never a guess
 * (inv. 33, inv. 39). Attribution is read a page at a time like everything
 * else here, so no window is held in memory.
 *
 * From those readings and the free lane's recorded stage capacity
 * (`stageCapacity.ts`) it names which resource class is constrained —
 * ingestion workers, bulk processing, object storage, database/indexes,
 * browser workers, LLM workers or GPU — and recommends increasing only that
 * one, only when a measured marginal gain says more of it would produce more.
 * A provider outage or failed authorization is a repair, never more CPU; the
 * application server is not a resource class here at all.
 *
 * Work is shared between active goal demand, open-world exploration,
 * capability building and future planning by the research allocation already
 * in force (the goals tick decides it, the free lane's claim order applies it),
 * reported here per lane beside each lane's own measured yield per job, with
 * no owner-set quota.
 *
 * Nothing here schedules, queues or stores anything new: it reads `feed_pulls`,
 * `feed_items`, `feed_item_coverage`, `cheap_results`, `research_claims`,
 * `monetization_path_facts`, `cash_opportunities`, `cash_money_entries`,
 * `construction_facts` and `bin_events`, and
 * writes one `ACQUISITION_MEASURES` bin event per window. Sources are whatever
 * the rows and `FEED_SOURCES` name; no source, category or industry is a list
 * of what is allowed.
 */
import { getDb } from '../../db/database.ts';
import { isRunpodSlot } from '../cheap/runpod.ts';
import { readPodSpend, type PodSpend } from '../cheap/runpodPod.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { boundMeasures, readStageCapacity, type Measured, type RecordedStageCapacity } from '../freeLane/stageCapacity.ts';
import type { RouteFailureCause } from '../freeLane/worker.ts';
import { RESEARCH_PURPOSES, type ResearchPurpose, type SharesInForce } from '../goals/researchAllocation.ts';
import { CODE_SIGNAL_SOURCE, coveredItems } from './detectors.ts';
import { extractItem } from './extract.ts';
import { CONNECTOR_HEALTH_EVENT, type ConnectorState } from './health.ts';
import { BATCH_ROW_PREFIX, SOURCE_YIELD_WINDOW_MS } from './run.ts';
import { SITE_SOURCE } from './sites.ts';
import { FEED_SOURCES, type FeedSource } from './sources.ts';

/** The bin event one window's acquisition measures are recorded under. */
export const ACQUISITION_MEASURES_EVENT = 'ACQUISITION_MEASURES';
/** One reading per window, back to back, as the yield reading is. */
export const ACQUISITION_MEASURES_WINDOW_MS = SOURCE_YIELD_WINDOW_MS;
/** Rows read per page; nothing here reads a window in one statement. */
const PAGE = 500;

const measured = <T>(value: T): Measured<T> => ({ measured: true, value });
const notMeasured = <T>(reason: string): Measured<T> => ({ measured: false, reason });
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

// ---------------------------------------------------------------------------
// Per-source measures
// ---------------------------------------------------------------------------

/**
 * Why an attributed measure is not measured in a particular window. Each is a
 * fact about that window's rows, never a property of the code: with the rows
 * present, every one of these measures is a number.
 */
export const UNMEASURED_REASONS = {
  timeToGoalImpact: 'no record the source stored in the window has reached a shortlist yet, so there is no publication-to-goal time to read',
  dollarsUnpriced: 'the window ran screens on the GPU pod while RunPod returned no price for some of its running time, so the dollar cost is not known',
  dollarsNoUseful: 'nothing the source stored in the window was useful, so there is no finding to divide the cost by',
  attributionUnreadable: 'the attribution rows (research claims, path facts, openings, money entries) could not be read',
} as const;

/** UTF-8 bytes of one acquired record as stored: what the source delivered for it. Pure. */
export function recordBytes(record: { externalId?: string | null; url: string; title: string; body: string | null; organization: string | null; publishedAt?: string | null }): number {
  let total = 0;
  for (const part of [record.externalId, record.url, record.title, record.body, record.organization, record.publishedAt]) {
    if (part) total += Buffer.byteLength(part, 'utf8');
  }
  return total;
}

/** The median of a list, or null when it is empty. Pure. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One feed item, as attribution reads it. */
export interface AttributedItem {
  id: string;
  source: string;
  url: string;
  publishedAt: string | null;
  fetchedAt: string;
  shortlistedAt: string | null;
  bytes: number;
}

/** What the rows say a source's records led to downstream. */
export interface SourceAttribution {
  source: string;
  /** Bytes of the records the source stored in the window. */
  bytes: number;
  /** Research claims read from the source's records that the gate accepted. */
  acceptedEvidence: number;
  /** Path evidence facts resting on those claims, plus openings from them with a named payer, a price and a fulfillment route. */
  verifiedLinks: number;
  /** Distinct monetization paths and openings the source's accepted claims support. */
  economicRelationships: number;
  /** Claims from the source's records a contradiction check challenged, refuted or reconciled. */
  correctedContradictions: number;
  /** Distinct blueprint variables (`construction_facts.fact_key`) the source's records resolved. */
  variablesResolved: number;
  /** Minutes from each record's publication to its shortlist. */
  minutesToGoalImpact: number[];
  /** Minutes from each record's publication to the first blueprint fact citing it. */
  minutesToPlan: number[];
  /** Verified customer payments, net of refunds, on openings the source's accepted claims started (cents). */
  revenueCents: number;
}

/** Openings with these three settled are a verified buyer, price and fulfillment link. Pure. */
export function isVerifiedLink(opening: { payer: string | null; price_cents: number | string | null; fulfillment_owner: string | null; delivery_method: string | null }): boolean {
  return Boolean(opening.payer && opening.price_cents !== null && Number(opening.price_cents) > 0 && (opening.fulfillment_owner || opening.delivery_method));
}

const minutesBetween = (from: string, to: string): number | null => {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 60_000) : null;
};

async function chunked<T>(ids: readonly string[], read: (chunk: string[], marks: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let at = 0; at < ids.length; at += PAGE) {
    const chunk = ids.slice(at, at + PAGE);
    if (chunk.length === 0) continue;
    out.push(...(await read(chunk, chunk.map(() => '?').join(','))));
  }
  return out;
}

/**
 * One source's attribution while pages are still being read. Every count is a
 * set of the downstream row's key, so a claim, fact, opening or variable two
 * pages both reach is counted once.
 */
interface SourceAttributionAcc {
  bytes: number;
  accepted: Set<string>;
  corrected: Set<string>;
  links: Set<string>;
  relations: Set<string>;
  variables: Set<string>;
  minutesToGoalImpact: number[];
  /** Earliest publication, and earliest blueprint fact, per record URL. */
  planStart: Map<string, string>;
  planFact: Map<string, string>;
  revenueOpenings: Set<string>;
  revenueCents: number;
}

/** Attribution accumulated over a window's pages, by source. */
export type AttributionAccumulator = Map<string, SourceAttributionAcc>;

const blankAcc = (): SourceAttributionAcc => ({
  bytes: 0, accepted: new Set(), corrected: new Set(), links: new Set(), relations: new Set(), variables: new Set(),
  minutesToGoalImpact: [], planStart: new Map(), planFact: new Map(), revenueOpenings: new Set(), revenueCents: 0,
});

/**
 * Follow one page of a source's records downstream through the rows that
 * already carry the chain — item URL → research claim → path fact / opening →
 * money entry, and item URL → blueprint fact — into `acc`. A record nothing
 * has cited yet contributes zero, which is a measurement. Read-only.
 */
export async function attributePage(acc: AttributionAccumulator, items: readonly AttributedItem[], until: string): Promise<void> {
  const db = getDb();
  const sourcesOfUrl = new Map<string, Set<string>>();
  for (const item of items) {
    const a = acc.get(item.source) ?? blankAcc();
    acc.set(item.source, a);
    a.bytes += item.bytes;
    const start = item.publishedAt ?? item.fetchedAt;
    if (item.shortlistedAt) {
      const minutes = minutesBetween(start, item.shortlistedAt);
      if (minutes !== null) a.minutesToGoalImpact.push(minutes);
    }
    const prior = a.planStart.get(item.url);
    if (!prior || start < prior) a.planStart.set(item.url, start);
    const set = sourcesOfUrl.get(item.url) ?? new Set<string>();
    set.add(item.source);
    sourcesOfUrl.set(item.url, set);
  }
  const urls = [...sourcesOfUrl.keys()];
  if (urls.length === 0) return;

  const claims = await chunked(urls, (chunk, marks) => db.all<{ id: string; source_url: string; accepted: number | string; contradiction_state: string | null; reconciliation: string | null }>(
    `SELECT id, source_url, accepted, contradiction_state, reconciliation FROM research_claims WHERE source_url IN (${marks})`,
    chunk,
  ));
  const sourcesOfClaim = new Map<string, Set<string>>();
  for (const claim of claims) {
    const sources = sourcesOfUrl.get(claim.source_url) ?? new Set<string>();
    const corrected = (claim.contradiction_state ?? 'UNCHALLENGED') !== 'UNCHALLENGED' || Boolean(claim.reconciliation);
    const accepted = Number(claim.accepted) === 1;
    if (accepted) sourcesOfClaim.set(claim.id, sources);
    for (const source of sources) {
      const a = acc.get(source)!;
      if (corrected) a.corrected.add(claim.id);
      if (accepted) a.accepted.add(claim.id);
    }
  }
  const acceptedIds = [...sourcesOfClaim.keys()];

  const facts = await chunked(acceptedIds, (chunk, marks) => db.all<{ path_id: string; claim_id: string }>(
    `SELECT path_id, claim_id FROM monetization_path_facts WHERE kind = 'EVIDENCE' AND claim_id IN (${marks})`,
    chunk,
  ));
  for (const fact of facts) {
    for (const source of sourcesOfClaim.get(fact.claim_id) ?? []) {
      const a = acc.get(source)!;
      a.links.add(`fact:${fact.path_id}\u0000${fact.claim_id}`);
      a.relations.add(`path:${fact.path_id}`);
    }
  }
  const openings = await chunked(acceptedIds, (chunk, marks) => db.all<{ id: string; source_claim_id: string; payer: string | null; price_cents: number | string | null; fulfillment_owner: string | null; delivery_method: string | null }>(
    `SELECT id, source_claim_id, payer, price_cents, fulfillment_owner, delivery_method FROM cash_opportunities WHERE source_claim_id IN (${marks})`,
    chunk,
  ));
  // Money is read once per (source, opening): an opening an earlier page already counted is not counted again.
  const newlyEarning = new Map<string, Set<string>>();
  for (const opening of openings) {
    for (const source of sourcesOfClaim.get(opening.source_claim_id) ?? []) {
      const a = acc.get(source)!;
      if (isVerifiedLink(opening)) a.links.add(`opening:${opening.id}`);
      a.relations.add(`opening:${opening.id}`);
      if (a.revenueOpenings.has(opening.id)) continue;
      a.revenueOpenings.add(opening.id);
      const set = newlyEarning.get(opening.id) ?? new Set<string>();
      set.add(source);
      newlyEarning.set(opening.id, set);
    }
  }
  const money = await chunked([...newlyEarning.keys()], (chunk, marks) => db.all<{ opportunity_id: string; kind: string; amount_cents: number | string }>(
    `SELECT opportunity_id, kind, amount_cents FROM cash_money_entries
      WHERE opportunity_id IN (${marks}) AND occurred_at < ?
        AND ((kind = 'CUSTOMER_PAYMENT' AND verified_reference IS NOT NULL) OR kind = 'REFUND')`,
    [...chunk, until],
  ));
  for (const entry of money) {
    const signed = entry.kind === 'REFUND' ? -Number(entry.amount_cents) : Number(entry.amount_cents);
    for (const source of newlyEarning.get(entry.opportunity_id) ?? []) acc.get(source)!.revenueCents += signed;
  }

  const blueprint = await chunked(urls, (chunk, marks) => db.all<{ source_url: string; fact_key: string; status: string; created_at: string }>(
    `SELECT source_url, fact_key, status, created_at FROM construction_facts WHERE source_url IN (${marks}) AND created_at < ?`,
    [...chunk, until],
  ));
  for (const fact of blueprint) {
    for (const source of sourcesOfUrl.get(fact.source_url) ?? []) {
      const a = acc.get(source)!;
      if (fact.status === 'VERIFIED' || fact.status === 'OBSERVED') a.variables.add(fact.fact_key);
      const prior = a.planFact.get(fact.source_url);
      if (!prior || fact.created_at < prior) a.planFact.set(fact.source_url, fact.created_at);
    }
  }
}

/** The totals an accumulator holds, by source. Pure. */
export function finishAttribution(acc: AttributionAccumulator): Map<string, SourceAttribution> {
  const out = new Map<string, SourceAttribution>();
  for (const [source, a] of acc) {
    const minutesToPlan: number[] = [];
    for (const [url, factAt] of a.planFact) {
      const start = a.planStart.get(url);
      const minutes = start ? minutesBetween(start, factAt) : null;
      if (minutes !== null) minutesToPlan.push(minutes);
    }
    out.set(source, {
      source,
      bytes: a.bytes,
      acceptedEvidence: a.accepted.size,
      verifiedLinks: a.links.size,
      economicRelationships: a.relations.size,
      correctedContradictions: a.corrected.size,
      variablesResolved: a.variables.size,
      minutesToGoalImpact: a.minutesToGoalImpact,
      minutesToPlan,
      revenueCents: a.revenueCents,
    });
  }
  return out;
}

/** `attributePage` over one list of items, finished. Read-only. */
export async function readSourceAttribution(items: readonly AttributedItem[], until: string): Promise<Map<string, SourceAttribution>> {
  const acc: AttributionAccumulator = new Map();
  for (let at = 0; at < items.length; at += PAGE) await attributePage(acc, items.slice(at, at + PAGE), until);
  return finishAttribution(acc);
}

/**
 * Dollars per screen call by model over the window: the free providers are a
 * measured $0, and a GPU pod call carries an even share of the pod's billed
 * spend. Unknown (null) when the pod ran unpriced. Pure.
 */
export function dollarsPerCall(spend: Pick<PodSpend, 'dollars' | 'unpricedRunningSamples'> | null, podCalls: number): { pod: number | null } {
  if (podCalls === 0) return { pod: 0 };
  if (!spend || spend.unpricedRunningSamples > 0) return { pod: null };
  return { pod: spend.dollars / podCalls };
}

/** Pod screen calls in [since, until) and what each cost; `readSpend` is RunPod's billed spend since `since`. */
async function podPricing(
  since: string,
  until: string,
  readSpend: (since: string) => Promise<Pick<PodSpend, 'dollars' | 'unpricedRunningSamples'>>,
): Promise<{ pod: number | null }> {
  const callRows = await getDb().all<{ model: string; k: number | string }>(
    `SELECT model, COUNT(*) AS k FROM cheap_results WHERE created_at >= ? AND created_at < ? AND substr(id, 1, ${BATCH_ROW_PREFIX.length}) <> ? GROUP BY model`,
    [since, until, BATCH_ROW_PREFIX],
  );
  const podCalls = callRows.filter((r) => isRunpodSlot(r.model)).reduce((k, r) => k + Number(r.k), 0);
  return dollarsPerCall(podCalls > 0 ? await readSpend(since).catch(() => null) : null, podCalls);
}

/** Bodies of one page of items, by id: read for bytes and extraction, then dropped with the page. */
async function pageBodies(ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await getDb().all<{ id: string; body: string | null }>(
    `SELECT id, body FROM feed_items WHERE id IN (${ids.map(() => '?').join(',')})`,
    [...ids],
  );
  for (const row of rows) out.set(row.id, row.body);
  return out;
}

export interface SourceAcquisitionMeasures {
  source: string;
  /** Records the source's pulls carried (ok pulls). */
  recordsVisited: Measured<number>;
  /** Items stored in the window (unique by `(source, external_id)`). */
  newUniqueDocuments: Measured<number>;
  /** Of those, items a free-model screen kept, a code rule covered or a shortlist took. */
  newUniqueUsefulDocuments: Measured<number>;
  /** Records read again that storage already held (visited − stored). */
  refreshedRecords: Measured<number>;
  /** UTF-8 bytes of the records the source stored in the window (`recordBytes`). */
  rawBytes: Measured<number>;
  /** Share of examined items from which the deterministic extractor read at least one fact. */
  parserCoverage: Measured<number | null>;
  /** How many stored items the extractor examined (bounded by `EXTRACT_BUDGET`) of how many were stored. */
  parserSample: { examined: number; stored: number };
  /** Facts the deterministic extractor read from the window's stored items. */
  structuredFacts: Measured<number>;
  /** Research claims read from the source's stored records that the gate accepted. */
  acceptedEvidence: Measured<number>;
  /** Stored items a code detector accounted for (`feed_item_coverage`). */
  codeDerivedMatches: Measured<number>;
  /** Path evidence facts on those claims, plus openings from them with a payer, a price and a fulfillment route. */
  verifiedBuyerPriceFulfillmentLinks: Measured<number>;
  /** Stored items a shortlist round took: the commercially usable leads a transaction path starts from. */
  usableTransactionPaths: Measured<number>;
  /** Median minutes from a stored record's publication to the shortlist that took it into goal work. */
  timeToGoalImpactMinutes: Measured<number>;
  /** Records that never reached a model: repeats storage dropped plus items a code rule covered. */
  aiJobsAvoided: Measured<number>;
  /** Stored items a free-model screen was asked about. */
  aiEscalations: Measured<number>;
  /** Model screen calls per useful document; null when nothing useful came out (unknown, never cheap). */
  aiCallsPerUsefulFinding: Measured<number | null>;
  /** Dollars the source's screens cost (free providers $0, a pod call its share of billed pod spend) per useful document. */
  dollarsPerUsefulFinding: Measured<number>;
  /** Failed pulls, and failed pulls the next pull of the source recovered from. */
  failureRecovery: Measured<{ failures: number; recoveries: number; pulls: number }>;
  /** Pulls the provider answered with 429 / 503, and the latest recorded connector state. */
  providerSaturation: Measured<{ throttled: number; latestHealth: ConnectorState | null }>;
  /** Verified customer payments net of refunds on openings the source's accepted claims started, in cents. */
  revenue: Measured<number>;
  /** What to do about this source's own provider, from its health — a repair, never compute. */
  repair: SourceRepair | null;
  /** Where processing should happen for this source, from what its acquisition metadata says it supports. */
  placement: PlacementAdvice;
}

export interface SourceRepair {
  kind: 'REPAIR_AUTHORIZATION' | 'REPAIR_OUTAGE' | 'REPAIR_CONNECTOR';
  reason: string;
}

/**
 * What a source's recorded connector state asks for. A revoked permission or an
 * outage is repaired (credentials, waiting out the provider, rediscovery), and
 * adding CPU, workers or a bigger server repairs neither. Pure.
 */
export function sourceRepair(state: ConnectorState | null): SourceRepair | null {
  switch (state) {
    case 'PERMISSION_REVOKED':
      return { kind: 'REPAIR_AUTHORIZATION', reason: 'the provider refused authorization; restore permitted access — more CPU or workers cannot repair a refusal' };
    case 'TRANSIENT_OUTAGE':
      return { kind: 'REPAIR_OUTAGE', reason: 'the provider is failing; back off and retry it — more CPU or workers cannot repair a provider outage' };
    case 'DEAD_ENDPOINT':
    case 'SCHEMA_CHANGED':
    case 'BROKEN_PARSER':
      return { kind: 'REPAIR_CONNECTOR', reason: `the connector is ${state.toLowerCase().replace('_', ' ')}; repair the connector — capacity does not read a moved or unreadable source` };
    default:
      return null;
  }
}

export interface PlacementAdvice {
  placement: 'FILTER_AT_SOURCE' | 'SHARDED_BULK_READ' | 'CONDITIONAL_READ' | 'WHOLE_READ';
  reason: string;
}

/**
 * Where to process a source's data, from what the source itself supports:
 * filter at the provider when it accepts a cursor or a narrowing query (so only
 * what is needed crosses the network), read a bulk snapshot in checkpointed
 * shards on an ingestion worker, read conditionally when the provider supports
 * validators, and only otherwise read it whole. Pure.
 */
export function placementAdvice(source: Pick<FeedSource, 'cursorUrl' | 'shards' | 'acquisition'> | null): PlacementAdvice {
  if (!source) return { placement: 'WHOLE_READ', reason: 'the source is not in the catalog, so nothing says it supports narrowing; it is read whole and storage drops repeats' };
  const mechanism = source.acquisition?.access.updateMechanism ?? null;
  if (source.cursorUrl || source.acquisition?.resourceQuery) {
    return { placement: 'FILTER_AT_SOURCE', reason: 'the provider accepts a cursor or narrowing query: filter in place and transfer only what was published since the last read' };
  }
  if (source.shards || mechanism === 'BULK_SNAPSHOT') {
    return { placement: 'SHARDED_BULK_READ', reason: 'a bulk source with no server-side filter: read it in checkpointed shards on an independent ingestion worker, not through the request loop' };
  }
  if (mechanism === 'CONDITIONAL_FETCH') {
    return { placement: 'CONDITIONAL_READ', reason: 'the provider supports validators: an unchanged resource costs a 304, not a transfer' };
  }
  return { placement: 'WHOLE_READ', reason: 'the source states no narrowing or conditional mechanism; it is read whole and storage drops repeats' };
}

interface PullRow {
  source: string;
  ok: number | string;
  fetched: number | string | null;
  inserted: number | string | null;
  error: string | null;
  created_at: string;
}

interface ItemRow {
  id: string;
  source: string;
  external_id: string | null;
  url: string;
  title: string;
  organization: string | null;
  published_at: string | null;
  fetched_at: string;
  shortlisted_round_id: string | null;
  shortlisted_at: string | null;
}

/** Whether a recorded pull error is the provider saying it is saturated (rate limit or overload). */
export function isThrottled(error: string | null): boolean {
  return /\bHTTP (429|503)\b/.test(error ?? '');
}

/** Failures, and failures the source's very next pull recovered from, from its pulls in time order. Pure. */
export function failureRecovery(pulls: readonly { ok: boolean }[]): { failures: number; recoveries: number; pulls: number } {
  let failures = 0;
  let recoveries = 0;
  for (let i = 0; i < pulls.length; i += 1) {
    if (pulls[i]!.ok) continue;
    failures += 1;
    if (pulls[i + 1]?.ok) recoveries += 1;
  }
  return { failures, recoveries, pulls: pulls.length };
}

/** Walk [since, until) of `feed_pulls` a page at a time; nothing holds the window. */
async function forEachPullPage(since: string, until: string, visit: (rows: readonly PullRow[]) => void): Promise<void> {
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const rows: (PullRow & { id: string })[] = await getDb().all(
      after
        ? `SELECT id, source, ok, fetched, inserted, error, created_at FROM feed_pulls
            WHERE created_at < ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ${PAGE}`
        : `SELECT id, source, ok, fetched, inserted, error, created_at FROM feed_pulls
            WHERE created_at < ? AND created_at >= ? ORDER BY created_at, id LIMIT ${PAGE}`,
      after ? [until, after.at, after.at, after.id] : [until, since],
    );
    visit(rows);
    if (rows.length < PAGE) return;
    const last = rows[rows.length - 1]!;
    after = { at: last.created_at, id: last.id };
  }
}

/**
 * Walk [since, until) of `feed_items` a page at a time, without bodies: a page
 * is visited and dropped, so memory is one page however large the window.
 */
async function forEachItemPage(since: string, until: string, visit: (rows: readonly ItemRow[]) => Promise<void>): Promise<void> {
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const rows: ItemRow[] = await getDb().all(
      after
        ? `SELECT id, source, external_id, url, title, organization, published_at, fetched_at, shortlisted_round_id, shortlisted_at FROM feed_items
            WHERE fetched_at < ? AND source <> ? AND source <> ? AND (fetched_at > ? OR (fetched_at = ? AND id > ?)) ORDER BY fetched_at, id LIMIT ${PAGE}`
        : `SELECT id, source, external_id, url, title, organization, published_at, fetched_at, shortlisted_round_id, shortlisted_at FROM feed_items
            WHERE fetched_at < ? AND source <> ? AND source <> ? AND fetched_at >= ? ORDER BY fetched_at, id LIMIT ${PAGE}`,
      after ? [until, CODE_SIGNAL_SOURCE, SITE_SOURCE, after.at, after.at, after.id] : [until, CODE_SIGNAL_SOURCE, SITE_SOURCE, since],
    );
    await visit(rows);
    if (rows.length < PAGE) return;
    const last = rows[rows.length - 1]!;
    after = { at: last.fetched_at, id: last.id };
  }
}

/**
 * Items one window runs the deterministic extractor over, in total and per
 * source. The extractor reads bodies in-process on the free lane's hourly tick,
 * so its work is bounded rather than proportional to feed volume; beyond the
 * budget parser coverage is a ratio over the items examined (recorded with its
 * sample) and the fact count is not claimed (inv. 33).
 */
export const EXTRACT_BUDGET = { perWindow: 5_000, perSource: 1_000 } as const;

/** The latest connector state each source has recorded up to `until`. */
async function latestHealth(until: string): Promise<Map<string, ConnectorState>> {
  const rows = await getDb().all<{ provider: string | null; measures: string | null; at: string }>(
    `SELECT provider, measures, at FROM bin_events WHERE event_type = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 2000`,
    [CONNECTOR_HEALTH_EVENT, until],
  );
  const out = new Map<string, ConnectorState>();
  for (const row of rows) {
    if (!row.provider || out.has(row.provider)) continue;
    try {
      const state = (JSON.parse(row.measures ?? '{}') as { state?: unknown }).state;
      if (typeof state === 'string') out.set(row.provider, state as ConnectorState);
    } catch {
      // An unreadable health row says nothing about the source.
    }
  }
  return out;
}

/**
 * Every CAP-21-7 measure for every source with rows in [since, until) or in the
 * catalog. Sources come from the rows themselves as well as `FEED_SOURCES`, so
 * a source the catalog no longer lists is still measured.
 */
export async function readAcquisitionMeasures(
  since: string,
  until: string,
  catalog: readonly FeedSource[] = FEED_SOURCES,
  budget: { perWindow: number; perSource: number } = EXTRACT_BUDGET,
  readSpend: (since: string) => Promise<Pick<PodSpend, 'dollars' | 'unpricedRunningSamples'>> = readPodSpend,
): Promise<SourceAcquisitionMeasures[]> {
  const db = getDb();
  const health = await latestHealth(until);
  // A pod screen call's share of the pod's billed spend is its cost; a free provider's is $0.
  const perCall = await podPricing(since, until, readSpend);
  const attribution: AttributionAccumulator = new Map();
  let attributionReadable = true;

  const pullsBy = new Map<string, { visited: number; inserted: number; pulls: number; failures: number; recoveries: number; throttled: number; lastFailed: boolean }>();
  await forEachPullPage(since, until, (rows) => {
    for (const p of rows) {
      const acc = pullsBy.get(p.source) ?? { visited: 0, inserted: 0, pulls: 0, failures: 0, recoveries: 0, throttled: 0, lastFailed: false };
      const ok = Number(p.ok) === 1;
      acc.pulls += 1;
      if (ok) {
        acc.visited += Number(p.fetched ?? 0);
        acc.inserted += Number(p.inserted ?? 0);
        if (acc.lastFailed) acc.recoveries += 1;
      } else {
        acc.failures += 1;
        if (isThrottled(p.error)) acc.throttled += 1;
      }
      acc.lastFailed = !ok;
      pullsBy.set(p.source, acc);
    }
  });

  type ItemAcc = { stored: number; useful: number; examined: number; parsed: number; facts: number; codeMatches: number; escalated: number; calls: number; podCalls: number; shortlisted: number; avoided: number };
  const itemsBy = new Map<string, ItemAcc>();
  let examinedTotal = 0;
  await forEachItemPage(since, until, async (page) => {
    if (page.length === 0) return;
    const ids = page.map((one) => one.id);
    const marks = ids.map(() => '?').join(',');
    const kept = new Set<string>();
    const screened = new Set<string>();
    const screenCalls = new Map<string, number>();
    const podCalls = new Map<string, number>();
    const rows = await db.all<{ id: string; subject_id: string; model: string; ok: number | string; output: string | null }>(
      `SELECT id, subject_id, model, ok, output FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${marks})`,
      [...ids],
    );
    for (const row of rows) {
      screened.add(row.subject_id);
      // A batched screen's per-record rows are its answers, not calls of their own.
      if (!row.id.startsWith(BATCH_ROW_PREFIX)) {
        screenCalls.set(row.subject_id, (screenCalls.get(row.subject_id) ?? 0) + 1);
        if (isRunpodSlot(row.model)) podCalls.set(row.subject_id, (podCalls.get(row.subject_id) ?? 0) + 1);
      }
      if (Number(row.ok) === 1 && (row.output ?? '').includes('"verdict":"KEEP"')) kept.add(row.subject_id);
    }
    const covered = new Set(await coveredItems(ids));

    // Which of this page's items the extractor reads, inside the window's budget.
    const toExamine: ItemRow[] = [];
    const pending = new Map<string, number>();
    for (const item of page) {
      const examined = (itemsBy.get(item.source)?.examined ?? 0) + (pending.get(item.source) ?? 0);
      if (examinedTotal + toExamine.length >= budget.perWindow || examined >= budget.perSource) continue;
      toExamine.push(item);
      pending.set(item.source, (pending.get(item.source) ?? 0) + 1);
    }
    // Every item's bytes are measured; only the budgeted ones are run through the extractor.
    const bodies = await pageBodies(ids);
    const examineIds = new Set(toExamine.map((one) => one.id));
    if (attributionReadable) {
      try {
        await attributePage(
          attribution,
          page.map((item) => ({
            id: item.id, source: item.source, url: item.url, publishedAt: item.published_at, fetchedAt: item.fetched_at, shortlistedAt: item.shortlisted_at,
            bytes: recordBytes({ externalId: item.external_id, url: item.url, title: item.title, body: bodies.get(item.id) ?? null, organization: item.organization, publishedAt: item.published_at }),
          })),
          until,
        );
      } catch {
        attributionReadable = false;
      }
    }

    for (const item of page) {
      const acc = itemsBy.get(item.source) ?? { stored: 0, useful: 0, examined: 0, parsed: 0, facts: 0, codeMatches: 0, escalated: 0, calls: 0, podCalls: 0, shortlisted: 0, avoided: 0 };
      acc.stored += 1;
      if (kept.has(item.id) || covered.has(item.id) || item.shortlisted_round_id) acc.useful += 1;
      if (covered.has(item.id)) acc.codeMatches += 1;
      if (screened.has(item.id)) acc.escalated += 1;
      if (covered.has(item.id) && !screened.has(item.id)) acc.avoided += 1;
      if (item.shortlisted_round_id) acc.shortlisted += 1;
      acc.calls += screenCalls.get(item.id) ?? 0;
      acc.podCalls += podCalls.get(item.id) ?? 0;
      if (examineIds.has(item.id)) {
        const read = extractItem({
          id: item.id,
          source: item.source,
          url: item.url,
          title: item.title,
          body: bodies.get(item.id) ?? null,
          organization: item.organization,
          publishedAt: item.published_at,
          fetchedAt: item.fetched_at,
        });
        acc.examined += 1;
        examinedTotal += 1;
        if (read.length > 0) acc.parsed += 1;
        acc.facts += read.length;
      }
      itemsBy.set(item.source, acc);
    }
  });

  const sources = new Set<string>(catalog.map((s) => s.id));
  for (const source of pullsBy.keys()) sources.add(source);
  for (const source of itemsBy.keys()) sources.add(source);
  const byId = new Map(catalog.map((s) => [s.id, s]));

  const attributedBy = finishAttribution(attribution);
  const out: SourceAcquisitionMeasures[] = [];
  for (const source of [...sources].sort()) {
    const p = pullsBy.get(source) ?? { visited: 0, inserted: 0, pulls: 0, failures: 0, recoveries: 0, throttled: 0, lastFailed: false };
    const i = itemsBy.get(source) ?? { stored: 0, useful: 0, examined: 0, parsed: 0, facts: 0, codeMatches: 0, escalated: 0, calls: 0, podCalls: 0, shortlisted: 0, avoided: 0 };
    const repeats = Math.max(0, p.visited - p.inserted);
    const state = health.get(source) ?? null;
    const complete = i.examined === i.stored;
    const attributed = attributedBy.get(source) ?? null;
    const fromRows = <T>(read: (a: SourceAttribution) => T): Measured<T> => {
      if (!attributionReadable) return notMeasured(UNMEASURED_REASONS.attributionUnreadable);
      return measured(read(attributed ?? { source, bytes: 0, acceptedEvidence: 0, verifiedLinks: 0, economicRelationships: 0, correctedContradictions: 0, variablesResolved: 0, minutesToGoalImpact: [], minutesToPlan: [], revenueCents: 0 }));
    };
    const toGoal = median(attributed?.minutesToGoalImpact ?? []);
    const dollars: Measured<number> = i.useful === 0
      ? notMeasured(UNMEASURED_REASONS.dollarsNoUseful)
      : i.podCalls > 0 && perCall.pod === null
        ? notMeasured(UNMEASURED_REASONS.dollarsUnpriced)
        : measured(round4((i.podCalls * (perCall.pod ?? 0)) / i.useful));
    out.push({
      source,
      recordsVisited: measured(p.visited),
      newUniqueDocuments: measured(i.stored),
      newUniqueUsefulDocuments: measured(i.useful),
      refreshedRecords: measured(repeats),
      rawBytes: measured(attributed?.bytes ?? 0),
      parserCoverage: measured(i.examined > 0 ? round4(i.parsed / i.examined) : null),
      parserSample: { examined: i.examined, stored: i.stored },
      structuredFacts: complete
        ? measured(i.facts)
        : notMeasured(`the extractor read ${i.facts} fact(s) from ${i.examined} of ${i.stored} stored item(s); the window's extraction budget (${budget.perWindow} per window, ${budget.perSource} per source) stopped there, so the whole count is not claimed`),
      acceptedEvidence: fromRows((a) => a.acceptedEvidence),
      codeDerivedMatches: measured(i.codeMatches),
      verifiedBuyerPriceFulfillmentLinks: fromRows((a) => a.verifiedLinks),
      usableTransactionPaths: measured(i.shortlisted),
      timeToGoalImpactMinutes: toGoal === null ? notMeasured(UNMEASURED_REASONS.timeToGoalImpact) : measured(toGoal),
      aiJobsAvoided: measured(repeats + i.avoided),
      aiEscalations: measured(i.escalated),
      aiCallsPerUsefulFinding: measured(i.useful > 0 ? round4(i.calls / i.useful) : null),
      dollarsPerUsefulFinding: dollars,
      failureRecovery: measured({ failures: p.failures, recoveries: p.recoveries, pulls: p.pulls }),
      providerSaturation: measured({ throttled: p.throttled, latestHealth: state }),
      revenue: fromRows((a) => a.revenueCents),
      repair: sourceRepair(state),
      placement: placementAdvice(byId.get(source) ?? null),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which resource class is constrained
// ---------------------------------------------------------------------------

/** The resource classes the research fleet scales by. The application server is deliberately not one. */
export const RESOURCE_CLASSES = [
  'INGESTION_WORKERS',
  'BULK_PROCESSING',
  'OBJECT_STORAGE',
  'DATABASE_INDEXES',
  'BROWSER_WORKERS',
  'LLM_WORKERS',
  'GPU',
] as const;
export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

export interface ResourceSignal {
  resource: ResourceClass;
  /** Work waiting on this resource now. */
  waiting: Measured<number>;
  /** Work this resource completes per hour. */
  throughputPerHour: Measured<number>;
  /** What one more unit of this resource would add, in accepted output per hour; only a positive measured gain justifies adding it. */
  marginalGain: Measured<number>;
  /** A fault in front of the resource that capacity cannot fix. */
  fault: { kind: 'OUTAGE' | 'AUTHORIZATION' | 'DATABASE'; evidence: string } | null;
}

export interface ResourceRecommendation {
  resource: ResourceClass;
  action: 'INCREASE' | 'HOLD' | 'REPAIR';
  reason: string;
}

export interface ConstraintVerdict {
  constrained: ResourceClass | null;
  basis: string;
  recommendations: ResourceRecommendation[];
}

/** Hours of waiting work at the measured rate; a resource with work and no measured throughput is stalled (infinite backlog). */
function backlogHours(signal: ResourceSignal): number | null {
  if (!signal.waiting.measured || signal.waiting.value <= 0) return null;
  if (!signal.throughputPerHour.measured) return null;
  if (signal.throughputPerHour.value <= 0) return Number.POSITIVE_INFINITY;
  return signal.waiting.value / signal.throughputPerHour.value;
}

/**
 * Name the constrained resource class from measurements and recommend scaling
 * only it. A faulted resource is repaired, never scaled. A resource is a
 * scaling candidate only when work measurably waits on it and a measured
 * marginal gain says another unit would produce more; among candidates, the
 * one with the longest measured backlog is constrained. Everything else holds
 * — an unmeasured resource is never assumed to be the bottleneck (inv. 39).
 * Pure.
 */
export function classifyConstraint(signals: readonly ResourceSignal[]): ConstraintVerdict {
  const recommendations: ResourceRecommendation[] = [];
  let best: { resource: ResourceClass; hours: number; gain: number } | null = null;
  for (const signal of signals) {
    if (signal.fault) continue;
    const hours = backlogHours(signal);
    if (hours === null || !signal.marginalGain.measured || signal.marginalGain.value <= 0) continue;
    if (!best || hours > best.hours || (hours === best.hours && signal.marginalGain.value > best.gain)) {
      best = { resource: signal.resource, hours, gain: signal.marginalGain.value };
    }
  }
  for (const resource of RESOURCE_CLASSES) {
    const signal = signals.find((s) => s.resource === resource);
    if (signal?.fault) {
      recommendations.push({
        resource,
        action: 'REPAIR',
        reason: `${signal.fault.kind.toLowerCase()} in front of ${resource}: ${signal.fault.evidence}. Repair it first; more CPU, workers or a larger server cannot.`,
      });
    } else if (best && best.resource === resource) {
      recommendations.push({
        resource,
        action: 'INCREASE',
        reason: `the longest measured backlog (${Number.isFinite(best.hours) ? `${round4(best.hours)} h` : 'stalled'}) with a measured marginal gain of ${round4(best.gain)} accepted/h per added unit`,
      });
    } else if (!signal) {
      recommendations.push({ resource, action: 'HOLD', reason: 'no measurement of this resource; an unmeasured resource is not a reason to scale' });
    } else {
      const why = !signal.waiting.measured
        ? `waiting work not measured (${signal.waiting.reason})`
        : signal.waiting.value <= 0
          ? 'no work waits on it'
          : !signal.marginalGain.measured
            ? `no measured marginal gain (${signal.marginalGain.reason})`
            : signal.marginalGain.value <= 0
              ? 'another unit is measured to add nothing'
              : 'another resource has the longer measured backlog';
      recommendations.push({ resource, action: 'HOLD', reason: why });
    }
  }
  const faults = signals.filter((s) => s.fault).map((s) => s.resource);
  const basis = best
    ? `${best.resource} is the constrained resource: work waits on it and a measured marginal gain says more of it produces more.`
    : `No resource is measurably constrained with a positive marginal gain; add nothing.${faults.length ? ` Repair first: ${faults.join(', ')}.` : ''}`;
  return { constrained: best?.resource ?? null, basis, recommendations };
}

/** A route failure cause, as a fault capacity cannot fix, on the resource it sits in front of. */
function faultOf(cause: RouteFailureCause): { resource: ResourceClass; kind: 'OUTAGE' | 'AUTHORIZATION' | 'DATABASE' } | null {
  switch (cause) {
    case 'credentials':
      return { resource: 'LLM_WORKERS', kind: 'AUTHORIZATION' };
    case 'provider availability':
      return { resource: 'LLM_WORKERS', kind: 'OUTAGE' };
    case 'broken GPU':
      return { resource: 'GPU', kind: 'OUTAGE' };
    case 'database':
      return { resource: 'DATABASE_INDEXES', kind: 'DATABASE' };
    default:
      return null;
  }
}

/** The stages of `stageCapacity.ts` each resource class is read from. */
const STAGES_OF: Partial<Record<ResourceClass, readonly string[]>> = {
  INGESTION_WORKERS: ['source-ingestion'],
  BULK_PROCESSING: ['parsing-indexing', 'graph-quant'],
  LLM_WORKERS: ['model-interpretation', 'evidence-verification'],
};

/**
 * Resource signals from the latest recorded stage-capacity measurement and the
 * window's source measures. Object storage and browser workers have no rows
 * and are reported unmeasured; a source whose provider refused authorization
 * or is out is a fault on ingestion, never a reason to add ingestion workers.
 * Pure.
 */
export function resourceSignals(recorded: RecordedStageCapacity | null, sources: readonly SourceAcquisitionMeasures[] = []): ResourceSignal[] {
  const report = recorded && !recorded.stale ? recorded.report : null;
  const missing = recorded === null
    ? 'no stage-capacity measurement has been recorded'
    : recorded.stale
      ? `the latest stage-capacity measurement is stale (${recorded.ageMinutes} min old)`
      : 'the latest stage-capacity measurement failed';
  const primary = report?.diagnosis?.primary ?? null;
  const routeFault = primary ? faultOf(primary.cause) : null;
  const ingestionFaults = sources.filter((s) => s.repair && s.repair.kind !== 'REPAIR_CONNECTOR');
  const constrainedGain = report?.constrained?.expectedGain;

  return RESOURCE_CLASSES.map((resource): ResourceSignal => {
    let fault: ResourceSignal['fault'] = null;
    if (routeFault && routeFault.resource === resource && primary) fault = { kind: routeFault.kind, evidence: `${primary.route}: ${primary.cause} (${primary.failures} failure(s))` };
    if (resource === 'INGESTION_WORKERS' && ingestionFaults.length > 0 && ingestionFaults.length === sources.filter((s) => s.recordsVisited.measured).length) {
      fault = { kind: ingestionFaults.some((s) => s.repair?.kind === 'REPAIR_AUTHORIZATION') ? 'AUTHORIZATION' : 'OUTAGE', evidence: ingestionFaults.map((s) => `${s.source} ${s.repair?.kind}`).join(', ') };
    }
    if (resource === 'OBJECT_STORAGE' || resource === 'BROWSER_WORKERS') {
      const why = `no row records ${resource === 'OBJECT_STORAGE' ? 'object-storage' : 'browser-worker'} queueing or throughput`;
      return { resource, waiting: notMeasured(why), throughputPerHour: notMeasured(why), marginalGain: notMeasured(why), fault };
    }
    if (!report) return { resource, waiting: notMeasured(missing), throughputPerHour: notMeasured(missing), marginalGain: notMeasured(missing), fault };
    if (resource === 'DATABASE_INDEXES') {
      const pool = report.process?.dbPool;
      const waiting = pool?.measured ? measured(pool.value.workloadWaiting) : notMeasured<number>(pool && !pool.measured ? pool.reason : 'no pool reading');
      const why = 'the database pool reading has no throughput or marginal-gain measure';
      return { resource, waiting, throughputPerHour: notMeasured(why), marginalGain: notMeasured(why), fault };
    }
    if (resource === 'GPU') {
      const why = 'GPU spend is measured, but no row measures what another GPU would add';
      return { resource, waiting: notMeasured(why), throughputPerHour: notMeasured(why), marginalGain: notMeasured(why), fault };
    }
    const stageIds = STAGES_OF[resource] ?? [];
    const stages = report.stages.filter((s) => stageIds.includes(s.stage));
    const sum = (pick: (s: (typeof stages)[number]) => Measured<number>): Measured<number> => {
      const read = stages.map(pick);
      if (read.length === 0) return notMeasured('no stage reading for this resource');
      const unseen = read.find((m) => !m.measured);
      if (unseen && !unseen.measured && read.every((m) => !m.measured)) return notMeasured(unseen.reason);
      return measured(read.reduce((n, m) => n + (m.measured ? m.value : 0), 0));
    };
    const gainHere = report.constrained && constrainedGain && report.constrained.stage !== null && stageIds.includes(report.constrained.stage);
    const marginalGain: Measured<number> = gainHere && constrainedGain
      ? constrainedGain.measured
        ? measured(constrainedGain.value.acceptedFactsPerHour)
        : notMeasured(constrainedGain.reason)
      : notMeasured('the stage-capacity measurement estimated no gain for another unit of this resource');
    return { resource, waiting: sum((s) => s.queueSize), throughputPerHour: sum((s) => s.itemsProcessedPerHour), marginalGain, fault };
  });
}

// ---------------------------------------------------------------------------
// Dynamic allocation across purposes, with no owner quota
// ---------------------------------------------------------------------------

/*
 * S-0304: "Allocate work dynamically between active goal demands, open-world
 * exploration, capability building and future planning; don't require the
 * owner to assign a quota to every category."
 *
 * Brain already has the one allocation that moves real work: the goals tick
 * decides the research purposes' shares from measured marginal outcome per
 * unit of cost (`goals/researchAllocation.ts` decideResearchAllocation),
 * records it as `GOAL_RESEARCH_REALLOCATED`, steps live bins' priority by it,
 * and the free lane orders the packets it claims by the same decision
 * (`freeLane/worker.ts` researchShiftsInForce). This reading reports that
 * decision in S-0304's four lanes — it never computes shares of its own that
 * nothing applies (§10.3, §20.4) — beside each lane's own measured yield per
 * job, so the two can be compared on the record.
 */

export const WORK_LANES = ['ACTIVE_GOAL_DEMAND', 'OPEN_WORLD_EXPLORATION', 'CAPABILITY_BUILDING', 'FUTURE_PLANNING'] as const;
export type WorkLane = (typeof WORK_LANES)[number];

/** Which S-0304 lane each research purpose serves; every purpose is in exactly one. */
export const LANE_OF_PURPOSE: Record<ResearchPurpose, WorkLane> = {
  TRANSACTION_ROUTES: 'ACTIVE_GOAL_DEMAND',
  OPERATING_SUPPORT: 'ACTIVE_GOAL_DEMAND',
  BROAD_DISCOVERY: 'OPEN_WORLD_EXPLORATION',
  SELF_IMPROVEMENT: 'CAPABILITY_BUILDING',
  FORWARD_EXPLORATION: 'FUTURE_PLANNING',
};

/** Which S-0304 lane each stage-capacity attribution category served. */
const LANE_OF_CATEGORY: Record<string, WorkLane> = {
  IMMEDIATE_COMMERCIAL_DISCOVERY: 'ACTIVE_GOAL_DEMAND',
  DEAL_COMPLETION: 'ACTIVE_GOAL_DEMAND',
  BROADER_WORLD_RESEARCH: 'OPEN_WORLD_EXPLORATION',
  SELF_IMPROVEMENT: 'CAPABILITY_BUILDING',
  FUTURE_GOAL_PREPARATION: 'FUTURE_PLANNING',
};

export interface LaneReading {
  lane: WorkLane;
  /** Jobs the lane itself spent in the window (accepted or not). */
  jobs: Measured<number>;
  /** Useful (accepted) output those jobs produced. */
  useful: Measured<number>;
  /** Useful output per job the lane spent: its own yield, never its share of another lane's work. */
  usefulPerJob: Measured<number>;
}

/**
 * Each lane's own jobs and useful output from the stage-capacity attribution:
 * a lane's useful-per-job is its accepted jobs over the jobs it spent, so a
 * lane that spent ten jobs for two accepted reads 0.2 whatever the other lanes
 * did. A reading recorded before jobs per category were measured says nothing
 * about yield (inv. 39). Pure.
 */
export function laneReadings(recorded: RecordedStageCapacity | null): LaneReading[] {
  const attribution = recorded && !recorded.stale ? recorded.report?.attribution ?? null : null;
  const none = (reason: string): LaneReading[] =>
    WORK_LANES.map((lane) => ({ lane, jobs: notMeasured(reason), useful: notMeasured(reason), usefulPerJob: notMeasured(reason) }));
  if (!attribution) return none('no current stage-capacity attribution');
  if (attribution.some((one) => typeof one.jobs !== 'number')) {
    return none('the stage-capacity reading counts accepted jobs only, not the jobs each category spent');
  }
  const jobs = new Map<WorkLane, number>();
  const productive = new Map<WorkLane, number>();
  for (const one of attribution) {
    const lane = LANE_OF_CATEGORY[one.category];
    if (!lane) continue;
    jobs.set(lane, (jobs.get(lane) ?? 0) + (one.jobs ?? 0));
    productive.set(lane, (productive.get(lane) ?? 0) + one.productiveJobs);
  }
  return WORK_LANES.map((lane) => {
    const spent = jobs.get(lane) ?? 0;
    const useful = productive.get(lane) ?? 0;
    return {
      lane,
      jobs: measured(spent),
      useful: measured(useful),
      usefulPerJob: spent > 0 ? measured(round4(useful / spent)) : notMeasured('the lane spent no job in the window'),
    };
  });
}

export interface LaneShare {
  lane: WorkLane;
  /** The share the decision in force gives the lane, or not measured when no decision is in force. */
  decided: Measured<number>;
  /** The share of job time the lane actually received in the decision's window. */
  observed: Measured<number>;
  /** The lane's own measured useful output per job (`laneReadings`). */
  usefulPerJob: Measured<number>;
  basis: string;
}

/** The research allocation in force as the free lane and the goals tick read it, or null when none is. */
export type AllocationInForce = (SharesInForce & { fingerprint: string | null }) | null;

/**
 * The work allocation in force, in S-0304's four lanes: the shares the goals
 * tick decided and the free lane's claim order applies, summed over the
 * purposes each lane serves, beside what each lane received and its own yield.
 * No decision in force (none recorded, or held for want of a measurement)
 * claims no share: the lane then claims by stored priority, and the record
 * says so rather than inventing one (inv. 39). No owner quota is an input. Pure.
 */
export function allocationInForce(decision: AllocationInForce, readings: readonly LaneReading[]): LaneShare[] {
  const sum = (shares: Record<ResearchPurpose, number>, lane: WorkLane): number =>
    round4(RESEARCH_PURPOSES.filter((p) => LANE_OF_PURPOSE[p] === lane).reduce((n, p) => n + shares[p], 0));
  return WORK_LANES.map((lane) => {
    const usefulPerJob = readings.find((r) => r.lane === lane)?.usefulPerJob ?? notMeasured<number>('no lane reading');
    if (!decision || decision.held) {
      const why = !decision ? 'no research allocation decision is recorded' : 'the research allocation decision in force is held (nothing measured to move it)';
      return { lane, decided: notMeasured(why), observed: notMeasured(why), usefulPerJob, basis: `${why}; the free lane claims by stored priority` };
    }
    return {
      lane,
      decided: measured(sum(decision.shares, lane)),
      observed: measured(sum(decision.observed, lane)),
      usefulPerJob,
      basis: `GOAL_RESEARCH_REALLOCATED ${decision.fingerprint ?? '(unfingerprinted)'}: decided by marginal useful outcome per unit of cost, applied by the goals tick's bin priority and the free lane's claim order`,
    };
  });
}

/** The decision in force, read exactly as the free lane reads it (`researchShiftsInForce`). */
async function readAllocationInForce(): Promise<AllocationInForce> {
  const tick = await import('../goals/tick.ts');
  return tick.sharesInForceFrom((await (await tick.productionResearchAllocationPorts()).lastDecision())?.detail ?? null);
}

// ---------------------------------------------------------------------------
// The recorded reading
// ---------------------------------------------------------------------------

export interface AcquisitionMeasuresReading {
  since: string;
  until: string;
  sources: SourceAcquisitionMeasures[];
  constraint: ConstraintVerdict;
  allocation: LaneShare[];
}

/**
 * Measure the window since the last reading and write one ACQUISITION_MEASURES
 * bin event, once per window, back to back. A window shorter than the interval
 * writes nothing and returns null.
 */
export async function recordAcquisitionMeasures(
  now: Date,
  record: typeof recordBinEvent = recordBinEvent,
  deps: {
    readStageCapacity?: (now: number) => Promise<RecordedStageCapacity | null>;
    catalog?: readonly FeedSource[];
    readAllocation?: () => Promise<AllocationInForce>;
  } = {},
): Promise<AcquisitionMeasuresReading | null> {
  const last = await getDb().get<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = ? ORDER BY at DESC, id DESC LIMIT 1`,
    [ACQUISITION_MEASURES_EVENT],
  );
  let since: string | null = null;
  try {
    const until = (JSON.parse(last?.measures ?? '{}') as { until?: unknown }).until;
    if (typeof until === 'string' && Number.isFinite(Date.parse(until))) since = until;
  } catch {
    since = null;
  }
  if (since === null) since = new Date(now.getTime() - ACQUISITION_MEASURES_WINDOW_MS).toISOString();
  if (now.getTime() - Date.parse(since) < ACQUISITION_MEASURES_WINDOW_MS) return null;
  const until = now.toISOString();
  const started = Date.now();
  const sources = await readAcquisitionMeasures(since, until, deps.catalog);
  const recorded = await (deps.readStageCapacity ?? readStageCapacity)(now.getTime());
  const constraint = classifyConstraint(resourceSignals(recorded, sources));
  // An unreadable decision is no decision: the reading still records, and says so.
  const decision = await (deps.readAllocation ?? readAllocationInForce)().catch(() => null);
  const allocation = allocationInForce(decision, laneReadings(recorded));
  const reading: AcquisitionMeasuresReading = { since, until, sources, constraint, allocation };
  const repairs = sources.filter((s) => s.repair).map((s) => `${s.source} ${s.repair!.kind}`);
  await record({
    eventType: ACQUISITION_MEASURES_EVENT,
    workloadClass: 'acquisition',
    outcome: 'MEASURED',
    reason: `${constraint.basis} ${sources.length} source(s) measured ${since} to ${until}.${repairs.length ? ` Source repairs: ${repairs.join(', ')}.` : ''}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    durationMs: Date.now() - started,
    measures: storedAcquisition(reading),
  });
  return reading;
}

/**
 * The reading as one row stores it: `since`/`until` kept (the next window starts
 * at `until`), sources needing a repair first and then by records visited, and
 * every list cut to `boundMeasures`' size with what was cut counted. Pure.
 */
export function storedAcquisition(reading: AcquisitionMeasuresReading): Record<string, unknown> {
  const visited = (s: SourceAcquisitionMeasures): number => (s.recordsVisited.measured ? s.recordsVisited.value : 0);
  const sources = [...(reading.sources ?? [])].sort((a, b) => Number(Boolean(b.repair)) - Number(Boolean(a.repair)) || visited(b) - visited(a));
  return boundMeasures({ ...reading, sources, totals: { sources: sources.length } } as unknown as Record<string, unknown>);
}

/** A route's attribution plus the compute it was billed for. */
export interface RouteAttribution extends SourceAttribution {
  /** The route's screens' share of billed GPU pod spend in dollars; free providers are $0; null when the pod ran unpriced. */
  computeDollars: number | null;
}

/**
 * Per route (feed source), what its records stored in [since, until) led to
 * downstream and the compute its screens were billed for — the CAP-25-2 stage
 * reading's attributed measures, read by the same chain and the same pages as
 * the per-source acquisition reading. Read-only.
 */
export async function readRouteAttribution(
  since: string,
  until: string,
  readSpend: (since: string) => Promise<Pick<PodSpend, 'dollars' | 'unpricedRunningSamples'>> = readPodSpend,
): Promise<Map<string, RouteAttribution>> {
  const db = getDb();
  const acc: AttributionAccumulator = new Map();
  const podCallsBySource = new Map<string, number>();
  await forEachItemPage(since, until, async (page) => {
    if (page.length === 0) return;
    const ids = page.map((one) => one.id);
    const bodies = await pageBodies(ids);
    await attributePage(
      acc,
      page.map((item) => ({
        id: item.id, source: item.source, url: item.url, publishedAt: item.published_at, fetchedAt: item.fetched_at, shortlistedAt: item.shortlisted_at,
        bytes: recordBytes({ externalId: item.external_id, url: item.url, title: item.title, body: bodies.get(item.id) ?? null, organization: item.organization, publishedAt: item.published_at }),
      })),
      until,
    );
    const sourceOf = new Map(page.map((item) => [item.id, item.source]));
    const rows = await db.all<{ id: string; subject_id: string; model: string }>(
      `SELECT id, subject_id, model FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    for (const row of rows) {
      if (row.id.startsWith(BATCH_ROW_PREFIX) || !isRunpodSlot(row.model)) continue;
      const source = sourceOf.get(row.subject_id);
      if (source) podCallsBySource.set(source, (podCallsBySource.get(source) ?? 0) + 1);
    }
  });
  const perCall = await podPricing(since, until, readSpend);
  const out = new Map<string, RouteAttribution>();
  for (const [source, a] of finishAttribution(acc)) {
    const calls = podCallsBySource.get(source) ?? 0;
    out.set(source, { ...a, computeDollars: calls === 0 ? 0 : perCall.pod === null ? null : Math.round(calls * perCall.pod * 10_000) / 10_000 });
  }
  return out;
}
