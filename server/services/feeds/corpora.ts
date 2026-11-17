/**
 * Large existing corpora, weighed before any crawler is built (ACQ-21-3).
 *
 * The named corpora below are concrete examples, not a data catalog: each one
 * must still be judged, per need, on the kind of fact the need wants, scope,
 * freshness, permitted use, data quality and whether it actually contributes
 * to the goal. Beside them sit open classes of domain-specific source
 * (associations, trade catalogs, rate sheets, filings, ...) that are judged by
 * exactly the same rule though no single corpus is named for them — so the
 * examples are never a whitelist (R01-A1, §18.1).
 *
 * Nothing here opens a source, owns a schedule or stores anything new:
 * `access.ts`/`accessMethods.ts` stay the way in, `feeds/run.ts` stays the
 * scheduler, and a decision is recorded through the existing `bin_events`
 * writer as a MEASURED `CORPUS_EVALUATION` row (§10.3, §20.4).
 *
 * How easy a source is to connect is deliberately not an input to the score:
 * no industry, geography or business model is privileged because one source
 * happened to be wired up first.
 */

import { recordBinEvent } from '../../repos/bins.ts';
import type { MethodClass } from '../sources/accessMethods.ts';

export const CORPUS_EVALUATION_EVENT = 'CORPUS_EVALUATION';

/** How current a corpus is, as its publisher states it. */
export type CorpusFreshness = 'CONTINUOUS' | 'DAILY' | 'PERIODIC' | 'HISTORICAL' | 'VARIES';

/** Days of lag a freshness class may carry at most, for comparison with a need. */
const FRESHNESS_LAG_DAYS: Record<CorpusFreshness, number> = {
  CONTINUOUS: 0.25,
  DAILY: 1,
  PERIODIC: 90,
  HISTORICAL: 365,
  // A class of sources is as fresh as the one found; unknown is never assumed favourable (inv. 39).
  VARIES: Number.POSITIVE_INFINITY,
};

export interface CorpusDescriptor {
  id: string;
  label: string;
  /** NAMED: one concrete corpus. DOMAIN_CLASS: an open class of domain sources, found per need. */
  kind: 'NAMED' | 'DOMAIN_CLASS';
  /** Official references, checked 2026-11-09. Empty for a class. */
  references: readonly string[];
  /** The kinds of fact it can supply. Open vocabulary; matching is by word. */
  factKinds: readonly string[];
  scope: string;
  freshness: CorpusFreshness;
  freshnessNote: string;
  permittedUse: string;
  /** 0..1: how far its records can be trusted for the facts it supplies. */
  quality: number;
  qualityNote: string;
  /** What it is not, carried onto every decision that applies it. */
  caveats: readonly string[];
  /** Fact kinds it supplies but must never be taken as proving alone. */
  notEvidenceOf: readonly string[];
  /** How to get at it: the method class and the route for a large job. */
  access: { method: MethodClass; route: string; largeJobRoute: string; pacing: string | null };
}

