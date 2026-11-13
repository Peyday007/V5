/**
 * ACQ-21-5, repair F3: a capability's declared expected page states and test
 * fixtures are executed, not only validated.
 *
 * The finding: within `server/services/sources/browser/`, `expectedStates` and
 * `fixtures` appeared only in `capability.ts`'s validation, and `operate.ts`
 * used only `timeoutMs` from the version — so drift in an expected page state
 * could not move a capability to REVIEW, and fixtures never tested anything.
 *
 * The real `operateCapability` and `operateWorkflow` run here; only the store,
 * the judgment, the permission and the browser are replaced. The fake browser
 * evaluates `expect` steps against a page text the test controls, the way the
 * real in-page check does, and stops at the first one that fails.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  BROWSER_WORKFLOW_RUN_EVENT,
  MAX_WORKFLOW_STEPS,
  type BrowserWorkflow,
  type OperateDeps,
  type WorkflowRecord,
  type WorkflowRun,
} from '../server/services/sources/browserWorkflow.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  checkFixture,
  expectedStateDrift,
  fixturesFor,
  operateCapability,
  readBrowserCapabilities,
  recordBrowserCapability,
  recordCapabilityDecision,
  testCapabilityFixtures,
  validateCapability,
  withExpectedStates,
  type BrowserCapability,
} from '../server/services/sources/browser/index.ts';

const HOST = 'records.example.org';

const cap = (over: Partial<BrowserCapability> = {}): BrowserCapability => ({
  workflow: {
    host: HOST,
    name: 'monthly report',
    purpose: 'read the monthly report',
    account: false,
    origin: 'AUTHORED',
    steps: [
      { kind: 'navigate', url: `https://${HOST}/reports` },
      { kind: 'expect', text: 'Report for' },
      { kind: 'extract', name: 'report', locator: { testId: 'report-table' } },
    ],
  },
  inputs: [],
  outputs: [{ name: 'report', description: 'the report table text' }],
  effect: 'READ',
  // One state the workflow already checks, and one it does not: the totals row after the table is read.
  expectedStates: [
    { afterStep: 2, text: 'Report for' },
    { afterStep: 3, text: 'Total' },
  ],
  timeoutMs: 60_000,
  retry: { maxAttempts: 3, backoffMs: 30_000, retryAfterUnknown: true },
  freshnessMs: 24 * 3_600_000,
  failureReasons: [],
  fixtures: [{ name: 'current', inputs: {}, expect: { report: 'Report for' } }],
  maintenanceOwner: 'acquisition maintainers',
  session: { account: false, reauthorizeAfterMs: null },
  rateLimit: { maxRunsPerHour: 60, minIntervalMs: 0 },
  ...over,
});

const key = (name: string) => `${HOST}\u0000${name}`;
const stored = (workflow: BrowserWorkflow): WorkflowRecord => ({
  workflow, definedAt: new Date().toISOString(), runs: 0, completed: 0, streak: 0, status: 'SCRIPT', interfaceChanged: false, why: 'recorded',
});

/** A browser over a page the test controls: `expect` steps are evaluated against `page.text`. */
function harness(c: BrowserCapability) {
  const page = { text: 'Report for 2026-10 | row one | Total 42', extracted: 'Report for 2026-10\nrow one\nTotal 42' };
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
  const ran: BrowserWorkflow[] = [];
  const operateDeps: OperateDeps = {
    workflows: async () => new Map([[key(c.workflow.name), stored(c.workflow)]]),
    permission: async () => ({ permitted: true }) as never,
    judge: (async () => ({
      capability: 'OPERATE', outcome: 'ROUTE_SELECTED', route: 'BROWSER', reason: 'approved routine', reusableConnectorJustified: true,
      bespokeCrawlerMayBeProposed: false, boundaries: [], convertToScript: false, handoff: null,
    })) as never,
    run: async (workflow: BrowserWorkflow): Promise<WorkflowRun> => {
      ran.push(workflow);
      const run: WorkflowRun = {
        host: workflow.host, name: workflow.name, outcome: 'COMPLETED', steps: [], extracted: [], downloads: [],
        finalUrl: `https://${HOST}/reports`, boundary: null, interfaceChanged: false, detail: 'every step ran',
      };
      for (const [index, s] of workflow.steps.entries()) {
        if (s.kind === 'expect') {
          const ok = (!s.text || page.text.includes(s.text)) && (!s.absentText || !page.text.includes(s.absentText));
          run.steps.push({ index, kind: s.kind, ok, detail: ok ? 'success check passed' : `CHECK_FAILED: the page does not show "${s.text}"` });
          if (!ok) return { ...run, outcome: 'FAILED', detail: `step ${index + 1}: CHECK_FAILED` };
        } else {
          if (s.kind === 'extract') run.extracted.push({ name: s.name, text: page.extracted, truncated: false });
          run.steps.push({ index, kind: s.kind, ok: true, detail: 'ran' });
        }
      }
      return run;
    },
  };
  return {
    page,
    rows,
    ran,
    capabilityDeps,
    deps: () => ({ capabilityDeps, record, runRows: async () => [], operateDeps }),
    async define() {
      const v = await recordBrowserCapability(c, 'a person', capabilityDeps);
      await recordCapabilityDecision({ host: HOST, name: c.workflow.name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, capabilityDeps);
      return v;
    },
    async status() {
      return (await readBrowserCapabilities(HOST, capabilityDeps)).get(key(c.workflow.name))!.status;
    },
    lastRunRow() {
      const runs = rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT);
      return JSON.parse(runs[runs.length - 1]!.measures) as Record<string, unknown> & { verification: Record<string, unknown> };
    },
  };
}

