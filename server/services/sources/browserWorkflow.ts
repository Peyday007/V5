/**
 * Operating a site's interface under the account a person granted (ACQ-21-1),
 * as a reusable, bounded browser workflow (ACQ-21-2's browser class).
 *
 * Production before this: the only browser route was one anonymous page render
 * (`browserMcp.ts`), and a "routine" only chose which read route went first.
 * Nothing could navigate, search, filter, enter a form, handle a download or
 * check that a workflow had worked, so the owner's example — a site with no
 * public API, operated without someone logging in and clicking through the
 * same workflow every time — could not be done at all.
 *
 * A workflow is a recorded definition (an append-only `BROWSER_WORKFLOW` bin
 * event, newest per host and name decides) of steps over reliable locators:
 *
 *   navigate · fill · select · check · click · waitFor · expect · extract · download
 *
 * and it is run deterministically in one isolated browser session, so a
 * sign-in step runs once per run and no person repeats it. Every run is a
 * `BROWSER_WORKFLOW_RUN` row with each step's outcome (never a filled value),
 * and the OPERATE judgment (`acquisition.ts`) is recorded beside it.
 *
 * What makes it reliable: a locator matches exactly one visible element or the
 * step fails (`pageActions.ts`); a definition must state at least one explicit
 * success check (`expect`); the run stops on the first failed step. A workflow
 * whose runs fail more often than they work, at least `WORKFLOW_RETIRE_FAILURES`
 * times, is retired — by its rows, never by a clock.
 *
 * Model-assisted work is a separate route, not the same render: when a locator
 * no longer fits (the interface changed), the run records `interfaceChanged`
 * and an outline of the page's interactive elements, the OPERATE judgment for
 * that run selects MODEL_ASSISTED, and a model-assisted repair is recorded as a
 * new version of the definition with `origin: 'MODEL_ASSISTED'`. Once such a
 * version has run unchanged `SCRIPT_CONVERSION_RUNS` times it is a tested
 * script (`scripted`), so the recurring pattern stops costing a model.
 *
 * What it never does:
 *
 *  - operate without a person's grant. The standing `OPERATE_PERMISSION` row
 *    for the host (`operatePermissionCli.ts`) is read before anything opens; no
 *    grant is NO_AUTHORIZED_ACCOUNT, a handoff naming the command.
 *  - hold or leak a credential. A sign-in value is named by a deployment secret
 *    (`secretEnv`, which must be a `BRAIN_OPERATE_*` variable so a workflow
 *    cannot read any other secret), resolved at the moment it is typed, sent only
 *    to the workflow's own host, and never recorded. A literal credential-shaped
 *    value is refused when the definition is recorded.
 *  - leave its host, or open an address `checkDestination` refuses.
 *  - evade a defence. A challenge page, or a sign-in wall the workflow did not
 *    expect, stops the run at the boundary (HUMAN_HANDOFF); a step aimed at a
 *    challenge widget is refused when recorded.
 *  - contact strangers or commit the business. A definition that says it would,
 *    or whose clicks name sending, buying, ordering, paying, signing or
 *    accepting, is refused.
 *
 * This extends the existing owner: the rows are `bin_events` through
 * `recordBinEvent`, the session is `browserMcp.ts`'s MCP client under its same
 * concurrency bound, and the read path (`access.ts`) runs a READ workflow as its
 * BROWSER route. No table, scheduler, queue or authority path is added, and no
 * host, category or industry is named.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { recordAcquisitionJudgment, looksLikeSecret, readOperatePermission, type OperatePermission } from './acquisition.ts';
import { SCRIPT_CONVERSION_RUNS } from './accessMethods.ts';
import { browserMcpUrl, BROWSER_TIMEOUT_MS, evaluateResult, McpSession, slot, type Http } from './browserMcp.ts';
import { checkDestination, MAX_TEXT_CHARS, systemResolver, type Resolver, type SourceFetch } from './fetchForWorker.ts';
import { pageActionSource, type Locator, type PageAction, type PageActionResult } from './pageActions.ts';

export const BROWSER_WORKFLOW_EVENT = 'BROWSER_WORKFLOW';
export const BROWSER_WORKFLOW_RUN_EVENT = 'BROWSER_WORKFLOW_RUN';
export const MAX_WORKFLOW_STEPS = 40;
export const MAX_WAIT_SECONDS = 10;
/** Failed runs after which a workflow that fails more than it works is retired. */
export const WORKFLOW_RETIRE_FAILURES = 2;
/** The only environment variables a workflow may type: deployment secrets set for operation. */
export const OPERATE_SECRET_ENV = /^BRAIN_OPERATE_[A-Z0-9_]+$/;

