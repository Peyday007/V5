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
 * Every fact also carries its provenance at fine granularity (ACQ-21-4 item
 * 5): where the record lives, when it was published and retrieved, the
 * source's version, format and licence when the item states them, the
 * extractor code version, the exact character span of the evidence in the
 * item field it was read from, the entities and the units. A value the item
 * does not state is null, never invented. Each fact is classed by what it is
 * epistemically — extraction only ever produces OBSERVED (read off the record)
 * or DERIVED (a role inferred from the record's kind); it never produces a
 * model estimate, a counterfactual or a verified commercial fact, which only
 * their own producers may assert.
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
  /** The source's own version of the record (an ETag, revision or dataset version), when the item carries one. */
  sourceVersion?: string | null;
  /** The format the record arrived in (e.g. `application/json`, `text/html`, `rss`), when known. */
  format?: string | null;
  /** The licence or permission the record was retrieved under, when the item states one. */
  license?: string | null;
}

/** The version of this extractor's code, recorded on every fact so a change in reading is visible in the rows. */
export const EXTRACTOR_VERSION = 'feeds-extract/2';

/**
 * What a fact is epistemically. Extraction emits only OBSERVED and DERIVED;
 * the other classes exist so downstream producers can say what they made
 * without a fact read off a record ever being mistaken for one of them.
 */
export type EpistemicClass = 'OBSERVED' | 'DERIVED' | 'MODEL_ESTIMATE' | 'COUNTERFACTUAL' | 'VERIFIED_COMMERCIAL';

/** The exact characters of the item field the evidence is: `source[field].slice(start, end) === text`. */
export interface EvidenceSpan {
  start: number;
  end: number;
  text: string;
}

/** Fine-grained provenance of one fact. Every field is present; an unknown is null. */
export interface FactProvenance {
  /** The original location of the record. */
  location: string;
  itemId: string;
  source: string;
  field: ItemField;
  publishedAt: string | null;
  retrievedAt: string;
  sourceVersion: string | null;
  format: string | null;
  license: string | null;
  /** The code that read the fact, and the model that did (always null: extraction calls no model). */
  extractor: { code: string; model: string | null };
  /** Where in the field the evidence sits; null only when the evidence text cannot be located verbatim. */
  span: EvidenceSpan | null;
  /** The normalized entity keys the fact concerns. */
  entities: string[];
  units: { unit: string | null; currency: string | null };
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
  epistemicClass: EpistemicClass;
  provenance: FactProvenance;
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
  return locatedDays(text).map(({ day, text: t }) => ({ day, text: t }));
}

/** `readDays` with where each day sits in the text. */
function locatedDays(text: string): { day: string; text: string; index: number }[] {
  const out: { day: string; text: string; index: number }[] = [];
  for (const m of text.matchAll(ISO_DAY)) {
    const day = validDay(Number(m[1]), Number(m[2]), Number(m[3]));
    if (day) out.push({ day, text: m[0]!, index: m.index });
  }
  for (const m of text.matchAll(WRITTEN_DAY)) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase().slice(0, 3))) + 1;
    const day = validDay(Number(m[3]), month, Number(m[2]));
    if (day) out.push({ day, text: m[0]!, index: m.index });
  }
  return out;
}

/** "City, ST" places a text states, normalized to lower case. Remote reads as "remote". */
export function readPlaces(text: string): { place: string; text: string }[] {
  return locatedPlaces(text).map(({ place, text: t }) => ({ place, text: t }));
}

/** `readPlaces` with the exact span of the text each place was read from. */
function locatedPlaces(text: string): { place: string; text: string; span: EvidenceSpan }[] {
  const out: { place: string; text: string; span: EvidenceSpan }[] = [];
  for (const m of text.matchAll(PLACE)) {
    const city = m[1]!.trim();
    const start = m.index + m[0].indexOf(city);
    const end = m.index + m[0].length;
    out.push({ place: `${city.toLowerCase()}, ${m[2]!.toLowerCase()}`, text: `${city}, ${m[2]}`, span: { start, end, text: text.slice(start, end) } });
  }
  const remote = REMOTE.exec(text);
  if (remote) out.push({ place: 'remote', text: remote[0], span: { start: remote.index, end: remote.index + remote[0].length, text: remote[0] } });
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
  const fieldText = (field: ItemField): string => (field === 'body' ? item.body ?? '' : field === 'organization' ? item.organization ?? '' : field === 'publishedAt' ? item.publishedAt ?? '' : item.title);
  // Where to look next for each repeated (field, text), so the second identical figure points at the second occurrence.
  const cursors = new Map<string, number>();
  const locate = (field: ItemField, text: string): EvidenceSpan | null => {
    const source = fieldText(field);
    const cursorKey = `${field}\u0000${text}`;
    let start = source.indexOf(text, cursors.get(cursorKey) ?? 0);
    if (start < 0) start = source.indexOf(text);
    if (start < 0 || !text) return null;
    cursors.set(cursorKey, start + 1);
    return { start, end: start + text.length, text };
  };
  const push = (
    fact: Omit<ExtractedFact, 'recordKind' | 'demand' | 'observedAt' | 'entityKey' | 'epistemicClass' | 'provenance'>,
    span?: EvidenceSpan,
  ): void => {
    // A role (buyer, provider, employer) is inferred from the record's kind; everything else is read off the record.
    const epistemicClass: EpistemicClass = fact.field === 'buyer' || fact.field === 'provider' || fact.field === 'employer' ? 'DERIVED' : 'OBSERVED';
    const provenance: FactProvenance = {
      location: item.url,
      itemId: item.id,
      source: item.source,
      field: fact.evidence.field,
      publishedAt: item.publishedAt ?? null,
      retrievedAt: item.fetchedAt,
      sourceVersion: item.sourceVersion ?? null,
      format: item.format ?? null,
      license: item.license ?? null,
      extractor: { code: EXTRACTOR_VERSION, model: null },
      span: span ?? locate(fact.evidence.field, fact.evidence.text),
      entities: entity ? [entity] : [],
      units: { unit: fact.unit, currency: fact.currency },
    };
    out.push({ ...fact, entityKey: entity, recordKind: kind, demand, observedAt, epistemicClass, provenance });
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
    for (const d of locatedDays(text)) {
      const span = { start: d.index, end: d.index + d.text.length, text: d.text };
      push({ key: `date:${subject}:${d.day}`, field: 'date', value: d.day, unit: null, currency: null, evidence: ev(field, d.text) }, span);
    }
    for (const p of locatedPlaces(text)) push({ key: `location:${subject}`, field: 'location', value: p.place, unit: null, currency: null, evidence: ev(field, p.text) }, p.span);
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