export const CORPORA: readonly CorpusDescriptor[] = [
  {
    id: 'common-crawl',
    label: 'Common Crawl',
    kind: 'NAMED',
    references: ['https://commoncrawl.org/get-started', 'https://index.commoncrawl.org/'],
    factKinds: ['web-page', 'domain-discovery', 'page-discovery', 'web-structure', 'historical-web'],
    scope: 'a massive archive of publicly crawled web content, with downloadable WARC records and URL (CDX) indexes',
    freshness: 'PERIODIC',
    freshnessNote: 'monthly-ish crawls of the past; not necessarily current',
    permittedUse: 'public crawl archive under the Common Crawl terms of use; the content of each page keeps its own rights',
    quality: 0.5,
    qualityNote: 'raw pages as crawled: broad, noisy, unverified',
    caveats: [
      'not evidence that a listed buyer currently needs a service',
      'not necessarily current',
      'query the CDX index and fetch only the matching WARC ranges; never copy the archive into the application server',
    ],
    notEvidenceOf: ['buyer-request', 'current-demand'],
    access: { method: 'BULK', route: 'CDX URL index, then byte-range WARC reads', largeJobRoute: 'filter in place by index, process in shards', pacing: null },
  },
  {
    id: 'sec-edgar',
    label: 'SEC EDGAR',
    kind: 'NAMED',
    references: ['https://www.sec.gov/search-filings/edgar-application-programming-interfaces'],
    factKinds: ['company-filing', 'financials', 'company-activity', 'industry-relationship', 'financial-condition', 'entity'],
    scope: 'US public company submissions and XBRL financial statements',
    freshness: 'DAILY',
    freshnessNote: 'keyless APIs update as filed; bulk ZIP archives refreshed nightly',
    permittedUse: 'public filings; the SEC fair-access rules apply (a declared User-Agent, no more than 10 requests a second)',
    quality: 0.9,
    qualityNote: 'primary, filed by the company under legal obligation',
    caveats: ['the SEC fair-access rules still apply: declared User-Agent, at most 10 requests a second', 'covers SEC registrants only'],
    notEvidenceOf: [],
    access: { method: 'NATIVE', route: 'data.sec.gov submissions and companyfacts APIs', largeJobRoute: 'nightly bulk ZIP archives', pacing: 'at most 10 requests a second with a declared User-Agent' },
  },
  {
    id: 'data-gov',
    label: 'Data.gov catalog',
    kind: 'NAMED',
    references: ['https://data.gov/developers/apis/'],
    factKinds: ['government-dataset', 'dataset-discovery', 'economic-indicator', 'regulatory', 'market-statistics'],
    scope: 'an extensive searchable catalog of US government datasets and their source locations',
    freshness: 'VARIES',
    freshnessNote: 'the catalog is current; each listed dataset is as fresh as its own provider keeps it',
    permittedUse: 'public government data; each dataset carries its provider’s licence',
    quality: 0.7,
    qualityNote: 'catalog metadata; the underlying data is as good as its provider',
    caveats: [
      'the CKAN API gives metadata and links, not the underlying dataset: retrieve the actual data from the listed provider',
      'public data about markets and companies does not imply pursuing prohibited government contracts',
    ],
    notEvidenceOf: ['government-contract-eligibility'],
    access: { method: 'NATIVE', route: 'CKAN package_search, then the provider’s own distribution URL', largeJobRoute: 'the provider’s bulk distribution', pacing: null },
  },
  {
    id: 'gdelt',
    label: 'GDELT',
    kind: 'NAMED',
    references: ['https://gdeltproject.org/data.html'],
    factKinds: ['news-event', 'event-trigger', 'market-change', 'knowledge-graph'],
    scope: 'structured records of global news events and knowledge-graph observations',
    freshness: 'CONTINUOUS',
    freshnessNote: 'updated every 15 minutes',
    permittedUse: 'open for research and commercial use with attribution',
    quality: 0.55,
    qualityNote: 'machine-coded from news; useful signal, noisy detail',
    caveats: ['useful for event triggers and changing market conditions', 'not proof of transaction demand without corroboration'],
    notEvidenceOf: ['buyer-request', 'current-demand', 'transaction-demand'],
    access: { method: 'BULK', route: 'DOC API for narrow queries; 15-minute export files', largeJobRoute: 'raw export files or BigQuery tables', pacing: 'no more than one DOC API request every five seconds' },
  },
  {
    id: 'wikidata',
    label: 'Wikidata',
    kind: 'NAMED',
    references: ['https://www.wikidata.org/wiki/Wikidata:Data_access'],
    factKinds: ['entity', 'entity-relationship', 'company-relationship', 'identifier'],
    scope: 'structured public entity and relationship data',
    freshness: 'CONTINUOUS',
    freshnessNote: 'live edits; weekly dumps',
    permittedUse: 'CC0 structured data',
    quality: 0.65,
    qualityNote: 'community-edited; strong on identifiers, uneven on small companies',
    caveats: ['for very large processing use the bulk dumps rather than overloading the public query endpoint'],
    notEvidenceOf: [],
    access: { method: 'NATIVE', route: 'SPARQL query service for small lookups', largeJobRoute: 'weekly JSON dumps', pacing: 'query service timeouts and limits apply' },
  },
  ...domainClasses(),
];

