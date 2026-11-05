/**
 * The free research lane: commercial research that Claude routines no longer
 * take (§84) is done by the free models behind the cheap lane (OmniRoute),
 * through exactly the queue, tools and gates a routine uses (§85).
 *
 * Why this exists. Brain-only mode parked every non-Brain bin as
 * WAITING_FOR_FREE_LANE, and nothing waited for it: the cheap lane answered
 * closed screening tasks and no worker of any kind drained research items for
 * it. The work was displaced with no replacement, which is the defect §85
 * records and `laneCoverage` now refuses.
 *
 * What it is. A Brain-side worker — two of them, one per configured model — that
 * claims research work items of PLAY_RESEARCH and GRUNT bins from the ordinary
 * queue (`claimWork`, the same compare-and-swap, the same audit-independence
 * admission) and answers each through the ordinary MCP tool handlers
 * (`findTool(...).run`), so every submission is authorized, validated, gated and
 * idempotent exactly as a routine's is. Nothing here decides what is evidence:
 *
 *   - sources are opened by Brain itself (`fetchForWorker`), never recalled by
 *     the model, and a claim whose quoted passage is not in the page Brain
 *     fetched is dropped before submission (code-first, not model-first);
 *   - the evidence gate, the verification gate and the audit decide acceptance;
 *   - a refusal from a tool is fed back to the model once, then the item is
 *     failed retryably and the queue's own backoff and attempt budget apply.
 *
 * Independence. A session is one worker, one packet, one role — the same shape
 * as a fresh routine session per role, and never the same context reused. Where
 * two models are configured, research and synthesis go to the first and
 * verification and the primary and judge audits to the second, so a claim is
 * verified by a different model than found it.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { CONNECTOR_SCOPES, type ClaimedWork, type Principal, type WorkItemRow } from '../../domain/types.ts';
import { createWorker, getWorkerByName, grantMembership, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { claimWork } from '../../repos/workQueue.ts';
import { completeUnleasedBin, getBin, recordBinEvent } from '../../repos/bins.ts';
import { evaluateContract } from '../bins/contracts.ts';
import { findTool } from '../../mcp/tools.ts';
import { workerIdentity } from '../identity/authenticate.ts';
import { auditAdmission } from '../research/auditAdmission.ts';
import { webSearch } from '../sources/discover.ts';
import { httpCompleter, laneConfig, type Completer, type LaneConfig } from '../cheap/lane.ts';
import type { SourceFetch } from '../sources/fetchForWorker.ts';
import { readSource } from '../sources/access.ts';

/** The research work types the free lane answers, and the tool that answers each. */
export const FREE_LANE_WORK_TYPES = [
  'RESEARCH_PLAN',
  'RESEARCH_FRAGMENT',
  'RESEARCH_VERIFY',
  'RESEARCH_SYNTHESIZE',
  'RESEARCH_AUDIT',
] as const;
export type FreeLaneWorkType = (typeof FREE_LANE_WORK_TYPES)[number];

/**
 * The purposes whose work is the free lane's (§84, §85). Never legal; Brain's own only for the
 * improvement loop's research, and only while its activation gate is ACTIVE (`freeLaneAdmits`).
 */
export const FREE_LANE_PURPOSES = ['PLAY_RESEARCH', 'GRUNT'] as const;

const WORKER_NAMES = ['free-lane-a', 'free-lane-b'] as const;
const LEASE_MS = 20 * 60_000;
const MAX_SOURCES = 6;
const SOURCE_CHARS = 7_000;

/**
 * Hosts Brain could not reach (DNS, connect, timeout), remembered for a while so the next
 * fragment does not spend its candidates and its attempt on a door already known shut.
 * Only a host-level refusal counts: a 404, a non-text page or an empty one says nothing
 * about the host. In-process and TTL-bounded; a success on the host forgives it at once.
 */
const UNREACHABLE_TTL_MS = 10 * 60_000;
/** Refusals that say the host is shut: one is enough. */
const HOST_LEVEL_REFUSALS = new Set<string>(['DNS_FAILED', 'NETWORK_ERROR']);
/**
 * A timeout is also what a slow but live host does, so one is a strike, not a verdict: the host is
 * remembered only when a second timeout lands inside the TTL of the first.
 */
const TIMEOUT_REASON = 'TIMEOUT';
const unreachableHosts = new Map<string, number>();
const timeoutStrikes = new Map<string, number>();

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function rememberUnreachable(url: string, reason: string, now = Date.now()): void {
  const host = hostOf(url);
  if (!host) return;
  if (HOST_LEVEL_REFUSALS.has(reason)) {
    unreachableHosts.set(host, now + UNREACHABLE_TTL_MS);
    return;
  }
  if (reason === TIMEOUT_REASON) {
    const first = timeoutStrikes.get(host);
    if (first !== undefined && first > now) {
      unreachableHosts.set(host, now + UNREACHABLE_TTL_MS);
      timeoutStrikes.delete(host);
    } else {
      timeoutStrikes.set(host, now + UNREACHABLE_TTL_MS);
    }
  }
}

/** A readable page from the host clears its strikes and its memory. */
export function forgiveHost(url: string): void {
  const host = hostOf(url);
  if (!host) return;
  unreachableHosts.delete(host);
  timeoutStrikes.delete(host);
}

export function isRememberedUnreachable(url: string, now = Date.now()): boolean {
  const host = hostOf(url);
  if (!host) return false;
  const until = unreachableHosts.get(host);
  if (until === undefined) return false;
  if (until <= now) {
    unreachableHosts.delete(host);
    return false;
  }
  return true;
}

export function rememberedUnreachableHosts(now = Date.now()): string[] {
  return [...unreachableHosts].filter(([, until]) => until > now).map(([host]) => host);
}

export function resetUnreachableHosts(): void {
  unreachableHosts.clear();
  timeoutStrikes.clear();
}

export interface FreeWorker {
  workerId: string;
  label: string;
  model: string;
}

export interface FreeLaneOptions {
  completer?: Completer;
  fetchSource?: (url: string) => Promise<SourceFetch>;
  /** Candidate pages from a free public search. Wikipedia's API by default. */
  search?: (query: string) => Promise<string[]>;
  config?: LaneConfig | null;
  /** Items each slot may take this tick. */
  perWorker?: number;
  /** Concurrent slots per worker (default 2, at most 4). Each slot is one model call at a time. */
  slots?: number;
}

/* ------------------------------------------------------------------------- */
/* Identity                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The free workers, one per configured model (two at most). Real worker rows,
 * created once, so every lease, pass and event names who did the work.
 */
export async function ensureFreeWorkers(config: LaneConfig): Promise<FreeWorker[]> {
  const models = config.models.length > 1 ? config.models.slice(0, 2) : [config.models[0] ?? 'auto'];
  const out: FreeWorker[] = [];
  for (let i = 0; i < models.length; i += 1) {
    const name = WORKER_NAMES[i]!;
    let worker = await getWorkerByName(name);
    if (!worker) {
      worker = await createWorker({
        name,
        displayName: name,
        createdByType: 'SYSTEM',
        createdById: 'free research lane (§85)',
      });
    }
    out.push({ workerId: worker.id, label: workerIdentity(worker), model: models[i]! });
  }
  return out;
}

/**
 * Membership on every project that holds free-lane work — the same scopes a
 * routine connector holds, granted by Brain to its own worker, and only where
 * there is work for it. Idempotent: an existing grant is not rewritten.
 */
