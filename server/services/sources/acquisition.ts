/**
 * Two complementary capabilities, decided separately and per case.
 *
 *   OPERATE   use a site's functionality under a legitimate account and
 *             permission, where no public API exists, so nobody repeatedly logs
 *             in and clicks through the same workflow.
 *   ACQUIRE   obtain and maintain information (documents, records, evidence) —
 *             existing corpora, bulk exports and catalogs first, a bespoke
 *             crawler only when none exists.
 *
 * Neither is authorization to contact strangers, evade a site's defenses or
 * make a business commitment: a need that is really one of those is refused,
 * and the refusal names the boundary.
 *
 * This extends the existing owner. The judgment is a `bin_events` row written
 * through `recordBinEvent` (the same table and writer as the `SOURCE_ACCESS`
 * history `access.ts` produces), and repetition is read back from those
 * `SOURCE_ACCESS` rows, so the record that measures the layer decides when a
 * reusable connector is worth building. No scheduler, queue, store or
 * authority path is added, and no category, industry or site is listed: every
 * judgment is made from the evidence handed in.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { ACCESS_METHODS } from './access.ts';
import { METHOD_CLASSES, selectAccessMethod, type AccessEvidence, type MethodClass } from './accessMethods.ts';
import { webSearch } from './discover.ts';

export const ACQUISITION_CAPABILITIES = ['OPERATE', 'ACQUIRE'] as const;
export type AcquisitionCapability = (typeof ACQUISITION_CAPABILITIES)[number];

/**
 * The routes a judgment may choose are the method classes of `accessMethods.ts`
 * — one vocabulary, one selector. This module adds the policy around that
 * selection (operate vs acquire, refused boundaries, search-before-crawl) and
 * never chooses a method itself, so two selectors cannot disagree on a need.
 */
export const ACQUISITION_ROUTES = METHOD_CLASSES;
export type AcquisitionRoute = MethodClass;

export type AcquisitionBoundary =
  | 'CONTACT_STRANGERS'
  | 'EVADE_SITE_DEFENSES'
  | 'BUSINESS_COMMITMENT'
  | 'NO_AUTHORIZED_ACCOUNT'
  | 'ACCESS_BARRIER'
  | 'TERMS_OR_LICENSE';

/** What is being asked for. */
export interface AcquisitionNeed {
  /** Which capability the need is: using a site's functionality, or obtaining information. */
  kind: AcquisitionCapability;
  /** What for, in words; recorded verbatim (bounded). */
  purpose: string;
  /** The host or resource, when one is named. */
  host?: string | null;
  /** The need would, as asked, message/solicit people who have not dealt with Brain. */
  contactsStrangers?: boolean;
  /** The need would, as asked, get past a CAPTCHA, login wall, bot block or rate limit. */
  evadesDefenses?: boolean;
  /** The need would, as asked, bind the company (order, purchase, offer, signature, acceptance). */
  makesBusinessCommitment?: boolean;
}

/** What is known about the need. Every field is optional: absent means "not established". */
export interface AcquisitionEvidence {
  /** An official API, authenticated export, webhook, CLI or standard protocol exists and is usable. */
  nativeIntegrationAvailable?: boolean;
  /** Existing corpora, bulk exports, open-data catalogs, feeds, sitemaps or indexes already found for the need. */
  existingBulkSources?: string[];
  /** Whether the search for existing corpora/exports/catalogs has actually been run. */
  bulkSearchDone?: boolean;
  /** Stable JSON/CSV/XML/HTML documents reachable by ordinary HTTP, honoring terms. */
  stableHttpDocuments?: boolean;
  /** The site's interactive interface is the supported way in. */
  interactiveInterfaceOnly?: boolean;
  /** An account Brain is permitted to use for this site is on record. */
  authorizedAccountOnRecord?: boolean;
  /** The interface is unfamiliar, changed, or its workflow is not yet known. */
  interfaceUnfamiliarOrChanged?: boolean;
  /** Authentication, owner consent, CAPTCHA or bot restrictions block automation. */
  blockedAtBoundary?: boolean;
  /** The data legitimately requires a paid licence, or terms/licence do not permit the intended use. */
  requiresLicence?: boolean;
  /** The boundary the last attempt met, when known; defaults to AUTHENTICATION when only `blockedAtBoundary` is stated. */
  boundary?: AccessEvidence['boundary'];
  /** Times this workflow/host has been used, read from SOURCE_ACCESS rows (see `repeatedUseFromRows`). */
  repeatedUses?: number;
  /** Of those, how many needed a route beyond a plain direct read. */
  repeatedUsesNeedingFallback?: number;
}

export interface AcquisitionJudgment {
  capability: AcquisitionCapability;
  outcome: 'ROUTE_SELECTED' | 'SEARCH_FIRST' | 'REFUSED';
  /** Null when refused or when the next step is a search for existing sources. */
  route: AcquisitionRoute | null;
  reason: string;
  /** A reusable connector or automation is justified by recorded repetition. */
  reusableConnectorJustified: boolean;
  /** Bespoke crawler may be proposed (ACQUIRE only: existing sources were searched for and none serves). */
  bespokeCrawlerMayBeProposed: boolean;
  boundaries: AcquisitionBoundary[];
  /** A stable recurring model-assisted pattern should become a tested script (from the one selector). */
  convertToScript: boolean;
  /** For HUMAN_HANDOFF: the permitted route a person is asked to secure, named by the one selector. */
  handoff: string | null;
}

