import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import * as capabilityModule from '../server/services/sources/browser/capability.ts';
import { classifyWorkflow } from '../server/services/sources/browser/actionClass.ts';
import { operateCapability } from '../server/services/sources/browser/operate.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  capabilitiesFrom,
  capabilityHash,
  consequentialSteps,
  effectKey,
  planCapabilityRun,
  readBrowserCapabilities,
  recordBrowserCapability,
  recordCapabilityDecision,
  validateCapability,
  type BrowserCapability,
  type CapabilityRow,
} from '../server/services/sources/browser/capability.ts';
import { BROWSER_WORKFLOW_EVENT, BROWSER_WORKFLOW_RUN_EVENT, type OperateResult } from '../server/services/sources/browserWorkflow.ts';

/*
 * ACQ-21-5: a browser routine is a versioned reusable capability. These tests
 * read only what the module derives from rows; no browser is opened.
 */

const base = (): BrowserCapability => ({
  workflow: {
    host: 'records.example.org',
    name: 'monthly report',
    purpose: 'download the monthly report the account already has access to',
    account: true,
    origin: 'MODEL_ASSISTED',
    steps: [
      { kind: 'navigate', url: 'https://records.example.org/reports' },
      { kind: 'fill', locator: { label: 'Month' }, value: '2026-10' },
      { kind: 'click', locator: { role: 'button', name: 'Show report' } },
      { kind: 'expect', text: 'Report for' },
      { kind: 'extract', name: 'report', locator: { testId: 'report-table' } },
    ],
  },
  inputs: [{ name: 'month', description: 'the month, YYYY-MM' }],
  outputs: [{ name: 'report', description: 'the report table text' }],
  effect: 'READ',
  expectedStates: [{ afterStep: 3, text: 'Report for' }],
  timeoutMs: 60_000,
  retry: { maxAttempts: 3, backoffMs: 30_000, retryAfterUnknown: true },
  freshnessMs: 24 * 3_600_000,
  failureReasons: ['NO_REPORT_YET'],
  fixtures: [{ name: 'october', inputs: { month: '2026-10' }, expect: { report: 'Report for' } }],
  maintenanceOwner: 'acquisition maintainers',
  session: { account: true, reauthorizeAfterMs: 7 * 24 * 3_600_000 },
  rateLimit: { maxRunsPerHour: 6, minIntervalMs: 60_000 },
});

const mutation = (): BrowserCapability => {
  const c = base();
  c.workflow = { ...c.workflow, name: 'publish listing', purpose: 'publish an already-approved listing', steps: [...c.workflow.steps.slice(0, 2), { kind: 'click', locator: { role: 'button', name: 'Publish' } }, ...c.workflow.steps.slice(3)] };
  c.effect = 'MUTATION';
  c.retry = { maxAttempts: 1, backoffMs: 0, retryAfterUnknown: false };
  return c;
};

/** An in-memory bin_events: recordBinEvent and the row reader over the same list. */
const store = () => {
  const rows: { eventType: string; measures: string; outcome: string | null; at: string }[] = [];
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  return {
    rows,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    deps: {
      record: (async (e: { eventType: string; measures?: Record<string, unknown>; outcome?: string | null }) =>
        void rows.push({ eventType: e.eventType, measures: JSON.stringify(e.measures ?? {}), outcome: e.outcome ?? null, at: tick() })) as never,
      rows: async () => ({
        capabilities: rows.filter((r) => r.eventType === BROWSER_CAPABILITY_EVENT),
        runs: rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT),
      }),
      now: () => clock,
    },
    run: (host: string, name: string, outcome: string, extra: Record<string, unknown> = {}) =>
      rows.push({ eventType: BROWSER_WORKFLOW_RUN_EVENT, measures: JSON.stringify({ host, name, ...extra }), outcome, at: tick() }),
  };
};