async function ensureMemberships(worker: FreeWorker): Promise<string[]> {
  const projects = (
    await getDb().all<{ project_id: string }>(
      `SELECT DISTINCT project_id FROM bins
        WHERE purpose IN ('PLAY_RESEARCH', 'GRUNT') AND state IN ('READY', 'LEASED', 'NEEDS_HUMAN')`,
      [],
    )
  ).map((row) => row.project_id);
  // §87: while the activation gate is ACTIVE, also the project holding the improvement loop's own research.
  const { improvementResearchProjects } = await import('../improvement/activation.ts');
  for (const projectId of await improvementResearchProjects()) if (!projects.includes(projectId)) projects.push(projectId);
  const held = new Set(
    (await listMembershipsForPrincipal('WORKER', worker.workerId)).filter((m) => m.active).map((m) => m.projectId),
  );
  for (const projectId of projects) {
    if (held.has(projectId)) continue;
    await grantMembership({
      projectId,
      principalType: 'WORKER',
      principalId: worker.workerId,
      role: 'MEMBER',
      scopes: [...CONNECTOR_SCOPES],
      grantedByType: 'SYSTEM',
      grantedById: 'free research lane (§85)',
    });
    held.add(projectId);
  }
  return [...held];
}

/** One worker, one packet, one role: the session an item is answered in. */
export function sessionFor(worker: FreeWorker, item: Pick<WorkItemRow, 'orchestration_id' | 'work_type' | 'payload'>): string {
  let role: string = item.work_type;
  if (item.work_type === 'RESEARCH_AUDIT') {
    try {
      role = `AUDIT_${String((JSON.parse(item.payload) as Record<string, unknown>)['role'] ?? '')}`;
    } catch {
      role = 'AUDIT_';
    }
  }
  const key = `${worker.workerId}|${item.orchestration_id ?? '-'}|${role}`;
  return `cse_free_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function principalFor(worker: FreeWorker, projectIds: string[], sessionRef: string): Principal {
  return {
    type: 'WORKER',
    id: worker.workerId,
    handle: worker.label,
    displayName: worker.label,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: sessionRef,
    authMethod: 'WORKER_BEARER',
    memberships: projectIds.map(
      (projectId) =>
        ({
          projectId,
          principalType: 'WORKER',
          principalId: worker.workerId,
          role: 'MEMBER',
          scopes: [...CONNECTOR_SCOPES],
          active: true,
        }) as unknown as Principal['memberships'][number],
    ),
    requestId: `req_${sessionRef}`,
  } as Principal;
}

/* ------------------------------------------------------------------------- */
/* Which items are the free lane's                                            */
/* ------------------------------------------------------------------------- */

/** The newest bin owning an item, and its purpose. */
/**
 * A work item's owning purpose, cached ten minutes. The claim window pages past
 * work the lane declines (`claimWork`), so an idle slot can ask about dozens of
 * items every pass; on a saturated database that must not be a query each.
 */
const purposeCache = new Map<string, { at: number; purpose: string | null }>();
const PURPOSE_TTL_MS = 10 * 60_000;

async function owningPurpose(item: Pick<WorkItemRow, 'bin_id' | 'orchestration_id'>): Promise<string | null> {
  const key = item.bin_id ?? item.orchestration_id ?? null;
  if (!key) return null;
  const cacheKey = `${item.bin_id ? 'b' : 'o'}:${key}`;
  const hit = purposeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PURPOSE_TTL_MS) return hit.purpose;
  const owner = item.bin_id ? 'b.id = ?' : 'b.orchestration_id = ?';
  const row = await getDb().get<{ purpose: string | null }>(
    `SELECT b.purpose FROM bins b WHERE ${owner} ORDER BY b.created_at DESC LIMIT 1`,
    [key],
  );
  const purpose = row?.purpose ?? null;
  if (purposeCache.size > 5000) purposeCache.clear();
  // An item with no bin yet may get one: only a found purpose is remembered.
  if (purpose !== null) purposeCache.set(cacheKey, { at: Date.now(), purpose });
  return purpose;
}

export function resetPurposeCache(): void {
  purposeCache.clear();
}

/**
 * Whether the free lane may take this item: commercial research always, and
 * Brain's own only for the improvement loop's method research while its
 * activation gate is ACTIVE, within that gate's lease cap (§87, `activation.ts`).
 */
export async function freeLaneAdmits(item: Pick<WorkItemRow, 'id' | 'bin_id' | 'orchestration_id'>): Promise<boolean> {
  const purpose = await owningPurpose(item);
  if (purpose !== null && (FREE_LANE_PURPOSES as readonly string[]).includes(purpose)) return true;
  if (purpose !== 'BRAIN_IMPROVEMENT') return false;
  const { freeLaneMayTakeImprovement } = await import('../improvement/activation.ts');
  return freeLaneMayTakeImprovement(item);
}

/** Which worker takes which role, so verification is not done by the model that found the claim. */
function workerFor(workers: FreeWorker[], item: Pick<WorkItemRow, 'work_type' | 'payload'>): number {
  if (workers.length < 2) return 0;
  if (item.work_type === 'RESEARCH_VERIFY') return 1;
  if (item.work_type === 'RESEARCH_AUDIT') {
    const role = (() => {
      try {
        return String((JSON.parse(item.payload) as Record<string, unknown>)['role'] ?? '');
      } catch {
        return '';
      }
    })();
    return role === 'ADVERSARIAL' ? 0 : 1;
  }
  return 0;
}

/* ------------------------------------------------------------------------- */
/* The model                                                                  */
/* ------------------------------------------------------------------------- */

/** The first JSON object in a model's reply, or null. Fenced or bare. */
export function firstJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A tool's input schema with the lease fields and the long prose removed, for a model to fill. */
export function schemaForModel(toolName: string, pick?: string): unknown {
  const tool = findTool(toolName);
  if (!tool) return {};
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'description' && typeof value === 'string' && value.length > 240) {
        out[key] = `${value.slice(0, 240)}…`;
        continue;
      }
      out[key] = strip(value);
    }
    return out;
  };
  const schema = strip(tool.inputSchema) as { properties?: Record<string, unknown>; required?: string[] };
  const props = { ...(schema.properties ?? {}) };
  for (const lease of ['work_item_id', 'lease_id', 'lease_generation', 'idempotency_key']) delete props[lease];
  if (pick) return props[pick] ?? {};
  return { type: 'object', properties: props, required: (schema.required ?? []).filter((r) => r in props) };
}

const SYSTEM =
  'You are a careful research worker for a research platform. You answer with ONE JSON object and ' +
  'nothing else. You never invent sources, URLs, figures or quotes: every quoted passage must be ' +
  'copied character for character from the source text you were given. When the evidence does ' +
  'not establish something, say so plainly instead of guessing.';

async function ask(
  completer: Completer,
  config: LaneConfig,
  model: string,
  prompt: string,
  onFail: (why: string) => void = () => undefined,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text = '';
    try {
      text = await completer({ ...config, timeoutMs: 180_000 }, model, SYSTEM, prompt, { maxTokens: 8000 });
    } catch (error) {
      onFail(`model call failed: ${String((error as Error).message ?? error).slice(0, 200)}`);
      continue;
    }
    const parsed = firstJson(text);
    if (parsed) return parsed;
    onFail(`no JSON in a ${text.length}-character reply`);
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Sources, opened by Brain                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Whitespace and typography only: curly quotes, dashes, non-breaking spaces and
 * ellipses are how a page and a model's copy of it differ without the words
 * differing. The words themselves must still match exactly.
 */
const normal = (s: string): string =>
  s
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2000-\u200B\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Whether a quoted passage is really in the text Brain fetched. */
export function quotedIn(excerpt: string, text: string): boolean {
  const needle = normal(excerpt);
  return needle.length >= 12 && normal(text).includes(needle);
}

/** A page as sentences, for citing by number. Bounded, and short fragments dropped. */
export function sentencesOf(text: string, max = 90): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\u201C])|\n{1,}/)
    .map((one) => one.replace(/\s+/g, ' ').trim())
    .filter((one) => one.length >= 20 && one.length <= 700)
    .slice(0, max);
}

type Citation =
  | { ok: true; url: string; excerpt: string; locator: string }
  | { ok: false; why: 'unparseable' | 'out of range' };

/** One reference as a model wrote it: an optional source, a sentence, and an optional end of a range. */
const REF = /S?(\d+)(?:\.(\d+))?(?:\s*(?:-|\u2013|\u2014|to)\s*S?(?:(\d+)\.)?(\d+))?/gi;

/** The S-form alone: "S2.3", "S1.3-S1.5". Unlike a bare number, it cannot be a year or a count in prose. */
const SFORM = new RegExp(REF.source.replace(/^S\?/, 'S'), 'gi');

/** Every reference in a citation value: 3, "3", "S2.3", "[S2.3]", "S1.3, S1.4", "S1.3-S1.5", "3-5", "sentences 3 and 4". */
function referencesIn(value: unknown): { source: number | null; from: number; to: number }[] {
  const texts = Array.isArray(value) ? value.flat(Infinity) : [value];
  const refs: { source: number | null; from: number; to: number }[] = [];
  for (const text of texts) {
    if (text === undefined || text === null || typeof text === 'object') continue;
    // A value that is only references ("3", "S1.3, S1.4", "sentences 3 and 4") is read whole; a value with
    // other words in it ("published in 2019") is read only where a reference says it is one (the S-form).
    const bare = String(text).replace(/\b(?:sentences?|sent\.?|and|or)\b|[[\](){}&;,]/gi, ' ').trim();
    const onlyRefs = bare !== '' && bare.replace(REF, '').trim() === '';
    for (const m of String(text).matchAll(onlyRefs ? REF : SFORM)) {
      const dotted = m[2] !== undefined;
      const from = Number(dotted ? m[2] : m[1]);
      const to = m[4] !== undefined ? Number(m[4]) : from;
      refs.push({ source: dotted ? Number(m[1]) : null, from, to: to >= from && to - from < 4 ? to : from });
    }
  }
  return refs.filter((r) => Number.isInteger(r.from) && r.from >= 1);
}

/** The source number a claim names: 3, "SOURCE 3", "SOURCE 3 \u2014 url", or the url itself. */
function sourceNumber(value: unknown, numbered: { url: string }[]): number | null {
  if (value === undefined || value === null) return null;
  const given = String(value).trim();
  const byUrl = numbered.findIndex((one) => given !== '' && (given === one.url || given.includes(one.url)));
  if (byUrl >= 0) return byUrl + 1;
  const m = /^(?:SOURCE\s*)?S?(\d+)\b/i.exec(given);
  return m ? Number(m[1]) : null;
}

function resolveCitation(claim: Record<string, unknown>, numbered: { url: string; sentences: string[] }[]): Citation {
  const refs = referencesIn(claim['sentences']);
  if (refs.length === 0) return { ok: false, why: 'unparseable' };
  // The explicit source wins, then the S-form's own source, then the only source there is.
  const sourceNo = sourceNumber(claim['source'], numbered) ?? refs.find((r) => r.source !== null)?.source ?? (numbered.length === 1 ? 1 : NaN);
  const source = Number.isInteger(sourceNo) ? numbered[sourceNo - 1] : undefined;
  if (!source) return { ok: false, why: 'out of range' };
  const picks: number[] = [];
  for (const r of refs) {
    if (r.source !== null && r.source !== sourceNo) continue;
    for (let n = r.from; n <= r.to; n += 1) picks.push(n);
  }
  const chosen = [...new Set(picks)].sort((a, b) => a - b).slice(0, 4);
  const lines = chosen.map((n) => source.sentences[n - 1]).filter((one): one is string => typeof one === 'string');
  if (lines.length === 0) return { ok: false, why: 'out of range' };
  const excerpt = lines.join(' ').slice(0, 800);
  return { ok: true, url: source.url, excerpt, locator: `sentence${chosen.length > 1 ? 's' : ''} ${chosen.join(', ')}` };
}

/** The verbatim excerpt a claim cites by sentence number, or null. Brain copies the sentences; the model never retypes them. */
export function citedExcerpt(
  claim: Record<string, unknown>,
  numbered: { url: string; sentences: string[] }[],
): { url: string; excerpt: string; locator: string } | null {
  const found = resolveCitation(claim, numbered);
  return found.ok ? { url: found.url, excerpt: found.excerpt, locator: found.locator } : null;
}

/** Why a citation was dropped, so the recorded failure says which kind it was. */
export function citationFailure(claim: Record<string, unknown>, numbered: { url: string; sentences: string[] }[]): string {
  const found = resolveCitation(claim, numbered);
  return found.ok ? 'cited' : found.why === 'out of range' ? 'cited sentences outside the page' : 'citation not readable as sentence numbers';
}

/**
 * Candidate pages for a query: a real web search first (`sources/discover.ts`),
 * then Wikipedia's API. Candidates only; Brain reads each page itself.
 *
 * Until 2026-11-04 the lane had only Wikipedia and whatever URLs the model
 * remembered, and remembered deep links were the largest cause of "no
 * readable source" (most 404s on official sites had never existed).
 */
export async function discoverCandidates(query: string): Promise<string[]> {
  const [web, wiki] = await Promise.all([webSearch(query), wikipediaCandidates(query)]);
  return [...web.slice(0, 6), ...wiki];
}

/** Free, keyless public search: Wikipedia's own API. Candidates only; Brain reads each page itself. */
export async function wikipediaCandidates(query: string): Promise<string[]> {
  try {
    const url =
      'https://en.wikipedia.org/w/api.php?action=opensearch&limit=3&namespace=0&format=json&search=' +
      encodeURIComponent(query.slice(0, 200));
    const response = await fetch(url, {
      headers: { 'user-agent': 'Brain research lane (public API)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown[];
    const links = Array.isArray(body[3]) ? (body[3] as unknown[]) : [];
    return links.filter((one): one is string => typeof one === 'string').slice(0, 2);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------- */
/* One item                                                                   */
/* ------------------------------------------------------------------------- */

export type ItemOutcome = 'SUBMITTED' | 'FAILED_RETRYABLE' | 'RELEASED';

interface Ctx {
  worker: FreeWorker;
  principal: Principal;
  claimed: ClaimedWork;
  completer: Completer;
  fetchSource: (url: string) => Promise<SourceFetch>;
  search: (query: string) => Promise<string[]>;
  config: LaneConfig;
  /** Why the item was not answered, for its event. Never a payload or a credential. */
  why: string;
  /** How sources were found for a fragment: search results, and which of the read pages came from them. */
  discovery?: { searched: number; readFromSearch: number; readFromModel: number };
}

/** `ask` for one item, recording why on the item when the model gives nothing usable. */
async function askFor(ctx: Ctx, prompt: string): Promise<Record<string, unknown> | null> {
  return ask(ctx.completer, ctx.config, ctx.worker.model, prompt, (why) => {
    ctx.why = why;
  });
}

async function call(ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const found = findTool(tool);
  if (!found) throw new Error(`no tool ${tool}`);
  const outcome = await found.run(args, { principal: ctx.principal, requestId: `req_${Math.random().toString(36).slice(2)}` });
  return outcome.value;
}

function proof(ctx: Ctx): Record<string, unknown> {
  return {
    work_item_id: ctx.claimed.workItemId,
    lease_id: ctx.claimed.leaseId,
    lease_generation: ctx.claimed.leaseGeneration,
  };
}

/** Submit through a tool; on a refusal, show the model the refusal once and try again. */
async function submitWithRepair(
  ctx: Ctx,
  tool: string,
  first: Record<string, unknown>,
  repairPrompt: (error: string, previous: Record<string, unknown>) => string,
  finalize?: (answer: Record<string, unknown>) => Record<string, unknown> | null,
  /**
   * When Brain's own checks drop every claim, show the model why and ask once more.
   * Production, 2026-11-05: WORK_FAULTED was the largest gate block (34 of 65) —
   * fragments whose attempts were spent on answers whose citations did not parse,
   * with the model never told what was wrong. The second answer meets exactly the
   * same checks; nothing about the evidence bar changes.
   */
  dropRepair?: (why: string, previous: Record<string, unknown>) => string,
): Promise<boolean> {
  let answer: Record<string, unknown> | null = first;
  let repairedDrop = false;
  for (let attempt = 0; attempt < 2 && answer; attempt += 1) {
    const args = finalize ? finalize(answer) : answer;
    if (!args) {
      // A finalizer that said why keeps its reason.
      if (!ctx.why.startsWith('the answer did not survive')) {
        ctx.why = 'the answer did not survive Brain\'s own checks (unquoted, uncited or empty)';
      }
      if (dropRepair && !repairedDrop) {
        repairedDrop = true;
        const dropWhy = ctx.why;
        answer = await askFor(ctx, dropRepair(dropWhy, answer));
        if (!answer) return false;
        attempt -= 1; // a dropped answer was never submitted, so it does not spend the refusal repair
        continue;
      }
      return false;
    }
    try {
      await call(ctx, tool, { ...args, ...proof(ctx) });
      return true;
    } catch (error) {
      ctx.why = `${tool} refused: ${String((error as Error).message ?? error).slice(0, 300)}`;
      if (attempt === 1) return false;
      answer = await askFor(ctx, repairPrompt(String((error as Error).message ?? error).slice(0, 1500), answer));
    }
  }
  return false;
}

async function complete(ctx: Ctx, summary: string): Promise<void> {
  try {
    await call(ctx, 'brain_complete_work', { ...proof(ctx), summary });
  } catch {
    // Already finished by the submission, or not current: the record stands.
  }
}

/** The parts of an assignment's guidance a source search can act on, bounded. Pure. */
export function guidanceBrief(guidance: unknown): Record<string, unknown> {
  if (!guidance || typeof guidance !== 'object') return {};
  const g = guidance as { unreachableHosts?: { host: string }[]; readableRoutes?: { host: string; lines: string[] }[]; searchStrategy?: string };
  const out: Record<string, unknown> = {};
  const hosts = (g.unreachableHosts ?? []).map((h) => h.host).filter(Boolean).slice(0, 10);
  if (hosts.length) out['hostsBrainCannotRead'] = hosts;
  const routes = (g.readableRoutes ?? []).slice(0, 4).map((r) => ({ host: r.host, routes: r.lines.slice(0, 3) }));
  if (routes.length) out['readableRoutes'] = routes;
  if (typeof g.searchStrategy === 'string' && g.searchStrategy.trim()) out['searchStrategy'] = g.searchStrategy.slice(0, 600);
  return out;
}

async function fragment(ctx: Ctx, assignment: Record<string, unknown>): Promise<boolean> {
  const frag = (assignment['fragment'] ?? {}) as Record<string, unknown>;
  const lanes = ((frag['requiredEvidence'] as { id: string; description: string }[] | undefined) ?? []).map((lane) => ({
    id: lane.id,
    description: lane.description,
  }));
  const question = String(frag['question'] ?? '');
  const brief = {
    question,
    packet: (assignment['orchestration'] as Record<string, unknown> | undefined)?.['assignment'] ?? null,
    scope: {
      geography: frag['geography'] ?? null,
      timeframe: frag['timeframe'] ?? null,
      population: frag['population'] ?? null,
      definitions: frag['definitions'] ?? null,
    },
    evidenceLanes: lanes,
    acceptableSourceTypes: frag['acceptableSourceTypes'] ?? [],
    excludedSourceTypes: frag['excludedSourceTypes'] ?? [],
    prohibitedEvidence: frag['prohibitedEvidence'] ?? [],
    // A repair attempt says why the last one failed and what to do differently (invariant 16);
    // the guidance Brain computed for this fragment says which hosts it could not read and which
    // routes it can. Both were dropped here until 2026-11-04, so a repair repeated its parent.
    ...(frag['repairReason'] ? { repair: { reason: frag['repairReason'], strategy: frag['repairStrategy'] ?? null } } : {}),
    ...guidanceBrief(assignment['guidance']),
  };

  const unreachableNote = (): string => {
    const hosts = rememberedUnreachableHosts();
    return hosts.length > 0 ? `Brain cannot reach these hosts at all, so name no page on them: ${JSON.stringify(hosts)}. ` : '';
  };
  // 1. Candidates: the model names primary pages it knows; Wikipedia's API adds two. Brain opens them all.
  const plan = await ask(
    ctx.completer,
    ctx.config,
    ctx.worker.model,
    `Research brief:\n${JSON.stringify(brief, null, 1)}\n\nName up to ${MAX_SOURCES} specific public web pages ` +
      'most likely to contain primary evidence for this question (official statistics, regulators, company ' +
      'filings, published price lists, trade bodies). Prefer exact page URLs you are confident exist. ' +
      unreachableNote() +
      'Reply as {"urls":["https://..."],"search":"a short search phrase"}.',
  );
  const urlsOf = (answer: Record<string, unknown> | null): string[] =>
    Array.isArray(answer?.['urls']) ? (answer!['urls'] as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  const searched = [
    ...(await ctx.search(String(plan?.['search'] ?? question))),
    ...(await ctx.search(question)),
  ];
  const tried = new Set<string>();
  const skipped = new Set<string>();
  const failedUrls: string[] = [];
  const fetchReasons: string[] = [];
  const fetchDetails: string[] = [];
  const readable: { url: string; text: string }[] = [];
  const open = async (urls: string[]): Promise<void> => {
    for (const url of urls) {
      if (readable.length >= MAX_SOURCES) return;
      if (!/^https?:\/\//i.test(url) || tried.has(url)) continue;
      tried.add(url);
      if (isRememberedUnreachable(url)) {
        skipped.add(url);
        fetchReasons.push('HOST_UNREACHABLE');
        continue;
      }
      const fetched = await ctx.fetchSource(url);
      const host = hostOf(url);
      if (fetched.readable && host) forgiveHost(url);
      if (!fetched.readable) rememberUnreachable(url, String(fetched.reason));
      if (fetched.readable && fetched.text.trim().length > 200) {
        readable.push({ url: fetched.finalUrl, text: fetched.text.slice(0, SOURCE_CHARS) });
      } else {
        failedUrls.push(url);
        fetchReasons.push(fetched.readable ? 'EMPTY' : String(fetched.reason));
        if (!fetched.readable && fetchDetails.length < 2 && !fetchDetails.includes(fetched.detail)) fetchDetails.push(fetched.detail);
      }
    }
  };
  // Search results first: they are pages that exist. A remembered URL is a guess.
  const fromSearch = new Set(searched);
  await open([...searched, ...urlsOf(plan)]);
  // A second round: show the model what Brain could not open and ask for other pages.
  if (readable.length < 2) {
    const retry = await askFor(
      ctx,
      `Research brief:\n${JSON.stringify(brief, null, 1)}\n\nBrain could not open these pages (missing, blocked or ` +
        `empty): ${JSON.stringify(failedUrls)}. ${unreachableNote()}Name up to ${MAX_SOURCES} OTHER public pages likely to hold primary ` +
        'evidence — prefer stable top-level pages of official bodies, regulators, statistics offices and company ' +
        'sites over deep links. Reply as {"urls":["https://..."]}.',
    );
    await open(urlsOf(retry));
  }
  const readFromSearch = readable.filter((one) => fromSearch.has(one.url)).length;
  ctx.discovery = { searched: fromSearch.size, readFromSearch, readFromModel: readable.length - readFromSearch };
  // A page skipped because its host is known shut was never a candidate Brain could have read.
  const candidates = [...tried].filter((u) => !skipped.has(u));
  if (readable.length === 0) {
    // A model that never answered is a provider failure, not a sourcing one.
    if (!/^(model call failed|no JSON)/.test(ctx.why) || candidates.length > 0) {
      const counts = fetchReasons.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
      ctx.why = `no readable source among ${candidates.length} candidate page(s): ${JSON.stringify(counts)} ${fetchDetails.join(' | ')}`.slice(0, 400);
    }
    return false;
  }

  // 2. Claims, cited by sentence number. Brain copies the sentences itself, so
  //    every excerpt is verbatim by construction: the model never retypes a quote.
  const claimSchema = schemaForModel('brain_submit_claims', 'claims');
  const numbered = readable.map((one) => ({ url: one.url, sentences: sentencesOf(one.text) }));
  const sources = numbered
    .map((one, i) => `SOURCE ${i + 1} — ${one.url}\n${one.sentences.map((t, n) => `[S${i + 1}.${n + 1}] ${t}`).join('\n')}`)
    .join('\n\n---\n\n');
  const prompt =
    `Research brief:\n${JSON.stringify(brief, null, 1)}\n\nSources Brain fetched, split into numbered sentences:\n\n${sources}\n\n` +
    'Extract the material claims these sources establish for the brief. For each claim give "source" (the ' +
    'SOURCE number) and "sentences" (the sentence numbers within that source that state it, e.g. [3,4]); ' +
    'Brain copies those sentences as the quoted evidence, so cite only sentences that say the claim. ' +
    'evidence_lane must be one of ' +
    JSON.stringify(lanes.map((l) => l.id)) +
    '; state geography/timeframe limits inside the claim. Include no claim the sources do not support. ' +
    `Reply as {"claims":[...]} where each claim has "source", "sentences" and the fields of: ${JSON.stringify(claimSchema)}`;
  const answer = await askFor(ctx, prompt);
  const laneIds = new Set(lanes.map((l) => l.id));
  const onlyLane = laneIds.size === 1 ? [...laneIds][0]! : null;
  const finalize = (raw: Record<string, unknown>): Record<string, unknown> | null => {
    const listed = Array.isArray(raw['claims']) ? (raw['claims'] as Record<string, unknown>[]) : [];
    const claims: Record<string, unknown>[] = [];
    const dropped: Record<string, number> = {};
    const drop = (why: string): void => {
      dropped[why] = (dropped[why] ?? 0) + 1;
    };
    for (const c of listed) {
      // With one declared lane there is only one lane a claim can fill; otherwise a
      // lane named by its description rather than its id is still that lane.
      if (onlyLane && !laneIds.has(String(c['evidence_lane']))) c['evidence_lane'] = onlyLane;
      if (!laneIds.has(String(c['evidence_lane']))) {
        const named = String(c['evidence_lane'] ?? '').trim().toLowerCase();
        const match = lanes.find((l) => named.length > 0 && (l.description.toLowerCase() === named || l.id.toLowerCase() === named));
        if (match) c['evidence_lane'] = match.id;
      }
      if (typeof c['claim'] !== 'string') {
        drop('no claim text');
        continue;
      }
      if (laneIds.size > 0 && !laneIds.has(String(c['evidence_lane']))) {
        drop('unknown evidence lane');
        continue;
      }
      const cited = citedExcerpt(c, numbered);
      if (cited) {
        const { source: _s, sentences: _n, ...rest } = c;
        claims.push({ ...rest, source_url: cited.url, evidence_excerpt: cited.excerpt, evidence_locator: cited.locator });
        continue;
      }
      // A model that quoted instead of citing is still held to the page, word for word.
      const source = readable.find((one) => one.url === c['source_url']);
      if (source && typeof c['evidence_excerpt'] === 'string' && quotedIn(String(c['evidence_excerpt']), source.text)) {
        const { source: _s, sentences: _n, ...rest } = c;
        claims.push(rest);
        continue;
      }
      drop(c['sentences'] !== undefined ? citationFailure(c, numbered) : 'no citation and no verbatim quote');
    }
    if (claims.length === 0) {
      ctx.why = `the answer did not survive Brain's own checks: ${listed.length} claim(s) offered, dropped ${JSON.stringify(dropped)}`;
      return null;
    }
    return { claims: claims.slice(0, 25) };
  };
  if (!answer) return false;
  const ok = await submitWithRepair(
    ctx,
    'brain_submit_claims',
    answer,
    (error, previous) => `${prompt}\n\nYour previous answer was refused by Brain: ${error}\nPrevious: ${JSON.stringify(previous).slice(0, 4000)}\nCorrect it.`,
    finalize,
    (why, previous) =>
      `${prompt}\n\nBrain could not use your previous answer: ${why.replace(/^the answer did not survive Brain's own checks: /, '')}. ` +
      'Every claim needs "source" as a SOURCE number and "sentences" as a list of the sentence numbers inside that ' +
      'source that state it — for example {"claim":"…","source":2,"sentences":[4,5],"evidence_lane":"' +
      (lanes[0]?.id ?? 'lane') + '"} for the sentences marked [S2.4] and [S2.5]. Offer only claims a sentence states; ' +
      `if no sentence states anything the brief asks, reply {"claims":[]}.\nPrevious: ${JSON.stringify(previous).slice(0, 3000)}`,
  );
  if (ok) await complete(ctx, `free lane: claims submitted from ${readable.length} source(s)`);
  return ok;
}

