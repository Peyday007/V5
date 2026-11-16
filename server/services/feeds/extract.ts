/**
 * Deterministic extraction and reconciliation over stored feed items
 * (ALGO-16-1 item 2).
 *
 * Ordinary code reads prices, dates, locations, quantities, deliverable
 * descriptions and buyer/provider identities out of records whose structure is
 * stable, and normalizes them — currencies to minor units, quantities to one
 * unit per dimension (`readQuantities`), entity names to the conservative key
 * `employerKey` already uses, dates to ISO days. Every fact carries the id of
 * the exact stored item and the field of it the value was read from, and the
 * exact text, so anyone can check it against the raw record.
 *
 * What a fact is *about* is never upgraded on the way through. A record's kind
 * comes from its source (or, for a source this module does not know, from the
 * record's own wording) and travels on every fact read from it: a job posting
 * is an employer hiring, a supplier advertisement is somebody selling, a
 * platform price is a listing. None of those is a buyer asking to buy, and the
 * type has no "confirmed demand" to put them in — the strongest a fact can say
 * is that the record itself states a request.
 *
 * Reconciliation never presents an observation as established. Several
 * observations of one fact that agree read OBSERVED; that disagree read
 * CONTESTED, with every observation kept; whose newest is older than the stale
 * window read STALE. Records the parser cannot read are not guessed at: they
 * are listed, in batches, for model assistance, and a record it could read is
 * never sent.
 *
 * Structure feeds Connect: `extractItems` turns what it read into event-graph
 * facts (`graphFactsFrom`) and adds them to the running Brain's graph — the
 * same `currentEventGraph()` that `syncEventGraph` fills from detections and
 * that construction reads — so a normalized price, quantity, place or stated
 * request reaches the graph rules and `constructFromGraph` on the same tick it
 * was read, and only the neighborhoods those facts touch are recomputed. A fact
 * enters the graph only with what reconciliation left standing: a contested
 * value enters as unknown, a stale record does not enter, and its basis (a job
 * posting, an advert, a listing) travels as a missing condition on every
 * hypothesis built on it, never as a buyer.
 *
 * `extractItem`, `reconcile` and `graphFactsFrom` are pure: no database, no
 * network, no model. Nothing here calls a model, so it works when every model
 * provider is down.
 */
import { employerKey, titleKey } from './detectors.ts';
import { currentEventGraph, type EventGraph, type GraphFact } from '../industry/eventGraph.ts';
import { readMoneyFigures } from '../cash/figures.ts';
import { readQuantities } from '../cash/volume.ts';

/** The stored item fields extraction reads: `StoredFeedItem`'s shape, nothing more. */
export interface ExtractableItem {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  publishedAt: string | null;
  fetchedAt: string;
}

/**
 * What kind of record a fact came from. Only STATED_REQUEST is somebody asking
 * to buy, and even that is the record's own statement, not a confirmed buyer.
 */
export type RecordKind = 'JOB_POSTING' | 'SUPPLIER_AD' | 'PLATFORM_PRICE' | 'STATED_REQUEST' | 'PUBLIC_RECORD' | 'NEWS' | 'UNKNOWN';

/**
 * Who a record is from is typed by what the record is: `buyer` only when the
 * record itself states a request, `provider` for a seller's advert or listing,
 * `employer` for a job posting (hiring, not buying), `organization` otherwise.
 */
export type FactField = 'price' | 'quantity' | 'date' | 'location' | 'deliverable' | 'buyer' | 'provider' | 'employer' | 'organization';

/** The item field a value was read from. */
export type ItemField = 'title' | 'body' | 'organization' | 'publishedAt';

