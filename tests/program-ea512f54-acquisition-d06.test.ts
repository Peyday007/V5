/**
 * ACQ-21-1 / ACQ-21-2: Brain operates a site's interface, not only renders a page.
 *
 * The browser server is faked at the MCP boundary, but the page is a real DOM
 * (jsdom) and the in-page step code `browserWorkflow.ts` sends is the code that
 * runs: locators, form entry, filtering, clicking, explicit success checks,
 * extraction and same-origin download handling are exercised as written.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_WORKFLOW_RUN_EVENT,
  MAX_WORKFLOW_STEPS,
  operateWorkflow,
  readBrowserWorkflows,
  recordBrowserWorkflow,
  runBrowserWorkflow,
  surveyInterface,
  validateWorkflow,
  workflowsFrom,
  type BrowserWorkflow,
  type WorkflowRecord,
} from '../server/services/sources/browserWorkflow.ts';
import { recordOperatePermission } from '../server/services/sources/acquisition.ts';
import { SCRIPT_CONVERSION_RUNS } from '../server/services/sources/accessMethods.ts';
import { ROUTINE_RETIRE_FAILURES } from '../server/services/sources/routines.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

const HOST = 'portal.example';
const resolve = async () => ['93.184.216.34'];

const SEARCH_PAGE = `<!doctype html><html><head><title>Records</title></head><body>
  <form id="f"><label for="q">Search records</label><input id="q" type="text">
  <label for="region">Region</label><select id="region"><option value="">Any</option><option value="w">West</option><option value="e">East</option></select>
  <button type="button" id="go">Search</button></form>
  <div data-testid="results"></div>
  <a href="/export.csv" id="dl">Export CSV</a>
</body></html>`;

const LOGIN_PAGE = `<!doctype html><html><body><form><label for="u">Email</label><input id="u" type="email">
  <label for="p">Password</label><input id="p" type="password"><button>Sign in</button></form></body></html>`;

const AMBIGUOUS_PAGE = `<!doctype html><html><body><button>Search</button><button>Search</button><p>ok</p></body></html>`;

/** A fake Playwright MCP server whose page is a real DOM. */
function fakeBrowser(pages: Record<string, string>, opts: { downloads?: Record<string, string>; redirect?: Record<string, string> } = {}) {
  let dom: JSDOM | null = null;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const load = (url: string) => {
    const landed = opts.redirect?.[url] ?? url;
    dom = new JSDOM(pages[landed] ?? '<html><body>not found</body></html>', { url: landed, runScripts: 'outside-only' });
    const w = dom.window as unknown as Record<string, unknown> & { HTMLElement: { prototype: Record<string, unknown> }; CSS?: unknown; document: Document };
    // jsdom does no layout; every rendered element counts as visible, hidden ones as not.
    w.HTMLElement.prototype['getClientRects'] = function (this: HTMLElement) {
      return this.closest('[hidden]') ? [] : [{}];
    };
    if (!w.CSS) w.CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
    w['fetch'] = async (href: string) => {
      const body = opts.downloads?.[new URL(href, landed).href];
      return { ok: body !== undefined, status: body !== undefined ? 200 : 404, url: href, headers: { get: () => 'text/csv' }, text: async () => body ?? '' };
    };
    // The site's own behaviour: searching writes the results.
    const go = w.document.getElementById('go');
    go?.addEventListener('click', () => {
      const q = (w.document.getElementById('q') as HTMLInputElement).value;
      const region = (w.document.getElementById('region') as HTMLSelectElement).value;
      w.document.querySelector('[data-testid=results]')!.textContent = `3 records for ${q} in ${region === 'w' ? 'West' : 'Any'}`;
    });
  };
  const http = async (_url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'mcp-session-id': 's1', 'content-type': 'application/json' } });
    if (body.method !== 'tools/call') return reply({});
    const name = body.params.name!;
    const args = body.params.arguments ?? {};
    calls.push({ name, args });
    if (name === 'browser_navigate') {
      load(String(args['url']));
      return reply({ content: [{ type: 'text', text: 'navigated' }] });
    }
    if (name === 'browser_wait_for') return reply({ content: [{ type: 'text', text: 'waited' }] });
    if (name === 'browser_evaluate') {
      const fn = (dom!.window as unknown as { eval: (code: string) => () => unknown }).eval(`(${String(args['function'])})`);
      const value = await fn();
      return reply({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(value)}\n` }] });
    }
    return reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
  };
  return { http: http as never, calls };
}

const searchWorkflow = (over: Partial<BrowserWorkflow> = {}): BrowserWorkflow => ({
  host: HOST,
  name: 'export west records',
  purpose: 'export the records list for the West region',
  account: true,
  origin: 'AUTHORED',
  steps: [
    { kind: 'navigate', url: `https://${HOST}/records` },
    { kind: 'fill', locator: { label: 'Search records' }, value: 'widgets' },
    { kind: 'select', locator: { label: 'Region' }, option: 'West' },
    { kind: 'click', locator: { role: 'button', name: 'Search' } },
    { kind: 'expect', locator: { testId: 'results' }, text: '3 records for widgets in West' },
    { kind: 'extract', name: 'results', locator: { testId: 'results' } },
    { kind: 'download', name: 'export', locator: { role: 'link', name: 'Export CSV' } },
  ],
  ...over,
});