async function verify(ctx: Ctx, assignment: Record<string, unknown>): Promise<boolean> {
  const claims = (assignment['claimsToVerify'] as Record<string, unknown>[] | null) ?? [];
  if (claims.length === 0) return false;
  const pages = new Map<string, string>();
  for (const claim of claims) {
    const url = typeof claim['sourceUrl'] === 'string' ? claim['sourceUrl'] : null;
    if (!url || pages.has(url)) continue;
    const fetched = await ctx.fetchSource(url);
    pages.set(url, fetched.readable ? fetched.text.slice(0, SOURCE_CHARS) : `UNREADABLE: ${fetched.reason}`);
  }
  const frag = (assignment['fragment'] ?? {}) as Record<string, unknown>;
  const schema = schemaForModel('brain_submit_verification');
  const prompt =
    `Fragment question: ${String(frag['question'] ?? '')}\nScope: ${JSON.stringify({
      geography: frag['geography'], timeframe: frag['timeframe'], population: frag['population'], definitions: frag['definitions'],
    })}\nEvidence lanes: ${JSON.stringify(frag['requiredEvidence'] ?? [])}\n\nClaims to verify:\n${JSON.stringify(claims, null, 1)}\n\n` +
    `Source pages as Brain fetched them now:\n${[...pages].map(([u, t]) => `URL ${u}\n${t}`).join('\n\n---\n\n')}\n\n` +
    'For each claim decide from the page text alone whether the page supports it and whether its scope ' +
    'matches the fragment. An unreadable page supports nothing. Then judge sufficiency for the fragment and ' +
    `list missing lanes. Reply with one JSON object matching: ${JSON.stringify(schema)}`;
  const answer = await askFor(ctx, prompt);
  if (!answer) return false;
  const known = new Set(claims.map((c) => String(c['claimId'])));
  const finalize = (raw: Record<string, unknown>): Record<string, unknown> | null => {
    const verdicts = (Array.isArray(raw['verdicts']) ? (raw['verdicts'] as Record<string, unknown>[]) : []).filter((v) =>
      known.has(String(v['claim_id'])),
    );
    if (verdicts.length === 0) return null;
    return { ...raw, verdicts };
  };
  const ok = await submitWithRepair(
    ctx,
    'brain_submit_verification',
    answer,
    (error, previous) => `${prompt}\n\nBrain refused your previous answer: ${error}\nPrevious: ${JSON.stringify(previous).slice(0, 4000)}\nCorrect it.`,
    finalize,
  );
  if (ok) await complete(ctx, `free lane: ${claims.length} claim(s) verified against pages Brain fetched`);
  return ok;
}

