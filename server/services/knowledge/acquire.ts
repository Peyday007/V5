/**
 * Acquiring public commercial datasets (§122): what Brain reads, how it finds
 * the newest release itself, and how one read becomes classified facts.
 *
 * Reuses the feeds' conditional-read contract (`feeds/access.ts`: validators,
 * content hash, NOT_MODIFIED) over bytes rather than text, because the Census
 * publishes its bulk files as ZIP archives. A family names a publisher's
 * dataset series; discovery reads the publisher's own directory listing for
 * the newest vintage, registers it, and supersedes the older one (whose facts
 * stay). A read that fails backs off exponentially and is retried on a later
 * pass; nothing waits on a person.
 *
 * Parsing is deterministic: each family's reader maps the publisher's columns
 * onto `METRICS`. A withheld cell (the Census suppression flag `D`, or `N`
 * "not available") is recorded as UNKNOWN, never as zero.
 */
import JSZip from 'jszip';
import { conditionalHeaders, contentHashOf, type Validators } from '../feeds/access.ts';
import {
  METRICS,
  geoCode,
  geoLabel,
  naicsLevel,
  normaliseNaics,
  validUntilOf,
  type Epistemic,
  type Metric,
} from '../../domain/commercialKnowledge.ts';
import type { NewFact } from '../../repos/commercialKnowledge.ts';
import type { SourceDefinition } from '../../repos/commercialKnowledge.ts';

export const USER_AGENT = process.env['SEC_EDGAR_USER_AGENT']?.trim() || 'Brain research-operations brain-knowledge/1.0';

/* ---------------------------------------------------------------- transport */

export interface BytesResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
export type BytesTransport = (url: string, headers: Record<string, string>, timeoutMs?: number) => Promise<BytesResponse>;

export const httpBytesTransport: BytesTransport = async (url, headers, timeoutMs = 180_000) => {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: response.status, headers: out, body: response.status === 304 ? new Uint8Array() : new Uint8Array(await response.arrayBuffer()) };
};

function header(headers: Record<string, string | undefined>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want && typeof v === 'string' && v !== '') return v;
  return null;
}

export type BytesResult =
  | { status: 'NOT_MODIFIED'; httpStatus: number; validators: Validators; reason: string }
  | { status: 'MODIFIED'; httpStatus: number; body: Uint8Array; validators: Validators; contentHash: string };

/**
 * The feeds' conditional read over bytes: a 304 or an unchanged hash is
 * NOT_MODIFIED; any other non-2xx throws, so a refusal (a redirect to a
 * key page, a 403) is never mistaken for "unchanged".
 */
export async function conditionalBytes(transport: BytesTransport, url: string, prior: Validators | null): Promise<BytesResult> {
  const response = await transport(url, conditionalHeaders(prior));
  const etag = header(response.headers, 'etag');
  const lastModified = header(response.headers, 'last-modified');
  if (response.status === 304) {
    return { status: 'NOT_MODIFIED', httpStatus: 304, validators: { etag: etag ?? prior?.etag ?? null, lastModified: lastModified ?? prior?.lastModified ?? null, contentHash: prior?.contentHash ?? null }, reason: '304 Not Modified' };
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  const contentHash = contentHashOf(Buffer.from(response.body).toString('latin1'));
  const validators: Validators = { etag, lastModified, contentHash };
  if (prior?.contentHash && prior.contentHash === contentHash) return { status: 'NOT_MODIFIED', httpStatus: response.status, validators, reason: 'the content hash equals the stored one' };
  return { status: 'MODIFIED', httpStatus: response.status, body: response.body, validators, contentHash };
}

/** The text of a dataset: the first .txt or .csv inside a ZIP, or the body itself. */
export async function datasetText(url: string, body: Uint8Array): Promise<string> {
  if (/\.zip($|\?)/i.test(url) || (body[0] === 0x50 && body[1] === 0x4b)) {
    const zip = await JSZip.loadAsync(body);
    const entry = Object.values(zip.files).find((f) => !f.dir && /\.(txt|csv)$/i.test(f.name));
    if (!entry) throw new Error('the archive holds no .txt or .csv file');
    return entry.async('string');
  }
  return Buffer.from(body).toString('utf8');
}

/* -------------------------------------------------------------------- CSV */

/** One CSV line, honouring double-quoted fields. */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Each data row as a record keyed by the header's lower-cased names. */
export function* csvRecords(text: string): Generator<Record<string, string>> {
  let start = 0;
  let header: string[] | null = null;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (!line.trim()) continue;
    const fields = csvFields(line);
    if (!header) {
      header = fields.map((f) => f.trim().toLowerCase());
      continue;
    }
    const record: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) record[header[i]!] = (fields[i] ?? '').trim();
    yield record;
  }
}

