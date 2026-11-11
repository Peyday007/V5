/**
 * Operating a site's interface: bounded browser workflows under a granted
 * account (ACQ-21-1, ACQ-21-2 browser and model-assisted classes).
 *
 * `browserMcp.ts` renders one public page anonymously. That reads a page. It
 * cannot operate a site. This module operates one: a workflow is a recorded,
 * reusable list of steps (navigation, search, filtering, form entry, download
 * handling) addressed by reliable locators (role and accessible name, label,
 * test id, CSS, exact text, never coordinates). Each workflow carries explicit
 * success checks, and a run passes only when those checks pass. A person records
 * a workflow once, or the worker session drafts one from an interface survey
 * (`surveyInterface`). After that Brain runs it whenever the work needs it, so
 * nobody logs in and clicks through the same workflow again.
 *
 * Authority, in order, every run:
 *
 *  1. The need is judged by `recordAcquisitionJudgment` as an OPERATE need
 *     (the one selector, the one ACQUISITION_JUDGMENT record). Contacting
 *     strangers, evading defences or committing the business is refused there,
 *     before any page opens.
 *  2. A workflow that needs an account runs only when a person's standing
 *     `OPERATE_PERMISSION` grant covers its host. A revocation applies to the
 *     very next run. The account is used through the browser server's own
 *     signed-in session (`BRAIN_BROWSER_SESSION_MCP_URL`). Brain never holds,
 *     types or records a credential: a password field is a boundary, and a
 *     step that would fill one is refused.
 *  3. Every address the workflow reaches is checked by `checkDestination` and
 *     must stay on the workflow's host. A sign-in wall, a CAPTCHA or a bot
 *     challenge ends the run as HANDOFF, naming the boundary, and is never
 *     worked around.
 *
 * Bounded: at most `MAX_WORKFLOW_STEPS` steps, one browser slot shared with
 * page renders (`withBrowserSlot`), one session per run, closed in a `finally`,
 * one overall timeout. Reliability is measured, never assumed: every run is a
 * `BROWSER_WORKFLOW_RUN` row, and a workflow that fails more often than it
 * works, at least `ROUTINE_RETIRE_FAILURES` times, is retired until a new
 * definition is recorded. A model-assisted draft becomes a tested script after
 * `SCRIPT_CONVERSION_RUNS` consecutive completed runs. A locator that stops
 * matching marks the interface as changed, and the next judgment routes it
 * back through model-assisted recovery.
 *
 * This extends the existing owner. Definitions and runs are `bin_events` rows
 * written through `recordBinEvent`, beside the SOURCE_ACCESS,
 * ACQUISITION_JUDGMENT and OPERATE_PERMISSION rows of this layer. No table,
 * scheduler, queue or authority path is added, and no host, category or
 * industry is named.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { readOperatePermission, recordAcquisitionJudgment, hostMeasuresPattern, type AcquisitionJudgment, type OperatePermission } from './acquisition.ts';
import { SCRIPT_CONVERSION_RUNS, type AccessEvidence } from './accessMethods.ts';
import { BROWSER_TIMEOUT_MS, browserMcpUrl, evaluateResult, McpSession, withBrowserSlot, type Http } from './browserMcp.ts';
import { checkDestination, MAX_TEXT_CHARS, systemResolver, type Resolver } from './fetchForWorker.ts';
import { ROUTINE_RETIRE_FAILURES } from './routines.ts';

export const BROWSER_WORKFLOW_EVENT = 'BROWSER_WORKFLOW';
export const BROWSER_WORKFLOW_RUN_EVENT = 'BROWSER_WORKFLOW_RUN';
export const MAX_WORKFLOW_STEPS = 40;
/** The longest a single wait step may hold the browser. */
export const MAX_WAIT_SECONDS = 10;
export const WORKFLOW_TIMEOUT_MS = 3 * BROWSER_TIMEOUT_MS;

/** A reliable locator: exactly one way of finding the element, never a coordinate. */
export interface Locator {
  role?: string;
  name?: string;
  label?: string;
  testId?: string;
  css?: string;
  text?: string;
  /** 1-based position when several elements match on purpose; without it more than one match is a failure. */
  nth?: number;
}

export type WorkflowStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'fill'; locator: Locator; value: string; submit?: boolean }
  | { kind: 'click'; locator: Locator }
  | { kind: 'select'; locator: Locator; option: string }
  | { kind: 'check'; locator: Locator; checked: boolean }
  | { kind: 'wait'; text?: string; seconds?: number }
  | { kind: 'expect'; text?: string; absentText?: string; locator?: Locator; urlIncludes?: string }
  | { kind: 'extract'; name: string; locator?: Locator }
  | { kind: 'download'; name: string; locator?: Locator; url?: string };