async function synthesize(ctx: Ctx, assignment: Record<string, unknown>): Promise<boolean> {
  const claims = (assignment['claimsToCite'] as Record<string, unknown>[] | null) ?? [];
  if (claims.length === 0) return false;
  const orchestration = (assignment['orchestration'] ?? {}) as Record<string, unknown>;
  const prompt =
    `Assignment: ${String(orchestration['assignment'] ?? orchestration['title'] ?? '')}\n\n` +
    `Accepted claims (the only evidence you may use):\n${JSON.stringify(claims, null, 1)}\n\n` +
    'Write the research packet as a clear report that answers the assignment from these claims only, citing ' +
    'each claim inline by its claimId in square brackets, e.g. [clm_...]. Say what the evidence does not ' +
    'establish. Reply as {"report":"...","cited_claim_ids":["..."],"still_missing":["..."]}.';
  const answer = await askFor(ctx, prompt);
  if (!answer) return false;
  const known = new Set(claims.map((c) => String(c['claimId'])));
  const finalize = (raw: Record<string, unknown>): Record<string, unknown> | null => {
    const report = typeof raw['report'] === 'string' ? raw['report'] : '';
    const cited = (Array.isArray(raw['cited_claim_ids']) ? (raw['cited_claim_ids'] as unknown[]) : [])
      .map(String)
      .filter((id) => known.has(id));
    if (report.length < 200 || cited.length === 0) return null;
    return {
      report,
      cited_claim_ids: [...new Set(cited)],
      still_missing: Array.isArray(raw['still_missing']) ? (raw['still_missing'] as unknown[]).map(String) : [],
    };
  };
  return submitWithRepair(
    ctx,
    'brain_submit_synthesis',
    answer,
    (error, previous) => `${prompt}\n\nBrain refused your previous answer: ${error}\nPrevious: ${JSON.stringify(previous).slice(0, 4000)}\nCorrect it.`,
    finalize,
  );
}

