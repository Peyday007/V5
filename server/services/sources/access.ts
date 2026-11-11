/**
 * Reading a public source by whichever legitimate route reaches it.
 *
 * Production, 2026-11-04: in 24 hours the free lane submitted 9 research
 * fragments and failed 116, and the failures it recorded were almost all "no
 * readable source": the site answered 403 to a reader it did not recognise, the
 * deep link the model named had moved (404), the source was a PDF the reader
 * refused as "not text", or the page was a JavaScript shell. `fetchForWorker`
 * was right to refuse each one honestly; it simply had only one way in.
 *
 * This is the one place that chooses a way in. Every caller that used to call
 * `fetchForWorker` directly calls `readSource`, and gets the same `SourceFetch`
 * back, plus which method produced it.
 *
 *   DIRECT      `fetchForWorker` — always first, unless this host's own record
 *               says it never works there and another method does.
 *   CONNECTOR   a site's own public API, for a site whose pages the general
 *               routes cannot read (`connectors.ts`).
 *   BROWSER     a JavaScript render in Playwright MCP, run as a separate app
 *               (`browserMcp.ts`) — only where robots.txt allows the path.
 *   SITEMAP     the same site's sitemap or feed, for a deep link that 404s: the
 *               page the site now lists for the closest path. What is returned
 *               is that page, under its own address, never the address asked for.
 *   ARCHIVE     the Internet Archive's copy, for a page that is gone, under the
 *               archive's permanent snapshot address so the citation names it.
 *
 * What it never does:
 *
 *  - widen access. A URL `checkDestination` refuses (private, credentials, odd
 *    port, odd scheme) is refused before any method runs and no fallback is
 *    tried. A 401, 402 or 451 is a site saying no, and no fallback is tried.
 *  - pretend. Every result says its method and its real address; a moved or
 *    archived page is cited as what it is. Whether the text supports a claim is
 *    still the verification pass's and the gate's question.
 *  - store a second copy of state. What worked on a host is read back from the
 *    `SOURCE_ACCESS` events this layer writes (one per read), so the record that
 *    measures the layer is the record that teaches it.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { browserMcpUrl, renderInBrowser } from './browserMcp.ts';
import { connectorFor } from './connectors.ts';
import { searchSuccessor } from './discover.ts';
import {
  recordAcquisitionJudgment,
  repeatedUseFromRows,
  REPEATED_USE_WINDOW_MS,
  type AcquisitionEvidence,
  type RecordAcquisitionDeps,
} from './acquisition.ts';
import { activeRoutine, routinesFrom, type Routine, type RoutineUse } from './routines.ts';
import { boundaryOfRead, classOfRoute, selectAccessMethod, type AccessEvidence } from './accessMethods.ts';
import { checkDestination, fetchForWorker, systemResolver, type Resolver, type SourceFetch } from './fetchForWorker.ts';

export const ACCESS_METHODS = ['DIRECT', 'CONNECTOR', 'BROWSER', 'SITEMAP', 'ARCHIVE', 'SEARCH'] as const;
export type AccessMethod = (typeof ACCESS_METHODS)[number];

export interface AccessAttempt {
  method: AccessMethod;
  readable: boolean;
  reason: string | null;
  status: number | null;
  ms: number;
}

/** What the reader learned about the source's own terms while reading it. */
export interface ReadTerms {
  /** robots.txt refused the browser route this read needed. */
  robotsDisallows?: boolean;
  /** Some attempt was answered 429. */
  rateLimited?: boolean;
}

export type SourceRead = SourceFetch & {
  method: AccessMethod;
  attempts: AccessAttempt[];
  terms?: ReadTerms;
  /** The reusable routine (from a CONNECTOR_PROPOSED row, `routines.ts`) that led this read, when one did. */
  routine?: RoutineUse;
};

export interface AccessDeps {
  direct?: (url: string) => Promise<SourceFetch>;
  browser?: ((url: string) => Promise<SourceFetch>) | null;
  resolve?: Resolver;
  /** Whether robots.txt lets a general reader fetch this URL. */
  robotsAllow?: (url: string) => Promise<boolean>;
  archive?: (url: string) => Promise<SourceFetch | null>;
  sitemap?: (url: string) => Promise<SourceFetch | null>;
  connector?: (url: string) => Promise<SourceFetch | null>;
  /**
   * The page a site has for what a dead link was about, found by a site search
   * (`discover.ts`). Defaults on only when no reader was injected, so a caller
   * that brings its own `direct` brings its own search too.
   */
  search?: ((url: string) => Promise<SourceFetch | null>) | null;
  learned?: (host: string) => Promise<AccessMethod | null>;
  /** The routine a CONNECTOR_PROPOSED row built for this host (`routines.ts`); defaults to the recorded rows. */
  routine?: (host: string) => Promise<Routine | null>;
  record?: (read: SourceRead, caller: string, ms: number) => Promise<void>;
  /** Which part of Brain asked, for the event. */
  caller?: string;
}

