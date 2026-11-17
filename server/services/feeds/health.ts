/**
 * Connector health for feed sources (ACQ-21-4 item 8).
 *
 * A source that stopped yielding records has failed in one of several ways, and
 * each one wants a different answer:
 *
 *   TRANSIENT_OUTAGE    5xx, 429, a timeout or a refused connection — the
 *                       provider is down for now. Retried on the feed loop's own
 *                       doubling backoff (`nextPullAt`); never a Factory objective.
 *   BROKEN_PARSER       a 2xx body the parser cannot read (not JSON, or records
 *                       present that the parser reads none of, shape unchanged).
 *   SCHEMA_CHANGED      the body still parses but its shape moved: the parser that
 *                       read records from this source now reads none, repeatedly,
 *                       or the body's top-level keys differ from the last good pull.
 *   PERMISSION_REVOKED  401 or 403 — the provider refuses this reader. Reported as
 *                       a permission need; never retried as an outage and never
 *                       worked around (§18, accessMethods' boundary rule).
 *   DEAD_ENDPOINT       404/410 or a DNS failure that persists.
 *   STALE               pulls succeed but nothing new has arrived for longer than
 *                       the source's expected freshness.
 *   HEALTHY             otherwise.
 *
 * A parser or schema fault is a repeatable repair, so it is routed to Factory
 * through the existing improvement loop (`registerDirected`, §87), keyed by
 * source so repeated detection is one candidate. The next pull that reads
 * records again marks it reverified. Decisions are rows on the existing
 * bin-event writer; this module owns no scheduler, queue or table.
 */

import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import type { Weakness } from '../../domain/improvement.ts';
import { nextPullAt } from './run.ts';

export const CONNECTOR_HEALTH_EVENT = 'CONNECTOR_HEALTH';

export const CONNECTOR_STATES = [
  'HEALTHY',
  'TRANSIENT_OUTAGE',
  'BROKEN_PARSER',
  'SCHEMA_CHANGED',
  'PERMISSION_REVOKED',
  'DEAD_ENDPOINT',
  'STALE',
] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

/** One recorded pull, as `feed_pulls` holds it, plus what the fetcher saw of the body when it said. */
export interface PullOutcome {
  at: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  error: string | null;
  /** Records the raw body held before parsing, when the fetcher counted them. */
  bodyRecords?: number | null;
  /** The body's top-level keys, when the fetcher recorded them. */
  topKeys?: readonly string[] | null;
}

export type ConnectorAction = 'NONE' | 'BACKOFF' | 'ROUTE_TO_FACTORY' | 'PERMISSION_NEED' | 'REDISCOVER' | 'WATCH';

export interface ConnectorVerdict {
  source: string;
  state: ConnectorState;
  action: ConnectorAction;
  reason: string;
  /** When the source may be asked again (BACKOFF only); null means not on a clock. */
  retryAt: string | null;
  /** Whether the feed loop may retry it as a transient failure. */
  retryAsOutage: boolean;
  /** The latest pull read records again after an earlier fault. */
  recovered: boolean;
  /** HTTP status of the latest failure, when one was recorded. */
  status: number | null;
}

/** Consecutive same-kind failures after which a 404 or DNS failure is a dead endpoint rather than a blip. */
export const DEAD_ENDPOINT_STREAK = 3;
/** Consecutive zero-record successes, after a past pull that read records, that mean the shape moved. */
export const SCHEMA_ZERO_STREAK = 3;
/** Expected freshness, as a multiple of the pull interval, past which no new record is STALE. */
export const STALE_INTERVALS = 4;

type FailureKind = 'TRANSIENT' | 'PERMISSION' | 'NOT_FOUND' | 'DNS' | 'UNREADABLE_BODY';

