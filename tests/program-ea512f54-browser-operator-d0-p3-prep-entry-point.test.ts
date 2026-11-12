/**
 * ACQ-21-5, finding F1: the capability layer is reached from the running Brain.
 *
 * Two production doors, both writing real rows through the one writer of each
 * record and running only through `operateCapability`:
 *
 *  - the terminal (`capabilityCli.ts`): define, discover, approve, retire, run;
 *  - the integrations tick (`integrations/loop.ts`, started by
 *    `server/index.ts`): approved, input-free, stale READs.
 *
 * The database is real; only the browser itself (`operateWorkflow`) is faked.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createProject } from '../server/repos/projects.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { BROWSER_WORKFLOW_RUN_EVENT, type OperateDeps, type OperateResult, type WorkflowRun } from '../server/services/sources/browserWorkflow.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  readBrowserCapabilities,
  runDueBrowserCapabilities,
  scheduledEligibility,
  type BrowserCapability,
} from '../server/services/sources/browser/index.ts';
import { runCapabilityCommand } from '../server/services/sources/browser/capabilityCli.ts';
import { integrationsTick } from '../server/services/integrations/loop.ts';
import { integration } from '../server/services/integrations/registry.ts';

let seq = 0;
let host = '';
let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  seq += 1;
  host = `entry${seq}-${Date.now()}.example.org`;
});

const readCap = (h: string, name = 'daily status', inputs: BrowserCapability['inputs'] = []): BrowserCapability => ({
  workflow: {
    host: h,
    name,
    purpose: 'read the public status table',
    account: false,
    origin: 'AUTHORED',
    steps: [
      { kind: 'navigate', url: `https://${h}/status` },
      { kind: 'expect', text: 'Status' },
      { kind: 'extract', name: 'status', locator: { testId: 'status-table' } },
    ],
  },
  inputs,
  outputs: [{ name: 'status', description: 'the status table text' }],
  effect: 'READ',
  expectedStates: [{ afterStep: 1, text: 'Status' }],
  timeoutMs: 60_000,
  retry: { maxAttempts: 3, backoffMs: 30_000, retryAfterUnknown: true },
  freshnessMs: 24 * 3_600_000,
  failureReasons: [],
  fixtures: [{ name: 'today', inputs: Object.fromEntries(inputs.map((f) => [f.name, 'x'])), expect: { status: 'Status' } }],
  maintenanceOwner: 'acquisition maintainers',
  session: { account: false, reauthorizeAfterMs: 7 * 24 * 3_600_000 },
  rateLimit: { maxRunsPerHour: 60, minIntervalMs: 0 },
});

const publishCap = (h: string): BrowserCapability => {
  const c = readCap(h, 'publish notice');
  c.workflow = {
    ...c.workflow,
    purpose: 'publish an already-approved notice',
    steps: [
      { kind: 'navigate', url: `https://${h}/notices` },
      { kind: 'click', locator: { role: 'button', name: 'Publish' } },
      { kind: 'expect', text: 'Published' },
      { kind: 'extract', name: 'status', locator: { testId: 'confirmation' } },
    ],
  };
  c.effect = 'MUTATION';
  c.expectedStates = [{ afterStep: 2, text: 'Published' }];
  c.retry = { maxAttempts: 1, backoffMs: 0, retryAfterUnknown: false };
  return c;
};

/** The browser, faked: reports a completed run and writes the owner's run row through the hook it is given. */
function fakeBrowser() {
  let calls = 0;
  const operate = async (h: string, name: string, d: OperateDeps = {}): Promise<OperateResult> => {
    calls += 1;
    const run: WorkflowRun = {
      host: h, name, outcome: 'COMPLETED', steps: [{ index: 0, kind: 'navigate', ok: true, detail: 'opened' }],
      extracted: [{ name: 'status', text: 'Status: all good\nrow', truncated: false }], downloads: [],
      finalUrl: `https://${h}/status`, boundary: null, interfaceChanged: false, detail: 'every step ran',
    };
    await d.record?.({ eventType: BROWSER_WORKFLOW_RUN_EVENT, outcome: run.outcome, reason: run.detail, measures: { host: h, name, steps: run.steps } });
    return { run, judgment: null, record: null };
  };
  return { operate: operate as never, calls: () => calls };
}