/**
 * A reusable connector pays for itself when work has repeated and the repetition
 * is not already cheap. Derived from the rows handed in: repeated at least twice,
 * and either more than one use needed a fallback route or the workflow is
 * interactive-only (where each repeat is a person's clicks). No host or category
 * enters the decision.
 */
function connectorJustified(evidence: AcquisitionEvidence, operate: boolean): boolean {
  const uses = evidence.repeatedUses ?? 0;
  if (uses < 2) return false;
  if (operate) return true;
  return (evidence.repeatedUsesNeedingFallback ?? 0) >= 2;
}

/** Judge one need from its evidence. Pure: same inputs, same judgment. */
export function judgeAcquisitionNeed(need: AcquisitionNeed, evidence: AcquisitionEvidence = {}): AcquisitionJudgment {
  const capability = need.kind;
  const refuse = (boundaries: AcquisitionBoundary[], reason: string): AcquisitionJudgment => ({
    capability,
    outcome: 'REFUSED',
    route: null,
    reason,
    reusableConnectorJustified: false,
    bespokeCrawlerMayBeProposed: false,
    boundaries,
    convertToScript: false,
    handoff: null,
  });

  // Boundaries first: neither capability authorizes any of these.
  const hard: AcquisitionBoundary[] = [];
  if (need.contactsStrangers) hard.push('CONTACT_STRANGERS');
  if (need.evadesDefenses) hard.push('EVADE_SITE_DEFENSES');
  if (need.makesBusinessCommitment) hard.push('BUSINESS_COMMITMENT');
  if (hard.length > 0) {
    return refuse(
      hard,
      `Refused: ${capability} is a capability to ${capability === 'OPERATE' ? 'operate a system' : 'acquire information'}, not authorization to ${hard
        .map((b) => (b === 'CONTACT_STRANGERS' ? 'contact strangers' : b === 'EVADE_SITE_DEFENSES' ? "evade a site's defenses" : 'make business commitments'))
        .join(' or ')}. A person decides that.`,
    );
  }

  const justified = connectorJustified(evidence, capability === 'OPERATE');
  const operate = capability === 'OPERATE';
  const existing = evidence.existingBulkSources ?? [];

  // ACQUIRE: existing corpora, bulk exports and catalogs before any bespoke crawler.
  if (!operate && !evidence.blockedAtBoundary && !evidence.requiresLicence && !evidence.nativeIntegrationAvailable && existing.length === 0 && !evidence.bulkSearchDone) {
    return {
      capability,
      outcome: 'SEARCH_FIRST',
      route: null,
      reason: 'Source discovery has not yet looked for existing corpora, bulk exports and catalogs; that search comes before any bespoke crawler is proposed.',
      reusableConnectorJustified: false,
      bespokeCrawlerMayBeProposed: false,
      boundaries: [],
      convertToScript: false,
      handoff: null,
    };
  }

  // The one selector decides the method; this module only states the need's evidence in its terms.
  const selection = selectAccessMethod({
    nativeAvailable: evidence.nativeIntegrationAvailable,
    bulkAvailable: operate ? undefined : existing.length > 0,
    httpReadable: operate ? undefined : evidence.stableHttpDocuments,
    interfaceOnly: operate ? true : evidence.interactiveInterfaceOnly,
    authorizedSession: operate ? evidence.authorizedAccountOnRecord : true,
    interfaceUnfamiliar: evidence.interfaceUnfamiliarOrChanged,
    boundary: evidence.blockedAtBoundary ? (evidence.boundary ?? 'AUTHENTICATION') : undefined,
    needsLicence: evidence.requiresLicence,
  });
  const route = selection.method;
  const boundaries: AcquisitionBoundary[] = [];
  if (route === 'HUMAN_HANDOFF') {
    if (evidence.requiresLicence) boundaries.push('TERMS_OR_LICENSE');
    else if (evidence.blockedAtBoundary) boundaries.push('ACCESS_BARRIER');
    else if (operate && !evidence.authorizedAccountOnRecord) boundaries.push('NO_AUTHORIZED_ACCOUNT');
  }
  const handoff = route === 'HUMAN_HANDOFF';
  // A bespoke crawler is proposable only when existing corpora were looked for and none serves:
  // a found bulk source that measurement ranked below HTTP is still a source to use, not to re-crawl.
  const bespoke = !operate && existing.length === 0 && (route === 'HTTP' || route === 'BROWSER' || route === 'MODEL_ASSISTED');
  const repeat =
    operate && (route === 'BROWSER' || route === 'MODEL_ASSISTED')
      ? justified
        ? ` The workflow has repeated ${evidence.repeatedUses} times on record, so a tested reusable connector replaces model-per-click work.`
        : ' Repetition on record does not yet justify a reusable connector.'
      : '';
  return {
    capability,
    outcome: 'ROUTE_SELECTED',
    route,
    reason: `${selection.why}.${repeat}`,
    reusableConnectorJustified: handoff ? false : justified,
    bespokeCrawlerMayBeProposed: bespoke,
    boundaries,
    convertToScript: handoff ? false : selection.convertToScript,
    handoff: handoff ? selection.handoff : null,
  };
}