export type WorkflowStep =
  | { op: 'navigate'; url: string }
  | { op: 'fill'; locator: Locator; value?: string; param?: string; secretEnv?: string }
  | { op: 'select'; locator: Locator; value?: string; param?: string }
  | { op: 'check'; locator: Locator; checked?: boolean }
  | { op: 'click'; locator: Locator }
  | { op: 'waitFor'; locator?: Locator; text?: string; seconds?: number }
  | { op: 'expect'; locator?: Locator; text?: string; urlIncludes?: string }
  | { op: 'extract'; locator?: Locator; as?: string }
  | { op: 'download'; locator?: Locator; url?: string; as?: string };

export interface BrowserWorkflow {
  /** The host the workflow operates; it never leaves it (subdomains included). */
  host: string;
  name: string;
  /** READ: the read path may run it for a URL on the host (param `url`). OPERATE: run on request. */
  purpose: 'READ' | 'OPERATE';
  description?: string;
  /** Names a run must supply; `{{name}}` in a navigate URL, or `param` in a fill/select. */
  params?: string[];
  steps: WorkflowStep[];
  /** Who wrote this version: a person/engineer, or a model-assisted repair or authoring. */
  origin?: 'AUTHORED' | 'MODEL_ASSISTED';
  /** Sign-in is part of the workflow (a password field is expected, not a boundary). */
  signsIn?: boolean;
  contactsStrangers?: boolean;
  makesBusinessCommitment?: boolean;
}

export type StepOutcome = 'OK' | 'FAILED' | 'BOUNDARY' | 'SKIPPED';

export interface StepRecord {
  index: number;
  op: WorkflowStep['op'];
  outcome: StepOutcome;
  /** Never a filled value. */
  detail: string | null;
  miss?: 'NOT_FOUND' | 'AMBIGUOUS';
  ms: number;
}

export type WorkflowBoundary = 'NO_AUTHORIZED_ACCOUNT' | 'AUTHENTICATION' | 'CAPTCHA' | 'OFF_HOST' | 'ADDRESS_NOT_PUBLIC';

export interface WorkflowOutput {
  text: string;
  totalChars: number;
  truncated: boolean;
  sha256: string;
  url: string;
  contentType: string;
}

export interface WorkflowRun {
  host: string;
  name: string;
  outcome: 'OK' | 'FAILED' | 'BOUNDARY' | 'REFUSED';
  steps: StepRecord[];
  outputs: Record<string, WorkflowOutput>;
  boundary: WorkflowBoundary | null;
  /** What a person or the business must provide to get past the boundary. */
  handoff: string | null;
  /** A locator stopped fitting: the interface changed, and a model-assisted repair is the route. */
  interfaceChanged: boolean;
  /** The page's interactive elements at the failure, for that repair. */
  outline: PageActionResult['elements'] | null;
  accountRef: string | null;
  finalUrl: string | null;
  refused: string[];
  startedAt: string;
  ms: number;
}

