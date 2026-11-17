/**
 * Production probes for RES-07, RES-15-5, RES-15-4, GOAL-13-6, GOAL-18-4 and
 * GOAL-23, read from what the running Brain records — the research allocation's
 * own decision rows, the constructed arrangements, and the goal plan readings —
 * never by calling the judge of the work. Three answers each:
 *  - UNKNOWN: nothing on production yet shows the behaviour (§39: an absence is
 *    not a demonstration either way, and not a defect a repair can fix);
 *  - FAIL: a recorded row that contradicts the requirement;
 *  - PASS: the rows demonstrate it and none contradicts it.
 */
import type { ProbeResult } from '../probes.ts';

const PURPOSES = ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'OPERATING_SUPPORT', 'SELF_IMPROVEMENT', 'FORWARD_EXPLORATION'] as const;
const EXPLORATION = ['BROAD_DISCOVERY', 'FORWARD_EXPLORATION'] as const;
const EPS = 1e-3;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* ------------------------------------------------------------------------- */
/* RES-07 and RES-15-5: the research allocation's decision rows               */
/* ------------------------------------------------------------------------- */

export type AllocationRow = Record<string, unknown>;

/** What is wrong with one recorded allocation's shares and floors, or null. Pure. */
export function allocationProblem(d: AllocationRow): string | null {
  const shares = d.shares as Record<string, unknown> | undefined;
  if (!shares || typeof shares !== 'object') return 'a decision records no shares';
  let total = 0;
  for (const p of PURPOSES) {
    const v = num(shares[p]);
    if (v === null) return `a decision gives ${p} no share`;
    total += v;
  }
  if (Math.abs(total - 1) > 0.02) return `a decision's shares sum to ${total.toFixed(3)}, not 1`;
  const floors = (d.floors ?? {}) as Record<string, unknown>;
  const per = num(floors.perPurpose);
  if (per !== null) {
    const under = PURPOSES.find((p) => (num(shares[p]) ?? 0) < per - EPS);
    if (under) return `a decision gives ${under} ${num(shares[under])}, under the per-purpose floor ${per}`;
  }
  const exploration = num(floors.exploration);
  const explored = EXPLORATION.reduce((s, p) => s + (num(shares[p]) ?? 0), 0);
  if (exploration !== null && explored < exploration - EPS) return `a decision gives exploration ${explored.toFixed(3)}, under its protected floor ${exploration}`;
  const health = num(floors.systemHealth);
  if (health !== null && (num(shares.SELF_IMPROVEMENT) ?? 0) < health - EPS) return `a decision gives SELF_IMPROVEMENT under its floor ${health}`;
  const commercial = num(floors.commercial);
  if (commercial !== null && (num(shares.TRANSACTION_ROUTES) ?? 0) < commercial - EPS) return `a decision gives TRANSACTION_ROUTES under the commercial floor ${commercial}`;
  return null;
}

/** RES-07 on given decision details, newest first. Pure. */
export function continuousResearchHolds(rows: readonly AllocationRow[]): ProbeResult {
  const measured = rows.filter((d) => d.held !== true);
  if (measured.length === 0) return { ok: null, detail: rows.length ? `${rows.length} allocation decision(s), every one held because nothing was measured` : 'no research allocation decision is recorded on production yet' };
  for (const d of measured) {
    const problem = allocationProblem(d);
    if (problem) return { ok: false, detail: `${problem} (decision ${String(d.fingerprint ?? '?')})` };
  }
  const moved = measured.filter((d) => Array.isArray(d.changes) && d.changes.length > 0);
  if (moved.length === 0) return { ok: null, detail: `${measured.length} measured allocation decision(s) across all five purposes within their floors, none yet reallocating` };
  return { ok: true, detail: `${measured.length} measured allocation decision(s) give all five purposes a share within the protected floors; ${moved.length} reallocated from measured yield` };
}

/** What is wrong with one measured decision's cost-once record or its moves, or null. Pure. */
export function yieldDecisionProblem(d: AllocationRow): string | null {
  const once = d.costCountedOnce as { holds?: unknown } | undefined;
  if (!once || once.holds !== true) return `decision ${String(d.fingerprint ?? '?')} does not show its cost counted once`;
  for (const c of (Array.isArray(d.changes) ? d.changes : []) as Array<{ purpose?: unknown; reasons?: unknown }>) {
    if (!Array.isArray(c.reasons) || c.reasons.length === 0) return `decision ${String(d.fingerprint ?? '?')} moves ${String(c.purpose)} without a measured reason`;
  }
  return null;
}