/* ------------------------------------------------------------------ parsing */

export interface ParsedDataset {
  facts: NewFact[];
  titles: { naics: string; label: string }[];
  rows: number;
}

export interface ParseContext {
  sourceId: string;
  acquisitionId: string | null;
  sourceTitle: string;
  sourceUrl: string;
  family: string;
  period: string;
  acquiredAt: string;
}

/** A Census suppression or "not available" flag: the cell is withheld, not zero. */
const WITHHELD = /^[DNSX]$/i;

function makeFact(ctx: ParseContext, metric: Metric, naics: string, stateFips: string | null, sizeClass: string, value: number, epistemic: Epistemic, label: string | null, basis: string): NewFact {
  const geo = geoCode(stateFips);
  return {
    subject_key: `${ctx.family}|${metric}|${naics}|${geo}|${sizeClass}|${ctx.period}`,
    metric,
    value,
    unit: METRICS[metric].unit,
    metric_class: METRICS[metric].class,
    epistemic,
    naics,
    naics_level: naicsLevel(naics),
    industry_label: label,
    geo_code: geo,
    geo_label: geoLabel(geo),
    size_class: sizeClass,
    period: ctx.period,
    basis,
    inputs: null,
    source_id: ctx.sourceId,
    acquisition_id: ctx.acquisitionId,
    source_title: ctx.sourceTitle,
    source_url: ctx.sourceUrl,
    quality: 'PRIMARY',
    observed_at: `${ctx.period}-12-31T00:00:00.000Z`,
    valid_until: validUntilOf(ctx.family, ctx.acquiredAt),
  };
}

function cell(ctx: ParseContext, out: NewFact[], metric: Metric, naics: string, state: string | null, size: string, raw: string | undefined, flag: string | undefined, scale: number, label: string | null, column: string): void {
  const n = Number((raw ?? '').replace(/,/g, ''));
  const withheld = (flag && WITHHELD.test(flag.trim())) || raw === undefined || raw === '' || !Number.isFinite(n);
  out.push(
    withheld
      ? makeFact(ctx, metric, naics, state, size, 0, 'UNKNOWN', label, `${column}: withheld by the publisher (flag ${flag || 'blank'})`)
      : makeFact(ctx, metric, naics, state, size, n * scale, 'FACT', label, `${column}${scale !== 1 ? ` × ${scale}` : ''}, as published`),
  );
}

/**
 * Statistics of U.S. Businesses, the economic-census year with receipts
 * (`us_state_6digitnaics_<year>.txt`): national figures for every industry
 * and size class. Its industry titles are the
 * classification's own words and become `knowledge_industries`.
 */
export function parseSusb(text: string, ctx: ParseContext): ParsedDataset {
  const facts: NewFact[] = [];
  const titles = new Map<string, string>();
  let rows = 0;
  for (const r of csvRecords(text)) {
    rows++;
    const naics = normaliseNaics(r['naics'] ?? '');
    if (!naics) continue;
    const label = r['naicsdscr'] || null;
    if (label && naics !== '00') titles.set(naics, label);
    const size = r['entrsize'] === '01' ? 'ALL' : r['entrsize'] === '05' ? 'SMALL' : null;
    if (!size) continue;
    const state = r['state'] ?? '00';
    if (state === '00') {
      cell(ctx, facts, 'FIRMS', naics, null, size, r['firm'], undefined, 1, label, 'FIRM');
      cell(ctx, facts, 'ESTABLISHMENTS', naics, null, size, r['estb'], undefined, 1, label, 'ESTB');
      // A range flag (EMPLFL_R) means the employment cell was withheld and printed as 0.
      cell(ctx, facts, 'EMPLOYMENT', naics, null, size, r['empl'], r['emplfl_r'] ? 'D' : r['emplfl_n'], 1, label, 'EMPL');
      cell(ctx, facts, 'ANNUAL_PAYROLL', naics, null, size, r['payr'], r['payrfl_n'], 1000, label, 'PAYR ($1,000)');
      if ('rcpt' in r) cell(ctx, facts, 'RECEIPTS', naics, null, size, r['rcpt'], r['rcptfl_n'], 1000, label, 'RCPT ($1,000)');
    }
    // A state's count of businesses comes from County Business Patterns (CBP_STATE); the SUSB state rows would repeat it.
  }
  return { facts, titles: [...titles].map(([naics, label]) => ({ naics, label })), rows };
}