/** Repetition is only evidence inside a recent window; older reads say nothing about today's work. */
export const REPEATED_USE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The workflow a SOURCE_ACCESS row belongs to: host plus path, never the query, so one workflow read again is one key. */
function workflowKeyOf(measures: { host?: unknown; url?: unknown }, host: string): string {
  if (typeof measures.url === 'string') {
    try {
      const u = new URL(measures.url);
      return `${host}${u.pathname.replace(/\/+$/, '') || '/'}`;
    } catch {
      /* fall through to the host-only key */
    }
  }
  return host;
}

/** Whether the read needed a route beyond a plain direct read, judged from its own attempts. */
function neededFallback(row: { provider: string | null }, measures: { attempts?: unknown }): boolean {
  if (Array.isArray(measures.attempts)) {
    return (measures.attempts as { method?: unknown }[]).some(
      (a) => typeof a?.method === 'string' && a.method !== 'DIRECT' && (ACCESS_METHODS as readonly string[]).includes(a.method),
    );
  }
  return Boolean(row.provider && row.provider !== 'DIRECT' && (ACCESS_METHODS as readonly string[]).includes(row.provider));
}

/**
 * Repeated use of a host's workflow, counted from `SOURCE_ACCESS` event rows. Pure over rows.
 *
 * Repetition is the same workflow done again inside a recent window, not traffic to
 * the host: rows are grouped by workflow key (host + path) and the most-repeated
 * workflow decides, so many different pages on one host never add up to "repeated".
 * Rows older than the window are ignored; a row with no usable `at` is ignored too,
 * because an undated read cannot be shown to be recent.
 */
export function repeatedUseFromRows(
  rows: { provider: string | null; measures: string | null; at?: string | null }[],
  host: string,
  opts: { now?: number; windowMs?: number } = {},
): { repeatedUses: number; repeatedUsesNeedingFallback: number } {
  const want = host.toLowerCase();
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowMs ?? REPEATED_USE_WINDOW_MS);
  const groups = new Map<string, { uses: number; fallback: number }>();
  for (const row of rows) {
    const at = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at) || at < since || at > now) continue;
    let measures: { host?: unknown; url?: unknown; attempts?: unknown } = {};
    try {
      measures = row.measures ? (JSON.parse(row.measures) as typeof measures) : {};
    } catch {
      continue;
    }
    if (typeof measures.host !== 'string' || measures.host.toLowerCase() !== want) continue;
    const key = workflowKeyOf(measures, want);
    const g = groups.get(key) ?? { uses: 0, fallback: 0 };
    g.uses += 1;
    if (neededFallback(row, measures)) g.fallback += 1;
    groups.set(key, g);
  }
  let best = { uses: 0, fallback: 0 };
  for (const g of groups.values()) if (g.uses > best.uses || (g.uses === best.uses && g.fallback > best.fallback)) best = g;
  return { repeatedUses: best.uses, repeatedUsesNeedingFallback: best.fallback };
}

/**
 * The `LIKE` pattern that selects a host's rows by their `measures`. Every writer
 * of a host-bearing row here (and `access.ts`) serializes `{ host, ... }` with
 * `JSON.stringify`, lower-cased, so the pattern is exact for them; the pure
 * readers still check the parsed host, so a pattern that matches more never
 * decides anything. `%`, `_` and `\\` are escaped, so a host is never a wildcard.
 */
