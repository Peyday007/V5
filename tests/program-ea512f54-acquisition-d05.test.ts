import { describe, expect, it } from 'vitest';
import {
  BROWSER_WORKFLOW_RUN_EVENT,
  mcpDriver,
  runAndRecordWorkflow,
  runBrowserWorkflow,
  validateWorkflow,
  workflowsFrom,
  WORKFLOW_RETIRE_FAILURES,
  type BrowserWorkflow,
  type PageDriver,
} from '../server/services/sources/browserWorkflow.ts';
import { pageActionSource, type Locator, type PageAction, type PageActionResult } from '../server/services/sources/pageActions.ts';
import { operateEvidenceOfRead, readSource, type SourceRead } from '../server/services/sources/access.ts';
import { SCRIPT_CONVERSION_RUNS } from '../server/services/sources/accessMethods.ts';
import type { OperatePermission } from '../server/services/sources/acquisition.ts';
import type { RecordBinEventInput } from '../server/repos/bins.ts';

const HOST = 'records.example';
const SECRET = 'correct-horse-battery-staple-91';
const publicResolver = async () => ['93.184.216.34'];
const granted = async (): Promise<OperatePermission> => ({ permitted: true, accountRef: 'research login', grantedBy: 'owner', at: '2026-11-01T00:00:00.000Z' });
const notGranted = async (): Promise<OperatePermission> => ({ permitted: false, accountRef: null, grantedBy: null, at: null });

/** An owner-shaped workflow: sign in once, search, filter, check success, extract the results and download the export. */
const searchWorkflow: BrowserWorkflow = {
  host: HOST,
  name: 'search filings',
  purpose: 'OPERATE',
  params: ['query', 'username'],
  signsIn: true,
  steps: [
    { op: 'navigate', url: `https://${HOST}/login` },
    { op: 'fill', locator: { label: 'Username' }, param: 'username' },
    { op: 'fill', locator: { label: 'Password' }, secretEnv: 'BRAIN_OPERATE_RECORDS_PASSWORD' },
    { op: 'click', locator: { role: 'button', name: 'Sign in' } },
    { op: 'expect', text: 'Signed in' },
    { op: 'navigate', url: `https://${HOST}/search?q={{query}}` },
    { op: 'select', locator: { label: 'Year' }, value: '2025' },
    { op: 'check', locator: { label: 'Only active' } },
    { op: 'click', locator: { role: 'button', name: 'Search' } },
    { op: 'waitFor', locator: { css: '#results' }, seconds: 3 },
    { op: 'expect', locator: { css: '#results' } },
    { op: 'extract', locator: { css: '#results' }, as: 'results' },
    { op: 'download', locator: { text: 'Export CSV' }, as: 'export' },
  ],
};

interface FakePage {
  url: string;
  title: string;
  text: string;
  password?: boolean;
  elements: Record<string, { text?: string; href?: string }>;
}

