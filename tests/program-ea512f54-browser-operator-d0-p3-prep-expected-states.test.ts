/**
 * ACQ-21-5, finding F3: a capability's declared expected page states and test
 * fixtures are executed, not only validated. Each expected state runs as a
 * check after the step it names; a state that does not hold, or a fixture the
 * run does not satisfy, moves the capability to REVIEW instead of counting as
 * a success. The workflow owner's runner is replaced by a fake page that
 * answers each `expect` step, so no browser opens.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { BROWSER_WORKFLOW_RUN_EVENT, type BrowserWorkflow, type OperateDeps, type RunWorkflowOptions, type WorkflowRecord, type WorkflowRun } from '../server/services/sources/browserWorkflow.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  executedWorkflow,
  expectedStateResults,
  fixtureResults,
  operateCapability,
  readBrowserCapabilities,
  recordBrowserCapability,
  recordCapabilityDecision,
  type BrowserCapability,
} from '../server/services/sources/browser/index.ts';

const HOST = 'ledger.example.net';

const cap = (): BrowserCapability => ({
  workflow: {
    host: HOST,
    name: 'balance sheet',
    purpose: 'read the balance sheet the account already has access to',
    account: false,
    origin: 'AUTHORED',
    steps: [
      { kind: 'navigate', url: `https://${HOST}/sheets` },
      { kind: 'click', locator: { role: 'link', name: 'Balance sheet' } },
      { kind: 'expect', text: 'Total assets' },
      { kind: 'extract', name: 'sheet', locator: { testId: 'sheet' } },
    ],
  },
  inputs: [{ name: 'year', description: 'the fiscal year' }],
  outputs: [{ name: 'sheet', description: 'the sheet text' }],
  effect: 'READ',
  // State 1 is the workflow's own check (step 3); state 2 is declared only on the capability.
  expectedStates: [
    { afterStep: 3, text: 'Total assets' },
    { afterStep: 1, urlIncludes: '/sheets' },
  ],
  timeoutMs: 60_000,
  retry: { maxAttempts: 2, backoffMs: 0, retryAfterUnknown: true },
  freshnessMs: 3_600_000,
  failureReasons: [],
  fixtures: [{ name: 'fy2025', inputs: { year: '2025' }, expect: { sheet: 'Total assets' } }],
  maintenanceOwner: 'acquisition maintainers',
  session: { account: false, reauthorizeAfterMs: null },
  rateLimit: { maxRunsPerHour: 10, minIntervalMs: 0 },
});

/** A page that answers `expect` steps from `page`, and records the steps it was asked to run. */
function harness() {
  const rows: { eventType: string; measures: string; outcome: string | null; at: string }[] = [];
  let clock = Date.now() - 3_600_000;
  const record = (async (e: { eventType: string; measures?: Record<string, unknown>; outcome?: string | null }) =>
    void rows.push({ eventType: e.eventType, measures: JSON.stringify(e.measures ?? {}), outcome: e.outcome ?? null, at: new Date((clock += 1000)).toISOString() })) as never;
  const capabilityDeps = {
    record,
    rows: async () => ({
      capabilities: rows.filter((r) => r.eventType === BROWSER_CAPABILITY_EVENT),
      runs: rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT),
    }),
    now: () => clock,
    recordWorkflow: (async (w: unknown) => w) as never,
  };
  const page = { url: `https://${HOST}/sheets`, text: 'Total assets 100', sheet: 'Total assets 100\nliabilities 40' };
  const ran: BrowserWorkflow[] = [];
  const stored = (): Map<string, WorkflowRecord> =>
    new Map([[`${HOST}\u0000balance sheet`, { workflow: cap().workflow, definedAt: new Date().toISOString(), status: 'ACTIVE', interfaceChanged: false, why: 'stored' } as unknown as WorkflowRecord]]);
  const operateDeps: OperateDeps = {
    workflows: async () => stored(),
    permission: async () => ({ permitted: true }) as never,
    judge: (async () => ({
      capability: 'OPERATE', outcome: 'ROUTE_SELECTED', route: 'BROWSER', reason: 'approved routine', reusableConnectorJustified: true,
      bespokeCrawlerMayBeProposed: false, boundaries: [], convertToScript: false, handoff: null,
    })) as never,
    run: async (workflow: BrowserWorkflow, _o: RunWorkflowOptions = {}): Promise<WorkflowRun> => {
      ran.push(workflow);
      const run: WorkflowRun = { host: workflow.host, name: workflow.name, outcome: 'COMPLETED', steps: [], extracted: [], downloads: [], finalUrl: page.url, boundary: null, interfaceChanged: false, detail: '' };
      for (const [index, s] of workflow.steps.entries()) {
        if (s.kind === 'expect') {
          const ok = (!s.text || page.text.includes(s.text)) && (!s.urlIncludes || page.url.includes(s.urlIncludes));
          run.steps.push({ index, kind: s.kind, ok, detail: ok ? 'success check passed' : 'CHECK_FAILED: the page does not match' });
          if (!ok) return { ...run, outcome: 'FAILED', detail: `step ${index + 1}: CHECK_FAILED` };
          continue;
        }
        if (s.kind === 'extract') run.extracted.push({ name: s.name, text: page.sheet, truncated: false });
        run.steps.push({ index, kind: s.kind, ok: true, detail: 'ran' });
      }
      return { ...run, detail: 'every step ran' };
    },
  };
  return {
    rows,
    ran,
    page,
    capabilityDeps,
    deps: () => ({ capabilityDeps, record, runRows: async () => [], operateDeps }),
    async define(c: BrowserCapability) {
      const v = await recordBrowserCapability(c, 'a person', capabilityDeps);
      await recordCapabilityDecision({ host: HOST, name: c.workflow.name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, capabilityDeps);
      return v;
    },
    status: async () => (await readBrowserCapabilities(HOST, capabilityDeps)).get(`${HOST}\u0000balance sheet`)?.status,
    runRows: () => rows.filter((r) => r.eventType === BROWSER_WORKFLOW_RUN_EVENT),
  };
}