let projectId = '';
const worker = { type: 'WORKER' as const, id: 'wrk_a' };
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('expected page states are checks in the workflow that runs', () => {
  it('checks each declared state right after the step it names, and does not repeat a check the workflow already makes', () => {
    const c = cap();
    const { workflow, checks } = withExpectedStates(c.workflow, c.expectedStates);
    expect(workflow.steps.map((s) => s.kind)).toEqual(['navigate', 'expect', 'extract', 'expect']);
    expect(workflow.steps[3]).toEqual({ kind: 'expect', text: 'Total' });
    expect(checks).toEqual([
      { state: 0, stepIndex: 1 },
      { state: 1, stepIndex: 3 },
    ]);
    // The approved definition itself is not changed.
    expect(c.workflow.steps).toHaveLength(3);
  });

  it('refuses a definition whose steps plus checks exceed what the workflow owner will run', () => {
    const steps: BrowserWorkflow['steps'] = [{ kind: 'navigate', url: `https://${HOST}/r` }, { kind: 'expect', text: 'Report' }];
    while (steps.length < MAX_WORKFLOW_STEPS - 1) steps.push({ kind: 'wait', seconds: 1 });
    steps.push({ kind: 'extract', name: 'report' });
    const states = [2, 3, 4].map((afterStep) => ({ afterStep, text: `state ${afterStep}` }));
    const problems = validateCapability(cap({ workflow: { ...cap().workflow, steps }, expectedStates: states }));
    expect(problems.join(' ')).toMatch(/steps plus its expected-state checks are at most/);
  });

  it('runs the declared state in the page: the run that is operated contains its check', async () => {
    const h = harness(cap());
    await h.define();
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: {}, actor: worker }, h.deps());
    expect(out.outcome).toBe('COMPLETED');
    expect(h.ran[0]!.steps).toContainEqual({ kind: 'expect', text: 'Total' });
    expect(h.lastRunRow().verification.expectedStates).toEqual({ declared: 2, missing: [] });
    expect(await h.status()).toBe('ACTIVE');
  });

  it('reproduces the finding and fixes it: drift in a declared state moves the capability to REVIEW', async () => {
    const h = harness(cap());
    await h.define();
    // The site no longer shows the totals row. Every locator still matches, so the workflow owner
    // alone reports no interface change; only the declared expected state can see the drift.
    h.page.text = 'Report for 2026-10 | row one';
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: {}, actor: worker }, h.deps());
    expect(out.outcome).toBe('REVIEW');
    expect(out.failureReason).toBe('EXPECTED_STATE_MISSING');
    const row = h.lastRunRow();
    expect(row.interfaceChanged).toBe(true);
    expect(expectedStateDrift({ steps: row.steps as WorkflowRun['steps'] })).toHaveLength(1);
    expect(await h.status()).toBe('REVIEW');

    // REVIEW is a handoff: the next run is refused before any browser session opens.
    const again = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: {}, actor: worker }, h.deps());
    expect(again.outcome).toBe('REVIEW');
    expect(again.sessionOpened).toBe(false);
    expect(h.ran).toHaveLength(1);
  });
});

