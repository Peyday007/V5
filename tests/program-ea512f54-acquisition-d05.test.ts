/**
 * ACQ-21-1 / ACQ-21-2, browser class: operating a site's interface as a
 * bounded, reusable workflow — navigation, search, filtering, form entry and
 * download handling over readable locators with explicit success checks, under
 * the account a person granted or none, stopping at a genuine access boundary.
 *
 * The browser here is a fake Playwright MCP server backed by jsdom, so the
 * in-page step functions the executor sends are really run against a DOM.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  readsAddress,
  runBrowserWorkflow,
  validateWorkflow,
  workflowAsRead,
  workflowsFromRows,
  type BrowserWorkflow,
} from '../server/services/sources/browserWorkflow.ts';
import { runBrowserWorkflowCommand } from '../server/services/sources/browserWorkflowCli.ts';
import { activeRoutine, routinesFrom } from '../server/services/sources/routines.ts';
import { operateEvidenceOfRead, readSource, type AccessDeps } from '../server/services/sources/access.ts';
import type { Resolver, SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import type { OperatePermission } from '../server/services/sources/acquisition.ts';

const resolve: Resolver = async (host) => (host === 'internal.example' ? ['10.0.0.9'] : ['93.184.216.34']);

const SEARCH_PAGE = `<!doctype html><html><body>
  <h1>Records</h1>
  <label for="q">Search</label><input id="q" type="search">
  <label for="region">Region</label><select id="region"><option value="">Any</option><option value="w">West</option><option value="e">East</option></select>
  <button id="go">Search</button>
  <div id="out"></div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const q = document.getElementById('q').value; const r = document.getElementById('region').value;
      document.getElementById('out').innerHTML = '<p>3 results for ' + q + ' in ' + r + '</p>' +
        '<ul><li class="result">Acme Ltd</li><li class="result">Beta LLC</li><li class="result">Gamma Inc</li></ul>' +
        '<a href="/export.csv?q=' + encodeURIComponent(q) + '">Export CSV</a>';
    });
  </script>
</body></html>`;

/** A fake Playwright MCP server: navigate builds a jsdom page, evaluate runs the sent function in it. */
function fakeBrowser(pages: Record<string, string>, files: Record<string, string> = {}) {
  let dom: JSDOM | null = null;
  const calls: string[] = [];
  const http = async (_url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const headers = { 'content-type': 'application/json', 'mcp-session-id': 's1' };
    if (body.id === undefined) return new Response(null, { status: 202, headers });
    const reply = (text: string, isError = false) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }), { status: 200, headers });
    if (body.method !== 'tools/call') return reply('ok');
    const name = body.params!.name!;
    const args = body.params!.arguments ?? {};
    calls.push(name);
    if (name === 'browser_navigate') {
      const url = String(args.url);
      const html = pages[url];
      if (html === undefined) return reply('net::ERR_NAME_NOT_RESOLVED', true);
      dom = new JSDOM(html, { url, runScripts: 'dangerously' });
      const w = dom.window as unknown as Record<string, any>;
      Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
      w.Element.prototype.getClientRects = function () { return [{}]; };
      w.CSS = { escape: (s: string) => s };
      w.fetch = async (href: string) => {
        const path = new URL(href).pathname;
        const text = files[path];
        return { ok: text !== undefined, status: text !== undefined ? 200 : 404, headers: { get: () => 'text/csv' }, text: async () => text ?? '' };
      };
      return reply('navigated');
    }
    if (name === 'browser_wait_for') {
      const text = String(args.text ?? '');
      return dom && dom.window.document.body.textContent!.includes(text) ? reply('found') : reply('timed out', true);
    }
    if (name === 'browser_evaluate') {
      const value = await (dom!.window as unknown as { eval: (s: string) => unknown }).eval(`(${String(args.function)})()`);
      return reply(`### Result\n${JSON.stringify(value)}\n### Ran Playwright code`);
    }
    return reply('unknown tool', true);
  };
  return { http, calls };
}

const searchWorkflow = (over: Partial<BrowserWorkflow> = {}): unknown => ({
  host: 'records.example',
  name: 'search-and-export',
  session: 'PUBLIC',
  steps: [
    { kind: 'navigate', url: 'https://records.example/search' },
    { kind: 'fill', locator: { label: 'Search' }, param: 'query' },
    { kind: 'select', locator: { label: 'Region' }, param: 'region' },
    { kind: 'click', locator: { role: 'button', name: 'Search' } },
    { kind: 'expect', text: '3 results' },
    { kind: 'extract', locator: { css: '.result' } },
    { kind: 'download', locator: { text: 'Export CSV' } },
  ],
  ...over,
});

