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
 *
 * OPERATE runs under the legitimate account available to it: a person's grant,
 * recorded once as a `SITE_ACCOUNT_GRANT` row and read on every OPERATE judgment,
 * so nobody logs in and clicks through again to say it is permitted. Without a
 * grant the judgment stops at NO_AUTHORIZED_ACCOUNT, as it must.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { ACCESS_METHODS } from './access.ts';
import { METHOD_CLASSES, selectAccessMethod, type AccessEvidence, type MethodClass } from './accessMethods.ts';

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
  /** The address the need is about, when one is known; scopes a path-limited account grant. */
  url?: string | null;
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
  /**
   * How often the interface workflow has been driven, and how many of those runs
   * worked unchanged — read from SOURCE_ACCESS rows (see `interfaceRecurrenceFromRows`).
   * The selector turns a stable recurring model-assisted pattern into a script from it.
   */
  interfaceRecurrence?: { runs: number; stable: number };
  /** Measured reliability (0..1) of each route for this need, when measured; handed to the one selector unchanged. */
  routeReliability?: AccessEvidence['reliability'];
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
}

/* ------------------------------------------------------------------------- */
/* The account an OPERATE need runs under                                     */
/* ------------------------------------------------------------------------- */

/**
 * An account Brain may operate a site under is a person's grant, never Brain's
 * inference. It is a `bin_events` row (`SITE_ACCOUNT_GRANT`, evidence class
 * OPERATOR_POLICY) written by `recordSiteAccountGrant`, naming the host, the
 * account by label, who granted it, and optionally which paths it covers and
 * when it lapses. A later row for the same host replaces it, and a REVOKED row
 * withdraws it, so the latest row is the answer and history is never rewritten.
 *
 * No credential is ever part of it: the label names the account, and the
 * secret stays in the session that signs in (§22). A grant is permission to
 * operate the interface; it is not permission to contact strangers, evade a
 * site's defenses or make a business commitment, and a boundary met while
 * operating still stops at a person (the selector checks boundaries first).
 */
export const SITE_ACCOUNT_GRANT_EVENT = 'SITE_ACCOUNT_GRANT';

export interface SiteAccountGrantInput {
  host: string;
  /** How the account is known (e.g. "research team login"). Never a password, token or key. */
  accountLabel: string;
  /** The person who granted it: a user id or address resolved by the surface that records it. */
  grantedBy: string;
  /** Path prefixes the grant covers; empty or absent means the whole host. */
  paths?: string[];
  /** What the grant is for, in words. */
  purpose?: string;
  /** When the grant lapses; absent means until revoked. */
  expiresAt?: string | null;
  /** Withdraw the grant for this host. */
  revoke?: boolean;
}

export interface SiteAccountOnRecord {
  host: string;
  accountLabel: string;
  grantedBy: string;
  grantedAt: string;
  paths: string[];
  expiresAt: string | null;
}

const CREDENTIAL_SHAPE = /(pass(word)?|secret|token|api[_-]?key|bearer)\s*[:=]|\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{8,}/i;

/** Record a person's grant (or withdrawal) of an account for a host. Refuses an input that would store a credential. */
export async function recordSiteAccountGrant(input: SiteAccountGrantInput, deps: { record?: typeof recordBinEvent } = {}): Promise<SiteAccountOnRecord | null> {
  const host = input.host.trim().toLowerCase();
  const label = input.accountLabel.trim();
  const grantedBy = input.grantedBy.trim();
  if (!host || !grantedBy || (!input.revoke && !label)) throw new Error('A site account grant names the host, the account and the person who granted it.');
  if (CREDENTIAL_SHAPE.test(label) || CREDENTIAL_SHAPE.test(input.purpose ?? '')) {
    throw new Error('A site account grant names the account; it never carries a credential. Keep the secret in the session that signs in.');
  }
  const paths = (input.paths ?? []).map((p) => (p.startsWith('/') ? p : `/${p}`).replace(/\/+$/, '') || '/').slice(0, 50);
  const expiresAt = input.expiresAt && Number.isFinite(Date.parse(input.expiresAt)) ? new Date(input.expiresAt).toISOString() : null;
  await (deps.record ?? recordBinEvent)({
    eventType: SITE_ACCOUNT_GRANT_EVENT,
    provider: null,
    workloadClass: 'acquisition',
    outcome: input.revoke ? 'REVOKED' : 'GRANTED',
    reason: (input.revoke
      ? `${grantedBy} withdrew the account for ${host}`
      : `${grantedBy} granted the account "${label}" for operating ${host}${paths.length ? ` (${paths.join(', ')})` : ''}${input.purpose ? `: ${input.purpose}` : ''}`
    ).slice(0, 480),
    evidenceClass: 'OPERATOR_POLICY',
    measures: { host, accountLabel: label.slice(0, 120), grantedBy: grantedBy.slice(0, 200), paths, purpose: (input.purpose ?? '').slice(0, 300), expiresAt },
  });
  return input.revoke ? null : { host, accountLabel: label, grantedBy, grantedAt: new Date().toISOString(), paths, expiresAt };
}