/**
 * County Business Patterns, national (`cbp<yy>us.zip`) or by state
 * (`cbp<yy>st.zip`): establishments, employment and payroll for all legal
 * forms (LFO `-`), and the establishments under 20 employees.
 */
export function parseCbp(text: string, ctx: ParseContext): ParsedDataset {
  const facts: NewFact[] = [];
  let rows = 0;
  for (const r of csvRecords(text)) {
    rows++;
    if ((r['lfo'] ?? '-') !== '-') continue;
    const naics = normaliseNaics(r['naics'] ?? '');
    if (!naics) continue;
    const stateRaw = r['fipstate'] ?? null;
    const state = stateRaw && stateRaw !== '98' ? stateRaw.padStart(2, '0') : null;
    cell(ctx, facts, 'ESTABLISHMENTS', naics, state, 'ALL', r['est'], undefined, 1, null, 'EST');
    const small = ['n<5', 'n5_9', 'n10_19'].map((k) => Number(r[k] ?? 'NaN'));
    if (small.every((v) => Number.isFinite(v))) {
      facts.push(makeFact(ctx, 'SMALL_ESTABLISHMENTS', naics, state, 'ALL', small.reduce((a, b) => a + b, 0), 'FACT', null, 'N<5 + N5_9 + N10_19, as published'));
    }
    if (!state) {
      cell(ctx, facts, 'EMPLOYMENT', naics, null, 'ALL', r['emp'], r['emp_nf'] === 'D' ? 'D' : undefined, 1, null, 'EMP');
      cell(ctx, facts, 'ANNUAL_PAYROLL', naics, null, 'ALL', r['ap'], r['ap_nf'] === 'D' ? 'D' : undefined, 1000, null, 'AP ($1,000)');
    }
  }
  return { facts, titles: [], rows };
}

/** Nonemployer Statistics (`nonemp<yy>us.zip`): businesses with no paid employees, and their receipts. */
export function parseNonemployer(text: string, ctx: ParseContext): ParsedDataset {
  const facts: NewFact[] = [];
  let rows = 0;
  for (const r of csvRecords(text)) {
    rows++;
    if ((r['lfo'] ?? '-') !== '-' || (r['rcptot_size'] ?? '001') !== '001') continue;
    const naics = normaliseNaics(r['naics'] ?? '');
    if (!naics) continue;
    const st = r['st'] ?? '00';
    const state = st === '00' ? null : st;
    cell(ctx, facts, 'NONEMPLOYER_ESTABLISHMENTS', naics, state, 'ALL', r['estab'], r['estab_f'] || undefined, 1, null, 'ESTAB');
    cell(ctx, facts, 'NONEMPLOYER_RECEIPTS', naics, state, 'ALL', r['rcptot'], r['rcptot_f'] || undefined, 1000, null, 'RCPTOT ($1,000)');
  }
  return { facts, titles: [], rows };
}

export const PARSERS: Record<string, (text: string, ctx: ParseContext) => ParsedDataset> = {
  SUSB: parseSusb,
  SUSB_RECEIPTS: parseSusb,
  CBP: parseCbp,
  CBP_STATE: parseCbp,
  CBP_CENSUS_YEAR: parseCbp,
  NES: parseNonemployer,
};

/* ---------------------------------------------------------------- discovery */

const CENSUS = 'https://www2.census.gov/programs-surveys';

