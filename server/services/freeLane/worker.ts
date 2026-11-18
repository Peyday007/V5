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
import { findingTakesQualifier, isStructuralFinding } from '../../domain/industry.ts';
import { isBrainProject } from '../../domain/binPurpose.ts';
import { createWorker, getWorkerByName, grantMembership, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { CLAIMABLE_SQL, claimWork, queueNow } from '../../repos/workQueue.ts';
import { completeUnleasedBin, getBin, recordBinEvent } from '../../repos/bins.ts';
import { itemMeters, utf8Bytes, type ItemUsage } from './itemMeter.ts';
import { evaluateContract } from '../bins/contracts.ts';
import { findTool } from '../../mcp/tools.ts';
import { MAX_LIST_ITEMS } from '../../mcp/researchTools.ts';
import { workerIdentity } from '../identity/authenticate.ts';
import { auditAdmission } from '../research/auditAdmission.ts';
import { isEncyclopediaPage, readWithoutAnswerFor, rememberReadWithoutAnswer, webSearch, webSearchRefusing } from '../sources/discover.ts';
import { httpCompleter, laneConfig, type Completer, type LaneConfig } from '../cheap/lane.ts';
import { isRunpodSlot, runpodBreakerOpen, runpodCallWindow, runpodPaused } from '../cheap/runpod.ts';
import type { SourceFetch } from '../sources/fetchForWorker.ts';
import { readSource } from '../sources/access.ts';
import { redactCredentials } from '../effects/failureDetail.ts';

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

/**
 * The next pages to open at once: up to `limit`, at most one per host, in the
 * queue's order. Removes them from the queue. A page on a host already in this
 * wave waits for the next one, so a single site never sees a burst. Exported for tests.
 */
export function takeWave(queue: string[], limit: number): string[] {
  const wave: string[] = [];
  const hosts = new Set<string>();
  for (let i = 0; i < queue.length && wave.length < Math.max(1, limit); ) {
    const url = queue[i]!;
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      host = url;
    }
    if (hosts.has(host)) {
      i += 1;
      continue;
    }
    hosts.add(host);
    wave.push(url);
    queue.splice(i, 1);
  }
  return wave;
}
/** The characters of a page's sentences a model is shown (`pageSentences`). */
const SOURCE_CHARS = 7_000;
/** The characters of a page Brain reads to choose them from. */
const PAGE_READ_CHARS = 60_000;

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

/**
 * Only a name the resolver says does not exist is shut on one answer. A temporary resolver
 * failure (EAI_AGAIN — the resolver's threads busy) or a reset connection is what a live host
 * looks like from a loaded machine: production, 2026-11-14, research fragments failing with
 * "no readable source among 0 candidate page(s)" because every host had been marked shut during
 * event-loop stalls. Those count as strikes, like a timeout.
 */
const DEFINITE_ABSENCE = /ENOTFOUND|NXDOMAIN|resolved to no address/i;

export function rememberUnreachable(url: string, reason: string, now = Date.now(), detail = ''): void {
  const host = hostOf(url);
  if (!host) return;
  if (HOST_LEVEL_REFUSALS.has(reason) && reason === 'DNS_FAILED' && DEFINITE_ABSENCE.test(detail)) {
    unreachableHosts.set(host, now + UNREACHABLE_TTL_MS);
    return;
  }
  if (reason === TIMEOUT_REASON || HOST_LEVEL_REFUSALS.has(reason)) {
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
      try {
        worker = await createWorker({
          name,
          displayName: name,
          createdByType: 'SYSTEM',
          createdById: 'free research lane (§85)',
        });
      } catch (error) {
        // Two passes of the pool that both read "no worker" race to write it, and the
        // name is unique, so the second insert is refused (Postgres suite, 2026-11-17:
        // "Key (name)=(free-lane-a) already exists"). The row the first one wrote is the worker.
        worker = await getWorkerByName(name);
        if (!worker) throw error;
      }
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

/**
 * A work item's owning bin and its purpose, cached ten minutes. The claim window
 * pages past work the lane declines (`claimWork`), so an idle slot can ask about
 * dozens of items every pass; on a saturated database that must not be a query
 * each.
 *
 * A research item usually carries no `bin_id` (`workQueue.ts`: `advancePacket`
 * creates fragments, verifications and audits with no bin), so its owner is the
 * newest bin of its orchestration. The same owner is what each `FREE_LANE_ITEM`
 * row is written against, so stage capacity attributes a job to the purpose the
 * lane admitted it for — never to UNATTRIBUTED because the item row had no bin.
 */
interface OwningBin {
  binId: string;
  purpose: string | null;
}
const purposeCache = new Map<string, { at: number; owner: OwningBin | null }>();
const PURPOSE_TTL_MS = 10 * 60_000;
/*
 * An unanswered owner — no bin yet, or a bin with no purpose — is remembered
 * too, for a minute. Only found purposes were, and production 2026-11-12 asked
 * this query 3,057 times in 23 minutes for the same handful of unowned items
 * while the event loop stalled for seconds. A minute is the most an item that
 * just gained a bin waits to be seen as owned.
 */
const UNOWNED_TTL_MS = 60_000;

export async function owningBin(item: Pick<WorkItemRow, 'bin_id' | 'orchestration_id'>): Promise<OwningBin | null> {
  const key = item.bin_id ?? item.orchestration_id ?? null;
  if (!key) return null;
  const cacheKey = `${item.bin_id ? 'b' : 'o'}:${key}`;
  const hit = purposeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < (hit.owner?.purpose ? PURPOSE_TTL_MS : UNOWNED_TTL_MS)) return hit.owner;
  const owner = item.bin_id ? 'b.id = ?' : 'b.orchestration_id = ?';
  const row = await getDb().get<{ id: string; purpose: string | null }>(
    `SELECT b.id, b.purpose FROM bins b WHERE ${owner} ORDER BY b.created_at DESC LIMIT 1`,
    [key],
  );
  const found: OwningBin | null = row ? { binId: row.id, purpose: row.purpose ?? null } : null;
  if (purposeCache.size > 5000) purposeCache.clear();
  // An item with no bin yet may get one, so an unowned answer expires sooner.
  purposeCache.set(cacheKey, { at: Date.now(), owner: found });
  return found;
}

async function owningPurpose(item: Pick<WorkItemRow, 'bin_id' | 'orchestration_id'>): Promise<string | null> {
  return (await owningBin(item))?.purpose ?? null;
}

export function resetPurposeCache(): void {
  purposeCache.clear();
  brainProjectCache.clear();
}

/**
 * Whether the free lane may take this item: commercial research always, and
 * Brain's own only for the improvement loop's method research while its
 * activation gate is ACTIVE, within that gate's lease cap (§87, `activation.ts`).
 */
export async function freeLaneAdmits(
  item: Pick<WorkItemRow, 'id' | 'bin_id' | 'orchestration_id'> & { project_id?: string | null },
): Promise<boolean> {
  const purpose = await owningPurpose(item);
  if (purpose !== null && (FREE_LANE_PURPOSES as readonly string[]).includes(purpose)) return true;
  /*
   * No purpose: no bin owns the item, or its bin was never tagged (the retag
   * pass reads live bins only). Production, 2026-11-17 (cash report, Cash Mode
   * 1): 28 research items, fragments and a plan, sat QUEUED at 0 attempts for
   * up to two months under RESEARCHING packets with no mission and no bin.
   * Routines refuse a bin-less item outside Brain's own projects
   * (`workItemPurposeAdmits`), and this refused every bin-less item, so the two
   * claimants together left one class of work to nobody. The project decides,
   * the same deterministic rule `workItemPurposeAdmits` applies from the other
   * side: Brain's own and technical projects are Claude's, and everything else
   * is commercial research, which is the free lane's (§85). A bin that does
   * carry a purpose still decides, and BLOCKED_LEGAL is never admitted.
   */
  if (purpose === null) return !(await brainProjectItem(item.project_id ?? null));
  if (purpose !== 'BRAIN_IMPROVEMENT') return false;
  const { freeLaneMayTakeImprovement } = await import('../improvement/activation.ts');
  return freeLaneMayTakeImprovement(item);
}

/** Whether an item's project is Brain's own (`isBrainProject`). Unknown counts as Brain's, so it is not taken. */
const brainProjectCache = new Map<string, boolean>();
async function brainProjectItem(projectId: string | null): Promise<boolean> {
  if (!projectId) return true;
  const hit = brainProjectCache.get(projectId);
  if (hit !== undefined) return hit;
  const project = await getDb().get<{ slug: string; purpose: string }>(
    'SELECT slug, purpose FROM projects WHERE id = ?',
    [projectId],
  );
  const brain = project ? isBrainProject(project) : true;
  brainProjectCache.set(projectId, brain);
  return brain;
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

/**
 * Where the bracket opened at `open` closes, or -1: brackets are counted and
 * strings skipped, so prose after the list ("… per [S1]") is not part of it.
 */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return ch === ']' ? i : -1;
    }
  }
  return -1;
}

/**
 * The first JSON object in a model's reply, or null. Fenced or bare.
 *
 * A reasoning model's `<think>…</think>` preamble is not the answer, so it is
 * removed first: its braces or a fenced example in it were read as the reply.
 * A reply that is a top-level array (production, 2026-11-14: Qwen3-4B answered
 * `[{"claim":…}]`, read as one object with no `claims`, or as nothing) is that
 * list, returned as `{claims:[…]}`. What a claim must prove is unchanged.
 *
 * Reasoning is not always closed. A reply cut off inside `<think>` (or one that
 * opens it and never closes it) has no end to strip at, and stripping only a
 * closed block read the reasoning's own braces as the reply — a draft
 * `{"claims":[]}` turned a real answer after it into nothing. There the answer
 * is the last whole JSON value. A reply whose template opened the block, so
 * only `</think>` appears, starts after it.
 */
export function firstJson(text: string): Record<string, unknown> | null {
  let answer = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // A chat template that opens the think block itself leaves only its close in the reply: what precedes it is reasoning.
  const closed = answer.search(/<\/think>(?![\s\S]*<\/think>)/i);
  if (closed >= 0) answer = answer.slice(closed + '</think>'.length);
  // A think block never closed (reasoning cut off) has no boundary: the answer, if any, is its last whole JSON value.
  const unclosed = answer.search(/<think>/i);
  if (unclosed >= 0) return lastJsonValue(answer.slice(unclosed + '<think>'.length));
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(answer);
  const body = fenced ? fenced[1]! : answer;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  const open = body.indexOf('[');
  if (open >= 0 && (start < 0 || open < start)) {
    try {
      const list = JSON.parse(body.slice(open, closingBracket(body, open) + 1)) as unknown;
      if (Array.isArray(list) && list.length > 0 && list.every((one) => one && typeof one === 'object' && !Array.isArray(one))) return { claims: list };
    } catch {
      // Not a list after all ("[S1.2] says …"): read the object below.
    }
  }
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Braces outside the answer: read below.
  }
  /*
   * The first `{` to the last `}` is not one value when prose around the
   * answer has braces of its own ("claim {clm_…}", a closing remark that
   * quotes a field) or when a draft precedes it. Production, 2026-11-17:
   * RESEARCH_VERIFY replies of 2–5k characters were read as "no JSON" and
   * re-asked word for word. The answer is then the last whole JSON value;
   * whatever it holds still meets every check after this.
   */
  return lastJsonValue(answer);
}

/**
 * Why a reply held no JSON Brain could read, in words a report can group by.
 * Pure. Only called on a reply `firstJson` returned null for.
 */
export function replyShape(text: string): string {
  if (text.trim() === '') return 'empty';
  let answer = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const closed = answer.search(/<\/think>(?![\s\S]*<\/think>)/i);
  if (closed >= 0) answer = answer.slice(closed + '</think>'.length);
  if (/<think>/i.test(answer)) return 'reasoning never closed';
  const from = answer.search(/[{[]/);
  if (from < 0) return 'prose only';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < answer.length; i += 1) {
    const ch = answer[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === '{' || ch === '[') depth += 1;
    else if ((ch === '}' || ch === ']') && depth > 0) depth -= 1;
  }
  return depth > 0 || inString ? 'cut off inside its JSON' : 'JSON that does not parse';
}

/**
 * The second ask after a reply that held no JSON. The same prompt again is
 * the same reply again (temperature 0: production 2026-11-17 logged identical
 * 4527-, 4082-, 4855- and 2329-character verify replies on every retry), so the
 * second ask says what was wrong. Nothing about what the answer must contain changes.
 */
export function noJsonRepair(prompt: string, shape: string): string {
  const cut = shape === 'cut off inside its JSON' || shape === 'reasoning never closed';
  return (
    `${prompt}\n\nYour previous reply held no JSON object Brain could read (${shape}). Reply again with ONLY ` +
    'the one JSON object: no prose or reasoning before or after it, and no code fence.' +
    (cut ? ' It ran out of room before the object closed, so keep every free-text field to one short sentence.' : '')
  );
}

/** An object, or a non-empty list of objects as `{claims:[…]}`; anything else is not an answer. */
function asAnswer(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((one) => one && typeof one === 'object' && !Array.isArray(one)) ? { claims: value } : null;
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * The last top-level `{…}` or `[…]` in a text that parses as an answer, or
 * null. Brackets inside JSON strings do not count, so a quote containing "}" or
 * "[S1.2]" does not end or start a value. Used where reasoning was never closed:
 * a draft or an example earlier in it is not the answer, the final value is.
 */
function lastJsonValue(text: string): Record<string, unknown> | null {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if ((ch === '}' || ch === ']') && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push([start, i + 1]);
    }
  }
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const [from, to] = spans[k]!;
    try {
      const answer = asAnswer(JSON.parse(text.slice(from, to)) as unknown);
      if (answer) return answer;
    } catch {
      // Prose in brackets ("[S1.2] says …"), or a value cut off: try the one before.
    }
  }
  return null;
}

