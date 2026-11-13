import { describe, expect, it } from 'vitest';
import {
  BROWSER_CAPABILITY_EVENT,
  capabilitiesFrom,
  capabilityHash,
  capabilityFromSuccessfulRun,
  consequentialSteps,
  discoverBrowserCapability,
  draftCapabilityFromRun,
  capabilityEffectKey,
  effectSubject,
  planCapabilityRun,
  readBrowserCapabilities,
  recordBrowserCapability,
  recordCapabilityDecision,
  validateCapability,
  type BrowserCapability,
  type CapabilityRow,
} from '../server/services/sources/browser/capability.ts';
import { browserEffectKey, requestBudgetFrom } from '../server/services/sources/browser/effectGuard.ts';
import {
  BROWSER_WORKFLOW_EVENT,
  BROWSER_WORKFLOW_RUN_EVENT,
  operateWorkflow,
  runBrowserWorkflow,
  type BrowserWorkflow,
  type OperateResult,
  type WorkflowRecord,
  type WorkflowRun,
} from '../server/services/sources/browserWorkflow.ts';

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

  it('plans: rows read earlier never decide a mutation; the effect claim does', async () => {
    const s = store();
    const v = await recordBrowserCapability(mutation(), 'a person', s.deps);
    await recordCapabilityDecision({ host: 'records.example.org', name: 'publish listing', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const record = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000publish listing')!;
    const inputs = { month: '2026-10' };
    const key = capabilityEffectKey(record, inputs);
    expect(capabilityEffectKey(record, { month: '2026-10' })).toBe(key);
    const later = s.now() + 3_600_000;
    const at = new Date(s.now()).toISOString();
    // A caller's snapshot of rows can be stale the moment it is read, so it can neither
    // clear nor block a mutation: every plan says RUN only through the atomic claim.
    for (const prior of [[], [{ key, outcome: 'STARTED', at }], [{ key, outcome: 'UNKNOWN', at }], [{ key, outcome: 'COMPLETED', at }]]) {
      expect(planCapabilityRun(record, inputs, prior, later)).toMatchObject({ decision: 'RUN', claim: 'REQUIRED', attempt: 1 });
    }
    // A read is idempotent and needs no claim.
    const r = await recordBrowserCapability(base(), 'a person', s.deps);
    await recordCapabilityDecision({ host: 'records.example.org', name: 'monthly report', contentHash: r.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const read = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000monthly report')!;
    expect(planCapabilityRun(read, inputs, [], later)).toMatchObject({ decision: 'RUN', claim: 'NONE' });
  });

  it('there is one effect key: the plan and the claim derive it with the same function', async () => {
    const s = store();
    const v = await recordBrowserCapability(mutation(), 'a person', s.deps);
    await recordCapabilityDecision({ host: 'records.example.org', name: 'publish listing', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const record = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000publish listing')!;
    const inputs = { month: '2026-10' };
    const planned = planCapabilityRun(record, inputs, [], s.now());
    expect(planned.key).toBe(browserEffectKey({ capability: effectSubject(record), approvedInput: inputs }));
    expect(planned.key).toMatch(/^bwe-[0-9a-f]{48}$/);
    expect(effectSubject(record)).toEqual({ host: 'records.example.org', name: 'publish listing', version: `v${v.version}:${v.contentHash}` });
    const mod = (await import('../server/services/sources/browser/index.ts')) as Record<string, unknown>;
    expect(mod.effectKey).toBeUndefined();
  });

  it('there is one run path: the row-scan runner is gone', async () => {
    const mod = (await import('../server/services/sources/browser/index.ts')) as Record<string, unknown>;
    expect(mod.runBrowserCapability).toBeUndefined();
    expect(mod.priorRunsFrom).toBeUndefined();
    expect(typeof mod.operateCapability).toBe('function');
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

  it('a read inside its freshness window is not run again, and the declared rate bound is the one request budget', async () => {
    const s = store();
    const v = await recordBrowserCapability(base(), 'a person', s.deps);
    await recordCapabilityDecision({ host: 'records.example.org', name: 'monthly report', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const record = (await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000monthly report')!;
    const key = capabilityEffectKey(record, { month: '2026-10' });
    const now = s.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(planCapabilityRun(record, { month: '2026-10' }, [{ key, outcome: 'COMPLETED', at: at(60_000) }], now).decision).toBe('ALREADY_DONE');
    expect(planCapabilityRun(record, { nope: '1' }, [], now)).toMatchObject({ decision: 'REFUSED', reason: 'BAD_INPUT' });
    // The capability's declared rate (6/hour, 60 s apart) holds across workers in the same budget as the host's limit,
    // counted from the BROWSER_WORKFLOW_RUN rows every worker writes.
    const rate = { name: record.name, ...record.current.capability.rateLimit };
    const nowDate = new Date(now);
    const run = (ms: number, name = record.name) => ({ id: `r${ms}`, outcome: 'COMPLETED', at: at(ms), measures: JSON.stringify({ host: record.host, name }) });
    const busy = Array.from({ length: 6 }, (_, i) => run(50 * 60_000 - i * 60_000));
    expect(requestBudgetFrom(record.host, busy, { now: nowDate, capability: rate })).toMatchObject({ decision: 'DEFER', bound: 'CAPABILITY_HOURLY' });
    expect(requestBudgetFrom(record.host, [run(10_000)], { now: nowDate, capability: rate })).toMatchObject({ decision: 'DEFER', bound: 'CAPABILITY_INTERVAL' });
    // Another capability's runs on the host do not use this capability's bound.
    expect(requestBudgetFrom(record.host, [run(10_000, 'something else')], { now: nowDate, capability: rate })).toMatchObject({ decision: 'PROCEED' });
    expect(planCapabilityRun(record, { month: '2026-11' }, busy.map((r) => ({ key: 'x', outcome: 'COMPLETED', at: r.at })), now).decision).toBe('RUN');
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

/*
 * F4: the model discovers an interface once; the first successful run becomes
 * a DRAFT capability, and only an approved version is then run by software.
 */
describe('discover once: a successful run becomes a DRAFT capability', () => {
  const discovered = (): BrowserWorkflow => ({ ...base().workflow, name: 'monthly report' });
  const completed = (w: BrowserWorkflow, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
    host: w.host,
    name: w.name,
    outcome: 'COMPLETED',
    steps: w.steps.map((st, i) => ({ index: i, kind: st.kind, ok: true, detail: 'ok' })),
    extracted: [{ name: 'report', text: 'Report for October 2026\nrow 1', truncated: false }],
    downloads: [],
    finalUrl: 'https://records.example.org/reports/2026-10',
    boundary: null,
    interfaceChanged: false,
    detail: 'completed',
    ...over,
  });
  const spec = { maintenanceOwner: 'acquisition maintainers', inputs: [{ name: 'month', description: 'the month, YYYY-MM' }], fixtureInputs: { month: '2026-10' } };
  const records = (w: BrowserWorkflow) => async () =>
    new Map<string, WorkflowRecord>([[`${w.host}\u0000${w.name.toLowerCase()}`, { workflow: w, definedAt: '2026-11-01T00:00:00.000Z', runs: 0, completed: 0, streak: 0, status: 'DRAFT', interfaceChanged: false, why: '' }]]);

  it('drafts a complete, valid definition from what the run proved', () => {
    const d = draftCapabilityFromRun(discovered(), completed(discovered()), spec);
    expect(d.drafted).toBe(true);
    if (!d.drafted) return;
    expect(validateCapability(d.capability)).toEqual([]);
    expect(d.capability.effect).toBe('READ');
    expect(d.capability.outputs.map((o) => o.name)).toEqual(['report']);
    expect(d.capability.expectedStates).toEqual([{ afterStep: 4, text: 'Report for' }]);
    expect(d.capability.fixtures[0]).toEqual({ name: 'discovered run', inputs: { month: '2026-10' }, expect: { report: 'Report for October 2026' } });
    expect(d.capability.session).toEqual({ account: true, reauthorizeAfterMs: 7 * 24 * 3_600_000 });
  });

  it.each([
    ['a run that did not complete', { outcome: 'FAILED' as const }],
    ['a run that found the interface changed', { interfaceChanged: true }],
    ['a run that did not obtain every output', { extracted: [] }],
    ['a run of another workflow', { name: 'something else' }],
  ])('drafts nothing from %s', (_what, over) => {
    expect(draftCapabilityFromRun(discovered(), completed(discovered(), over), spec).drafted).toBe(false);
  });

  it('a consequential workflow is drafted as a MUTATION that is never retried', () => {
    const w = mutation().workflow;
    const d = draftCapabilityFromRun(w, completed(w), spec);
    expect(d.drafted && d.capability.effect).toBe('MUTATION');
    expect(d.drafted && d.capability.retry).toEqual({ maxAttempts: 1, backoffMs: 0, retryAfterUnknown: false });
  });

  it('the fixture never carries a secret the page showed', () => {
    const d = draftCapabilityFromRun(discovered(), completed(discovered(), { extracted: [{ name: 'report', text: 'Report for you token=abcdef0123456789abcdef', truncated: false }] }), spec);
    expect(d.drafted && JSON.stringify(d.capability)).not.toContain('abcdef0123456789abcdef');
  });

  it('records the first successful run as DRAFT; it runs only after a person approves that exact version', async () => {
    const s = store();
    const w = discovered();
    let ran = 0;
    const operate = (async () => {
      ran += 1;
      return { run: completed(w), judgment: null, record: (await records(w)()).values().next().value! };
    }) as unknown as typeof operateWorkflow;
    const result = await discoverBrowserCapability(w.host, w.name, spec, 'model-assisted survey', { ...s.deps, workflows: records(w), recordWorkflow: (async (x: BrowserWorkflow) => x) as never, operate });
    expect(ran).toBe(1);
    expect(result.outcome).toBe('DRAFTED');
    const record = (await readBrowserCapabilities(w.host, s.deps)).get(`${w.host}\u0000${w.name}`)!;
    expect(record.status).toBe('DRAFT');
    expect(record.current.contentHash).toBe(result.version!.contentHash);
    expect(planCapabilityRun(record, { month: '2026-11' }, []).decision).toBe('REFUSED');
    await recordCapabilityDecision({ host: w.host, name: w.name, contentHash: record.current.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    const approved = (await readBrowserCapabilities(w.host, s.deps)).get(`${w.host}\u0000${w.name}`)!;
    expect(planCapabilityRun(approved, { month: '2026-11' }, []).decision).toBe('RUN');
  });

  it('a failed discovery run records nothing', async () => {
    const s = store();
    const w = discovered();
    const operate = (async () => ({ run: completed(w, { outcome: 'FAILED', detail: 'no table' }), judgment: null, record: null })) as unknown as typeof operateWorkflow;
    const result = await discoverBrowserCapability(w.host, w.name, spec, 'model-assisted survey', { ...s.deps, workflows: records(w), operate });
    expect(result.outcome).toBe('NOT_DRAFTED');
    expect(s.rows.filter((r) => r.eventType === BROWSER_CAPABILITY_EVENT)).toEqual([]);
  });

  it('never runs a consequential workflow to discover it, but drafts one from a run already performed', async () => {
    const s = store();
    const w = mutation().workflow;
    let ran = 0;
    const operate = (async () => {
      ran += 1;
      throw new Error('must not run');
    }) as unknown as typeof operateWorkflow;
    const refused = await discoverBrowserCapability(w.host, w.name, spec, 'model-assisted survey', { ...s.deps, workflows: records(w), operate });
    expect(refused.outcome).toBe('REFUSED');
    expect(ran).toBe(0);
    const drafted = await capabilityFromSuccessfulRun(w, completed(w), spec, 'a person', { ...s.deps, recordWorkflow: (async (x: BrowserWorkflow) => x) as never });
    expect(drafted.outcome).toBe('DRAFTED');
    expect((await readBrowserCapabilities(w.host, s.deps)).get(`${w.host}\u0000${w.name.toLowerCase()}`)!.status).toBe('DRAFT');
  });
});

describe('session material is the browser server\'s; Brain models only the reauthorization rule', () => {
  it('an account workflow runs only through the signed-in session server, and without it does not run', async () => {
    const prior = process.env.BRAIN_BROWSER_SESSION_MCP_URL;
    delete process.env.BRAIN_BROWSER_SESSION_MCP_URL;
    try {
      const run = await runBrowserWorkflow(base().workflow);
      expect(run.outcome).toBe('UNAVAILABLE');
      expect(run.detail).toContain('BRAIN_BROWSER_SESSION_MCP_URL');
      expect(run.steps).toEqual([]);
    } finally {
      if (prior !== undefined) process.env.BRAIN_BROWSER_SESSION_MCP_URL = prior;
    }
  });

  it('a session the server rejected, or one past its window, is a REAUTHORIZE handoff, and a draft carries no session value', async () => {
    const s = store();
    const v = await recordBrowserCapability(base(), 'a person', { ...s.deps, recordWorkflow: (async (x: BrowserWorkflow) => x) as never });
    await recordCapabilityDecision({ host: 'records.example.org', name: 'monthly report', contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, s.deps);
    s.run('records.example.org', 'monthly report', 'HANDOFF', { boundary: 'AUTHENTICATION' });
    expect((await readBrowserCapabilities('records.example.org', s.deps)).get('records.example.org\u0000monthly report')!.handoff).toBe('REAUTHORIZE');
    const d = draftCapabilityFromRun(base().workflow, {
      host: 'records.example.org', name: 'monthly report', outcome: 'COMPLETED', steps: [], extracted: [{ name: 'report', text: 'Report for', truncated: false }],
      downloads: [], finalUrl: null, boundary: null, interfaceChanged: false, detail: '',
    }, { maintenanceOwner: 'x', inputs: [{ name: 'month', description: 'm' }], fixtureInputs: { month: '2026-10' } });
    expect(d.drafted && d.capability.session).toEqual({ account: true, reauthorizeAfterMs: 7 * 24 * 3_600_000 });
  });
});