async function audit(ctx: Ctx, role: string): Promise<boolean> {
  const brief = await call(ctx, 'brain_get_audit_brief', { work_item_id: ctx.claimed.workItemId });
  const key = role.toLowerCase();
  const schema = schemaForModel('brain_submit_audit', key);
  const prompt =
    `You are the ${role} auditor of a research packet. Audit brief (the document, its claim ledger and what ` +
    `it was asked to do):\n${JSON.stringify(brief).slice(0, 60_000)}\n\nJudge it strictly against the brief. ` +
    `Reply as {"${key}": <object>} where the object matches: ${JSON.stringify(schema)}`;
  let raw = await askFor(ctx, prompt);
  /*
   * A long brief is where free models stop answering in JSON. Production,
   * 2026-11-05 09:18–10:18Z: ANALYSIS.AUDIT 5/25 and six packets parked "an audit
   * work item finished without recording anything", each attempt "the model
   * returned no usable JSON" on a brief of up to 60 000 characters. Once, the
   * same audit is asked over a compact brief with a JSON-only instruction; the
   * submission is judged exactly as before.
   */
  if (!raw && /no usable JSON|no JSON/i.test(ctx.why)) {
    const compact =
      `You are the ${role} auditor of a research packet. Audit brief (shortened; the document, its claim ledger ` +
      `and the assignment):\n${JSON.stringify(brief).slice(0, 20_000)}\n\nJudge it strictly against the brief. ` +
      `Reply with ONLY one JSON object, no prose and no code fence: {"${key}": <object>} where the object matches: ` +
      JSON.stringify(schema);
    raw = await askFor(ctx, compact);
  }
  if (!raw) return false;
  // Models often answer with the role's object itself rather than wrapped in it.
  const inner = raw[key] && typeof raw[key] === 'object' ? raw[key] : raw;
  const answer: Record<string, unknown> = { [key]: inner };
  return submitWithRepair(
    ctx,
    'brain_submit_audit',
    answer,
    (error, previous) => `${prompt}\n\nBrain refused your previous answer: ${error}\nPrevious: ${JSON.stringify(previous).slice(0, 4000)}\nCorrect it.`,
    (r) => ({ [key]: r[key] && typeof r[key] === 'object' ? r[key] : r }),
  );
}