export const STEP_KINDS = ['navigate', 'fill', 'click', 'select', 'check', 'wait', 'expect', 'extract', 'download'] as const;

export interface BrowserWorkflow {
  host: string;
  name: string;
  purpose: string;
  /** The workflow runs under the account a person granted for the host. */
  account: boolean;
  /** Who wrote it: a person, or a model reading an interface survey. */
  origin: 'AUTHORED' | 'MODEL_ASSISTED';
  steps: WorkflowStep[];
}

export type WorkflowBoundary = NonNullable<AccessEvidence['boundary']>;

export interface WorkflowStepResult {
  index: number;
  kind: WorkflowStep['kind'];
  ok: boolean;
  detail: string;
}

export interface WorkflowRun {
  host: string;
  name: string;
  outcome: 'COMPLETED' | 'FAILED' | 'HANDOFF' | 'REFUSED' | 'UNAVAILABLE';
  steps: WorkflowStepResult[];
  extracted: { name: string; text: string; truncated: boolean }[];
  downloads: { name: string; url: string; sha256: string; chars: number; text: string }[];
  finalUrl: string | null;
  boundary: WorkflowBoundary | null;
  /** A locator stopped matching: the interface changed and needs model-assisted recovery. */
  interfaceChanged: boolean;
  detail: string;
}

/* ------------------------------------------------------------------------- */
/* Validation (pure)                                                          */
/* ------------------------------------------------------------------------- */

const SECRET_SHAPED = /[:@].*[:@]|^(sk|pk|ghp|gho|xox[abp]|brn[a-z])[-_]|^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const CREDENTIAL_FIELD = /pass(word|code|phrase)?|secret|token|otp|one[- ]time|2fa|mfa|pin\b|cvv|cvc|card number/i;

/** Whether a URL stays on the workflow's host (the host itself or one of its subdomains). Pure. */
export function onHost(url: string, host: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const want = host.toLowerCase();
    return h === want || h.endsWith(`.${want}`);
  } catch {
    return false;
  }
}

function locatorProblem(loc: Locator | undefined): string | null {
  if (!loc || typeof loc !== 'object') return 'a locator is required';
  const ways = ['role', 'label', 'testId', 'css', 'text'].filter((k) => typeof (loc as Record<string, unknown>)[k] === 'string' && ((loc as Record<string, unknown>)[k] as string).trim() !== '');
  if (ways.length !== 1) return 'a locator names exactly one of role, label, testId, css or text';
  if (loc.name !== undefined && !loc.role) return 'a name qualifies a role';
  if (loc.nth !== undefined && (!Number.isInteger(loc.nth) || loc.nth < 1)) return 'nth is a 1-based position';
  for (const v of [loc.label, loc.name, loc.testId, loc.css, loc.role]) if (v && CREDENTIAL_FIELD.test(v)) return 'a credential field is a boundary, not a step';
  return null;
}

/** Every problem with a workflow definition; empty when it may be recorded and run. Pure. */
export function validateWorkflow(w: BrowserWorkflow): string[] {
  const problems: string[] = [];
  const host = (w.host ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) problems.push('the workflow names the host it operates');
  if (!w.name?.trim()) problems.push('the workflow has a name');
  if (!w.purpose?.trim()) problems.push('the workflow states its purpose');
  if (w.origin !== 'AUTHORED' && w.origin !== 'MODEL_ASSISTED') problems.push('origin is AUTHORED or MODEL_ASSISTED');
  const steps = Array.isArray(w.steps) ? w.steps : [];
  if (steps.length === 0) problems.push('the workflow has steps');
  if (steps.length > MAX_WORKFLOW_STEPS) problems.push(`at most ${MAX_WORKFLOW_STEPS} steps`);
  if (steps[0]?.kind !== 'navigate') problems.push('the first step navigates to the starting page');
  if (!steps.some((s) => s.kind === 'expect')) problems.push('the workflow has at least one explicit success check (expect)');
  steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s?.kind ?? '?'})`;
    if (!s || !(STEP_KINDS as readonly string[]).includes(s.kind)) return problems.push(`${at}: unknown step`);
    switch (s.kind) {
      case 'navigate':
        if (!onHost(s.url, host) || !/^https:\/\//i.test(s.url)) problems.push(`${at}: navigation stays on https://${host}`);
        break;
      case 'fill': {
        const p = locatorProblem(s.locator);
        if (p) problems.push(`${at}: ${p}`);
        if (typeof s.value !== 'string') problems.push(`${at}: a fill has a value`);
        else if (SECRET_SHAPED.test(s.value)) problems.push(`${at}: a value is never a credential`);
        break;
      }
      case 'click':
      case 'select':
      case 'check': {
        const p = locatorProblem(s.locator);
        if (p) problems.push(`${at}: ${p}`);
        if (s.kind === 'select' && !s.option?.trim()) problems.push(`${at}: a select names its option`);
        break;
      }
      case 'wait':
        if (!s.text && !(typeof s.seconds === 'number' && s.seconds > 0 && s.seconds <= MAX_WAIT_SECONDS)) problems.push(`${at}: wait for a text, or 1-${MAX_WAIT_SECONDS} seconds`);
        break;
      case 'expect':
        if (!s.text && !s.absentText && !s.locator && !s.urlIncludes) problems.push(`${at}: a success check names what it checks`);
        if (s.locator) {
          const p = locatorProblem(s.locator);
          if (p) problems.push(`${at}: ${p}`);
        }
        break;
      case 'extract':
      case 'download':
        if (!s.name?.trim()) problems.push(`${at}: names what it captures`);
        if (s.locator) {
          const p = locatorProblem(s.locator);
          if (p) problems.push(`${at}: ${p}`);
        }
        if (s.kind === 'download' && !s.locator && !s.url) problems.push(`${at}: a download names a link or an address`);
        if (s.kind === 'download' && s.url && !onHost(s.url, host)) problems.push(`${at}: a download stays on ${host}`);
        break;
    }
    return undefined;
  });
  return problems;
}

