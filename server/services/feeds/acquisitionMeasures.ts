/**
 * Resource-aware acquisition measurement (CAP-21-7), extending the feed owner.
 *
 * Per source and window it measures what acquisition actually produced — records
 * visited, new unique useful documents, refreshed records, parser coverage,
 * structured facts, code-derived matches, AI jobs avoided and escalated, AI
 * calls per useful finding, failure and recovery, provider saturation, raw
 * bytes, accepted evidence, verified buyer/price/fulfillment links,
 * time-to-goal impact, dollars per useful finding and revenue — the last six
 * through the rows that link a stored item to what it became
 * (`readSourceOutcomeLinks`). A measure that cannot be read on one reading
 * says `NOT_MEASURED` with the reason instead of a guess (inv. 33, inv. 39).
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
 * capability building and future planning by measured marginal value, with no
 * owner-set quota.
 *
 * Nothing here schedules, queues or stores anything new: it reads `feed_pulls`,
 * `feed_items`, `feed_item_coverage`, `cheap_results`, `research_claims`,
 * `monetization_path_facts`, `cash_opportunities`, `cash_money_entries`,
 * `free_lane_capacity`, `llm_models` and `bin_events`, and
 * writes one `ACQUISITION_MEASURES` bin event per window. Sources are whatever
 * the rows and `FEED_SOURCES` name; no source, category or industry is a list
 * of what is allowed.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { readStageCapacity, type Measured, type RecordedStageCapacity } from '../freeLane/stageCapacity.ts';
import type { RouteFailureCause } from '../freeLane/worker.ts';
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
 * Why a measure could not be read on this reading. Each names the row that
 * would have had to answer, never a guess. These are conditions of one
 * reading (a linkage read that failed, a screen on a model with no recorded
 * price) — not measures that are unmeasured by construction.
 */
export const UNMEASURED_REASONS = {
  linkage: 'the rows that link a feed item to claims, plan facts, opportunities and money could not be read on this reading',
  dollarsPerUsefulFinding: 'a screen of this source ran on a model with no free_lane_capacity row and no zero-priced llm_models row, and cheap_results records no token counts to price it',
} as const;

// ---------------------------------------------------------------------------
// Downstream linkage: what a source's stored items went on to become
// ---------------------------------------------------------------------------

/**
 * What one source's stored items became downstream, read from the rows that
 * carry the link — never inferred:
 *
 * - a research claim cites the item by `research_claims.source_url = feed_items.url`;
 * - a plan fact cites the claim by `monetization_path_facts.claim_id`;
 * - an opportunity came from the item's shortlist round by
 *   `cash_opportunities.discovery_round_id = feed_items.shortlisted_round_id`;
 * - money arrived on that opportunity by `cash_money_entries.opportunity_id`;
 * - a screen call's price is its model's: $0 for a model the free lane runs
 *   (`free_lane_capacity`) or one `llm_models` prices at zero, unknown otherwise.
 */
export interface SourceOutcomeLinks {
  /** UTF-8 bytes of the records this source delivered that storage kept (url, title, body, organization). */
  storedBytes: number;
  /** Claims citing a stored item that structural validation sourced and no contradiction check refuted. */
  acceptedEvidence: number;
  /** Claims citing a stored item whose contradiction was settled (SUPPORTED or REFUTED). */
  settledContradictions: number;
  /** Distinct (pathway, attribute) plan variables an EVIDENCE fact resolved from those claims. */
  variablesResolved: number;
  /** Distinct monetization pathways those facts sit on: the economic relationships the source evidenced. */
  economicRelationships: number;
  /** Opportunities from the source's shortlist rounds whose validation is COMPLETE, by which link they carry. */
  verifiedLinks: { buyer: number; price: number; fulfillment: number; complete: number };
  /** Median minutes from an item's arrival to the first plan fact or opportunity it caused; null when none did. */
  minutesToGoalImpact: number | null;
  /** Customer payments less refunds on those opportunities, in cents. */
  revenueCents: number;
  /** Screen calls the source's items cost (a batch's per-record rows are not calls). */
  screenCalls: number;
  /** Dollars those calls cost; null when one ran on a model with no recorded price. */
  screenDollars: number | null;
}

/** A stored item, as the linkage reads it. */
export interface LinkedItem {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  fetched_at: string;
  shortlisted_round_id: string | null;
}