export function hostMeasuresPattern(host: string): string {
  const escaped = host.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%"host":"${escaped}"%`;
}

/** How many rows of one host a reader takes; a host's own history, never the whole table's. */
const HOST_ROWS_MAX = 500;

/**
 * Repeated-use counts for a host from existing SOURCE_ACCESS rows; zeros when unreadable.
 *
 * The read path does not call this: `access.ts` counts repetition from the
 * SOURCE_ACCESS rows its learner already holds (one load per refresh, §61/§63).
 * This is for a caller off that path, and it reads that host's rows only.
 */
export async function readRepeatedUse(host: string): Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<{ provider: string | null; measures: string | null; at: string | null }>(
      `SELECT provider, measures, at FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ${HOST_ROWS_MAX}`,
      [since, hostMeasuresPattern(host)],
    );
    return repeatedUseFromRows(rows, host);
  } catch {
    return { repeatedUses: 0, repeatedUsesNeedingFallback: 0 };
  }
}

/**
 * Whether Brain may operate a host's interface under an account is a person's
 * permission, and it is a row: an append-only `OPERATE_PERMISSION` bin event
 * whose outcome is GRANTED or REVOKED, naming the host and the account by a
 * reference (a label a person recognizes — never a credential, token or
 * password). The newest row for the host decides, so a revocation is a later
 * row rather than an edit, and history is kept (§5, §17).
 *
 * A person makes the row from a terminal (`operatePermissionCli.ts grant|revoke|show`,
 * invariant 35); `recordOperatePermission` is the one writer behind it.
 *
 * This is the record the OPERATE judgment reads. A read path (`access.ts`) can
 * only say a browser rendered a public page — it cannot know about an account,
 * and says `false` — so the judgment consults this record whenever the caller
 * has not itself established an account, and an operation becomes BROWSER or
 * MODEL_ASSISTED exactly when a person granted it. A permission is never
 * authorization to contact strangers, evade defenses or commit the business:
 * those boundaries are judged first and refuse regardless of any grant.
 */
export const OPERATE_PERMISSION_EVENT = 'OPERATE_PERMISSION';

export interface OperatePermission {
  permitted: boolean;
  /** The account a person named for the host, by reference; null when none is granted. */
  accountRef: string | null;
  grantedBy: string | null;
  at: string | null;
}

const NO_PERMISSION: OperatePermission = { permitted: false, accountRef: null, grantedBy: null, at: null };

/** The standing permission for a host from OPERATE_PERMISSION rows. Pure: the newest dated row for the host decides. */
export function operatePermissionFromRows(
  rows: { outcome: string | null; measures: string | null; at?: string | null }[],
  host: string,
): OperatePermission {
  const want = host.toLowerCase();
  let best: { at: number; row: OperatePermission } | null = null;
  for (const row of rows) {
    const at = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    let m: { host?: unknown; accountRef?: unknown; grantedBy?: unknown } = {};
    try {
      m = row.measures ? (JSON.parse(row.measures) as typeof m) : {};
    } catch {
      continue;
    }
    if (typeof m.host !== 'string' || m.host.toLowerCase() !== want) continue;
    if (row.outcome !== 'GRANTED' && row.outcome !== 'REVOKED') continue;
    if (best && best.at >= at) continue;
    const granted = row.outcome === 'GRANTED' && typeof m.accountRef === 'string' && m.accountRef.trim() !== '';
    best = {
      at,
      row: granted
        ? { permitted: true, accountRef: (m.accountRef as string).trim(), grantedBy: typeof m.grantedBy === 'string' ? m.grantedBy : null, at: row.at ?? null }
        : { ...NO_PERMISSION, grantedBy: typeof m.grantedBy === 'string' ? m.grantedBy : null, at: row.at ?? null },
    };
  }
  return best?.row ?? NO_PERMISSION;
}

/**
 * The standing operate permission for a host, read from the rows; none when unreadable.
 *
 * Only that host's rows are read, newest first, and only a few: the newest dated
 * row decides, and a host has a handful of grants and revocations, not thousands.
 * It is read fresh on every OPERATE judgment rather than held, because a
 * revocation is an authority decision and must apply to the very next read.
 */
export async function readOperatePermission(host: string): Promise<OperatePermission> {
  try {
    const rows = await getDb().all<{ outcome: string | null; measures: string | null; at: string | null }>(
      `SELECT outcome, measures, at FROM bin_events WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 20`,
      [OPERATE_PERMISSION_EVENT, hostMeasuresPattern(host)],
    );
    return operatePermissionFromRows(rows, host);
  } catch {
    return NO_PERMISSION;
  }
}

/** A credential-shaped string is never an account reference: the record names an account, it does not hold one. */
function looksLikeSecret(value: string): boolean {
  return /[:@].*[:@]|^(sk|pk|ghp|gho|xox[abp]|brn[a-z])[-_]|^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(value);
}

/**
 * Record a person's grant or revocation of permission to operate a host's
 * interface under a named account. Append-only; the newest row decides.
 */
export async function recordOperatePermission(
  input: { host: string; granted: boolean; accountRef?: string | null; grantedBy: string; note?: string | null },
  deps: { record?: typeof recordBinEvent } = {},
): Promise<OperatePermission> {
  const host = input.host.trim().toLowerCase();
  if (!host) throw new Error('An operate permission names the host it covers.');
  if (!input.grantedBy.trim()) throw new Error('An operate permission names the person who gave it.');
  const accountRef = input.accountRef?.trim() || null;
  if (input.granted && !accountRef) throw new Error('A grant names the account Brain may operate under, by reference.');
  if (accountRef && looksLikeSecret(accountRef)) throw new Error('An account reference is a label, never a credential.');
  await (deps.record ?? recordBinEvent)({
    eventType: OPERATE_PERMISSION_EVENT,
    workloadClass: 'acquisition',
    outcome: input.granted ? 'GRANTED' : 'REVOKED',
    reason: `${input.granted ? 'Granted' : 'Revoked'} operating ${host}${accountRef ? ` under ${accountRef}` : ''}${input.note ? `: ${input.note}` : ''}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { host, accountRef: input.granted ? accountRef : null, grantedBy: input.grantedBy.trim() },
  });
  return input.granted
    ? { permitted: true, accountRef, grantedBy: input.grantedBy.trim(), at: null }
    : { ...NO_PERMISSION, grantedBy: input.grantedBy.trim() };
}

