/**
 * Production probes for ACQ-21-1 and ACQ-21-2, read from the rows the
 * acquisition judgment writes (`sources/acquisition.ts recordAcquisitionJudgment`):
 * `bin_events` of type `ACQUISITION_JUDGMENT`, `provider` = the route chosen,
 * `outcome` = ROUTE_SELECTED | SEARCH_FIRST | REFUSED, `reason` = why, and
 * `measures.capability` = OPERATE | ACQUIRE.
 *
 * Nothing here imports the code under test; a probe that called the judgment
 * would be the judgment marking its own work.
 *
 *  - UNKNOWN (`ok: null`): the rows do not yet show the behaviour (no judgment
 *    in the window, or only one of the two capabilities exercised).
 *  - FAIL: a row contradicts the requirement — a selected route that is not one
 *    of the method classes, a judgment with no reason, a capability that is
 *    neither operating a system nor acquiring information.
 *  - PASS: the rows demonstrate it and none contradicts it.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';

const WINDOW_MS = 30 * 86_400_000;
const METHODS = new Set(['NATIVE', 'BULK', 'HTTP', 'BROWSER', 'MODEL_ASSISTED', 'HUMAN_HANDOFF']);
const CAPABILITIES = new Set(['OPERATE', 'ACQUIRE']);
const OUTCOMES = new Set(['ROUTE_SELECTED', 'SEARCH_FIRST', 'REFUSED']);
/** Routes that are not "a site with an API key or a document a person uploaded". */
const BEYOND_API = new Set(['BULK', 'HTTP', 'BROWSER', 'MODEL_ASSISTED']);

export interface JudgmentRow {
  provider: string | null;
  outcome: string | null;
  reason: string | null;
  measures: string | null;
  at: string;
}

