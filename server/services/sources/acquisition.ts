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
  /** A stable recurring model-assisted pattern should become a tested script (from the one selector). */
  convertToScript: boolean;
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

/*
 * The acquisition history: the SOURCE_ACCESS, OPERATE_PERMISSION and
 * CONNECTOR_PROPOSED rows the judgments read, held once per process.
 *
 * Every public read records a judgment, so these reads run on the research hot
 * path. Reading the rows per read (5,000 access rows twice for a browser read,
 * 2,000 permission rows unfiltered, 500 proposals) put an unmeasured load on
 * the shared database (§61/§63). Instead the rows are loaded in one pass at
 * most every `ACQUISITION_HISTORY_REFRESH_MS`, single-flight, the cadence the
 * access learner already uses (`access.ts` LEARN_REFRESH_MS), and what this
 * process writes is added as it is written (`noteSourceAccess`, the permission
 * and proposal writers below). So a read sees its own and this process's
 * earlier reads at once, and other processes' rows within one refresh.
 *
 * The rows stay the record (§45): nothing is stored here that a reload cannot
 * rebuild. A read path's OPERATE judgment is a recorded judgment about a public
 * read — the research browser signs into nothing — so a revocation recorded by
 * another process reaching it within one refresh performs no effect meanwhile;
 * one recorded in this process applies to the next read.
 */
export const ACQUISITION_HISTORY_REFRESH_MS = 5 * 60_000;
/** The most rows of each kind held, the same bounds the per-read queries used. */
const ACCESS_ROWS_MAX = 5000;
const PERMISSION_ROWS_MAX = 2000;

interface AccessRow {
  provider: string | null;
  measures: string | null;
  at: string | null;
}
interface PermissionRow {
  outcome: string | null;
  measures: string | null;
  at: string | null;
}
interface AcquisitionHistory {
  loadedAt: number;
  /** Newest first. */
  access: AccessRow[];
  /** Newest first. */
  permissions: PermissionRow[];
  /** `host|route` of every proposal inside the window. */
  proposals: Set<string>;
}

let history: AcquisitionHistory | null = null;
let historyLoading: Promise<void> | null = null;
let historyLoads = 0;

const proposalKey = (host: string, route: string) => `${host.toLowerCase()}|${route}`;

async function loadHistory(): Promise<void> {
  historyLoads += 1;
  const since = new Date(Date.now() - REPEATED_USE_WINDOW_MS).toISOString();
  const next: AcquisitionHistory = { loadedAt: Date.now(), access: [], permissions: [], proposals: new Set() };
  const db = getDb();
  // Each kind is read on its own, so one unreadable kind leaves the others' rows (and zeros, never guesses, for it).
  try {
    next.access = await db.all<AccessRow>(
      `SELECT provider, measures, at FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? ORDER BY at DESC LIMIT ${ACCESS_ROWS_MAX}`,
      [since],
    );
  } catch {
    /* no repetition is evidenced */
  }
  try {
    next.permissions = await db.all<PermissionRow>(
      `SELECT outcome, measures, at FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT ${PERMISSION_ROWS_MAX}`,
      [OPERATE_PERMISSION_EVENT],
    );
  } catch {
    /* no permission is evidenced */
  }
  try {
    const rows = await db.all<{ measures: string | null }>(
      `SELECT measures FROM bin_events WHERE event_type = 'CONNECTOR_PROPOSED' AND at >= ? ORDER BY at DESC LIMIT 500`,
      [since],
    );
    for (const r of rows) {
      try {
        const m = JSON.parse(r.measures ?? '{}') as { host?: unknown; route?: unknown };
        if (typeof m.host === 'string' && typeof m.route === 'string') next.proposals.add(proposalKey(m.host, m.route));
      } catch {
        /* an unparseable row proposes nothing */
      }
    }
  } catch {
    /* no proposal is on record */
  }
  history = next;
}

async function currentHistory(): Promise<AcquisitionHistory> {
  if (!history || Date.now() - history.loadedAt > ACQUISITION_HISTORY_REFRESH_MS) {
    historyLoading ??= loadHistory().finally(() => {
      historyLoading = null;
    });
    await historyLoading;
  }
  return history ?? { loadedAt: Date.now(), access: [], permissions: [], proposals: new Set() };
}