/**
 * The grant in force for a host (and path, when one is known), from grant rows. Pure.
 * The latest row for the host decides; a revoked, lapsed or out-of-scope grant is none.
 * With no path known, only a whole-host grant applies.
 */
export function siteAccountFromRows(
  rows: { outcome: string | null; measures: string | null; at: string | null }[],
  host: string,
  opts: { path?: string | null; now?: number } = {},
): SiteAccountOnRecord | null {
  const want = host.trim().toLowerCase();
  const now = opts.now ?? Date.now();
  let latest: { at: number; atText: string; outcome: string; m: Record<string, unknown> } | null = null;
  for (const row of rows) {
    const at = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at) || at > now) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(row.measures ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof m.host !== 'string' || m.host.toLowerCase() !== want) continue;
    if (!latest || at >= latest.at) latest = { at, atText: row.at!, outcome: row.outcome ?? '', m };
  }
  if (!latest || latest.outcome !== 'GRANTED') return null;
  const { m } = latest;
  const label = typeof m.accountLabel === 'string' ? m.accountLabel : '';
  const grantedBy = typeof m.grantedBy === 'string' ? m.grantedBy : '';
  if (!label || !grantedBy) return null;
  const expiresAt = typeof m.expiresAt === 'string' ? m.expiresAt : null;
  if (expiresAt && Date.parse(expiresAt) <= now) return null;
  const paths = Array.isArray(m.paths) ? (m.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  if (paths.length > 0) {
    const path = opts.path ? opts.path.replace(/\/+$/, '') || '/' : null;
    if (!path || !paths.some((p) => p === '/' || path === p || path.startsWith(`${p}/`))) return null;
  }
  return { host: want, accountLabel: label, grantedBy, grantedAt: latest.atText, paths, expiresAt };
}

/** The grant in force for a host from `bin_events`; null when none or unreadable. */
export async function readSiteAccount(host: string, path?: string | null): Promise<SiteAccountOnRecord | null> {
  try {
    const rows = await getDb().all<{ outcome: string | null; measures: string | null; at: string | null }>(
      `SELECT outcome, measures, at FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 2000`,
      [SITE_ACCOUNT_GRANT_EVENT],
    );
    return siteAccountFromRows(rows, host, { path });
  } catch {
    return null;
  }
}

/** The path a need is about, when its purpose or host names a URL. */
function pathOfNeed(need: AcquisitionNeed): string | null {
  const url = need.url ?? /https?:\/\/\S+/.exec(need.purpose)?.[0];
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
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
    ...(operate && evidence.interfaceRecurrence ? { recurrence: evidence.interfaceRecurrence } : {}),
    ...(evidence.routeReliability ? { reliability: evidence.routeReliability } : {}),
  });
  const route = selection.method;
  const boundaries: AcquisitionBoundary[] = [];
  if (route === 'HUMAN_HANDOFF') {
    if (evidence.requiresLicence) boundaries.push('TERMS_OR_LICENSE');
    else if (evidence.blockedAtBoundary) boundaries.push('ACCESS_BARRIER');
    else if (operate && !evidence.authorizedAccountOnRecord) boundaries.push('NO_AUTHORIZED_ACCOUNT');
  }
  const handoff = route === 'HUMAN_HANDOFF';
  const bespoke = !operate && (route === 'HTTP' || route === 'BROWSER' || route === 'MODEL_ASSISTED');
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
 * How often a host's interface workflow was driven, and how many of those runs worked,
 * from `SOURCE_ACCESS` rows. Pure over rows. Grouped by workflow key like
 * `repeatedUseFromRows`; a run is a read whose attempts include BROWSER, and it is
 * stable when that BROWSER attempt was readable. The most-run workflow decides.
 */