/* ------------------------------------------------------------------------- */
/* In-page code (runs inside the browser via browser_evaluate)                */
/* ------------------------------------------------------------------------- */

/** Finds elements by a locator and performs one step. Deterministic; no model per click. */
const IN_PAGE = String.raw`(step) => {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const txt = (el) => (el == null ? '' : typeof el.innerText === 'string' ? el.innerText : el.textContent || '');
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const nameOf = (el) => norm(el.getAttribute('aria-label') || (el.labels && el.labels[0] && txt(el.labels[0])) || el.getAttribute('placeholder') || el.getAttribute('title') || txt(el) || el.value || '');
  const ROLE = { button: 'button,[role=button],input[type=submit],input[type=button]', link: 'a[href],[role=link]', textbox: 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=number],input[type=tel],input[type=url],input[type=date],textarea,[role=textbox]', searchbox: 'input[type=search],[role=searchbox]', checkbox: 'input[type=checkbox],[role=checkbox]', radio: 'input[type=radio],[role=radio]', combobox: 'select,[role=combobox]', tab: '[role=tab]', option: 'option,[role=option]', row: 'tr,[role=row]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]' };
  const find = (loc) => {
    let c = [];
    if (loc.testId) c = [...document.querySelectorAll('[data-testid="' + CSS.escape(loc.testId) + '"]')];
    else if (loc.label) { const want = norm(loc.label); c = [...document.querySelectorAll('input,select,textarea,[role=textbox],[role=combobox],[role=searchbox]')].filter((el) => nameOf(el) === want || (el.labels && [...el.labels].some((l) => norm(txt(l)) === want))); }
    else if (loc.role) { c = [...document.querySelectorAll(ROLE[loc.role] || '[role="' + CSS.escape(loc.role) + '"]')]; if (loc.name) { const want = norm(loc.name); c = c.filter((el) => nameOf(el) === want); } }
    else if (loc.css) c = [...document.querySelectorAll(loc.css)];
    else if (loc.text) { const want = norm(loc.text); c = [...document.querySelectorAll('a,button,label,span,div,td,th,li,h1,h2,h3,h4,p,summary,option')].filter((el) => norm(txt(el)) === want && ![...el.children].some((k) => norm(txt(k)) === want)); }
    return c.filter(visible);
  };
  const one = (loc) => {
    const c = find(loc);
    if (c.length === 0) return { el: null, why: 'NOT_FOUND: no element matches the locator' };
    if (c.length > 1 && !loc.nth) return { el: null, why: 'AMBIGUOUS: ' + c.length + ' elements match the locator' };
    const el = c[(loc.nth || 1) - 1];
    return el ? { el, why: '' } : { el: null, why: 'NOT_FOUND: no element at position ' + loc.nth };
  };
  const credential = (el) => el && (el.type === 'password' || /pass(word|code)|one-time-code/i.test(el.getAttribute('autocomplete') || ''));
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const out = (ok, detail, extra) => JSON.stringify(Object.assign({ ok, detail, url: location.href }, extra || {}));
  if (step.kind === 'boundary') {
    const frames = [...document.querySelectorAll('iframe')].map((f) => f.src || '').join(' ');
    if (/recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|captcha/i.test(frames) || document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]')) return out(true, 'CAPTCHA');
    if ([...document.querySelectorAll('input[type=password]')].some(visible)) return out(true, 'AUTHENTICATION');
    return out(true, '');
  }
  if (step.kind === 'survey') {
    const take = (els, f) => els.filter(visible).slice(0, 60).map(f);
    const fields = take([...document.querySelectorAll('input:not([type=hidden]),select,textarea')], (el) => ({ tag: el.tagName.toLowerCase(), type: el.type || null, label: nameOf(el) || null, testId: el.getAttribute('data-testid'), credential: !!credential(el) }));
    const buttons = take([...document.querySelectorAll('button,[role=button],input[type=submit]')], (el) => ({ name: nameOf(el), testId: el.getAttribute('data-testid') }));
    const links = take([...document.querySelectorAll('a[href]')], (el) => ({ name: nameOf(el), href: el.href }));
    return out(true, 'surveyed', { title: document.title, fields, buttons, links });
  }
  if (step.kind === 'expect') {
    const body = norm(document.body ? txt(document.body) : '');
    if (step.text && !body.includes(norm(step.text))) return out(false, 'CHECK_FAILED: the page does not show "' + step.text + '"');
    if (step.absentText && body.includes(norm(step.absentText))) return out(false, 'CHECK_FAILED: the page shows "' + step.absentText + '"');
    if (step.urlIncludes && !location.href.includes(step.urlIncludes)) return out(false, 'CHECK_FAILED: the address does not include "' + step.urlIncludes + '"');
    if (step.locator) { const r = one(step.locator); if (!r.el) return out(false, r.why); }
    return out(true, 'success check passed');
  }
  if (step.kind === 'extract') {
    if (!step.locator) return out(true, 'extracted the page', { text: document.body ? txt(document.body) : '' });
    const c = find(step.locator);
    if (c.length === 0) return out(false, 'NOT_FOUND: no element matches the locator');
    return out(true, 'extracted ' + c.length + ' element(s)', { text: c.map((el) => txt(el)).join('\n') });
  }
  if (step.kind === 'link') {
    const r = one(step.locator);
    if (!r.el) return out(false, r.why);
    const href = r.el.href || r.el.getAttribute('href') || '';
    return href ? out(true, 'link resolved', { href: new URL(href, location.href).href }) : out(false, 'NOT_FOUND: the element is not a link');
  }
  const r = one(step.locator);
  if (!r.el) return out(false, r.why);
  const el = r.el;
  if (step.kind === 'fill') {
    if (credential(el)) return out(false, 'BOUNDARY: the field is a credential; Brain does not type one');
    setValue(el, step.value);
    if (step.submit) { if (el.form && el.form.requestSubmit) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    return out(true, 'filled');
  }
  if (step.kind === 'click') { el.click(); return out(true, 'clicked'); }
  if (step.kind === 'check') { if (!!el.checked !== !!step.checked) el.click(); return out(!!el.checked === !!step.checked, 'checked=' + !!el.checked); }
  if (step.kind === 'select') {
    if (el.tagName !== 'SELECT') return out(false, 'NOT_FOUND: the element is not a select');
    const want = norm(step.option);
    const opt = [...el.options].find((o) => norm(o.text) === want || norm(o.value) === want);
    if (!opt) return out(false, 'NOT_FOUND: no option "' + step.option + '"');
    setValue(el, opt.value);
    return out(true, 'selected');
  }
  return out(false, 'unknown step');
}`;