/** UTF-8 bytes of a stored record's content. Pure. */
export function recordBytes(item: Pick<LinkedItem, 'url' | 'title' | 'body' | 'organization'>): number {
  return Buffer.byteLength(item.url, 'utf8') + Buffer.byteLength(item.title, 'utf8')
    + Buffer.byteLength(item.body ?? '', 'utf8') + Buffer.byteLength(item.organization ?? '', 'utf8');
}

/** The median of a list, or null for an empty one. Pure. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const emptyLinks = (): SourceOutcomeLinks => ({
  storedBytes: 0, acceptedEvidence: 0, settledContradictions: 0, variablesResolved: 0, economicRelationships: 0,
  verifiedLinks: { buyer: 0, price: 0, fulfillment: 0, complete: 0 },
  minutesToGoalImpact: null, revenueCents: 0, screenCalls: 0, screenDollars: 0,
});

async function inChunks<R>(keys: readonly string[], read: (chunk: string[], marks: string) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  const unique = [...new Set(keys)];
  for (let at = 0; at < unique.length; at += PAGE) {
    const chunk = unique.slice(at, at + PAGE);
    out.push(...(await read(chunk, chunk.map(() => '?').join(','))));
  }
  return out;
}

const filled = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * Per-source downstream linkage for a set of stored items, from rows. Every
 * source with an item gets an entry; a source whose items led nowhere reads
 * zero, which is a measurement, not an absence of one.
 */