async function plan(ctx: Ctx, assignment: Record<string, unknown>): Promise<boolean> {
  const orchestration = (assignment['orchestration'] ?? {}) as Record<string, unknown>;
  const schema = schemaForModel('brain_propose_fragments');
  const prompt =
    `Research assignment: ${String(orchestration['assignment'] ?? '')}\nTitle: ${String(orchestration['title'] ?? '')}\n` +
    `Context Brain holds for it: ${JSON.stringify({
      corrections: assignment['correctionsRequested'] ?? null,
      judge: assignment['recentJudgeCorrections'] ?? null,
      checkpoints: assignment['checkpoints'] ?? [],
    }).slice(0, 8000)}\n\n` +
    'Decompose the assignment into the smallest set of bounded research fragments (usually 2-6) that ' +
    'together answer it. Each fragment asks one answerable question, states its geography, timeframe, ' +
    'population and definitions, and declares the evidence lanes that would settle it and what counts ' +
    `as complete. Reply with one JSON object matching: ${JSON.stringify(schema)}`;
  const answer = await askFor(ctx, prompt);
  if (!answer || !Array.isArray(answer['fragments'])) return false;
  const ok = await submitWithRepair(
    ctx,
    'brain_propose_fragments',
    answer,
    (error, previous) => `${prompt}\n\nBrain refused your previous answer: ${error}\nPrevious: ${JSON.stringify(previous).slice(0, 6000)}\nCorrect it.`,
  );
  if (ok) await complete(ctx, 'free lane: fragments proposed');
  return ok;
}