/** What one recorded error string means. Pure. Unknown errors are transient: they get a backoff, not a repair. */
export function failureKind(error: string | null): { kind: FailureKind; status: number | null } {
  const e = error ?? '';
  const http = /\bHTTP (\d{3})\b/.exec(e);
  const status = http ? Number(http[1]) : null;
  if (status === 401 || status === 403) return { kind: 'PERMISSION', status };
  if (status === 404 || status === 410) return { kind: 'NOT_FOUND', status };
  if (/ENOTFOUND/.test(e)) return { kind: 'DNS', status };
  // `response.json()` on a 2xx body that is not JSON: the body arrived and could not be read.
  if (status === null && /SyntaxError|Unexpected token|not valid JSON|JSON\.parse|Unexpected end of JSON/i.test(e)) return { kind: 'UNREADABLE_BODY', status };
  return { kind: 'TRANSIENT', status };
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((k, i) => k === [...b].sort()[i]);

/**
 * Classify a source from its recorded pulls, newest first or in any order. Pure.
 * `intervalMs` is the source's pull interval (expected freshness derives from it).
 */
export function classifyConnector(
  source: string,
  history: readonly PullOutcome[],
  opts: { intervalMs: number; now?: number },
): ConnectorVerdict {
  const now = opts.now ?? Date.now();
  const pulls = [...history].filter((p) => Number.isFinite(Date.parse(p.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const base = { source, retryAt: null, retryAsOutage: false, recovered: false, status: null } as const;
  const latest = pulls[0];
  if (!latest) return { ...base, state: 'HEALTHY', action: 'WATCH', reason: 'no pull recorded yet; nothing to judge' };

  const everRead = pulls.some((p) => p.ok && p.fetched > 0);
  const lastGood = pulls.find((p) => p.ok && p.fetched > 0) ?? null;

  if (!latest.ok) {
    const streak: PullOutcome[] = [];
    for (const p of pulls) {
      if (p.ok) break;
      streak.push(p);
    }
    const { kind, status } = failureKind(latest.error);
    const sameKind = streak.filter((p) => failureKind(p.error).kind === kind).length;
    if (kind === 'PERMISSION') {
      return {
        ...base,
        status,
        state: 'PERMISSION_REVOKED',
        action: 'PERMISSION_NEED',
        reason: `${source} answered HTTP ${status}${everRead ? ' after earlier successful pulls' : ''}: the provider refuses this reader. A permission is needed (an authorized account, an official export or the provider's consent); it is not retried as an outage and not worked around.`,
      };
    }
    if (kind === 'UNREADABLE_BODY') {
      return {
        ...base,
        state: 'BROKEN_PARSER',
        action: 'ROUTE_TO_FACTORY',
        reason: `${source} returned a body its reader could not parse (${(latest.error ?? '').slice(0, 120)}): a repeatable repair to the parser.`,
      };
    }
    if ((kind === 'NOT_FOUND' || kind === 'DNS') && sameKind >= DEAD_ENDPOINT_STREAK) {
      return {
        ...base,
        status,
        state: 'DEAD_ENDPOINT',
        action: 'REDISCOVER',
        reason: `${source}: ${kind === 'DNS' ? 'the host does not resolve' : `HTTP ${status}`} on ${sameKind} consecutive pulls — the endpoint is gone; find its successor rather than retrying.`,
      };
    }
    const retryAt = nextPullAt({ intervalMs: opts.intervalMs }, { lastSuccessAt: lastGood?.at ?? null, failuresSince: streak.length, lastFailureAt: latest.at });
    return {
      ...base,
      status,
      state: 'TRANSIENT_OUTAGE',
      action: 'BACKOFF',
      retryAsOutage: true,
      retryAt: new Date(retryAt).toISOString(),
      reason: `${source}: ${(latest.error ?? 'failed').slice(0, 120)} on ${streak.length} consecutive pull(s) — a provider outage; retried with backoff, not a repair.`,
    };
  }

  // The latest pull succeeded.
  const prior = pulls[1] ?? null;
  if (latest.fetched === 0 && (latest.bodyRecords ?? 0) > 0) {
    const changed = latest.topKeys && lastGood?.topKeys ? !sameKeys(latest.topKeys, lastGood.topKeys) : false;
    return {
      ...base,
      state: changed ? 'SCHEMA_CHANGED' : 'BROKEN_PARSER',
      action: 'ROUTE_TO_FACTORY',
      reason: changed
        ? `${source}: the body's shape changed (keys ${latest.topKeys!.join(',')} vs ${lastGood!.topKeys!.join(',')}) and the parser reads none of its ${latest.bodyRecords} record(s).`
        : `${source}: the body held ${latest.bodyRecords} record(s) and the parser read none of them.`,
    };
  }
  if (latest.fetched === 0 && everRead) {
    let zeros = 0;
    for (const p of pulls) {
      if (!p.ok || p.fetched > 0) break;
      zeros += 1;
    }
    if (zeros >= SCHEMA_ZERO_STREAK) {
      return {
        ...base,
        state: 'SCHEMA_CHANGED',
        action: 'ROUTE_TO_FACTORY',
        reason: `${source}: ${zeros} consecutive successful pulls read no records, where the same parser read ${lastGood!.fetched} before — the response shape moved.`,
      };
    }
  }
  const recovered = latest.fetched > 0 && !!prior && (!prior.ok || prior.fetched === 0);
  const lastNew = pulls.find((p) => p.ok && p.inserted > 0);
  const staleAfter = opts.intervalMs * STALE_INTERVALS;
  const since = lastNew ? Date.parse(lastNew.at) : Date.parse(pulls.at(-1)!.at);
  if (now - since > staleAfter && pulls.some((p) => Date.parse(p.at) <= now - staleAfter)) {
    return {
      ...base,
      recovered,
      state: 'STALE',
      action: 'WATCH',
      reason: `${source}: no new record since ${lastNew?.at ?? 'its first pull'}, past the expected freshness of ${Math.round(staleAfter / 3_600_000)}h.`,
    };
  }
  return {
    ...base,
    recovered,
    state: 'HEALTHY',
    action: 'NONE',
    reason: recovered ? `${source} read ${latest.fetched} record(s) again after an earlier fault.` : `${source} is reading records.`,
  };
}

/** The improvement-loop weakness for a parser or schema fault on one source. Pure. */
export function connectorWeakness(verdict: ConnectorVerdict, samples: readonly string[] = []): Weakness {
  return {
    key: `FEED_CONNECTOR_REPAIR:${verdict.source}`,
    kind: 'FEED_CONNECTOR_REPAIR',
    title: `Repair the feed connector for ${verdict.source} (${verdict.state === 'SCHEMA_CHANGED' ? 'schema changed' : 'parser broken'})`,
    problem:
      `${verdict.reason} Reproduce it from a current response, update the source's parser in ` +
      'server/services/feeds/sources.ts with a test built from that response, and keep the parser tolerant (it never throws on a strange body).',
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'server/services/feeds/sources.ts',
    mutationScope: ['server/services/feeds/**', 'tests/**'],
    frequency: 1,
    denominator: 1,
    scope: 'LOCAL',
    severity: 'MEDIUM',
    researchQuestion: `What shape does feed source ${verdict.source} now return, and what deterministic parser reads it?`,
    samples: [verdict.reason.slice(0, 300), ...samples.slice(0, 4)],
    knownCause: verdict.state,
  };
}

/** The newest recorded pull read records. */
function latestReads(history: readonly PullOutcome[]): boolean {
  const latest = [...history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return !!latest && latest.ok && latest.fetched > 0;
}

/** The recorded pulls of one source, newest first. */
export async function readPullHistory(source: string, limit = 20): Promise<PullOutcome[]> {
  const rows = await getDb().all<{ ok: number; fetched: number; inserted: number; error: string | null; created_at: string }>(
    'SELECT ok, fetched, inserted, error, created_at FROM feed_pulls WHERE source = ? ORDER BY created_at DESC LIMIT ?',
    [source, limit],
  );
  return rows.map((r) => ({ at: r.created_at, ok: Number(r.ok) === 1, fetched: Number(r.fetched), inserted: Number(r.inserted), error: r.error }));
}

/** Whether a repair for this source is routed and not yet reverified, from CONNECTOR_HEALTH rows. */
export async function readRoutedUnverified(source: string): Promise<boolean> {
  const row = await getDb().get<{ outcome: string | null }>(
    `SELECT outcome FROM bin_events WHERE event_type = ? AND provider = ? AND outcome IN ('ROUTED_TO_FACTORY', 'REVERIFIED')
      ORDER BY at DESC LIMIT 1`,
    [CONNECTOR_HEALTH_EVENT, source],
  );
  return row?.outcome === 'ROUTED_TO_FACTORY';
}

export interface SuperviseDeps {
  history?: (source: string) => Promise<PullOutcome[]>;
  routedUnverified?: (source: string) => Promise<boolean>;
  register?: (weakness: Weakness, now: Date, options: { evidence: Record<string, unknown> }) => Promise<{ candidate: { weaknessKey: string } }>;
  record?: typeof recordBinEvent;
  now?: Date;
}

export interface Supervision {
  verdict: ConnectorVerdict;
  /** ROUTED_TO_FACTORY, REVERIFIED, BACKOFF, PERMISSION_NEED, REDISCOVER, STALE or NONE. */
  outcome: string;
  candidateKey: string | null;
}

/**
 * Classify one source from its recorded pulls and act: a parser or schema fault
 * goes to Factory through the improvement loop; a pull that reads records after
 * a routed repair marks it reverified; an outage gets backoff only; a revoked
 * permission is a permission need. Every decision except an unremarkable
 * HEALTHY is recorded as a CONNECTOR_HEALTH row.
 */
export async function superviseConnector(source: string, intervalMs: number, deps: SuperviseDeps = {}): Promise<Supervision> {
  const now = deps.now ?? new Date();
  const record = deps.record ?? recordBinEvent;
  const history = await (deps.history ?? readPullHistory)(source);
  const verdict = classifyConnector(source, history, { intervalMs, now: now.getTime() });
  let outcome = 'NONE';
  let candidateKey: string | null = null;

  if (verdict.action === 'ROUTE_TO_FACTORY') {
    const register =
      deps.register ??
      (async (w: Weakness, at: Date, options: { evidence: Record<string, unknown> }) => (await import('../improvement/loop.ts')).registerDirected(w, at, options));
    const { candidate } = await register(connectorWeakness(verdict), now, {
      evidence: { connectorHealth: { source, state: verdict.state, reason: verdict.reason } },
    });
    candidateKey = candidate.weaknessKey;
    outcome = 'ROUTED_TO_FACTORY';
  } else if (verdict.state === 'HEALTHY' && latestReads(history) && (await (deps.routedUnverified ?? readRoutedUnverified)(source))) {
    outcome = 'REVERIFIED';
  } else if (verdict.action === 'BACKOFF') {
    outcome = 'BACKOFF';
  } else if (verdict.action === 'PERMISSION_NEED') {
    outcome = 'PERMISSION_NEED';
  } else if (verdict.action === 'REDISCOVER') {
    outcome = 'REDISCOVER';
  } else if (verdict.state === 'STALE') {
    outcome = 'STALE';
  }

  if (outcome !== 'NONE') {
    await record({
      eventType: CONNECTOR_HEALTH_EVENT,
      provider: source,
      workloadClass: 'feed-connector',
      outcome,
      reason: verdict.reason.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: {
        source,
        state: verdict.state,
        action: verdict.action,
        status: verdict.status,
        retryAt: verdict.retryAt,
        retryAsOutage: verdict.retryAsOutage,
        recovered: verdict.recovered,
        ...(candidateKey ? { candidateKey } : {}),
      },
    });
  }
  return { verdict, outcome, candidateKey };
}
