/**
 * Operating a website's interface as a bounded, reusable workflow (ACQ-21-1,
 * ACQ-21-2 browser class).
 *
 * A one-page render (`browserMcp.ts` `renderInBrowser`) reads what a page shows.
 * Operating a site is more than that: navigate, search, filter, fill a form,
 * download a file, and know it worked. This module is that, as data and one
 * executor:
 *
 *  - A **workflow** is a recorded list of steps over **locators** a person can
 *    read and a test can check (role + accessible name, label, visible text,
 *    test id, CSS) — never coordinates, never a model deciding each click. It
 *    must carry at least one explicit success check (`expect`), so "it ran" is
 *    never mistaken for "it worked".
 *  - It is **recorded once and reused**: an append-only `BROWSER_WORKFLOW` bin
 *    event, the newest per host and name deciding (the same table and writer
 *    the access and acquisition judgments use; no new store). `routines.ts`
 *    attaches a host's recorded workflow to its browser routine, so a read the
 *    routine leads runs the script instead of rediscovering the page, and a
 *    model-assisted pattern that became stable runs as a tested script.
 *  - It runs **under the legitimate account a person granted, or none**. A
 *    workflow that needs an account (`session: 'ACCOUNT'`) runs only when the
 *    host has a standing `OPERATE_PERMISSION` grant (`acquisition.ts`), and only
 *    on the deployment's account browser (`BRAIN_BROWSER_ACCOUNT_MCP_URL`): a
 *    separate Playwright MCP server whose persistent profile holds the session
 *    the person signed into once. Brain never holds, types or stores the
 *    credential (invariant 22, §22) — a step that targets a password field is
 *    refused at validation and again in the page — so nobody logs in and clicks
 *    through the same workflow again, and nobody's password passes through Brain.
 *  - It **stops at a genuine access boundary**. A sign-in wall, a CAPTCHA or a
 *    bot check met mid-run ends the run as `HUMAN_HANDOFF`, naming the
 *    boundary; nothing here tries to get past it. robots.txt is honoured for
 *    every page a workflow opens, every address is checked by `checkDestination`
 *    before and after navigation, and a workflow never leaves its own host.
 *
 * Every run is a `BROWSER_WORKFLOW_RUN` row with each step's success check
 * (parameter names only — never their values). Nothing here contacts a
 * stranger, makes a commitment or evades a defence, and no host, category or
 * industry is named: every workflow is a row somebody recorded.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { BROWSER_TIMEOUT_MS, BrowserBusy, browserMcpUrl, evaluateResult, openBrowserSession, slot, type Http, type McpSession } from './browserMcp.ts';
import { checkDestination, MAX_TEXT_CHARS, systemResolver, type Resolver, type SourceFetch } from './fetchForWorker.ts';
import type { OperatePermission } from './acquisition.ts';

export const BROWSER_WORKFLOW_EVENT = 'BROWSER_WORKFLOW';
export const BROWSER_WORKFLOW_RUN_EVENT = 'BROWSER_WORKFLOW_RUN';
/** A workflow is bounded: more steps than this is not a routine, it is a crawl. */
export const MAX_WORKFLOW_STEPS = 30;
/** The parameter a read routine's workflow navigates to: the address being read. */
export const URL_PARAM = 'url';

export type Locator =
  | { role: string; name?: string; nth?: number }
  | { label: string; nth?: number }
  | { text: string; nth?: number }
  | { testId: string; nth?: number }
  | { css: string; nth?: number };

export type WorkflowStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'fill'; locator: Locator; param: string }
  | { kind: 'select'; locator: Locator; param: string }
  | { kind: 'click'; locator: Locator }
  | { kind: 'waitFor'; text: string }
  | { kind: 'expect'; text?: string; urlIncludes?: string; locator?: Locator }
  | { kind: 'extract'; locator?: Locator }
  | { kind: 'download'; locator: Locator };

export interface BrowserWorkflow {
  host: string;
  name: string;
  /** PUBLIC runs on the research browser with no account; ACCOUNT needs a standing operate permission. */
  session: 'PUBLIC' | 'ACCOUNT';
  steps: WorkflowStep[];
}

export class WorkflowError extends Error {}