/** Fetches a same-origin download inside the signed-in page, so the session's own cookies apply. */
const IN_PAGE_DOWNLOAD = String.raw`async (href) => {
  const res = await fetch(href, { credentials: 'same-origin' });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  return JSON.stringify({ ok: res.ok, status: res.status, type, text, url: res.url });
}`;

export const inPageCall = (code: string, arg: unknown): string => `() => (${code})(${JSON.stringify(arg)})`;

/* ------------------------------------------------------------------------- */
/* Running a workflow                                                         */
/* ------------------------------------------------------------------------- */

export interface RunWorkflowOptions {
  /** The browser endpoint; defaults to the signed-in session server for account workflows, else the reader. */
  endpoint?: string | null;
  http?: Http;
  resolve?: Resolver;
  timeoutMs?: number;
}

/** The browser server that holds a person's signed-in session for granted accounts. */
export function browserSessionUrl(): string | null {
  const raw = (process.env.BRAIN_BROWSER_SESSION_MCP_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
}

const toolText = (payload: Record<string, unknown> | null): { isError: boolean; text: string } => {
  const result = payload?.['result'] as { isError?: boolean; content?: { text?: string }[] } | undefined;
  return { isError: Boolean(result?.isError), text: (result?.content ?? []).map((c) => c.text ?? '').join(' ') };
};

interface PageReply {
  ok: boolean;
  detail: string;
  url?: string;
  text?: string;
  href?: string;
}

/**
 * Run one workflow in the browser. Never throws. Does not judge authority or
 * record anything: `operateWorkflow` does both around it.
 */
export async function runBrowserWorkflow(workflow: BrowserWorkflow, options: RunWorkflowOptions = {}): Promise<WorkflowRun> {
  const host = workflow.host.trim().toLowerCase();
  const run: WorkflowRun = { host, name: workflow.name, outcome: 'FAILED', steps: [], extracted: [], downloads: [], finalUrl: null, boundary: null, interfaceChanged: false, detail: '' };
  const end = (outcome: WorkflowRun['outcome'], detail: string): WorkflowRun => Object.assign(run, { outcome, detail: detail.slice(0, 300) });
  const problems = validateWorkflow(workflow);
  if (problems.length > 0) return end('REFUSED', `invalid workflow: ${problems[0]}`);
  const endpoint = options.endpoint !== undefined ? options.endpoint : workflow.account ? browserSessionUrl() : browserMcpUrl();
  if (!endpoint) return end('UNAVAILABLE', workflow.account ? 'no signed-in browser session is configured (BRAIN_BROWSER_SESSION_MCP_URL)' : 'no browser is configured (BRAIN_BROWSER_MCP_URL)');
  const resolve = options.resolve ?? systemResolver;

  const work = async (): Promise<WorkflowRun> => {
    const mcp = new McpSession(endpoint, options.http ?? (globalThis.fetch as Http), AbortSignal.timeout(options.timeoutMs ?? WORKFLOW_TIMEOUT_MS));
    const evaluate = async (code: string): Promise<PageReply> => {
      const reply = await mcp.request('tools/call', { name: 'browser_evaluate', arguments: { function: code } });
      return evaluateResult(reply ?? {}) as PageReply;
    };
    const landed = async (url: string | undefined): Promise<string | null> => {
      if (!url) return null;
      run.finalUrl = url;
      if (!onHost(url, host)) return `the page left ${host} (${new URL(url).hostname})`;
      const checked = await checkDestination(url, resolve);
      return checked.ok ? null : `the page ended somewhere not public (${checked.reason})`;
    };
    const boundary = async (): Promise<WorkflowBoundary | null> => {
      const b = await evaluate(inPageCall(IN_PAGE, { kind: 'boundary' }));
      return b.detail === 'CAPTCHA' || b.detail === 'AUTHENTICATION' ? b.detail : null;
    };
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'brain-site-operator', version: '1.0' } });
      await mcp.request('notifications/initialized', {}, true);
      for (const [index, step] of workflow.steps.entries()) {
        const record = (ok: boolean, detail: string): void => {
          run.steps.push({ index, kind: step.kind, ok, detail: detail.slice(0, 200) });
        };
        const stop = (detail: string, outcome: WorkflowRun['outcome'], why: string): WorkflowRun => {
          record(false, detail);
          return end(outcome, `step ${index + 1}: ${why}`);
        };
        if (step.kind === 'navigate') {
          const checked = await checkDestination(step.url, resolve);
          if (!checked.ok) return stop(checked.detail, 'REFUSED', `${checked.detail}`);
          const nav = toolText(await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url: checked.url.toString() } }));
          if (nav.isError) return stop(nav.text, 'FAILED', `the browser could not open the page`);
          record(true, 'opened');
        } else if (step.kind === 'wait') {
          const args = step.text ? { text: step.text } : { time: Math.min(step.seconds ?? 1, MAX_WAIT_SECONDS) };
          const waited = toolText(await mcp.request('tools/call', { name: 'browser_wait_for', arguments: args }));
          record(!waited.isError, waited.isError ? `waited without seeing "${step.text}"` : 'waited');
          if (waited.isError) return end('FAILED', `step ${index + 1}: ${waited.text.slice(0, 120)}`);
        } else if (step.kind === 'download') {
          let href = step.url ?? '';
          if (step.locator) {
            const link = await evaluate(inPageCall(IN_PAGE, { kind: 'link', locator: step.locator }));
            if (!link.ok || !link.href) {
              run.interfaceChanged ||= /^(NOT_FOUND|AMBIGUOUS)/.test(link.detail);
              return stop(link.detail, 'FAILED', `${link.detail}`);
            }
            href = link.href;
          }
          const where = await landed(href);
          if (where) return stop(where, 'REFUSED', `${where}`);
          const got = (await evaluate(inPageCall(IN_PAGE_DOWNLOAD, href))) as PageReply & { status?: number };
          if (!got.ok) return stop(`the download answered ${got.status ?? '?'}`, 'FAILED', `download refused`);
          const whole = String(got.text ?? '');
          const text = whole.slice(0, MAX_TEXT_CHARS);
          run.downloads.push({ name: step.name, url: href, sha256: createHash('sha256').update(whole).digest('hex'), chars: whole.length, text });
          record(true, `downloaded ${whole.length} chars`);
        } else {
          const reply = await evaluate(inPageCall(IN_PAGE, step));
          if (!reply.ok) {
            record(false, reply.detail);
            if (reply.detail.startsWith('BOUNDARY')) {
              run.boundary = 'AUTHENTICATION';
              return end('HANDOFF', `step ${index + 1}: a credential field is a boundary; a person signs the session in`);
            }
            run.interfaceChanged ||= /^(NOT_FOUND|AMBIGUOUS)/.test(reply.detail);
            return end('FAILED', `step ${index + 1}: ${reply.detail}`);
          }
          if (step.kind === 'extract') {
            const whole = String(reply.text ?? '').replace(/[ \t]+/g, ' ').trim();
            run.extracted.push({ name: step.name, text: whole.slice(0, MAX_TEXT_CHARS), truncated: whole.length > MAX_TEXT_CHARS });
          }
          record(true, reply.detail);
          const where = await landed(reply.url);
          if (where) return end('REFUSED', `step ${index + 1}: ${where}`);
        }
        if (step.kind === 'navigate' || step.kind === 'click' || (step.kind === 'fill' && step.submit)) {
          const met = await boundary();
          if (met) {
            run.boundary = met;
            return end('HANDOFF', `step ${index + 1}: met ${met === 'CAPTCHA' ? 'a challenge' : 'a sign-in wall'}; stopping at the boundary, nothing is bypassed`);
          }
          const at = await evaluate(inPageCall(IN_PAGE, { kind: 'expect' }));
          const where = await landed(at.url);
          if (where) return end('REFUSED', `step ${index + 1}: ${where}`);
        }
      }
      return end('COMPLETED', `${run.steps.length} step(s) passed, every success check held`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return end('FAILED', /abort|timeout/i.test(message) ? 'the workflow ran out of time' : `browser: ${message}`);
    } finally {
      await mcp.close();
    }
  };
  return withBrowserSlot(work).catch((error: unknown) => end('UNAVAILABLE', `browser: ${error instanceof Error ? error.message : String(error)}`));
}