/** Text that is a bot challenge or a JavaScript shell, not the page. */
const SHELL = new RegExp(
  [
    'just a moment\\.\\.\\.',
    'enable javascript and cookies',
    'attention required! \\| cloudflare',
    'please enable javascript',
    'you need to enable javascript',
    'checking your browser',
    'verify you are (a )?human',
    'verify you are not a bot',
    'performing security verification',
    'sorry, you have been blocked',
    'you are unable to access',
    'needs a human touch',
    'loading challenge',
    'errcode px',
    'press (and|&) hold',
    'are you a robot',
    'unusual traffic from your computer',
    'request unsuccessful\\. incapsula',
    'pardon our interruption',
    'access to this page has been denied',
    'access denied',
    'please log ?in to verify',
    'check the box below to continue',
    'ensuring a fair fan experience',
  ].join('|'),
  'i',
);

/** A page that says the thing asked for is not there, served with a 200. */
const SOFT_404 =
  /(the requested (document|page) does not exist|page not found|this page (doesn't|does not) exist|the page you (are looking for|requested) (could not be found|does not exist|doesn't exist|is no longer available)|404 error)/i;

/** A page that is a bot challenge or a "not found" page rather than the content: readable bytes, no source. Pure. */
export function isChallenge(read: SourceFetch): boolean {
  return read.readable && read.text.length < 6000 && (SHELL.test(read.text) || SOFT_404.test(read.text));
}
const THIN_CHARS = 200;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a direct read came back as something a browser might read better. Pure. */
export function wantsBrowser(read: SourceFetch): boolean {
  if (read.readable) {
    if (!/html/i.test(read.contentType)) return false;
    return read.text.trim().length < THIN_CHARS || isChallenge(read);
  }
  if (read.reason === 'EMPTY' || read.reason === 'TIMEOUT') return true;
  if (read.reason === 'NETWORK_ERROR') return !/ENOTFOUND|EAI_AGAIN/i.test(read.detail);
  if (read.reason === 'HTTP_ERROR') return read.status === 403 || read.status === 429 || read.status === 503 || read.status === 520;
  return false;
}

/** Whether a page may be gone from where it was, so its successor or an archived copy is worth looking for. Pure. */
export function wantsReplacement(read: SourceFetch): boolean {
  if (read.readable) return false;
  if (read.reason === 'HTTP_ERROR') return read.status === 404 || read.status === 410;
  return read.reason === 'DNS_FAILED';
}

/** A refusal no other method may route around. Pure. */
export function isFinalRefusal(read: SourceFetch): boolean {
  if (read.readable) return false;
  if (['INVALID_URL', 'SCHEME_NOT_ALLOWED', 'PORT_NOT_ALLOWED', 'CREDENTIALS_IN_URL', 'ADDRESS_NOT_PUBLIC'].includes(read.reason)) return true;
  return read.reason === 'HTTP_ERROR' && (read.status === 401 || read.status === 402 || read.status === 451);
}

/** Whether `a` is a better reading than `b`. */
function better(a: SourceFetch, b: SourceFetch): boolean {
  if (!a.readable) return false;
  if (!b.readable) return true;
  if (isChallenge(a)) return false;
  return isChallenge(b) || a.text.trim().length > b.text.trim().length * 1.5;
}

/* ------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* ------------------------------------------------------------------------- */

const robotsCache = new Map<string, { until: number; rules: { allow: boolean; path: string }[] }>();
const ROBOTS_TTL_MS = 60 * 60_000;

/** The rules in a robots.txt that bind a general reader (`User-agent: *`). Pure. */
export function robotsRules(body: string): { allow: boolean; path: string }[] {
  const rules: { allow: boolean; path: string }[] = [];
  let agents: string[] = [];
  let inRules = false;
  let applies = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'user-agent') {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
      applies = agents.some((one) => one === '*' || one.includes('brainsourcereader'));
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (applies && value.length > 0) rules.push({ allow: key === 'allow', path: value });
    }
  }
  return rules;
}

/** Whether a path is allowed by robots rules: the longest matching rule wins, allow on a tie. Pure. */
export function robotsAllows(rules: { allow: boolean; path: string }[], pathAndQuery: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    const pattern = new RegExp(
      '^' +
        rule.path
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\\\$$/, '$'),
    );
    if (!pattern.test(pathAndQuery)) continue;
    if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow)) {
      best = { allow: rule.allow, length: rule.path.length };
    }
  }
  return best ? best.allow : true;
}

async function defaultRobotsAllow(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const key = parsed.origin;
  let cached = robotsCache.get(key);
  if (!cached || cached.until <= Date.now()) {
    const read = await fetchForWorker(`${parsed.origin}/robots.txt`, { timeoutMs: 8_000 });
    // No robots.txt (or an unreadable one) states no restriction.
    cached = { until: Date.now() + ROBOTS_TTL_MS, rules: read.readable ? robotsRules(read.text) : [] };
    robotsCache.set(key, cached);
  }
  return robotsAllows(cached.rules, parsed.pathname + parsed.search);
}