export interface ExtractedFact {
  /** Which fact this observes: the same key across items means the same fact, so they reconcile. */
  key: string;
  field: FactField;
  /** The normalized value: minor units for a price, the normalized unit's amount for a quantity, ISO day, key text. */
  value: string | number;
  unit: string | null;
  currency: string | null;
  entityKey: string | null;
  recordKind: RecordKind;
  /**
   * What the record says about demand. Never "confirmed": a record cannot
   * confirm a buyer, and a job posting, supplier advert or platform price is
   * not demand at all.
   */
  demand: 'NOT_DEMAND' | 'STATED_REQUEST';
  evidence: { itemId: string; field: ItemField; text: string; url: string };
  observedAt: string;
}

export type ReconciledStatus = 'OBSERVED' | 'CONTESTED' | 'STALE';

export interface ReconciledFact {
  key: string;
  status: ReconciledStatus;
  /** The one value when observations agree; null when contested. */
  value: string | number | null;
  observations: ExtractedFact[];
}

export interface ExtractionRun {
  facts: ExtractedFact[];
  reconciled: ReconciledFact[];
  /** Items the parser could not read, batched for model assistance. Never a readable one. */
  needsModel: ExtractableItem[][];
  /** What this run handed the event graph: the facts it built, and what the graph recomputed for them. */
  graph: ExtractionGraphUpdate;
}

export interface ExtractionGraphUpdate {
  /** One graph fact per record the graph can relate (it names who and what), each linked to its stored item. */
  facts: GraphFact[];
  /** Facts the graph took as new or changed; a re-read of an unchanged record is a duplicate and adds nothing. */
  added: number;
  /** Neighborhoods recomputed because of them. */
  affected: string[];
}

/** How long an observation stands before it reads as stale. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
/** Unreadable items per model-assistance batch. */
export const MODEL_BATCH_SIZE = 20;

/** The kind each known source's records are. A source not listed is classified from the record's wording. */
const SOURCE_KINDS: Record<string, RecordKind> = {
  remoteok: 'JOB_POSTING',
  remotive: 'JOB_POSTING',
  'federal-register-rules': 'PUBLIC_RECORD',
  'code-signal': 'PUBLIC_RECORD',
};