/**
 * The claims an answer lists, wherever a model put the list: `claims` in any
 * case, one claim object under `claims`, or an answer that is itself one claim.
 * Production, 2026-11-14: "0 claim(s) offered, dropped {}" was most of the
 * recorded drops. Every claim read here still meets every check after it.
 */
export function listedClaims(raw: Record<string, unknown>): Record<string, unknown>[] {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const key = 'claims' in raw ? 'claims' : Object.keys(raw).find((k) => k.trim().toLowerCase() === 'claims');
  const value = key === undefined ? undefined : raw[key];
  if (Array.isArray(value)) return value.filter(isObject);
  if (isObject(value) && typeof value['claim'] === 'string') return [value];
  if (value === undefined && typeof raw['claim'] === 'string') return [raw];
  return [];
}

/**
 * The verdicts a verification answer lists: under `verdicts`, or a bare list of
 * them (which `firstJson` reads as `{claims:[…]}`). A verdict keyed `claimId` —
 * the key the claims were shown to the model under — is read as `claim_id`.
 * Every verdict read here is still judged by `brain_submit_verification` whole.
 */
export function verdictsOf(raw: Record<string, unknown>): Record<string, unknown>[] {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const named = (v: Record<string, unknown>): boolean => typeof v['claim_id'] === 'string' || typeof v['claimId'] === 'string';
  /*
   * Where a reply puts its verdicts. Production, 2026-11-18 03:17–06:57Z (after
   * #1077): 42 of 55 free-lane attempts that burned an attempt were
   * RESEARCH_VERIFY answers that parsed as JSON and still listed no verdict
   * Brain could read. A verdict under `verdicts` as one object or as a map by
   * claim id, a bare verdict, or one inside the JSON Schema the model was shown
   * (`properties`) is the same verdict wherever it sits; the server judges it whole.
   */
  const listIn = (node: Record<string, unknown>): unknown[] | null => {
    for (const key of ['verdicts', 'claims', 'items']) {
      const value = node[key];
      if (Array.isArray(value)) return value;
      if (isObject(value)) {
        if (named(value)) return [value];
        const entries = Object.entries(value);
        if (entries.length > 0 && entries.every(([, v]) => isObject(v))) {
          return entries.map(([id, v]) => (named(v as Record<string, unknown>) ? v : { claim_id: id, ...(v as Record<string, unknown>) }));
        }
      }
    }
    return named(node) ? [node] : null;
  };
  let list = listIn(raw);
  // One wrapper deep: the schema's own `properties`, or a single key holding the answer.
  if (!list) {
    for (const value of Object.values(raw)) {
      if (isObject(value) && (list = listIn(value))) break;
    }
  }
  return ((list ?? []) as unknown[]).filter(isObject).map((v) => {
    if (v['claim_id'] !== undefined || typeof v['claimId'] !== 'string') return v;
    const { claimId, ...rest } = v;
    return { claim_id: claimId, ...rest };
  });
}

/**
 * Why a verification reply carried no verdict on a claim Brain asked about, in
 * words a report can group by: what it listed and which ids it named. Pure.
 */
export function verdictMissReason(raw: Record<string, unknown>, asked: readonly string[]): string {
  const read = verdictsOf(raw);
  const head = "the answer did not survive Brain's own checks: no verdict named a claim it was asked about";
  if (read.length === 0) return `${head}; listed no verdicts (keys ${JSON.stringify(Object.keys(raw).slice(0, 8))})`;
  const ids = read.map((v) => String(v['claim_id'] ?? '')).slice(0, 4);
  return `${head}; ${read.length} verdict(s) named ${JSON.stringify(ids)}, asked ${JSON.stringify(asked.slice(0, 4))}`.slice(0, 400);
}

/**
 * The declared lane a model's label names, or null. An exact id wins; then a
 * label equal to an id or a description ignoring case; then a label whose
 * whole text equals exactly one lane's id or description once case,
 * punctuation and spacing are ignored. A label in two parts ("L1: primary
 * sources", "primary sources (L2)") names a lane only through its first part:
 * that part must name exactly one lane, and the second part, if it names a
 * lane at all, must name the same one. The second part alone never decides,
 * so "Lane 3 (primary sources)" — a lane nobody declared — names no lane
 * rather than the lane whose description it happens to repeat. A label that
 * fits two lanes, or none, names no lane.
 */