export function interfaceRecurrenceFromRows(
  rows: { measures: string | null; at?: string | null }[],
  host: string,
  opts: { now?: number; windowMs?: number } = {},
): { runs: number; stable: number } {
  const want = host.toLowerCase();
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowMs ?? REPEATED_USE_WINDOW_MS);
  const groups = new Map<string, { runs: number; stable: number }>();
  for (const row of rows) {
    const at = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at) || at < since || at > now) continue;
    let measures: { host?: unknown; url?: unknown; attempts?: unknown } = {};
    try {
      measures = row.measures ? (JSON.parse(row.measures) as typeof measures) : {};
    } catch {
      continue;
    }
    if (typeof measures.host !== 'string' || measures.host.toLowerCase() !== want || !Array.isArray(measures.attempts)) continue;
    const browser = (measures.attempts as { method?: unknown; readable?: unknown }[]).filter((a) => a?.method === 'BROWSER');
    if (browser.length === 0) continue;
    const key = workflowKeyOf(measures, want);
    const g = groups.get(key) ?? { runs: 0, stable: 0 };
    g.runs += 1;
    if (browser.some((a) => a.readable === true)) g.stable += 1;
    groups.set(key, g);
  }
  let best = { runs: 0, stable: 0 };
  for (const g of groups.values()) if (g.runs > best.runs || (g.runs === best.runs && g.stable > best.stable)) best = g;
  return best;
}

/** Interface recurrence for a host from existing SOURCE_ACCESS rows; zeros when unreadable. */
export async function readInterfaceRecurrence(host: string): Promise<{ runs: number; stable: number }> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<{ measures: string | null; at: string | null }>(
      `SELECT measures, at FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? ORDER BY at DESC LIMIT 5000`,
      [since],
    );
    return interfaceRecurrenceFromRows(rows, host);
  } catch {
    return { runs: 0, stable: 0 };
  }
}

/** Repeated-use counts for a host from existing SOURCE_ACCESS rows; zeros when unreadable. */
export async function readRepeatedUse(host: string): Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<{ provider: string | null; measures: string | null; at: string | null }>(
      `SELECT provider, measures, at FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? ORDER BY at DESC LIMIT 5000`,
      [since],
    );
    return repeatedUseFromRows(rows, host);
  } catch {
    return { repeatedUses: 0, repeatedUsesNeedingFallback: 0 };
  }
}

export interface RecordAcquisitionDeps {
  repeatedUse?: (host: string) => Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }>;
  record?: typeof recordBinEvent;
  /** Whether a proposal for this host and route is already on record inside the window. */
  proposalOnRecord?: (host: string, route: string) => Promise<boolean>;
  /** The account grant in force for an OPERATE need's host (and path); defaults to the grant rows. */
  accountOnRecord?: (host: string, path: string | null) => Promise<SiteAccountOnRecord | null>;
  /** How often the host's interface workflow ran and held; defaults to the SOURCE_ACCESS rows. */
  interfaceRecurrence?: (host: string) => Promise<{ runs: number; stable: number }>;
  caller?: string;
}