/* ------------------------------------------------------------------------- */
/* The Internet Archive                                                       */
/* ------------------------------------------------------------------------- */

/** The archived copy of a page, cited by its permanent snapshot address, or null. */
export async function archivedCopy(url: string, direct: (url: string) => Promise<SourceFetch> = (u) => fetchForWorker(u)): Promise<SourceFetch | null> {
  const lookup = await direct(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
  if (!lookup.readable) return null;
  let snapshot: { available?: boolean; url?: string; timestamp?: string; status?: string } | undefined;
  try {
    snapshot = (JSON.parse(lookup.text) as { archived_snapshots?: { closest?: typeof snapshot } }).archived_snapshots?.closest;
  } catch {
    return null;
  }
  if (!snapshot?.available || !snapshot.timestamp || (snapshot.status && snapshot.status !== '200')) return null;
  // `id_` asks for the page as it was captured, without the archive's toolbar.
  const raw = `https://web.archive.org/web/${snapshot.timestamp}id_/${url}`;
  const read = await direct(raw);
  if (!read.readable) return null;
  return { ...read, requestedUrl: url, finalUrl: `https://web.archive.org/web/${snapshot.timestamp}/${url}` };
}

/* ------------------------------------------------------------------------- */
/* Sitemaps and feeds                                                         */
/* ------------------------------------------------------------------------- */

function tokens(path: string): string[] {
  return decodeURIComponent(path)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((one) => one.length > 2 && !['html', 'htm', 'php', 'aspx', 'www', 'index'].includes(one));
}

/** How well a listed URL matches the path asked for, 0..1, by shared path words. Pure. */
export function pathSimilarity(wanted: string, candidate: string): number {
  const a = new Set(tokens(new URL(wanted).pathname));
  const b = new Set(tokens(new URL(candidate).pathname));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const one of a) if (b.has(one)) shared += 1;
  return shared / Math.max(a.size, Math.min(b.size, a.size + 2));
}

/** The addresses a sitemap or feed lists. Pure. */
export function listedUrls(body: string): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  const isIndex = /<sitemapindex/i.test(body);
  for (const match of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) (isIndex ? sitemaps : pages).push(match[1]!.replace(/&amp;/g, '&'));
  for (const match of body.matchAll(/<link>\s*([^<\s]+)\s*<\/link>/gi)) pages.push(match[1]!.replace(/&amp;/g, '&'));
  for (const match of body.matchAll(/<link[^>]+href="([^"]+)"[^>]*\/?>/gi)) pages.push(match[1]!.replace(/&amp;/g, '&'));
  return { pages, sitemaps };
}

/** The page a site's own sitemap or feed now lists for the closest path, read directly, or null. */
export async function sitemapSuccessor(
  url: string,
  direct: (url: string) => Promise<SourceFetch> = (u) => fetchForWorker(u),
): Promise<SourceFetch | null> {
  const wanted = new URL(url);
  const origin = wanted.origin;
  const roots = new Set<string>();
  const robots = await direct(`${origin}/robots.txt`);
  if (robots.readable) for (const m of robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) roots.add(m[1]!);
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/feed', '/rss.xml']) roots.add(origin + path);
  const seen = new Set<string>();
  const queue = [...roots].slice(0, 6);
  let best: { url: string; score: number } | null = null;
  let reads = 0;
  while (queue.length > 0 && reads < 8) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (hostOf(next) !== wanted.hostname.toLowerCase() && hostOf(next) !== `www.${wanted.hostname.toLowerCase()}`) continue;
    reads += 1;
    const listing = await direct(next);
    if (!listing.readable) continue;
    const { pages, sitemaps } = listedUrls(listing.text);
    // Children whose own name shares a word with the path go first.
    const ranked = sitemaps
      .map((one) => ({ one, score: tokens(one).filter((t) => tokens(wanted.pathname).includes(t)).length }))
      .sort((x, y) => y.score - x.score)
      .map((x) => x.one);
    queue.push(...ranked.slice(0, 3));
    for (const page of pages) {
      try {
        if (page === url) continue;
        const score = pathSimilarity(url, page);
        if (!best || score > best.score) best = { url: page, score };
      } catch {
        // not a URL
      }
    }
  }
  if (!best || best.score < 0.5) return null;
  const read = await direct(best.url);
  return read.readable ? { ...read, requestedUrl: url } : null;
}

/* ------------------------------------------------------------------------- */
/* What worked on a host, read back from the record                           */
/* ------------------------------------------------------------------------- */

const LEARN_WINDOW_MS = 7 * 24 * 60 * 60_000;
const LEARN_REFRESH_MS = 5 * 60_000;
let learnedMap = new Map<string, AccessMethod>();