describe('a workflow definition is bounded and reliable before it runs (pure)', () => {
  it('accepts a workflow with reliable locators and an explicit success check', () => {
    expect(validateWorkflow(searchWorkflow())).toEqual([]);
  });

  it('refuses what would make operation unbounded, unchecked or a credential handler', () => {
    const steps = searchWorkflow().steps;
    const problems = (w: Partial<BrowserWorkflow>) => validateWorkflow(searchWorkflow(w)).join(' | ');
    expect(problems({ steps: steps.filter((s) => s.kind !== 'expect') })).toMatch(/explicit success check/);
    expect(problems({ steps: [{ kind: 'navigate', url: 'https://elsewhere.example/' }, ...steps.slice(1)] })).toMatch(/stays on/);
    expect(problems({ steps: [...steps, { kind: 'fill', locator: { label: 'Password' }, value: 'x' }] })).toMatch(/credential field is a boundary/);
    expect(problems({ steps: [...steps, { kind: 'fill', locator: { label: 'Note' }, value: 'sk-abcdefabcdefabcdef' }] })).toMatch(/never a credential/);
    expect(problems({ steps: [...steps, { kind: 'click', locator: { role: 'button', css: '#go' } }] })).toMatch(/exactly one of/);
    expect(problems({ steps: [steps[0]!, ...Array.from({ length: MAX_WORKFLOW_STEPS }, () => steps[4]!)] })).toMatch(new RegExp(`at most ${MAX_WORKFLOW_STEPS}`));
    expect(problems({ steps: [...steps, { kind: 'download', name: 'x', url: 'https://elsewhere.example/a.csv' }] })).toMatch(/download stays on/);
  });
});