async function answerItem(ctx: Ctx): Promise<boolean> {
  const type = ctx.claimed.workType;
  if (type === 'RESEARCH_AUDIT') {
    const role = String(ctx.claimed.payload['role'] ?? '');
    return audit(ctx, role);
  }
  const view = await call(ctx, 'brain_get_assignment', { work_item_id: ctx.claimed.workItemId });
  const assignment = (view['assignment'] ?? {}) as Record<string, unknown>;
  if (type === 'RESEARCH_PLAN') return plan(ctx, assignment);
  if (type === 'RESEARCH_FRAGMENT') return fragment(ctx, assignment);
  if (type === 'RESEARCH_VERIFY') return verify(ctx, assignment);
  if (type === 'RESEARCH_SYNTHESIZE') return synthesize(ctx, assignment);
  return false;
}

/* ------------------------------------------------------------------------- */
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

export interface FreeLaneTick {
  configured: boolean;
  workers: number;
  claimed: number;
  submitted: number;
  failed: number;
  byType: Record<string, number>;
  /** Bins closed because their packet filed. */
  closed: number;
}

let running = false;
/**
 * Items handed back after a provider failure, and when they may be taken again,
 * per model: a busy free provider says nothing about the RunPod GPU, so the GPU
 * may take an item the free model just failed on (production 2026-11-05: 29 149
 * claims declined as cooling down while 37 items waited and the lane sat idle).
 * Process-local by design.
 */
const cooldown = new Map<string, number>();
const cooldownKey = (model: string, itemId: string) => `${model}\n${itemId}`;

/**
 * Items no model in the lane may take yet: each is cooling down for every one
 * of `models`. They wait in the queue but nothing will run them, so they are
 * not a reason to keep a paid GPU on (`runpodPod.ts`).
 */
export function coolingForEveryModel(models: string[], now: number = Date.now()): number {
  if (models.length === 0) return 0;
  const byItem = new Map<string, Set<string>>();
  for (const [key, until] of cooldown) {
    if (until <= now) continue;
    const cut = key.indexOf('\n');
    const model = key.slice(0, cut);
    const item = key.slice(cut + 1);
    byItem.set(item, (byItem.get(item) ?? new Set()).add(model));
  }
  let n = 0;
  for (const cooled of byItem.values()) if (models.every((model) => cooled.has(model))) n += 1;
  return n;
}

/** Tests: end every cooldown now, as if its time had passed. Strike counts are kept. */
export function endFreeLaneCooldowns(): void {
  cooldown.clear();
}
const transientStrikes = new Map<string, number>();

/** Models whose recent free-lane items all failed, from the lane's own events. */
async function failingModels(now = Date.now()): Promise<Set<string>> {
  const since = new Date(now - 30 * 60_000).toISOString();
  const rows = await getDb().all<{ reason: string | null; outcome: string; n: number | string }>(
    `SELECT reason, outcome, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY reason, outcome`,
    [since],
  );
  const byModel = new Map<string, { ok: number; bad: number }>();
  for (const row of rows) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0]!;
    const entry = byModel.get(model) ?? { ok: 0, bad: 0 };
    if (row.outcome === 'SUBMITTED') entry.ok += Number(row.n);
    else entry.bad += Number(row.n);
    byModel.set(model, entry);
  }
  return new Set([...byModel].filter(([, e]) => e.ok === 0 && e.bad >= 4).map(([m]) => m));
}

/**
 * Take and answer free-lane items, a few per worker, both workers at once.
 * Never concurrent with itself; a tick that finds the lane unconfigured does
 * nothing and says so, which is what `laneCoverage` reads.
 */
/**
 * The order a slot asks the queue in: later stages first, so a packet already
 * paid for is finished before new research starts and results flow downstream
 * rather than piling up at the front of the pipeline.
 */
const CLAIM_ORDER: readonly (readonly FreeLaneWorkType[])[] = [
  ['RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT', 'RESEARCH_VERIFY'],
  ['RESEARCH_PLAN', 'RESEARCH_FRAGMENT'],
];

/** Memberships, read at most once a minute per worker rather than once per job. */
const membershipCache = new Map<string, { at: number; projects: string[] }>();

/** Forget the memberships read, so the next job re-reads and re-grants them (the activation's recovery). */
export function resetFreeLaneMemberships(): void {
  membershipCache.clear();
}
async function projectsFor(worker: FreeWorker): Promise<string[]> {
  const cached = membershipCache.get(worker.workerId);
  if (cached && Date.now() - cached.at < 60_000) return cached.projects;
  const projects = await ensureMemberships(worker);
  membershipCache.set(worker.workerId, { at: Date.now(), projects });
  return projects;
}

export interface TakeInput {
  workers: FreeWorker[];
  worker: FreeWorker;
  index: number;
  completer: Completer;
  fetchSource: (url: string) => Promise<SourceFetch>;
  search: (query: string) => Promise<string[]>;
  config: LaneConfig;
  /** Take a job whose role prefers the other model, when that model is saturated. */
  spillover?: boolean;
}

/**
 * Claim one free-lane job and answer it. The unit every slot repeats.
 * Returns the claimed job (null when there was none for this slot) and whether
 * Brain accepted the answer.
 */
/** A provider failure that says the provider was busy or unreachable, not that the work was wrong. */
/** Brain's own database or gateway was unavailable: an outage, never the work's fault. */
export const BRAIN_UNAVAILABLE = /database pool had no free connection|Connection terminated due to connection timeout|too many clients|Brain is temporarily busy|database did not answer in time/i;

export const PROVIDER_BUSY = /\b(?:HTTP (?:408|409|425|429|5\d\d)|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|overloaded|rate.?limit)/i;

/**
 * Why the lane declined work it was offered, since the process started: reason → count.
 * A lane that claims nothing while work waits must say why (2026-11-04: three silent hours).
 */