let projectId = '';
const worker = { type: 'WORKER' as const, id: 'wrk_states' };
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('the executed step list', () => {
  it('checks every declared expected state after the step it names, and reuses the workflow’s own identical check', () => {
    const c = cap();
    const ex = executedWorkflow(c);
    expect(ex.workflow.steps.map((s) => s.kind)).toEqual(['navigate', 'expect', 'click', 'expect', 'extract']);
    expect(ex.workflow.steps[1]).toEqual({ kind: 'expect', urlIncludes: '/sheets' });
    // The approved steps are unchanged and in order.
    expect(ex.workflow.steps.filter((_, i) => ex.origins[i]!.step > 0)).toEqual(c.workflow.steps);
    expect(ex.origins[1]).toEqual({ step: 0, states: [1] });
    expect(ex.origins[3]).toEqual({ step: 3, states: [0] });
  });

  it('judges each state HELD, MISSING or NOT_REACHED from the run', () => {
    const c = cap();
    const ex = executedWorkflow(c);
    const run: WorkflowRun = {
      host: HOST, name: 'balance sheet', outcome: 'FAILED', boundary: null, interfaceChanged: false, finalUrl: null, extracted: [], downloads: [], detail: '',
      steps: [{ index: 0, kind: 'navigate', ok: true, detail: '' }, { index: 1, kind: 'expect', ok: false, detail: 'CHECK_FAILED' }],
    };
    expect(expectedStateResults(c, ex, run).map((x) => x.result)).toEqual(['NOT_REACHED', 'MISSING']);
  });

  it('applies a fixture only to its own inputs and judges it against the obtained outputs', () => {
    const c = cap();
    const run: WorkflowRun = {
      host: HOST, name: 'balance sheet', outcome: 'COMPLETED', boundary: null, interfaceChanged: false, finalUrl: null, downloads: [], detail: '', steps: [],
      extracted: [{ name: 'sheet', text: 'Net income 5', truncated: false }],
    };
    expect(fixtureResults(c, { year: '2024' }, run)).toEqual([]);
    expect(fixtureResults(c, { year: '2025' }, run)).toMatchObject([{ name: 'fy2025', result: 'FAILED' }]);
    expect(fixtureResults(c, { year: '2025' }, { ...run, extracted: [{ name: 'sheet', text: 'TOTAL  ASSETS 9', truncated: false }] })).toMatchObject([{ result: 'PASSED' }]);
  });
});

describe('operating a capability executes its expected states and fixtures', () => {
  it('runs the inserted state checks and completes when every state holds and the fixture passes', async () => {
    const h = harness();
    await h.define(cap());
    const out = await operateCapability({ projectId, host: HOST, name: 'balance sheet', inputs: { year: '2025' }, actor: worker }, h.deps());
    expect(out.outcome).toBe('COMPLETED');
    expect(h.ran[0]!.steps).toEqual(executedWorkflow(cap()).workflow.steps);
    expect(out.expectedStates.map((x) => x.result)).toEqual(['HELD', 'HELD']);
    expect(out.fixtures).toMatchObject([{ name: 'fy2025', result: 'PASSED' }]);
    const m = JSON.parse(h.runRows()[0]!.measures);
    expect(m.verification.expectedStates.map((x: { result: string }) => x.result)).toEqual(['HELD', 'HELD']);
    expect(await h.status()).toBe('ACTIVE');
  });

  it('moves the capability to REVIEW when a capability-declared state drifts, and runs nothing after', async () => {
    const h = harness();
    await h.define(cap());
    h.page.url = `https://${HOST}/moved`;
    const out = await operateCapability({ projectId, host: HOST, name: 'balance sheet', inputs: { year: '2025' }, actor: worker }, h.deps());
    expect(out).toMatchObject({ outcome: 'REVIEW', failureReason: 'INTERFACE_CHANGED' });
    expect(out.expectedStates.find((x) => x.state === 1)?.result).toBe('MISSING');
    expect(h.runRows()[0]!.outcome).toBe('FAILED');
    expect(JSON.parse(h.runRows()[0]!.measures).interfaceChanged).toBe(true);
    expect(await h.status()).toBe('REVIEW');
    const again = await operateCapability({ projectId, host: HOST, name: 'balance sheet', inputs: { year: '2025' }, actor: worker }, h.deps());
    expect(again).toMatchObject({ outcome: 'REVIEW', sessionOpened: false });
    expect(h.ran).toHaveLength(1);
  });

  it('moves the capability to REVIEW when a run with a fixture’s inputs does not obtain what the fixture states', async () => {
    const h = harness();
    await h.define(cap());
    h.page.sheet = 'Net income 5';
    const out = await operateCapability({ projectId, host: HOST, name: 'balance sheet', inputs: { year: '2025' }, actor: worker }, h.deps());
    expect(out).toMatchObject({ outcome: 'REVIEW', failureReason: 'FIXTURE_FAILED' });
    expect(out.fixtures).toMatchObject([{ name: 'fy2025', result: 'FAILED' }]);
    expect(await h.status()).toBe('REVIEW');
  });

  it('does not judge a fixture against a run with other inputs', async () => {
    const h = harness();
    await h.define(cap());
    h.page.sheet = 'Net income 5';
    const out = await operateCapability({ projectId, host: HOST, name: 'balance sheet', inputs: { year: '2024' }, actor: worker }, h.deps());
    expect(out.outcome).toBe('COMPLETED');
    expect(out.fixtures).toEqual([]);
  });
});