/*
 * The consumers of a judgment (F-JUDGMENT-NO-CONSUMER).
 *
 * A judgment that only sits in a row changes nothing, so each outcome that asks
 * for something is acted on here, by the one writer, at the moment it is made:
 *
 *   SEARCH_FIRST   source discovery runs: existing corpora, bulk exports,
 *                  catalogs, feeds and APIs for the need are looked for, the
 *                  search is recorded as a `SOURCE_DISCOVERY` row, and the need
 *                  is judged again on what the search found. Every later
 *                  judgment for that host reads the discovery back, so the
 *                  search is made once per window, not once per read.
 *   bespoke        a connector proposal for a bespoke ACQUIRE route (HTTP,
 *                  BROWSER, MODEL_ASSISTED) is written only when
 *                  `bespokeCrawlerMayBeProposed` holds — i.e. after that search
 *                  ran and found nothing to use instead.
 *   HUMAN_HANDOFF  an `ACCESS_HANDOFF` row is opened naming the boundary, the
 *                  permitted route the selector named (an official export, a
 *                  licence, an account, a partner integration, a specific human
 *                  step) and the exact next step. It is what a person reads at
 *                  the terminal (`acquisitionCli.ts handoffs`, invariant 35),
 *                  and it settles itself when a later judgment for the host
 *                  routes without a handoff or a person grants the permission.
 *
 * All three are `bin_events` rows through `recordBinEvent`, the same table and
 * writer as every other row of this layer. No scheduler, queue, store or
 * authority path is added, and no host, category or industry is named: the
 * search query is built from the need itself, and what counts as a bulk source
 * is the shape of the address a search returned.
 */
export const SOURCE_DISCOVERY_EVENT = 'SOURCE_DISCOVERY';
export const ACCESS_HANDOFF_EVENT = 'ACCESS_HANDOFF';

export interface SourceDiscovery {
  query: string;
  /** Every address the search returned (bounded). A search result is a candidate, never evidence. */
  candidates: string[];
  /** Those whose address is shaped like a corpus, export, catalog, feed, index or API. */
  bulkCandidates: string[];
}

/** The address of a corpus, a bulk export, a catalog, a feed, an index or an API — judged by shape, for any site. */
const BULK_SHAPE =
  /\.(csv|tsv|jsonl?|xml|zip|gz|tgz|parquet|xlsx?|ods|rss|atom|rdf)(?:[?#]|$)|\/(?:datasets?|data|downloads?|exports?|bulk|catalog(?:ue)?s?|feeds?|rss|atom|sitemaps?(?:[._-][^/]*)?|api|apis|developers?|opendata|open-data|archives?|repositor(?:y|ies)|records|registry|indexe?s?)(?:[/?#.]|$)/i;

export function bulkCandidatesOf(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (BULK_SHAPE.test(`${url.pathname}${url.search ? '?' : ''}`) || /^(data|api|opendata|catalog|download)s?\./i.test(url.hostname)) out.push(u);
    } catch {
      /* not an address */
    }
  }
  return out;
}