/** The browser, as the steps need it. The production driver is Playwright MCP; tests bring a fake. */
export interface PageDriver {
  navigate(url: string): Promise<{ ok: boolean; detail?: string }>;
  act(action: PageAction): Promise<PageActionResult>;
  wait(seconds: number): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------------- */
/* Definitions                                                                */
/* ------------------------------------------------------------------------- */

/** Clicks whose target names contacting someone or committing the business. */
const COMMITTING =
  /\b(buy|purchase|pay|checkout|check out|place order|order now|confirm (order|purchase|booking|payment)|book now|subscribe|sign (the )?(contract|agreement)|e-?sign|accept (the )?(offer|terms|bid|quote)|submit (a |the )?(bid|offer|proposal|quote|application)|send|message|contact|invite|reply|post|publish)\b/i;
/** Elements that are a site's defence, never a target. */
const DEFENCE = /captcha|recaptcha|hcaptcha|turnstile|cf-challenge|challenge-form|px-captcha|arkose/i;

const locatorText = (l: Locator | undefined): string => (l ? Object.values(l).join(' ') : '');

function onHost(host: string, candidate: string): boolean {
  const h = candidate.toLowerCase();
  return h === host || h.endsWith(`.${host}`);
}

/** Every reason a definition may not be recorded or run. Pure; empty means valid. */
export function validateWorkflow(w: BrowserWorkflow): string[] {
  const errors: string[] = [];
  const host = (w.host ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) errors.push('host must be a hostname');
  if (!w.name?.trim()) errors.push('a workflow has a name');
  if (w.purpose !== 'READ' && w.purpose !== 'OPERATE') errors.push('purpose is READ or OPERATE');
  if (w.contactsStrangers) errors.push('operating a site is not authorization to contact strangers');
  if (w.makesBusinessCommitment) errors.push('operating a site is not authorization to commit the business');
  const steps = Array.isArray(w.steps) ? w.steps : [];
  if (steps.length === 0) errors.push('a workflow has steps');
  if (steps.length > MAX_WORKFLOW_STEPS) errors.push(`at most ${MAX_WORKFLOW_STEPS} steps`);
  if (!steps.some((s) => s.op === 'expect')) errors.push('a workflow states at least one explicit success check (expect)');
  if (steps[0] && steps[0].op !== 'navigate') errors.push('a workflow starts by navigating');
  if (w.purpose === 'READ' && !(w.params ?? []).includes('url')) errors.push('a READ workflow takes the url to read as param "url"');
  if (w.purpose === 'READ' && !steps.some((s) => s.op === 'extract' || s.op === 'download')) errors.push('a READ workflow extracts or downloads something');
  const params = new Set(w.params ?? []);
  steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s.op})`;
    if ('locator' in s && s.locator && DEFENCE.test(locatorText(s.locator))) errors.push(`${at} targets a site defence; defences are not operated`);
    switch (s.op) {
      case 'navigate': {
        const templated = s.url.replace(/\{\{(\w+)\}\}/g, (_m, p: string) => {
          if (!params.has(p)) errors.push(`${at} uses undeclared param ${p}`);
          return p === 'url' ? `https://${host}/` : 'x';
        });
        try {
          const u = new URL(templated.startsWith('https://') || templated.startsWith('http://') ? templated : `https://${host}${templated.startsWith('/') ? '' : '/'}${templated}`);
          if (!onHost(host, u.hostname)) errors.push(`${at} leaves ${host}`);
        } catch {
          errors.push(`${at} has no valid address`);
        }
        break;
      }
      case 'fill':
      case 'select': {
        const sources = [s.value !== undefined, s.param !== undefined, s.op === 'fill' && s.secretEnv !== undefined].filter(Boolean).length;
        if (sources !== 1) errors.push(`${at} takes exactly one of value, param${s.op === 'fill' ? ' or secretEnv' : ''}`);
        if (s.param !== undefined && !params.has(s.param)) errors.push(`${at} uses undeclared param ${s.param}`);
        if (s.op === 'fill' && s.secretEnv !== undefined && !OPERATE_SECRET_ENV.test(s.secretEnv)) errors.push(`${at} may only type a BRAIN_OPERATE_* deployment secret`);
        if (s.value !== undefined && (looksLikeSecret(s.value) || /pass(word)?|secret|token|api.?key/i.test(locatorText(s.locator)))) {
          errors.push(`${at} holds a literal credential; name a BRAIN_OPERATE_* secret with secretEnv instead`);
        }
        if (s.op === 'fill' && s.secretEnv !== undefined && !w.signsIn) errors.push(`${at} types a secret, so the workflow declares signsIn`);
        break;
      }
      case 'click':
        if (COMMITTING.test(locatorText(s.locator))) errors.push(`${at} would contact someone or commit the business ("${locatorText(s.locator).slice(0, 60)}")`);
        break;
      case 'waitFor':
        if (s.seconds !== undefined && (s.seconds < 0 || s.seconds > MAX_WAIT_SECONDS)) errors.push(`${at} waits at most ${MAX_WAIT_SECONDS}s`);
        break;
      case 'expect':
        if (!s.locator && !s.text && !s.urlIncludes) errors.push(`${at} checks something`);
        break;
      case 'download':
        if (!s.locator && !s.url) errors.push(`${at} names what to download`);
        break;
      default:
        break;
    }
  });
  return errors;
}

/** The definition with its host normalized. */
function normalized(w: BrowserWorkflow): BrowserWorkflow {
  return { ...w, host: w.host.trim().toLowerCase(), name: w.name.trim(), origin: w.origin ?? 'AUTHORED' };
}