interface HostTally {
  directOk: number;
  directFail: number;
  other: Map<AccessMethod, { ok: number; fail: number }>;
}

/**
 * Which method to lead with on each host, from SOURCE_ACCESS rows. Pure.
 *
 * A route leads only where DIRECT has failed at least twice and never worked, and
 * the route itself has worked more often than it has failed there — so a route that
 * starts failing on a host (a site that began serving challenges) stops leading.
 */
export function learnFrom(rows: { provider: string | null; outcome: string | null; measures: string | null }[]): Map<string, AccessMethod> {
  const tallies = new Map<string, HostTally>();
  for (const row of rows) {
    let measures: { host?: string; attempts?: AccessAttempt[] };
    try {
      measures = JSON.parse(row.measures ?? '{}') as typeof measures;
    } catch {
      continue;
    }
    if (!measures.host) continue;
    const tally = tallies.get(measures.host) ?? { directOk: 0, directFail: 0, other: new Map() };
    for (const attempt of measures.attempts ?? []) {
      if (attempt.method === 'DIRECT') {
        if (attempt.readable) tally.directOk += 1;
        else tally.directFail += 1;
      } else if (attempt.method === 'BROWSER' || attempt.method === 'CONNECTOR') {
        const entry = tally.other.get(attempt.method) ?? { ok: 0, fail: 0 };
        if (attempt.readable) entry.ok += 1;
        else entry.fail += 1;
        tally.other.set(attempt.method, entry);
      }
    }
    tallies.set(measures.host, tally);
  }
  const out = new Map<string, AccessMethod>();
  for (const [host, tally] of tallies) {
    if (tally.directOk > 0 || tally.directFail < 2) continue;
    const winner = [...tally.other].filter(([, e]) => e.ok > e.fail).sort((a, b) => b[1].ok - a[1].ok)[0];
    if (winner) out.set(host, winner[0]);
  }
  return out;
}

/** Browser reads of a host from SOURCE_ACCESS rows, newest first. */
export interface BrowserRecord {
  runs: number;
  stable: number;
  /** The most recent browser attempt on the host read the page. */
  lastOk: boolean;
}

/** How often the browser route ran on each host and how often it read the page. Pure. */
export function browserRecordFrom(rows: { measures: string | null }[]): Map<string, BrowserRecord> {
  const out = new Map<string, BrowserRecord>();
  for (const row of rows) {
    let measures: { host?: string; attempts?: AccessAttempt[] };
    try {
      measures = JSON.parse(row.measures ?? '{}') as typeof measures;
    } catch {
      continue;
    }
    if (!measures.host) continue;
    for (const attempt of measures.attempts ?? []) {
      if (attempt.method !== 'BROWSER') continue;
      const entry = out.get(measures.host) ?? { runs: 0, stable: 0, lastOk: attempt.readable };
      entry.runs += 1;
      if (attempt.readable) entry.stable += 1;
      out.set(measures.host, entry);
    }
  }
  return out;
}

let browserRecords = new Map<string, BrowserRecord>();

/*
 * The access history, loaded once per refresh and shared.
 *
 * Every public read records itself and two judgments, so anything read per read
 * runs on the research hot path against the shared database (§61/§63). The
 * learner, the routines, the acquisition judgment's repetition count and its
 * "already proposed" check all want the same two sets of rows — recent
 * SOURCE_ACCESS and CONNECTOR_PROPOSED — so they are read together, at most once
 * per `LEARN_REFRESH_MS`, single-flight, and every consumer derives from them.
 * What this process writes is added as it is written (`noteHistory`), so a read
 * counts itself and this process's earlier reads at once, and other processes'
 * rows within one refresh. Nothing is held that a reload cannot rebuild (§45).
 */
interface HistoryAccessRow {
  provider: string | null;
  outcome: string | null;
  measures: string | null;
  at: string | null;
}
interface HistoryProposalRow {
  measures: string | null;
  at: string | null;
}
const HISTORY_ACCESS_MAX = 5000;
let historyAt = 0;
let historyLoading: Promise<void> | null = null;
/** Newest first. */
let historyAccess: HistoryAccessRow[] = [];
/** `host|route` of each CONNECTOR_PROPOSED row inside the window, held or written here. */
let historyProposals = new Set<string>();
let routineMap = new Map<string, Routine>();

/** What the history reads and writes cost the database since the last reset: the load this module adds, measured. */
const dbLoad = { historyLoads: 0, queries: 0, writes: 0, judgmentsSkipped: 0 };
export function sourceAccessDbLoad(): Readonly<typeof dbLoad> {
  return { ...dbLoad };
}

const proposalKey = (host: string, route: string) => `${host.toLowerCase()}|${route}`;