const WORDING: Array<[RegExp, RecordKind]> = [
  [/\b(request for (?:proposals?|quotes?|bids?)|rfp|rfq|invitation to bid|seeking (?:quotes|bids|a contractor|a vendor|a supplier)|looking for (?:a )?(?:contractor|vendor|supplier|provider)|need(?:s|ed)? (?:a )?(?:contractor|vendor|supplier))\b/i, 'STATED_REQUEST'],
  [/\b(we(?:'re| are) hiring|now hiring|job opening|apply now|full[- ]time|part[- ]time|salary|position)\b/i, 'JOB_POSTING'],
  [/\b(we offer|our services|available for hire|for sale|now booking|free estimates?|call us|contact us for a quote)\b/i, 'SUPPLIER_AD'],
  [/\b(list(?:ed)? (?:price|at)|price list|marketplace price|per unit price|asking price)\b/i, 'PLATFORM_PRICE'],
];

/** The kind of record an item is: its source's, else its own wording's, else UNKNOWN. */
export function recordKindOf(item: Pick<ExtractableItem, 'source' | 'title' | 'body'>): RecordKind {
  const bySource = SOURCE_KINDS[item.source];
  if (bySource) return bySource;
  if (item.source.startsWith('news-')) return 'NEWS';
  const text = `${item.title}\n${item.body ?? ''}`;
  for (const [pattern, kind] of WORDING) if (pattern.test(text)) return kind;
  return 'UNKNOWN';
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY'];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ISO_DAY = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const WRITTEN_DAY = new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi');
const PLACE = /\b(?:in|near|serving|located in|based in)\s+([A-Z][A-Za-z.' -]{1,40}?),\s*([A-Z]{2})\b/g;
const REMOTE = /\b(remote|anywhere|worldwide)\b/i;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function validDay(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Every ISO day a text states, written either way. */
export function readDays(text: string): { day: string; text: string }[] {
  const out: { day: string; text: string }[] = [];
  for (const m of text.matchAll(ISO_DAY)) {
    const day = validDay(Number(m[1]), Number(m[2]), Number(m[3]));
    if (day) out.push({ day, text: m[0]! });
  }
  for (const m of text.matchAll(WRITTEN_DAY)) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase().slice(0, 3))) + 1;
    const day = validDay(Number(m[3]), month, Number(m[2]));
    if (day) out.push({ day, text: m[0]! });
  }
  return out;
}

/** "City, ST" places a text states, normalized to lower case. Remote reads as "remote". */
export function readPlaces(text: string): { place: string; text: string }[] {
  const out: { place: string; text: string }[] = [];
  for (const m of text.matchAll(PLACE)) out.push({ place: `${m[1]!.trim().toLowerCase()}, ${m[2]!.toLowerCase()}`, text: `${m[1]!.trim()}, ${m[2]}` });
  const remote = REMOTE.exec(text);
  if (remote) out.push({ place: 'remote', text: remote[0] });
  return out;
}

/** The deliverable a record is about, as a comparable key. Job titles lose seniority and work-mode words. */
function deliverableOf(item: ExtractableItem, kind: RecordKind): string | null {
  const key = kind === 'JOB_POSTING' ? titleKey(item.title) : item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return key || null;
}

/** Read one stored item into facts. Pure; the same item always gives the same facts. */
export function extractItem(item: ExtractableItem): ExtractedFact[] {
  const kind = recordKindOf(item);
  const entity = employerKey(item.organization);
  const deliverable = deliverableOf(item, kind);
  const observedAt = item.publishedAt ?? item.fetchedAt;
  const demand: ExtractedFact['demand'] = kind === 'STATED_REQUEST' ? 'STATED_REQUEST' : 'NOT_DEMAND';
  const subject = `${entity ?? item.id}:${deliverable ?? '-'}`;
  const out: ExtractedFact[] = [];
  const push = (fact: Omit<ExtractedFact, 'recordKind' | 'demand' | 'observedAt' | 'entityKey'>): void => {
    out.push({ ...fact, entityKey: entity, recordKind: kind, demand, observedAt });
  };
  const ev = (field: ItemField, text: string) => ({ itemId: item.id, field, text, url: item.url });

  if (entity && item.organization) {
    // Who the record is from, in the role its kind gives them. Only a stated request makes a buyer:
    // an employer hiring is not buying from anyone outside, and a seller advertising is supply.
    const role: FactField =
      kind === 'STATED_REQUEST' ? 'buyer' : kind === 'SUPPLIER_AD' || kind === 'PLATFORM_PRICE' ? 'provider' : kind === 'JOB_POSTING' ? 'employer' : 'organization';
    push({ key: `${role}:${item.id}`, field: role, value: entity, unit: null, currency: null, evidence: ev('organization', item.organization) });
  }
  if (deliverable) push({ key: `deliverable:${item.id}`, field: 'deliverable', value: deliverable, unit: null, currency: null, evidence: ev('title', item.title) });

  for (const field of ['title', 'body'] as const) {
    const text = field === 'title' ? item.title : item.body ?? '';
    if (!text) continue;
    for (const currency of CURRENCIES) {
      for (const figure of readMoneyFigures(text, currency)) {
        push({
          key: `price:${subject}:${currency}:${figure.perUnit ? 'rate' : 'total'}`,
          field: 'price',
          value: figure.cents,
          unit: figure.perUnit ? 'per-unit' : null,
          currency,
          evidence: ev(field, figure.text),
        });
      }
    }
    for (const q of readQuantities(text)) {
      push({ key: `quantity:${subject}:${q.normalizedUnit}`, field: 'quantity', value: q.normalizedValue, unit: q.normalizedUnit, currency: null, evidence: ev(field, q.text) });
    }
    for (const d of readDays(text)) push({ key: `date:${subject}:${d.day}`, field: 'date', value: d.day, unit: null, currency: null, evidence: ev(field, d.text) });
    for (const p of readPlaces(text)) push({ key: `location:${subject}`, field: 'location', value: p.place, unit: null, currency: null, evidence: ev(field, p.text) });
  }
  if (item.publishedAt) {
    const day = item.publishedAt.slice(0, 10);
    push({ key: `date:${item.id}:published`, field: 'date', value: day, unit: null, currency: null, evidence: ev('publishedAt', item.publishedAt) });
  }
  return out;
}

/**
 * Whether the parser could read an item: its kind is known and it yielded at
 * least one fact beyond who sent it and what it is called. Anything else goes
 * to model assistance — nothing readable ever does.
 */
export function readable(item: ExtractableItem, facts: readonly ExtractedFact[]): boolean {
  if (recordKindOf(item) === 'UNKNOWN') return false;
  return facts.some((f) => f.field === 'price' || f.field === 'quantity' || f.field === 'location' || (f.field === 'date' && f.evidence.field !== 'publishedAt'));
}

/** Reconcile observations by fact key: agreeing OBSERVED, disagreeing CONTESTED, old STALE. Never "established". */
export function reconcile(facts: readonly ExtractedFact[], now: Date, staleAfterMs = STALE_AFTER_MS): ReconciledFact[] {
  const byKey = new Map<string, ExtractedFact[]>();
  for (const fact of facts) byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact]);
  const out: ReconciledFact[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const observations = byKey.get(key)!.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.evidence.itemId.localeCompare(b.evidence.itemId));
    const newest = Date.parse(observations[observations.length - 1]!.observedAt);
    const values = new Set(observations.map((o) => String(o.value)));
    const status: ReconciledStatus = Number.isFinite(newest) && now.getTime() - newest > staleAfterMs ? 'STALE' : values.size > 1 ? 'CONTESTED' : 'OBSERVED';
    out.push({ key, status, value: status === 'CONTESTED' ? null : observations[observations.length - 1]!.value, observations });
  }
  return out;
}

