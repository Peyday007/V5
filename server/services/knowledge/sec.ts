/**
 * SEC XBRL frames read into sector economics (§122): what public companies'
 * own filings say about margins, the cash cycle and capital intensity — the
 * three things the Census business counts cannot.
 *
 * A frame (`data.sec.gov/api/xbrl/frames/…`) is one reported concept for every
 * filer in one calendar period. Each company's ratios are computed from its own
 * figures for that period, and the sector's figure is the median of its
 * companies (at least `MIN_COMPANIES`): an ESTIMATE, its inputs named. The
 * filer's industry comes from EDGAR's own index of the year's 10-K filings
 * (its SIC code), folded onto the NAICS sector by the published SIC-division
 * correspondence below — a sector-level link, stated as such.
 *
 * SEC fair access: a declared User-Agent and well under ten requests a second.
 */
import { METRICS, geoLabel, validUntilOf, type Metric } from '../../domain/commercialKnowledge.ts';
import type { NewFact } from '../../repos/commercialKnowledge.ts';
import { USER_AGENT } from './acquire.ts';
import { contentHashOf } from '../feeds/access.ts';

export type JsonFetch = (url: string) => Promise<unknown>;

const SPACING_MS = 150;
let lastCallAt = 0;

/** One SEC read, paced, and retried twice with backoff when the service answers 429 or 5xx. */
export const httpJson: JsonFetch = async (url) => {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCallAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) return null;
    if (response.status === 200) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 3 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
};

/**
 * SIC two-digit major groups onto NAICS sectors, following the Census
 * SIC-to-NAICS correspondence at the division level. Where a division splits
 * across sectors the major group decides (48 communications → 51, 49
 * utilities → 22, 65 real estate → 53, 73 business services → 54, 7370s
 * computer services → 51).
 */
export function sectorOfSic(sic: string): string | null {
  const n = Number(sic.slice(0, 2));
  if (!/^\d{2}/.test(sic)) return null;
  if (sic.startsWith('737')) return '51';
  if (n === 58 || n === 70) return '72';
  if (n === 48) return '51';
  if (n === 49) return '22';
  if (n === 65) return '53';
  if (n === 80 || n === 83) return '62';
  if (n === 82) return '61';
  if (n === 72 || n === 75 || n === 76) return '81';
  if (n === 73 || n === 81 || n === 87 || n === 89) return '54';
  if (n === 78 || n === 79 || n === 84) return '71';
  if (n >= 1 && n <= 9) return '11';
  if (n >= 10 && n <= 14) return '21';
  if (n >= 15 && n <= 17) return '23';
  if (n >= 20 && n <= 39) return '31';
  if (n >= 40 && n <= 47) return '48';
  if (n === 50 || n === 51) return '42';
  if (n >= 52 && n <= 59) return '44';
  if ((n >= 60 && n <= 64) || n === 67) return '52';
  if (n >= 91 && n <= 99) return '92';
  return null;
}

interface Frame {
  data?: { cik: number; val: number; start?: string; end?: string }[];
}

const DURATION_CONCEPTS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
  cost: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
  gross: ['GrossProfit'],
  operating: ['OperatingIncomeLoss'],
} as const;
const INSTANT_CONCEPTS = {
  receivables: ['AccountsReceivableNetCurrent'],
  inventory: ['InventoryNet'],
  fixedAssets: ['PropertyPlantAndEquipmentNet'],
} as const;

/** Each company's value of the first concept that reports it. */
async function values(fetchJson: JsonFetch, concepts: readonly string[], period: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const concept of concepts) {
    const frame = (await fetchJson(`https://data.sec.gov/api/xbrl/frames/us-gaap/${concept}/USD/${period}.json`)) as Frame | null;
    for (const row of frame?.data ?? []) if (!out.has(row.cik) && Number.isFinite(row.val)) out.set(row.cik, row.val);
  }
  return out;
}