async function loadHistory(): Promise<void> {
  dbLoad.historyLoads += 1;
  // One window covers every consumer: repetition and routines look back
  // REPEATED_USE_WINDOW_MS; the learner keeps only its own LEARN_WINDOW_MS of it.
  const since = new Date(Date.now() - Math.max(REPEATED_USE_WINDOW_MS, LEARN_WINDOW_MS)).toISOString();
  let access: HistoryAccessRow[] = [];
  let proposals: HistoryProposalRow[] = [];
  try {
    dbLoad.queries += 1;
    access = await getDb().all<HistoryAccessRow>(
      `SELECT provider, outcome, measures, at FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? ORDER BY at DESC LIMIT ${HISTORY_ACCESS_MAX}`,
      [since],
    );
  } catch {
    // A record that cannot be read teaches nothing; DIRECT leads and nothing is repeated.
  }
  try {
    dbLoad.queries += 1;
    proposals = await getDb().all<HistoryProposalRow>(
      `SELECT measures, at FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED' AND at >= ? ORDER BY at DESC LIMIT 500`,
      [new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString()],
    );
  } catch {
    // A record that cannot be read builds no routine; the ordinary routes run.
  }
  const learnSince = Date.now() - LEARN_WINDOW_MS;
  const learnRows = access.filter((r) => (r.at ? Date.parse(r.at) >= learnSince : false));
  learnedMap = learnFrom(learnRows);
  browserRecords = browserRecordFrom(learnRows);
  routineMap = routinesFrom(proposals, access);
  historyAccess = access;
  historyProposals = new Set();
  for (const p of proposals) {
    try {
      const m = JSON.parse(p.measures ?? '{}') as { host?: unknown; route?: unknown };
      if (typeof m.host === 'string' && typeof m.route === 'string') historyProposals.add(proposalKey(m.host, m.route));
    } catch {
      /* an unparseable row proposes nothing */
    }
  }
}

async function freshHistory(): Promise<void> {
  if (Date.now() - historyAt > LEARN_REFRESH_MS) {
    historyLoading ??= loadHistory().finally(() => {
      historyAt = Date.now();
      historyLoading = null;
    });
    await historyLoading;
  }
}

/** Add a row this process just wrote to the held history, so the next judgment counts it without reading it back. */
function noteHistory(eventType: string, provider: string | null, measures: Record<string, unknown>): void {
  if (eventType === 'SOURCE_ACCESS') {
    historyAccess.unshift({ provider, outcome: null, measures: JSON.stringify(measures), at: new Date().toISOString() });
    if (historyAccess.length > HISTORY_ACCESS_MAX) historyAccess.length = HISTORY_ACCESS_MAX;
  } else if (eventType === 'CONNECTOR_PROPOSED' && typeof measures.host === 'string' && typeof measures.route === 'string') {
    historyProposals.add(proposalKey(measures.host, measures.route));
  }
}

async function defaultLearned(host: string): Promise<AccessMethod | null> {
  await freshHistory();
  return learnedMap.get(host) ?? null;
}

async function defaultRoutine(host: string): Promise<Routine | null> {
  await freshHistory();
  return routineMap.get(host) ?? null;
}

/** A host's repetition, counted from the held SOURCE_ACCESS rows (this read's own row included). */
async function heldRepeatedUse(host: string): Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }> {
  await freshHistory();
  return repeatedUseFromRows(historyAccess, host);
}

async function heldProposalOnRecord(host: string, route: string): Promise<boolean> {
  await freshHistory();
  return historyProposals.has(proposalKey(host, route));
}

/*
 * A judgment that has not changed is not written again. The SOURCE_ACCESS row is
 * the record of every read; the ACQUISITION_JUDGMENT row records a decision, and a
 * decision repeated unchanged for the same caller, host and capability within one
 * refresh adds a write and no information. A changed route, outcome, boundary or
 * connector/script flag is written at once, so every change of decision is a row.
 */
const lastJudgment = new Map<string, { signature: string; at: number }>();


export function resetSourceAccessMemory(): void {
  historyAt = 0;
  historyLoading = null;
  historyAccess = [];
  historyProposals = new Set();
  routineMap = new Map();
  learnedMap = new Map();
  browserRecords = new Map();
  robotsCache.clear();
  lastJudgment.clear();
  dbLoad.historyLoads = 0;
  dbLoad.queries = 0;
  dbLoad.writes = 0;
  dbLoad.judgmentsSkipped = 0;
}

/**
 * What the attempts made on one read say about each way in. Pure.
 *
 * Each class is evidenced only by an attempt at a route of that class, and a
 * route no attempt tried is left unknown rather than assumed either way. The
 * route that finally produced the text is not special: it counts the same as any
 * other attempt at its class, so the evidence can name a different method than
 * the one used. No account is ever asserted — a browser render here is a public
 * page read, and says nothing about a session.
 */