describe('fixtures test what a run obtains', () => {
  it('matches fixtures by their exact inputs, and checks each expected output', () => {
    const c = cap({ inputs: [{ name: 'month', description: 'YYYY-MM' }], fixtures: [
      { name: 'october', inputs: { month: '2026-10' }, expect: { report: 'Report for 2026-10' } },
      { name: 'november', inputs: { month: '2026-11' }, expect: { report: 'Report for 2026-11' } },
    ] });
    expect(fixturesFor(c, { month: '2026-10' }).map((f) => f.name)).toEqual(['october']);
    expect(fixturesFor(c, { month: '2026-12' })).toEqual([]);
    const run = { extracted: [{ name: 'report', text: 'Report  for\n2026-10 rows', truncated: false }], downloads: [] };
    expect(checkFixture(c.fixtures[0]!, run)).toEqual({ ok: true, mismatched: [] });
    expect(checkFixture(c.fixtures[1]!, run)).toEqual({ ok: false, mismatched: ['report'] });
  });

  it('records a passing fixture on the run row', async () => {
    const h = harness(cap());
    await h.define();
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: {}, actor: worker }, h.deps());
    expect(out.outcome).toBe('COMPLETED');
    expect(h.lastRunRow().verification.fixtures).toEqual([{ name: 'current', ok: true, mismatched: [] }]);
  });

  it('a run that no longer obtains what its fixture says moves the capability to REVIEW, never COMPLETED', async () => {
    const c = cap({ fixtures: [{ name: 'current', inputs: {}, expect: { report: 'Report for' } }], expectedStates: [{ afterStep: 2, text: 'Report for' }] });
    const h = harness(c);
    await h.define();
    // Every page check passes, but the table now holds a different document.
    h.page.extracted = 'Statement 2026-10\nrow one';
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: {}, actor: worker }, h.deps());
    expect(out.outcome).toBe('REVIEW');
    expect(out.failureReason).toBe('FIXTURE_MISMATCH');
    expect(h.lastRunRow().verification).toMatchObject({ verified: false, fixtures: [{ name: 'current', ok: false, mismatched: ['report'] }] });
    expect(await h.status()).toBe('REVIEW');
  });

  it('testCapabilityFixtures runs each fixture of a READ through the one run path', async () => {
    const c = cap({ inputs: [{ name: 'month', description: 'YYYY-MM' }], fixtures: [
      { name: 'october', inputs: { month: '2026-10' }, expect: { report: 'Report for' } },
      { name: 'september', inputs: { month: '2026-09' }, expect: { report: 'Report for' } },
    ] });
    const h = harness(c);
    await h.define();
    const results = await testCapabilityFixtures({ projectId, host: HOST, name: 'monthly report', actor: worker }, h.deps());
    expect(results.map((r) => [r.fixture, r.result?.outcome])).toEqual([['october', 'COMPLETED'], ['september', 'COMPLETED']]);
    expect(h.ran).toHaveLength(2);
  });

  it('testCapabilityFixtures never performs a mutation to test it', async () => {
    const c = cap({
      workflow: { ...cap().workflow, steps: [...cap().workflow.steps, { kind: 'click', locator: { role: 'button', name: 'Submit order' } }] },
      effect: 'MUTATION',
      retry: { maxAttempts: 1, backoffMs: 0, retryAfterUnknown: false },
      expectedStates: [{ afterStep: 2, text: 'Report for' }],
    });
    expect(validateCapability(c)).toEqual([]);
    const h = harness(c);
    await h.define();
    const results = await testCapabilityFixtures({ projectId, host: HOST, name: 'monthly report', actor: worker }, h.deps());
    expect(results.every((r) => r.result === null)).toBe(true);
    expect(h.ran).toHaveLength(0);
  });
});