/** Forget the held rows, so the next judgment reads them again (tests, and `resetSourceAccessMemory`). */
export function resetAcquisitionHistory(): void {
  history = null;
  historyLoading = null;
  historyLoads = 0;
}

/** How many times the rows were loaded since the last reset: the load this module puts on the database. */
export function acquisitionHistoryLoads(): number {
  return historyLoads;
}

/** Add a SOURCE_ACCESS row this process just wrote, so the next judgment counts it without reading it back. */
export function noteSourceAccess(row: { provider: string | null; measures: Record<string, unknown> | string | null; at?: string | null }): void {
  if (!history) return;
  history.access.unshift({
    provider: row.provider,
    measures: typeof row.measures === 'string' || row.measures === null ? row.measures : JSON.stringify(row.measures),
    at: row.at ?? new Date().toISOString(),
  });
  if (history.access.length > ACCESS_ROWS_MAX) history.access.length = ACCESS_ROWS_MAX;
}

/** Repeated-use counts for a host from the SOURCE_ACCESS rows; zeros when unreadable. */
export async function readRepeatedUse(host: string): Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }> {
  try {
    return repeatedUseFromRows((await currentHistory()).access, host);
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
 * This is the record the OPERATE judgment reads. An OPERATE need comes from a
 * caller that asks to operate a system — never from a read: `access.ts` records
 * every read as ACQUIRE only, whatever route it took — so the judgment consults
 * this record whenever that caller has not itself established an account, and an
 * operation becomes BROWSER or MODEL_ASSISTED exactly when a person granted it. A permission is never
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

/** The standing operate permission for a host, read from the rows; none when unreadable. */
export async function readOperatePermission(host: string): Promise<OperatePermission> {
  try {
    return operatePermissionFromRows((await currentHistory()).permissions, host);
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
  const measures = { host, accountRef: input.granted ? accountRef : null, grantedBy: input.grantedBy.trim() };
  await (deps.record ?? recordBinEvent)({
    eventType: OPERATE_PERMISSION_EVENT,
    workloadClass: 'acquisition',
    outcome: input.granted ? 'GRANTED' : 'REVOKED',
    reason: `${input.granted ? 'Granted' : 'Revoked'} operating ${host}${accountRef ? ` under ${accountRef}` : ''}${input.note ? `: ${input.note}` : ''}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures,
  });
  // The next judgment in this process honours the grant or revocation at once, without reading it back.
  if (!deps.record && history) {
    history.permissions.unshift({ outcome: input.granted ? 'GRANTED' : 'REVOKED', measures: JSON.stringify(measures), at: new Date().toISOString() });
  }
  return input.granted
    ? { permitted: true, accountRef, grantedBy: input.grantedBy.trim(), at: null }
    : { ...NO_PERMISSION, grantedBy: input.grantedBy.trim() };
}

export interface RecordAcquisitionDeps {
  repeatedUse?: (host: string) => Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }>;
  /** The standing operate permission for a host; defaults to the OPERATE_PERMISSION rows. */
  operatePermission?: (host: string) => Promise<OperatePermission>;
  record?: typeof recordBinEvent;
  /** Whether a proposal for this host and route is already on record inside the window. */
  proposalOnRecord?: (host: string, route: string) => Promise<boolean>;
  caller?: string;
}

/** A connector or script is proposed once per host and route per window, not once per read. */
async function readProposalOnRecord(host: string, route: string): Promise<boolean> {
  try {
    return (await currentHistory()).proposals.has(proposalKey(host, route));
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
      convertToScript: judgment.convertToScript,
      bespokeCrawlerMayBeProposed: judgment.bespokeCrawlerMayBeProposed,
      boundaries: judgment.boundaries,
      repeatedUses: used.repeatedUses ?? null,
      repeatedUsesNeedingFallback: used.repeatedUsesNeedingFallback ?? null,
      existingBulkSources: (used.existingBulkSources ?? []).length,
      bulkSearchDone: Boolean(used.bulkSearchDone),
      ...(need.kind === 'OPERATE'
        ? { authorizedAccount: accountSource, accountRef: permission?.permitted ? permission.accountRef : null }
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
          ? `A model-assisted routine on ${host} has run unchanged ${used.repeatedUses ?? 'repeatedly'} times: convert it to a tested script.`
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
      if (!deps.record && history) history.proposals.add(proposalKey(host, judgment.route));
    }
  }
  return judgment;
}