export async function readSourceOutcomeLinks(items: readonly LinkedItem[]): Promise<Map<string, SourceOutcomeLinks>> {
  const db = getDb();
  const out = new Map<string, SourceOutcomeLinks>();
  const linksOf = (source: string): SourceOutcomeLinks => {
    let one = out.get(source);
    if (!one) { one = emptyLinks(); out.set(source, one); }
    return one;
  };
  const itemsByUrl = new Map<string, LinkedItem[]>();
  const itemsByRound = new Map<string, LinkedItem[]>();
  for (const item of items) {
    linksOf(item.source).storedBytes += recordBytes(item);
    itemsByUrl.set(item.url, [...(itemsByUrl.get(item.url) ?? []), item]);
    if (item.shortlisted_round_id) itemsByRound.set(item.shortlisted_round_id, [...(itemsByRound.get(item.shortlisted_round_id) ?? []), item]);
  }

  // Claims citing the items.
  const claims = await inChunks([...itemsByUrl.keys()], (chunk, marks) => db.all<{ id: string; source_url: string; validation_state: string; contradiction_state: string }>(
    `SELECT id, source_url, validation_state, contradiction_state FROM research_claims WHERE source_url IN (${marks})`, chunk,
  ));
  const itemsOfClaim = new Map<string, LinkedItem[]>();
  for (const claim of claims) {
    const cited = itemsByUrl.get(claim.source_url) ?? [];
    const accepted = claim.validation_state === 'SOURCED' && claim.contradiction_state !== 'REFUTED';
    const settled = claim.contradiction_state === 'SUPPORTED' || claim.contradiction_state === 'REFUTED';
    for (const source of new Set(cited.map((i) => i.source))) {
      if (accepted) linksOf(source).acceptedEvidence += 1;
      if (settled) linksOf(source).settledContradictions += 1;
    }
    if (accepted) itemsOfClaim.set(claim.id, cited);
  }

  // The earliest downstream effect per item: a plan fact or an opportunity.
  const firstEffect = new Map<string, number>();
  const touch = (item: LinkedItem, at: string) => {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return;
    const prior = firstEffect.get(item.id);
    if (prior === undefined || t < prior) firstEffect.set(item.id, t);
  };

  // Plan facts resolved from those claims.
  const facts = await inChunks([...itemsOfClaim.keys()], (chunk, marks) => db.all<{ claim_id: string; path_id: string; attribute: string; created_at: string }>(
    `SELECT claim_id, path_id, attribute, created_at FROM monetization_path_facts WHERE kind = 'EVIDENCE' AND claim_id IN (${marks})`, chunk,
  ));
  const variables = new Map<string, Set<string>>();
  const pathways = new Map<string, Set<string>>();
  for (const fact of facts) {
    for (const item of itemsOfClaim.get(fact.claim_id) ?? []) {
      variables.set(item.source, (variables.get(item.source) ?? new Set()).add(`${fact.path_id}\u0000${fact.attribute}`));
      pathways.set(item.source, (pathways.get(item.source) ?? new Set()).add(fact.path_id));
      touch(item, fact.created_at);
    }
  }
  for (const [source, set] of variables) linksOf(source).variablesResolved = set.size;
  for (const [source, set] of pathways) linksOf(source).economicRelationships = set.size;

  // Opportunities opened from the items' shortlist rounds, and money on them.
  const opportunities = await inChunks([...itemsByRound.keys()], (chunk, marks) => db.all<{ id: string; discovery_round_id: string; validation_state: string | null; payer: string | null; price_cents: number | string | null; fulfillment_owner: string | null; created_at: string }>(
    `SELECT id, discovery_round_id, validation_state, payer, price_cents, fulfillment_owner, created_at FROM cash_opportunities WHERE discovery_round_id IN (${marks})`, chunk,
  ));
  const sourcesOfOpportunity = new Map<string, Set<string>>();
  for (const opp of opportunities) {
    const fed = itemsByRound.get(opp.discovery_round_id) ?? [];
    for (const item of fed) touch(item, opp.created_at);
    const sources = new Set(fed.map((i) => i.source));
    sourcesOfOpportunity.set(opp.id, sources);
    if (opp.validation_state !== 'COMPLETE') continue;
    const buyer = filled(opp.payer);
    const price = opp.price_cents !== null && opp.price_cents !== undefined;
    const fulfillment = filled(opp.fulfillment_owner);
    for (const source of sources) {
      const v = linksOf(source).verifiedLinks;
      if (buyer) v.buyer += 1;
      if (price) v.price += 1;
      if (fulfillment) v.fulfillment += 1;
      if (buyer && price && fulfillment) v.complete += 1;
    }
  }
  const money = await inChunks([...sourcesOfOpportunity.keys()], (chunk, marks) => db.all<{ opportunity_id: string; kind: string; amount_cents: number | string }>(
    `SELECT opportunity_id, kind, amount_cents FROM cash_money_entries WHERE kind IN ('CUSTOMER_PAYMENT', 'REFUND') AND opportunity_id IN (${marks})`, chunk,
  ));
  for (const entry of money) {
    const signed = entry.kind === 'REFUND' ? -Number(entry.amount_cents) : Number(entry.amount_cents);
    for (const source of sourcesOfOpportunity.get(entry.opportunity_id) ?? []) linksOf(source).revenueCents += signed;
  }

  const delays = new Map<string, number[]>();
  for (const item of items) {
    const effect = firstEffect.get(item.id);
    const arrived = Date.parse(item.fetched_at);
    if (effect === undefined || !Number.isFinite(arrived)) continue;
    delays.set(item.source, [...(delays.get(item.source) ?? []), Math.max(0, (effect - arrived) / 60_000)]);
  }
  for (const [source, list] of delays) {
    const mid = median(list);
    linksOf(source).minutesToGoalImpact = mid === null ? null : round4(mid);
  }

  // What the screens of these items cost, at their models' recorded prices.
  const freeModels = new Set((await db.all<{ model: string }>(`SELECT model FROM free_lane_capacity`)).map((r) => r.model));
  for (const r of await db.all<{ model_id: string }>(`SELECT model_id FROM llm_models WHERE input_micros_per_mtok = 0 AND output_micros_per_mtok = 0`)) freeModels.add(r.model_id);
  const sourceOfItem = new Map(items.map((i) => [i.id, i.source]));
  const screens = await inChunks([...sourceOfItem.keys()], (chunk, marks) => db.all<{ id: string; subject_id: string; model: string }>(
    `SELECT id, subject_id, model FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${marks})`, chunk,
  ));
  for (const call of screens) {
    if (call.id.startsWith(BATCH_ROW_PREFIX)) continue;
    const source = sourceOfItem.get(call.subject_id);
    if (!source) continue;
    const links = linksOf(source);
    links.screenCalls += 1;
    if (!freeModels.has(call.model)) links.screenDollars = null;
  }
  return out;
}