/** Record a workflow definition (a new version when the host and name exist). Refuses an invalid one. */
export async function recordBrowserWorkflow(
  input: BrowserWorkflow,
  by: string,
  deps: { record?: typeof recordBinEvent } = {},
): Promise<BrowserWorkflow> {
  const errors = validateWorkflow(input);
  if (!by.trim()) errors.push('a definition names who recorded it');
  if (errors.length > 0) throw new Error(`Workflow refused: ${errors.join('; ')}`);
  const w = normalized(input);
  await (deps.record ?? recordBinEvent)({
    eventType: BROWSER_WORKFLOW_EVENT,
    provider: w.origin === 'MODEL_ASSISTED' ? 'MODEL_ASSISTED' : 'BROWSER',
    workloadClass: 'operate',
    outcome: 'DEFINED',
    reason: `${w.origin === 'MODEL_ASSISTED' ? 'Model-assisted' : 'Authored'} ${w.purpose} workflow "${w.name}" on ${w.host} (${w.steps.length} steps) by ${by.trim()}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { ...w, by: by.trim() },
  });
  return w;
}

export interface WorkflowStatus {
  workflow: BrowserWorkflow;
  definedAt: string;
  runs: number;
  ok: number;
  /** Consecutive OK runs, newest first, of this version. */
  stableRuns: number;
  retired: boolean;
  /** A model-assisted version that has run unchanged long enough to be a tested script. */
  scripted: boolean;
  why: string;
}

interface Row {
  measures: string | null;
  outcome?: string | null;
  at: string | null;
}

const parse = <T>(raw: string | null): T | null => {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const keyOf = (host: string, name: string): string => `${host.toLowerCase()}|${name.trim()}`;

/** Workflow versions and their reliability, from definition and run rows. Pure. The newest version per host and name decides. */
export function workflowsFrom(definitions: readonly Row[], runs: readonly Row[]): Map<string, WorkflowStatus> {
  const newest = new Map<string, { w: BrowserWorkflow; at: string; t: number }>();
  for (const row of definitions) {
    const t = row.at ? Date.parse(row.at) : Number.NaN;
    const m = parse<BrowserWorkflow>(row.measures);
    if (!Number.isFinite(t) || !m || typeof m.host !== 'string' || typeof m.name !== 'string' || !Array.isArray(m.steps)) continue;
    if (validateWorkflow(m).length > 0) continue;
    const key = keyOf(m.host, m.name);
    const prior = newest.get(key);
    if (prior && prior.t >= t) continue;
    newest.set(key, { w: normalized(m), at: row.at!, t });
  }
  const out = new Map<string, WorkflowStatus>();
  for (const [key, d] of newest) {
    const mine = runs
      .map((r) => ({ m: parse<{ host?: string; name?: string; definedAt?: string; outcome?: string }>(r.measures), at: r.at ?? '' }))
      .filter((r) => r.m && keyOf(r.m.host ?? '', r.m.name ?? '') === key && r.m.definedAt === d.at && r.m.outcome !== 'REFUSED')
      .sort((a, b) => b.at.localeCompare(a.at));
    // A boundary is not the workflow failing: it is the site or the grant saying no.
    const judged = mine.filter((r) => r.m!.outcome !== 'BOUNDARY');
    const ok = judged.filter((r) => r.m!.outcome === 'OK').length;
    const failures = judged.length - ok;
    let stableRuns = 0;
    for (const r of judged) {
      if (r.m!.outcome !== 'OK') break;
      stableRuns += 1;
    }
    const retired = failures >= WORKFLOW_RETIRE_FAILURES && failures > ok;
    const scripted = d.w.origin === 'MODEL_ASSISTED' && stableRuns >= SCRIPT_CONVERSION_RUNS;
    out.set(key, {
      workflow: d.w,
      definedAt: d.at,
      runs: judged.length,
      ok,
      stableRuns,
      retired,
      scripted,
      why: retired
        ? `"${d.w.name}" on ${d.w.host} failed ${failures} of ${judged.length} runs; retired until a new version is recorded`
        : `"${d.w.name}" on ${d.w.host}: ${ok}/${judged.length} runs worked${scripted ? `; ran unchanged ${stableRuns} times, now a tested script` : ''}`,
    });
  }
  return out;
}

/** Recorded workflows and their status; empty when the rows cannot be read. */
export async function readWorkflows(): Promise<Map<string, WorkflowStatus>> {
  try {
    const definitions = await getDb().all<Row>(`SELECT measures, at FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 500`, [BROWSER_WORKFLOW_EVENT]);
    if (definitions.length === 0) return new Map();
    const runs = await getDb().all<Row>(`SELECT measures, at FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 5000`, [BROWSER_WORKFLOW_RUN_EVENT]);
    return workflowsFrom(definitions, runs);
  } catch {
    return new Map();
  }
}

/** The active READ workflow for a host, or null. */
export function readWorkflowFor(host: string, workflows: Map<string, WorkflowStatus>): WorkflowStatus | null {
  const h = host.toLowerCase();
  const candidates = [...workflows.values()].filter((s) => s.workflow.purpose === 'READ' && !s.retired && onHost(s.workflow.host, h));
  return candidates.sort((a, b) => b.ok - a.ok || b.definedAt.localeCompare(a.definedAt))[0] ?? null;
}

/* ------------------------------------------------------------------------- */
/* Running                                                                    */
/* ------------------------------------------------------------------------- */

/** Text that is a defence page, not the site. */
const CHALLENGE =
  /just a moment\.\.\.|checking your browser|verify you are (a )?human|verify you are not a bot|are you a robot|press (and|&) hold|unusual traffic from your computer|performing security verification|sorry, you have been blocked|access to this page has been denied/i;

export interface RunWorkflowDeps {
  driver?: () => PageDriver | null;
  permission?: (host: string) => Promise<OperatePermission>;
  resolve?: Resolver;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

const fill = (template: string, params: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, p: string) => (p === 'url' ? params[p] ?? '' : encodeURIComponent(params[p] ?? '')));

/** Run one workflow once. Never throws; every outcome is in the result. */
export async function runBrowserWorkflow(
  input: BrowserWorkflow,
  params: Record<string, string> = {},
  deps: RunWorkflowDeps = {},
): Promise<WorkflowRun> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const t0 = Date.now();
  const resolve = deps.resolve ?? systemResolver;
  const env = deps.env ?? process.env;
  const host = (input.host ?? '').trim().toLowerCase();
  const steps: StepRecord[] = [];
  const outputs: Record<string, WorkflowOutput> = {};
  const run = (outcome: WorkflowRun['outcome'], extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
    host,
    name: input.name,
    outcome,
    steps,
    outputs,
    boundary: null,
    handoff: null,
    interfaceChanged: false,
    outline: null,
    accountRef: null,
    finalUrl: null,
    refused: [],
    startedAt: started.toISOString(),
    ms: Date.now() - t0,
    ...extra,
  });

  const errors = validateWorkflow(input);
  for (const p of input.params ?? []) if (params[p] === undefined) errors.push(`param ${p} was not supplied`);
  if (errors.length > 0) return run('REFUSED', { refused: errors });
  const w = normalized(input);

  const permission = await (deps.permission ?? readOperatePermission)(host).catch(() => ({ permitted: false, accountRef: null, grantedBy: null, at: null }));
  if (!permission.permitted) {
    return run('BOUNDARY', {
      boundary: 'NO_AUTHORIZED_ACCOUNT',
      handoff: `a person's grant to operate ${host}: operatePermissionCli.ts grant --host ${host} --account <reference> --by <name>`,
    });
  }
  const driver = (deps.driver ?? mcpDriver)();
  if (!driver) return run('FAILED', { accountRef: permission.accountRef, refused: ['no browser is configured (BRAIN_BROWSER_MCP_URL)'] });

  let finalUrl: string | null = null;
  const stop = async (outcome: WorkflowRun['outcome'], extra: Partial<WorkflowRun>): Promise<WorkflowRun> => {
    for (let i = steps.length; i < w.steps.length; i += 1) steps.push({ index: i, op: w.steps[i]!.op, outcome: 'SKIPPED', detail: null, ms: 0 });
    return run(outcome, { accountRef: permission.accountRef, finalUrl, ...extra });
  };
  /** Where the page is now, and whether it is somewhere the workflow may be. */
  const guard = async (): Promise<Partial<WorkflowRun> | null> => {
    const state = await driver.act({ op: 'state' });
    finalUrl = state.url || finalUrl;
    let landed: URL | null = null;
    try {
      landed = new URL(state.url);
    } catch {
      landed = null;
    }
    if (landed && !onHost(host, landed.hostname)) return { boundary: 'OFF_HOST', handoff: `the workflow left ${host} for ${landed.hostname}; it is stopped rather than followed` };
    if (landed) {
      const ok = await checkDestination(landed.toString(), resolve);
      if (!ok.ok) return { boundary: 'ADDRESS_NOT_PUBLIC', handoff: null };
    }
    if (CHALLENGE.test(`${state.title}\n${state.text ?? ''}`)) {
      return { boundary: 'CAPTCHA', handoff: 'the site answered with a challenge: an official export, a licence or a partner integration; the challenge is not solved by Brain' };
    }
    if (state.passwordField && !w.signsIn) {
      return { boundary: 'AUTHENTICATION', handoff: `${host} asked for a sign-in this workflow does not perform: record a version that signs in under "${permission.accountRef}", or an official export` };
    }
    return null;
  };

  try {
    for (let i = 0; i < w.steps.length; i += 1) {
      const s = w.steps[i]!;
      const ts = Date.now();
      const record = (outcome: StepOutcome, detail: string | null, miss?: 'NOT_FOUND' | 'AMBIGUOUS') =>
        steps.push({ index: i, op: s.op, outcome, detail: detail?.slice(0, 200) ?? null, ...(miss ? { miss } : {}), ms: Date.now() - ts });
      const failed = async (result: PageActionResult): Promise<WorkflowRun> => {
        record('FAILED', result.detail ?? 'the step did not take', result.miss);
        const changed = result.miss !== undefined;
        const outline = changed ? (await driver.act({ op: 'outline' }).catch(() => null))?.elements ?? null : null;
        return stop('FAILED', { interfaceChanged: changed, outline });
      };
      switch (s.op) {
        case 'navigate': {
          const raw = fill(s.url, params);
          let target: URL;
          try {
            target = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${host}${raw.startsWith('/') ? '' : '/'}${raw}`);
          } catch {
            record('FAILED', 'no valid address');
            return stop('FAILED', {});
          }
          if (!onHost(host, target.hostname)) {
            record('BOUNDARY', `${target.hostname} is not ${host}`);
            return stop('BOUNDARY', { boundary: 'OFF_HOST', handoff: null });
          }
          const checked = await checkDestination(target.toString(), resolve);
          if (!checked.ok) {
            record('BOUNDARY', checked.reason);
            return stop('BOUNDARY', { boundary: 'ADDRESS_NOT_PUBLIC', handoff: null });
          }
          const nav = await driver.navigate(checked.url.toString());
          if (!nav.ok) {
            record('FAILED', nav.detail ?? 'the page did not open');
            return stop('FAILED', {});
          }
          break;
        }
        case 'fill':
        case 'select': {
          let value: string | undefined;
          if (s.op === 'fill' && s.secretEnv) {
            value = env[s.secretEnv];
            if (!value) {
              record('BOUNDARY', `deployment secret ${s.secretEnv} is not set`);
              return stop('BOUNDARY', { boundary: 'AUTHENTICATION', handoff: `set the deployment secret ${s.secretEnv} for "${permission.accountRef}"` });
            }
          } else value = s.param !== undefined ? params[s.param] : s.value;
          const result = await driver.act({ op: s.op, locator: s.locator, value: value ?? '' });
          if (!result.ok) return failed(result);
          break;
        }
        case 'check': {
          const result = await driver.act({ op: 'check', locator: s.locator, checked: s.checked ?? true });
          if (!result.ok) return failed(result);
          break;
        }
        case 'click': {
          const result = await driver.act({ op: 'click', locator: s.locator });
          if (!result.ok) return failed(result);
          await driver.wait(1);
          break;
        }
        case 'waitFor': {
          if (s.locator || s.text) {
            let present: PageActionResult | null = null;
            for (let left = Math.min(s.seconds ?? MAX_WAIT_SECONDS, MAX_WAIT_SECONDS); left >= 0; left -= 1) {
              present = await driver.act({ op: 'present', ...(s.locator ? { locator: s.locator } : {}), ...(s.text ? { text: s.text } : {}) });
              if (present.ok || left === 0) break;
              await driver.wait(1);
            }
            if (!present?.ok) return failed(present ?? { ok: false, url: '', title: '' });
          } else await driver.wait(Math.min(s.seconds ?? 1, MAX_WAIT_SECONDS));
          break;
        }
        case 'expect': {
          if (s.locator || s.text) {
            const present = await driver.act({ op: 'present', ...(s.locator ? { locator: s.locator } : {}), ...(s.text ? { text: s.text } : {}) });
            if (!present.ok) return failed(present);
          }
          if (s.urlIncludes) {
            const state = await driver.act({ op: 'state' });
            if (!state.url.includes(s.urlIncludes)) {
              record('FAILED', 'the page is not where the success check expects');
              return stop('FAILED', {});
            }
          }
          break;
        }
        case 'extract':
        case 'download': {
          const result =
            s.op === 'extract'
              ? await driver.act({ op: 'extract', ...(s.locator ? { locator: s.locator } : {}), maxChars: MAX_TEXT_CHARS })
              : await driver.act({ op: 'download', ...(s.locator ? { locator: s.locator } : {}), ...(s.url ? { url: fill(s.url, params) } : {}), maxChars: MAX_TEXT_CHARS });
          if (!result.ok || !result.text) return failed(result);
          const text = result.text;
          const at = result.href ?? result.url;
          outputs[s.as ?? `${s.op}${i + 1}`] = {
            text,
            totalChars: result.totalChars ?? text.length,
            truncated: (result.totalChars ?? text.length) > text.length,
            sha256: createHash('sha256').update(text).digest('hex'),
            url: at,
            contentType: s.op === 'download' ? result.contentType ?? 'text/plain' : 'text/html; operated',
          };
          break;
        }
      }
      if (s.op === 'navigate' || s.op === 'click' || s.op === 'download') {
        const stopped = await guard();
        if (stopped) {
          record('BOUNDARY', stopped.boundary ?? null);
          return stop('BOUNDARY', stopped);
        }
      }
      if (steps.length === i) record('OK', null);
    }
    return run('OK', { accountRef: permission.accountRef, finalUrl });
  } catch (error) {
    steps.push({ index: steps.length, op: w.steps[steps.length]?.op ?? 'navigate', outcome: 'FAILED', detail: `browser: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), ms: 0 });
    return stop('FAILED', {});
  } finally {
    await driver.close().catch(() => undefined);
  }
}