/**
 * How a record's kind enters the graph, or null for one the graph has no
 * relation for. Only a stated request is a buyer. A job posting is a want on
 * the JOB_POSTING basis (as a code detection is), an advert is an offer, a
 * listing with a price is a seller's price. A public record, a news item or a
 * record of unknown kind states no want, offer or price of its own, so it is
 * not given one.
 */
const GRAPH_KIND: Partial<Record<RecordKind, { kind: GraphFact['kind']; basis: GraphFact['basis']; role: GraphFact['actor']['role'] }>> = {
  STATED_REQUEST: { kind: 'WANT', basis: 'STATED_REQUEST', role: 'BUYER' },
  JOB_POSTING: { kind: 'WANT', basis: 'JOB_POSTING', role: 'UNKNOWN' },
  SUPPLIER_AD: { kind: 'OFFER', basis: 'SUPPLIER_AD', role: 'SUPPLIER' },
  PLATFORM_PRICE: { kind: 'OFFER', basis: 'PLATFORM_PRICE', role: 'SUPPLIER' },
};

/**
 * The event-graph facts a set of extracted facts supports: one per record that
 * names who it is from and what it is about. Values come only from fact keys
 * reconciliation left OBSERVED — a CONTESTED price, quantity or place enters
 * as unknown rather than as one side of the disagreement — and a record whose
 * observation is older than the stale window does not enter at all. Every
 * graph fact's evidence is the exact stored item, its source and URL. Pure.
 */