/** A connector or script is proposed once per host and route per window, not once per read. */
async function readProposalOnRecord(host: string, route: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
    const rows = await getDb().all<{ measures: string | null }>(
      `SELECT measures FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED' AND at >= ? ORDER BY at DESC LIMIT 500`,
      [since],
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
 * Judge a need with repetition read from the SOURCE_ACCESS history, and persist
 * the judgment as a MEASURED `ACQUISITION_JUDGMENT` bin event. Caller-supplied
 * repetition counts are kept when present; otherwise they are read from rows.
 */
export async function recordAcquisitionJudgment(
  need: AcquisitionNeed,
  evidence: AcquisitionEvidence = {},
  deps: RecordAcquisitionDeps = {},
): Promise<AcquisitionJudgment> {
  let used = evidence;
  if (need.host && evidence.repeatedUses === undefined) {
    const counted = await (deps.repeatedUse ?? readRepeatedUse)(need.host);
    used = { ...evidence, ...counted };
  }
  // OPERATE runs under an account a person granted, read from the grant record. A caller's
  // `false` means its own read evidenced no session, not that none was granted, so the
  // record decides; a caller that already holds one (true) is kept.
  let account: SiteAccountOnRecord | null = null;
  if (need.kind === 'OPERATE' && need.host && used.authorizedAccountOnRecord !== true) {
    account = await (deps.accountOnRecord ?? readSiteAccount)(need.host.toLowerCase(), pathOfNeed(need)).catch(() => null);
    if (account) used = { ...used, authorizedAccountOnRecord: true };
  }
  if (need.kind === 'OPERATE' && need.host && used.interfaceRecurrence === undefined) {
    const recurrence = await (deps.interfaceRecurrence ?? readInterfaceRecurrence)(need.host.toLowerCase()).catch(() => null);
    if (recurrence && recurrence.runs > 0) used = { ...used, interfaceRecurrence: recurrence };
  }
  const judged = judgeAcquisitionNeed(need, used);
  const judgment: AcquisitionJudgment =
    account && judged.outcome === 'ROUTE_SELECTED' && (judged.route === 'BROWSER' || judged.route === 'MODEL_ASSISTED')
      ? { ...judged, reason: `${judged.reason} Operated under the account "${account.accountLabel}" granted by ${account.grantedBy} at ${account.grantedAt}.` }
      : judged;
  await (deps.record ?? recordBinEvent)({
    eventType: 'ACQUISITION_JUDGMENT',
    provider: judgment.route,
    workloadClass: deps.caller ?? 'acquisition',
    outcome: judgment.outcome,
    reason: judgment.reason.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: {
      capability: judgment.capability,
      route: judgment.route,
      purpose: need.purpose.slice(0, 300),
      host: need.host?.toLowerCase() ?? null,
      reusableConnectorJustified: judgment.reusableConnectorJustified,
      convertToScript: judgment.convertToScript,
      bespokeCrawlerMayBeProposed: judgment.bespokeCrawlerMayBeProposed,
      boundaries: judgment.boundaries,
      repeatedUses: used.repeatedUses ?? null,
      repeatedUsesNeedingFallback: used.repeatedUsesNeedingFallback ?? null,
      existingBulkSources: (used.existingBulkSources ?? []).length,
      bulkSearchDone: Boolean(used.bulkSearchDone),
      ...(need.kind === 'OPERATE'
        ? {
            authorizedAccount: account
              ? { label: account.accountLabel, grantedBy: account.grantedBy, grantedAt: account.grantedAt, source: 'GRANT_RECORD' }
              : used.authorizedAccountOnRecord
                ? { source: 'CALLER' }
                : null,
            interfaceRecurrence: used.interfaceRecurrence ?? null,
          }
        : {}),
    },
  });
  // The consumer of both flags: a justified connector or script is written down as a proposal
  // for the host and route, once per window, so the decision to build it is a row someone can act on.
  if ((judgment.reusableConnectorJustified || judgment.convertToScript) && need.host && judgment.route) {
    const host = need.host.toLowerCase();
    const seen = await (deps.proposalOnRecord ?? readProposalOnRecord)(host, judgment.route);
    if (!seen) {
      await (deps.record ?? recordBinEvent)({
        eventType: 'CONNECTOR_PROPOSED',
        provider: judgment.route,
        workloadClass: deps.caller ?? 'acquisition',
        outcome: judgment.convertToScript ? 'SCRIPT' : 'CONNECTOR',
        reason: (judgment.convertToScript
          ? `A model-assisted routine on ${host} has run unchanged ${used.interfaceRecurrence?.stable ?? used.repeatedUses ?? 'repeatedly'} times: convert it to a tested script.`
          : `${need.kind === 'OPERATE' ? 'The workflow' : 'Reads'} on ${host} repeated ${used.repeatedUses} times on record: build a reusable ${judgment.route} connector.`
        ).slice(0, 480),
        evidenceClass: 'MEASURED',
        measures: {
          host,
          route: judgment.route,
          capability: judgment.capability,
          kind: judgment.convertToScript ? 'SCRIPT' : 'CONNECTOR',
          repeatedUses: used.repeatedUses ?? null,
          repeatedUsesNeedingFallback: used.repeatedUsesNeedingFallback ?? null,
        },
      });
    }
  }
  return judgment;
}