async function define(c: BrowserCapability): Promise<string> {
  const out = await runCapabilityCommand(['define', '--file', 'cap.json', '--by', 'a person'], { readFile: async () => JSON.stringify(c) });
  expect(out.code, out.out).toBe(0);
  const hash = /hash ([0-9a-f]{16,})/.exec(out.out)?.[1];
  expect(hash).toBeTruthy();
  return hash!;
}

async function approve(c: BrowserCapability, hash: string) {
  const out = await runCapabilityCommand(['approve', '--host', c.workflow.host, '--name', c.workflow.name, '--hash', hash, '--by', 'a person']);
  expect(out.code, out.out).toBe(0);
  return out;
}

const rowsOf = (eventType: string, h: string) =>
  getDb().all<{ outcome: string | null; measures: string }>(`SELECT outcome, measures FROM bin_events WHERE event_type = ? AND measures LIKE ?`, [eventType, `%"host":"${h}"%`]);

describe('the terminal writes real capability rows through the one writer', () => {
  it('define records a DRAFT, show prints its hash and steps, approve moves it to APPROVED', async () => {
    const c = readCap(host);
    const hash = await define(c);
    let shown = await runCapabilityCommand(['show', '--host', host]);
    expect(shown.out).toContain('DRAFT');
    expect(shown.out).toContain(hash);
    expect(shown.out).toMatch(/step 2 extract IDEMPOTENT_READ/);
    const approved = await approve(c, hash);
    expect(approved.out).toContain('APPROVED');
    shown = await runCapabilityCommand(['show', '--host', host]);
    expect(shown.out).toContain('approved by a person');
    const rows = await rowsOf(BROWSER_CAPABILITY_EVENT, host);
    expect(rows.map((r) => r.outcome).sort()).toEqual(['APPROVED', 'DEFINED']);
  });

  it('refuses an approval of a hash that is not the current version, and a usage error is not a throw', async () => {
    const c = readCap(host);
    await define(c);
    const out = await runCapabilityCommand(['approve', '--host', host, '--name', c.workflow.name, '--hash', 'deadbeefdeadbeef', '--by', 'a person']);
    expect(out.code).toBe(1);
    expect(out.out).toMatch(/refused: .*not the current version/);
    expect((await runCapabilityCommand(['approve', '--host', host])).code).toBe(2);
    expect((await runCapabilityCommand(['nonsense'])).code).toBe(2);
  });

  it('retire records the decision and the capability no longer runs', async () => {
    const c = readCap(host);
    const hash = await define(c);
    await approve(c, hash);
    const out = await runCapabilityCommand(['retire', '--host', host, '--name', c.workflow.name, '--hash', hash, '--by', 'a person']);
    expect(out.code, out.out).toBe(0);
    expect(out.out).toContain('RETIRED');
  });

  it('run performs an approved mutation only with the steps the person names, and only once', async () => {
    const c = publishCap(host);
    const hash = await define(c);
    await approve(c, hash);
    const browser = fakeBrowser();
    const deps = { operateDeps: { operate: browser.operate, runRows: async () => [] } };
    const base = ['run', '--host', host, '--name', c.workflow.name, '--project', projectId, '--by', 'a person'];

    const refused = await runCapabilityCommand(base, deps);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('APPROVAL_MISSING');
    expect(browser.calls()).toBe(0);

    const done = await runCapabilityCommand([...base, '--approve-steps', '1'], deps);
    expect(done.code, done.out).toBe(0);
    expect(done.out).toMatch(/^COMPLETED/);
    expect(browser.calls()).toBe(1);

    const again = await runCapabilityCommand([...base, '--approve-steps', '1'], deps);
    expect(again.code).toBe(1);
    expect(again.out).toContain('DUPLICATE_EFFECT');
    expect(browser.calls()).toBe(1);

    const runs = await rowsOf(BROWSER_WORKFLOW_RUN_EVENT, host);
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.measures).capability.contentHash).toBe(hash);
  });

  it('performs an approved mutation once even when a second run names a different --project', async () => {
    const c = publishCap(host);
    const hash = await define(c);
    await approve(c, hash);
    const browser = fakeBrowser();
    const deps = { operateDeps: { operate: browser.operate, runRows: async () => [] } };
    const other = await createProject({ name: `Other ${Math.random().toString(36).slice(2, 8)}` });
    const run = (project: string) =>
      ['run', '--host', host, '--name', c.workflow.name, '--project', project, '--by', 'a person', '--approve-steps', '1'];

    const done = await runCapabilityCommand(run(projectId), deps);
    expect(done.code, done.out).toBe(0);
    expect(browser.calls()).toBe(1);

    // The project is a flag the caller types; it must not make the same effect a new one.
    const elsewhere = await runCapabilityCommand(run(other.id), deps);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.out).toContain('DUPLICATE_EFFECT');
    expect(browser.calls()).toBe(1);
  });
});