export function graphFactsFrom(
  items: readonly ExtractableItem[],
  facts: readonly ExtractedFact[],
  reconciled: readonly ReconciledFact[],
  now: Date,
  staleAfterMs = STALE_AFTER_MS,
): GraphFact[] {
  const status = new Map(reconciled.map((r) => [r.key, r.status]));
  const standing = (fact: ExtractedFact): boolean => status.get(fact.key) === 'OBSERVED';
  const byItem = new Map<string, ExtractedFact[]>();
  for (const fact of facts) byItem.set(fact.evidence.itemId, [...(byItem.get(fact.evidence.itemId) ?? []), fact]);
  const out: GraphFact[] = [];
  for (const item of items) {
    const read = byItem.get(item.id) ?? [];
    const recordKind = read[0]?.recordKind ?? recordKindOf(item);
    const shape = GRAPH_KIND[recordKind];
    if (!shape) continue;
    const observedAt = item.publishedAt ?? item.fetchedAt;
    const observed = Date.parse(observedAt);
    if (!Number.isFinite(observed) || now.getTime() - observed > staleAfterMs) continue;
    const actor = read.find((f) => f.field === 'buyer' || f.field === 'provider' || f.field === 'employer' || f.field === 'organization');
    const deliverable = read.find((f) => f.field === 'deliverable');
    if (!actor || !deliverable) continue;
    const place = read.find((f) => f.field === 'location' && standing(f));
    const quantity = read.find((f) => f.field === 'quantity' && standing(f));
    const price = read.find((f) => f.field === 'price' && standing(f));
    const days = read
      .filter((f) => f.field === 'date' && f.evidence.field !== 'publishedAt' && standing(f))
      .map((f) => String(f.value))
      .sort();
    const listed = recordKind === 'PLATFORM_PRICE' && price !== undefined;
    out.push({
      id: `extraction:${item.id}`,
      kind: listed ? 'PRICE' : shape.kind,
      basis: shape.basis,
      actor: { key: String(actor.value), name: item.organization, role: shape.role },
      subject: String(deliverable.value),
      region: place ? String(place.value) : null,
      quantity: quantity ? Number(quantity.value) : null,
      unit: quantity ? quantity.unit : price?.unit ?? null,
      priceCents: price ? Number(price.value) : null,
      currency: price?.currency ?? null,
      // Only a listing is a side of a market: a request's budget is not a price anyone agreed to pay.
      side: listed ? 'SELL' : null,
      statedCostCents: null,
      // A want holds until the last day it states; anything else from when it was seen, open-ended.
      window: { from: observedAt, to: shape.kind === 'WANT' && days.length > 0 && days[days.length - 1]! >= observedAt.slice(0, 10) ? `${days[days.length - 1]!}T23:59:59.999Z` : null },
      channel: item.source,
      rights: [],
      evidence: [{ rawId: item.id, source: item.source, url: item.url, observedAt }],
    });
  }
  return out;
}

/**
 * Extract every item, reconcile the facts, batch the unreadable items for model
 * assistance, and add what was read to the event graph (by default the running
 * Brain's, `currentEventGraph()`, which construction reads; `graph: null` adds
 * nothing). The graph recomputes only the neighborhoods these facts touch, and
 * an item read again unchanged is a duplicate that recomputes nothing.
 */
export function extractItems(items: readonly ExtractableItem[], now: Date = new Date(), options: { graph?: EventGraph | null } = {}): ExtractionRun {
  const facts: ExtractedFact[] = [];
  const unreadable: ExtractableItem[] = [];
  for (const item of items) {
    const read = extractItem(item);
    facts.push(...read);
    if (!readable(item, read)) unreadable.push(item);
  }
  const needsModel: ExtractableItem[][] = [];
  for (let i = 0; i < unreadable.length; i += MODEL_BATCH_SIZE) needsModel.push(unreadable.slice(i, i + MODEL_BATCH_SIZE));
  const reconciled = reconcile(facts, now);
  const graphFacts = graphFactsFrom(items, facts, reconciled, now);
  const graph = options.graph === undefined ? currentEventGraph() : options.graph;
  const affected = new Set<string>();
  let added = 0;
  if (graph) {
    for (const fact of graphFacts) {
      const result = graph.add(fact);
      if (result.affected.length > 0) added += 1;
      for (const hood of result.affected) affected.add(hood);
    }
  }
  return { facts, reconciled, needsModel, graph: { facts: graphFacts, added, affected: [...affected].sort() } };
}