/** The production driver: one isolated Playwright MCP session for the whole run, or null when no browser is configured. */
export function mcpDriver(options: { endpoint?: string | null; http?: Http; timeoutMs?: number } = {}): PageDriver | null {
  const endpoint = options.endpoint === undefined ? browserMcpUrl() : options.endpoint;
  if (!endpoint) return null;
  const signal = AbortSignal.timeout(options.timeoutMs ?? BROWSER_TIMEOUT_MS * 4);
  const mcp = new McpSession(endpoint, options.http ?? (globalThis.fetch as Http), signal);
  let opened: Promise<void> | null = null;
  const open = () =>
    (opened ??= (async () => {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'brain-operator', version: '1.0' } });
      await mcp.request('notifications/initialized', {}, true);
    })());
  return {
    async navigate(url) {
      await open();
      const nav = await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url } });
      const result = nav?.['result'] as { isError?: boolean; content?: { text?: string }[] } | undefined;
      return result?.isError ? { ok: false, detail: (result.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 200) } : { ok: true };
    },
    async act(action) {
      await open();
      const evaluated = await mcp.request('tools/call', { name: 'browser_evaluate', arguments: { function: pageActionSource(action) } });
      return evaluateResult(evaluated ?? {}) as PageActionResult;
    },
    async wait(seconds) {
      await open();
      await mcp.request('tools/call', { name: 'browser_wait_for', arguments: { time: seconds } }).catch(() => null);
    },
    close: () => mcp.close(),
  };
}

