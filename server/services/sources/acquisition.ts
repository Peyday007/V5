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
  caller?: string;
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
  const judgment = judgeAcquisitionNeed(need, used);
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
      bespokeCrawlerMayBeProposed: judgment.bespokeCrawlerMayBeProposed,
      boundaries: judgment.boundaries,
      repeatedUses: used.repeatedUses ?? null,
      repeatedUsesNeedingFallback: used.repeatedUsesNeedingFallback ?? null,
      existingBulkSources: (used.existingBulkSources ?? []).length,
      bulkSearchDone: Boolean(used.bulkSearchDone),
    },
  });
  return judgment;
}