describe('runBrowserWorkflow operates the interface', () => {
  it('navigates, searches, filters, clicks, checks success, extracts and downloads under the session', async () => {
    const browser = fakeBrowser({ [`https://${HOST}/records`]: SEARCH_PAGE }, { downloads: { [`https://${HOST}/export.csv`]: 'id,name\n1,widget\n' } });
    const run = await runBrowserWorkflow(searchWorkflow(), { endpoint: 'http://browser.internal/mcp', http: browser.http, resolve });
    expect(run.detail).toMatch(/every success check held/);
    expect(run.outcome).toBe('COMPLETED');
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.extracted).toEqual([{ name: 'results', text: '3 records for widgets in West', truncated: false }]);
    expect(run.downloads).toHaveLength(1);
    expect(run.downloads[0]).toMatchObject({ name: 'export', url: `https://${HOST}/export.csv`, chars: 17, text: 'id,name\n1,widget\n' });
    expect(run.downloads[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the browser was driven by locators in page code, never by a model per click.
    expect(new Set(browser.calls.map((c) => c.name))).toEqual(new Set(['browser_navigate', 'browser_evaluate']));
  });

  it('a success check that does not hold fails the run', async () => {
    const browser = fakeBrowser({ [`https://${HOST}/records`]: SEARCH_PAGE });
    const steps = searchWorkflow().steps.slice(0, 4).concat([{ kind: 'expect', text: '99 records' }]);
    const run = await runBrowserWorkflow(searchWorkflow({ steps }), { endpoint: 'http://b/mcp', http: browser.http, resolve });
    expect(run.outcome).toBe('FAILED');
    expect(run.detail).toMatch(/CHECK_FAILED/);
  });

  it('an ambiguous locator fails rather than guessing, and marks the interface as changed', async () => {
    const browser = fakeBrowser({ [`https://${HOST}/a`]: AMBIGUOUS_PAGE });
    const run = await runBrowserWorkflow(
      searchWorkflow({ steps: [{ kind: 'navigate', url: `https://${HOST}/a` }, { kind: 'click', locator: { role: 'button', name: 'Search' } }, { kind: 'expect', text: 'ok' }] }),
      { endpoint: 'http://b/mcp', http: browser.http, resolve },
    );
    expect(run.outcome).toBe('FAILED');
    expect(run.detail).toMatch(/AMBIGUOUS: 2 elements/);
    expect(run.interfaceChanged).toBe(true);
  });

  it('a sign-in wall is a boundary: the run hands off and types nothing', async () => {
    const browser = fakeBrowser({ [`https://${HOST}/login`]: LOGIN_PAGE }, { redirect: { [`https://${HOST}/records`]: `https://${HOST}/login` } });
    const run = await runBrowserWorkflow(searchWorkflow(), { endpoint: 'http://b/mcp', http: browser.http, resolve });
    expect(run.outcome).toBe('HANDOFF');
    expect(run.boundary).toBe('AUTHENTICATION');
    expect(run.steps.map((s) => s.kind)).toEqual(['navigate']);
  });

  it('a page that leaves the host is refused, whatever it rendered', async () => {
    const browser = fakeBrowser({ 'https://elsewhere.example/': SEARCH_PAGE }, { redirect: { [`https://${HOST}/records`]: 'https://elsewhere.example/' } });
    const run = await runBrowserWorkflow(searchWorkflow(), { endpoint: 'http://b/mcp', http: browser.http, resolve });
    expect(run.outcome).toBe('REFUSED');
    expect(run.detail).toMatch(/left portal\.example/);
  });

  it('without a signed-in session server an account workflow is unavailable, not attempted', async () => {
    const run = await runBrowserWorkflow(searchWorkflow(), { endpoint: null, resolve });
    expect(run.outcome).toBe('UNAVAILABLE');
    expect(run.detail).toMatch(/BRAIN_BROWSER_SESSION_MCP_URL/);
  });

  it('surveys an interface into addressable locators for a model-assisted draft, and stops at a boundary', async () => {
    const browser = fakeBrowser({ [`https://${HOST}/records`]: SEARCH_PAGE, [`https://${HOST}/login`]: LOGIN_PAGE });
    const survey = await surveyInterface(`https://${HOST}/records`, HOST, { endpoint: 'http://b/mcp', http: browser.http, resolve });
    expect(survey.ok).toBe(true);
    const s = survey.survey as { fields: { label: string | null }[]; buttons: { name: string }[]; links: { name: string }[] };
    expect(s.fields.map((f) => f.label)).toEqual(['search records', 'region']);
    expect(s.buttons.map((b) => b.name)).toContain('search');
    expect(s.links.map((l) => l.name)).toContain('export csv');
    const wall = await surveyInterface(`https://${HOST}/login`, HOST, { endpoint: 'http://b/mcp', http: browser.http, resolve });
    expect(wall).toMatchObject({ ok: false, boundary: 'AUTHENTICATION' });
  });
});

describe('workflow reliability is read from run rows (pure)', () => {
  const AT = '2026-11-09T00:00:00.000Z';
  const def = (w: BrowserWorkflow, at = AT) => ({ measures: JSON.stringify({ host: w.host, name: w.name, workflow: w }), at });
  const run = (w: BrowserWorkflow, outcome: string, i: number, extra: Record<string, unknown> = {}) => ({
    measures: JSON.stringify({ host: w.host, name: w.name, definedAt: AT, ...extra }),
    outcome,
    at: `2026-11-10T00:00:0${i}.000Z`,
  });
  const only = (m: Map<string, WorkflowRecord>) => [...m.values()][0]!;

  it(`a model-assisted draft becomes a tested script after ${SCRIPT_CONVERSION_RUNS} consecutive completed runs`, () => {
    const w = searchWorkflow({ origin: 'MODEL_ASSISTED' });
    const two = Array.from({ length: SCRIPT_CONVERSION_RUNS - 1 }, (_, i) => run(w, 'COMPLETED', i + 1));
    expect(only(workflowsFrom([def(w)], two)).status).toBe('DRAFT');
    const enough = Array.from({ length: SCRIPT_CONVERSION_RUNS }, (_, i) => run(w, 'COMPLETED', i + 1));
    expect(only(workflowsFrom([def(w)], enough)).status).toBe('SCRIPT');
  });

  it('a workflow that fails more than it works is retired; a handoff is not counted as a failure', () => {
    const w = searchWorkflow();
    const failing = Array.from({ length: ROUTINE_RETIRE_FAILURES }, (_, i) => run(w, 'FAILED', i + 1, { interfaceChanged: true }));
    const r = only(workflowsFrom([def(w)], failing));
    expect(r.status).toBe('RETIRED');
    expect(r.interfaceChanged).toBe(true);
    const handoffs = Array.from({ length: 4 }, (_, i) => run(w, 'HANDOFF', i + 1));
    expect(only(workflowsFrom([def(w)], [...handoffs, run(w, 'COMPLETED', 6)])).status).toBe('SCRIPT');
  });

  it('a newer definition starts its reliability afresh', () => {
    const w = searchWorkflow();
    const failing = Array.from({ length: ROUTINE_RETIRE_FAILURES }, (_, i) => run(w, 'FAILED', i + 1));
    expect(only(workflowsFrom([def(w), def(w, '2026-11-11T00:00:00.000Z')], failing)).status).toBe('DRAFT');
  });
});

describe('operateWorkflow on the database: judged, permitted, run and recorded', () => {
  it('runs only under a person’s standing grant, records every run, and a revocation stops the next one', async () => {
    await freshProject();
    await recordBrowserWorkflow(searchWorkflow(), 'test-owner');
    const browser = fakeBrowser({ [`https://${HOST}/records`]: SEARCH_PAGE }, { downloads: { [`https://${HOST}/export.csv`]: 'a,b\n' } });
    const options = { endpoint: 'http://b/mcp', http: browser.http, resolve };

    const before = await operateWorkflow(HOST, 'export west records', { options });
    expect(before.run.outcome).toBe('HANDOFF');
    expect(browser.calls).toHaveLength(0);

    await recordOperatePermission({ host: HOST, granted: true, accountRef: 'records team login', grantedBy: 'test-owner' });
    const granted = await operateWorkflow(HOST, 'export west records', { options });
    expect(granted.judgment?.route).toBe('BROWSER');
    expect(granted.run.outcome).toBe('COMPLETED');
    expect(granted.run.downloads[0]?.text).toBe('a,b\n');

    await recordOperatePermission({ host: HOST, granted: false, grantedBy: 'test-owner' });
    const revoked = await operateWorkflow(HOST, 'export west records', { options });
    expect(revoked.run.outcome).toBe('HANDOFF');

    const rows = await getDb().all<{ outcome: string; measures: string }>(`SELECT outcome, measures FROM bin_events WHERE event_type = ? ORDER BY at`, [BROWSER_WORKFLOW_RUN_EVENT]);
    expect(rows.map((r) => r.outcome)).toEqual(['HANDOFF', 'COMPLETED', 'HANDOFF']);
    const completed = JSON.parse(rows[1]!.measures) as { downloads: { chars: number }[]; extracted: { name: string }[] };
    expect(completed.downloads[0]!.chars).toBe(4);
    expect(completed.extracted[0]!.name).toBe('results');
    const judged = await getDb().all<{ outcome: string; measures: string }>(`SELECT outcome, measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = 'browser-workflow' ORDER BY at`);
    expect(judged).toHaveLength(3);
    // The account is named on exactly the judgment whose run went through the signed-in session under it.
    const accounts = judged.map((r) => JSON.parse(r.measures) as { authorizedAccount: string; accountRef: string | null });
    expect(accounts.map((a) => [a.authorizedAccount, a.accountRef])).toEqual([
      ['NONE', null],
      ['PERMISSION_RECORD', 'records team login'],
      ['NONE', null],
    ]);
    expect((await readBrowserWorkflows(HOST)).size).toBe(1);
  });

  it('a public interactive workflow needs no account grant, and an unknown workflow is refused', async () => {
    await freshProject();
    const w = searchWorkflow({ name: 'public search', account: false, steps: searchWorkflow().steps.slice(0, 5) });
    await recordBrowserWorkflow(w, 'test-owner');
    const browser = fakeBrowser({ [`https://${HOST}/records`]: SEARCH_PAGE });
    const done = await operateWorkflow(HOST, 'public search', { options: { endpoint: 'http://b/mcp', http: browser.http, resolve } });
    expect(done.run.outcome).toBe('COMPLETED');
    expect((await operateWorkflow(HOST, 'nothing recorded')).run.outcome).toBe('REFUSED');
  });

  it('refuses to record a workflow that is not bounded and checked', async () => {
    await freshProject();
    await expect(recordBrowserWorkflow(searchWorkflow({ steps: searchWorkflow().steps.filter((s) => s.kind !== 'expect') }), 'x')).rejects.toThrow(/explicit success check/);
  });
});