const STEP_KINDS = ['navigate', 'fill', 'select', 'click', 'waitFor', 'expect', 'extract', 'download'] as const;
const CREDENTIAL_WORDS = /pass(word|code|phrase)?\b|passwd|one[- ]time|otp\b|2fa|mfa|security code|verification code|secret|api[ _-]?key|token/i;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function sameSite(host: string, candidate: string): boolean {
  const h = host.toLowerCase();
  const c = candidate.toLowerCase();
  return c === h || c.endsWith(`.${h}`) || h.endsWith(`.${c}`);
}

function validateLocator(raw: unknown, at: string): Locator {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nth = r.nth === undefined ? undefined : Number(r.nth);
  if (nth !== undefined && !(Number.isInteger(nth) && nth >= 0)) throw new WorkflowError(`${at}: nth is a non-negative integer`);
  const withNth = <T extends object>(l: T): T => (nth === undefined ? l : { ...l, nth });
  let loc: Locator;
  if (str(r.role)) loc = withNth({ role: str(r.role), ...(str(r.name) ? { name: str(r.name) } : {}) });
  else if (str(r.label)) loc = withNth({ label: str(r.label) });
  else if (str(r.text)) loc = withNth({ text: str(r.text) });
  else if (str(r.testId)) loc = withNth({ testId: str(r.testId) });
  else if (str(r.css)) loc = withNth({ css: str(r.css) });
  else throw new WorkflowError(`${at}: a locator names a role, label, text, testId or css`);
  const said = [str(r.name), str(r.label), str(r.text), str(r.testId), str(r.css)].join(' ');
  if (CREDENTIAL_WORDS.test(said) || /type\s*=\s*["']?password/i.test(said)) {
    throw new WorkflowError(`${at}: a workflow never targets a credential field; the account browser's own session signs in`);
  }
  return loc;
}

/** Validate a recorded workflow. Pure; throws WorkflowError naming the first problem. */
export function validateWorkflow(input: unknown): BrowserWorkflow {
  const o = (input ?? {}) as Record<string, unknown>;
  const host = str(o.host).toLowerCase();
  const name = str(o.name);
  if (!host || /[\s/]/.test(host)) throw new WorkflowError('a workflow names the host it operates');
  if (!name) throw new WorkflowError('a workflow has a name it is reused by');
  const session = o.session === 'ACCOUNT' ? 'ACCOUNT' : o.session === 'PUBLIC' || o.session === undefined ? 'PUBLIC' : null;
  if (!session) throw new WorkflowError('session is PUBLIC or ACCOUNT');
  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  if (rawSteps.length === 0) throw new WorkflowError('a workflow has steps');
  if (rawSteps.length > MAX_WORKFLOW_STEPS) throw new WorkflowError(`a workflow has at most ${MAX_WORKFLOW_STEPS} steps`);
  const steps = rawSteps.map((raw, i): WorkflowStep => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const at = `step ${i + 1}`;
    const kind = s.kind as (typeof STEP_KINDS)[number];
    if (!(STEP_KINDS as readonly unknown[]).includes(kind)) throw new WorkflowError(`${at}: unknown kind ${String(s.kind)}`);
    switch (kind) {
      case 'navigate': {
        const url = str(s.url);
        if (url !== `$${URL_PARAM}`) {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new WorkflowError(`${at}: navigate takes an absolute address or $${URL_PARAM}`);
          }
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new WorkflowError(`${at}: only web addresses are opened`);
          if (!sameSite(host, parsed.hostname)) throw new WorkflowError(`${at}: a workflow never leaves ${host}`);
        }
        return { kind, url };
      }
      case 'fill':
      case 'select': {
        const param = str(s.param);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(param)) throw new WorkflowError(`${at}: ${kind} takes its value from a named parameter`);
        if (CREDENTIAL_WORDS.test(param)) throw new WorkflowError(`${at}: a workflow never takes a credential as a parameter`);
        return { kind, locator: validateLocator(s.locator, at), param };
      }
      case 'click':
      case 'download':
        return { kind, locator: validateLocator(s.locator, at) };
      case 'waitFor': {
        const text = str(s.text);
        if (!text) throw new WorkflowError(`${at}: waitFor names the text it waits for`);
        return { kind, text };
      }
      case 'expect': {
        const text = str(s.text);
        const urlIncludes = str(s.urlIncludes);
        const locator = s.locator === undefined ? undefined : validateLocator(s.locator, at);
        if (!text && !urlIncludes && !locator) throw new WorkflowError(`${at}: a success check names text, an address fragment or a locator`);
        return { kind, ...(text ? { text } : {}), ...(urlIncludes ? { urlIncludes } : {}), ...(locator ? { locator } : {}) };
      }
      case 'extract':
        return { kind, ...(s.locator === undefined ? {} : { locator: validateLocator(s.locator, at) }) };
    }
  });
  if (!steps.some((s) => s.kind === 'expect')) throw new WorkflowError('a workflow carries at least one explicit success check (expect)');
  if (steps[0]!.kind !== 'navigate') throw new WorkflowError('a workflow starts by opening a page');
  return { host, name, session, steps };
}