/**
 * Run a workflow under the shared browser bound, record the run, and record the
 * OPERATE judgment it is evidence for. The run row never carries an output's
 * text or a filled value — sizes and digests only.
 */
export async function runAndRecordWorkflow(
  status: Pick<WorkflowStatus, 'workflow' | 'definedAt' | 'runs' | 'ok'>,
  params: Record<string, string>,
  deps: RunWorkflowDeps & { record?: typeof recordBinEvent; judge?: boolean; caller?: string } = {},
): Promise<WorkflowRun> {
  const result = await slot(() => runBrowserWorkflow(status.workflow, params, deps)).catch(
    (error: unknown): WorkflowRun => ({
      host: status.workflow.host,
      name: status.workflow.name,
      outcome: 'FAILED',
      steps: [],
      outputs: {},
      boundary: null,
      handoff: null,
      interfaceChanged: false,
      outline: null,
      accountRef: null,
      finalUrl: null,
      refused: [`browser: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)],
      startedAt: new Date().toISOString(),
      ms: 0,
    }),
  );
  const record = deps.record ?? recordBinEvent;
  await record({
    eventType: BROWSER_WORKFLOW_RUN_EVENT,
    provider: result.interfaceChanged ? 'MODEL_ASSISTED' : 'BROWSER',
    workloadClass: deps.caller ?? 'operate',
    outcome: result.outcome,
    reason: `${result.outcome} "${result.name}" on ${result.host}${result.boundary ? ` at ${result.boundary}` : ''}${result.interfaceChanged ? ': the interface changed' : ''}`.slice(0, 480),
    durationMs: result.ms,
    evidenceClass: 'MEASURED',
    measures: {
      host: result.host,
      name: result.name,
      definedAt: status.definedAt,
      origin: status.workflow.origin ?? 'AUTHORED',
      outcome: result.outcome,
      accountRef: result.accountRef,
      steps: result.steps,
      outputs: Object.fromEntries(Object.entries(result.outputs).map(([k, o]) => [k, { chars: o.totalChars, sha256: o.sha256, url: o.url.slice(0, 400), contentType: o.contentType }])),
      boundary: result.boundary,
      handoff: result.handoff,
      interfaceChanged: result.interfaceChanged,
      outline: result.outline,
      finalUrl: result.finalUrl?.slice(0, 400) ?? null,
      refused: result.refused,
    },
  }).catch(() => undefined);
  if (deps.judge !== false && result.outcome !== 'REFUSED') {
    const blocked = result.boundary !== null && result.boundary !== 'NO_AUTHORIZED_ACCOUNT';
    await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: `run "${result.name}" on ${result.host}`, host: result.host },
      {
        interactiveInterfaceOnly: true,
        authorizedAccountOnRecord: result.accountRef !== null,
        interfaceUnfamiliarOrChanged: result.interfaceChanged,
        blockedAtBoundary: blocked,
        ...(result.boundary === 'CAPTCHA' ? { boundary: 'CAPTCHA' as const } : result.boundary === 'AUTHENTICATION' ? { boundary: 'AUTHENTICATION' as const } : {}),
        repeatedUses: status.runs + 1,
        // A locator that stopped fitting is the deterministic routine measured at zero on this
        // interface: the model-assisted repair is the route until a new version runs.
        ...(result.interfaceChanged
          ? { reliability: { BROWSER: 0, MODEL_ASSISTED: 0.5 } }
          : status.runs > 0
            ? { reliability: { BROWSER: status.ok / status.runs } }
            : {}),
      },
      { caller: deps.caller ?? 'operate', ...(deps.permission ? { operatePermission: deps.permission } : {}), ...(deps.record ? { record: deps.record } : {}) },
    ).catch(() => undefined);
  }
  return result;
}

/** A READ workflow's run as the read path's SourceFetch: its first output, under the address it came from. */
export function workflowRunAsFetch(requestedUrl: string, run: WorkflowRun): SourceFetch {
  const out = Object.values(run.outputs)[0];
  if (run.outcome === 'OK' && out) {
    return {
      readable: true,
      requestedUrl,
      finalUrl: out.url,
      status: 200,
      contentType: out.contentType,
      retrievedAt: run.startedAt,
      sha256: out.sha256,
      text: out.text,
      truncated: out.truncated,
      totalChars: out.totalChars,
    };
  }
  const detail = run.boundary
    ? `operated workflow "${run.name}" stopped at ${run.boundary}${run.handoff ? `: ${run.handoff}` : ''}`
    : `operated workflow "${run.name}" ${run.interfaceChanged ? 'no longer fits the interface' : 'did not complete'}`;
  return {
    readable: false,
    requestedUrl,
    finalUrl: run.finalUrl,
    status: null,
    retrievedAt: run.startedAt,
    reason: run.boundary === 'CAPTCHA' ? 'EMPTY' : run.boundary === 'ADDRESS_NOT_PUBLIC' ? 'ADDRESS_NOT_PUBLIC' : 'NETWORK_ERROR',
    detail: detail.slice(0, 200),
  };
}