/** The links of a directory listing, relative names only. */
export function listingLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href="([^"?#:]+)"/g)) {
    const href = m[1]!;
    if (href.startsWith('/') || href.startsWith('.')) continue;
    out.push(href);
  }
  return out;
}

export type TextFetch = (url: string) => Promise<string>;

export const httpText: TextFetch = async (url) => {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000), redirect: 'manual' });
  if (response.status !== 200) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
};

interface Family {
  family: string;
  publisher: string;
  title: (year: string) => string;
  valueReason: string;
  /** The newest vintage the publisher's listing shows, as a source to read. */
  discover: (get: TextFetch, context: { receiptsYear: string | null }) => Promise<{ url: string; period: string } | null>;
}

async function yearsUnder(get: TextFetch, url: string): Promise<string[]> {
  return listingLinks(await get(url))
    .map((h) => /^(\d{4})\/$/.exec(h)?.[1])
    .filter((y): y is string => !!y)
    .sort((a, b) => b.localeCompare(a));
}

/** The newest year whose listing holds a file this pattern names. */
async function newestWith(get: TextFetch, base: string, file: (year: string) => string, sub = '', maxYears = 8, keep: (year: string) => boolean = () => true): Promise<{ url: string; period: string } | null> {
  for (const year of (await yearsUnder(get, `${base}/`)).filter(keep).slice(0, maxYears)) {
    const dir = `${base}/${year}/${sub}`;
    const links = await get(dir).then(listingLinks).catch(() => [] as string[]);
    const name = file(year);
    if (links.includes(name)) return { url: `${dir}${name}`, period: year };
  }
  return null;
}

const yy = (year: string) => year.slice(2);

export const FAMILIES: Family[] = [
  {
    family: 'SUSB_RECEIPTS',
    publisher: 'U.S. Census Bureau, Statistics of U.S. Businesses',
    title: (y) => `Statistics of U.S. Businesses ${y} (economic census year): firms, employment, payroll and receipts by 6-digit NAICS, state and enterprise size`,
    valueReason: 'the only free source of receipts per firm by detailed industry and size: revenue, labour cost share and small-firm economics',
    // Receipts are collected only in economic-census years (those ending in 2 or 7).
    discover: (get) => newestWith(get, `${CENSUS}/susb/datasets`, (y) => `us_state_6digitnaics_${y}.txt`, '', 4, (y) => Number(y) % 5 === 2),
  },
  {
    family: 'SUSB',
    publisher: 'U.S. Census Bureau, Statistics of U.S. Businesses',
    title: (y) => `Statistics of U.S. Businesses ${y}: firms, establishments, employment and payroll by 6-digit NAICS, state and enterprise size`,
    valueReason: 'the newest count of firms by enterprise size: how many small firms of a kind exist, and their payroll',
    discover: (get) => newestWith(get, `${CENSUS}/susb/datasets`, (y) => `us_state_6digitnaics_${y}.txt`),
  },
  {
    family: 'CBP',
    publisher: 'U.S. Census Bureau, County Business Patterns',
    title: (y) => `County Business Patterns ${y}: U.S. establishments, employment and payroll by NAICS`,
    valueReason: 'the newest annual count of employer establishments per industry: how many buyers of a kind exist, and their payroll',
    discover: (get) => newestWith(get, `${CENSUS}/cbp/datasets`, (y) => `cbp${yy(y)}us.zip`),
  },
  {
    family: 'CBP_STATE',
    publisher: 'U.S. Census Bureau, County Business Patterns',
    title: (y) => `County Business Patterns ${y}: establishments by state and NAICS`,
    valueReason: 'buyer counts per state, so a goal that names a market is sized for that market',
    discover: (get) => newestWith(get, `${CENSUS}/cbp/datasets`, (y) => `cbp${yy(y)}st.zip`),
  },
  {
    family: 'CBP_CENSUS_YEAR',
    publisher: 'U.S. Census Bureau, County Business Patterns',
    title: (y) => `County Business Patterns ${y} (the economic-census year): U.S. establishments, employment and payroll by NAICS`,
    valueReason: 'the same year as the receipts survey, so the two programs can be checked against each other and receipts carried forward by payroll',
    discover: async (get, { receiptsYear }) => {
      if (!receiptsYear) return null;
      const dir = `${CENSUS}/cbp/datasets/${receiptsYear}/`;
      const name = `cbp${yy(receiptsYear)}us.zip`;
      const links = await get(dir).then(listingLinks).catch(() => [] as string[]);
      return links.includes(name) ? { url: `${dir}${name}`, period: receiptsYear } : null;
    },
  },
  {
    family: 'NES',
    publisher: 'U.S. Census Bureau, Nonemployer Statistics',
    title: (y) => `Nonemployer Statistics ${y}: businesses without employees and their receipts by NAICS`,
    valueReason: 'what a business with no employees takes in per industry: the economics of solo and owner-operated work',
    discover: (get) => newestWith(get, `${CENSUS}/nonemployer-statistics/datasets`, (y) => `nonemp${yy(y)}us.zip`, 'historical-datasets/'),
  },
];