/** A scripted site: pages keyed by path, locators keyed by their JSON. Records every action it receives. */
function fakeSite(opts: { pages?: Record<string, FakePage>; onClick?: Record<string, string>; missing?: string[] } = {}) {
  const key = (l: Locator) => JSON.stringify(l);
  const pages: Record<string, FakePage> = opts.pages ?? {
    '/login': { url: `https://${HOST}/login`, title: 'Sign in', text: 'Sign in', password: true, elements: { [key({ label: 'Username' })]: {}, [key({ label: 'Password' })]: {}, [key({ role: 'button', name: 'Sign in' })]: {} } },
    '/home': { url: `https://${HOST}/home`, title: 'Home', text: 'Signed in as research', elements: {} },
    '/search': {
      url: `https://${HOST}/search`,
      title: 'Search',
      text: 'Search',
      elements: { [key({ label: 'Year' })]: {}, [key({ label: 'Only active' })]: {}, [key({ role: 'button', name: 'Search' })]: {} },
    },
    '/results': {
      url: `https://${HOST}/results`,
      title: 'Results',
      text: 'Results: 3 filings',
      elements: { [key({ css: '#results' })]: { text: 'Acme 2025 annual filing\nBeta 2025 annual filing' }, [key({ text: 'Export CSV' })]: { href: `https://${HOST}/export.csv` } },
    },
  };
  const onClick = opts.onClick ?? { [key({ role: 'button', name: 'Sign in' })]: '/home', [key({ role: 'button', name: 'Search' })]: '/results' };
  let page: FakePage = { url: 'about:blank', title: '', text: '', elements: {} };
  const actions: PageAction[] = [];
  const navigations: string[] = [];
  let closed = false;
  const base = () => ({ url: page.url, title: page.title });
  const has = (l: Locator) => !(opts.missing ?? []).includes(key(l)) && key(l) in page.elements;
  const driver: PageDriver = {
    async navigate(url) {
      navigations.push(url);
      const path = new URL(url).pathname;
      page = pages[path] ?? { url, title: 'Not found', text: 'Not found', elements: {} };
      page = { ...page, url };
      return { ok: true };
    },
    async act(a): Promise<PageActionResult> {
      actions.push(a);
      switch (a.op) {
        case 'state':
          return { ...base(), ok: true, text: page.text, passwordField: Boolean(page.password) };
        case 'outline':
          return { ...base(), ok: true, elements: Object.keys(page.elements).map((k) => ({ tag: 'button', role: 'button', name: k, type: null, id: null })) };
        case 'present':
          return a.locator ? { ...base(), ok: has(a.locator), ...(has(a.locator) ? {} : { miss: 'NOT_FOUND' as const }) } : { ...base(), ok: page.text.includes(a.text ?? '') };
        case 'extract': {
          const text = a.locator ? page.elements[key(a.locator)]?.text : page.text;
          return text ? { ...base(), ok: true, text, totalChars: text.length } : { ...base(), ok: false, miss: 'NOT_FOUND' };
        }
        case 'download':
          return a.locator && has(a.locator) ? { ...base(), ok: true, href: page.elements[key(a.locator)]!.href!, contentType: 'text/csv', text: 'name,year\nAcme,2025\n', totalChars: 20 } : { ...base(), ok: false, miss: 'NOT_FOUND' };
        default: {
          if (!has(a.locator)) return { ...base(), ok: false, miss: 'NOT_FOUND', detail: 'no element matches the locator' };
          if (a.op === 'click' && onClick[key(a.locator)]) {
            const next = onClick[key(a.locator)]!;
            page = next.startsWith('http') ? { url: next, title: 'Elsewhere', text: 'elsewhere', elements: {} } : { ...pages[next]! };
          }
          return { ...base(), ok: true };
        }
      }
    },
    async wait() {},
    async close() {
      closed = true;
    },
  };
  return { driver, actions, navigations, closed: () => closed };
}

const env = { BRAIN_OPERATE_RECORDS_PASSWORD: SECRET };
const deps = (site: ReturnType<typeof fakeSite>, permission = granted) => ({ driver: () => site.driver, permission, resolve: publicResolver, env });