/** Open classes of domain-specific source. None is named; each is found per need and judged like any corpus. */
function domainClasses(): CorpusDescriptor[] {
  const cls = (id: string, label: string, factKinds: string[], scope: string, notEvidenceOf: string[] = []): CorpusDescriptor => ({
    id: `domain:${id}`,
    label,
    kind: 'DOMAIN_CLASS',
    references: [],
    factKinds,
    scope,
    freshness: 'VARIES',
    freshnessNote: 'as fresh as the source found; established when it is found',
    permittedUse: 'established per source found: its terms, licence and robots rules',
    quality: 0.6,
    qualityNote: 'established per source found',
    caveats: ['a class, not a source: discover the specific source for this need and judge its freshness and terms before relying on it'],
    notEvidenceOf,
    access: { method: 'BULK', route: 'discover the specific source, then select its access method', largeJobRoute: 'the source’s own export or bulk route', pacing: null },
  });
  return [
    cls('industry-associations', 'Industry associations', ['membership', 'supplier', 'industry-relationship', 'entity'], 'member directories and industry bodies'),
    cls('trade-catalogs', 'Trade catalogs', ['product-catalog', 'supplier', 'price', 'capacity'], 'published product and trade catalogs'),
    cls('rate-sheets', 'Public rate sheets', ['price', 'published-price', 'rate'], 'published prices and rate cards'),
    cls('permitted-marketplaces', 'Permitted marketplaces', ['buyer-request', 'current-demand', 'price', 'supplier', 'listing'], 'marketplaces whose terms permit this use'),
    cls('procurement-directories', 'Procurement and supplier directories', ['supplier', 'procurement', 'buyer-request', 'capacity'], 'procurement notices and supplier directories'),
    cls('business-filings', 'Business filings', ['company-filing', 'entity', 'company-activity'], 'state and national business registries and filings'),
    cls('regulatory-records', 'Regulatory records', ['regulatory', 'licence-record', 'compliance-deadline'], 'regulator registers, rules and enforcement records'),
    cls('archives', 'Archives', ['historical-record', 'historical-web'], 'institutional and public archives'),
    cls('inventory-feeds', 'Commercial inventory feeds', ['inventory', 'capacity', 'price', 'listing'], 'commercial inventory and availability feeds'),
    cls('transport-economic', 'Transportation and economic datasets', ['transport', 'economic-indicator', 'market-statistics', 'geography'], 'transportation, trade and economic statistics'),
    cls('academic-repositories', 'Institutional and academic repositories', ['academic', 'method', 'dataset-discovery'], 'institutional and academic data repositories'),
  ];
}

/** What a need wants. An unstated field is unknown, never favourable. */
export interface CorpusNeed {
  purpose: string;
  /** The kinds of fact the need consumes. */
  factKinds: readonly string[];
  /** The oldest a record may be and still answer the need, in days. */
  maxAgeDays?: number;
  /** The use the need will make of what is read: 'commercial', 'research', ... */
  intendedUse?: string;
  /** Uses ruled out for this need (e.g. 'government-contract'). */
  prohibitedUses?: readonly string[];
  /** The job processes a very large volume. */
  largeJob?: boolean;
  /** The lowest quality the need tolerates, 0..1 (default 0.4). */
  minQuality?: number;
  /**
   * Sources already connected. Recorded on the decision and deliberately not
   * used to rank: ease of connection is not a reason to privilege a source.
   */
  connected?: readonly string[];
}

export interface CorpusDecision {
  corpusId: string;
  label: string;
  kind: CorpusDescriptor['kind'];
  outcome: 'APPLIED' | 'SKIPPED';
  /** Why, in the need's own terms. */
  reason: string;
  /** Contribution to the goal, 0..1: the share of the need's fact kinds it supplies, times quality. */
  score: number;
  /** The fact kinds of the need it supplies (and may be relied on for). */
  supplies: readonly string[];
  /** Fact kinds it touches but must not prove alone; corroboration required. */
  needsCorroboration: readonly string[];
  scope: string;
  freshness: CorpusFreshness;
  permittedUse: string;
  quality: number;
  caveats: readonly string[];
  /** The route to use for this need's size. */
  route: string;
  pacing: string | null;
}

export interface CorporaEvaluation {
  purpose: string;
  decisions: CorpusDecision[];
  applied: string[];
  skipped: string[];
}