const pages = { 'https://records.example/search': SEARCH_PAGE };
const files = { '/export.csv': 'name,region\nAcme Ltd,West\nBeta LLC,West\nGamma Inc,West\n' };

describe('a workflow is steps over readable locators, with an explicit success check', () => {
  it('refuses what a reusable routine must never be', () => {
    expect(() => validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://records.example/' }] }))).toThrow(/success check/);
    expect(() => validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://elsewhere.example/' }, { kind: 'expect', text: 'x' }] }))).toThrow(/never leaves/);
    expect(() =>
      validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://records.example/' }, { kind: 'fill', locator: { label: 'Password' }, param: 'q' }, { kind: 'expect', text: 'x' }] })),
    ).toThrow(/credential field/);
    expect(() =>
      validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://records.example/' }, { kind: 'fill', locator: { css: 'input[type=password]' }, param: 'q' }, { kind: 'expect', text: 'x' }] })),
    ).toThrow(/credential field/);
    expect(() =>
      validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://records.example/' }, { kind: 'fill', locator: { label: 'Name' }, param: 'apiKey' }, { kind: 'expect', text: 'x' }] })),
    ).toThrow(/credential/);
    const tooMany = Array.from({ length: 31 }, () => ({ kind: 'expect', text: 'x' }));
    expect(() => validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://records.example/' }, ...tooMany] as never }))).toThrow(/at most/);
    expect(validateWorkflow(searchWorkflow()).steps).toHaveLength(7);
  });
});

describe('running a workflow through the browser', () => {
  it('searches, filters, fills, checks success, extracts and downloads — and records the run without parameter values', async () => {
    const browser = fakeBrowser(pages, files);
    const rows: Record<string, unknown>[] = [];
    const run = await runBrowserWorkflow(validateWorkflow(searchWorkflow()), { query: 'acme', region: 'West' }, {
      endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => true,
      record: (async (row: Record<string, unknown>) => { rows.push(row); }) as never,
    });
    expect(run.reason).toMatch(/success check/);
    expect(run.outcome).toBe('SUCCEEDED');
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.extracted[0]).toBe('Acme Ltd\nBeta LLC\nGamma Inc');
    expect(run.downloads[0]).toMatchObject({ url: 'https://records.example/export.csv?q=acme', chars: files['/export.csv']!.length });
    expect(browser.calls.filter((c) => c === 'browser_navigate')).toHaveLength(1);
    expect(rows).toHaveLength(1);
    const measures = rows[0]!.measures as { params: string[]; steps: unknown[] };
    expect(rows[0]).toMatchObject({ eventType: 'BROWSER_WORKFLOW_RUN', outcome: 'SUCCEEDED' });
    expect(measures.params).toEqual(['query', 'region']);
    expect(JSON.stringify(rows[0])).not.toContain('acme');
  });

  it('fails on a success check that does not hold instead of calling a run a success', async () => {
    const browser = fakeBrowser(pages, files);
    const wf = validateWorkflow(searchWorkflow({ steps: [{ kind: 'navigate', url: 'https://records.example/search' }, { kind: 'expect', text: 'Order confirmed' }] }));
    const run = await runBrowserWorkflow(wf, {}, { endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => true, record: null });
    expect(run.outcome).toBe('FAILED');
    expect(run.reason).toMatch(/does not show "Order confirmed"/);
  });

  it('refuses an ambiguous locator rather than clicking the first match', async () => {
    const two = '<html><body><button>Go</button><button>Go</button></body></html>';
    const browser = fakeBrowser({ 'https://records.example/two': two });
    const wf = validateWorkflow({ host: 'records.example', name: 'two', steps: [{ kind: 'navigate', url: 'https://records.example/two' }, { kind: 'click', locator: { role: 'button', name: 'Go' } }, { kind: 'expect', text: 'Go' }] });
    const run = await runBrowserWorkflow(wf, {}, { endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => true, record: null });
    expect(run.outcome).toBe('FAILED');
    expect(run.reason).toMatch(/ambiguous/);
  });

  it('stops at a sign-in wall or a CAPTCHA and hands off; it never tries to get past either', async () => {
    const wall = '<html><body><form><input type="text" name="user"><input type="password" name="pw"><button>Sign in</button></form></body></html>';
    const captcha = '<html><body><p>Please verify you are human</p><div class="g-recaptcha"></div></body></html>';
    const browser = fakeBrowser({ 'https://records.example/app': wall, 'https://records.example/bot': captcha });
    const at = (url: string) => validateWorkflow({ host: 'records.example', name: 'n', steps: [{ kind: 'navigate', url }, { kind: 'expect', text: 'Dashboard' }] });
    const opts = { endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => true, record: null };
    const signIn = await runBrowserWorkflow(at('https://records.example/app'), {}, opts);
    expect(signIn).toMatchObject({ outcome: 'HUMAN_HANDOFF' });
    expect(signIn.reason).toMatch(/sign-in/);
    const bot = await runBrowserWorkflow(at('https://records.example/bot'), {}, opts);
    expect(bot).toMatchObject({ outcome: 'HUMAN_HANDOFF' });
    expect(bot.reason).toMatch(/CAPTCHA/);
  });

  it('honours robots.txt and refuses an address that is not public', async () => {
    const browser = fakeBrowser(pages, files);
    const wf = validateWorkflow(searchWorkflow());
    const robots = await runBrowserWorkflow(wf, { query: 'a', region: 'West' }, { endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => false, record: null });
    expect(robots).toMatchObject({ outcome: 'REFUSED' });
    expect(robots.reason).toMatch(/robots/);
    const internal = validateWorkflow({ host: 'internal.example', name: 'i', steps: [{ kind: 'navigate', url: 'https://internal.example/' }, { kind: 'expect', text: 'x' }] });
    const refused = await runBrowserWorkflow(internal, {}, { endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => true, record: null });
    expect(refused).toMatchObject({ outcome: 'REFUSED' });
    expect(browser.calls).not.toContain('browser_navigate');
  });
});

describe('operating under the legitimate account a person granted', () => {
  const account = (host: string): unknown => ({ ...(searchWorkflow() as object), host, session: 'ACCOUNT' });
  const granted = async (): Promise<OperatePermission> => ({ permitted: true, accountRef: 'operations login', grantedBy: 'owner', at: '2026-11-10T00:00:00Z' });
  const none = async (): Promise<OperatePermission> => ({ permitted: false, accountRef: null, grantedBy: null, at: null });

  it('refuses without a standing grant, and without the account browser that holds the session', async () => {
    const browser = fakeBrowser(pages, files);
    const wf = validateWorkflow(account('records.example'));
    const noGrant = await runBrowserWorkflow(wf, { query: 'a', region: 'West' }, { accountEndpoint: 'http://account-browser/mcp', http: browser.http, resolve, permission: none, record: null });
    expect(noGrant).toMatchObject({ outcome: 'REFUSED' });
    expect(noGrant.reason).toMatch(/NO_AUTHORIZED_ACCOUNT/);
    const noBrowser = await runBrowserWorkflow(wf, { query: 'a', region: 'West' }, { accountEndpoint: null, http: browser.http, resolve, permission: granted, record: null });
    expect(noBrowser.reason).toMatch(/no account browser/);
    expect(browser.calls).toHaveLength(0);
  });

  it('runs on the account browser under the grant, naming the account by reference only', async () => {
    const browser = fakeBrowser(pages, files);
    const rows: Record<string, unknown>[] = [];
    const run = await runBrowserWorkflow(validateWorkflow(account('records.example')), { query: 'acme', region: 'East' }, {
      endpoint: 'http://public-browser/mcp', accountEndpoint: 'http://account-browser/mcp', http: browser.http, resolve, robotsAllow: async () => true,
      permission: granted, record: (async (row: Record<string, unknown>) => { rows.push(row); }) as never,
    });
    expect(run).toMatchObject({ outcome: 'SUCCEEDED', session: 'ACCOUNT', accountRef: 'operations login' });
    expect(rows[0]).toMatchObject({ provider: 'BROWSER_ACCOUNT', measures: expect.objectContaining({ accountRef: 'operations login' }) });
  });
});

describe('a recorded workflow is the routine the read path runs', () => {
  const readWorkflow = {
    host: 'records.example', name: 'read-record', session: 'ACCOUNT',
    steps: [{ kind: 'navigate', url: '$url' }, { kind: 'expect', locator: { css: '.result' } }, { kind: 'extract', locator: { css: '.result' } }],
  };

  it('builds a browser routine from the recorded row, newest version deciding', () => {
    const rows = [
      { measures: JSON.stringify({ workflow: { ...readWorkflow, steps: [{ kind: 'navigate', url: '$url' }, { kind: 'expect', text: 'old' }] } }), at: '2026-11-01T00:00:00Z' },
      { measures: JSON.stringify({ workflow: readWorkflow }), at: '2026-11-05T00:00:00Z' },
      { measures: JSON.stringify({ workflow: { host: 'x.example' } }), at: '2026-11-06T00:00:00Z' },
    ];
    const recorded = workflowsFromRows(rows);
    expect(recorded.get('records.example')).toHaveLength(1);
    expect(readsAddress(recorded.get('records.example')![0]!.workflow)).toBe(true);
    const routine = routinesFrom([], [], recorded).get('records.example')!;
    expect(routine).toMatchObject({ lead: 'BROWSER', kind: 'SCRIPT', retired: false });
    expect(routine.workflow?.name).toBe('read-record');
    expect(activeRoutine(routine)).toMatchObject({ lead: 'BROWSER', workflow: { name: 'read-record', session: 'ACCOUNT' } });
  });

  it('runs the workflow on the address read, and a worked ACCOUNT read puts the account on record', async () => {
    const routine = routinesFrom([], [], workflowsFromRows([{ measures: JSON.stringify({ workflow: readWorkflow }), at: '2026-11-05T00:00:00Z' }])).get('records.example')!;
    const ran: string[] = [];
    const browser = fakeBrowser({ 'https://records.example/r/7': '<html><body><ul><li class="result">Acme Ltd — filed 2026-10-01, revenue 4,100,000</li></ul></body></html>' });
    const deps: AccessDeps = {
      resolve, robotsAllow: async () => true, learned: async () => null, record: async () => undefined,
      archive: async () => null, sitemap: async () => null, browser: null,
      direct: async (u: string): Promise<SourceFetch> => ({ readable: false, requestedUrl: u, finalUrl: u, status: 403, retrievedAt: 'now', reason: 'HTTP_ERROR', detail: '403' }),
      routine: async () => routine,
      workflow: async (wf, u) => {
        ran.push(wf.name);
        return workflowAsRead(
          await runBrowserWorkflow(wf, { url: u }, { accountEndpoint: 'http://account-browser/mcp', http: browser.http, resolve, robotsAllow: async () => true, permission: async () => ({ permitted: true, accountRef: 'ops', grantedBy: 'owner', at: null }), record: null }),
          u,
        );
      },
    };
    const read = await readSource('https://records.example/r/7', deps);
    expect(ran).toEqual(['read-record']);
    expect(read).toMatchObject({ readable: true, method: 'BROWSER', routine: { workflow: { name: 'read-record', session: 'ACCOUNT' } } });
    expect(read.readable && read.text).toContain('revenue 4,100,000');
    expect(operateEvidenceOfRead(read, null, {})).toMatchObject({ authorizedAccountOnRecord: true });
    // A plain render asserts no account.
    expect(operateEvidenceOfRead({ attempts: read.attempts }, null, {})).toMatchObject({ authorizedAccountOnRecord: false });
  });
});

describe('the workflow terminal', () => {
  it('records once and runs by name, without printing parameter values', async () => {
    const stored: unknown[] = [];
    const record = (async (raw: unknown) => { stored.push(raw); return validateWorkflow(raw); }) as never;
    const recorded = await runBrowserWorkflowCommand(['record', '--file', 'w.json', '--by', 'owner'], { readFile: async () => JSON.stringify(searchWorkflow()), record });
    expect(recorded).toMatchObject({ code: 0 });
    expect(recorded.out).toMatch(/parameters: query, region/);
    const workflows = async () => workflowsFromRows([{ measures: JSON.stringify({ workflow: stored[0] }), at: '2026-11-10T00:00:00Z' }]);
    expect((await runBrowserWorkflowCommand(['show', '--host', 'records.example'], { workflows })).out).toMatch(/search-and-export/);
    const browser = fakeBrowser(pages, files);
    const ran = await runBrowserWorkflowCommand(['run', '--host', 'records.example', '--name', 'search-and-export', '--param', 'query=acme', '--param', 'region=West'], {
      workflows, runDeps: { endpoint: 'http://browser/mcp', http: browser.http, resolve, robotsAllow: async () => true, record: null },
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toMatch(/SUCCEEDED/);
    expect(ran.out).toMatch(/downloaded/);
    expect(ran.out).not.toContain('acme');
    const bad = await runBrowserWorkflowCommand(['record', '--file', 'w.json', '--by', 'owner'], { readFile: async () => JSON.stringify({ host: 'a.example', name: 'n', steps: [{ kind: 'navigate', url: 'https://a.example/' }] }), record });
    expect(bad).toMatchObject({ code: 1 });
  });
});