function parse(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function judgments(now: Date): Promise<JudgmentRow[]> {
  return getDb().all<JudgmentRow>(
    `SELECT provider, outcome, reason, measures, at FROM bin_events
      WHERE event_type = 'ACQUISITION_JUDGMENT' AND at >= ? ORDER BY at`,
    [new Date(now.getTime() - WINDOW_MS).toISOString()],
  );
}

/** What is wrong with one judgment row, or null. Pure. */
export function judgmentProblem(row: JudgmentRow): string | null {
  const m = parse(row.measures);
  const capability = typeof m.capability === 'string' ? m.capability : '';
  if (!CAPABILITIES.has(capability)) return `a judgment at ${row.at} names capability "${capability || 'none'}"`;
  if (!OUTCOMES.has(row.outcome ?? '')) return `a judgment at ${row.at} has outcome "${row.outcome ?? 'none'}"`;
  if (!(row.reason ?? '').trim()) return `a ${capability} judgment at ${row.at} records no reason`;
  if (row.outcome === 'ROUTE_SELECTED' && !METHODS.has(row.provider ?? '')) {
    return `a ${capability} judgment at ${row.at} selected "${row.provider ?? 'nothing'}", which is not an access method`;
  }
  return null;
}

/** ACQ-21-2 on given rows. Pure. */
export function methodSelectionHolds(rows: readonly JudgmentRow[]): ProbeResult {
  if (rows.length === 0) return { ok: null, detail: 'no acquisition judgment in the last 30 days: method selection is not yet demonstrated' };
  for (const row of rows) {
    const problem = judgmentProblem(row);
    if (problem) return { ok: false, detail: problem };
  }
  const selected = rows.filter((r) => r.outcome === 'ROUTE_SELECTED');
  if (selected.length === 0) return { ok: null, detail: `${rows.length} judgment(s), none has selected a route yet` };
  const byRoute = new Map<string, number>();
  for (const r of selected) byRoute.set(r.provider!, (byRoute.get(r.provider!) ?? 0) + 1);
  return {
    ok: true,
    detail: `${selected.length} route(s) selected with their reasons (${[...byRoute].map(([k, v]) => `${k} ${v}`).join(', ')}); ${rows.length} judgment(s) in 30 days, none malformed`,
  };
}

/** ACQ-21-1 on given rows. Pure. */
export function separateCapabilitiesHold(rows: readonly JudgmentRow[]): ProbeResult {
  if (rows.length === 0) return { ok: null, detail: 'no acquisition judgment in the last 30 days: neither capability is demonstrated yet' };
  for (const row of rows) {
    const problem = judgmentProblem(row);
    if (problem) return { ok: false, detail: problem };
  }
  const of = (capability: string) => rows.filter((r) => parse(r.measures).capability === capability);
  const acquire = of('ACQUIRE');
  const operate = of('OPERATE');
  const beyond = acquire.filter((r) => r.outcome === 'ROUTE_SELECTED' && BEYOND_API.has(r.provider ?? ''));
  const missing: string[] = [];
  if (beyond.length === 0) missing.push('no information acquired by a route beyond an API (bulk, HTTP, browser or model-assisted)');
  if (operate.length === 0) missing.push('no system-operating judgment recorded');
  if (missing.length > 0) return { ok: null, detail: `${acquire.length} ACQUIRE and ${operate.length} OPERATE judgment(s): ${missing.join('; ')}` };
  return {
    ok: true,
    detail: `${acquire.length} ACQUIRE judgment(s) (${beyond.length} by a route beyond an API) and ${operate.length} OPERATE judgment(s), judged as separate capabilities`,
  };
}

export async function methodSelectionOnRows(now: Date = new Date()): Promise<ProbeResult> {
  return methodSelectionHolds(await judgments(now));
}

export async function separateCapabilitiesOnRows(now: Date = new Date()): Promise<ProbeResult> {
  return separateCapabilitiesHold(await judgments(now));
}

/* ------------------------------------------------------------------------- */
/* ACQ-21-5: browser routines as versioned reusable capabilities              */
/* ------------------------------------------------------------------------- */

export interface CapabilityEventRow {
  event_type: string;
  outcome: string | null;
  measures: string | null;
  at: string;
}

/**
 * ACQ-21-5 on given rows (`BROWSER_CAPABILITY` and `BROWSER_WORKFLOW_RUN`). Pure.
 *  - FAIL: a defined version with no version number or content hash; a run of a
 *    version nobody defined, or of one no person approved.
 *  - PASS: a capability defined and approved as an exact version, and a run of
 *    that version that completed and verified what it obtained.
 *  - UNKNOWN: nothing defined, approved or run yet.
 */
export function browserCapabilitiesHold(rows: readonly CapabilityEventRow[]): ProbeResult {
  const defined = new Set<string>();
  const approved = new Set<string>();
  let definitions = 0;
  for (const r of rows.filter((x) => x.event_type === 'BROWSER_CAPABILITY')) {
    const m = parse(r.measures);
    const key = `${String(m.host)}|${String(m.name)}|${String(m.contentHash)}`;
    if (r.outcome === 'DEFINED') {
      if (typeof m.version !== 'number' || !(typeof m.contentHash === 'string' && m.contentHash)) {
        return { ok: false, detail: `a browser capability defined at ${r.at} carries no version or content hash` };
      }
      definitions += 1;
      defined.add(key);
    } else if (r.outcome === 'APPROVED') approved.add(key);
    else if (r.outcome === 'RETIRED') approved.delete(key);
  }
  let completed = 0;
  let runs = 0;
  for (const r of rows.filter((x) => x.event_type === 'BROWSER_WORKFLOW_RUN')) {
    const m = parse(r.measures);
    const cap = m.capability && typeof m.capability === 'object' ? (m.capability as Record<string, unknown>) : null;
    if (!cap) continue; // a workflow run that is not a capability run (sources/browserWorkflow.ts) is not judged here
    runs += 1;
    const key = `${String(m.host)}|${String(m.name)}|${String(cap.contentHash)}`;
    if (!defined.has(key)) return { ok: false, detail: `a browser run at ${r.at} used ${String(m.name)} version ${String(cap.version)}, which was never defined` };
    if (!approved.has(key) && r.outcome === 'COMPLETED') return { ok: false, detail: `a browser run at ${r.at} completed ${String(m.name)} version ${String(cap.version)} without that version being approved` };
    if (r.outcome === 'COMPLETED') completed += 1;
  }
  if (definitions === 0) return { ok: null, detail: 'no browser routine has been defined as a versioned capability yet' };
  if (approved.size === 0 || completed === 0) {
    return { ok: null, detail: `${definitions} capability version(s) defined, ${approved.size} approved, ${runs} run(s), ${completed} completed and verified: not yet demonstrated end to end` };
  }
  return { ok: true, detail: `${definitions} capability version(s) defined, ${approved.size} approved by a person, ${completed} verified run(s) of an approved version out of ${runs}` };
}

export async function browserCapabilitiesOnRows(): Promise<ProbeResult> {
  const rows = await getDb().all<CapabilityEventRow>(
    `SELECT event_type, outcome, measures, at FROM bin_events
      WHERE event_type IN ('BROWSER_CAPABILITY', 'BROWSER_WORKFLOW_RUN') ORDER BY at, id`,
  );
  return browserCapabilitiesHold(rows);
}