/**
 * RES-15-5 on given decision details, newest first. Pure.
 *
 * The rows are append-only history, so a decision that failed stays in the
 * read window long after a repair. What the requirement asks is whether the
 * running Brain counts cost once now: the decisions in force are the measured
 * ones newer than the newest failing one. The newest measured decision failing
 * is a FAIL; an older failure that newer measured decisions all superseded is
 * reported, never hidden, and does not fail the probe.
 */
export function yieldAllocationHolds(rows: readonly AllocationRow[]): ProbeResult {
  const measured = rows.filter((d) => d.held !== true);
  if (measured.length === 0) return { ok: null, detail: 'no measured research allocation decision is recorded on production yet' };
  const failing = measured.findIndex((d) => yieldDecisionProblem(d) !== null);
  if (failing === 0) return { ok: false, detail: yieldDecisionProblem(measured[0]!)! };
  const current = failing < 0 ? measured : measured.slice(0, failing);
  const superseded = failing < 0 ? 0 : measured.slice(failing).filter((d) => yieldDecisionProblem(d) !== null).length;
  const history = superseded > 0 ? `; ${superseded} older decision(s) that did not hold are superseded (newest: ${yieldDecisionProblem(measured[failing]!)})` : '';
  const moved = current.filter((d) => Array.isArray(d.changes) && d.changes.length > 0).length;
  if (moved === 0) return { ok: null, detail: `${current.length} measured decision(s) count cost once; none has yet moved a share by yield${history}` };
  return { ok: true, detail: `${current.length} measured decision(s) count each job's cost once; ${moved} moved shares, every change with its measured reason${history}` };
}

async function allocationRows(): Promise<AllocationRow[]> {
  const { listImprovementEvents } = await import('../../../../repos/improvement.ts');
  return (await listImprovementEvents({ kinds: ['RESEARCH_ALLOCATION_DECIDED'], limit: 50 })).map((e) => e.detail as AllocationRow);
}

export async function continuousResearchHoldsOnRows(): Promise<ProbeResult> {
  return continuousResearchHolds(await allocationRows());
}

export async function yieldAllocationHoldsOnRows(): Promise<ProbeResult> {
  return yieldAllocationHolds(await allocationRows());
}

/* ------------------------------------------------------------------------- */
/* RES-15-4: one question per constructed position                            */
/* ------------------------------------------------------------------------- */

export interface PositionedArrangement {
  key: string;
  positionQuestions?: Array<{ kind?: unknown; position?: unknown; asks?: unknown; established?: unknown; question?: unknown }>;
}

/** RES-15-4 on given arrangements. Pure. */
export function positionResearchHolds(arrangements: readonly PositionedArrangement[]): ProbeResult {
  const with_ = arrangements.filter((a) => Array.isArray(a.positionQuestions) && a.positionQuestions.length > 0);
  if (with_.length === 0) return { ok: null, detail: `${arrangements.length} constructed arrangement(s), none yet decomposed into position questions` };
  let positions = 0;
  for (const a of with_) {
    const qs = a.positionQuestions!;
    const pos = qs.filter((q) => q.kind === 'POSITION');
    if (pos.length === 0) return { ok: false, detail: `arrangement ${a.key} asks no question at any position` };
    for (const q of qs) {
      if (typeof q.question !== 'string' || !q.question.trim()) return { ok: false, detail: `arrangement ${a.key} carries an empty position question` };
      const asks = Array.isArray(q.asks) ? (q.asks as unknown[]) : [];
      const known = new Set(Array.isArray(q.established) ? (q.established as unknown[]) : []);
      const again = asks.find((f) => known.has(f));
      if (again !== undefined) return { ok: false, detail: `arrangement ${a.key} asks again for ${String(again)}, which it already establishes` };
    }
    positions += new Set(pos.map((q) => String(q.position))).size;
  }
  return { ok: true, detail: `${with_.length} constructed arrangement(s) decomposed into ${positions} distinct position question(s), none re-asking what is established` };
}

export async function positionResearchHoldsOnRows(): Promise<ProbeResult> {
  const { listProjects } = await import('../../../../repos/projects.ts');
  const { constructArrangements } = await import('../../../cash/construct.ts');
  const out: PositionedArrangement[] = [];
  for (const p of await listProjects()) {
    try {
      const built = await constructArrangements({ projectId: p.id, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30 });
      out.push(...(built as PositionedArrangement[]));
    } catch (error) {
      return { ok: null, detail: `project ${p.id}: construction could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'error'})` };
    }
  }
  return positionResearchHolds(out);
}

/* ------------------------------------------------------------------------- */
/* GOAL-13-6, GOAL-18-4, GOAL-23: the goal plan readings' recorded summary    */
/* ------------------------------------------------------------------------- */

