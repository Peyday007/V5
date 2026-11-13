/**
 * Approved browser capabilities, run by the Brain process (ACQ-21-5).
 *
 * "The model may discover how to interact with a new interface once; software
 * may then run that approved workflow thousands of times." `operateCapability`
 * is the one path a capability runs through; this module is what calls it on
 * the running Brain, from the integration registry's own clock
 * (`integrations/loop.ts`, started by `server/index.ts`) — no scheduler, queue
 * or store is added (§10.3, §20.4).
 *
 * What the clock runs, and what it never runs:
 *
 *  - only a capability whose current version a person APPROVED (or which is
 *    ACTIVE since that approval), with no handoff (REVIEW, REAUTHORIZE) open;
 *  - only an idempotent READ that declares no inputs: there is nothing to
 *    choose, so running it again is a freshness refresh of what was approved.
 *    `planCapabilityRun` defers it while its last result is fresh and backs off
 *    after a failure within the declared retry bound;
 *  - never a MUTATION. An already-approved action is performed only when a
 *    person asks for it at the terminal (`capabilityCli.ts run`), naming the
 *    steps they approve, and the effect claim makes it happen once.
 *
 * The request budget (the host's limit and the capability's declared rate) is
 * decided inside `operateCapability` over the same run rows every run writes,
 * so many workers and this clock together cannot exceed it.
 *
 * Nothing here names a host, category or industry: the hosts are whatever
 * BROWSER_CAPABILITY rows exist.
 */
import { getDb } from '../../../db/database.ts';
import { hostMeasuresPattern } from '../acquisition.ts';
import { browserMcpUrl } from '../browserMcp.ts';
import { BROWSER_WORKFLOW_RUN_EVENT } from '../browserWorkflow.ts';
import { BROWSER_CAPABILITY_EVENT, readBrowserCapabilities, type CapabilityRecord, type PriorRun } from './capability.ts';
import { operateCapability, type OperateCapabilityDeps, type OperateCapabilityResult } from './operate.ts';

/** At most this many capability runs a tick; the rest wait for the next one. */
export const MAX_RUNS_PER_TICK = 3;
/**
 * The project a Brain-wide READ is attributed to. A read takes no effect claim
 * (`guardBrowserRun` claims only a mutation), so this is a label on the run,
 * never an idempotency scope, and the clock never runs a mutation.
 */
export const BRAIN_CAPABILITY_PROJECT = 'brain';
export const SCHEDULER_ACTOR = { type: 'SYSTEM' as const, id: 'integrations-tick' };

interface Row {
  measures: string | null;
  outcome?: string | null;
  at?: string | null;
}

const parse = (raw: string | null | undefined): Record<string, unknown> | null => {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Every host a capability was ever defined for, from BROWSER_CAPABILITY rows. Pure. */
export function hostsFrom(rows: readonly Row[]): string[] {
  const hosts = new Set<string>();
  for (const r of rows) {
    const host = parse(r.measures)?.['host'];
    if (typeof host === 'string' && host.trim()) hosts.add(host.trim().toLowerCase());
  }
  return [...hosts].sort();
}

/**
 * A capability's earlier runs by effect key, from the run rows `operateCapability`
 * writes (`measures.effectKey`, `measures.outcome`). Only a verified run reads
 * COMPLETED. Pure.
 */
export function priorReadsFrom(rows: readonly Row[], name: string): PriorRun[] {
  const want = name.trim().toLowerCase();
  const out: PriorRun[] = [];
  for (const r of rows) {
    const m = parse(r.measures);
    if (!m || typeof m['name'] !== 'string' || m['name'].trim().toLowerCase() !== want) continue;
    const key = m['effectKey'];
    const outcome = m['outcome'];
    if (typeof key !== 'string' || typeof outcome !== 'string' || !r.at) continue;
    out.push({ key, outcome, at: r.at });
  }
  return out;
}

/** Why the clock does or does not run this capability now. Pure. */
export function scheduledEligibility(record: CapabilityRecord): { run: boolean; why: string } {
  const c = record.current.capability;
  if (record.status !== 'APPROVED' && record.status !== 'ACTIVE') return { run: false, why: `status ${record.status}` };
  if (record.handoff) return { run: false, why: `handoff ${record.handoff} is open` };
  if (c.effect !== 'READ') return { run: false, why: 'a mutation runs only when a person asks for it' };
  if (c.inputs.length > 0) return { run: false, why: 'it declares inputs a caller chooses' };
  if (record.fresh) return { run: false, why: 'its last result is still fresh' };
  return { run: true, why: 'approved read, due' };
}

export interface ScheduleDeps {
  hosts?: () => Promise<string[]>;
  capabilities?: (host: string) => Promise<Map<string, CapabilityRecord>>;
  runRows?: (host: string) => Promise<Row[]>;
  operate?: typeof operateCapability;
  operateDeps?: OperateCapabilityDeps;
  /** Whether a browser is configured; defaults to `BRAIN_BROWSER_MCP_URL`. */
  browserConfigured?: () => boolean;
  maxRuns?: number;
}

async function readHosts(): Promise<string[]> {
  try {
    const rows = await getDb().all<Row>(
      `SELECT measures FROM bin_events WHERE event_type = ? AND outcome = ? ORDER BY at DESC LIMIT 2000`,
      [BROWSER_CAPABILITY_EVENT, 'DEFINED'],
    );
    return hostsFrom(rows);
  } catch {
    return [];
  }
}

async function readRunRows(host: string): Promise<Row[]> {
  try {
    return await getDb().all<Row>(
      `SELECT measures, outcome, at FROM bin_events WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 500`,
      [BROWSER_WORKFLOW_RUN_EVENT, hostMeasuresPattern(host)],
    );
  } catch {
    return [];
  }
}

export interface ScheduledRun {
  host: string;
  name: string;
  version: number;
  outcome: OperateCapabilityResult['outcome'];
  failureReason: string | null;
}

/**
 * One pass: every approved, due, input-free READ capability, run once through
 * `operateCapability`, at most `MAX_RUNS_PER_TICK`. Nothing runs when no
 * browser is configured.
 */
export async function runDueBrowserCapabilities(deps: ScheduleDeps = {}): Promise<ScheduledRun[]> {
  if (!(deps.browserConfigured ?? (() => browserMcpUrl() !== null))()) return [];
  const limit = deps.maxRuns ?? MAX_RUNS_PER_TICK;
  const done: ScheduledRun[] = [];
  for (const host of await (deps.hosts ?? readHosts)()) {
    if (done.length >= limit) break;
    const records = await (deps.capabilities ?? ((h: string) => readBrowserCapabilities(h)))(host);
    const due = [...records.values()].filter((r) => scheduledEligibility(r).run);
    if (due.length === 0) continue;
    const rows = await (deps.runRows ?? readRunRows)(host);
    for (const record of due) {
      if (done.length >= limit) break;
      const result = await (deps.operate ?? operateCapability)(
        {
          projectId: BRAIN_CAPABILITY_PROJECT,
          host: record.host,
          name: record.name,
          inputs: {},
          priorReads: priorReadsFrom(rows, record.name),
          actor: SCHEDULER_ACTOR,
        },
        deps.operateDeps ?? {},
      );
      done.push({ host: record.host, name: record.name, version: record.current.version, outcome: result.outcome, failureReason: result.failureReason });
    }
  }
  return done;
}