export function accessEvidenceOfAttempts(
  attempts: readonly AccessAttempt[],
  context: { terms?: ReadTerms; browserRecord?: BrowserRecord | null } = {},
): AccessEvidence {
  const evidence: AccessEvidence = {};
  const terms = context.terms;
  const rateLimited = terms?.rateLimited === true || attempts.some((a) => a.status === 429);
  if (terms?.robotsDisallows || rateLimited) evidence.terms = { ...(terms?.robotsDisallows ? { robotsDisallows: true } : {}), ...(rateLimited ? { rateLimited: true } : {}) };
  const verdict = (methods: readonly AccessMethod[]): boolean | undefined => {
    const tried = attempts.filter((a) => methods.includes(a.method));
    return tried.length === 0 ? undefined : tried.some((a) => a.readable);
  };
  evidence.nativeAvailable = verdict(['CONNECTOR']);
  evidence.bulkAvailable = verdict(['SITEMAP', 'ARCHIVE']);
  evidence.httpReadable = verdict(['DIRECT', 'SEARCH']);
  const browser = verdict(['BROWSER']);
  // The interface is the only way in when a render read what plain HTTP could not.
  evidence.interfaceOnly = browser === undefined ? undefined : browser && evidence.httpReadable !== true;
  // The interface is unfamiliar when the host has no browser history or its last browser read failed
  // after others worked (it changed); stated only where this read used the browser or the host has a record.
  const record = context.browserRecord;
  if (record || browser !== undefined) {
    evidence.interfaceUnfamiliar = !record || !record.lastOk;
    if (record) evidence.recurrence = { runs: record.runs, stable: record.stable };
  }
  return evidence;
}

/** What the attempts on one read say, in the acquisition judgment's terms. Pure. */
export function acquisitionEvidenceOfRead(
  read: Pick<SourceRead, 'attempts' | 'readable' | 'method'>,
  boundary: AccessEvidence['boundary'] | null,
  evidence: AccessEvidence,
): AcquisitionEvidence {
  const bulkTried = read.attempts.some((a) => a.method === 'SITEMAP' || a.method === 'ARCHIVE');
  const bulkFound = read.attempts.filter((a) => (a.method === 'SITEMAP' || a.method === 'ARCHIVE') && a.readable).map((a) => a.method);
  return {
    nativeIntegrationAvailable: evidence.nativeAvailable === true,
    existingBulkSources: bulkFound,
    bulkSearchDone: bulkTried,
    stableHttpDocuments: evidence.httpReadable === true,
    interactiveInterfaceOnly: evidence.interfaceOnly === true,
    blockedAtBoundary: boundary !== null && boundary !== 'PAYMENT' && boundary !== 'LEGAL',
    requiresLicence: boundary === 'PAYMENT' || boundary === 'LEGAL',
  };
}

/**
 * What a read-path judgment reads and writes through: repetition and prior
 * proposals from the held history (no query of their own), and a writer that counts every write, adds
 * it to the held history, and leaves out a judgment that has not changed.
 */
function judgmentDeps(caller: string): RecordAcquisitionDeps {
  return {
    caller,
    repeatedUse: heldRepeatedUse,
    proposalOnRecord: heldProposalOnRecord,
    record: async (event) => {
      const measures = (event.measures ?? {}) as Record<string, unknown>;
      if (event.eventType === 'ACQUISITION_JUDGMENT') {
        const key = `${caller}|${String(measures.host)}|${String(measures.capability)}`;
        const signature = JSON.stringify([event.outcome, event.provider, measures.reusableConnectorJustified, measures.convertToScript, measures.bespokeCrawlerMayBeProposed, measures.boundaries]);
        const prior = lastJudgment.get(key);
        if (prior && prior.signature === signature && Date.now() - prior.at <= LEARN_REFRESH_MS) {
          dbLoad.judgmentsSkipped += 1;
          return;
        }
        lastJudgment.set(key, { signature, at: Date.now() });
      }
      dbLoad.writes += 1;
      await recordBinEvent(event);
      noteHistory(event.eventType, event.provider ?? null, measures);
    },
  };
}

async function judgeReadAsAcquisition(
  read: SourceRead,
  host: string | null,
  boundary: AccessEvidence['boundary'] | null,
  evidence: AccessEvidence,
  caller: string,
): Promise<void> {
  await recordAcquisitionJudgment(
    { kind: 'ACQUIRE', purpose: `read ${read.requestedUrl}`, host },
    acquisitionEvidenceOfRead(read, boundary, evidence),
    judgmentDeps(caller),
  );
}