export interface InterfaceSurvey {
  ok: boolean;
  detail: string;
  boundary: WorkflowBoundary | null;
  /** Visible fields, buttons and links with the labels and test ids a workflow can address. Null unless ok. */
  survey: unknown;
}

/**
 * Survey an interface so a model can draft a workflow from real locators (the
 * model-assisted class): the model interprets the page, and the draft it writes
 * is recorded with origin MODEL_ASSISTED and becomes a tested script only by
 * running unchanged. Same checks as a run: on the host, public, and stopping at
 * a boundary. Read-only; never throws.
 */
export async function surveyInterface(url: string, hostIn: string, options: RunWorkflowOptions & { account?: boolean } = {}): Promise<InterfaceSurvey> {
  const host = hostIn.trim().toLowerCase();
  const fail = (detail: string, boundary: WorkflowBoundary | null = null): InterfaceSurvey => ({ ok: false, detail: detail.slice(0, 300), boundary, survey: null });
  if (!onHost(url, host)) return fail(`the address is not on ${host}`);
  const resolve = options.resolve ?? systemResolver;
  const checked = await checkDestination(url, resolve);
  if (!checked.ok) return fail(checked.detail);
  const endpoint = options.endpoint !== undefined ? options.endpoint : options.account ? browserSessionUrl() : browserMcpUrl();
  if (!endpoint) return fail('no browser is configured');
  return withBrowserSlot(async (): Promise<InterfaceSurvey> => {
    const mcp = new McpSession(endpoint, options.http ?? (globalThis.fetch as Http), AbortSignal.timeout(options.timeoutMs ?? BROWSER_TIMEOUT_MS));
    const evaluate = async (arg: unknown) =>
      evaluateResult((await mcp.request('tools/call', { name: 'browser_evaluate', arguments: { function: inPageCall(IN_PAGE, arg) } })) ?? {}) as PageReply & Record<string, unknown>;
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'brain-site-operator', version: '1.0' } });
      await mcp.request('notifications/initialized', {}, true);
      const nav = toolText(await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url: checked.url.toString() } }));
      if (nav.isError) return fail('the browser could not open the page');
      const b = await evaluate({ kind: 'boundary' });
      if (b.detail === 'CAPTCHA' || b.detail === 'AUTHENTICATION') return fail(`met ${b.detail}; stopping at the boundary`, b.detail);
      const reply = await evaluate({ kind: 'survey' });
      if (!reply.url || !onHost(reply.url, host) || !(await checkDestination(reply.url, resolve)).ok) return fail('the page left the host or ended somewhere not public');
      const { ok: _ok, detail: _detail, ...survey } = reply;
      return { ok: true, detail: 'surveyed', boundary: null, survey };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      await mcp.close();
    }
  }).catch((error: unknown) => fail(`browser: ${error instanceof Error ? error.message : String(error)}`));
}