describe('validateCapability refuses an incomplete definition', () => {
  it('a complete definition passes', () => {
    expect(validateCapability(base())).toEqual([]);
  });

  it.each([
    ['selectors', (c: BrowserCapability) => void (c.workflow.steps = [c.workflow.steps[0]!, { kind: 'expect', urlIncludes: '/reports' }, { kind: 'extract', name: 'report' }])],
    ['expected page states', (c: BrowserCapability) => void (c.expectedStates = [])],
    ['timeout', (c: BrowserCapability) => void (c.timeoutMs = 0)],
    ['retry policy', (c: BrowserCapability) => void ((c as { retry: unknown }).retry = undefined)],
    ['freshness window', (c: BrowserCapability) => void (c.freshnessMs = 0)],
    ['maintenance owner', (c: BrowserCapability) => void (c.maintenanceOwner = ' ')],
    ['fixtures', (c: BrowserCapability) => void (c.fixtures = [])],
  ])('without %s', (_what, spoil) => {
    const c = base();
    spoil(c);
    expect(validateCapability(c).length).toBeGreaterThan(0);
  });

  it('an output must be captured by a step, and an expected state must name a step', () => {
    const c = base();
    c.outputs.push({ name: 'invoice', description: 'never extracted' });
    c.expectedStates.push({ afterStep: 99, text: 'x' });
    const p = validateCapability(c);
    expect(p.some((x) => x.includes('output "invoice"'))).toBe(true);
    expect(p.some((x) => x.includes('afterStep'))).toBe(true);
  });

  it('detects a consequential control before submitting, and a READ may not press one', () => {
    expect(consequentialSteps(mutation().workflow)).toEqual([{ step: 3, why: 'clicks "button Publish"' }]);
    const disguised = mutation();
    disguised.effect = 'READ';
    disguised.retry = { maxAttempts: 2, backoffMs: 0, retryAfterUnknown: false };
    expect(validateCapability(disguised).some((x) => x.includes('declare it a MUTATION'))).toBe(true);
    expect(validateCapability(mutation())).toEqual([]);
  });
});