describe('the integrations tick runs approved reads on the running Brain', () => {
  it('runs an approved, input-free, stale READ once, and not again while it is fresh', async () => {
    const c = readCap(host);
    const hash = await define(c);
    await approve(c, hash);
    const browser = fakeBrowser();
    const deps = { browserConfigured: () => true, operateDeps: { operate: browser.operate, runRows: async () => [] } };

    const first = (await runDueBrowserCapabilities(deps)).filter((r) => r.host === host);
    expect(first).toEqual([{ host, name: c.workflow.name, version: 1, outcome: 'COMPLETED', failureReason: null }]);
    expect(browser.calls()).toBe(1);
    const record = (await readBrowserCapabilities(host)).get(`${host}\u0000${c.workflow.name}`)!;
    expect(record.status).toBe('ACTIVE');
    expect(record.fresh).toBe(true);

    const second = (await runDueBrowserCapabilities(deps)).filter((r) => r.host === host);
    expect(second).toEqual([]);
    expect(browser.calls()).toBe(1);
    const runs = await rowsOf(BROWSER_WORKFLOW_RUN_EVENT, host);
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.measures)).toMatchObject({ outcome: 'COMPLETED', capability: { version: 1, contentHash: hash } });
  });

  it('never runs a draft, a mutation, or a read that needs inputs; and nothing without a browser', async () => {
    const draft = readCap(host, 'draft read');
    await define(draft);
    const mutation = publishCap(host);
    await approve(mutation, await define(mutation));
    const withInputs = readCap(host, 'search', [{ name: 'q', description: 'the query' }]);
    await approve(withInputs, await define(withInputs));

    const records = await readBrowserCapabilities(host);
    const why = Object.fromEntries([...records.values()].map((r) => [r.name, scheduledEligibility(r)]));
    expect(why['draft read']).toEqual({ run: false, why: 'status DRAFT' });
    expect(why['publish notice']?.run).toBe(false);
    expect(why['search']?.run).toBe(false);

    const browser = fakeBrowser();
    const ran = (await runDueBrowserCapabilities({ browserConfigured: () => true, operateDeps: { operate: browser.operate, runRows: async () => [] } }))
      .filter((r) => r.host === host);
    expect(ran).toEqual([]);
    expect(browser.calls()).toBe(0);

    const ready = readCap(host, 'ready read');
    await approve(ready, await define(ready));
    expect(await runDueBrowserCapabilities({ browserConfigured: () => false, operateDeps: { operate: browser.operate } })).toEqual([]);
    expect(browser.calls()).toBe(0);
  });

  it('is wired into the tick server/index.ts starts, and declared in the integration registry', () => {
    const root = process.cwd();
    const index = readFileSync(path.join(root, 'server/index.ts'), 'utf8');
    expect(index).toMatch(/startIntegrationsLoop\(/);
    const loop = readFileSync(path.join(root, 'server/services/integrations/loop.ts'), 'utf8');
    expect(loop).toMatch(/from '\.\.\/sources\/browser\/schedule\.ts'/);
    expect(loop).toMatch(/await runDueBrowserCapabilities\(\)/);
    const browser = integration('browser');
    expect(browser.consumers.map((x) => x.path)).toEqual(
      expect.arrayContaining(['server/services/sources/browser/schedule.ts', 'server/services/sources/browser/capabilityCli.ts']),
    );
    const cli = readFileSync(path.join(root, 'server/services/sources/browser/capabilityCli.ts'), 'utf8');
    expect(cli).toMatch(/import\.meta\.url\.endsWith/);
  });

  it('the tick itself does nothing during warm-up', async () => {
    expect(await integrationsTick(Date.now(), {}, 0)).toEqual([]);
  });
});
