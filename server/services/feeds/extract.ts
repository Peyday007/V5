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
 * Pure: no database, no network, no model. It reads the stored item shape and
 * returns facts, so it works when every model provider is down.
 */
import { employerKey, titleKey } from './detectors.ts';
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
  // Each side of the HN freelance thread states what it is: a request to buy outside work, or a provider's offer.
  'hn-seeking-freelancer': 'STATED_REQUEST',
  'hn-seeking-work': 'SUPPLIER_AD',
};

/**
 * Wording in which a provider states, in its own record, that it serves
 * through or for others: subcontract or overflow work, white- or private-label
 * supply, wholesale or trade accounts, a referral, reseller, dealer, affiliate
 * or partner programme. A record saying this is a supplier advertisement whose
 * author has declared a partner role; nothing here is guessed from a plain
 * advert, and a buyer asking for a subcontractor is still a stated request
 * (that pattern is read first).
 */
export const PARTNER_OFFER_WORDING =
  /\b(white[- ]label(?:ed)?|private[- ]label(?:ed)?|wholesale (?:accounts?|pricing|inquiries|partners?)|trade (?:accounts?|partners?|pricing)|referral (?:partners?|partnerships?|program(?:me)?s?|fees? paid)|(?:reseller|dealer|affiliate|partner) program(?:me)?s?|partnership (?:inquiries|enquiries|opportunities)|we partner with|(?:available|accepting|open) (?:for|to) (?:subcontract(?:ing)?|overflow) (?:work|jobs|projects)|subcontract(?:ing)? (?:work|jobs|projects) (?:welcome|wanted|accepted)|overflow work (?:welcome|wanted|accepted))\b/i;

/** Sources whose titles are roles (a job, a freelancer wanted or offered): read the way job titles are, so both sides of one role share a deliverable. */
const ROLE_TITLE_SOURCES = new Set(['remoteok', 'remotive', 'hn-seeking-freelancer', 'hn-seeking-work']);

const WORDING: Array<[RegExp, RecordKind]> = [
  [/\b(request for (?:proposals?|quotes?|bids?)|rfp|rfq|invitation to bid|seeking (?:quotes|bids|a contractor|a vendor|a supplier)|looking for (?:a )?(?:contractor|vendor|supplier|provider)|need(?:s|ed)? (?:a )?(?:contractor|vendor|supplier))\b/i, 'STATED_REQUEST'],
  [/\b(we(?:'re| are) hiring|now hiring|job opening|apply now|full[- ]time|part[- ]time|salary|position)\b/i, 'JOB_POSTING'],
  [/\b(we offer|our services|available for hire|for sale|now booking|free estimates?|call us|contact us for a quote)\b/i, 'SUPPLIER_AD'],
  [PARTNER_OFFER_WORDING, 'SUPPLIER_AD'],
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
const PLACE = /(?:\b(?:in|near|serving|located in|based in|[Ll]ocation:)|\|)\s+([A-Z][A-Za-z.' -]{1,40}?),\s*([A-Z]{2})\b/g;
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
  const key = kind === 'JOB_POSTING' || ROLE_TITLE_SOURCES.has(item.source) ? titleKey(item.title) : item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

/** Extract every item, reconcile the facts, and batch the unreadable items for model assistance. */
export function extractItems(items: readonly ExtractableItem[], now: Date = new Date()): ExtractionRun {
  const facts: ExtractedFact[] = [];
  const unreadable: ExtractableItem[] = [];
  for (const item of items) {
    const read = extractItem(item);
    facts.push(...read);
    if (!readable(item, read)) unreadable.push(item);
  }
  const needsModel: ExtractableItem[][] = [];
  for (let i = 0; i < unreadable.length; i += MODEL_BATCH_SIZE) needsModel.push(unreadable.slice(i, i + MODEL_BATCH_SIZE));
  return { facts, reconciled: reconcile(facts, now), needsModel };
}