describe('a recorded workflow operates the interface under the granted account (ACQ-21-1, ACQ-21-2 browser class)', () => {
  it('signs in once, searches, filters, enters a form, checks success, extracts and downloads — without a person', async () => {
    const site = fakeSite();
    const run = await runBrowserWorkflow(searchWorkflow, { query: 'annual filing', username: 'research' }, deps(site));
    expect(run.outcome).toBe('OK');
    expect(run.accountRef).toBe('research login');
    expect(run.steps.map((s) => s.outcome)).toEqual(searchWorkflow.steps.map(() => 'OK'));
    expect(run.outputs['results']?.text).toContain('Acme 2025 annual filing');
    expect(run.outputs['export']).toMatchObject({ url: `https://${HOST}/export.csv`, contentType: 'text/csv' });
    expect(site.navigations).toEqual([`https://${HOST}/login`, `https://${HOST}/search?q=annual%20filing`]);
    // The secret reached the form and nothing else: not the steps, not the result.
    expect(site.actions.some((a) => a.op === 'fill' && a.value === SECRET)).toBe(true);
    expect(JSON.stringify(run)).not.toContain(SECRET);
    expect(site.closed()).toBe(true);
  });

  it('does not operate a host nobody granted, and names the command that grants it', async () => {
    const site = fakeSite();
    const run = await runBrowserWorkflow(searchWorkflow, { query: 'x', username: 'r' }, deps(site, notGranted));
    expect(run).toMatchObject({ outcome: 'BOUNDARY', boundary: 'NO_AUTHORIZED_ACCOUNT' });
    expect(run.handoff).toContain('operatePermissionCli.ts grant');
    expect(site.navigations).toEqual([]);
  });

  it('stops at a missing deployment secret instead of guessing a login', async () => {
    const site = fakeSite();
    const run = await runBrowserWorkflow(searchWorkflow, { query: 'x', username: 'r' }, { ...deps(site), env: {} });
    expect(run).toMatchObject({ outcome: 'BOUNDARY', boundary: 'AUTHENTICATION' });
    expect(run.handoff).toContain('BRAIN_OPERATE_RECORDS_PASSWORD');
  });

  it('stops at a challenge page, a sign-in it did not expect, or a redirect off the host — never works around them', async () => {
    const challenged = fakeSite({ pages: { '/login': { url: '', title: 'Just a moment...', text: 'Checking your browser', elements: {} } } });
    expect(await runBrowserWorkflow(searchWorkflow, { query: 'x', username: 'r' }, deps(challenged))).toMatchObject({ outcome: 'BOUNDARY', boundary: 'CAPTCHA' });

    const readOnly: BrowserWorkflow = { host: HOST, name: 'read', purpose: 'OPERATE', steps: [{ op: 'navigate', url: `https://${HOST}/login` }, { op: 'expect', text: 'Sign in' }] };
    expect(await runBrowserWorkflow(readOnly, {}, deps(fakeSite()))).toMatchObject({ outcome: 'BOUNDARY', boundary: 'AUTHENTICATION' });

    const key = JSON.stringify({ role: 'button', name: 'Sign in' });
    const away = fakeSite({ onClick: { [key]: 'https://elsewhere.example/landing' } });
    expect(await runBrowserWorkflow(searchWorkflow, { query: 'x', username: 'r' }, deps(away))).toMatchObject({ outcome: 'BOUNDARY', boundary: 'OFF_HOST' });
  });

  it('a locator that no longer fits fails the run, says the interface changed, and keeps an outline for the model-assisted repair', async () => {
    const site = fakeSite({ missing: [JSON.stringify({ role: 'button', name: 'Search' })] });
    const run = await runBrowserWorkflow(searchWorkflow, { query: 'x', username: 'r' }, deps(site));
    expect(run.outcome).toBe('FAILED');
    expect(run.interfaceChanged).toBe(true);
    expect(run.outline?.length).toBeGreaterThan(0);
    expect(run.steps.find((s) => s.outcome === 'FAILED')).toMatchObject({ op: 'click', miss: 'NOT_FOUND' });
    expect(run.steps.filter((s) => s.outcome === 'SKIPPED').length).toBeGreaterThan(0);
  });
});