/** The one query a discovery makes for a need: its own words and host, asking for existing corpora rather than pages. */
export function discoveryQuery(need: Pick<AcquisitionNeed, 'purpose' | 'host'>): string {
  const words = need.purpose
    .replace(/https?:\/\/\S+/g, (u) => {
      try {
        return new URL(u).pathname.split(/[/_\-.]+/).filter((w) => w.length > 2 && !/^\d+$/.test(w)).join(' ');
      } catch {
        return '';
      }
    })
    .replace(/^\s*read\b/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${need.host ? `${need.host.toLowerCase()} ` : ''}${words} dataset OR "bulk download" OR export OR catalog OR API OR feed`.replace(/\s+/g, ' ').trim();
}

/** Look for existing corpora for a need: one polite, low-priority search (`discover.ts`). Never throws. */
export async function discoverExistingSources(
  need: Pick<AcquisitionNeed, 'purpose' | 'host'>,
  deps: { search?: (query: string) => Promise<string[]> } = {},
): Promise<SourceDiscovery> {
  const query = discoveryQuery(need);
  let candidates: string[] = [];
  try {
    candidates = (await (deps.search ?? ((q: string) => webSearch(q, { priority: 'LOW' })))(query)).slice(0, 8);
  } catch {
    candidates = [];
  }
  return { query, candidates, bulkCandidates: bulkCandidatesOf(candidates) };
}

interface EventRow {
  event_type?: string | null;
  outcome?: string | null;
  measures: string | null;
  at?: string | null;
}

function parseMeasures(row: { measures: string | null }): Record<string, unknown> | null {
  try {
    const m = JSON.parse(row.measures ?? '{}') as unknown;
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The newest SOURCE_DISCOVERY for a host inside the window, from rows. Pure. */
export function discoveryFromRows(rows: readonly EventRow[], host: string, opts: { now?: number; windowMs?: number } = {}): (SourceDiscovery & { at: string }) | null {
  const want = host.toLowerCase();
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowMs ?? REPEATED_USE_WINDOW_MS);
  let best: (SourceDiscovery & { at: string }) | null = null;
  for (const row of rows) {
    if (row.event_type && row.event_type !== SOURCE_DISCOVERY_EVENT) continue;
    const at = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at) || at < since || at > now) continue;
    const m = parseMeasures(row);
    if (!m || typeof m.host !== 'string' || m.host.toLowerCase() !== want) continue;
    if (best && Date.parse(best.at) >= at) continue;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    best = { query: typeof m.query === 'string' ? m.query : '', candidates: list(m.candidates), bulkCandidates: list(m.bulkCandidates), at: row.at! };
  }
  return best;
}

export async function readDiscoveryOnRecord(host: string): Promise<SourceDiscovery | null> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<EventRow>(
      `SELECT outcome, measures, at FROM bin_events WHERE event_type = ? AND at >= ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 20`,
      [SOURCE_DISCOVERY_EVENT, since, hostMeasuresPattern(host)],
    );
    return discoveryFromRows(rows, host);
  } catch {
    return null;
  }
}

/** The key one handoff is the same handoff by: host, capability and the boundary it stopped at. */
export function handoffKey(host: string, capability: string, boundary: string): string {
  return `${host.toLowerCase()}|${capability}|${boundary}`;
}

async function readHandoffOnRecord(host: string, capability: string, boundary: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<EventRow>(
      `SELECT outcome, measures, at FROM bin_events WHERE event_type = ? AND at >= ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 50`,
      [ACCESS_HANDOFF_EVENT, since, hostMeasuresPattern(host)],
    );
    const want = handoffKey(host, capability, boundary);
    return rows.some((r) => {
      const m = parseMeasures(r);
      return m !== null && typeof m.host === 'string' && handoffKey(m.host, String(m.capability), String(m.boundary)) === want;
    });
  } catch {
    return false;
  }
}

/** The exact step that answers a handoff, in words a person can do. */
function handoffNextStep(capability: AcquisitionCapability, host: string, boundary: string, seek: string): string {
  if (capability === 'OPERATE' && boundary === 'NO_AUTHORIZED_ACCOUNT') {
    return `grant an account Brain may operate ${host} under: npx tsx server/services/sources/operatePermissionCli.ts grant --host ${host} --account "<label>" --by <name>`;
  }
  return `secure ${seek} for ${host}; the next judgment for ${host} that routes without a handoff settles this`;
}

export interface OpenHandoff {
  host: string;
  capability: string;
  boundary: string;
  seek: string;
  nextStep: string;
  purpose: string;
  openedAt: string;
}

/**
 * The handoffs a person still has to answer, from rows. Pure.
 *
 * The newest ACCESS_HANDOFF per host, capability and boundary is open until a
 * later row answers it: an ACQUISITION_JUDGMENT for that host and capability
 * that routes without a handoff, or (for OPERATE) a later OPERATE_PERMISSION
 * grant for the host. Nothing is settled by a clock.
 */
export function openHandoffsFromRows(rows: readonly EventRow[]): OpenHandoff[] {
  const opened = new Map<string, OpenHandoff & { t: number }>();
  const answered = new Map<string, number>();
  const note = (k: string, t: number) => answered.set(k, Math.max(answered.get(k) ?? 0, t));
  for (const row of rows) {
    const t = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(t)) continue;
    const m = parseMeasures(row);
    if (!m || typeof m.host !== 'string') continue;
    const host = m.host.toLowerCase();
    if (row.event_type === ACCESS_HANDOFF_EVENT) {
      const capability = String(m.capability);
      const boundary = String(m.boundary);
      const key = handoffKey(host, capability, boundary);
      const prior = opened.get(key);
      if (prior && prior.t >= t) continue;
      opened.set(key, {
        host,
        capability,
        boundary,
        seek: typeof m.seek === 'string' ? m.seek : '',
        nextStep: typeof m.nextStep === 'string' ? m.nextStep : '',
        purpose: typeof m.purpose === 'string' ? m.purpose : '',
        openedAt: row.at!,
        t,
      });
    } else if (row.event_type === 'ACQUISITION_JUDGMENT' && row.outcome === 'ROUTE_SELECTED' && m.route !== 'HUMAN_HANDOFF') {
      note(`${host}|${String(m.capability)}`, t);
    } else if (row.event_type === OPERATE_PERMISSION_EVENT && row.outcome === 'GRANTED') {
      note(`${host}|OPERATE`, t);
    }
  }
  return [...opened.values()]
    .filter((h) => (answered.get(`${h.host}|${h.capability}`) ?? 0) <= h.t)
    .sort((a, b) => b.t - a.t)
    .map(({ t: _t, ...h }) => h);
}

/** Open handoffs from the record: the rows of the three kinds that open and answer them. Empty when unreadable. */
export async function readOpenHandoffs(): Promise<OpenHandoff[]> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const handoffs = await getDb().all<EventRow>(
      `SELECT event_type, outcome, measures, at FROM bin_events WHERE event_type = ? AND at >= ? ORDER BY at DESC LIMIT 500`,
      [ACCESS_HANDOFF_EVENT, since],
    );
    if (handoffs.length === 0) return [];
    const answers = await getDb().all<EventRow>(
      `SELECT event_type, outcome, measures, at FROM bin_events
        WHERE ((event_type = 'ACQUISITION_JUDGMENT' AND outcome = 'ROUTE_SELECTED') OR (event_type = ? AND outcome = 'GRANTED'))
          AND at >= ? ORDER BY at DESC LIMIT 5000`,
      [OPERATE_PERMISSION_EVENT, since],
    );
    return openHandoffsFromRows([...handoffs, ...answers]);
  } catch {
    return [];
  }
}

export interface RecordAcquisitionDeps {
  repeatedUse?: (host: string) => Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }>;
  /** The standing operate permission for a host; defaults to the OPERATE_PERMISSION rows. */
  operatePermission?: (host: string) => Promise<OperatePermission>;
  record?: typeof recordBinEvent;
  /** Whether a proposal for this host and route is already on record inside the window. */
  proposalOnRecord?: (host: string, route: string) => Promise<boolean>;
  /** The discovery already on record for a host inside the window; defaults to the SOURCE_DISCOVERY rows. */
  discoveryOnRecord?: (host: string) => Promise<SourceDiscovery | null>;
  /**
   * The search a SEARCH_FIRST judgment runs. Defaults to `discoverExistingSources`;
   * null records the judgment without running one (the caller has one in flight).
   */
  discover?: ((need: AcquisitionNeed) => Promise<SourceDiscovery>) | null;
  /** Run the discovery without waiting for it (a read path must not wait on a search); the first judgment is returned. */
  discoverInBackground?: boolean;
  /** Whether this handoff (host, capability, boundary) is already open on record inside the window. */
  handoffOnRecord?: (host: string, capability: string, boundary: string) => Promise<boolean>;
  caller?: string;
}

/** A connector or script is proposed once per host and route per window, not once per read. */
async function readProposalOnRecord(host: string, route: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<{ measures: string | null }>(
      `SELECT measures FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED' AND at >= ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 50`,
      [since, hostMeasuresPattern(host)],
    );
    return rows.some((r) => {
      try {
        const m = JSON.parse(r.measures ?? '{}') as { host?: unknown; route?: unknown };
        return m.host === host && m.route === route;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Judge a need with repetition read from the SOURCE_ACCESS history, persist the
 * judgment as a MEASURED `ACQUISITION_JUDGMENT` bin event, and act on it (see
 * the consumers above). Caller-supplied repetition counts are kept when
 * present; otherwise they are read from rows. When a SEARCH_FIRST judgment's
 * discovery is awaited, the judgment returned is the one made on its result.
 */
export async function recordAcquisitionJudgment(
  need: AcquisitionNeed,
  evidence: AcquisitionEvidence = {},
  deps: RecordAcquisitionDeps = {},
): Promise<AcquisitionJudgment> {
  const record = deps.record ?? recordBinEvent;
  const workloadClass = deps.caller ?? 'acquisition';
  const host = need.host?.toLowerCase() ?? null;
  let used = evidence;
  if (need.host && evidence.repeatedUses === undefined) {
    const counted = await (deps.repeatedUse ?? readRepeatedUse)(need.host);
    used = { ...evidence, ...counted };
  }
  // A search already made for this host answers "has anyone looked for existing corpora?"
  // for every later judgment of it, so SEARCH_FIRST is asked once per window, not once per read.
  let discoveryOnRecord = false;
  if (need.kind === 'ACQUIRE' && host && used.bulkSearchDone !== true && (used.existingBulkSources ?? []).length === 0) {
    const prior = await (deps.discoveryOnRecord ?? readDiscoveryOnRecord)(host).catch(() => null);
    if (prior) {
      used = { ...used, bulkSearchDone: true, existingBulkSources: prior.bulkCandidates };
      discoveryOnRecord = true;
    }
  }
  // An account the caller could not establish is looked up in the permission record:
  // a read path never knows about accounts, and a person's grant is what makes operation possible.
  let accountSource: 'CALLER' | 'PERMISSION_RECORD' | 'NONE' = used.authorizedAccountOnRecord === true ? 'CALLER' : 'NONE';
  let permission: OperatePermission | null = null;
  if (need.kind === 'OPERATE' && need.host && used.authorizedAccountOnRecord !== true) {
    permission = await (deps.operatePermission ?? readOperatePermission)(need.host);
    if (permission.permitted) {
      used = { ...used, authorizedAccountOnRecord: true };
      accountSource = 'PERMISSION_RECORD';
    }
  }

  const writeJudgment = async (judgment: AcquisitionJudgment, ev: AcquisitionEvidence, extra: Record<string, unknown>): Promise<void> => {
    await record({
      eventType: 'ACQUISITION_JUDGMENT',
      provider: judgment.route,
      workloadClass,
      outcome: judgment.outcome,
      reason: judgment.reason.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: {
        capability: judgment.capability,
        route: judgment.route,
        purpose: need.purpose.slice(0, 300),
        host,
        reusableConnectorJustified: judgment.reusableConnectorJustified,
        convertToScript: judgment.convertToScript,
        bespokeCrawlerMayBeProposed: judgment.bespokeCrawlerMayBeProposed,
        boundaries: judgment.boundaries,
        ...(judgment.handoff ? { handoff: judgment.handoff } : {}),
        repeatedUses: ev.repeatedUses ?? null,
        repeatedUsesNeedingFallback: ev.repeatedUsesNeedingFallback ?? null,
        existingBulkSources: (ev.existingBulkSources ?? []).length,
        bulkSearchDone: Boolean(ev.bulkSearchDone),
        ...(discoveryOnRecord ? { discoveryOnRecord: true } : {}),
        ...(need.kind === 'OPERATE'
          ? { authorizedAccount: accountSource, accountRef: permission?.permitted ? permission.accountRef : null }
          : {}),
        ...extra,
      },
    });
  };

  const actOn = async (judgment: AcquisitionJudgment, ev: AcquisitionEvidence): Promise<void> => {
    if (!host) return;
    // A justified connector or script is written down as a proposal for the host and route, once per
    // window. For ACQUIRE a bespoke route is proposable only after the search for existing corpora ran
    // and found nothing (`bespokeCrawlerMayBeProposed`); otherwise the corpora come first.
    const bespokeRoute = judgment.capability === 'ACQUIRE' && (judgment.route === 'HTTP' || judgment.route === 'BROWSER' || judgment.route === 'MODEL_ASSISTED');
    if ((judgment.reusableConnectorJustified || judgment.convertToScript) && judgment.route && (!bespokeRoute || judgment.bespokeCrawlerMayBeProposed)) {
      const seen = await (deps.proposalOnRecord ?? readProposalOnRecord)(host, judgment.route);
      if (!seen) {
        await record({
          eventType: 'CONNECTOR_PROPOSED',
          provider: judgment.route,
          workloadClass,
          outcome: judgment.convertToScript ? 'SCRIPT' : 'CONNECTOR',
          reason: (judgment.convertToScript
            ? `A model-assisted routine on ${host} has run unchanged ${ev.repeatedUses ?? 'repeatedly'} times: convert it to a tested script.`
            : `${need.kind === 'OPERATE' ? 'The workflow' : 'Reads'} on ${host} repeated ${ev.repeatedUses} times on record: build a reusable ${judgment.route} connector.`
          ).slice(0, 480),
          evidenceClass: 'MEASURED',
          measures: {
            host,
            route: judgment.route,
            capability: judgment.capability,
            kind: judgment.convertToScript ? 'SCRIPT' : 'CONNECTOR',
            repeatedUses: ev.repeatedUses ?? null,
            repeatedUsesNeedingFallback: ev.repeatedUsesNeedingFallback ?? null,
            ...(bespokeRoute ? { bespokeCrawlerMayBeProposed: true } : {}),
          },
        });
      }
    }
    // A handoff is a stop at a genuine boundary, and a stop nobody hears about is a silence:
    // open it once per host, capability and boundary, naming the permitted route and the next step.
    if (judgment.route === 'HUMAN_HANDOFF') {
      const boundary = judgment.boundaries[0] ?? 'NO_AUTOMATED_ROUTE';
      const seek = judgment.handoff ?? 'an official export, a licence, a partner integration or a specific human step';
      const open = await (deps.handoffOnRecord ?? readHandoffOnRecord)(host, judgment.capability, boundary).catch(() => false);
      if (!open) {
        const nextStep = handoffNextStep(judgment.capability, host, boundary, seek);
        await record({
          eventType: ACCESS_HANDOFF_EVENT,
          provider: 'HUMAN_HANDOFF',
          workloadClass,
          outcome: 'OPEN',
          reason: `${judgment.capability} on ${host} stopped at ${boundary}: seek ${seek}`.slice(0, 480),
          evidenceClass: 'MEASURED',
          measures: { host, capability: judgment.capability, boundary, boundaries: judgment.boundaries, seek: seek.slice(0, 300), nextStep: nextStep.slice(0, 400), purpose: need.purpose.slice(0, 300) },
        });
      }
    }
  };

  const judgment = judgeAcquisitionNeed(need, used);
  await writeJudgment(judgment, used, {});
  await actOn(judgment, used);

  // SEARCH_FIRST is acted on: the search for existing corpora runs, is recorded, and the need is judged
  // again on what it found — a bulk source to use, or (finding none) the bespoke route it may now propose.
  if (judgment.outcome === 'SEARCH_FIRST' && deps.discover !== null) {
    const discover = deps.discover ?? ((n: AcquisitionNeed) => discoverExistingSources(n));
    const run = async (): Promise<AcquisitionJudgment> => {
      const found = await discover(need);
      await record({
        eventType: SOURCE_DISCOVERY_EVENT,
        provider: 'BULK',
        workloadClass,
        outcome: found.bulkCandidates.length > 0 ? 'FOUND' : 'NONE_FOUND',
        reason: (found.bulkCandidates.length > 0
          ? `Existing corpora/exports/catalogs found for ${host ?? 'the need'}: ${found.bulkCandidates.slice(0, 3).join(' ')}`
          : `Searched for existing corpora, exports and catalogs for ${host ?? 'the need'}; none found (${found.candidates.length} pages returned)`
        ).slice(0, 480),
        evidenceClass: 'MEASURED',
        measures: {
          host,
          purpose: need.purpose.slice(0, 300),
          query: found.query.slice(0, 300),
          candidates: found.candidates.slice(0, 8).map((u) => u.slice(0, 300)),
          bulkCandidates: found.bulkCandidates.slice(0, 8).map((u) => u.slice(0, 300)),
        },
      });
      const after: AcquisitionEvidence = { ...used, bulkSearchDone: true, existingBulkSources: found.bulkCandidates };
      const followed = judgeAcquisitionNeed(need, after);
      await writeJudgment(followed, after, { followsDiscovery: true });
      await actOn(followed, after);
      return followed;
    };
    if (deps.discoverInBackground) {
      void run().catch(() => undefined);
      return judgment;
    }
    return run();
  }
  return judgment;
}
