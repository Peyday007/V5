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

export const ACQUISITION_CAPABILITIES = ['OPERATE', 'ACQUIRE'] as const;
export type AcquisitionCapability = (typeof ACQUISITION_CAPABILITIES)[number];

/** The access routes a judgment may choose. The first six are Brain's readers in `access.ts`; the rest are the spec's other routes. */
export const ACQUISITION_ROUTES = [
  'NATIVE_INTEGRATION',
  'BULK_SOURCE',
  'HTTP',
  'BROWSER_AUTOMATION',
  'MODEL_ASSISTED_BROWSER',
  'HUMAN_HANDOFF',
] as const;
export type AcquisitionRoute = (typeof ACQUISITION_ROUTES)[number];

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

  // A genuine access boundary: stop and seek permitted access.
  if (evidence.blockedAtBoundary || evidence.requiresLicence) {
    return {
      capability,
      outcome: 'ROUTE_SELECTED',
      route: 'HUMAN_HANDOFF',
      reason: evidence.requiresLicence
        ? 'The data needs a licence or the terms do not permit the use; seek a licence, official export or partner integration rather than automate around it.'
        : 'Authentication, owner consent, CAPTCHA or bot restrictions block automation; stop at the boundary and seek permitted access, an official export, a licence, a partner integration or a specific human step.',
      reusableConnectorJustified: false,
      bespokeCrawlerMayBeProposed: false,
      boundaries: [evidence.requiresLicence ? 'TERMS_OR_LICENSE' : 'ACCESS_BARRIER'],
    };
  }

  const justified = connectorJustified(evidence, capability === 'OPERATE');

  if (capability === 'OPERATE') {
    if (evidence.nativeIntegrationAvailable) {
      return {
        capability,
        outcome: 'ROUTE_SELECTED',
        route: 'NATIVE_INTEGRATION',
        reason: 'A first-party integration exists for the functionality; it is the reliable, permitted, low-cost route.',
        reusableConnectorJustified: justified,
        bespokeCrawlerMayBeProposed: false,
        boundaries: [],
      };
    }
    if (!evidence.authorizedAccountOnRecord) {
      return {
        capability,
        outcome: 'ROUTE_SELECTED',
        route: 'HUMAN_HANDOFF',
        reason: 'No public API and no authorized account on record: operating the interface needs an account Brain is permitted to use, so the step is a person granting one.',
        reusableConnectorJustified: false,
        bespokeCrawlerMayBeProposed: false,
        boundaries: ['NO_AUTHORIZED_ACCOUNT'],
      };
    }
    const route: AcquisitionRoute = evidence.interfaceUnfamiliarOrChanged ? 'MODEL_ASSISTED_BROWSER' : 'BROWSER_AUTOMATION';
    return {
      capability,
      outcome: 'ROUTE_SELECTED',
      route,
      reason:
        (evidence.interfaceUnfamiliarOrChanged
          ? 'No public API; an authorized account is on record; the interface is unfamiliar or changed, so a model helps interpret it and propose a reusable routine. '
          : 'No public API; an authorized account is on record; the interface is operated with reliable locators and explicit success checks. ') +
        (justified
          ? `The workflow has repeated ${evidence.repeatedUses} times on record, so a tested reusable connector replaces model-per-click work.`
          : 'Repetition on record does not yet justify a reusable connector.'),
      reusableConnectorJustified: justified,
      bespokeCrawlerMayBeProposed: false,
      boundaries: [],
    };
  }

  // ACQUIRE: existing corpora, bulk exports and catalogs before any bespoke crawler.
  const existing = evidence.existingBulkSources ?? [];
  if (evidence.nativeIntegrationAvailable) {
    return {
      capability,
      outcome: 'ROUTE_SELECTED',
      route: 'NATIVE_INTEGRATION',
      reason: 'An official API, export or standard protocol serves the need; it precedes any crawler.',
      reusableConnectorJustified: justified,
      bespokeCrawlerMayBeProposed: false,
      boundaries: [],
    };
  }
  if (existing.length > 0) {
    return {
      capability,
      outcome: 'ROUTE_SELECTED',
      route: 'BULK_SOURCE',
      reason: `${existing.length} existing corpus/bulk export/catalog found (${existing.slice(0, 3).join('; ').slice(0, 200)}); use it before writing a bespoke crawler.`,
      reusableConnectorJustified: justified,
      bespokeCrawlerMayBeProposed: false,
      boundaries: [],
    };
  }
  if (!evidence.bulkSearchDone) {
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
  if (evidence.stableHttpDocuments) {
    return {
      capability,
      outcome: 'ROUTE_SELECTED',
      route: 'HTTP',
      reason: 'The existing-source search found nothing to reuse; stable documents are reachable by ordinary HTTP honoring terms and rate limits, so a bounded paginated download (a crawler of last resort) may be proposed.',
      reusableConnectorJustified: justified,
      bespokeCrawlerMayBeProposed: true,
      boundaries: [],
    };
  }
  if (evidence.interactiveInterfaceOnly) {
    return {
      capability,
      outcome: 'ROUTE_SELECTED',
      route: evidence.interfaceUnfamiliarOrChanged ? 'MODEL_ASSISTED_BROWSER' : 'BROWSER_AUTOMATION',
      reason: 'The existing-source search found nothing to reuse and the interactive interface is the supported way in; bounded browser work is the route.',
      reusableConnectorJustified: justified,
      bespokeCrawlerMayBeProposed: true,
      boundaries: [],
    };
  }
  return {
    capability,
    outcome: 'ROUTE_SELECTED',
    route: 'HUMAN_HANDOFF',
    reason: 'The existing-source search found nothing to reuse and no permitted automated route is established; seek an official export, licence or partner integration.',
    reusableConnectorJustified: false,
    bespokeCrawlerMayBeProposed: false,
    boundaries: [],
  };
}