describe("a mutation's retry policy never allows an automatic retry after an unknown outcome", () => {
  it('refuses retryAfterUnknown and more than one attempt', () => {
    const c = mutation();
    c.retry = { maxAttempts: 1, backoffMs: 0, retryAfterUnknown: true };
    expect(validateCapability(c).some((x) => x.includes('stays UNKNOWN'))).toBe(true);
    c.retry = { maxAttempts: 2, backoffMs: 0, retryAfterUnknown: false };
    expect(validateCapability(c).some((x) => x.includes('never retried automatically'))).toBe(true);
  });

  it('plans: rows read before a run never decide a mutation; only the effect claim does', async () => {
    const s = store();
    const v = await recordBrowserCapability(mutation(), 'a person', s.deps);
    await recordCapabilityDecision({ host: 'records.example.org', name: 'publish listing', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const record = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000publish listing')!;
    const inputs = { month: '2026-10' };
    const key = effectKey(v.contentHash, inputs);
    expect(effectKey(v.contentHash, { month: '2026-10' })).toBe(key);
    // The planner still refuses what it can know without racing anyone…
    expect(planCapabilityRun(record, { nope: '1' }, [], s.now())).toMatchObject({ decision: 'REFUSED', reason: 'BAD_INPUT' });
    // …but does not answer "already done / in flight / unknown" for a mutation from a row scan:
    // that answer is the claim's, taken in one statement by operateCapability (invariant 24).
    const at = new Date(s.now()).toISOString();
    for (const outcome of ['STARTED', 'UNKNOWN', 'COMPLETED']) {
      expect(planCapabilityRun(record, inputs, [{ key, outcome, at }], s.now() + 3_600_000).decision).toBe('RUN');
    }
    // And there is no second run path that acts on such a scan.
    expect('runBrowserCapability' in capabilityModule).toBe(false);
  });

  it('runs: concurrent workers that all read before any writes perform the mutation once, and an UNKNOWN is never re-performed', async () => {
    const projectId = (await freshProject()).project.id;
    const s = store();
    const c = mutation();
    const v = await recordBrowserCapability(c, 'a person', { ...s.deps, recordWorkflow: (async (w: unknown) => w) as never });
    await recordCapabilityDecision({ host: 'records.example.org', name: 'publish listing', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const j = classifyWorkflow(c.workflow);
    const approvals = j.effectSteps.map((i) => ({ stepIndex: i, fingerprint: j.steps[i]!.fingerprint, actionClass: j.steps[i]!.actionClass, approvedBy: 'a person', approvedAt: new Date().toISOString() }));
    let operated = 0;
    // Every worker has read the rows (nothing in flight) before the first one acts.
    let release!: () => void;
    const allRead = new Promise<void>((r) => (release = r));
    let reads = 0;
    const workers = 5;
    const capabilities = async (host: string) => {
      const records = await readBrowserCapabilities(host, s.deps);
      if (++reads === workers) release();
      await allRead;
      return records;
    };
    const timedOut: OperateResult = {
      run: { host: 'records.example.org', name: 'publish listing', outcome: 'FAILED', steps: [{ index: 1, kind: 'navigate', ok: true, detail: '' }], extracted: [], downloads: [], finalUrl: null, boundary: null, interfaceChanged: false, detail: 'timed out' },
      judgment: null,
      record: null,
    };
    const deps = {
      capabilities,
      record: s.deps.record,
      runRows: async () => [],
      operate: (async () => {
        operated += 1;
        await new Promise((r) => setTimeout(r, 20));
        return timedOut;
      }) as never,
    };
    const run = (id: string) => operateCapability({ projectId, host: 'records.example.org', name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: { type: 'WORKER', id } }, deps);
    const results = await Promise.all(Array.from({ length: workers }, (_, i) => run(`wrk_${i}`)));
    expect(operated).toBe(1);
    expect(results.filter((r) => r.sessionOpened)).toHaveLength(1);
    expect(results.find((r) => r.sessionOpened)).toMatchObject({ outcome: 'UNKNOWN', failureReason: 'OUTCOME_UNKNOWN' });
    for (const r of results.filter((x) => !x.sessionOpened)) expect(r).toMatchObject({ outcome: 'REFUSED', failureReason: 'DUPLICATE_EFFECT' });
    // No in-flight marker row stands in for the claim.
    expect(s.rows.some((r) => r.outcome === 'RUN_STARTED')).toBe(false);
    // An hour later, a fresh worker still does not re-perform an unknown outcome.
    s.advance(3_600_000);
    expect(await run('wrk_late')).toMatchObject({ outcome: 'REFUSED', failureReason: 'OUTCOME_UNKNOWN', sessionOpened: false });
    expect(operated).toBe(1);
  });
});

describe('versions: any change is a new version and the previous rows are kept', () => {
  it('hashes the whole definition and numbers versions monotonically', async () => {
    const s = store();
    const v1 = await recordBrowserCapability(base(), 'a person', s.deps);
    const again = await recordBrowserCapability(base(), 'a person', s.deps);
    expect(again.version).toBe(1);
    const changed = base();
    changed.workflow.steps[2] = { kind: 'click', locator: { role: 'button', name: 'View report' } };
    expect(capabilityHash(changed)).not.toBe(v1.contentHash);
    const v2 = await recordBrowserCapability(changed, 'a person', s.deps);
    expect(v2.version).toBe(2);
    const defined = s.rows.filter((r) => r.eventType === BROWSER_CAPABILITY_EVENT && r.outcome === 'DEFINED');
    expect(defined).toHaveLength(2);
    expect(JSON.parse(defined[0]!.measures)).toMatchObject({ version: 1, contentHash: v1.contentHash });
    // The workflow owner holds each definition too, so operateWorkflow runs exactly this version.
    expect(s.rows.filter((r) => r.eventType === BROWSER_WORKFLOW_EVENT)).toHaveLength(2);
    const record = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000monthly report')!;
    expect(record.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(record.current.contentHash).toBe(v2.contentHash);
    expect(record.status).toBe('DRAFT');
  });

  it('an approval names the exact current version', async () => {
    const s = store();
    const v1 = await recordBrowserCapability(base(), 'a person', s.deps);
    const changed = base();
    changed.freshnessMs = 2 * 3_600_000;
    await recordBrowserCapability(changed, 'a person', s.deps);
    await expect(recordCapabilityDecision({ host: 'records.example.org', name: 'monthly report', contentHash: v1.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps)).rejects.toThrow(/not the current version/);
  });
});

describe('lifecycle is derived only from recorded rows', () => {
  it('DRAFT → APPROVED → ACTIVE → REVIEW → (re-approved) → RETIRED', async () => {
    const s = store();
    const host = 'records.example.org';
    const name = 'monthly report';
    const status = async () => (await readBrowserCapabilities(host, s.deps)).get(`${host}\u0000${name}`)!;
    const v = await recordBrowserCapability(base(), 'a person', s.deps);
    expect((await status()).status).toBe('DRAFT');
    await recordCapabilityDecision({ host, name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    expect((await status()).status).toBe('APPROVED');
    s.run(host, name, 'COMPLETED');
    const active = await status();
    expect(active.status).toBe('ACTIVE');
    expect(active.fresh).toBe(true);
    s.run(host, name, 'FAILED', { interfaceChanged: true });
    const review = await status();
    expect(review.status).toBe('REVIEW');
    expect(review.handoff).toBe('REVIEW');
    expect(planCapabilityRun(review, { month: '2026-10' }, [], s.now())).toMatchObject({ decision: 'REFUSED', reason: 'INTERFACE_CHANGED' });
    await recordCapabilityDecision({ host, name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    expect((await status()).status).toBe('APPROVED');
    await recordCapabilityDecision({ host, name, contentHash: v.contentHash, decision: 'RETIRED', by: 'a person' }, s.deps);
    expect((await status()).status).toBe('RETIRED');
  });

  it('a rejected or aged session yields a REAUTHORIZE handoff, and staleness is read from the rows', async () => {
    const s = store();
    const host = 'records.example.org';
    const name = 'monthly report';
    const v = await recordBrowserCapability(base(), 'a person', s.deps);
    await recordCapabilityDecision({ host, name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    s.run(host, name, 'COMPLETED');
    s.run(host, name, 'HANDOFF', { boundary: 'AUTHENTICATION' });
    const rejected = (await readBrowserCapabilities(host, s.deps)).get(`${host}\u0000${name}`)!;
    expect(rejected.handoff).toBe('REAUTHORIZE');
    expect(planCapabilityRun(rejected, { month: '2026-10' }, [], s.now())).toMatchObject({ decision: 'REFUSED', reason: 'SESSION_EXPIRED' });

    const rows: CapabilityRow[] = s.rows.filter((r) => r.eventType === BROWSER_CAPABILITY_EVENT);
    const later = s.now() + 8 * 24 * 3_600_000;
    const aged = capabilitiesFrom(rows, s.rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT && r.outcome === 'COMPLETED'), later).get(`${host}\u0000${name}`)!;
    expect(aged.handoff).toBe('REAUTHORIZE');
    expect(aged.fresh).toBe(false);
  });

  it('a read inside its freshness window is not run again, and the rate bound holds across workers', async () => {
    const s = store();
    const v = await recordBrowserCapability(base(), 'a person', s.deps);
    await recordCapabilityDecision({ host: 'records.example.org', name: 'monthly report', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const record = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000monthly report')!;
    const key = effectKey(v.contentHash, { month: '2026-10' });
    const now = s.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(planCapabilityRun(record, { month: '2026-10' }, [{ key, outcome: 'COMPLETED', at: at(60_000) }], now).decision).toBe('ALREADY_DONE');
    const busy = Array.from({ length: 6 }, (_, i) => ({ key: `other-${i}`, outcome: 'COMPLETED', at: at(50 * 60_000 - i * 60_000) }));
    expect(planCapabilityRun(record, { month: '2026-11' }, busy, now).decision).toBe('WAIT');
    expect(planCapabilityRun(record, { month: '2026-11' }, [{ key: 'x', outcome: 'COMPLETED', at: at(10_000) }], now).decision).toBe('WAIT');
    expect(planCapabilityRun(record, { nope: '1' }, [], now)).toMatchObject({ decision: 'REFUSED', reason: 'BAD_INPUT' });
  });
});

describe('a capability record contains no credential or session value', () => {
  it('refuses session material in any field', () => {
    const withCookie = base() as BrowserCapability & { session: Record<string, unknown> };
    withCookie.session = { ...withCookie.session, cookie: 'sid=abcdefghijklmnopqrstuvwxyz0123456789' };
    expect(validateCapability(withCookie).some((x) => x.includes('session material'))).toBe(true);
    const withToken = base();
    withToken.fixtures[0]!.inputs.month = 'Bearer abc.def.ghi';
    expect(validateCapability(withToken).some((x) => x.includes('credential'))).toBe(true);
  });

  it('the recorded rows carry the rule, never a value', async () => {
    const s = store();
    await recordBrowserCapability(base(), 'a person', s.deps);
    const written = s.rows.map((r) => r.measures).join('\n');
    expect(written).not.toMatch(/"(cookie|token|password|sessionId|authorization)"/i);
    expect(JSON.parse(s.rows.find((r) => r.eventType === BROWSER_CAPABILITY_EVENT)!.measures).capability.session).toEqual({ account: true, reauthorizeAfterMs: 7 * 24 * 3_600_000 });
  });
});