async function defaultRecord(read: SourceRead, caller: string, ms: number): Promise<void> {
  const host = hostOf(read.requestedUrl);
  const used = classOfRoute(read.method);
  const boundary = boundaryOfRead({
    readable: read.readable,
    reason: read.readable ? undefined : read.reason,
    status: read.status,
    robotsBlocked: read.terms?.robotsDisallows === true,
  });
  // The held history is brought up to date before this read's row is added to it, so
  // a refresh already in flight cannot drop the row, and the browser record is current.
  await freshHistory().catch(() => undefined);
  const attemptEvidence = accessEvidenceOfAttempts(read.attempts, { terms: read.terms, browserRecord: host ? browserRecords.get(host) : null });
  const evidence: AccessEvidence = boundary ? { boundary, ...(attemptEvidence.terms ? { terms: attemptEvidence.terms } : {}) } : attemptEvidence;
  const judged = selectAccessMethod(evidence);
  // A boundary is a stop; otherwise the method used is the route that ran, and the
  // judgment is what the evidence of every attempt supports, so a disagreement shows.
  const agrees = judged.method === used;
  const methodReason = (
    boundary
      ? judged.why
      : read.readable
        ? agrees
          ? `${used} was used and the attempts support it: ${judged.why}`
          : `${used} was used; the attempts on this read support ${judged.method} (${judged.why}); no session was evidenced`
        : `${used} did not yield a readable source (${read.reason}); no boundary was met, so no human step is implied`
  ).slice(0, 300);
  const accessMeasures = {
    host,
    url: read.requestedUrl.slice(0, 400),
    finalUrl: read.finalUrl?.slice(0, 400) ?? null,
    chars: read.readable ? read.totalChars : 0,
    attempts: read.attempts,
    ...(read.routine ? { routine: read.routine } : {}),
    methodClass: boundary ? judged.method : used,
    methodJudged: judged.method,
    methodAgrees: boundary ? true : agrees,
    methodReason,
    convertToScript: judged.convertToScript,
    methodConsidered: judged.considered,
    methodConstraints: judged.constraints,
  };
  dbLoad.writes += 1;
  await recordBinEvent({
    eventType: 'SOURCE_ACCESS',
    provider: read.method,
    workloadClass: caller,
    outcome: read.readable ? 'READ' : 'UNREADABLE',
    reason: `${read.readable ? read.method : read.reason} ${read.requestedUrl}`.slice(0, 480),
    durationMs: ms,
    evidenceClass: 'MEASURED',
    measures: accessMeasures,
  });
  noteHistory('SOURCE_ACCESS', read.method, accessMeasures);
  // Reading a public source is the ACQUIRE capability: ask the acquisition judgment what
  // this read's own evidence supports (existing bulk sources first, a connector when the
  // host's SOURCE_ACCESS history justifies one) and record it beside the access row.
  await judgeReadAsAcquisition(read, host, boundary ?? null, evidence, caller).catch(() => undefined);
  // A read never records the OPERATE capability, whatever rendered it and whatever permission
  // stands for its host: the research browser opens one isolated, signed-out session per page
  // (`browserMcp.ts`), so no account was used and no interface was operated. An OPERATE judgment
  // is written only by the code that actually runs a workflow under the granted account
  // (`browserWorkflow.ts operateWorkflow`), so the row and the operation are the same event (§18, inv. 45).
}

/* ------------------------------------------------------------------------- */
/* The reader                                                                 */
/* ------------------------------------------------------------------------- */

