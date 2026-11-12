/**
 * ACQ-21-5, repair R2-F2: the step list that runs is the step list that was
 * approved. `operateCapability` classifies and authorizes the approved
 * version's workflow; the workflow owner must run exactly that, never the
 * newest BROWSER_WORKFLOW row for the host/name, which is written separately
 * and can be replaced without a capability decision.
 *
 * The real `operateWorkflow` runs here; only the store, the judgment, the
 * permission and the browser itself are replaced, so no browser is opened.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  BROWSER_WORKFLOW_RUN_EVENT,
  type BrowserWorkflow,
  type OperateDeps,
  type RunWorkflowOptions,
  type WorkflowRecord,
  type WorkflowRun,
} from '../server/services/sources/browserWorkflow.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  operateCapability,
  recordBrowserCapability,
  recordCapabilityDecision,
  type BrowserCapability,
} from '../server/services/sources/browser/index.ts';

const HOST = 'records.example.org';

const approvedCap = (): BrowserCapability => ({
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

/** A step list nobody approved: recorded directly through the workflow owner under the same host/name. */
const unapprovedWorkflow = (): BrowserWorkflow => ({
  ...approvedCap().workflow,
  steps: [
    { kind: 'navigate', url: `https://${HOST}/account` },
    { kind: 'click', locator: { role: 'button', name: 'Delete account' } },
    { kind: 'extract', name: 'report', locator: { testId: 'report-table' } },
  ],
});

const storedRecord = (workflow: BrowserWorkflow, over: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflow, definedAt: new Date().toISOString(), runs: 0, completed: 0, streak: 0, status: 'SCRIPT', interfaceChanged: false, why: 'recorded', ...over,
});

function harness(stored: () => Map<string, WorkflowRecord>) {
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
    workflows: async () => stored(),
    permission: async () => ({ permitted: true }) as never,
    judge: (async () => ({
      capability: 'OPERATE', outcome: 'ROUTE_SELECTED', route: 'BROWSER', reason: 'approved routine', reusableConnectorJustified: true,
      bespokeCrawlerMayBeProposed: false, boundaries: [], convertToScript: false, handoff: null,
    })) as never,
    run: async (workflow: BrowserWorkflow, _o: RunWorkflowOptions = {}): Promise<WorkflowRun> => {
      ran.push(workflow);
      return {
        host: workflow.host, name: workflow.name, outcome: 'COMPLETED',
        steps: workflow.steps.map((s, index) => ({ index, kind: s.kind, ok: true, detail: 'ran' })),
        extracted: [{ name: 'report', text: 'Report for 2026-10\nrow one', truncated: false }], downloads: [],
        finalUrl: `https://${HOST}/reports`, boundary: null, interfaceChanged: false, detail: 'every step ran',
      };
    },
  };
  return {
    ran,
    deps: () => ({ capabilityDeps, record, runRows: async () => [], operateDeps }),
    async define(c: BrowserCapability) {
      const v = await recordBrowserCapability(c, 'a person', capabilityDeps);
      await recordCapabilityDecision({ host: HOST, name: c.workflow.name, contentHash: v.contentHash, decision: 'APPROVED', by: 'a person' }, capabilityDeps);
      return v;
    },
  };
}

const key = (name: string) => `${HOST}\u0000${name}`;
let projectId = '';
const worker = { type: 'WORKER' as const, id: 'wrk_a' };

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('the approved version is the step list that runs', () => {
  it('runs the approved steps when the newest stored workflow for the host/name is a different, consequential one', async () => {
    const h = harness(() => new Map([[key('monthly report'), storedRecord(unapprovedWorkflow())]]));
    await h.define(approvedCap());
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(out.outcome).toBe('COMPLETED');
    expect(h.ran).toHaveLength(1);
    expect(h.ran[0]!.steps).toEqual(approvedCap().workflow.steps);
    expect(JSON.stringify(h.ran[0]!.steps)).not.toContain('Delete account');
  });

  it('still honours the store lifecycle: a retired workflow is not run, even pinned', async () => {
    const h = harness(() => new Map([[key('monthly report'), storedRecord(unapprovedWorkflow(), { status: 'RETIRED', why: 'retired by a person' })]]));
    await h.define(approvedCap());
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(h.ran).toHaveLength(0);
    expect(out.outcome).not.toBe('COMPLETED');
  });

  it('runs nothing when the workflow owner holds no record for the host/name', async () => {
    const h = harness(() => new Map());
    await h.define(approvedCap());
    const out = await operateCapability({ projectId, host: HOST, name: 'monthly report', inputs: { month: '2026-10' }, actor: worker }, h.deps());
    expect(h.ran).toHaveLength(0);
    expect(out.outcome).not.toBe('COMPLETED');
  });
});