const norm = (s: string): string => s.toLowerCase().trim();

/**
 * Judge every corpus and domain class against one need. Pure.
 * A candidate is APPLIED when it supplies a fact the need consumes, is fresh
 * enough, its permitted use does not collide with the need's, and its quality
 * clears the need's floor; otherwise SKIPPED with the first failing reason.
 */
export function evaluateCorpora(need: CorpusNeed, corpora: readonly CorpusDescriptor[] = CORPORA): CorporaEvaluation {
  const wants = [...new Set(need.factKinds.map(norm).filter(Boolean))];
  const prohibited = (need.prohibitedUses ?? []).map(norm);
  const floor = need.minQuality ?? 0.4;
  const decisions: CorpusDecision[] = [];

  for (const c of corpora) {
    const kinds = c.factKinds.map(norm);
    const caveatOnly = c.notEvidenceOf.map(norm);
    const touched = wants.filter((w) => kinds.includes(w));
    const supplies = touched.filter((w) => !caveatOnly.includes(w));
    const needsCorroboration = wants.filter((w) => caveatOnly.includes(w));
    const score = wants.length ? Math.round((supplies.length / wants.length) * c.quality * 1000) / 1000 : 0;
    const route = need.largeJob ? c.access.largeJobRoute : c.access.route;

    let reason: string | null = null;
    if (supplies.length === 0) {
      reason = needsCorroboration.length
        ? `${c.label} is not evidence of ${needsCorroboration.join(', ')}: ${c.caveats[0] ?? 'it cannot answer this need alone'}`
        : `${c.label} supplies none of the facts this need consumes (${wants.join(', ') || 'none stated'})`;
    } else if (need.maxAgeDays !== undefined && FRESHNESS_LAG_DAYS[c.freshness] > need.maxAgeDays) {
      reason = `${c.label} is not fresh enough: ${c.freshnessNote}; the need tolerates ${need.maxAgeDays} day(s)`;
    } else if (prohibited.some((p) => norm(c.permittedUse).includes(p))) {
      reason = `${c.label}'s permitted use collides with a use ruled out for this need (${prohibited.join(', ')})`;
    } else if (c.quality < floor) {
      reason = `${c.label} quality ${c.quality} is below the need's floor ${floor}: ${c.qualityNote}`;
    }

    const applied = reason === null;
    decisions.push({
      corpusId: c.id,
      label: c.label,
      kind: c.kind,
      outcome: applied ? 'APPLIED' : 'SKIPPED',
      reason: applied
        ? `${c.label} supplies ${supplies.join(', ')} (${c.scope}); freshness ${c.freshnessNote}; use: ${c.permittedUse}; via ${route}` +
          (needsCorroboration.length ? `; ${needsCorroboration.join(', ')} needs corroboration elsewhere` : '')
        : reason!,
      score: applied ? score : 0,
      supplies,
      needsCorroboration,
      scope: c.scope,
      freshness: c.freshness,
      permittedUse: c.permittedUse,
      quality: c.quality,
      caveats: c.caveats,
      route,
      pacing: c.access.pacing,
    });
  }
  // Ranked by contribution only; connection state is not an input. Stable on the catalog order.
  const order = new Map(corpora.map((c, i) => [c.id, i]));
  decisions.sort((a, b) => b.score - a.score || (order.get(a.corpusId) ?? 0) - (order.get(b.corpusId) ?? 0));
  return {
    purpose: need.purpose,
    decisions,
    applied: decisions.filter((d) => d.outcome === 'APPLIED').map((d) => d.corpusId),
    skipped: decisions.filter((d) => d.outcome === 'SKIPPED').map((d) => d.corpusId),
  };
}

/**
 * Evaluate and record the decision as one MEASURED `CORPUS_EVALUATION` row on
 * the existing bin-event writer — when and why each candidate was applied or
 * skipped. No new table.
 */