/** Read one public source by the first legitimate route that works. Never throws. */
export async function readSource(url: string, deps: AccessDeps = {}): Promise<SourceRead> {
  const started = Date.now();
  const direct = deps.direct ?? ((u: string) => fetchForWorker(u));
  const browser = deps.browser === undefined ? (browserMcpUrl() ? (u: string) => renderInBrowser(u) : null) : deps.browser;
  const robotsAllow = deps.robotsAllow ?? defaultRobotsAllow;
  const archive = deps.archive ?? ((u: string) => archivedCopy(u, direct));
  const sitemap = deps.sitemap ?? ((u: string) => sitemapSuccessor(u, direct));
  const connector = deps.connector ?? ((u: string) => connectorFor(u)?.(u, direct) ?? Promise.resolve(null));
  const search =
    deps.search !== undefined ? deps.search : deps.direct ? null : (u: string) => searchSuccessor(u, direct);
  const learned = deps.learned ?? defaultLearned;
  const record = deps.record ?? defaultRecord;
  const routineOf = deps.routine ?? defaultRoutine;
  const attempts: AccessAttempt[] = [];
  let routineUsed: RoutineUse | undefined;
  const terms: ReadTerms = {};
  /** Whether the site's robots.txt allows the browser route; a refusal is recorded as a term of this read. */
  const browserAllowed = async (): Promise<boolean> => {
    const allowed = await robotsAllow(url).catch(() => false);
    if (!allowed) terms.robotsDisallows = true;
    return allowed;
  };

  const attempt = async (method: AccessMethod, run: () => Promise<SourceFetch | null>): Promise<SourceFetch | null> => {
    const t = Date.now();
    let read: SourceFetch | null;
    try {
      read = await run();
    } catch (error) {
      read = null;
      attempts.push({ method, readable: false, reason: `ERROR ${(error as Error).message ?? ''}`.slice(0, 80), status: null, ms: Date.now() - t });
      return null;
    }
    const challenged = Boolean(read && isChallenge(read));
    attempts.push({
      method,
      readable: Boolean(read?.readable) && !challenged,
      reason: read ? (challenged ? 'CHALLENGE' : read.readable ? null : read.reason) : 'NOT_FOUND',
      status: read?.status ?? null,
      ms: Date.now() - t,
    });
    return read;
  };
  const done = async (read: SourceFetch, method: AccessMethod): Promise<SourceRead> => {
    // A challenge page is not the source, whichever route fetched it.
    const honest: SourceFetch = isChallenge(read)
      ? {
          readable: false,
          requestedUrl: read.requestedUrl,
          finalUrl: read.finalUrl,
          status: read.status,
          retrievedAt: read.retrievedAt,
          reason: 'EMPTY',
          detail: 'the site answered with a bot challenge, not the page',
        }
      : read;
    const out: SourceRead = { ...honest, method, attempts, ...(routineUsed ? { routine: routineUsed } : {}), ...(terms.robotsDisallows || attempts.some((a) => a.status === 429) ? { terms: { ...terms, ...(attempts.some((a) => a.status === 429) ? { rateLimited: true } : {}) } } : {}) };
    await record(out, deps.caller ?? 'unknown', Date.now() - started).catch(() => undefined);
    return out;
  };

  // Access controls first: an address Brain may not open is not opened by any route.
  const checked = await checkDestination(url, deps.resolve ?? systemResolver);
  if (!checked.ok) {
    return done(
      { readable: false, requestedUrl: url, finalUrl: null, status: null, retrievedAt: new Date().toISOString(), reason: checked.reason, detail: checked.detail },
      'DIRECT',
    );
  }
  const host = checked.url.hostname.toLowerCase();

  // A site with its own public API for this kind of page.
  if (connectorFor(url) || deps.connector) {
    const viaApi = await attempt('CONNECTOR', () => connector(url));
    if (viaApi?.readable) return done(viaApi, 'CONNECTOR');
  }

  // A reusable routine a CONNECTOR_PROPOSED row built for this host leads, so the
  // route repetition justified is run rather than rediscovered on every read.
  const routine = activeRoutine(await routineOf(host).catch(() => null));
  if (routine && (routine.lead === 'SITEMAP' || routine.lead === 'ARCHIVE')) {
    routineUsed = routine;
    const run = routine.lead === 'SITEMAP' ? sitemap : archive;
    const viaRoutine = await attempt(routine.lead, () => run(url));
    if (viaRoutine?.readable && !wantsBrowser(viaRoutine)) return done(viaRoutine, routine.lead);
  }

  // A host whose own record says DIRECT never works there and the browser does,
  // or whose browser routine was proposed from recorded repetition.
  const learnedLead = await learned(host).catch(() => null);
  const routineBrowser = routine?.lead === 'BROWSER';
  const lead: AccessMethod | null = learnedLead ?? (routineBrowser ? 'BROWSER' : null);
  if (lead === 'BROWSER' && browser && (await browserAllowed())) {
    if (routineBrowser) routineUsed = routine!;
    const rendered = await attempt('BROWSER', () => browser(url));
    if (rendered?.readable && !wantsBrowser(rendered)) return done(rendered, 'BROWSER');
  }

  const first = (await attempt('DIRECT', () => direct(url)))!;
  if (first.readable && !wantsBrowser(first)) return done(first, 'DIRECT');
  if (isFinalRefusal(first)) return done(first, 'DIRECT');

  let bestRead: SourceFetch = first;
  let bestMethod: AccessMethod = 'DIRECT';

  if (wantsBrowser(first) && browser && lead !== 'BROWSER' && (await browserAllowed())) {
    const rendered = await attempt('BROWSER', () => browser(url));
    if (rendered && better(rendered, bestRead)) {
      bestRead = rendered;
      bestMethod = 'BROWSER';
    }
    if (bestRead.readable && !wantsBrowser(bestRead)) return done(bestRead, bestMethod);
  }

  if (wantsReplacement(first)) {
    if (!first.readable && first.reason === 'HTTP_ERROR') {
      const moved = await attempt('SITEMAP', () => sitemap(url));
      if (moved?.readable) return done(moved, 'SITEMAP');
    }
  }
  if (!bestRead.readable || wantsBrowser(bestRead)) {
    const archived = await attempt('ARCHIVE', () => archive(url));
    if (archived && better(archived, bestRead)) return done(archived, 'ARCHIVE');
  }
  // A page that is gone and was never archived is usually one that never existed —
  // a remembered deep link. The site's own page about the same thing is the successor.
  if (search && wantsReplacement(first) && !first.readable && first.reason === 'HTTP_ERROR') {
    const found = await attempt('SEARCH', () => search(url));
    if (found?.readable) return done({ ...found, requestedUrl: url }, 'SEARCH');
  }
  return done(bestRead, bestMethod);
}