/** The registration a discovered vintage becomes. */
export function sourceFor(family: Family, found: { url: string; period: string }, origin: 'CATALOG' | 'DISCOVERED'): SourceDefinition {
  return {
    sourceKey: `${family.family.toLowerCase()}-${found.period}`,
    family: family.family,
    title: family.title(found.period),
    publisher: family.publisher,
    url: found.url,
    period: found.period,
    format: /\.zip$/i.test(found.url) ? 'ZIP/CSV' : 'CSV',
    origin,
    discoveredFrom: found.url.replace(/[^/]+$/, ''),
    valueReason: family.valueReason,
  };
}

/**
 * Other Census programs that publish NAICS-coded bulk files and that no
 * reader covers yet: candidates, named with what was found, so the gap is a
 * row (and the Command Center shows it) rather than a silence. Bounded: a
 * window of programs per call, rotated by the hour.
 */
export async function discoverCandidatePrograms(get: TextFetch, known: ReadonlySet<string>, hour: number, window = 4): Promise<SourceDefinition[]> {
  const programs = listingLinks(await get(`${CENSUS}/`))
    .filter((h) => /^[a-z0-9-]+\/$/.test(h))
    .map((h) => h.slice(0, -1))
    .filter((p) => !['cbp', 'susb', 'nonemployer-statistics'].includes(p))
    .sort();
  if (programs.length === 0) return [];
  const start = (hour * window) % programs.length;
  const out: SourceDefinition[] = [];
  for (const program of [...programs, ...programs].slice(start, start + window)) {
    const datasets = `${CENSUS}/${program}/datasets/`;
    const years = await yearsUnder(get, datasets).catch(() => [] as string[]);
    const year = years[0];
    if (!year) continue;
    const files = await get(`${datasets}${year}/`).then(listingLinks).catch(() => [] as string[]);
    const naicsFile = files.find((f) => /naics|ind/i.test(f) && /\.(zip|txt|csv|xlsx)$/i.test(f));
    if (!naicsFile) continue;
    const key = `candidate-${program}-${year}`;
    if (known.has(key)) continue;
    out.push({
      sourceKey: key,
      family: `CANDIDATE:${program}`,
      title: `Census ${program} ${year}: ${naicsFile}`,
      publisher: `U.S. Census Bureau (${program})`,
      url: `${datasets}${year}/${naicsFile}`,
      period: year,
      format: naicsFile.split('.').pop()!.toUpperCase(),
      origin: 'DISCOVERED',
      discoveredFrom: datasets,
      valueReason: `an industry-coded (${naicsFile}) dataset Brain found in the Census ${program} program; no reader maps its columns yet`,
      status: 'CANDIDATE',
    });
  }
  return out;
}

/* ------------------------------------------------------------------- retries */

export const READ_RECHECK_MS = 7 * 86_400_000;
export const RETRY_BASE_MS = 20 * 60_000;

/** After a success, look again in a week (a conditional read costs a 304); after failures, back off exponentially to that week. */
export function nextDueAfter(now: Date, ok: boolean, consecutiveFailures: number): string {
  if (ok) return new Date(now.getTime() + READ_RECHECK_MS).toISOString();
  const wait = Math.min(READ_RECHECK_MS, RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures));
  return new Date(now.getTime() + wait).toISOString();
}