const skipTally = new Map<string, number>();
export function freeLaneSkips(): Record<string, number> {
  return Object.fromEntries([...skipTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
}

export async function takeOne(input: TakeInput): Promise<{ claimed: ClaimedWork | null; ok: boolean; ms: number }> {
  const { workers, worker, index, config } = input;
  const projectIds = await projectsFor(worker);
  if (projectIds.length === 0) return { claimed: null, ok: false, ms: 0 };
  let session = '';
  let one: ClaimedWork | undefined;
  for (const types of CLAIM_ORDER) {
    const claimed = await claimWork({
      workerId: worker.workerId,
      scopes: projectIds.map((projectId) => ({ projectId, scopes: [...CONNECTOR_SCOPES] })),
      workTypes: [...types],
      limit: 1,
      leaseMs: LEASE_MS,
      admit: async (item) => {
        if (!input.spillover && workerFor(workers, item) !== index) {
          return { ok: false, reason: 'the other free worker takes this role' };
        }
        if ((cooldown.get(cooldownKey(worker.model, item.id)) ?? 0) > Date.now()) return { ok: false, reason: 'cooling down after a provider failure' };
        if (!(await freeLaneAdmits(item))) return { ok: false, reason: 'not free-lane work' };
        session = sessionFor(worker, item);
        return auditAdmission({ workerId: worker.workerId, routineId: null, accountId: null, sessionRef: session })(item);
      },
      onSkip: (_item, reason) => {
        const key = reason.slice(0, 80);
        skipTally.set(key, (skipTally.get(key) ?? 0) + 1);
      },
    });
    one = claimed[0];
    if (one) break;
  }
  if (!one) return { claimed: null, ok: false, ms: 0 };
  const started = Date.now();
  const ctx: Ctx = {
    worker,
    principal: principalFor(worker, projectIds, session),
    claimed: one,
    completer: input.completer,
    fetchSource: input.fetchSource,
    search: input.search,
    config,
    why: 'the model returned no usable JSON',
  };
  let ok = false;
  try {
    ok = await answerItem(ctx);
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 300);
    console.warn(`[free-lane] ${one.workType} ${one.workItemId} threw:`, message);
    // The failure is the exception, not the default "no usable JSON" (2026-11-05: every
    // failed audit read that way and the cause was unreadable from the rows).
    ctx.why = `threw: ${message}`;
  }
  const transient = !ok && /^(model call failed|no JSON)/.test(ctx.why);
  /*
   * A provider that is busy or rate-limiting (HTTP 429/5xx, a timeout, a reset)
   * said nothing about the work, however many times it says it. Production,
   * 2026-11-04 02:32Z: in a run of 503/429s an approved goal's deep dive spent
   * both of its screen's attempts on three provider failures each and parked
   * for a person ("finished without recording anything"). So a provider
   * failure always hands the item back with its attempt refunded, the cooldown
   * growing to an hour; only an answer the model returned that held no JSON
   * keeps the three-strike limit, because that one can be the work's fault.
   */
  /*
   * Brain's own database being unavailable says nothing about the work either.
   * Production, 2026-11-05 11:29–11:31Z: audit items threw "The database pool
   * had no free connection … 593 caller(s) waiting", were failed retryably,
   * spent their attempts, and six packets parked "an audit work item finished
   * without recording anything". Treated as a provider outage: refunded, cooled.
   */
  const brainUnavailable = !ok && BRAIN_UNAVAILABLE.test(ctx.why);
  const providerFailure = !ok && ((/^model call failed/.test(ctx.why) && PROVIDER_BUSY.test(ctx.why)) || brainUnavailable);
  const strikes = transient || brainUnavailable ? (transientStrikes.get(one.workItemId) ?? 0) + 1 : 0;
  if (ok) {
    transientStrikes.delete(one.workItemId);
  } else if ((transient || brainUnavailable) && (strikes < 3 || providerFailure)) {
    /*
     * The model or its provider failed, not the work: hand the item back with
     * its attempt refunded, and leave it alone for a while so a provider outage
     * cannot spend the item's attempt budget.
     */
    transientStrikes.set(one.workItemId, strikes);
    cooldown.set(cooldownKey(worker.model, one.workItemId), Date.now() + Math.min(60, 5 * strikes) * 60_000);
    try {
      await call(ctx, 'brain_release_work', { ...proof(ctx), detail: `free lane: ${ctx.why}`.slice(0, 300) });
    } catch {
      // Lease already gone: the queue's expiry returns it.
    }
  } else {
    transientStrikes.delete(one.workItemId);
    try {
      await call(ctx, 'brain_fail_work', {
        ...proof(ctx),
        category: 'WORKER_ERROR',
        retryable: true,
        detail: `free lane (${worker.model}) produced no answer Brain accepted for this ${one.workType}`,
      });
    } catch {
      // Lease already gone: the queue's expiry returns it.
    }
  }
  const ms = Date.now() - started;
  await recordBinEvent({
    eventType: 'FREE_LANE_ITEM',
    projectId: one.projectId,
    workItemId: one.workItemId,
    workerId: worker.workerId,
    sessionRef: session,
    workloadClass: one.workType,
    outcome: ok ? 'SUBMITTED' : (transient || brainUnavailable) && (strikes < 3 || providerFailure) ? 'RELEASED_TRANSIENT' : 'FAILED_RETRYABLE',
    reason: ok ? `model ${worker.model}` : `model ${worker.model}: ${ctx.why}`.slice(0, 480),
    durationMs: ms,
    evidenceClass: 'MEASURED',
    ...(ctx.discovery ? { measures: { discovery: ctx.discovery } } : {}),
  });
  return { claimed: one, ok, ms };
}

export async function freeLaneTick(options: FreeLaneOptions = {}): Promise<FreeLaneTick> {
  const config = options.config === undefined ? laneConfig() : options.config;
  const tick: FreeLaneTick = { configured: Boolean(config), workers: 0, claimed: 0, submitted: 0, failed: 0, byType: {}, closed: 0 };
  if (!config || running) return tick;
  running = true;
  try {
    const all = await ensureFreeWorkers(config);
    /*
     * Reroute: a model whose every free-lane item in the last half hour failed
     * (on enough of them) is skipped, and its roles go to the other model.
     */
    const down = await failingModels();
    const healthy = all.filter((w) => !down.has(w.model));
    const workers = healthy.length > 0 ? healthy : all;
    tick.workers = workers.length;
    const completer = options.completer ?? httpCompleter;
    const fetchSource = options.fetchSource ?? ((url: string) => readSource(url, { caller: 'free-lane' }));
    const perWorker = Math.max(1, options.perWorker ?? 2);

    const slots = Math.max(1, Math.min(64, options.slots ?? 2));
    await Promise.all(
      workers.flatMap((worker, index) => Array.from({ length: slots }, () => ({ worker, index }))).map(async ({ worker, index }) => {
        for (let n = 0; n < perWorker; n += 1) {
          const result = await takeOne({ workers, worker, index, completer, fetchSource, search: options.search ?? discoverCandidates, config });
          if (!result.claimed) return;
          tick.claimed += 1;
          tick.byType[result.claimed.workType] = (tick.byType[result.claimed.workType] ?? 0) + 1;
          if (result.ok) tick.submitted += 1;
          else tick.failed += 1;
        }
      }),
    );
    tick.closed = await closeFiledFreeLaneBins();
  } finally {
    running = false;
  }
  return tick;
}

/**
 * Close every free-lane bin whose packet has filed and whose contract Brain's
 * own rows now satisfy. Returns how many closed.
 */
export async function closeFiledFreeLaneBins(): Promise<number> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT b.id FROM bins b JOIN research_orchestrations o ON o.id = b.orchestration_id
      WHERE (b.purpose IN ('PLAY_RESEARCH', 'GRUNT')
             OR (b.purpose = 'BRAIN_IMPROVEMENT' AND b.kind = 'RESEARCH_PACKET'))
        AND b.completion_contract = 'RESEARCH_PACKET_V1'
        AND b.state IN ('READY', 'NEEDS_HUMAN') AND o.status IN ('COMPLETE', 'COMPLETE_WITH_GAPS')
      LIMIT 50`,
    [],
  );
  let closed = 0;
  for (const row of rows) {
    const bin = await getBin(row.id);
    if (!bin) continue;
    const verdict = await evaluateContract(bin);
    if (!verdict.satisfied) continue;
    if (await completeUnleasedBin(bin.id, bin.leaseGeneration, 'Packet filed by the free research lane; contract satisfied (§85).')) {
      closed += 1;
    }
  }
  return closed;
}

let timer: NodeJS.Timeout | null = null;

/**
 * The lane's own loop, beside the dispatcher. Off when no cheap lane is configured.
 *
 * It starts after a delay rather than at boot, for the self-scan's reason: the
 * minutes after a restart are when the database is busiest and when Deploy's
 * own restart verification runs, and four model-driven slots competing with it
 * made that verification slow enough not to finish (Deploy 41601470270).
 */
export function startFreeLaneLoop(_intervalMs = 30_000, delayMs = 3 * 60_000): void {
  if (timer) return;
  /*
   * §86: the lane is an adaptive pool now, not a fixed tick. Its controller
   * sizes each model's slots from measurements (`capacity.ts`).
   */
  const begin = (): void => {
    void import('./capacity.ts')
      .then(({ startAdaptivePool }) => startAdaptivePool())
      .catch((error) => console.warn('[free-lane] pool did not start:', (error as Error).message));
  };
  const wait = setTimeout(begin, delayMs);
  wait.unref?.();
  timer = wait as unknown as NodeJS.Timeout;
}

export function stopFreeLaneLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