describe('a workflow run is recorded, and its judgment separates the deterministic routine from model-assisted repair', () => {
  const status = { workflow: searchWorkflow, definedAt: '2026-11-09T00:00:00.000Z', runs: 3, ok: 3 };

  it('records the run without values and the OPERATE judgment under the granted account', async () => {
    const events: RecordBinEventInput[] = [];
    const record = async (e: RecordBinEventInput) => void events.push(e);
    await runAndRecordWorkflow(status, { query: 'x', username: 'r' }, { ...deps(fakeSite()), record });
    const run = events.find((e) => e.eventType === BROWSER_WORKFLOW_RUN_EVENT)!;
    expect(run.outcome).toBe('OK');
    expect(run.measures).toMatchObject({ host: HOST, name: 'search filings', definedAt: status.definedAt, accountRef: 'research login' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(run.measures)).not.toContain('Acme 2025 annual filing');
    const judgment = events.find((e) => e.eventType === 'ACQUISITION_JUDGMENT')!;
    expect(judgment.measures).toMatchObject({ capability: 'OPERATE', route: 'BROWSER', authorizedAccount: 'CALLER' });
  });

  it('a changed interface makes the judgment MODEL_ASSISTED, not the same deterministic render', async () => {
    const events: RecordBinEventInput[] = [];
    const record = async (e: RecordBinEventInput) => void events.push(e);
    const site = fakeSite({ missing: [JSON.stringify({ css: '#results' })] });
    await runAndRecordWorkflow(status, { query: 'x', username: 'r' }, { ...deps(site), record });
    expect(events.find((e) => e.eventType === BROWSER_WORKFLOW_RUN_EVENT)).toMatchObject({ outcome: 'FAILED', provider: 'MODEL_ASSISTED' });
    expect(events.find((e) => e.eventType === 'ACQUISITION_JUDGMENT')!.measures).toMatchObject({ route: 'MODEL_ASSISTED' });
  });
});

describe('a definition is refused when it would be unsafe or unreliable (pure)', () => {
  const base: BrowserWorkflow = { host: HOST, name: 'w', purpose: 'OPERATE', steps: [{ op: 'navigate', url: `https://${HOST}/` }, { op: 'expect', text: 'ok' }] };
  const errs = (w: Partial<BrowserWorkflow>) => validateWorkflow({ ...base, ...w });

  it('accepts the owner-shaped workflow', () => {
    expect(validateWorkflow(searchWorkflow)).toEqual([]);
    expect(errs({})).toEqual([]);
  });

  it('requires an explicit success check', () => {
    expect(errs({ steps: [{ op: 'navigate', url: `https://${HOST}/` }] }).join()).toMatch(/success check/);
  });

  it('refuses a literal credential and any secret that is not a BRAIN_OPERATE_* deployment secret', () => {
    expect(errs({ signsIn: true, steps: [...base.steps, { op: 'fill', locator: { label: 'Password' }, value: 'hunter2hunter2' }] }).join()).toMatch(/literal credential/);
    expect(errs({ signsIn: true, steps: [...base.steps, { op: 'fill', locator: { label: 'Password' }, secretEnv: 'DATABASE_URL' }] }).join()).toMatch(/BRAIN_OPERATE_/);
  });

  it('refuses contacting strangers, committing the business, targeting a defence, and leaving the host', () => {
    expect(errs({ contactsStrangers: true }).join()).toMatch(/contact strangers/);
    expect(errs({ makesBusinessCommitment: true }).join()).toMatch(/commit the business/);
    for (const name of ['Place order', 'Send message', 'Buy now', 'Accept offer']) {
      expect(errs({ steps: [...base.steps, { op: 'click', locator: { role: 'button', name } }] }).join()).toMatch(/commit the business/);
    }
    expect(errs({ steps: [...base.steps, { op: 'click', locator: { css: '.g-recaptcha' } }] }).join()).toMatch(/defence/);
    expect(errs({ steps: [{ op: 'navigate', url: 'https://other.example/' }, { op: 'expect', text: 'x' }] }).join()).toMatch(/leaves/);
  });

  it('a READ workflow takes the url and produces something to read', () => {
    expect(errs({ purpose: 'READ' }).join()).toMatch(/param "url"/);
  });
});

describe('workflow versions and reliability come from rows (pure)', () => {
  const AT = '2026-11-09T00:00:00.000Z';
  const def = (w: BrowserWorkflow, at = AT) => ({ measures: JSON.stringify(w), at });
  const ran = (outcome: string, at: string, definedAt = AT) => ({ measures: JSON.stringify({ host: HOST, name: 'search filings', definedAt, outcome }), at });

  it('retires a version that fails more than it works, and does not count boundaries as failures', () => {
    const failing = Array.from({ length: WORKFLOW_RETIRE_FAILURES }, (_, i) => ran('FAILED', `2026-11-10T0${i}:00:00.000Z`));
    const s = workflowsFrom([def(searchWorkflow)], [...failing, ran('BOUNDARY', '2026-11-10T05:00:00.000Z')]).get(`${HOST}|search filings`)!;
    expect(s).toMatchObject({ runs: WORKFLOW_RETIRE_FAILURES, ok: 0, retired: true });
  });

  it('a newer version starts its own record, and a model-assisted version that ran unchanged becomes a tested script', () => {
    const NEW = '2026-11-10T12:00:00.000Z';
    const repaired = { ...searchWorkflow, origin: 'MODEL_ASSISTED' as const };
    const runs = [ran('FAILED', '2026-11-10T01:00:00.000Z'), ...Array.from({ length: SCRIPT_CONVERSION_RUNS }, (_, i) => ran('OK', `2026-11-10T1${3 + i}:00:00.000Z`, NEW))];
    const s = workflowsFrom([def(searchWorkflow), def(repaired, NEW)], runs).get(`${HOST}|search filings`)!;
    expect(s).toMatchObject({ definedAt: NEW, runs: SCRIPT_CONVERSION_RUNS, ok: SCRIPT_CONVERSION_RUNS, scripted: true, retired: false });
  });

  it('an invalid definition row builds nothing', () => {
    expect(workflowsFrom([def({ ...searchWorkflow, steps: [] })], []).size).toBe(0);
  });
});

describe('the read path runs a granted READ workflow as its browser route', () => {
  const url = `https://${HOST}/filings/42`;
  const failDirect = async (u: string) => ({ readable: false as const, requestedUrl: u, finalUrl: u, status: 403, retrievedAt: 'now', reason: 'HTTP_ERROR' as never, detail: '403' });

  it('an operated read is BROWSER, says which workflow and account, and is OPERATE evidence under that account', async () => {
    const recorded: SourceRead[] = [];
    const text = 'Filing 42: Acme annual report. '.repeat(20);
    const read = await readSource(url, {
      direct: failDirect,
      resolve: publicResolver,
      robotsAllow: async () => true,
      browser: null,
      learned: async () => null,
      routine: async () => null,
      workflow: async (u, _h, allowed) => ((await allowed()) ? { read: { readable: true, requestedUrl: u, finalUrl: u, status: 200, contentType: 'text/html; operated', retrievedAt: 'now', sha256: 'x', text, truncated: false, totalChars: text.length }, workflow: 'read filing', accountRef: 'research login', outcome: 'OK' } : null),
      record: async (r) => void recorded.push(r),
    });
    expect(read).toMatchObject({ readable: true, method: 'BROWSER', operated: { workflow: 'read filing', accountRef: 'research login', outcome: 'OK' } });
    expect(read.attempts.map((a) => a.method)).toEqual(['BROWSER']);
    expect(operateEvidenceOfRead(read, null, {})).toMatchObject({ authorizedAccountOnRecord: true, interactiveInterfaceOnly: true });
    expect(recorded[0]?.operated?.workflow).toBe('read filing');
  });

  it('a host with no workflow is read exactly as before, with no phantom attempt and no account', async () => {
    const read = await readSource(url, {
      direct: failDirect,
      resolve: publicResolver,
      robotsAllow: async () => true,
      browser: async (u) => ({ readable: true, requestedUrl: u, finalUrl: u, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'y', text: 'Rendered public page text. '.repeat(30), truncated: false, totalChars: 810 }),
      learned: async () => null,
      routine: async () => null,
      workflow: async () => null,
      archive: async () => null,
      sitemap: async () => null,
      record: async () => undefined,
    });
    expect(read.operated).toBeUndefined();
    expect(read.attempts[0]?.method).toBe('DIRECT');
    expect(operateEvidenceOfRead(read, null, {})?.authorizedAccountOnRecord).toBe(false);
  });

  it('robots.txt still governs an operated read', async () => {
    let ran = false;
    const read = await readSource(url, {
      direct: failDirect,
      resolve: publicResolver,
      robotsAllow: async () => false,
      browser: null,
      learned: async () => null,
      routine: async () => null,
      workflow: async (_u, _h, allowed) => ((await allowed()) ? ((ran = true), null) : null),
      archive: async () => null,
      sitemap: async () => null,
      record: async () => undefined,
    });
    expect(ran).toBe(false);
    expect(read.operated).toBeUndefined();
  });
});

describe('the production driver drives Playwright MCP with the in-page actions', () => {
  it('navigates with browser_navigate and performs each action with browser_evaluate, in one session', async () => {
    const calls: { method: string; name?: string; args?: Record<string, unknown>; session: string | null }[] = [];
    const http = async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const headers = new Headers(init.headers);
      if (init.method === 'DELETE') return new Response('', { status: 200 });
      calls.push({ method: body.method ?? '', name: body.params?.name, args: body.params?.arguments, session: headers.get('mcp-session-id') });
      const result =
        body.params?.name === 'browser_evaluate'
          ? { content: [{ type: 'text', text: `### Result\n${JSON.stringify(JSON.stringify({ ok: true, url: `https://${HOST}/`, title: 'T' }))}` }] }
          : { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'S1' } });
    };
    const driver = mcpDriver({ endpoint: 'http://browser.internal/mcp', http })!;
    await driver.navigate(`https://${HOST}/`);
    const action: PageAction = { op: 'click', locator: { role: 'button', name: 'Search' } };
    expect(await driver.act(action)).toMatchObject({ ok: true });
    await driver.close();
    expect(calls.map((c) => c.name ?? c.method)).toEqual(['initialize', 'notifications/initialized', 'browser_navigate', 'browser_evaluate']);
    expect(calls.at(-1)!.args).toEqual({ function: pageActionSource(action) });
    expect(calls.at(-1)!.session).toBe('S1');
    expect(mcpDriver({ endpoint: null })).toBeNull();
  });

  it('embeds an action as data, so a value can never become script', () => {
    const src = pageActionSource({ op: 'fill', locator: { css: '#q' }, value: '"); alert(1); ("' });
    expect(src).toContain(JSON.stringify('"); alert(1); ("'));
    expect(() => new Function(`return (${src})`)).not.toThrow();
  });
});
