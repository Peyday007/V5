/**
 * ACQ-21-5, the deterministic execution path: an approved capability version
 * is classified, guarded, run through the existing workflow owner, verified,
 * redacted and recorded as one run row. No browser is opened: the workflow
 * owner's `operateWorkflow` is replaced by a fake that reports a run.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { BROWSER_WORKFLOW_RUN_EVENT, type OperateDeps, type OperateResult, type WorkflowRun } from '../server/services/sources/browserWorkflow.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  capabilityEffectKey,
  classifyWorkflow,
  operateCapability,
  readBrowserCapabilities,
  recordBrowserCapability,
  recordCapabilityDecision,
  type ApprovedAction,
  type BrowserCapability,
  type OperateCapabilityDeps,
} from '../server/services/sources/browser/index.ts';

const HOST = 'records.example.org';

const readCap = (): BrowserCapability => ({
  workflow: {
    host: HOST,
    name: 'monthly report',
    purpose: 'read the monthly report the account already has access to',
    account: true,
    origin: 'AUTHORED',
    steps: [
      { kind: 'navigate', url: `https://${HOST}/reports` },
      { kind: 'expect', text: 'Report for' },
      { kind: 'extract', name: 'report', locator: { testId: 'report-table' } },
    ],
  },
  inputs: [{ name: 'month', description: 'the month, YYYY-MM' }],
  outputs: [{ name: 'report', description: 'the report table text' }],
  effect: 'READ',
  expectedStates: [{ afterStep: 2, text: 'Report for' }],
  timeoutMs: 60_000,
  retry: { maxAttempts: 3, backoffMs: 30_000, retryAfterUnknown: true },
  freshnessMs: 24 * 3_600_000,
  failureReasons: [],
  fixtures: [{ name: 'october', inputs: { month: '2026-10' }, expect: { report: 'Report for' } }],
  maintenanceOwner: 'acquisition maintainers',
  session: { account: true, reauthorizeAfterMs: 7 * 24 * 3_600_000 },
  rateLimit: { maxRunsPerHour: 6, minIntervalMs: 0 },
});

const publishCap = (): BrowserCapability => {
  const c = readCap();
  c.workflow = {
    ...c.workflow,
    name: 'publish listing',
    purpose: 'publish an already-approved listing',
    steps: [
      { kind: 'navigate', url: `https://${HOST}/listings` },
      { kind: 'click', locator: { role: 'button', name: 'Publish' } },
      { kind: 'expect', text: 'Published' },
      { kind: 'extract', name: 'report', locator: { testId: 'confirmation' } },
    ],
  };
  c.effect = 'MUTATION';
  c.retry = { maxAttempts: 1, backoffMs: 0, retryAfterUnknown: false };
  // Its own fixture: what publishing obtains. Fixtures are executed (repair F3), so a
  // fixture copied from the read capability would correctly fail every publish run.
  c.fixtures = [{ name: 'october', inputs: { month: '2026-10' }, expect: { report: 'Published' } }];
  return c;
};

/** In-memory bin_events for the capability rows; effect claims use the real database. */
function harness() {
  const rows: { eventType: string; measures: string; outcome: string | null; at: string; reason: string | null }[] = [];
  let clock = Date.now() - 3_600_000;
  const tick = () => new Date((clock += 1000)).toISOString();
  const record = (async (e: { eventType: string; measures?: Record<string, unknown>; outcome?: string | null; reason?: string | null }) =>
    void rows.push({ eventType: e.eventType, measures: JSON.stringify(e.measures ?? {}), outcome: e.outcome ?? null, reason: e.reason ?? null, at: tick() })) as never;
  const capabilityDeps = {
    record,
    rows: async () => ({
      capabilities: rows.filter((r) => r.eventType === BROWSER_CAPABILITY_EVENT),
      runs: rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT),
    }),
    now: () => clock,
    recordWorkflow: (async (w: unknown) => w) as never,
  };
  let operateCalls = 0;
  let nextRun: Partial<WorkflowRun> = {};
  const operate = async (host: string, name: string, d: OperateDeps = {}): Promise<OperateResult> => {
    operateCalls += 1;
    const run: WorkflowRun = {
      host, name, outcome: 'COMPLETED', steps: [{ index: 0, kind: 'navigate', ok: true, detail: 'opened' }],
      extracted: [{ name: 'report', text: 'Report for 2026-10\nrow one', truncated: false }], downloads: [],
      finalUrl: `https://${host}/reports`, boundary: null, interfaceChanged: false, detail: 'every step ran', ...nextRun,
    };
    await d.record?.({ eventType: BROWSER_WORKFLOW_RUN_EVENT, outcome: run.outcome, reason: run.detail, measures: { host, name, definedAt: 'x', steps: run.steps } });
    return { run, judgment: null, record: null };
  };
  return {
    rows,
    calls: () => operateCalls,
    setRun: (r: Partial<WorkflowRun>) => void (nextRun = r),
    capabilityDeps,
    deps: (): OperateCapabilityDeps => ({ capabilityDeps, operate: operate as never, record, runRows: async () => [] }),
    async define(c: BrowserCapability) {
      const v = await recordBrowserCapability(c, 'a person', capabilityDeps);
      await recordCapabilityDecision({ host: HOST, name: c.workflow.name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, capabilityDeps);
      return v;
    },
    runRows: () => rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT),
  };
}