/** The parameter names a workflow needs. Pure. */
export function workflowParams(workflow: BrowserWorkflow): string[] {
  const names = new Set<string>();
  for (const s of workflow.steps) {
    if (s.kind === 'fill' || s.kind === 'select') names.add(s.param);
    if (s.kind === 'navigate' && s.url === `$${URL_PARAM}`) names.add(URL_PARAM);
  }
  return [...names];
}

/** Whether a workflow reads an address handed to it (a read routine) rather than a fixed page. Pure. */
export function readsAddress(workflow: BrowserWorkflow): boolean {
  return workflow.steps[0]?.kind === 'navigate' && workflow.steps[0].url === `$${URL_PARAM}`;
}

/* ------------------------------------------------------------------------- */
/* The record                                                                 */
/* ------------------------------------------------------------------------- */

/** Record a workflow. Append-only: a revision is a newer row with the same host and name. */
export async function recordBrowserWorkflow(
  input: unknown,
  recordedBy: string,
  deps: { record?: typeof recordBinEvent } = {},
): Promise<BrowserWorkflow> {
  const workflow = validateWorkflow(input);
  if (!recordedBy.trim()) throw new WorkflowError('a workflow names who recorded it');
  await (deps.record ?? recordBinEvent)({
    eventType: BROWSER_WORKFLOW_EVENT,
    workloadClass: 'acquisition',
    outcome: workflow.session,
    reason: `Workflow "${workflow.name}" on ${workflow.host}: ${workflow.steps.length} step(s), recorded by ${recordedBy.trim()}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { host: workflow.host, name: workflow.name, workflow, recordedBy: recordedBy.trim() },
  });
  return workflow;
}

export interface RecordedWorkflow {
  workflow: BrowserWorkflow;
  /** The `bin_events.at` of the row that recorded this version. */
  recordedAt: string;
}

/** The newest valid workflow per host and name, from BROWSER_WORKFLOW rows. Pure; a row that no longer validates is skipped. */
export function workflowsFromRows(rows: readonly { measures: string | null; at: string | null }[]): Map<string, RecordedWorkflow[]> {
  const newest = new Map<string, { t: number; r: RecordedWorkflow }>();
  for (const row of rows) {
    const t = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(t)) continue;
    let w: BrowserWorkflow;
    try {
      w = validateWorkflow((JSON.parse(row.measures ?? '{}') as { workflow?: unknown }).workflow);
    } catch {
      continue;
    }
    const key = `${w.host}\u0000${w.name}`;
    const prior = newest.get(key);
    if (prior && prior.t >= t) continue;
    newest.set(key, { t, r: { workflow: w, recordedAt: row.at! } });
  }
  const byHost = new Map<string, RecordedWorkflow[]>();
  for (const { r } of [...newest.values()].sort((a, b) => b.t - a.t)) byHost.set(r.workflow.host, [...(byHost.get(r.workflow.host) ?? []), r]);
  return byHost;
}

export async function readBrowserWorkflows(): Promise<Map<string, RecordedWorkflow[]>> {
  try {
    const rows = await getDb().all<{ measures: string | null; at: string | null }>(
      `SELECT measures, at FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 2000`,
      [BROWSER_WORKFLOW_EVENT],
    );
    return workflowsFromRows(rows);
  } catch {
    return new Map();
  }
}

/* ------------------------------------------------------------------------- */
/* Running one                                                                */
/* ------------------------------------------------------------------------- */

export type WorkflowOutcome = 'SUCCEEDED' | 'FAILED' | 'HUMAN_HANDOFF' | 'REFUSED';

export interface StepResult {
  index: number;
  kind: WorkflowStep['kind'];
  ok: boolean;
  detail: string;
}

export interface WorkflowRun {
  host: string;
  name: string;
  session: BrowserWorkflow['session'];
  accountRef: string | null;
  outcome: WorkflowOutcome;
  reason: string;
  steps: StepResult[];
  finalUrl: string | null;
  /** Text the workflow extracted, in step order. */
  extracted: string[];
  downloads: { url: string; contentType: string | null; chars: number; sha256: string; text: string }[];
}

export interface WorkflowDeps {
  endpoint?: string | null;
  accountEndpoint?: string | null;
  http?: Http;
  resolve?: Resolver;
  robotsAllow?: (url: string) => Promise<boolean>;
  permission?: (host: string) => Promise<OperatePermission>;
  record?: typeof recordBinEvent | null;
  timeoutMs?: number;
  caller?: string;
}

export function accountBrowserMcpUrl(): string | null {
  const raw = (process.env.BRAIN_BROWSER_ACCOUNT_MCP_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
}

/** The in-page locator resolver, as source. It returns every visible match, innermost first for text. */
const FIND = `
const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
const ROLE = { button: 'button,[role=button],input[type=submit],input[type=button]', link: 'a[href],[role=link]',
  textbox: 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=number],input[type=tel],input[type=url],textarea,[role=textbox]',
  searchbox: 'input[type=search],[role=searchbox]', combobox: 'select,[role=combobox]', checkbox: 'input[type=checkbox],[role=checkbox]',
  radio: 'input[type=radio],[role=radio]', tab: '[role=tab]', option: 'option,[role=option]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]', row: 'tr,[role=row]' };
const nameOf = (e) => norm(e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.value || e.getAttribute('placeholder'));
const find = (loc) => {
  let c = [];
  if (loc.css) c = [...document.querySelectorAll(loc.css)];
  else if (loc.testId) c = [...document.querySelectorAll('[data-testid="' + CSS.escape(loc.testId) + '"]')];
  else if (loc.label) {
    const want = norm(loc.label);
    for (const l of document.querySelectorAll('label')) {
      if (norm(l.innerText) !== want) continue;
      const t = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input,select,textarea');
      if (t) c.push(t);
    }
    for (const e of document.querySelectorAll('[aria-label],[placeholder]')) {
      if (norm(e.getAttribute('aria-label')) === want || norm(e.getAttribute('placeholder')) === want) c.push(e);
    }
  } else if (loc.role) {
    const want = loc.name ? norm(loc.name) : null;
    c = [...document.querySelectorAll(ROLE[loc.role] || '[role="' + loc.role + '"]')].filter((e) => !want || nameOf(e) === want);
  } else if (loc.text) {
    const want = norm(loc.text);
    c = [...document.querySelectorAll('body *')].filter((e) => norm(e.innerText) === want);
    c = c.filter((e) => !c.some((o) => o !== e && e.contains(o)));
  }
  c = [...new Set(c)].filter(visible);
  if (loc.nth !== undefined) return c[loc.nth] ? [c[loc.nth]] : [];
  return c;
};
const one = (loc) => {
  const c = find(loc);
  if (c.length === 0) return { el: null, why: 'no visible element matches the locator' };
  if (c.length > 1) return { el: null, why: c.length + ' elements match the locator; it is ambiguous (add nth or a narrower locator)' };
  return { el: c[0], why: null };
};
`;

/** The browser_evaluate function for one step. Pure. Every function returns a JSON string. */
export function stepFunction(step: WorkflowStep, value: string | null): string {
  const loc = 'locator' in step && step.locator ? JSON.stringify(step.locator) : 'null';
  const v = JSON.stringify(value ?? '');
  const out = (body: string) => `() => { ${FIND} const r = (() => { ${body} })(); return JSON.stringify(r); }`;
  switch (step.kind) {
    case 'fill':
      return out(`const f = one(${loc}); if (!f.el) return { ok: false, detail: f.why };
        if (f.el.type === 'password') return { ok: false, detail: 'refused: a workflow never types into a password field' };
        const proto = f.el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; f.el.focus(); setter.call(f.el, ${v});
        f.el.dispatchEvent(new Event('input', { bubbles: true })); f.el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: f.el.value === ${v}, detail: f.el.value === ${v} ? 'filled' : 'the field did not keep the value' };`);
    case 'select':
      return out(`const f = one(${loc}); if (!f.el) return { ok: false, detail: f.why };
        if (f.el.tagName !== 'SELECT') return { ok: false, detail: 'the locator is not a select' };
        const want = norm(${v}); const opt = [...f.el.options].find((o) => norm(o.value) === want || norm(o.text) === want);
        if (!opt) return { ok: false, detail: 'no option matches the parameter' };
        f.el.value = opt.value; f.el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, detail: 'selected' };`);
    case 'click':
      return out(`const f = one(${loc}); if (!f.el) return { ok: false, detail: f.why }; f.el.click(); return { ok: true, detail: 'clicked' };`);
    case 'expect':
      return out(`const problems = []; const text = document.body ? document.body.innerText : '';
        ${step.text ? `if (!norm(text).includes(norm(${JSON.stringify(step.text)}))) problems.push('the page does not show ' + ${JSON.stringify(JSON.stringify(step.text))});` : ''}
        ${step.urlIncludes ? `if (!location.href.includes(${JSON.stringify(step.urlIncludes)})) problems.push('the address does not include ' + ${JSON.stringify(step.urlIncludes)});` : ''}
        ${step.locator ? `if (find(${loc}).length === 0) problems.push('the expected element is not on the page');` : ''}
        return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'success check held' };`);
    case 'extract':
      return out(step.locator
        ? `const c = find(${loc}); if (c.length === 0) return { ok: false, detail: 'no visible element matches the locator' };
           return { ok: true, detail: c.length + ' element(s) read', value: c.map((e) => e.innerText).join('\\n') };`
        : `return { ok: true, detail: 'page read', value: document.body ? document.body.innerText : '' };`);
    case 'download':
      return out(`const f = one(${loc}); if (!f.el) return { ok: false, detail: f.why };
        const a = f.el.closest('a[href]') || (f.el.getAttribute('href') ? f.el : null);
        if (!a) return { ok: false, detail: 'the located element is not a link to a file' };
        return { ok: true, detail: 'link found', value: new URL(a.getAttribute('href'), location.href).toString() };`);
    default:
      return out(`return { ok: false, detail: 'not an in-page step' };`);
  }
}

/** Where a page stands after navigation: its address and whether it is a genuine access boundary. */
const LANDING = `() => { const text = document.body ? document.body.innerText : '';
  const captcha = !!document.querySelector('iframe[src*="captcha"],iframe[src*="challenge"],.g-recaptcha,.h-captcha,#cf-challenge-running') ||
    /verify you are (a )?human|are you a robot|unusual traffic|complete the security check|checking your browser/i.test(text);
  const signIn = !!document.querySelector('input[type=password]');
  return JSON.stringify({ url: location.href, captcha, signIn }); }`;

const downloadFunction = (href: string): string =>
  `async () => { const r = await fetch(${JSON.stringify(href)}, { credentials: 'include' }); const t = await r.text();
    return JSON.stringify({ ok: r.ok, status: r.status, type: r.headers.get('content-type'), total: t.length, text: t.slice(0, ${MAX_TEXT_CHARS}) }); }`;

async function evaluate(mcp: McpSession, fn: string): Promise<Record<string, unknown>> {
  const payload = await mcp.request('tools/call', { name: 'browser_evaluate', arguments: { function: fn } });
  return (evaluateResult(payload ?? {}) ?? {}) as Record<string, unknown>;
}

/** An address without its query or fragment, which may carry a parameter's value. */
export function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/** A parameter value that looks like a credential is never typed by a workflow. */
function credentialShaped(value: string): boolean {
  return /^(sk|pk|ghp|gho|xox[abp])[-_]|^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(value);
}

/**
 * Run one recorded workflow. Never throws: every outcome is a WorkflowRun, and
 * (unless `record` is null) a BROWSER_WORKFLOW_RUN row.
 */
export async function runBrowserWorkflow(
  workflow: BrowserWorkflow,
  params: Readonly<Record<string, string>>,
  deps: WorkflowDeps = {},
): Promise<WorkflowRun> {
  const resolve = deps.resolve ?? systemResolver;
  const run: WorkflowRun = {
    host: workflow.host, name: workflow.name, session: workflow.session, accountRef: null,
    outcome: 'REFUSED', reason: '', steps: [], finalUrl: null, extracted: [], downloads: [],
  };
  const finish = async (outcome: WorkflowOutcome, reason: string): Promise<WorkflowRun> => {
    run.outcome = outcome;
    run.reason = reason.slice(0, 300);
    if (deps.record !== null) {
      await (deps.record ?? recordBinEvent)({
        eventType: BROWSER_WORKFLOW_RUN_EVENT,
        provider: workflow.session === 'ACCOUNT' ? 'BROWSER_ACCOUNT' : 'BROWSER',
        workloadClass: deps.caller ?? 'acquisition',
        outcome,
        reason: `${workflow.name} on ${workflow.host}: ${run.reason}`.slice(0, 480),
        evidenceClass: 'MEASURED',
        measures: {
          host: workflow.host, name: workflow.name, session: workflow.session, accountRef: run.accountRef,
          params: Object.keys(params).sort(), steps: run.steps,
          // An address's query can carry a parameter's value, so the record keeps the path only.
          downloads: run.downloads.map(({ url, contentType, chars, sha256 }) => ({ url: withoutQuery(url), contentType, chars, sha256 })),
          finalUrl: run.finalUrl ? withoutQuery(run.finalUrl) : null,
        },
      }).catch(() => undefined);
    }
    return run;
  };

  for (const name of workflowParams(workflow)) {
    const value = params[name];
    if (value === undefined || value === '') return finish('REFUSED', `the workflow needs the parameter "${name}"`);
    if (name !== URL_PARAM && credentialShaped(value)) return finish('REFUSED', `the parameter "${name}" looks like a credential; a workflow never types one`);
  }

  let endpoint: string | null;
  if (workflow.session === 'ACCOUNT') {
    const permission = await (deps.permission ?? (async (h: string) => (await import('./acquisition.ts')).readOperatePermission(h)))(workflow.host).catch(
      () => ({ permitted: false, accountRef: null, grantedBy: null, at: null }) as OperatePermission,
    );
    if (!permission.permitted) return finish('REFUSED', `NO_AUTHORIZED_ACCOUNT: nobody has granted Brain permission to operate ${workflow.host} under an account`);
    run.accountRef = permission.accountRef;
    endpoint = deps.accountEndpoint === undefined ? accountBrowserMcpUrl() : deps.accountEndpoint;
    if (!endpoint) return finish('REFUSED', 'no account browser is configured (BRAIN_BROWSER_ACCOUNT_MCP_URL); the grant stands but there is no signed-in session to operate');
  } else {
    endpoint = deps.endpoint === undefined ? browserMcpUrl() : deps.endpoint;
    if (!endpoint) return finish('REFUSED', 'no browser is configured (BRAIN_BROWSER_MCP_URL)');
  }

  try {
    return await slot(async () => {
      const signal = AbortSignal.timeout(deps.timeoutMs ?? BROWSER_TIMEOUT_MS * 2);
      const mcp = await openBrowserSession(endpoint!, deps.http ?? (globalThis.fetch as Http), signal);
      try {
        for (const [i, step] of workflow.steps.entries()) {
          const note = (ok: boolean, detail: string) => run.steps.push({ index: i + 1, kind: step.kind, ok, detail: detail.slice(0, 200) });
          if (step.kind === 'navigate') {
            const target = step.url === `$${URL_PARAM}` ? params[URL_PARAM]! : step.url;
            const checked = await checkDestination(target, resolve);
            if (!checked.ok) {
              note(false, `refused: ${checked.reason}`);
              return finish('REFUSED', `step ${i + 1}: the address may not be opened (${checked.reason})`);
            }
            if (!sameSite(workflow.host, checked.url.hostname)) {
              note(false, 'refused: outside the workflow host');
              return finish('REFUSED', `step ${i + 1}: a workflow never leaves ${workflow.host}`);
            }
            if (!(await (deps.robotsAllow ?? (async () => true))(checked.url.toString()).catch(() => false))) {
              note(false, 'refused: robots.txt disallows the page');
              return finish('REFUSED', `step ${i + 1}: robots.txt disallows ${checked.url.pathname}`);
            }
            const nav = await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url: checked.url.toString() } });
            const navResult = nav?.['result'] as { isError?: boolean; content?: { text?: string }[] } | undefined;
            if (navResult?.isError) {
              note(false, `the page did not open: ${(navResult.content ?? []).map((c) => c.text ?? '').join(' ')}`);
              return finish('FAILED', `step ${i + 1}: the page did not open`);
            }
          } else if (step.kind === 'waitFor') {
            const waited = await mcp.request('tools/call', { name: 'browser_wait_for', arguments: { text: step.text } }).catch(() => null);
            const r = waited?.['result'] as { isError?: boolean } | undefined;
            if (!waited || r?.isError) {
              note(false, `"${step.text}" never appeared`);
              return finish('FAILED', `step ${i + 1}: "${step.text}" never appeared`);
            }
            note(true, 'appeared');
            continue;
          } else {
            const value = step.kind === 'fill' || step.kind === 'select' ? params[step.param]! : null;
            const r = await evaluate(mcp, stepFunction(step, value));
            const ok = r.ok === true;
            if (step.kind === 'download' && ok) {
              const href = String(r.value ?? '');
              const checked = await checkDestination(href, resolve);
              if (!checked.ok || !sameSite(workflow.host, checked.url.hostname)) {
                note(false, 'refused: the file is not on the workflow host or not public');
                return finish('REFUSED', `step ${i + 1}: the download leaves ${workflow.host}`);
              }
              const got = await evaluate(mcp, downloadFunction(checked.url.toString()));
              if (got.ok !== true) {
                note(false, `the download answered ${String(got.status)}`);
                return finish('FAILED', `step ${i + 1}: the download answered ${String(got.status)}`);
              }
              const text = String(got.text ?? '');
              run.downloads.push({ url: checked.url.toString(), contentType: typeof got.type === 'string' ? got.type : null, chars: Number(got.total ?? text.length), sha256: createHash('sha256').update(text).digest('hex'), text });
              note(true, `downloaded ${Number(got.total ?? text.length)} characters`);
              continue;
            }
            note(ok, String(r.detail ?? (ok ? 'ok' : 'failed')));
            if (!ok) return finish('FAILED', `step ${i + 1} (${step.kind}): ${String(r.detail ?? 'failed')}`);
            if (step.kind === 'extract') run.extracted.push(String(r.value ?? '').slice(0, MAX_TEXT_CHARS));
            if (step.kind !== 'click') continue;
          }
          // After a page opens or a click: where did it land, and is it a boundary nobody may automate past?
          const landing = await evaluate(mcp, LANDING);
          const finalUrl = typeof landing.url === 'string' ? landing.url : null;
          if (finalUrl) {
            const landed = await checkDestination(finalUrl, resolve);
            if (!landed.ok) {
              note(false, 'the page ended somewhere not public');
              return finish('REFUSED', `step ${i + 1}: the page ended somewhere not public (${landed.reason})`);
            }
            run.finalUrl = finalUrl;
          }
          if (landing.captcha === true) {
            note(false, 'a CAPTCHA or bot check stands here');
            return finish('HUMAN_HANDOFF', `step ${i + 1}: a CAPTCHA or bot check stands here; Brain stops at it and asks for permitted access, an export or a person's step`);
          }
          if (landing.signIn === true) {
            note(false, 'a sign-in form stands here');
            return finish('HUMAN_HANDOFF', `step ${i + 1}: the site asks for a sign-in${workflow.session === 'ACCOUNT' ? '; the account browser\'s session has lapsed and the account holder signs in once on it' : '; this needs an account a person grants (operatePermissionCli.ts)'}`);
          }
          if (step.kind === 'navigate') note(true, 'opened');
        }
        return finish('SUCCEEDED', `${run.steps.filter((s) => s.kind === 'expect').length} success check(s) held`);
      } finally {
        await mcp.close();
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BrowserBusy) return finish('FAILED', message);
    return finish('FAILED', /abort|timeout/i.test(message) ? 'the workflow timed out' : `browser: ${message}`);
  }
}

/** A read routine's workflow as a source read: the extracted text (or the page) is what was read. */
export function workflowAsRead(run: WorkflowRun, requestedUrl: string, now: () => Date = () => new Date()): SourceFetch {
  const whole = [...run.extracted, ...run.downloads.map((d) => d.text)].join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  if (run.outcome !== 'SUCCEEDED' || !whole) {
    return {
      readable: false, requestedUrl, finalUrl: run.finalUrl, status: null, retrievedAt: now().toISOString(),
      reason: run.outcome === 'REFUSED' ? 'ADDRESS_NOT_PUBLIC' : 'EMPTY',
      detail: `workflow ${run.name}: ${run.outcome === 'SUCCEEDED' ? 'it read nothing' : run.reason}`.slice(0, 200),
    };
  }
  const text = whole.slice(0, MAX_TEXT_CHARS);
  return {
    readable: true, requestedUrl, finalUrl: run.finalUrl ?? requestedUrl, status: 200,
    contentType: `text/plain; workflow=${run.name}`, retrievedAt: now().toISOString(),
    sha256: createHash('sha256').update(whole).digest('hex'), text, truncated: text.length < whole.length, totalChars: whole.length,
  };
}