/* ------------------------------------------------------------------------- */
/* Records: definitions, runs, reliability (pure over rows)                   */
/* ------------------------------------------------------------------------- */

export interface WorkflowRecord {
  workflow: BrowserWorkflow;
  definedAt: string;
  runs: number;
  completed: number;
  /** Consecutive completed runs, newest first. */
  streak: number;
  /** A model-assisted draft that has run unchanged often enough is a tested script. */
  status: 'DRAFT' | 'SCRIPT' | 'RETIRED';
  /** The last run found the interface changed. */
  interfaceChanged: boolean;
  why: string;
}

const parse = <T>(raw: string | null): T | null => {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const keyOf = (host: string, name: string) => `${host.toLowerCase()}\u0000${name.trim().toLowerCase()}`;

/** Workflows from BROWSER_WORKFLOW rows and their reliability from BROWSER_WORKFLOW_RUN rows. Pure. */
export function workflowsFrom(definitions: readonly { measures: string | null; at: string | null }[], runs: readonly { measures: string | null; outcome: string | null; at: string | null }[]): Map<string, WorkflowRecord> {
  const newest = new Map<string, { w: BrowserWorkflow; at: string; t: number }>();
  for (const row of definitions) {
    const t = row.at ? Date.parse(row.at) : Number.NaN;
    const m = parse<{ workflow?: BrowserWorkflow }>(row.measures);
    if (!Number.isFinite(t) || !m?.workflow || validateWorkflow(m.workflow).length > 0) continue;
    const key = keyOf(m.workflow.host, m.workflow.name);
    const prior = newest.get(key);
    if (prior && prior.t >= t) continue;
    newest.set(key, { w: m.workflow, at: row.at!, t });
  }
  const out = new Map<string, WorkflowRecord>();
  for (const [key, d] of newest) {
    const mine = runs
      .map((r) => ({ r, m: parse<{ host?: string; name?: string; definedAt?: string; interfaceChanged?: boolean }>(r.measures), t: r.at ? Date.parse(r.at) : Number.NaN }))
      .filter((x) => x.m && keyOf(x.m.host ?? '', x.m.name ?? '') === key && x.m.definedAt === d.at && Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t);
    // A handoff or refusal is the boundary working, not the routine failing.
    const counted = mine.filter((x) => x.r.outcome === 'COMPLETED' || x.r.outcome === 'FAILED');
    const completed = counted.filter((x) => x.r.outcome === 'COMPLETED').length;
    let streak = 0;
    for (const x of counted) {
      if (x.r.outcome !== 'COMPLETED') break;
      streak += 1;
    }
    const failures = counted.length - completed;
    const retired = failures >= ROUTINE_RETIRE_FAILURES && failures > completed;
    const scripted = d.w.origin === 'AUTHORED' ? completed > 0 : streak >= SCRIPT_CONVERSION_RUNS;
    const status = retired ? 'RETIRED' : scripted ? 'SCRIPT' : 'DRAFT';
    out.set(key, {
      workflow: d.w,
      definedAt: d.at,
      runs: counted.length,
      completed,
      streak,
      status,
      interfaceChanged: Boolean(mine[0]?.m?.interfaceChanged),
      why:
        status === 'RETIRED'
          ? `failed ${failures} of ${counted.length} runs; retired until a new definition is recorded`
          : status === 'SCRIPT'
            ? `a tested routine: ${completed}/${counted.length} runs completed${d.w.origin === 'MODEL_ASSISTED' ? `, ${streak} in a row unchanged` : ''}`
            : `a ${d.w.origin === 'MODEL_ASSISTED' ? 'model-assisted draft' : 'workflow'} not yet proven (${streak}/${SCRIPT_CONVERSION_RUNS} consecutive completed runs)`,
    });
  }
  return out;
}

/** Record a workflow definition. Append-only; the newest definition of a host's named workflow decides. */
export async function recordBrowserWorkflow(workflow: BrowserWorkflow, recordedBy: string, deps: { record?: typeof recordBinEvent } = {}): Promise<BrowserWorkflow> {
  const w: BrowserWorkflow = { ...workflow, host: workflow.host.trim().toLowerCase(), name: workflow.name.trim() };
  const problems = validateWorkflow(w);
  if (problems.length > 0) throw new Error(`Refused: ${problems.join('; ')}`);
  if (!recordedBy.trim()) throw new Error('A workflow names who recorded it.');
  await (deps.record ?? recordBinEvent)({
    eventType: BROWSER_WORKFLOW_EVENT,
    provider: w.origin === 'MODEL_ASSISTED' ? 'MODEL_ASSISTED' : 'BROWSER',
    workloadClass: 'acquisition',
    outcome: 'DEFINED',
    reason: `Workflow "${w.name}" on ${w.host}: ${w.purpose}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { host: w.host, name: w.name, recordedBy: recordedBy.trim(), workflow: w },
  });
  return w;
}

async function readWorkflowRows(host: string): Promise<{ definitions: { measures: string | null; at: string | null }[]; runs: { measures: string | null; outcome: string | null; at: string | null }[] }> {
  try {
    const pattern = hostMeasuresPattern(host);
    const definitions = await getDb().all<{ measures: string | null; at: string | null }>(
      `SELECT measures, at FROM bin_events WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 50`,
      [BROWSER_WORKFLOW_EVENT, pattern],
    );
    const runs = await getDb().all<{ measures: string | null; outcome: string | null; at: string | null }>(
      `SELECT measures, outcome, at FROM bin_events WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 200`,
      [BROWSER_WORKFLOW_RUN_EVENT, pattern],
    );
    return { definitions, runs };
  } catch {
    return { definitions: [], runs: [] };
  }
}

/** A host's recorded workflows with their measured reliability. */
export async function readBrowserWorkflows(host: string): Promise<Map<string, WorkflowRecord>> {
  const { definitions, runs } = await readWorkflowRows(host);
  return workflowsFrom(definitions, runs);
}

export interface OperateDeps {
  workflows?: (host: string) => Promise<Map<string, WorkflowRecord>>;
  permission?: (host: string) => Promise<OperatePermission>;
  judge?: typeof recordAcquisitionJudgment;
  run?: typeof runBrowserWorkflow;
  record?: typeof recordBinEvent;
  options?: RunWorkflowOptions;
}

export interface OperateResult {
  run: WorkflowRun;
  judgment: AcquisitionJudgment | null;
  record: WorkflowRecord | null;
}

/**
 * Operate a host's interface by running its recorded workflow: judged, permitted,
 * bounded, and recorded. This is how Brain reuses a site's functionality without a
 * person signing in and clicking through it again.
 */
export async function operateWorkflow(hostIn: string, name: string, deps: OperateDeps = {}): Promise<OperateResult> {
  const host = hostIn.trim().toLowerCase();
  const blank = (outcome: WorkflowRun['outcome'], detail: string, boundary: WorkflowBoundary | null = null): WorkflowRun => ({
    host, name, outcome, steps: [], extracted: [], downloads: [], finalUrl: null, boundary, interfaceChanged: false, detail,
  });
  const record = (await (deps.workflows ?? readBrowserWorkflows)(host)).get(keyOf(host, name)) ?? null;
  if (!record) return { run: blank('REFUSED', `no workflow "${name}" is recorded for ${host}`), judgment: null, record: null };

  const judgment = await (deps.judge ?? recordAcquisitionJudgment)(
    { kind: 'OPERATE', purpose: record.workflow.purpose, host },
    {
      interactiveInterfaceOnly: true,
      // An unauthenticated workflow needs no grant; an account workflow needs the person's grant, read by the judgment itself.
      ...(record.workflow.account ? {} : { authorizedAccountOnRecord: true }),
      interfaceUnfamiliarOrChanged: record.interfaceChanged || record.status === 'DRAFT',
    },
    { caller: 'browser-workflow', ...(deps.permission ? { operatePermission: deps.permission } : {}) },
  );
  let run: WorkflowRun;
  if (judgment.outcome !== 'ROUTE_SELECTED' || (judgment.route !== 'BROWSER' && judgment.route !== 'MODEL_ASSISTED')) {
    run = blank(judgment.outcome === 'REFUSED' ? 'REFUSED' : 'HANDOFF', judgment.reason.slice(0, 300), judgment.route === 'HUMAN_HANDOFF' && record.workflow.account ? 'AUTHENTICATION' : null);
  } else if (record.workflow.account && !(await (deps.permission ?? readOperatePermission)(host)).permitted) {
    // Read again at the moment of running: a revocation between judgment and run still stops it.
    run = blank('HANDOFF', `no standing permission to operate ${host}; a person grants it (operatePermissionCli.ts)`, 'AUTHENTICATION');
  } else if (record.status === 'RETIRED') {
    run = blank('REFUSED', `the workflow is retired: ${record.why}`);
  } else {
    run = await (deps.run ?? runBrowserWorkflow)(record.workflow, deps.options ?? {});
  }
  await (deps.record ?? recordBinEvent)({
    eventType: BROWSER_WORKFLOW_RUN_EVENT,
    provider: judgment.route,
    workloadClass: 'acquisition',
    outcome: run.outcome,
    reason: run.detail.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: {
      host,
      name: record.workflow.name,
      definedAt: record.definedAt,
      status: record.status,
      boundary: run.boundary,
      interfaceChanged: run.interfaceChanged,
      finalUrl: run.finalUrl,
      steps: run.steps,
      extracted: run.extracted.map((e) => ({ name: e.name, chars: e.text.length })),
      downloads: run.downloads.map((d) => ({ name: d.name, sha256: d.sha256, chars: d.chars })),
    },
  });
  return { run, judgment, record };
}