const approvalsFor = (c: BrowserCapability): ApprovedAction[] => {
  const j = classifyWorkflow(c.workflow);
  return j.effectSteps.map((i) => ({ stepIndex: i, fingerprint: j.steps[i]!.fingerprint, actionClass: j.steps[i]!.actionClass, approvedBy: 'a person', approvedAt: new Date().toISOString() }));
};

let projectId = '';
const worker = { type: 'WORKER' as const, id: 'wrk_a' };
const otherWorker = { type: 'WORKER' as const, id: 'wrk_b' };

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('operating an approved capability', () => {
  it('runs an IDEMPOTENT_READ, verifies it, and records a run row carrying its version and verification', async () => {
    const h = harness();
    const v = await h.define(readCap());
    const out = await operateCapability(
      { projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker, expectation: { datasets: [{ name: 'report', minRows: 1 }] } },
      h.deps(),
    );
    expect(out).toMatchObject({ outcome: 'COMPLETED', actionClass: 'IDEMPOTENT_READ', failureReason: null, sessionOpened: true });
    expect(out.verification?.verified).toBe(true);
    const runs = h.runRows();
    expect(runs).toHaveLength(1);
    const m = JSON.parse(runs[0]!.measures);
    expect(m.capability).toEqual({ version: v.version, contentHash: v.contentHash });
    expect(m.actionClass).toBe('IDEMPOTENT_READ');
    expect(m.verification.verified).toBe(true);
    expect(runs[0]!.outcome).toBe('COMPLETED');
    expect((await readBrowserCapabilities(HOST, h.capabilityDeps)).get(`${HOST}\u0000monthly report`)?.status).toBe('ACTIVE');
  });

  it('refuses a CONSEQUENTIAL step without approval before any browser session opens', async () => {
    const h = harness();
    await h.define(publishCap());
    const out = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(out).toMatchObject({ outcome: 'REFUSED', failureReason: 'APPROVAL_MISSING', actionClass: 'CONSEQUENTIAL', sessionOpened: false });
    expect(h.calls()).toBe(0);
    expect(h.rows.some((r) => r.outcome === 'RUN_REFUSED')).toBe(true);
  });

  it('moves the capability to REVIEW when a run reports the interface changed, and does not retry', async () => {
    const h = harness();
    await h.define(readCap());
    h.setRun({ outcome: 'FAILED', interfaceChanged: true, extracted: [], detail: 'locator report-table matched nothing' });
    const first = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(first).toMatchObject({ outcome: 'REVIEW', failureReason: 'INTERFACE_CHANGED' });
    expect((await readBrowserCapabilities(HOST, h.capabilityDeps)).get(`${HOST}\u0000monthly report`)?.status).toBe('REVIEW');
    h.setRun({});
    const again = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(again).toMatchObject({ outcome: 'REVIEW', sessionOpened: false });
    expect(h.calls()).toBe(1);
  });

  it('asks for reauthorization when the signed-in session is rejected', async () => {
    const h = harness();
    await h.define(readCap());
    h.setRun({ outcome: 'HANDOFF', boundary: 'AUTHENTICATION', steps: [], extracted: [], detail: 'sign-in wall' });
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(out).toMatchObject({ outcome: 'REAUTHORIZE', failureReason: 'SESSION_EXPIRED' });
  });

  it('records no secret in the run row', async () => {
    const h = harness();
    await h.define(readCap());
    const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
    h.setRun({ detail: `ran with Authorization: Bearer ${secret}`, finalUrl: `https://${HOST}/reports?session_token=${secret}&page=2` });
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(out.outcome).toBe('COMPLETED');
    const written = JSON.stringify(h.rows);
    expect(written).not.toContain(secret);
    expect(JSON.stringify(out.run)).not.toContain(secret);
    expect(written).toContain('page=2');
  });

  it('refuses a duplicate mutation claim from a second worker', async () => {
    const h = harness();
    const c = publishCap();
    await h.define(c);
    const approvals = approvalsFor(c);
    h.setRun({ extracted: [{ name: 'report', text: 'Published listing 42', truncated: false }] });
    const [a, b] = await Promise.all([
      operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: worker }, h.deps()),
      operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: otherWorker }, h.deps()),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['COMPLETED', 'REFUSED']);
    expect([a, b].find((x) => x.outcome === 'REFUSED')?.failureReason).toBe('DUPLICATE_EFFECT');
    expect(h.calls()).toBe(1);
    const later = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: otherWorker }, h.deps());
    expect(later).toMatchObject({ outcome: 'REFUSED', failureReason: 'DUPLICATE_EFFECT', sessionOpened: false });
    expect(h.calls()).toBe(1);
  });

  it('many workers racing the same mutation with no rows yet: exactly one performs it, the claim decides', async () => {
    const h = harness();
    const c = publishCap();
    await h.define(c);
    const approvals = approvalsFor(c);
    // Every worker starts from the same empty view of the rows, the window a read-then-write guard loses.
    h.setRun({ extracted: [], steps: [{ index: 0, kind: 'click', ok: true, detail: 'pressed Publish' }], outcome: 'FAILED', detail: 'timed out after submitting' });
    const actors = ['wrk_1', 'wrk_2', 'wrk_3', 'wrk_4', 'wrk_5'].map((id) => ({ type: 'WORKER' as const, id }));
    const results = await Promise.all(actors.map((actor) => operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor }, h.deps())));
    expect(h.calls()).toBe(1);
    expect(results.filter((r) => r.sessionOpened)).toHaveLength(1);
    expect(results.find((r) => r.sessionOpened)).toMatchObject({ outcome: 'UNKNOWN', failureReason: 'OUTCOME_UNKNOWN' });
    for (const r of results.filter((x) => !x.sessionOpened)) expect(r.outcome).toBe('REFUSED');
    const keys = new Set(results.map((r) => r.effectKey));
    expect(keys.size).toBe(1);
    // After the unknown outcome, no later attempt re-performs it either.
    const later = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: worker }, h.deps());
    expect(later).toMatchObject({ outcome: 'REFUSED', failureReason: 'OUTCOME_UNKNOWN', sessionOpened: false });
    expect(h.calls()).toBe(1);
  });

  it('records a mutation that ran but did not verify as UNKNOWN, and never re-performs it', async () => {
    const h = harness();
    const c = publishCap();
    await h.define(c);
    const approvals = approvalsFor(c);
    h.setRun({ extracted: [] });
    const first = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: worker }, h.deps());
    expect(first).toMatchObject({ outcome: 'UNKNOWN', failureReason: 'OUTCOME_UNKNOWN' });
    expect(h.runRows()[0]!.outcome).toBe('FAILED');
    const retry = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: worker }, h.deps());
    expect(retry).toMatchObject({ outcome: 'REFUSED', failureReason: 'OUTCOME_UNKNOWN', sessionOpened: false });
    expect(h.calls()).toBe(1);
  });

  it('claims the same effect key the plan reports, and enforces the capability\'s declared rate', async () => {
    const h = harness();
    const c = publishCap();
    c.rateLimit = { maxRunsPerHour: 1, minIntervalMs: 0 };
    await h.define(c);
    const record = (await readBrowserCapabilities(HOST, h.capabilityDeps)).get(`${HOST}\u0000publish listing`)!;
    const approvals = approvalsFor(c);
    h.setRun({ extracted: [{ name: 'report', text: 'Published listing 7', truncated: false }] });
    const first = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-10' }, approvals, actor: worker }, h.deps());
    expect(first.outcome).toBe('COMPLETED');
    expect(first.effectKey).toBe(capabilityEffectKey(record, { month: '2026-10' }));
    // A different effect of the same capability inside the hour is deferred by the one budget, before any session.
    // The rows and the budget read one clock: every row is stamped a minute before the run's own `now`.
    const now = new Date();
    const runRows = async () => h.runRows().map((r, i) => ({ id: `row_${i}`, outcome: r.outcome, at: new Date(now.getTime() - 60_000).toISOString(), measures: r.measures }));
    const second = await operateCapability({ projectId, host: HOST, name: 'publish listing', inputs: { month: '2026-11' }, approvals, actor: worker }, { ...h.deps(), runRows, now: () => now });
    expect(second).toMatchObject({ outcome: 'DEFERRED', failureReason: 'RATE_LIMITED', sessionOpened: false });
    expect(second.budget?.bound).toBe('CAPABILITY_HOURLY');
    expect(h.calls()).toBe(1);
  });

  it('defers a read still inside its freshness window without opening a session', async () => {
    const h = harness();
    await h.define(readCap());
    const record = (await readBrowserCapabilities(HOST, h.capabilityDeps)).get(`${HOST}\u0000monthly report`)!;
    const key = capabilityEffectKey(record, { month: '2026-10' });
    const now = new Date();
    const out = await operateCapability(
      { projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker, priorReads: [{ key, outcome: 'COMPLETED', at: new Date(now.getTime() - 60_000).toISOString() }] },
      { ...h.deps(), now: () => now },
    );
    expect(out).toMatchObject({ outcome: 'DEFERRED', failureReason: 'FRESH', sessionOpened: false, effectKey: key });
    expect(h.calls()).toBe(0);
  });

  it('defers a host at its request limit without opening a session', async () => {
    const h = harness();
    await h.define(readCap());
    const now = Date.now();
    const busy = async () => [1, 2, 3].map((i) => ({ id: `bev_${i}`, outcome: 'COMPLETED', at: new Date(now - i * 1000).toISOString() }));
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker, declaredPerMinute: 3 }, { ...h.deps(), runRows: busy });
    expect(out).toMatchObject({ outcome: 'DEFERRED', failureReason: 'RATE_LIMITED', sessionOpened: false });
    expect(out.budget).toMatchObject({ limit: 3, counted: 3 });
    expect(h.calls()).toBe(0);
  });
});