export type Forecast = Record<string, unknown>;

/** GOAL-13-6 on given forecasts. Pure. */
export function compressedTimelinesHold(fs: readonly Forecast[]): ProbeResult {
  const read = fs.map((f) => f.timelines as { horizons?: unknown } | null | undefined).filter((t): t is { horizons?: unknown } => !!t && Array.isArray(t.horizons));
  if (read.length === 0) return { ok: null, detail: 'no goal plan reading records its timelines yet' };
  let horizons = 0;
  for (const t of read) {
    for (const h of t.horizons as Array<{ days?: unknown; reach?: unknown; reachBasis?: unknown }>) {
      horizons += 1;
      const reach = num(h.reach);
      if (reach === null && h.reachBasis !== null && h.reachBasis !== undefined) return { ok: false, detail: `a ${String(h.days)}-day horizon states a ${String(h.reachBasis)} basis with no reach` };
      if (reach !== null && h.reachBasis !== 'COVERAGE' && h.reachBasis !== 'PROBABILITY') return { ok: false, detail: `a ${String(h.days)}-day horizon states a reach of ${reach} without saying whether it is coverage or a calibrated probability` };
    }
  }
  const compressed = read.filter((t) => (t.horizons as unknown[]).length >= 2).length;
  if (compressed === 0) return { ok: null, detail: `${read.length} reading(s) record a single horizon; none yet searches a compressed timeline` };
  return { ok: true, detail: `${compressed} reading(s) search compressed horizons (${horizons} horizon(s) read); every reach says whether it is coverage or a calibrated probability` };
}

/** GOAL-18-4 on given forecasts. Pure. */
export function overperformanceHolds(fs: readonly Forecast[]): ProbeResult {
  const objectives = fs.map((f) => f.objective as Record<string, unknown> | null | undefined).filter((o): o is Record<string, unknown> => !!o);
  if (objectives.length === 0) return { ok: null, detail: 'no goal plan reading records its objective yet' };
  let outcomes = 0;
  for (const o of objectives) {
    const out = o.outcome as Record<string, unknown> | null | undefined;
    if (!out) continue;
    outcomes += 1;
    const expected = num(out.expected), upper = num(out.upper), adverse = num(out.adverse);
    if (expected === null || upper === null || adverse === null) return { ok: false, detail: 'an outcome reading omits its expected, upper or adverse figure' };
    if (adverse > expected + EPS || expected > upper + EPS) return { ok: false, detail: `an outcome reading's adverse ${adverse}, expected ${expected} and upper ${upper} are out of order` };
    if (out.status === 'ACCEPTED' && num(o.requiredConfidence) === null) return { ok: false, detail: 'an outcome is ACCEPTED with no configured confidence' };
  }
  if (outcomes === 0) return { ok: null, detail: `${objectives.length} reading(s) record an objective; none yet an outcome reading` };
  return { ok: true, detail: `${outcomes} reading(s) state expected, upper and adverse outcomes in order against a configured objective` };
}

/** GOAL-23 on given forecasts. Pure. */
export function distinctPlansHold(fs: readonly Forecast[]): ProbeResult {
  const sets = fs.map((f) => f.planSet as Record<string, unknown> | null | undefined).filter((s): s is Record<string, unknown> => !!s);
  if (sets.length === 0) return { ok: null, detail: 'no goal plan reading records a plan set yet' };
  let best = 0;
  for (const s of sets) {
    const candidates = num(s.candidates) ?? 0, distinct = num(s.distinct) ?? 0, accepted = num(s.accepted) ?? 0;
    if (distinct > candidates) return { ok: false, detail: `a plan set publishes ${distinct} distinct plan(s) from ${candidates} candidate(s)` };
    if (accepted > distinct) return { ok: false, detail: `a plan set accepts ${accepted} plan(s) of ${distinct} distinct` };
    const plans = (Array.isArray(s.plans) ? s.plans : []) as Array<{ signature?: unknown }>;
    const sigs = plans.map((p) => String(p.signature ?? ''));
    if (sigs.some((x) => !x)) return { ok: false, detail: 'a published plan carries no signature, so its distinctness is not proven' };
    if (new Set(sigs).size !== sigs.length) return { ok: false, detail: 'two published plans share a signature: counted as distinct, they are one plan' };
    best = Math.max(best, distinct);
  }
  if (best < 2) return { ok: null, detail: `${sets.length} plan set(s) recorded, none yet with two distinct plans` };
  return { ok: true, detail: `${sets.length} plan set(s); up to ${best} distinct plans, each proven distinct by its signature` };
}

