/**
 * ACQ-21-4 item 8: connector health distinguishes a transient outage, a broken
 * parser and a revoked permission from recorded pull outcomes; only parser or
 * schema faults go to Factory (via the improvement loop's registerDirected), a
 * later healthy pull reverifies them, an outage gets backoff only, and a
 * revoked permission is never retried as an outage.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_HEALTH_EVENT,
  classifyConnector,
  connectorWeakness,
  failureKind,
  superviseConnector,
  type PullOutcome,
} from '../server/services/feeds/health.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const ok = (hoursAgo: number, fetched = 10, inserted = 5, extra: Partial<PullOutcome> = {}): PullOutcome => ({ at: at(hoursAgo), ok: true, fetched, inserted, error: null, ...extra });
const fail = (hoursAgo: number, error: string): PullOutcome => ({ at: at(hoursAgo), ok: false, fetched: 0, inserted: 0, error });
const opts = { intervalMs: 6 * HOUR, now: NOW };

describe('failureKind', () => {
  it('reads the recorded error strings', () => {
    expect(failureKind('HTTP 503').kind).toBe('TRANSIENT');
    expect(failureKind('timed out after 20000ms').kind).toBe('TRANSIENT');
    expect(failureKind('HTTP 401').kind).toBe('PERMISSION');
    expect(failureKind('HTTP 403').kind).toBe('PERMISSION');
    expect(failureKind('HTTP 404').kind).toBe('NOT_FOUND');
    expect(failureKind('fetch failed (ENOTFOUND)').kind).toBe('DNS');
    expect(failureKind("SyntaxError: Unexpected token '<', \"<!DOCTYPE\" is not valid JSON").kind).toBe('UNREADABLE_BODY');
  });
});

describe('classifyConnector distinguishes the three named cases', () => {
  it('a 5xx or timeout is a transient outage with backoff', () => {
    const v = classifyConnector('remoteok', [fail(0.1, 'HTTP 502'), fail(0.5, 'timed out after 20000ms'), ok(7)], opts);
    expect(v.state).toBe('TRANSIENT_OUTAGE');
    expect(v.action).toBe('BACKOFF');
    expect(v.retryAsOutage).toBe(true);
    expect(Date.parse(v.retryAt!)).toBeGreaterThan(NOW - 0.1 * HOUR);
  });

  it('recovery after an outage is healthy and says so', () => {
    const v = classifyConnector('remoteok', [ok(0), fail(1, 'HTTP 503'), ok(7)], opts);
    expect(v.state).toBe('HEALTHY');
    expect(v.recovered).toBe(true);
  });

  it('a 2xx body the reader cannot parse is a broken parser', () => {
    const v = classifyConnector('remotive', [fail(0, 'SyntaxError: Unexpected token < in JSON'), ok(6)], opts);
    expect(v.state).toBe('BROKEN_PARSER');
    expect(v.action).toBe('ROUTE_TO_FACTORY');
    expect(v.retryAsOutage).toBe(false);
  });

  it('records present with none read and the same keys is a broken parser; changed keys is a schema change', () => {
    const good = ok(6, 10, 5, { bodyRecords: 10, topKeys: ['jobs'] });
    expect(classifyConnector('s', [ok(0, 0, 0, { bodyRecords: 12, topKeys: ['jobs'] }), good], opts).state).toBe('BROKEN_PARSER');
    expect(classifyConnector('s', [ok(0, 0, 0, { bodyRecords: 12, topKeys: ['data', 'meta'] }), good], opts).state).toBe('SCHEMA_CHANGED');
  });

  it('repeated zero-record successes after the parser used to read is a schema change', () => {
    const v = classifyConnector('s', [ok(0, 0, 0), ok(6, 0, 0), ok(12, 0, 0), ok(18, 20, 4)], opts);
    expect(v.state).toBe('SCHEMA_CHANGED');
    expect(v.action).toBe('ROUTE_TO_FACTORY');
  });

  it('401 or 403 after past success is a revoked permission, never an outage', () => {
    for (const code of [401, 403]) {
      const v = classifyConnector('s', [fail(0, `HTTP ${code}`), fail(1, `HTTP ${code}`), ok(7)], opts);
      expect(v.state).toBe('PERMISSION_REVOKED');
      expect(v.action).toBe('PERMISSION_NEED');
      expect(v.retryAsOutage).toBe(false);
      expect(v.retryAt).toBeNull();
      expect(v.reason).toMatch(/not retried as an outage/);
    }
  });

  it('a persisting 404 or DNS failure is a dead endpoint; a single one is still an outage', () => {
    expect(classifyConnector('s', [fail(0, 'HTTP 404'), fail(1, 'HTTP 404'), fail(2, 'HTTP 404'), ok(9)], opts).state).toBe('DEAD_ENDPOINT');
    expect(classifyConnector('s', [fail(0, 'fetch failed (ENOTFOUND)'), fail(1, 'fetch failed (ENOTFOUND)'), fail(2, 'fetch failed (ENOTFOUND)')], opts).state).toBe('DEAD_ENDPOINT');
    expect(classifyConnector('s', [fail(0, 'HTTP 404'), ok(6)], opts).state).toBe('TRANSIENT_OUTAGE');
  });

  it('nothing new past the expected freshness is stale', () => {
    const v = classifyConnector('s', [ok(0, 10, 0), ok(6, 10, 0), ok(12, 10, 0), ok(18, 10, 0), ok(30, 10, 3)], opts);
    expect(v.state).toBe('STALE');
    expect(classifyConnector('s', [ok(0, 10, 2), ok(6)], opts).state).toBe('HEALTHY');
  });
});

describe('superviseConnector routes only repairable faults', () => {
  const harness = (history: PullOutcome[], routedUnverified = false) => {
    const registered: { key: string; evidence: Record<string, unknown> }[] = [];
    const rows: { eventType: string; outcome?: string | null; provider?: string | null }[] = [];
    return {
      registered,
      rows,
      deps: {
        now: new Date(NOW),
        history: async () => history,
        routedUnverified: async () => routedUnverified,
        register: async (w: { key: string }, _now: Date, o: { evidence: Record<string, unknown> }) => {
          registered.push({ key: w.key, evidence: o.evidence });
          return { candidate: { weaknessKey: w.key } };
        },
        record: async (input: { eventType: string; outcome?: string | null; provider?: string | null }) => void rows.push(input),
      },
    };
  };

  it('a parser fault is registered with the improvement loop and recorded as routed', async () => {
    const h = harness([fail(0, 'SyntaxError: Unexpected token <'), ok(6)]);
    const s = await superviseConnector('remotive', 6 * HOUR, h.deps);
    expect(s.outcome).toBe('ROUTED_TO_FACTORY');
    expect(h.registered).toHaveLength(1);
    expect(h.registered[0]!.key).toBe('FEED_CONNECTOR_REPAIR:remotive');
    expect(h.rows[0]).toMatchObject({ eventType: CONNECTOR_HEALTH_EVENT, outcome: 'ROUTED_TO_FACTORY', provider: 'remotive' });
  });

  it('a later healthy pull marks the routed repair reverified', async () => {
    const h = harness([ok(0, 12, 6), fail(6, 'SyntaxError: Unexpected token <')], true);
    const s = await superviseConnector('remotive', 6 * HOUR, h.deps);
    expect(s.outcome).toBe('REVERIFIED');
    expect(h.registered).toHaveLength(0);
    expect(h.rows[0]).toMatchObject({ outcome: 'REVERIFIED' });
  });

  it('a transient outage produces backoff, not a Factory objective', async () => {
    const h = harness([fail(0, 'HTTP 503'), ok(6)]);
    const s = await superviseConnector('remoteok', 6 * HOUR, h.deps);
    expect(s.outcome).toBe('BACKOFF');
    expect(h.registered).toHaveLength(0);
  });

  it('a revoked permission is a permission need, not a Factory objective and not a retry', async () => {
    const h = harness([fail(0, 'HTTP 403'), ok(6)]);
    const s = await superviseConnector('s', 6 * HOUR, h.deps);
    expect(s.outcome).toBe('PERMISSION_NEED');
    expect(s.verdict.retryAsOutage).toBe(false);
    expect(h.registered).toHaveLength(0);
  });

  it('a healthy source with nothing routed records nothing', async () => {
    const h = harness([ok(0, 10, 2)]);
    const s = await superviseConnector('s', 6 * HOUR, h.deps);
    expect(s.outcome).toBe('NONE');
    expect(h.rows).toHaveLength(0);
  });

  it('the weakness scopes the repair to the feeds parsers', () => {
    const w = connectorWeakness(classifyConnector('s', [fail(0, 'SyntaxError: x JSON')], opts));
    expect(w.ownerComponent).toBe('server/services/feeds/sources.ts');
    expect(w.mutationScope).toContain('server/services/feeds/**');
    expect(w.knownCause).toBe('BROKEN_PARSER');
  });
});