/** The window's stored items, with linkage read for every source. Null when a linkage row could not be read. */
export async function readWindowOutcomeLinks(since: string, until: string): Promise<Map<string, SourceOutcomeLinks> | null> {
  try {
    return await readSourceOutcomeLinks(await pagedItems(since, until));
  } catch {
    return null;
  }
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
  /** UTF-8 bytes of the records the source delivered that storage kept. */
  rawBytes: Measured<number>;
  /** Share of stored items from which the deterministic extractor read at least one fact. */
  parserCoverage: Measured<number | null>;
  /** Facts the deterministic extractor read from the window's stored items. */
  structuredFacts: Measured<number>;
  /** Sourced, unrefuted research claims citing a stored item of the source. */
  acceptedEvidence: Measured<number>;
  /** Stored items a code detector accounted for (`feed_item_coverage`). */
  codeDerivedMatches: Measured<number>;
  /** Opportunities from the source's shortlist rounds whose validation is COMPLETE, by the buyer, price and fulfillment link each carries. */
  verifiedBuyerPriceFulfillmentLinks: Measured<{ buyer: number; price: number; fulfillment: number; complete: number }>;
  /** Stored items a shortlist round took: the commercially usable leads a transaction path starts from. */
  usableTransactionPaths: Measured<number>;
  /** Median minutes from an item's arrival to the first plan fact or opportunity it caused; null when none did yet. */
  timeToGoalImpactMinutes: Measured<number | null>;
  /** Records that never reached a model: repeats storage dropped plus items a code rule covered. */
  aiJobsAvoided: Measured<number>;
  /** Stored items a free-model screen was asked about. */
  aiEscalations: Measured<number>;
  /** Model screen calls per useful document; null when nothing useful came out (unknown, never cheap). */
  aiCallsPerUsefulFinding: Measured<number | null>;
  /** Screen dollars per useful document at the models' recorded prices; null when nothing useful came out. */
  dollarsPerUsefulFinding: Measured<number | null>;
  /** Failed pulls, and failed pulls the next pull of the source recovered from. */
  failureRecovery: Measured<{ failures: number; recoveries: number; pulls: number }>;
  /** Pulls the provider answered with 429 / 503, and the latest recorded connector state. */
  providerSaturation: Measured<{ throttled: number; latestHealth: ConnectorState | null }>;
  /** Customer payments less refunds, in dollars, on opportunities the source's shortlisted items led to. */
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
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  published_at: string | null;
  fetched_at: string;
  shortlisted_round_id: string | null;
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

async function pagedPulls(since: string, until: string): Promise<PullRow[]> {
  const out: PullRow[] = [];
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
    out.push(...rows);
    if (rows.length < PAGE) return out;
    const last = rows[rows.length - 1]!;
    after = { at: last.created_at, id: last.id };
  }
}