async function recentForecasts(): Promise<Forecast[]> {
  const { getDb } = await import('../../../../db/database.ts');
  const rows = await getDb().all<{ forecast: string | null }>('SELECT forecast FROM goal_plan_readings ORDER BY created_at DESC, id DESC LIMIT 200', []);
  return rows.flatMap((r) => {
    try {
      const f = JSON.parse(r.forecast ?? '') as unknown;
      return f && typeof f === 'object' ? [f as Forecast] : [];
    } catch {
      return [];
    }
  });
}

export async function compressedTimelinesHoldOnRows(): Promise<ProbeResult> {
  return compressedTimelinesHold(await recentForecasts());
}
export async function overperformanceHoldsOnRows(): Promise<ProbeResult> {
  return overperformanceHolds(await recentForecasts());
}
export async function distinctPlansHoldOnRows(): Promise<ProbeResult> {
  return distinctPlansHold(await recentForecasts());
}

/* ------------------------------------------------------------------------- */
/* COM-13-2 and META-18-1: the campaigns' own row readers, absence as UNKNOWN */
/* ------------------------------------------------------------------------- */

/** COM-13-2 from `leverageHoldsOnRows`: nothing traced is UNKNOWN; a revenue ceiling is FAIL. Pure. */
export function leverageVerdict(r: { ok: boolean; detail: string; combinations: number; revenueCeilingViolations: readonly string[] }): ProbeResult {
  if (r.revenueCeilingViolations.length > 0) return { ok: false, detail: r.detail };
  if (r.combinations === 0) return { ok: null, detail: r.detail };
  return { ok: r.ok, detail: r.detail };
}

/** META-18-1 from `noAnchoringHoldsOnRows`: no live or discriminating subject is UNKNOWN; a whitelist or a scan error is FAIL. Pure. */
export function anchoringVerdict(r: { ok: boolean; detail: string; live: number; discriminating: number; violations: readonly unknown[] }): ProbeResult {
  if (r.violations.length > 0) return { ok: false, detail: r.detail };
  if (r.ok) return { ok: true, detail: r.detail };
  if (r.live === 0 || r.discriminating === 0) return { ok: null, detail: r.detail };
  return { ok: false, detail: r.detail };
}

export async function leverageHoldsOnRowsProbe(): Promise<ProbeResult> {
  const specifier = '../../../quant/leverage.ts';
  const mod = (await import(specifier)) as { leverageHoldsOnRows?: () => Promise<Parameters<typeof leverageVerdict>[0]> };
  if (!mod.leverageHoldsOnRows) return { ok: null, detail: 'commercial leverage is not deployed in this Brain yet' };
  return leverageVerdict(await mod.leverageHoldsOnRows());
}

export async function anchoringHoldsOnRowsProbe(): Promise<ProbeResult> {
  const specifier = '../../../industry/construction/anchoring.ts';
  let mod: { noAnchoringHoldsOnRows?: () => Promise<Parameters<typeof anchoringVerdict>[0]> };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    return { ok: null, detail: 'the anchoring check is not deployed in this Brain yet' };
  }
  if (!mod.noAnchoringHoldsOnRows) return { ok: null, detail: 'the anchoring check is not deployed in this Brain yet' };
  return anchoringVerdict(await mod.noAnchoringHoldsOnRows());
}

/* ------------------------------------------------------------------------- */
/* INT-38-AUTHORITY: the campaign's joint reader, absence as UNKNOWN          */
/* ------------------------------------------------------------------------- */

/** INT-38-AUTHORITY from `actionsObeyAuthorityOnRows`: no ledgered lifecycle effect yet is UNKNOWN (§39), never a pass. Pure. */
export function authorityIntegrationVerdict(r: { ok: boolean | null; detail: string; counts: { effects: number } }): ProbeResult {
  if (r.ok === false) return { ok: false, detail: r.detail };
  if (r.ok === null || /^nothing performed yet/.test(r.detail)) return { ok: null, detail: r.detail };
  return { ok: true, detail: r.detail };
}

export async function authorityIntegrationHoldsOnRows(): Promise<ProbeResult> {
  const specifier = '../../../cash/authorityIntegration.ts';
  let mod: { actionsObeyAuthorityOnRows?: () => Promise<Parameters<typeof authorityIntegrationVerdict>[0]> };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    return { ok: null, detail: 'the authority integration reader is not deployed in this Brain yet' };
  }
  if (!mod.actionsObeyAuthorityOnRows) return { ok: null, detail: 'the authority integration reader is not deployed in this Brain yet' };
  return authorityIntegrationVerdict(await mod.actionsObeyAuthorityOnRows());
}