export function laneFor(label: unknown, lanes: { id: string; description: string }[]): string | null {
  const given = String(label ?? '').trim();
  if (given === '') return null;
  if (lanes.some((l) => l.id === given)) return given;
  const lower = given.toLowerCase();
  const plain = lanes.filter((l) => l.description.toLowerCase() === lower || l.id.toLowerCase() === lower);
  if (plain.length > 0) return plain[0]!.id;
  const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  /** The declared lanes a squashed piece of label names, by id or by description. */
  const naming = (piece: string): Set<string> =>
    new Set(piece === '' ? [] : lanes.filter((l) => squash(l.id) === piece || squash(l.description) === piece).map((l) => l.id));
  const only = (ids: Set<string>): string | null => (ids.size === 1 ? [...ids][0]! : null);
  const whole = naming(squash(given));
  if (whole.size > 0) return only(whole);
  const parts = given.split(/\s*(?::|\s[-\u2013\u2014]\s|\()\s*/);
  const head = only(naming(squash(parts[0] ?? '')));
  if (head === null) return null;
  const tail = naming(squash(parts.slice(1).join(' ')));
  return tail.size === 0 || (tail.size === 1 && tail.has(head)) ? head : null;
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

/**
 * What counts as a claim, said to the model in the fragment prompt. Production,
 * 2026-11-16 20:07–21:07Z: 81 of gpt-oss-120b's 96 refused fragments were the
 * reply `{"claims":[]}` over 4–6 pages Brain had read — the model read "the
 * claims these sources establish for the brief" as "an answer to the whole
 * question" and listed nothing, and the repair prompt told it an empty list was
 * acceptable. A sentence that settles part of the question is evidence; every
 * claim it yields is still copied from the page and held to every check.
 */
export const PARTIAL_EVIDENCE =
  'A claim need not answer the whole question: a figure, price, count, named buyer or seller, rule, date or ' +
  'definition that bears on any part of the brief is a claim, with its limits stated in the claim text. ';

/** The repair prompt for a reply that listed no claims at all over pages Brain read. Pure. */
export function emptyListRepair(prompt: string, sources: number, lane: string): string {
  return (
    `${prompt}\n\nYour previous answer listed no claims from the ${sources} source(s) above. Read them again for ` +
    'any sentence that bears on part of the brief. ' + PARTIAL_EVIDENCE +
    'Cite each by SOURCE and sentence numbers, e.g. {"claim":"…","source":2,"sentences":[4,5],"evidence_lane":"' + lane + '"}. ' +
    'Reply {"claims":[],"none_because":"…"} only if no sentence in any source bears on the brief at all, and say in ' +
    'none_because, in one sentence, which it is: the sources are about something else, or the brief rule (a source ' +
    'type, the scope, a lane) that keeps out the sentences that are on the subject, naming the rule and the source.'
  );
}

/**
 * Why a model listed no claims, in its own words, bounded, or null. Production,
 * 2026-11-17 (W13): 20 of gpt-oss-120b's 21 refused fragments in an hour were
 * `0 claim(s) offered, dropped {}` — no check dropped anything; the model listed
 * none over five pages Brain had read, after #998's re-ask and #1014's page
 * selection. Two fixes aimed at a cause nobody had read. The reason the model
 * gives is recorded so the next fix is aimed at the one it states. Pure.
 */
export function noneBecause(raw: Record<string, unknown>): string | null {
  for (const key of ['none_because', 'reason', 'why', 'explanation', 'note']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') return redactCredentials(redactSecrets(value.replace(/\s+/g, ' ').trim())).slice(0, 240);
  }
  return null;
}

/**
 * The failure recorded for an answer from which no claim survived. An empty
 * list is said as one (`dropped {}`, then the model's stated reason or what it
 * sent), so a report never reads a model that listed nothing as one whose
 * claims Brain's checks dropped. Pure.
 */
export function droppedReason(listed: number, dropped: Record<string, number>, pages: readonly string[], raw: Record<string, unknown>): string {
  const head = `the answer did not survive Brain's own checks: ${listed} claim(s) offered, dropped ${JSON.stringify(dropped)}`;
  if (listed > 0) return head;
  // The class of each page it read, so a reading can set the evidence offered against the source types the brief asks for.
  const classes = pages.reduce<Record<string, number>>((acc, url) => ({ ...acc, [hostClass(url)]: (acc[hostClass(url)] ?? 0) + 1 }), {});
  const from = `${head} from ${pages.length} source(s) ${JSON.stringify(classes)}`;
  const because = noneBecause(raw);
  return because ? `${from}; the model listed none because: ${because}` : `${from}; the reply was ${JSON.stringify(raw).slice(0, 200)}`;
}

/**
 * What kind of page a URL is, by its host alone: an official body, a
 * reference work, or a commercial or other site. Coarse, and only a reading:
 * it never decides whether a claim is accepted (W13). Pure.
 */
export function hostClass(url: string): 'official' | 'reference' | 'commercial' | 'unknown' {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (/(^|\.)(gov|mil|int)$|(^|\.)gov\.[a-z]{2}$|(^|\.)(gc\.ca|europa\.eu|un\.org|oecd\.org|worldbank\.org)$/.test(host)) return 'official';
  if (/(^|\.)edu$|(^|\.)ac\.[a-z]{2}$|(^|\.)(wikipedia\.org|wikidata\.org|britannica\.com)$/.test(host)) return 'reference';
  return 'commercial';
}

async function ask(
  completer: Completer,
  config: LaneConfig,
  model: string,
  prompt: string,
  onFail: (why: string) => void = () => undefined,
  options: { json?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  let asked = prompt;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text = '';
    try {
      text = await completer({ ...config, timeoutMs: 180_000 }, model, SYSTEM, asked, { maxTokens: 8000, ...(options.json ? { json: true } : {}) });
    } catch (error) {
      const message = String((error as Error).message ?? error);
      // On the GPU slot the error that reaches here is the fallback's: the GPU's
      // own failure was swallowed when the call fell back. When the GPU's own
      // calls are failing, that is the cause, and the reason says so.
      const down = gpuDown(model);
      const detail = down ? `GPU slot's own calls failing; the fallback then said: ${message}` : message;
      onFail(`model call failed [${classifyRouteFailure(message, { gpuDown: down })}]: ${redactSecrets(detail).slice(0, 200)}`);
      continue;
    }
    const parsed = firstJson(text);
    if (parsed) return parsed;
    const shape = replyShape(text);
    onFail(`no JSON in a ${text.length}-character reply: ${shape}`);
    // An empty reply says nothing and is asked again as it was; a reply with words is told what was wrong.
    if (shape !== 'empty') asked = noJsonRepair(prompt, shape);
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

const STOP = new Set(
  ('about above after again also among and any are because been before being between both but can could does doing down during ' +
    'each every from further have having here how into its itself just more most must not now off once only other our out over ' +
    'own same should some such than that the their them then there these they this those through too under until very was were ' +
    'what when where which while who whom why will with within would your yours brain claim claims source sources evidence lane ' +
    'fragment question null').split(' '),
);

const stem = (word: string): string => word.replace(/(?:ies|es|s)$/, '');

/** The words a brief or a claim is about, for picking the page sentences that bear on it. Pure. */
export function focusTerms(focus: string): Set<string> {
  const out = new Set<string>();
  for (const word of focus.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) if (!STOP.has(word)) out.add(stem(word));
  return out;
}

/**
 * Words Brain's own question templates put around a subject ("Establish whether
 * such buyers actually pay", "nobody has established this yet … quoting the
 * source, or report it unanswered", "What published evidence shows how …
 * behaves for buyers and offers like this plan's"). They say nothing about what
 * a page must be about, so a page is never judged on-topic by them.
 */
const ASK_WORDS = focusTerms(
  'establish established whether actually such published publish nobody find says say quoting quote report unanswered answer ' +
    'composed arrangement opening needs world confirm refute described fulfilled producing shows show behaves offers like plan reading ' +
    'part packet missing name named known public page pages web specific data information',
);

/**
 * Words nearly every page carries, commercial or academic: a wage table, a
 * NAICS index, a company's contact page and an arXiv abstract all say
 * "business", "member", "account", "rate", "data" or "model". They name no
 * subject, so a page is never judged on-topic by them — unless they are all
 * the subject has.
 *
 * Production, 2026-11-17 15:20–16:15Z: constructed rounds quote buyers as
 * "anonymous members of the public" and "individual account of unknown
 * business"; their subject terms were {anonymou, member} and {individual,
 * account, unknown, busines}, so one or two of these words let a photometric
 * redshift paper, a BLS wage table and a mine-supply contact page through.
 */
const GENERIC_WORDS = focusTerms(
  'anonymous member members individual individuals account accounts unknown business businesses company companies ' +
    'people person general common kind kinds type types various other another group groups organisation organization ' +
    'service services product products customer customers user users market markets data model models method methods ' +
    'number numbers rate rates price prices cost costs value values amount average typical percent percentage total ' +
    'year years time times based include includes including provide provides using used make made work works high large ' +
    'small level levels result results system systems process information case cases area areas',
);

/** The terms a page must carry to bear on a question: its quoted subject when it names one, else the question. Pure. */
export function subjectTerms(question: string): Set<string> {
  const quoted = [...question.matchAll(/["“]([^"”]{4,120})["”]/g)].map((m) => m[1]!);
  const of = (text: string): { all: Set<string>; specific: Set<string> } => {
    const all = focusTerms(text);
    for (const one of ASK_WORDS) all.delete(one);
    return { all, specific: new Set([...all].filter((one) => !GENERIC_WORDS.has(one))) };
  };
  const named = of(quoted.length > 0 ? quoted.join(' ') : question);
  if (named.specific.size > 0) return named.specific;
  // A quoted subject made only of generic words ("individual account of unknown business") is
  // read with the rest of the question (the product, the channel); generic words stay only when
  // nothing specific is said anywhere.
  if (quoted.length > 0) {
    const whole = of(question);
    if (whole.specific.size > 0) return whole.specific;
  }
  return named.all;
}

/**
 * Whether a fetched page bears on the question at all: it carries at least two
 * of the subject's terms (three of a subject of six or more; every one of a
 * one-term subject). Pure.
 *
 * Production, 2026-11-17 11:03–12:03Z: gpt-oss-120b worked 108 fragments and
 * answered every one with an honest empty claim list, and its reasons named the
 * pages Brain had handed it — "quantum entanglement and chlamydia infection",
 * "high-speed train positioning and NHS staff wellbeing", "GitHub about and
 * security pages", "unreadable binary data". Every readable page a search or the
 * model named was shown, in the order found, with no check that it was about the
 * question; the first six readable pages filled the brief, so an on-topic page
 * further down the list was never opened, and a paid model was asked to cite
 * pages that could not answer. An off-topic page is now skipped like an empty
 * one and the next candidate opened. The evidence bar is unchanged: a page that
 * passes still has to state the claim in its own sentences.
 */
export function pageBearsOn(text: string, terms: Set<string>): boolean {
  if (terms.size === 0) return true;
  // A long subject (a whole unquoted question) shares two words with almost any page, so it needs three.
  const need = Math.min(terms.size, terms.size >= 6 ? 3 : 2);
  const seen = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    const w = stem(word);
    if (terms.has(w)) {
      seen.add(w);
      if (seen.size >= need) return true;
    }
  }
  return false;
}

/**
 * A site's navigation page (contact, security, login, privacy, careers) or a
 * search interface (EDGAR's search, a NAICS lookup, any `?q=` results page):
 * it states no market fact, only the site's own interface text. Pure.
 */
export function isNavigationPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
    if (/(^|\/)(contact(-us)?|security|privacy(-policy)?|cookies?(-policy)?|log-?in|sign-?in|sign-?up|register|careers?|jobs|search|cgi-bin\/browse-edgar|accessibility|sitemap)(\.[a-z]+)?$/.test(path)) return true;
    if (/(^|\/)(edgar\/search|search-results?|naics\/?$)/.test(path)) return true;
    return [...parsed.searchParams.keys()].some((key) => /^(q|query|search|keywords?|input|searchterm)$/i.test(key));
  } catch {
    return false;
  }
}

/** Hosts of academic preprints and paper indexes. */
const ACADEMIC_HOSTS = /(^|\.)(arxiv\.org|biorxiv\.org|medrxiv\.org|semanticscholar\.org|researchgate\.net|scholar\.google\.com|paperswithcode\.com|openreview\.net|aclanthology\.org|pubmed\.ncbi\.nlm\.nih\.gov)$/;

/** An academic preprint or paper index page. Pure. */
export function isAcademicPage(url: string): boolean {
  try {
    return ACADEMIC_HOSTS.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Whether a fragment's own source rules ask for academic sources. Pure. */
export function wantsAcademicSources(acceptableSourceTypes: unknown): boolean {
  const types = Array.isArray(acceptableSourceTypes) ? acceptableSourceTypes : [];
  return types.some((one) => typeof one === 'string' && /academic|peer|journal|paper|preprint|scholar|study|studies|literature/i.test(one));
}

/**
 * Candidates to open, in the order found, without the pages that cannot
 * answer: navigation and search-interface pages always, and academic
 * preprints unless the fragment's source rules ask for academic sources. Pure.
 *
 * Production, 2026-11-17 15:20–16:15Z: of ~25 fragments gpt-oss-120b worked,
 * 2 produced accepted claims; its empty answers named the candidates — arXiv
 * papers on photometric redshift, weighted MaxSAT and chemical reaction
 * networks for commercial questions, the SEC EDGAR search interface, a
 * mine-supply company's contact page. Until then a navigation page was only
 * moved to the end of the list (#1052), so it was still opened and shown
 * whenever nothing better had been read.
 */
export function candidateOrder(urls: string[], options: { academic?: boolean } = {}): string[] {
  return urls.filter((u) => !isNavigationPage(u) && (options.academic === true || !isAcademicPage(u)));
}

/**
 * The sentences of a page a model is shown, verbatim and in the page's order.
 *
 * Production, 2026-11-17 01:02–01:49Z: most of gpt-oss-120b's refused
 * fragments were the reply `{"claims":[]}` over 2–6 pages Brain had read, and
 * again after the re-ask (#998). The lane showed each page's first 7 000
 * characters, and a commercial page's first 7 000 characters are mostly its
 * menus: a pricing page measured that day had 13 prose sentences of 90 in that
 * window and its first price past it. A page short enough to show whole is
 * shown whole, as before. A longer one is read in full; lines that are neither
 * prose nor a figure are left out, and the rest are kept by how many of the
 * brief's words they carry, then whether they state a figure, then their place
 * on the page, up to the same character budget. Every sentence is still the
 * page's own text, cited by number and copied by Brain: what a claim must
 * prove does not change. Pure.
 */
export function pageSentences(text: string, focus: string, budget = SOURCE_CHARS, max = 90): string[] {
  const all = sentencesOf(text, 100_000);
  const size = (list: string[]): number => list.reduce((n, one) => n + one.length + 1, 0);
  if (all.length <= max && size(all) <= budget) return all;
  const terms = focusTerms(focus);
  const seen = new Set<string>();
  const scored = all
    .map((one, index) => {
      // A menu repeated in a page's header and footer is shown once.
      const repeat = seen.has(one);
      seen.add(one);
      if (repeat) return { one, index, hits: 0, figure: false, keep: false };
      const words = one.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [];
      const hits = new Set(words.map(stem).filter((w) => terms.has(w))).size;
      const figure = /\d/.test(one);
      return { one, index, hits, figure, keep: figure || one.split(' ').length >= 6 };
    })
    .filter((s) => s.keep)
    .sort((a, b) => b.hits - a.hits || Number(b.figure) - Number(a.figure) || a.index - b.index);
  const chosen: typeof scored = [];
  let used = 0;
  for (const s of scored) {
    if (chosen.length >= max) break;
    if (used + s.one.length + 1 > budget) continue;
    chosen.push(s);
    used += s.one.length + 1;
  }
  return chosen.sort((a, b) => a.index - b.index).map((s) => s.one);
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

/**
 * Where a small model puts the sentence numbers when it does not use the key it
 * was asked for (production, 2026-11-08: Qwen3-4B answers dropped whole as "no
 * citation and no verbatim quote"). The reference still has to resolve to a real
 * sentence of a page Brain fetched; only where it may be written is widened.
 */
const CITATION_KEYS = ['sentences', 'sentence', 'sentence_numbers', 'sentence_ids', 'sentence_refs', 'citations', 'citation', 'cites', 'evidence_sentences', 'evidence_locator', 'source_ref', 'evidence_excerpt'];

/** The first citation key that holds a reference, or the `sentences` value. */
function citationValue(claim: Record<string, unknown>): unknown {
  for (const key of CITATION_KEYS) {
    if (claim[key] !== undefined && referencesIn(claim[key]).length > 0) return claim[key];
  }
  return claim['sentences'];
}

/**
 * The recorded reason for a claim that carried no reference Brain could read. It names
 * the keys the model did send (names only, never values, capped), so a production row
 * shows which key a model cites under and CITATION_KEYS can be widened from evidence.
 */
export function uncitedReason(claim: Record<string, unknown>): string {
  const keys = Object.keys(claim)
    .filter((k) => !['claim', 'evidence_lane'].includes(k))
    .slice(0, 8)
    .map((k) => k.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40))
    .filter((k) => k.length > 0);
  return keys.length > 0 ? `no citation and no verbatim quote (claim keys: ${keys.join(',')})` : 'no citation and no verbatim quote';
}

function resolveCitation(claim: Record<string, unknown>, numbered: { url: string; sentences: string[] }[]): Citation {
  const refs = referencesIn(citationValue(claim));
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
  if (found.ok) return 'cited';
  if (found.why === 'out of range') return 'cited sentences outside the page';
  // What the model wrote where a citation goes, bounded, so the next unread shape is read from the record (2026-11-17: 2 of 8 recorded drops).
  const key = CITATION_KEYS.find((k) => claim[k] !== undefined && k !== 'evidence_excerpt');
  const shape = key ? `${key}=${JSON.stringify(claim[key]).slice(0, 60)}` : '';
  return shape ? `citation not readable as sentence numbers (${shape})` : 'citation not readable as sentence numbers';
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

/**
 * Wikipedia's full-text search query for a search phrase: its words joined by
 * `OR`, so a page matching most of them ranks first and one matching only some
 * still answers. Pure.
 *
 * Until 2026-11-18 this was `action=opensearch`, which matches page *titles* by
 * prefix, so a topic phrase ("PA DEP abandoned mine reclamation contractor
 * rates") matched no title and returned nothing. With DuckDuckGo refusing for
 * longer than a fragment waits (production 0ba2eb30, 01:00–01:45Z, 27 fragments
 * "none from web search"), that left a fragment with no search candidate at all.
 * Full-text search with the words ANDed (its default) is no better for these
 * phrases: both measured queries had 0 hits. ORed, they returned "Pennsylvania
 * Department of Environmental Protection" and "Mine reclamation", and
 * "Variable data printing" and "Postcard".
 */
export function wikipediaSearchQuery(query: string): string {
  const words = query
    .slice(0, 200)
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 0 && !/^(or|and|not)$/i.test(w));
  return [...new Set(words)].slice(0, 12).join(' OR ');
}

/** Free, keyless public search: Wikipedia's full-text search API. Candidates only; Brain reads each page itself. */
export async function wikipediaCandidates(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const search = wikipediaSearchQuery(query);
  if (!search) return [];
  try {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&list=search&srnamespace=0&srlimit=3&srprop=&format=json&srsearch=' +
      encodeURIComponent(search);
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'Brain research lane (public API)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { query?: { search?: Array<{ title?: unknown }> } };
    const hits = Array.isArray(body?.query?.search) ? body.query.search : [];
    return hits
      .map((hit) => hit?.title)
      .filter((title): title is string => typeof title === 'string' && title.length > 0)
      .map((title) => 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')))
      .slice(0, 3);
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
  /**
   * The fragment's model listed no claim from the pages it was shown while web
   * search was refusing and none of those pages came from a web search result
   * (only Wikipedia or remembered URLs): like "no readable source" in an outage,
   * it says nothing about the question, so the attempt is refunded.
   */
  searchStarved?: boolean;
  /** What the item used while it ran (itemMeter.ts); recorded on its `FREE_LANE_ITEM` row. */
  usage?: ItemUsage;
}

/**
 * The item's model route, page reader and search, each counting what crossed the
 * network into the item's meter. The behaviour of each is unchanged.
 */
export function meteredIo(
  usage: ItemUsage,
  io: { completer: Completer; fetchSource: (url: string) => Promise<SourceFetch>; search: (query: string) => Promise<string[]> },
): { completer: Completer; fetchSource: (url: string) => Promise<SourceFetch>; search: (query: string) => Promise<string[]> } {
  return {
    completer: (async (config, model, system, prompt, options) => {
      usage.modelCalls += 1;
      usage.networkBytesOut += utf8Bytes(system) + utf8Bytes(prompt);
      const text = await io.completer(config, model, system, prompt, options);
      usage.networkBytesIn += utf8Bytes(text);
      return text;
    }) as Completer,
    fetchSource: async (url) => {
      usage.networkBytesOut += utf8Bytes(url);
      const page = await io.fetchSource(url);
      usage.networkBytesIn += utf8Bytes(page?.readable ? page.text : '');
      return page;
    },
    search: async (query) => {
      usage.networkBytesOut += utf8Bytes(query);
      const found = await io.search(query);
      usage.networkBytesIn += utf8Bytes(found);
      return found;
    },
  };
}

/** `ask` for one item, recording why on the item when the model gives nothing usable. */
async function askFor(ctx: Ctx, prompt: string, options: { json?: boolean } = {}): Promise<Record<string, unknown> | null> {
  return ask(
    ctx.completer,
    ctx.config,
    ctx.worker.model,
    prompt,
    (why) => {
      ctx.why = why;
    },
    options,
  );
}

/**
 * Failures that happen before any statement reaches the database: no pool
 * connection, a connect that timed out, the server refusing another client.
 * Nothing ran, so asking again cannot repeat an effect (invariant 26 — a
 * statement timeout, whose outcome is unknown, is deliberately not here).
 */
export const BRAIN_NOT_REACHED = /database pool had no free connection|Connection terminated due to connection timeout|too many clients/i;
/** Waits between attempts when Brain's database was not reached. Exported for tests. */
export const NOT_REACHED_BACKOFF_MS = [1_000, 3_000, 9_000];

/**
 * A Brain tool, asked again when the database was not reached.
 *
 * Production, 2026-11-05 13:25–19:25Z: 46 of the $10K goal's free-lane jobs
 * ended "threw: The database pool had no free connection" and two more had
 * their submission refused the same way — each after minutes of model work
 * the GPU or a free provider had already done. The answer was thrown away, a
 * submission was sent back to the model as if it were wrong, and the item was
 * cooled for up to an hour. A pool that is full for seconds is a reason to wait
 * seconds, so the call waits and asks again; past the backoff it throws as before.
 */
async function call(ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const found = findTool(tool);
  if (!found) throw new Error(`no tool ${tool}`);
  const started = Date.now();
  if (ctx.usage) ctx.usage.dbCalls += 1;
  try {
    const outcome = await retryNotReached(() => found.run(args, { principal: ctx.principal, requestId: `req_${Math.random().toString(36).slice(2)}` }));
    return outcome.value;
  } finally {
    if (ctx.usage) ctx.usage.dbMs += Date.now() - started;
  }
}

/** Run `fn`, waiting and running it again while Brain's database was not reached. Exported for tests. */
export async function retryNotReached<T>(fn: () => Promise<T>, backoff: readonly number[] = NOT_REACHED_BACKOFF_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const wait = backoff[attempt];
      if (wait === undefined || !BRAIN_NOT_REACHED.test(String((error as Error)?.message ?? error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function proof(ctx: Ctx): Record<string, unknown> {
  return {
    work_item_id: ctx.claimed.workItemId,
    lease_id: ctx.claimed.leaseId,
    lease_generation: ctx.claimed.leaseGeneration,
  };
}

/** Submit through a tool; on a refusal, show the model the refusal once and try again. */
/**
 * Submit, and when Brain refuses one numbered claim, submit the rest without it.
 *
 * `brain_submit_claims` refuses a whole submission for one claim's impossible
 * field ("a HUMAN_REQUIREMENT finding carries no figure, so labor_qualifier must
 * be omitted", "closes_on needs an opportunity_signal", …). Production,
 * 2026-11-07: a small model's one bad claim cost every good claim beside it,
 * and the repair round usually repeated the mistake. The refused claim is
 * dropped — never edited — and every other claim meets every rule as before.
 */
export async function submitDroppingRefusedClaims(ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<void> {
  let current = args;
  for (let dropped = 0; ; dropped += 1) {
    try {
      await call(ctx, tool, { ...current, ...proof(ctx) });
      return;
    } catch (error) {
      const message = String((error as Error).message ?? error);
      const claims = Array.isArray(current['claims']) ? (current['claims'] as unknown[]) : null;
      const index = /\bclaims\[(\d+)\]/.exec(message);
      const at = index ? Number(index[1]) : -1;
      if (tool !== 'brain_submit_claims' || !claims || claims.length < 2 || at < 0 || at >= claims.length || dropped >= 5) throw error;
      current = { ...current, claims: claims.filter((_, i) => i !== at) };
      // Dropping the refused claim stands in for the repair call that would otherwise have been asked.
      if (ctx.usage) ctx.usage.modelCallsAvoided += 1;
    }
  }
}

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
      await submitDroppingRefusedClaims(ctx, tool, args);
      return true;
    } catch (error) {
      ctx.why = `${tool} refused: ${String((error as Error).message ?? error).slice(0, 300)}`;
      // Brain's database, not the answer: nothing for the model to repair.
      if (attempt === 1 || BRAIN_UNAVAILABLE.test(ctx.why)) return false;
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

/** A web search reads at most this many characters of a query (`webSearch` cuts at 240). */
const SEARCH_QUERY_CHARS = 120;

/**
 * The searches a fragment runs: the model's own short phrases first, then the
 * question's quoted subject. Pure.
 *
 * Production, 2026-11-07: the lane searched with the fragment's whole question,
 * and `webSearch` keeps its first 240 characters. For a constructed or goal round
 * those are the question's preamble ("Brain composed an arrangement nobody has
 * published as an opening, and needs the world to confirm or refute it: buyers
 * described as …"), so one of every fragment's two searches asked the shared,
 * rate-limited search queue for boilerplate. A quoted phrase in the question is
 * what it is about; with none, its first sentence is the best short form.
 */
export function searchQueries(question: string, modelPhrases: unknown): string[] {
  const out: string[] = [];
  const add = (one: string): void => {
    const q = one.replace(/\s+/g, ' ').trim().slice(0, SEARCH_QUERY_CHARS);
    if (q.length >= 3 && !out.some((have) => have.toLowerCase() === q.toLowerCase())) out.push(q);
  };
  const subject = subjectTerms(question);
  const carriesSubject = (phrase: string): boolean => subject.size === 0 || [...focusTerms(phrase)].some((one) => subject.has(one));
  // A model phrase that names none of the subject ("weighted MaxSAT benchmark", "occupational wage data") searches
  // for something else, and its results are off-topic candidates; it is not searched.
  const phrases = (Array.isArray(modelPhrases) ? modelPhrases : [modelPhrases]).filter(
    (one): one is string => typeof one === 'string' && carriesSubject(one),
  );
  const quoted = [...question.matchAll(/["“]([^"”]{4,120})["”]/g)].map((m) => m[1]!);
  // As many searches as before (two): the model's best phrase, then the question's own subject.
  if (phrases[0]) add(phrases[0]);
  add(quoted.length > 0 ? quoted.slice(0, 2).join(' ') : (question.split(/(?<=[.?!])\s/)[0] ?? question));
  for (const one of phrases.slice(1)) add(one);
  return out.slice(0, 2);
}

async function fragment(ctx: Ctx, assignment: Record<string, unknown>): Promise<boolean> {
  const frag = (assignment['fragment'] ?? {}) as Record<string, unknown>;
  const lanes = ((frag['requiredEvidence'] as { id: string; description: string }[] | undefined) ?? []).map((lane) => ({
    id: lane.id,
    description: lane.description,
  }));
  const question = String(frag['question'] ?? '');
  // The packet's assignment repeats the question for a one-fragment packet (every goal and constructed
  // round), doubling a brief a small model must read; it is sent only when it says something else.
  const packetText = String((assignment['orchestration'] as Record<string, unknown> | undefined)?.['assignment'] ?? '');
  const brief = {
    question,
    packet: packetText && !packetText.includes(question.slice(0, 400)) ? packetText.slice(0, 4000) : null,
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
  // 1. Candidates: the model names primary pages it knows; Wikipedia's search adds up to three. Brain opens them all.
  const plan = await ask(
    ctx.completer,
    ctx.config,
    ctx.worker.model,
    `Research brief:\n${JSON.stringify(brief, null, 1)}\n\nName up to ${MAX_SOURCES} specific public web pages ` +
      'most likely to contain primary evidence for this question: pages about the buyers, product or industry the ' +
      'question names (their own pricing, rates or terms pages, published price lists, trade bodies, regulators), and an ' +
      'official statistics table or company filing only when it reports on that subject. Never a search interface, a code ' +
      'directory or an academic paper unless acceptableSourceTypes asks for one. Prefer exact page URLs you are confident exist, and the page that ' +
      'states the asked fact (a named company\'s own pricing, rates or terms page) over its home, about or contact page. ' +
      unreachableNote() +
      'Reply as {"urls":["https://..."],"searches":["two or three short web search phrases, under ten words each, naming the subject the question is about and the fact it asks (a price, rate, term or count)"]}.',
  );
  const urlsOf = (answer: Record<string, unknown> | null): string[] =>
    Array.isArray(answer?.['urls']) ? (answer!['urls'] as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  // Both queries at once: the search module paces its own queue, so this only
  // stops the second waiting on the first's answer before it is even asked.
  const queries = searchQueries(question, plan?.['searches'] ?? plan?.['search']);
  const searched = (await Promise.all(queries.map((q) => ctx.search(q)))).flat();
  const subject = subjectTerms(question);
  const academic = wantsAcademicSources(frag['acceptableSourceTypes']);
  const tried = new Set<string>();
  const skipped = new Set<string>();
  const failedUrls: string[] = [];
  const fetchReasons: string[] = [];
  const fetchDetails: string[] = [];
  const readable: { url: string; text: string; asked: string }[] = [];
  // Pages an earlier attempt at this question read and got no claim from (§15): not shown again.
  const readBefore = readWithoutAnswerFor(question);
  /*
   * Pages are opened in waves rather than one after another: each wave opens as
   * many as are still needed at once, one per host, and results are taken in
   * the candidates' order, so search results still come before remembered URLs
   * and no more pages are read than the job needs.
   */
  const open = async (urls: string[]): Promise<void> => {
    const queue: string[] = [];
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url) || tried.has(url) || queue.includes(url)) continue;
      queue.push(url);
    }
    while (queue.length > 0 && readable.length < MAX_SOURCES) {
      const wave = takeWave(queue, MAX_SOURCES - readable.length);
      const results = await Promise.all(
        wave.map(async (url) => {
          tried.add(url);
          if (isRememberedUnreachable(url)) return { url, fetched: null };
          return { url, fetched: await ctx.fetchSource(url) };
        }),
      );
      for (const { url, fetched } of results) {
        if (!fetched) {
          skipped.add(url);
          fetchReasons.push('HOST_UNREACHABLE');
          continue;
        }
        const host = hostOf(url);
        if (fetched.readable && host) forgiveHost(url);
        if (!fetched.readable) rememberUnreachable(url, String(fetched.reason), Date.now(), String(fetched.detail ?? ''));
        const read = fetched.readable && fetched.text.trim().length > 200;
        const onTopic = read && pageBearsOn(fetched.text.slice(0, PAGE_READ_CHARS), subject);
        if (onTopic && readable.length < MAX_SOURCES) {
          readable.push({ url: fetched.finalUrl, text: fetched.text.slice(0, PAGE_READ_CHARS), asked: url });
        } else if (!onTopic) {
          failedUrls.push(url);
          fetchReasons.push(read ? 'OFF_TOPIC' : fetched.readable ? 'EMPTY' : String(fetched.reason));
          if (!fetched.readable && fetchDetails.length < 2 && !fetchDetails.includes(fetched.detail)) fetchDetails.push(fetched.detail);
        }
      }
    }
  };
  // Pages that cannot answer are not opened at all, and the reason is kept for `none_because`.
  const keep = (urls: string[]): string[] => {
    const kept = candidateOrder(urls, { academic }).filter((url) => !readBefore.has(url));
    for (const url of urls) {
      if (kept.includes(url) || tried.has(url) || failedUrls.includes(url)) continue;
      failedUrls.push(url);
      fetchReasons.push(readBefore.has(url) ? 'READ_BEFORE_NO_CLAIM' : isNavigationPage(url) ? 'NAVIGATION_PAGE' : 'ACADEMIC_OFF_SCOPE');
    }
    return kept;
  };
  // Search results first: they are pages that exist. A remembered URL is a guess.
  const fromSearch = new Set(searched);
  await open(keep([...searched, ...urlsOf(plan)]));
  // A second round: show the model what Brain could not open and ask for other pages.
  if (readable.length < 2) {
    const retry = await askFor(
      ctx,
      `Research brief:\n${JSON.stringify(brief, null, 1)}\n\nBrain could not open these pages (missing, blocked or ` +
        `empty): ${JSON.stringify(failedUrls)}. ${unreachableNote()}Name up to ${MAX_SOURCES} OTHER public pages likely to hold primary ` +
        'evidence about the buyers, product or industry the question names — prefer the subject\'s own pricing, rates or ' +
        'terms pages and stable pages of trade bodies and regulators that report on it over guessed deep links, and never a ' +
        'home, about, contact, login or search page or an unrelated statistics table, which states no fact about the question. ' +
        'Reply as {"urls":["https://..."]}.',
    );
    await open(keep(urlsOf(retry)));
  } else if (ctx.usage) {
    // Enough pages were read on the first round, so the second round's model call was not needed.
    ctx.usage.modelCallsAvoided += 1;
  }
  const readFromSearch = readable.filter((one) => fromSearch.has(one.url)).length;
  ctx.discovery = { searched: fromSearch.size, readFromSearch, readFromModel: readable.length - readFromSearch };
  // A page skipped because its host is known shut was never a candidate Brain could have read.
  const candidates = [...tried].filter((u) => !skipped.has(u));
  if (readable.length === 0) {
    // A model that never answered is a provider failure, not a sourcing one.
    if (!/^(model call failed|no JSON)/.test(ctx.why) || candidates.length > 0) {
      const counts = fetchReasons.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
      // Whether web search gave any candidate is the first question about a sourcing failure, and the
      // report masks the counts, so it is said in words `failureClass` keeps (2026-11-17, B3).
      const fromWeb = fromSearch.size === 0 ? ', none from web search' : '';
      ctx.why = `no readable source among ${candidates.length} candidate page(s)${fromWeb}: ${JSON.stringify(counts)} ${fetchDetails.join(' | ')}`.slice(0, 400);
    }
    return false;
  }

  // 2. Claims, cited by sentence number. Brain copies the sentences itself, so
  //    every excerpt is verbatim by construction: the model never retypes a quote.
  const claimSchema = schemaForModel('brain_submit_claims', 'claims');
  const focus = [question, ...lanes.map((l) => l.description), JSON.stringify(brief.scope)].join(' ');
  const numbered = readable.map((one) => ({ url: one.url, sentences: pageSentences(one.text, focus) }));
  const sources = numbered
    .map((one, i) => `SOURCE ${i + 1} — ${one.url}\n${one.sentences.map((t, n) => `[S${i + 1}.${n + 1}] ${t}`).join('\n')}`)
    .join('\n\n---\n\n');
  const prompt =
    `Research brief:\n${JSON.stringify(brief, null, 1)}\n\nSources Brain fetched, split into numbered sentences:\n\n${sources}\n\n` +
    'Extract the material claims these sources establish for the brief. For each claim give "source" (the ' +
    'SOURCE number) and "sentences" (the sentence numbers within that source that state it, e.g. [3,4]); ' +
    'Brain copies those sentences as the quoted evidence, so cite only sentences that say the claim. ' +
    PARTIAL_EVIDENCE +
    'evidence_lane must be one of ' +
    JSON.stringify(lanes.map((l) => l.id)) +
    '; state geography/timeframe limits inside the claim. Include no claim the sources do not support. ' +
    `Reply as {"claims":[...]} where each claim has "source", "sentences" and the fields of: ${JSON.stringify(claimSchema)}`;
  const answer = await askFor(ctx, prompt);
  const laneIds = new Set(lanes.map((l) => l.id));
  const onlyLane = laneIds.size === 1 ? [...laneIds][0]! : null;
  /*
   * Brain read every page these claims cite, so each is RETRIEVED whatever the
   * model wrote, and a field the tool does not define is dropped rather than
   * sent. Production, 2026-11-07: a 4B model marked read pages unreachable, so
   * goal rounds' fragments failed the gate on "source could not be read", and
   * added `geography`/`timeframe`, which refused whole submissions.
   */
  const claimFields = new Set(Object.keys((claimSchema as { items?: { properties?: Record<string, unknown> } }).items?.properties ?? {}));
  const asRead = (c: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(c)) if (claimFields.size === 0 || claimFields.has(key)) out[key] = value;
    out['retrieval_state'] = 'RETRIEVED';
    /*
     * Two fields a small model adds where they cannot belong, each of which
     * refused the whole submission (production, 2026-11-07): a qualifier on a
     * structural finding that is about itself, and a closing date on a claim
     * that names no opening. Dropping the field keeps the claim; the rest of it
     * is held to every rule as before.
     */
    const finding = out['structural_finding'];
    if (out['structural_qualifier'] !== undefined && (!isStructuralFinding(finding) || !findingTakesQualifier(finding))) delete out['structural_qualifier'];
    if (out['closes_on'] !== undefined && (out['opportunity_signal'] === undefined || out['opportunity_signal'] === null || out['opportunity_signal'] === '')) delete out['closes_on'];
    return out;
  };
  const finalize = (raw: Record<string, unknown>): Record<string, unknown> | null => {
    const listed = listedClaims(raw);
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
        const match = laneFor(c['evidence_lane'], lanes);
        if (match) c['evidence_lane'] = match;
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
        claims.push(asRead({ ...rest, source_url: cited.url, evidence_excerpt: cited.excerpt, evidence_locator: cited.locator }));
        continue;
      }
      // A model that quoted instead of citing is still held to the page, word for word.
      const source = readable.find((one) => one.url === c['source_url']);
      if (source && typeof c['evidence_excerpt'] === 'string' && quotedIn(String(c['evidence_excerpt']), source.text)) {
        const { source: _s, sentences: _n, ...rest } = c;
        claims.push(asRead(rest));
        continue;
      }
      drop(CITATION_KEYS.some((key) => c[key] !== undefined && key !== 'evidence_excerpt') ? citationFailure(c, numbered) : uncitedReason(c));
    }
    if (claims.length === 0) {
      // With nothing listed, the model's stated reason, else what it sent, is the only clue to why (2026-11-16/17).
      ctx.why = droppedReason(listed.length, dropped, readable.map((one) => one.url), raw);
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
      listedClaims(previous).length === 0 && Array.isArray(previous['claims'])
        ? emptyListRepair(prompt, readable.length, lanes[0]?.id ?? 'lane')
        : `${prompt}\n\nBrain could not use your previous answer: ${why.replace(/^the answer did not survive Brain's own checks: /, '')}. ` +
      'Every claim needs "source" as a SOURCE number and "sentences" as a list of the sentence numbers inside that ' +
      'source that state it — for example {"claim":"…","source":2,"sentences":[4,5],"evidence_lane":"' +
      (lanes[0]?.id ?? 'lane') + '"} for the sentences marked [S2.4] and [S2.5]. Offer only claims a sentence states; ' +
      `if no sentence states anything the brief asks, reply {"claims":[]}.\nPrevious: ${JSON.stringify(previous).slice(0, 3000)}`,
  );
  if (ok) await complete(ctx, `free lane: claims submitted from ${readable.length} source(s)`);
  else if (/: 0 claim\(s\) offered/.test(ctx.why)) {
    // The model read these pages and listed nothing: the next attempt at this question opens others (§15).
    rememberReadWithoutAnswer(question, readable.flatMap((one) => [one.asked, one.url]));
    ctx.searchStarved = webSearchRefusing() && !readable.some((one) => fromSearch.has(one.asked) && !isEncyclopediaPage(one.asked));
  }
  return ok;
}

async function verify(ctx: Ctx, assignment: Record<string, unknown>): Promise<boolean> {
  const claims = (assignment['claimsToVerify'] as Record<string, unknown>[] | null) ?? [];
  if (claims.length === 0) return false;
  const pages = new Map<string, string>();
  // Every cited page is needed, so all are opened at once, one per host per wave.
  const queue = [...new Set(claims.map((claim) => (typeof claim['sourceUrl'] === 'string' ? claim['sourceUrl'] : null)).filter((url): url is string => !!url))];
  while (queue.length > 0) {
    const wave = takeWave(queue, queue.length);
    const fetched = await Promise.all(wave.map(async (url) => ({ url, page: await ctx.fetchSource(url) })));
    for (const { url, page } of fetched) {
      if (!page.readable) {
        pages.set(url, `UNREADABLE: ${page.reason}`);
        continue;
      }
      // The sentences that bear on the claims citing this page, verbatim: a cited passage past the page's
      // first 7 000 characters (where its menus end) is in front of the verifier, not cut off before it.
      const citing = claims.filter((claim) => claim['sourceUrl'] === url);
      const focus = citing.map((claim) => `${String(claim['claim'] ?? '')} ${String(claim['evidenceExcerpt'] ?? '')}`).join(' ');
      pages.set(url, pageSentences(page.text.slice(0, PAGE_READ_CHARS), focus).join('\n'));
    }
  }
  // Kept in the claims' own order for the prompt.
  const ordered = new Map<string, string>();
  for (const claim of claims) {
    const url = typeof claim['sourceUrl'] === 'string' ? claim['sourceUrl'] : null;
    if (url && pages.has(url) && !ordered.has(url)) ordered.set(url, pages.get(url)!);
  }
  pages.clear();
  for (const [url, text] of ordered) pages.set(url, text);
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
  // A verification is one JSON object by definition: asked for as one (`response_format`), so a
  // provider that honours it cannot wrap it in prose. One that refuses the field is asked plainly.
  const answer = await askFor(ctx, prompt, { json: true });
  if (!answer) return false;
  const known = new Set(claims.map((c) => String(c['claimId'])));
  const finalize = (raw: Record<string, unknown>): Record<string, unknown> | null => {
    const verdicts = verdictsOf(raw).filter((v) => known.has(String(v['claim_id'])));
    if (verdicts.length === 0) {
      ctx.why = verdictMissReason(raw, [...known]);
      return null;
    }
    // The tool's own top-level fields only, read beside the verdicts: a schema's `type`/`properties` is not the answer.
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const holder = 'sufficiency' in raw ? raw : Object.values(raw).find((v): v is Record<string, unknown> => isObject(v) && 'sufficiency' in v) ?? raw;
    const out: Record<string, unknown> = { verdicts };
    for (const key of ['sufficiency', 'missing_lanes', 'unresolved_gaps']) if (holder[key] !== undefined) out[key] = holder[key];
    return out;
  };
  const ok = await submitWithRepair(
    ctx,
    'brain_submit_verification',
    answer,
    (error, previous) => `${prompt}\n\nBrain refused your previous answer: ${error}\nPrevious: ${JSON.stringify(previous).slice(0, 4000)}\nCorrect it.`,
    finalize,
    /*
     * Told once what was missing, as a fragment answer has been since 2026-11-05:
     * the ids to answer and the shape, not the schema. The second answer meets the
     * same checks, and the server still judges every verdict.
     */
    (why, previous) =>
      `${prompt}\n\nBrain could not use your previous answer: ${why.replace(/^the answer did not survive Brain's own checks: /, '')}. ` +
      'Reply with ONE object {"verdicts":[...],"sufficiency":"SUFFICIENT" or "INSUFFICIENT","missing_lanes":[...]} — the answer ' +
      'itself, not a schema — with one verdict per claim, each naming its claim by "claim_id" exactly as given: ' +
      `${JSON.stringify([...known])}.\nPrevious: ${JSON.stringify(previous).slice(0, 3000)}`,
  );
  if (ok) await complete(ctx, `free lane: ${claims.length} claim(s) verified against pages Brain fetched`);
  return ok;
}

/**
 * The cited ids a synthesis submits, within the tool's list limit. Production,
 * 2026-11-16: gpt-oss-120b's packet was refused whole for listing more than
 * MAX_LIST_ITEMS ids. Every id kept is an accepted claim of this packet; the
 * ones the report cites inline come first, then the rest in the model's order. Pure.
 */
export function citedWithinLimit(report: string, cited: readonly string[]): string[] {
  const unique = [...new Set(cited)];
  if (unique.length <= MAX_LIST_ITEMS) return unique;
  const inline = unique.filter((id) => report.includes(id));
  return [...inline, ...unique.filter((id) => !report.includes(id))].slice(0, MAX_LIST_ITEMS);
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
    `establish. cited_claim_ids lists at most ${MAX_LIST_ITEMS} ids, the claims the report relies on most. ` +
    'Reply as {"report":"...","cited_claim_ids":["..."],"still_missing":["..."]}.';
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
      cited_claim_ids: citedWithinLimit(report, cited),
      still_missing: Array.isArray(raw['still_missing']) ? (raw['still_missing'] as unknown[]).map(String).filter((s) => s.trim()).slice(0, MAX_LIST_ITEMS) : [],
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
  /*
   * An audit that already came back transient (a timeout, a provider error) is
   * not asked the long way again. Production, 2026-11-05 12:20–20:00Z: audit items
   * reached lease generation 29–37, each attempt refunded as transient, so the
   * packets sat in AUDITING for hours with every audit role still queued.
   */
  const struck = (transientStrikes.get(ctx.claimed.workItemId) ?? 0) > 0;
  let raw = struck ? null : await askFor(ctx, prompt);
  // A struck audit is not asked the long way again: that call is avoided.
  if (struck && ctx.usage) ctx.usage.modelCallsAvoided += 1;
  /*
   * A long brief is where free models stop answering in JSON. Production,
   * 2026-11-05 09:18–10:18Z: ANALYSIS.AUDIT 5/25 and six packets parked "an audit
   * work item finished without recording anything", each attempt "the model
   * returned no usable JSON" on a brief of up to 60 000 characters. Once, the
   * same audit is asked over a compact brief with a JSON-only instruction; the
   * submission is judged exactly as before.
   */
  if (!raw && (struck || /no usable JSON|no JSON/i.test(ctx.why))) {
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

/**
 * Cooldowns set because the model's route (its provider, or Brain's own
 * database) was unavailable — not because of anything in the item. They say
 * the route was down, so they end the moment the same route answers again
 * (`clearRouteCooldowns`), rather than running out a clock of up to an hour.
 *
 * Production, 2026-11-15 07:46Z: brain-a held 4 of its 12 slots busy while 11
 * items waited. Its provider answered most calls ("errors acceptable") but each
 * intermittent 503 cooled that item for brain-a for 5–60 minutes, so its idle
 * slots declined every one of them ("cooling down after a provider failure")
 * and only the RunPod slot — held at 2 — could take them (rule 9).
 */
const routeCooled = new Set<string>();

/** The route answered: its outage cooldowns end, so its idle slots may take those items again. */
export function clearRouteCooldowns(model: string): number {
  let cleared = 0;
  for (const key of routeCooled) {
    if (!key.startsWith(`${model}\n`)) continue;
    routeCooled.delete(key);
    if (cooldown.delete(key)) cleared += 1;
  }
  return cleared;
}

/** Tests: end every cooldown now, as if its time had passed. Strike counts are kept. */
export function endFreeLaneCooldowns(): void {
  cooldown.clear();
  routeCooled.clear();
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
  /*
   * Down when fewer than one in five of its recent items were accepted — the
   * bar `unfitPairs` already holds a model to — not only when none were.
   * Production, 2026-11-07: brain-a answered 2 of ~47 items in three hours
   * (HTTP 503s), kept the audit and verify roles because of those 2, and the
   * GPU declined those roles 5,762 times ("the other free worker takes this
   * role"). No audit settled after 20:48Z and 21 goal rounds stayed open, so
   * nothing reached the harvest or the $10K plan.
   */
  return new Set([...byModel].filter(([, e]) => isFailing(e)).map(([m]) => m));
}

/** A model whose recent items mostly failed: at least four failures and under one in five accepted. Pure. */
export function isFailing(e: { ok: number; bad: number }): boolean {
  return e.bad >= 4 && e.ok * 5 < e.ok + e.bad;
}

/**
 * Which (model, kind of work) pairs keep failing, from the lane's own rows.
 *
 * Production, 2026-11-05 22:00Z → 11-06 02:40Z (`packets recent`): six packets
 * parked "a primary/judge/adversarial audit work item finished without
 * recording anything" — each audit had spent both attempts on the RunPod
 * Qwen3-4B slot ("produced no answer Brain accepted"), which took audits by
 * spillover while the larger models' audits succeeded beside it. A model whose
 * answers for one work type Brain has rejected at least four times in a day,
 * with fewer than one in five accepted, stops taking that type — while another
 * model in the lane is not so marked, so the work is never left with nobody.
 * Transient releases are not counted: an outage is not the model's answer.
 */
export function unfitPairs(
  rows: readonly { model: string; work_type: string; outcome: string; n: number | string; reason?: string | null }[],
  models: readonly string[],
  /**
   * Slots answering through another model right now: slot → the model it calls.
   * Production, 2026-11-06 03:48Z: with the RunPod pod refused START all night,
   * its slot fell back to the same OmniRoute model the other slots use, so
   * holding the others back from audits sent audits to that model anyway.
   */
  alias: Readonly<Record<string, string>> = {},
): Set<string> {
  const marked = new Set<string>();
  for (const [key, e] of answerTally(rows)) if (isFailing(e)) marked.add(key);
  const distinct = models.filter((m) => !(m in alias));
  // Never every distinct model for one type: the work would wait for nobody.
  for (const type of new Set([...marked].map((k) => k.slice(k.indexOf('|') + 1)))) {
    if (distinct.length > 0 && distinct.every((m) => marked.has(`${m}|${type}`))) {
      for (const m of models) marked.delete(`${m}|${type}`);
    }
  }
  // A slot answering through another model is held back exactly when that model is.
  for (const [slot, actual] of Object.entries(alias)) {
    for (const key of [...marked]) if (key.startsWith(`${slot}|`)) marked.delete(key);
    for (const key of [...marked]) {
      if (key.startsWith(`${actual}|`)) marked.add(`${slot}|${key.slice(actual.length + 1)}`);
    }
  }
  return marked;
}

/**
 * Each (model, kind of work) pair's accepted and rejected answers, and the
 * reasons its rejected ones were refused — the one tally `unfitPairs` marks
 * from and the model-output incident (`coverage.ts`) reports. Only the model's
 * own answer counts against it: an outage that ran out of strikes is recorded
 * FAILED_RETRYABLE too (Brain's database flood, 11-05). Pure.
 */
export function answerTally(
  rows: readonly { model: string; work_type: string; outcome: string; n: number | string; reason?: string | null }[],
): Map<string, { ok: number; bad: number; reasons: Map<string, number> }> {
  const tally = new Map<string, { ok: number; bad: number; reasons: Map<string, number> }>();
  for (const row of rows) {
    if (row.outcome === 'FAILED_RETRYABLE' && row.reason && notTheAnswer(row.reason)) continue;
    const key = `${row.model}|${row.work_type}`;
    const entry = tally.get(key) ?? { ok: 0, bad: 0, reasons: new Map<string, number>() };
    if (row.outcome === 'SUBMITTED') entry.ok += Number(row.n);
    else if (row.outcome === 'FAILED_RETRYABLE') {
      entry.bad += Number(row.n);
      const reason = String(row.reason ?? '');
      entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + Number(row.n));
    }
    tally.set(key, entry);
  }
  return tally;
}

/**
 * A failure that says Brain, the provider or the sources were unavailable, not
 * that the answer was wrong. Production, 2026-11-16 17:25Z: 26 fragments waited
 * with no slot busy, "answers … rejected" the top decline (148,575 since boot),
 * and the lane accepted 2 claims an hour. The day of rows it judged held hours
 * when the GPU slot's calls never reached the model ("model call failed [broken
 * GPU]", stale pod routing, fixed in #984) and pages no model could open ("no
 * readable source": 404s and DNS failures every model met alike). A model that
 * never answered, or that Brain gave nothing to read, is not judged by it.
 *
 * Nor is one that read the pages and said, in words, why none of them states
 * what the brief asks (W13, 2026-11-17): gpt-oss-120b was held back from every
 * fragment for 20 empty lists in an hour while the model the work went to wrote
 * claims from the brief instead of a page. Declining to invent is the evidence
 * bar working; it is not accepted either, so it never makes a model look fit.
 * A bare empty list with no stated reason still counts against the model.
 */
export function notTheAnswer(reason: string): boolean {
  return (
    /threw:|refused: .*(?:connection|timeout|not queryable)|: model call failed|: no readable source among|; the model listed none because: \S/i.test(reason) ||
    BRAIN_UNAVAILABLE.test(reason) ||
    PROVIDER_BUSY.test(reason)
  );
}

let fitness: { at: number; unfit: Set<string> } | null = null;
/** Tests: forget the cached fitness reading. */
export function resetFreeLaneFitness(): void {
  fitness = null;
  pairProbes.clear();
  resetRouteHealth();
}
export async function unfitNow(models: readonly string[], now = Date.now(), fallbackModel: string | null = null): Promise<Set<string>> {
  if (fitness && now - fitness.at < 5 * 60_000) return fitness.unfit;
  const rows = await answerRows(now);
  // The RunPod slot is its own model only while the GPU is answering.
  const alias: Record<string, string> = {};
  if (fallbackModel) {
    const gpuServing = !runpodPaused() && !runpodBreakerOpen(now) && runpodCallWindow(30 * 60_000, now).ok > 0;
    for (const m of models) if (isRunpodSlot(m) && !gpuServing && m !== fallbackModel) alias[m] = fallbackModel;
  }
  const unfit = unfitPairs(rows, models, alias);
  fitness = { at: now, unfit };
  return unfit;
}

/**
 * The answers fitness is judged on: each (model, kind of work) pair's most
 * recent RECENT_ANSWERS judged answers within the last day, by model, kind,
 * outcome and reason. Production, 2026-11-17 04:38–05:45Z: #1014 fixed the
 * page truncation behind gpt-oss-120b's empty fragment answers, but a day of
 * pre-fix rejections kept it held back from RESEARCH_FRAGMENT, so the H200
 * sat 0.28 slots busy and produced 1 accepted claim in an hour ($3.59) while
 * it held no new answer that could ever clear it. A pair is judged on what it
 * does now, and `pairProbeDue` gives a held pair the answers to show it.
 * Answers that are not the model's own (`notTheAnswer`) do not use up the window.
 */
export async function answerRows(now = Date.now()): Promise<{ model: string; reason: string | null; work_type: string; outcome: string; n: number | string }[]> {
  const rows = await getDb().all<{ reason: string | null; work_type: string; outcome: string }>(
    `SELECT e.reason, w.work_type, e.outcome FROM bin_events e
       JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ?
      ORDER BY e.at DESC`,
    [new Date(now - 86_400_000).toISOString()],
  );
  return recentAnswers(rows);
}

/** How many of a pair's latest judged answers decide whether it is fit. */
export const RECENT_ANSWERS = 10;

/** Newest-first answer rows → each pair's latest RECENT_ANSWERS judged answers, grouped. Pure. */
export function recentAnswers(
  rows: readonly { reason: string | null; work_type: string; outcome: string }[],
): { model: string; reason: string | null; work_type: string; outcome: string; n: number }[] {
  const judged = new Map<string, number>();
  const grouped = new Map<string, { model: string; reason: string | null; work_type: string; outcome: string; n: number }>();
  for (const row of rows) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0]!;
    const pair = `${model}|${row.work_type}`;
    const counts = row.outcome === 'SUBMITTED' || (row.outcome === 'FAILED_RETRYABLE' && !(row.reason && notTheAnswer(row.reason)));
    if (counts) {
      const seen = judged.get(pair) ?? 0;
      if (seen >= RECENT_ANSWERS) continue;
      judged.set(pair, seen + 1);
    }
    const key = `${pair}\t${row.outcome}\t${row.reason ?? ''}`;
    const entry = grouped.get(key) ?? { model, reason: row.reason, work_type: row.work_type, outcome: row.outcome, n: 0 };
    entry.n += 1;
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

/** How often a held (model, kind) pair is given one item to show whether it still fails. */
export const PAIR_REPROBE_MS = 30 * 60_000;
const pairProbes = new Map<string, number>();

/** Whether a held pair is due its re-probe item. It only reads. */
export function pairProbeDue(model: string, workType: string, now = Date.now()): boolean {
  return now - (pairProbes.get(`${model}|${workType}`) ?? 0) >= PAIR_REPROBE_MS;
}

/** The admitted item is the held pair's re-probe; the next waits PAIR_REPROBE_MS. */
export function takePairProbe(model: string, workType: string, now = Date.now()): void {
  pairProbes.set(`${model}|${workType}`, now);
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

/**
 * The work types a slot asks the queue for, one list per ask, in priority order.
 *
 * `claimWork` reads a bounded window of the queue (8 + 16 + 32 rows) and offers
 * each row to the lane's `admit` rule. One ask for several types let rows the
 * slot must decline — the other worker's role, a type it can never take —
 * fill that window, so claimable work of another type behind them was never
 * offered while the lane sat idle (rule 9, IDLE_CAPACITY). A slot now never
 * asks for a type `workerFor` always gives the other worker, and asks for one
 * type at a time, so declined rows of one type cannot hide another's. Pure.
 */
export function claimAsks(
  workers: readonly { model: string }[],
  index: number,
  spillover = false,
): FreeLaneWorkType[][] {
  const asks: FreeLaneWorkType[][] = [];
  for (const group of CLAIM_ORDER) {
    for (const type of group) {
      if (!spillover && workers.length >= 2) {
        // RESEARCH_AUDIT goes to either worker by its payload role; the rest are fixed.
        const owner = type === 'RESEARCH_VERIFY' ? 1 : type === 'RESEARCH_AUDIT' ? index : 0;
        if (owner !== index) continue;
      }
      asks.push([type]);
    }
  }
  return asks;
}

/** Rows one claim reads in all (8 + 16 + 32): a claim that declined this many saw no more. */
const CLAIM_WINDOW = 56;

/** The work types with at least one claimable row in these projects. */
async function waitingTypes(projectIds: string[]): Promise<Map<string, number>> {
  const now = queueNow();
  const rows = await getDb().all<{ work_type: string; top: number | string }>(
    `SELECT work_type, MAX(priority) AS top FROM work_items
      WHERE ${CLAIMABLE_SQL} AND project_id IN (${projectIds.map(() => '?').join(', ')})
      GROUP BY work_type`,
    [now, now, ...projectIds],
  );
  return new Map(rows.map((row) => [row.work_type, Number(row.top)]));
}

/**
 * The asks, most important waiting work first (Brain-wide resource rule, §98).
 *
 * Stage order (`CLAIM_ORDER`) used to come before priority, so an approved
 * revenue goal's research — boosted by `GOAL_PRIORITY_BOOST` — waited behind
 * any unrelated synthesis, audit or verification. The highest priority waiting
 * in each ask now decides the order; stage order breaks ties. Pure.
 */
export function asksByPriority(
  asks: readonly FreeLaneWorkType[][],
  waiting: ReadonlyMap<string, number>,
): FreeLaneWorkType[][] {
  const top = (types: readonly string[]) => Math.max(-Infinity, ...types.map((type) => waiting.get(type) ?? -Infinity));
  return asks
    .map((types, index) => ({ types, index, top: top(types) }))
    .filter((one) => one.top > -Infinity)
    .sort((a, b) => b.top - a.top || a.index - b.index)
    .map((one) => one.types);
}

/** Packets holding claimable rows of these types, best priority first, bounded. */
async function waitingPackets(projectIds: string[], types: readonly string[]): Promise<string[]> {
  const now = queueNow();
  const rows = await getDb().all<{ orchestration_id: string }>(
    `SELECT orchestration_id, MAX(priority) AS top FROM work_items
      WHERE ${CLAIMABLE_SQL} AND orchestration_id IS NOT NULL
        AND project_id IN (${projectIds.map(() => '?').join(', ')})
        AND work_type IN (${types.map(() => '?').join(', ')})
      GROUP BY orchestration_id ORDER BY MAX(priority) DESC, orchestration_id LIMIT 10`,
    [now, now, ...projectIds, ...types],
  );
  return rows.map((row) => row.orchestration_id);
}

/**
 * The research allocation in force, as the priority step each purpose takes
 * (RES-07, RES-15-5, review F1).
 *
 * The goals tick decides the five purposes' shares and steps live bins by them,
 * but the free lane claims `work_items` by their own priority, which no decision
 * changes — so the compute the yield reader counts in each purpose's observed
 * share could not be moved by the decision that reads it, and decided and
 * observed shares never converged. The lane now reads the same decision row
 * (`productionResearchAllocationPorts().lastDecision()`, through the tick's own
 * parser and `purposePriorityShifts`) and orders the packets it claims from by
 * it. Read-only: nothing is written, so a step is never applied twice and the
 * stored priority each owner set stays its own. Read at most once a minute; a
 * held, absent or unreadable decision steps nothing.
 */
let shiftsRead: { at: number; shifts: Record<string, number> | null } | null = null;
async function researchShiftsInForce(): Promise<Record<string, number> | null> {
  if (shiftsRead && Date.now() - shiftsRead.at < 60_000) return shiftsRead.shifts;
  let shifts: Record<string, number> | null = null;
  try {
    const tick = await import('../goals/tick.ts');
    const { purposePriorityShifts } = await import('../goals/researchAllocation.ts');
    const parsed = tick.sharesInForceFrom((await (await tick.productionResearchAllocationPorts()).lastDecision())?.detail ?? null);
    if (parsed && !parsed.held) {
      const stepped = purposePriorityShifts(parsed);
      if (Object.values(stepped).some((step) => step !== 0)) shifts = stepped;
    }
  } catch (error) {
    console.warn('[free-lane] research allocation unreadable; claiming by stored priority:', String((error as Error)?.message ?? error).slice(0, 200));
  }
  shiftsRead = { at: Date.now(), shifts };
  return shifts;
}

/** Forget the decision read, so the next take re-reads it (tests, and a new decision). */
export function resetResearchShifts(): void {
  shiftsRead = null;
}

/**
 * Packets in the order the decision in force says: each packet's best waiting
 * priority plus the step of the purposes it serves (the highest step among
 * them, as for a bin — `binPriorityShift`). Ties keep stored priority, then id.
 * Pure.
 */
export function packetsByAllocation(packets: readonly { id: string; top: number; shift: number }[]): string[] {
  return [...packets]
    .sort((a, b) => b.top + b.shift - (a.top + a.shift) || b.top - a.top || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((one) => one.id);
}

/** How many packets a take asks in decision order before the ordinary scan. */
const ALLOCATED_PACKETS = 5;

/** Packets holding claimable rows of these types, ordered by the decision in force, bounded. */
async function allocatedPackets(projectIds: string[], types: readonly string[], shifts: Record<string, number>): Promise<string[]> {
  const now = queueNow();
  const rows = await getDb().all<{ orchestration_id: string; project_id: string; top: number | string }>(
    `SELECT orchestration_id, MIN(project_id) AS project_id, MAX(priority) AS top FROM work_items
      WHERE ${CLAIMABLE_SQL} AND orchestration_id IS NOT NULL
        AND project_id IN (${projectIds.map(() => '?').join(', ')})
        AND work_type IN (${types.map(() => '?').join(', ')})
      GROUP BY orchestration_id ORDER BY MAX(priority) DESC, orchestration_id LIMIT 50`,
    [now, now, ...projectIds, ...types],
  );
  if (rows.length === 0) return [];
  const { purposesOfBins } = await import('../goals/researchYield.ts');
  const { binPriorityShift } = await import('../goals/researchAllocation.ts');
  const purposes = await purposesOfBins(rows.map((row) => ({ id: row.orchestration_id, orchestrationId: row.orchestration_id, projectId: row.project_id })));
  return packetsByAllocation(
    rows.map((row) => ({
      id: row.orchestration_id,
      top: Number(row.top),
      shift: binPriorityShift(purposes.get(row.orchestration_id) ?? [], shifts as Parameters<typeof binPriorityShift>[1]),
    })),
  ).slice(0, ALLOCATED_PACKETS);
}

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
  /** How often the held lease is renewed while the item is worked. Tests shorten it. */
  heartbeatMs?: number;
}

/**
 * Renew the lease every `everyMs` until stopped, through `brain_heartbeat_work`:
 * the queue's guarded UPDATE that moves the expiry only while this exact lease
 * generation is still current (§19, §24), so a heartbeat can never take back an
 * item another worker has since claimed. The first refusal ends the renewals;
 * the submit then reports the lost lease as before.
 *
 * Production 62c38137, 2026-11-18 15:01–15:50Z (paid RunPod H200 run): the lane
 * claimed with a fixed 20-minute lease and never renewed it, while RunPod jobs
 * averaged ~671 s and auto/best-coding audits ~1,164 s. Four GPU audits and one
 * auto/best-coding audit finished past expiry and were refused at submit, "This
 * lease is no longer current" — paid work discarded.
 */
export function keepLeaseAlive(renew: () => Promise<unknown>, everyMs: number): () => void {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    renew()
      .catch((error) => {
        // Not current any more (expired, reclaimed or ended): stop asking.
        stopped = true;
        clearInterval(timer);
        console.warn('[free-lane] lease heartbeat refused:', String((error as Error)?.message ?? error).slice(0, 200));
      })
      .finally(() => {
        inFlight = false;
      });
  }, Math.max(1, everyMs));
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** A renewal well inside the lease, so one slow or missed heartbeat does not lose it. */
const HEARTBEAT_MS = Math.floor(LEASE_MS / 4);

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

/* ------------------------------------------------------------------------- */
/* Route health: which cause, and which route to stop sending items to        */
/* ------------------------------------------------------------------------- */

/** The cause a failing model route reports, read from its own error, never a guess. */
export type RouteFailureCause =
  | 'credentials'
  | 'task routing'
  | 'broken GPU'
  | 'provider availability'
  | 'database'
  | 'unclassified';

export const ROUTE_FAILURE_CAUSES: readonly RouteFailureCause[] = [
  'credentials',
  'task routing',
  'broken GPU',
  'provider availability',
  'database',
  'unclassified',
];

/**
 * Names the actual cause of a model-call failure so the recorded reason says which one it was.
 * `gpuDown` is the GPU slot's own measured state (`gpuDown`): on that slot the
 * message is usually the free fallback's error, because the GPU's own error
 * was swallowed when the call fell back — 2026-11-09, run 42577770227, the pod
 * had been deleted, every GPU call got a 404, and 325 failures were recorded
 * as "cheap lane HTTP N", which named the fallback and hid the GPU.
 */
export function classifyRouteFailure(message: string, route: { gpuDown?: boolean } = {}): RouteFailureCause {
  if (route.gpuDown || /\brunpod (?:HTTP|returned|unavailable)\b/i.test(message)) return 'broken GPU';
  if (/\b(?:HTTP (?:401|403)|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication|credential)/i.test(message)) return 'credentials';
  if (/\b(?:HTTP 404|model[^.]{0,40}not (?:found|available|loaded)|no such model|unknown model|unsupported model)/i.test(message)) return 'task routing';
  if (/\b(?:gpu|cuda|runpod|pod (?:not|is|has)|out of memory|OOM)\b/i.test(message)) return 'broken GPU';
  if (BRAIN_UNAVAILABLE.test(message)) return 'database';
  if (PROVIDER_BUSY.test(message)) return 'provider availability';
  return 'unclassified';
}

/** A credential never reaches a recorded reason: bearer tokens and key-shaped strings are cut out. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rpa|ghp|gho|ghs|xox[a-z])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, '$1[redacted]');
}

/** How far back the GPU slot's own calls are read to say it is down. */
export const GPU_DOWN_WINDOW_MS = 15 * 60_000;

/**
 * Whether a GPU slot's own calls are failing: in the window at least one GPU
 * call failed and none answered. A pod paused on purpose is not down (its calls
 * go to the fallback without touching the GPU), and a free-provider route never is.
 */
export function gpuDown(model: string, now = Date.now()): boolean {
  if (!isRunpodSlot(model) || runpodPaused()) return false;
  const window = runpodCallWindow(GPU_DOWN_WINDOW_MS, now);
  return window.failed > 0 && window.ok === 0;
}

/**
 * The cause a recorded reason names: the `[cause]` tag `ask` wrote when there
 * is one (it was decided with the GPU's state in hand, which the text alone no
 * longer carries), otherwise classified from the text. Null for a reason that
 * is not a model-call failure.
 */
export function causeOfReason(reason: string | null): RouteFailureCause | null {
  const text = reason ?? '';
  if (!/model call failed/.test(text)) return null;
  const tag = /model call failed \[([^\]]+)\]/.exec(text)?.[1];
  const known = ROUTE_FAILURE_CAUSES.find((cause) => cause === tag);
  return known ?? classifyRouteFailure(text);
}

/** Consecutive provider failures after which a route stops being offered items. */
export const ROUTE_FAILURE_LIMIT = 3;
const ROUTE_REPROBE_MS = 5 * 60_000;
const routeHealth = new Map<string, { failures: number; cause: RouteFailureCause; nextProbeAt: number }>();

/**
 * How far back a route's own call outcomes are read to judge it, and how many are kept. The same
 * half hour `failingModels` reads, held in memory so it binds inside a tick rather than across ticks.
 */
export const ROUTE_WINDOW_MS = 30 * 60_000;
const ROUTE_WINDOW_MAX = 64;
const routeWindow = new Map<string, { at: number; ok: boolean; cause: RouteFailureCause | null }[]>();

/** Routes whose window this process has already rebuilt from the lane's rows. */
const routeRestored = new Set<string>();

/** Tests: forget every route's health. */
export function resetRouteHealth(): void {
  routeHealth.clear();
  routeWindow.clear();
  routeRestored.clear();
}

/**
 * Rebuild each route's breaker from the lane's own durable rows, once per process.
 *
 * The window and the hold are memory, so a worker restart used to reopen a failing route to every
 * slot until it re-accumulated ROUTE_FAILURE_LIMIT failures (CAP-16-3, episode 3 review F1). The
 * same outcomes are already recorded: each item writes one `FREE_LANE_ITEM` row naming its model and
 * its reason (`takeOne`). Those rows are the record, and the breaker is derived from them: the last
 * ROUTE_WINDOW_MS of a route's rows are replayed, at their own times and in order, through
 * `recordRouteOutcome` — the same rule that judged them live — so after a restart the route stands
 * exactly where it would have stood had the process never stopped. Nothing new is stored.
 *
 * A route this process has already judged is left alone (its in-memory window holds the same rows,
 * and replaying them would count them twice). A failed read rebuilds nothing and is retried on the
 * next tick: the breaker then starts from live calls, as it did before.
 */
export async function restoreRouteHealth(models: readonly string[], now = Date.now()): Promise<number> {
  const pending = [...new Set(models)].filter((model) => !routeRestored.has(model));
  if (pending.length === 0) return 0;
  let rows: { at: string; outcome: string | null; reason: string | null }[];
  try {
    rows = await getDb().all<{ at: string; outcome: string | null; reason: string | null }>(
      `SELECT at, outcome, reason FROM bin_events
        WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at <= ?
        ORDER BY at ASC, id ASC`,
      [new Date(now - ROUTE_WINDOW_MS).toISOString(), new Date(now).toISOString()],
    );
  } catch {
    return 0;
  }
  let replayed = 0;
  for (const model of pending) {
    routeRestored.add(model);
    // Already judged live in this process: its window is current.
    if ((routeWindow.get(model)?.length ?? 0) > 0 || routeHealth.has(model)) continue;
    const ok = `model ${model}`;
    const failed = `model ${model}: `;
    for (const row of rows) {
      const reason = row.reason ?? '';
      const at = Date.parse(row.at);
      if (!Number.isFinite(at)) continue;
      if (row.outcome === 'SUBMITTED' && reason === ok) recordRouteOutcome(model, { ok: true }, at);
      else if (row.outcome !== 'SUBMITTED' && reason.startsWith(failed)) recordRouteOutcome(model, { ok: false, why: reason.slice(failed.length) }, at);
      else continue;
      replayed += 1;
    }
  }
  return replayed;
}

/**
 * Whether a route's recent calls mostly failed: the bar `isFailing` holds a model to (at least four
 * failures and under one in five answered), read over its last ROUTE_WINDOW_MS of outcomes.
 *
 * Production, 2026-11-16 16:48Z (CAP-16-3, episode 3): brain-a's provider was "overloaded: 89% of 9
 * calls failed" beside a healthy GPU route, and r01.cap-16-3 read 62–98% of six hours' lane outcomes
 * as provider failures. The breaker counted only consecutive failures and forgot everything on one
 * success, and that success also ended every route cooldown (`clearRouteCooldowns`). So a provider
 * answering about one call in nine was never held: each rare answer reopened it to every slot and
 * every cooled item, and each of those recorded another "model call failed". A route is judged by its
 * ratio instead. One success no longer reopens a route that is still mostly failing, and a route that
 * mostly answers through occasional 503s (the 2026-11-15 07:46Z case) is never held by it.
 */
export function routeWindowFailing(model: string, now = Date.now()): boolean {
  const recent = (routeWindow.get(model) ?? []).filter((one) => now - one.at < ROUTE_WINDOW_MS);
  const ok = recent.filter((one) => one.ok).length;
  return isFailing({ ok, bad: recent.length - ok });
}

function noteRouteCall(model: string, entry: { at: number; ok: boolean; cause: RouteFailureCause | null }): void {
  const kept = (routeWindow.get(model) ?? []).filter((one) => entry.at - one.at < ROUTE_WINDOW_MS);
  kept.push(entry);
  routeWindow.set(model, kept.slice(-ROUTE_WINDOW_MAX));
}

/**
 * A failing route's standing: null when it is healthy or due its single re-probe item.
 * It only reads: asking does not spend the re-probe slot, because the item being
 * asked about may still be declined by a later filter (unfit, not free-lane work,
 * the admission audit). The slot is spent by `takeRouteProbe`, once an item is
 * actually admitted onto the route.
 */
export function routeHold(model: string, now = Date.now()): string | null {
  const state = routeHealth.get(model);
  if (!state || state.failures < ROUTE_FAILURE_LIMIT) return null;
  if (now >= state.nextProbeAt) return null;
  return `model route failing (${state.cause}); another model takes the work until it is re-probed`;
}

/**
 * An item was admitted onto a held route that was due its re-probe: that item is
 * the probe, and the next is held until it answers. A healthy route is untouched.
 */
export function takeRouteProbe(model: string, now = Date.now()): void {
  const state = routeHealth.get(model);
  if (!state || state.failures < ROUTE_FAILURE_LIMIT) return;
  if (now >= state.nextProbeAt) state.nextProbeAt = now + ROUTE_REPROBE_MS;
}

/**
 * A route that answered is healthy again — unless its recent calls still mostly failed
 * (`routeWindowFailing`), when the answer was its re-probe and the route stays held until the next
 * one. A route that did not answer is counted, with its cause. Returns whether the route is open.
 */
export function recordRouteOutcome(model: string, outcome: { ok: boolean; why?: string }, now = Date.now()): boolean {
  if (outcome.ok) {
    noteRouteCall(model, { at: now, ok: true, cause: null });
    if (!routeWindowFailing(model, now)) {
      routeHealth.delete(model);
      return true;
    }
    const recent = routeWindow.get(model) ?? [];
    const cause = [...recent].reverse().find((one) => !one.ok)?.cause ?? routeHealth.get(model)?.cause ?? 'unclassified';
    const state = routeHealth.get(model) ?? { failures: 0, cause, nextProbeAt: now };
    state.failures = Math.max(state.failures, ROUTE_FAILURE_LIMIT);
    state.nextProbeAt = now + ROUTE_REPROBE_MS;
    routeHealth.set(model, state);
    return false;
  }
  const why = outcome.why ?? '';
  if (!/^model call failed/.test(why) && !BRAIN_UNAVAILABLE.test(why)) return routeHold(model, now) === null;
  const cause = causeOfReason(why) ?? classifyRouteFailure(why);
  // Brain's own database being busy says nothing about the model route.
  if (cause === 'database') return routeHold(model, now) === null;
  noteRouteCall(model, { at: now, ok: false, cause });
  const state = routeHealth.get(model) ?? { failures: 0, cause, nextProbeAt: now + ROUTE_REPROBE_MS };
  const wasHeld = state.failures >= ROUTE_FAILURE_LIMIT;
  state.failures += 1;
  state.cause = cause;
  // A route whose window is over the bar is held now, however its failures were interleaved.
  if (routeWindowFailing(model, now)) state.failures = Math.max(state.failures, ROUTE_FAILURE_LIMIT);
  if (!wasHeld && state.failures >= ROUTE_FAILURE_LIMIT) state.nextProbeAt = now + ROUTE_REPROBE_MS;
  routeHealth.set(model, state);
  return false;
}

/**
 * Whether a model is held back from a kind of work: it is marked unfit for it
 * AND another model in the lane can take it now — not marked, and its route
 * not held. Pure. Production, 2026-11-16 18:05–19:04Z: gpt-oss-120b was marked
 * unfit for RESEARCH_FRAGMENT while brain-a's route was held on HTTP 429s, so
 * 33 fragments waited with no slot busy (143,318 declines "another model takes
 * it") and nothing was submitted for an hour. `unfitPairs` never marks every
 * model, but a model whose route is down takes nothing either.
 */
export function heldBackFor(
  model: string,
  workType: string,
  models: readonly string[],
  unfit: ReadonlySet<string>,
  hold: (model: string) => string | null,
): boolean {
  if (!unfit.has(`${model}|${workType}`)) return false;
  return models.some((other) => other !== model && !unfit.has(`${other}|${workType}`) && hold(other) === null);
}

export async function takeOne(input: TakeInput): Promise<{ claimed: ClaimedWork | null; ok: boolean; ms: number }> {
  const { workers, worker, index, config } = input;
  const projectIds = await projectsFor(worker);
  if (projectIds.length === 0) return { claimed: null, ok: false, ms: 0 };
  let session = '';
  let one: ClaimedWork | undefined;
  // The bin each admitted item belongs to, so its FREE_LANE_ITEM row names it.
  const owners = new Map<string, string>();
  const unfit = await unfitNow(workers.map((w) => w.model), Date.now(), config.fallbackModel ?? null);
  const scopes = projectIds.map((projectId) => ({ projectId, scopes: [...CONNECTOR_SCOPES] }));
  const admit = async (item: WorkItemRow) => {
    if (!input.spillover && workerFor(workers, item) !== index) {
      return { ok: false, reason: 'the other free worker takes this role' };
    }
    if ((cooldown.get(cooldownKey(worker.model, item.id)) ?? 0) > Date.now()) return { ok: false, reason: 'cooling down after a provider failure' };
    const held = routeHold(worker.model);
    if (held) return { ok: false, reason: held };
    /*
     * Another model takes this item only if it could take it now: its route not
     * held AND the item not cooling down for it. Production, 2026-11-16 19:50–20:09Z:
     * every waiting fragment was cooling down for brain-a after its 429s, so it
     * never admitted its route re-probe, its overdue probe read as a healthy route,
     * and the GPU stayed held back with 35 fragments waiting and nothing running.
     */
    const otherHold = (model: string): string | null =>
      routeHold(model) ?? ((cooldown.get(cooldownKey(model, item.id)) ?? 0) > Date.now() ? 'cooling down after a provider failure' : null);
    const pairProbe = heldBackFor(worker.model, item.work_type, workers.map((w) => w.model), unfit, otherHold);
    if (pairProbe && !pairProbeDue(worker.model, item.work_type)) {
      return { ok: false, reason: 'this model’s answers for this kind of work are rejected; another model takes it' };
    }
    if (!(await freeLaneAdmits(item))) return { ok: false, reason: 'not free-lane work' };
    const owner = await owningBin(item);
    if (owner) owners.set(item.id, owner.binId);
    session = sessionFor(worker, item);
    const admitted = await auditAdmission({ workerId: worker.workerId, routineId: null, accountId: null, sessionRef: session })(item);
    // Only an item that passed every filter spends a held route's re-probe slot.
    if (admitted.ok) {
      takeRouteProbe(worker.model);
      if (pairProbe) takePairProbe(worker.model, item.work_type);
    }
    return admitted;
  };
  const ask = async (types: FreeLaneWorkType[], orchestrationId: string | null): Promise<ClaimedWork | undefined> => {
    let declined = 0;
    const claimed = await claimWork({
      workerId: worker.workerId,
      scopes,
      workTypes: [...types],
      orchestrationId,
      limit: 1,
      leaseMs: LEASE_MS,
      admit,
      onSkip: (_item, reason) => {
        declined += 1;
        // Per model: 453,012 "answers … rejected" declines (2026-11-16 20:07Z) did not say whose.
        const key = `${worker.model}: ${reason.slice(0, 80)}`;
        skipTally.set(key, (skipTally.get(key) ?? 0) + 1);
      },
    });
    if (claimed[0]) return claimed[0];
    // A window the lane declined end to end may hide claimable rows of the same
    // type behind it (e.g. the other role's audits). Ask once per packet holding
    // such rows, so one packet's declined rows cannot hide another's.
    if (orchestrationId === null && declined >= CLAIM_WINDOW) {
      for (const id of await waitingPackets(projectIds, types)) {
        const inPacket = await ask(types, id);
        if (inPacket) return inPacket;
      }
    }
    return undefined;
  };
  // Only types that have claimable rows are asked for: each ask is a bounded scan.
  const waiting = await waitingTypes(projectIds);
  // Under a research allocation that steps a purpose, the packets are asked in
  // the order it gives before the ordinary priority scan, so the decision moves
  // the free lane's compute and not only bins (RES-07, review F1).
  const shifts = await researchShiftsInForce();
  for (const types of asksByPriority(claimAsks(workers, index, input.spillover), waiting)) {
    if (shifts) {
      for (const id of await allocatedPackets(projectIds, types, shifts)) {
        one = await ask(types, id);
        if (one) break;
      }
      if (one) break;
    }
    one = await ask(types, null);
    if (one) break;
  }
  if (!one) return { claimed: null, ok: false, ms: 0 };
  const started = Date.now();
  const meterKey = `${one.workItemId}:${one.leaseId}`;
  const usage = itemMeters.open(meterKey);
  const io = meteredIo(usage, { completer: input.completer, fetchSource: input.fetchSource, search: input.search });
  const ctx: Ctx = {
    worker,
    principal: principalFor(worker, projectIds, session),
    claimed: one,
    completer: io.completer,
    fetchSource: io.fetchSource,
    search: io.search,
    config,
    why: 'the model returned no usable JSON',
    usage,
  };
  let ok = false;
  // The lease is renewed for as long as the item is worked, not sized to a guess
  // at how long a model takes (see `keepLeaseAlive`).
  const stopHeartbeat = keepLeaseAlive(
    () => call(ctx, 'brain_heartbeat_work', { ...proof(ctx), lease_ms: LEASE_MS }),
    input.heartbeatMs ?? HEARTBEAT_MS,
  );
  try {
    ok = await answerItem(ctx);
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 300);
    console.warn(`[free-lane] ${one.workType} ${one.workItemId} threw:`, message);
    // The failure is the exception, not the default "no usable JSON" (2026-11-05: every
    // failed audit read that way and the cause was unreadable from the rows).
    ctx.why = `threw: ${message}`;
  } finally {
    stopHeartbeat();
  }
  /*
   * A verification the model answered in words, and answered again in words when
   * told what was wrong, is that model's answer to this item: asking it again
   * later is the same prompt at temperature 0 and the same reply. Production,
   * 2026-11-17 01:37–07:37Z: 112 RESEARCH_VERIFY releases "no JSON in a
   * N-character reply" (identical lengths on every retry) against 40 failures,
   * and a release is not counted by `unfitPairs`, so the loop also hid the
   * failures from the rule that routes the work to a model that can do it.
   * It fails now — counted against the model — and this model leaves the item
   * to another one. An empty reply or a failed call is still transient.
   */
  const answeredWithoutJson = !ok && one.workType === 'RESEARCH_VERIFY' && /^no JSON in a [1-9]\d*-character reply/.test(ctx.why);
  const transient = !ok && /^(model call failed|no JSON)/.test(ctx.why) && !answeredWithoutJson;
  if (answeredWithoutJson) {
    const key = cooldownKey(worker.model, one.workItemId);
    cooldown.set(key, Date.now() + 60 * 60_000);
    // The item's own answer, not a route outage: a later success on the route does not end it.
    routeCooled.delete(key);
  }
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
  /*
   * Nor does a fragment that found no readable source while web search was
   * refusing. Production 0ba2eb30, 2026-11-18 01:00–01:45Z: DuckDuckGo refused
   * for longer than a fragment waits, 27 fragments failed "no readable source
   * … none from web search", each spending one of its two attempts (31 of 40
   * fragments failed, every retry ineffective), and a goal's rounds ended
   * without a report. Refunded and cooled like a provider outage, so research
   * resumes with its work when search answers again.
   */
  const searchOutage =
    !ok &&
    one.workType === 'RESEARCH_FRAGMENT' &&
    ((/^no readable source among/.test(ctx.why) && webSearchRefusing()) || ctx.searchStarved === true);
  const strikes = transient || brainUnavailable || searchOutage ? (transientStrikes.get(one.workItemId) ?? 0) + 1 : 0;
  const refund = (transient || brainUnavailable || searchOutage) && (strikes < 3 || providerFailure || searchOutage);
  // Recorded before the cooldowns are touched: one answer from a route whose recent calls still
  // mostly failed is its re-probe, and does not reopen it to every cooled item (CAP-16-3).
  const routeOpen = recordRouteOutcome(worker.model, { ok, why: ctx.why });
  if (ok) {
    transientStrikes.delete(one.workItemId);
    if (routeOpen) clearRouteCooldowns(worker.model);
  } else if (refund) {
    /*
     * The model or its provider failed, not the work: hand the item back with
     * its attempt refunded, and leave it alone for a while so a provider outage
     * cannot spend the item's attempt budget.
     */
    transientStrikes.set(one.workItemId, strikes);
    // Brain's own database being full clears in seconds, not the hour a provider
    // outage can last: the item is offered again after a minute.
    const coolMs = brainUnavailable && !/^model call failed/.test(ctx.why) ? 60_000 : Math.min(60, 5 * strikes) * 60_000;
    const key = cooldownKey(worker.model, one.workItemId);
    cooldown.set(key, Date.now() + coolMs);
    // A route outage, not the item's own answer: ended by the route's next success.
    if (providerFailure) routeCooled.add(key);
    else routeCooled.delete(key);
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
  const used = itemMeters.close(meterKey) ?? usage;
  await recordBinEvent({
    eventType: 'FREE_LANE_ITEM',
    binId: owners.get(one.workItemId) ?? null,
    projectId: one.projectId,
    workItemId: one.workItemId,
    workerId: worker.workerId,
    sessionRef: session,
    workloadClass: one.workType,
    outcome: ok ? 'SUBMITTED' : refund ? 'RELEASED_TRANSIENT' : 'FAILED_RETRYABLE',
    reason: ok ? `model ${worker.model}` : `model ${worker.model}: ${ctx.why}`.slice(0, 480),
    durationMs: ms,
    evidenceClass: 'MEASURED',
    measures: { usage: used, ...(ctx.discovery ? { discovery: ctx.discovery } : {}) },
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
    // After a restart, each route's breaker resumes from the lane's recorded outcomes (CAP-16-3).
    await restoreRouteHealth(all.map((w) => w.model));
    /*
     * Reroute: a model whose free-lane items in the last half hour mostly failed
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
  /*
   * The GPU budget binds from boot, not from the pool's first step minutes later: a pod
   * RUNNING when Brain starts (a deploy restarted it, production 2026-11-17 01:22Z) is
   * counted at once from RunPod's own start time, and stopped if it has exhausted the budget.
   */
  const budgetCheck = setTimeout(() => {
    void import('../cheap/runpodPod.ts')
      .then(({ superviseRunpodPod }) => superviseRunpodPod({ waiting: 0, inFlight: 0 }, { budgetOnly: true }))
      .catch((error) => console.warn('[runpod] boot budget check failed:', (error as Error).message));
  }, Math.min(delayMs, BOOT_BUDGET_CHECK_MS));
  budgetCheck.unref?.();
  const wait = setTimeout(() => {
    begin();
    measureStages();
    const every = setInterval(measureStages, STAGE_CAPACITY_INTERVAL_MS);
    every.unref?.();
    stageTimer = every;
  }, delayMs);
  wait.unref?.();
  timer = wait as unknown as NodeJS.Timeout;
}

/** How soon after boot the GPU budget is checked against RunPod's own billing. */
export const BOOT_BUDGET_CHECK_MS = 15_000;

/** How often the lane records its per-stage capacity reading (CAP-16-3). */
export const STAGE_CAPACITY_INTERVAL_MS = 60 * 60_000;
let stageTimer: NodeJS.Timeout | null = null;

/**
 * Record the per-stage capacity measurement (`stageCapacity.ts`) as a
 * `bin_events` row. Background only: the web process never waits on it.
 */
function measureStages(): void {
  void import('./stageCapacity.ts')
    .then(({ recordStageCapacity }) => recordStageCapacity())
    .catch((error) => console.warn('[free-lane] stage capacity not recorded:', (error as Error).message));
}

export function stopFreeLaneLoop(): void {
  if (timer) clearTimeout(timer);
  if (stageTimer) clearInterval(stageTimer);
  timer = null;
  stageTimer = null;
}