/** The SIC code of every company that filed a 10-K in the year after the period, from EDGAR's own index. */
async function sicByCompany(fetchJson: JsonFetch, filingYear: number, maxPages = 120): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  type Page = { timed_out?: boolean; hits?: { total?: { value?: number }; hits?: { _source?: { ciks?: string[]; sics?: string[] } }[] } } | null;
  let total = Infinity;
  for (let page = 0; page < maxPages && page * 100 < Math.min(total, 10_000); page++) {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=10-K&dateRange=custom&startdt=${filingYear}-01-01&enddt=${filingYear}-12-31&from=${page * 100}`;
    // The index sometimes answers a page partially (a shard timed out): asked once more before it is taken.
    let body: Page;
    try {
      body = (await fetchJson(url)) as Page;
    } catch {
      // One page the index will not serve is a gap in the classification, not a failed read.
      continue;
    }
    const expected = (b: Page) => Math.min(100, (b?.hits?.total?.value ?? 0) - page * 100);
    if (body && (body.timed_out || (body.hits?.hits?.length ?? 0) < expected(body))) body = ((await fetchJson(url)) as Page) ?? body;
    total = body?.hits?.total?.value ?? 0;
    for (const hit of body?.hits?.hits ?? []) {
      const cik = Number(hit._source?.ciks?.[0]);
      const sic = hit._source?.sics?.[0];
      if (Number.isFinite(cik) && sic) out.set(cik, sic);
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const MIN_COMPANIES = 5;

export interface SecContext {
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  year: number;
  acquiredAt: string;
}

/** Read one calendar year of frames into per-sector medians. */
export async function readSecYear(fetchJson: JsonFetch, ctx: SecContext): Promise<{ facts: NewFact[]; rows: number; contentHash: string }> {
  const duration = `CY${ctx.year}`;
  const instant = `CY${ctx.year}Q4I`;
  const revenue = await values(fetchJson, DURATION_CONCEPTS.revenue, duration);
  const cost = await values(fetchJson, DURATION_CONCEPTS.cost, duration);
  const gross = await values(fetchJson, DURATION_CONCEPTS.gross, duration);
  const operating = await values(fetchJson, DURATION_CONCEPTS.operating, duration);
  const receivables = await values(fetchJson, INSTANT_CONCEPTS.receivables, instant);
  const inventory = await values(fetchJson, INSTANT_CONCEPTS.inventory, instant);
  const fixedAssets = await values(fetchJson, INSTANT_CONCEPTS.fixedAssets, instant);
  const sic = await sicByCompany(fetchJson, ctx.year + 1);

  const perSector = new Map<string, Record<string, number[]>>();
  let rows = 0;
  for (const [cik, rev] of revenue) {
    if (!(rev > 1_000_000)) continue;
    const code = sic.get(cik);
    const sector = code ? sectorOfSic(code) : null;
    if (!sector) continue;
    rows++;
    const bag = perSector.get(sector) ?? { companies: [], gross: [], operating: [], receivable: [], inventory: [], fixed: [] };
    bag['companies']!.push(cik);
    const g = gross.get(cik) ?? (cost.has(cik) ? rev - cost.get(cik)! : undefined);
    if (g !== undefined && Math.abs(g / rev) <= 1) bag['gross']!.push(g / rev);
    const o = operating.get(cik);
    if (o !== undefined && o / rev >= -2 && o / rev <= 1) bag['operating']!.push(o / rev);
    const ar = receivables.get(cik);
    if (ar !== undefined && ar >= 0) bag['receivable']!.push((ar / rev) * 365);
    const inv = inventory.get(cik);
    const cogs = cost.get(cik) ?? (g !== undefined ? rev - g : undefined);
    if (inv !== undefined && inv >= 0 && cogs && cogs > 0) bag['inventory']!.push((inv / cogs) * 365);
    const ppe = fixedAssets.get(cik);
    if (ppe !== undefined && ppe >= 0) bag['fixed']!.push(ppe / rev);
    perSector.set(sector, bag);
  }

  const facts: NewFact[] = [];
  const period = String(ctx.year);
  const put = (metric: Metric, sector: string, value: number, n: number, basis: string) =>
    facts.push({
      subject_key: `SEC_XBRL|${metric}|${sector}|US|ALL|${period}`,
      metric,
      value: Math.round(value * 10_000) / 10_000,
      unit: METRICS[metric].unit,
      metric_class: METRICS[metric].class,
      epistemic: metric === 'PUBLIC_COMPANIES' ? 'FACT' : 'ESTIMATE',
      naics: sector,
      naics_level: 2,
      industry_label: null,
      geo_code: 'US',
      geo_label: geoLabel('US'),
      size_class: 'PUBLIC',
      period,
      basis: `${basis}; ${n} SEC registrants whose 10-K names an SIC code in this sector (SIC major group → NAICS sector correspondence)`,
      inputs: null,
      source_id: ctx.sourceId,
      acquisition_id: null,
      source_title: ctx.sourceTitle,
      source_url: ctx.sourceUrl,
      quality: metric === 'PUBLIC_COMPANIES' ? 'PRIMARY' : 'DERIVED',
      observed_at: `${period}-12-31T00:00:00.000Z`,
      valid_until: validUntilOf('SEC_XBRL', ctx.acquiredAt),
    });
  for (const [sector, bag] of perSector) {
    put('PUBLIC_COMPANIES', sector, bag['companies']!.length, bag['companies']!.length, 'companies reporting revenue over $1 million');
    const metric = (key: string, m: Metric, basis: string) => {
      const xs = bag[key]!;
      if (xs.length >= MIN_COMPANIES) put(m, sector, median(xs), xs.length, `median of ${basis}`);
    };
    metric('gross', 'GROSS_MARGIN', 'gross profit ÷ revenue');
    metric('operating', 'OPERATING_MARGIN', 'operating income ÷ revenue');
    metric('receivable', 'RECEIVABLE_DAYS', 'year-end receivables ÷ revenue × 365');
    metric('inventory', 'INVENTORY_DAYS', 'year-end inventory ÷ cost of revenue × 365');
    metric('fixed', 'FIXED_ASSETS_PER_REVENUE', 'net property, plant and equipment ÷ revenue');
  }
  const contentHash = contentHashOf(JSON.stringify(facts.map((f) => [f.subject_key, f.value])));
  return { facts, rows, contentHash };
}

/** The newest calendar year whose revenue frame is substantially filed. */
export async function newestSecYear(fetchJson: JsonFetch, now: Date): Promise<number | null> {
  for (let year = now.getUTCFullYear() - 1; year >= now.getUTCFullYear() - 3; year--) {
    const frame = (await fetchJson(`https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY${year}.json`)) as (Frame & { pts?: number }) | null;
    if ((frame?.pts ?? frame?.data?.length ?? 0) >= 1000) return year;
  }
  return null;
}