/** Only recent use counts as repetition: a host busy last year is not repeated work now. */
export const REPEATED_USE_WINDOW_DAYS = 30;

/** One workflow on a host: its path without query or fragment, so a repeat is the same work again. */
function workflowKey(url: unknown, host: string): string {
  if (typeof url !== 'string') return host;
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return host;
  }
}

/**
 * Repeated use of one workflow on a host, counted from `SOURCE_ACCESS` event rows. Pure over rows.
 *
 * Repetition is the busiest single workflow (same host and path) inside the window, not every
 * row for the host: traffic across many different pages is volume, not repeated work. A use
 * "needed a fallback" only when its own attempts show an earlier route failing before a
 * different one served; a row that records no attempts says nothing and is not counted.
 * A row with an `at` older than the window is ignored; rows without one are taken as current.
 */
export function repeatedUseFromRows(
  rows: { provider: string | null; measures: string | null; at?: string | null }[],
  host: string,
  now: number = Date.now(),
): { repeatedUses: number; repeatedUsesNeedingFallback: number } {
  const want = host.toLowerCase();
  const since = now - REPEATED_USE_WINDOW_DAYS * 86_400_000;
  const flows = new Map<string, { uses: number; fallback: number }>();
  for (const row of rows) {
    if (row.at) {
      const t = Date.parse(row.at);
      if (Number.isFinite(t) && t < since) continue;
    }
    let measures: { host?: unknown; url?: unknown; attempts?: unknown } = {};
    try {
      measures = row.measures ? (JSON.parse(row.measures) as typeof measures) : {};
    } catch {
      continue;
    }
    if (typeof measures.host !== 'string' || measures.host.toLowerCase() !== want) continue;
    const flow = flows.get(workflowKey(measures.url, want)) ?? { uses: 0, fallback: 0 };
    flow.uses += 1;
    const attempts = Array.isArray(measures.attempts) ? (measures.attempts as { readable?: unknown }[]) : [];
    const failedFirst = attempts.length > 1 && attempts[0]?.readable === false;
    if (row.provider && row.provider !== 'DIRECT' && (ACCESS_METHODS as readonly string[]).includes(row.provider) && failedFirst) flow.fallback += 1;
    flows.set(workflowKey(measures.url, want), flow);
  }
  let repeatedUses = 0;
  let repeatedUsesNeedingFallback = 0;
  for (const flow of flows.values()) {
    if (flow.uses > repeatedUses) repeatedUses = flow.uses;
    if (flow.fallback > repeatedUsesNeedingFallback) repeatedUsesNeedingFallback = flow.fallback;
  }
  return { repeatedUses, repeatedUsesNeedingFallback };
}

/** Repeated-use counts for a host from existing SOURCE_ACCESS rows in the window; zeros when unreadable. */
export async function readRepeatedUse(host: string): Promise<{ repeatedUses: number; repeatedUsesNeedingFallback: number }> {
  try {
    const now = Date.now();
    const since = new Date(now - REPEATED_USE_WINDOW_DAYS * 86_400_000).toISOString();
    // Filtered by host in the query, so other hosts' traffic cannot fill the row limit.
    const rows = await getDb().all<{ provider: string | null; measures: string | null; at: string | null }>(
      `SELECT provider, measures, at FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? AND measures LIKE ? ORDER BY at DESC LIMIT 5000`,
      [since, `%${host.toLowerCase().replace(/[\\%]/g, '')}%`],
    );
    return repeatedUseFromRows(rows, host, now);
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