async function pagedItems(since: string, until: string): Promise<ItemRow[]> {
  const out: ItemRow[] = [];
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const rows: ItemRow[] = await getDb().all(
      after
        ? `SELECT id, source, url, title, body, organization, published_at, fetched_at, shortlisted_round_id FROM feed_items
            WHERE fetched_at < ? AND source <> ? AND source <> ? AND (fetched_at > ? OR (fetched_at = ? AND id > ?)) ORDER BY fetched_at, id LIMIT ${PAGE}`
        : `SELECT id, source, url, title, body, organization, published_at, fetched_at, shortlisted_round_id FROM feed_items
            WHERE fetched_at < ? AND source <> ? AND source <> ? AND fetched_at >= ? ORDER BY fetched_at, id LIMIT ${PAGE}`,
      after ? [until, CODE_SIGNAL_SOURCE, SITE_SOURCE, after.at, after.at, after.id] : [until, CODE_SIGNAL_SOURCE, SITE_SOURCE, since],
    );
    out.push(...rows);
    if (rows.length < PAGE) return out;
    const last = rows[rows.length - 1]!;
    after = { at: last.fetched_at, id: last.id };
  }
}

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
): Promise<SourceAcquisitionMeasures[]> {
  const db = getDb();
  const pulls = await pagedPulls(since, until);
  const items = await pagedItems(since, until);
  const health = await latestHealth(until);

  const kept = new Set<string>();
  const covered = new Set<string>();
  const screened = new Set<string>();
  const screenCallsBySubject = new Map<string, number>();
  for (let at = 0; at < items.length; at += PAGE) {
    const chunk = items.slice(at, at + PAGE).map((one) => one.id);
    const marks = chunk.map(() => '?').join(',');
    const rows = await db.all<{ id: string; subject_id: string; ok: number | string; output: string | null }>(
      `SELECT id, subject_id, ok, output FROM cheap_results WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${marks})`,
      [...chunk],
    );
    for (const row of rows) {
      screened.add(row.subject_id);
      // A batched screen's per-record rows are its answers, not calls of their own.
      if (!row.id.startsWith(BATCH_ROW_PREFIX)) screenCallsBySubject.set(row.subject_id, (screenCallsBySubject.get(row.subject_id) ?? 0) + 1);
      if (Number(row.ok) === 1 && (row.output ?? '').includes('"verdict":"KEEP"')) kept.add(row.subject_id);
    }
    for (const id of await coveredItems(chunk)) covered.add(id);
  }

  const sources = new Set<string>(catalog.map((s) => s.id));
  for (const p of pulls) sources.add(p.source);
  for (const i of items) sources.add(i.source);
  const byId = new Map(catalog.map((s) => [s.id, s]));
  let links: Map<string, SourceOutcomeLinks> | null;
  try {
    links = await readSourceOutcomeLinks(items);
  } catch {
    links = null;
  }

  const out: SourceAcquisitionMeasures[] = [];
  for (const source of [...sources].sort()) {
    const mine = pulls.filter((p) => p.source === source);
    const okPulls = mine.filter((p) => Number(p.ok) === 1);
    const visited = okPulls.reduce((n, p) => n + Number(p.fetched ?? 0), 0);
    const insertedByPulls = okPulls.reduce((n, p) => n + Number(p.inserted ?? 0), 0);
    const stored = items.filter((i) => i.source === source);
    const useful = stored.filter((i) => kept.has(i.id) || covered.has(i.id) || i.shortlisted_round_id);
    let parsed = 0;
    let facts = 0;
    for (const item of stored) {
      const read = extractItem({
        id: item.id,
        source: item.source,
        url: item.url,
        title: item.title,
        body: item.body,
        organization: item.organization,
        publishedAt: item.published_at,
        fetchedAt: item.fetched_at,
      });
      if (read.length > 0) parsed += 1;
      facts += read.length;
    }
    const codeMatches = stored.filter((i) => covered.has(i.id)).length;
    const escalated = stored.filter((i) => screened.has(i.id)).length;
    const calls = stored.reduce((n, i) => n + (screenCallsBySubject.get(i.id) ?? 0), 0);
    const repeats = Math.max(0, visited - insertedByPulls);
    const state = health.get(source) ?? null;
    const links_here = links ? links.get(source) ?? emptyLinks() : null;
    out.push({
      source,
      recordsVisited: measured(visited),
      newUniqueDocuments: measured(stored.length),
      newUniqueUsefulDocuments: measured(useful.length),
      refreshedRecords: measured(repeats),
      rawBytes: links_here ? measured(links_here.storedBytes) : notMeasured(UNMEASURED_REASONS.linkage),
      parserCoverage: measured(stored.length > 0 ? round4(parsed / stored.length) : null),
      structuredFacts: measured(facts),
      acceptedEvidence: links_here ? measured(links_here.acceptedEvidence) : notMeasured(UNMEASURED_REASONS.linkage),
      codeDerivedMatches: measured(codeMatches),
      verifiedBuyerPriceFulfillmentLinks: links_here ? measured({ ...links_here.verifiedLinks }) : notMeasured(UNMEASURED_REASONS.linkage),
      usableTransactionPaths: measured(stored.filter((i) => i.shortlisted_round_id).length),
      timeToGoalImpactMinutes: links_here ? measured(links_here.minutesToGoalImpact) : notMeasured(UNMEASURED_REASONS.linkage),
      aiJobsAvoided: measured(repeats + stored.filter((i) => covered.has(i.id) && !screened.has(i.id)).length),
      aiEscalations: measured(escalated),
      aiCallsPerUsefulFinding: measured(useful.length > 0 ? round4(calls / useful.length) : null),
      dollarsPerUsefulFinding: !links_here
        ? notMeasured(UNMEASURED_REASONS.linkage)
        : links_here.screenDollars === null
          ? notMeasured(UNMEASURED_REASONS.dollarsPerUsefulFinding)
          : measured(useful.length > 0 ? round4(links_here.screenDollars / useful.length) : null),
      failureRecovery: measured(failureRecovery(mine.map((p) => ({ ok: Number(p.ok) === 1 })))),
      providerSaturation: measured({ throttled: mine.filter((p) => Number(p.ok) !== 1 && isThrottled(p.error)).length, latestHealth: state }),
      revenue: links_here ? measured(links_here.revenueCents / 100) : notMeasured(UNMEASURED_REASONS.linkage),
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

export const WORK_LANES = ['ACTIVE_GOAL_DEMAND', 'OPEN_WORLD_EXPLORATION', 'CAPABILITY_BUILDING', 'FUTURE_PLANNING'] as const;
export type WorkLane = (typeof WORK_LANES)[number];

export interface LaneReading {
  lane: WorkLane;
  /** Jobs spent on the lane in the window. */
  jobs: number;
  /** Useful output those jobs produced. */
  useful: Measured<number>;
}

export interface LaneShare {
  lane: WorkLane;
  share: number;
  marginalValue: number | null;
  basis: string;
}

/** The smallest share any lane keeps, so a lane with no reading yet still earns one. */
export const LANE_FLOOR = 0.05;

/**
 * Share of the next window's work per lane, from measured marginal value
 * (useful output per job). Every lane keeps a floor so an unmeasured one can
 * earn a reading; an unmeasured lane gets only the floor, never more (inv. 39);
 * the rest follows measured value. No owner-set quota is an input. Pure.
 */
export function allocateWork(readings: readonly LaneReading[]): LaneShare[] {
  const value = new Map<WorkLane, number | null>();
  for (const lane of WORK_LANES) {
    const r = readings.find((one) => one.lane === lane);
    value.set(lane, r && r.useful.measured && r.jobs > 0 ? r.useful.value / r.jobs : null);
  }
  const total = [...value.values()].reduce<number>((n, v) => n + (v ?? 0), 0);
  const rest = 1 - LANE_FLOOR * WORK_LANES.length;
  const measuredLanes = [...value.values()].filter((v) => v !== null).length;
  return WORK_LANES.map((lane) => {
    const v = value.get(lane) ?? null;
    let share = LANE_FLOOR;
    let basis: string;
    if (v === null) basis = 'no measured value: the floor only';
    else if (total > 0) {
      share += rest * (v / total);
      basis = `measured ${round4(v)} useful per job`;
    } else {
      // Every measured lane produced nothing: none outranks another, so the rest is split evenly among them.
      share += measuredLanes > 0 ? rest / measuredLanes : 0;
      basis = 'measured, but no lane produced useful output: an even split of the remainder';
    }
    return { lane, share: round4(share), marginalValue: v === null ? null : round4(v), basis };
  });
}

/** Lane readings from the stage-capacity attribution: each productive job is useful output of the lane it served. Pure. */
export function laneReadings(recorded: RecordedStageCapacity | null): LaneReading[] {
  const attribution = recorded && !recorded.stale ? recorded.report?.attribution ?? null : null;
  if (!attribution) return WORK_LANES.map((lane) => ({ lane, jobs: 0, useful: notMeasured('no current stage-capacity attribution') }));
  const laneOf: Record<string, WorkLane> = {
    IMMEDIATE_COMMERCIAL_DISCOVERY: 'ACTIVE_GOAL_DEMAND',
    DEAL_COMPLETION: 'ACTIVE_GOAL_DEMAND',
    BROADER_WORLD_RESEARCH: 'OPEN_WORLD_EXPLORATION',
    SELF_IMPROVEMENT: 'CAPABILITY_BUILDING',
    FUTURE_GOAL_PREPARATION: 'FUTURE_PLANNING',
  };
  const productive = new Map<WorkLane, number>();
  for (const one of attribution) {
    const lane = laneOf[one.category];
    if (lane) productive.set(lane, (productive.get(lane) ?? 0) + one.productiveJobs);
  }
  const total = [...productive.values()].reduce((n, v) => n + v, 0);
  // Jobs are the window's productive jobs; a lane's useful output is its own productive jobs, so its value is its share of them.
  return WORK_LANES.map((lane) => ({ lane, jobs: total, useful: measured(productive.get(lane) ?? 0) }));
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
  deps: { readStageCapacity?: (now: number) => Promise<RecordedStageCapacity | null>; catalog?: readonly FeedSource[] } = {},
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
  const allocation = allocateWork(laneReadings(recorded));
  const reading: AcquisitionMeasuresReading = { since, until, sources, constraint, allocation };
  const repairs = sources.filter((s) => s.repair).map((s) => `${s.source} ${s.repair!.kind}`);
  await record({
    eventType: ACQUISITION_MEASURES_EVENT,
    workloadClass: 'acquisition',
    outcome: 'MEASURED',
    reason: `${constraint.basis} ${sources.length} source(s) measured ${since} to ${until}.${repairs.length ? ` Source repairs: ${repairs.join(', ')}.` : ''}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    durationMs: Date.now() - started,
    measures: reading as unknown as Record<string, unknown>,
  });
  return reading;
}