export async function recordCorporaEvaluation(
  need: CorpusNeed,
  deps: { record?: typeof recordBinEvent; caller?: string; projectId?: string | null } = {},
): Promise<CorporaEvaluation> {
  const evaluation = evaluateCorpora(need);
  const record = deps.record ?? recordBinEvent;
  await record({
    eventType: CORPUS_EVALUATION_EVENT,
    workloadClass: deps.caller ?? 'acquisition',
    projectId: deps.projectId ?? null,
    outcome: evaluation.applied.length ? 'APPLIED' : 'NONE_APPLIED',
    reason: (evaluation.applied.length
      ? `Applied ${evaluation.applied.join(', ')} for: ${need.purpose}`
      : `No existing corpus answers: ${need.purpose}`
    ).slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: {
      purpose: need.purpose.slice(0, 300),
      factKinds: need.factKinds,
      maxAgeDays: need.maxAgeDays ?? null,
      largeJob: Boolean(need.largeJob),
      connected: need.connected ?? [],
      connectionRanked: false,
      decisions: evaluation.decisions.map((d) => ({
        corpus: d.corpusId,
        outcome: d.outcome,
        score: d.score,
        reason: d.reason.slice(0, 300),
        needsCorroboration: d.needsCorroboration,
      })),
    },
  });
  return evaluation;
}

// ---------------------------------------------------------------------------
// Discovery from a real unknown, and adding what pays (ACQ-21-3)
// ---------------------------------------------------------------------------

/** The share of a need a corpus must answer, times its quality, before connecting it is proposed. */
export const CORPUS_PROPOSAL_MIN_SCORE = 0.5;

/** A word as compared: lower case, a trailing plural `s` dropped. */
const stem = (word: string): string => {
  const w = word.toLowerCase();
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
};

/**
 * The fact kinds a piece of research text asks for, read against the catalog's
 * own open vocabulary. Pure. A kind matches when every word of it appears in
 * the text ("company-filing" in "which company filed …" matches; "price" in
 * "what price do suppliers publish" matches). Nothing is invented: a text that
 * names no catalogued kind of fact yields none, and its need is recorded as one
 * no corpus answers.
 */
export function factKindsIn(text: string, corpora: readonly CorpusDescriptor[] = CORPORA): string[] {
  const words = new Set(text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(stem));
  const vocabulary = [...new Set(corpora.flatMap((c) => c.factKinds.map(norm)))];
  return vocabulary.filter((kind) => kind.split('-').filter(Boolean).every((part) => words.has(stem(part)))).sort();
}

/** A research unknown, as the feed loop derives it (`MissingLinkQuestion`), reduced to what a need reads. */
export interface ResearchUnknown {
  key: string;
  question: string;
  condition: string;
}

/**
 * The need a research unknown states. Pure. Its fact kinds come from the
 * unknown's own words, so the need is the goal's, never a connected source's
 * declaration of itself; `connected` is carried for the record and never ranks.
 */
export function needFromUnknown(unknown: ResearchUnknown, connected: readonly string[], corpora: readonly CorpusDescriptor[] = CORPORA): CorpusNeed {
  return {
    purpose: `missing link ${unknown.key}: ${unknown.question}`.slice(0, 300),
    factKinds: factKindsIn(`${unknown.question} ${unknown.condition}`, corpora),
    intendedUse: 'commercial',
    connected,
  };
}

/**
 * The corpus worth connecting for this need, or null. Pure.
 *
 * Only when the best-ranked applied candidate is not already connected, and it
 * answers enough of the need (`CORPUS_PROPOSAL_MIN_SCORE`): a corpus that a
 * connected source already matches or beats adds nothing, and one that answers
 * too little does not pay for a connector.
 */
export function corpusToAdd(evaluation: CorporaEvaluation, connected: ReadonlySet<string>): CorpusDecision | null {
  const best = evaluation.decisions.find((d) => d.outcome === 'APPLIED') ?? null;
  if (!best || connected.has(best.corpusId) || best.score < CORPUS_PROPOSAL_MIN_SCORE) return null;
  const connectedBest = evaluation.decisions.find((d) => d.outcome === 'APPLIED' && connected.has(d.corpusId));
  if (connectedBest && connectedBest.score >= best.score) return null;
  return best;
}

/** The weakness key an unconnected corpus is proposed under: one per corpus, however many needs it answers. */
export function corpusProposalKey(corpusId: string): string {
  return `CORPUS_UNCONNECTED:${corpusId}`;
}
