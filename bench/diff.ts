/**
 * The developmental loop's feedback: one bench result against a prior one, case by case.
 *
 * Pure. A case IMPROVED when its score rose (a planningReliability case went from
 * failing to passing), REGRESSED when it fell, and is UNCHANGED otherwise; a case only
 * one side has is NEW or REMOVED. A NEW CRITICAL failure is a critical failure class
 * (`CaseResult.critical` / `failures`) the case did not already carry in the baseline —
 * a case can stay failed and still get worse in the way that matters most.
 *
 * The run is REJECTED on any regression, any new critical failure, or any removed case
 * (a case that vanished cannot be shown not to have regressed). This is level A —
 * developmental — feedback: the same runner and cases as the evaluator, on this
 * machine, never a substitute for the evaluator's hidden cases or for production.
 */
import type { BenchResult, CaseResult } from './types.ts';

export const LEVEL_A = 'Level A (developmental) feedback: a local bench diff, not production verification and not the evaluator\'s verdict.';

export type CaseChange = 'IMPROVED' | 'REGRESSED' | 'UNCHANGED' | 'NEW' | 'REMOVED';

export interface CaseDiff {
  id: string;
  change: CaseChange;
  before: CaseResult | null;
  after: CaseResult | null;
  /** Critical failure classes the case carries now and did not before. */
  newCritical: string[];
}

export interface BenchDiff {
  suite: string;
  baselineSha: string;
  sha: string;
  cases: CaseDiff[];
  metrics: Array<{ name: string; before: number | null; after: number | null }>;
  verdict: 'PASS' | 'REJECT';
  reasons: string[];
}

/** The critical classes a case carries: the explicit list when the runner gave one, else "critical" itself. */
function criticalClasses(c: CaseResult | null, critical: ReadonlySet<string> | null): string[] {
  if (!c || c.pass) return [];
  if (c.failures && critical) return c.failures.filter((f) => critical.has(f));
  return c.critical ? (c.failures?.length ? c.failures : ['CRITICAL']) : [];
}

/**
 * Compare `after` with `before`. `critical` names the suite's critical failure classes
 * when the caller knows them (planningReliability's `CRITICAL`); without it a case's own
 * `critical` flag decides.
 */
export function diffResults(before: BenchResult, after: BenchResult, critical: ReadonlySet<string> | null = null): BenchDiff {
  const byId = new Map(before.cases.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const cases: CaseDiff[] = [];
  for (const a of after.cases) {
    seen.add(a.id);
    const b = byId.get(a.id) ?? null;
    const was = new Set(criticalClasses(b, critical));
    const newCritical = criticalClasses(a, critical).filter((f) => !was.has(f));
    const change: CaseChange = !b ? 'NEW' : a.score > b.score ? 'IMPROVED' : a.score < b.score ? 'REGRESSED' : 'UNCHANGED';
    cases.push({ id: a.id, change, before: b, after: a, newCritical });
  }
  for (const b of before.cases) if (!seen.has(b.id)) cases.push({ id: b.id, change: 'REMOVED', before: b, after: null, newCritical: [] });

  const names = [...new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)])].sort();
  const metrics = names.map((name) => ({ name, before: before.metrics[name] ?? null, after: after.metrics[name] ?? null }));

  const reasons: string[] = [];
  if (before.suite !== after.suite) reasons.push(`the baseline is suite ${before.suite}, this run is ${after.suite}`);
  const regressed = cases.filter((c) => c.change === 'REGRESSED');
  if (regressed.length) reasons.push(`${regressed.length} case(s) regressed: ${regressed.map((c) => c.id).join(', ')}`);
  const critical_ = cases.filter((c) => c.newCritical.length);
  if (critical_.length) reasons.push(`${critical_.length} new critical failure(s): ${critical_.map((c) => `${c.id} [${c.newCritical.join(', ')}]`).join(', ')}`);
  const usableRegressed = cases.filter((c) => c.before?.usable?.pass && c.after?.usable && !c.after.usable.pass);
  if (usableRegressed.length) reasons.push(`${usableRegressed.length} case(s) lost an owner-usable plan: ${usableRegressed.map((c) => c.id).join(', ')}`);
  const removed = cases.filter((c) => c.change === 'REMOVED');
  if (removed.length) reasons.push(`${removed.length} baseline case(s) did not run: ${removed.map((c) => c.id).join(', ')}`);
  return { suite: after.suite, baselineSha: before.sha, sha: after.sha, cases, metrics, verdict: reasons.length ? 'REJECT' : 'PASS', reasons };
}

/**
 * Shard results of one run, as one result: their cases in shard order, and the counting
 * metrics recomputed over all of them (a shard's ratio cannot be averaged into a run's).
 * Refuses shards of different suites or commits, and a case id two shards both ran.
 */
export function mergeResults(shards: BenchResult[]): BenchResult {
  if (shards.length === 0) throw new Error('no shard results to merge');
  const first = shards[0]!;
  for (const s of shards) {
    if (s.suite !== first.suite) throw new Error(`shards of different suites: ${first.suite}, ${s.suite}`);
    if (s.sha !== first.sha) throw new Error(`shards of different commits: ${first.sha.slice(0, 12)}, ${s.sha.slice(0, 12)}`);
  }
  const cases = shards.flatMap((s) => s.cases);
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`case ${c.id} ran in two shards`);
    ids.add(c.id);
  }
  const passed = cases.filter((c) => c.pass).length;
  const metrics: Record<string, number> = {
    accuracy: cases.length ? passed / cases.length : 0,
    passed,
    cases: cases.length,
    criticalFailures: cases.filter((c) => c.critical).length,
    errors: cases.filter((c) => c.verdict === 'ERROR').length,
  };
  const ranAt = shards.map((s) => s.ranAt).sort().at(-1) ?? first.ranAt;
  return { suite: first.suite, sha: first.sha, ref: first.ref, cases, metrics, ranAt };
}

const ORDER: CaseChange[] =['REGRESSED', 'IMPROVED', 'NEW', 'REMOVED', 'UNCHANGED'];

/** One line for a case: its change, id, verdict before → after, and (public cases only) the grader's reason. */
function caseLine(c: CaseDiff): string {
  const v = (r: CaseResult | null) => (r ? (r.verdict ?? (r.pass ? 'PASS' : 'FAIL')) : '—');
  const verdict = c.change === 'UNCHANGED' ? v(c.after) : `${v(c.before)} → ${v(c.after)}`;
  const reason = c.after?.reason ?? c.before?.reason;
  const crit = c.newCritical.length ? ` NEW CRITICAL [${c.newCritical.join(', ')}]` : '';
  return `  ${c.change.padEnd(9)} ${c.id}  ${verdict}${crit}${reason && c.change !== 'UNCHANGED' ? ` — ${reason}` : ''}`;
}

/** The human block: changed cases first with reasons, unchanged ones by id and verdict, then the primary metrics. */
export function formatDiff(d: BenchDiff, options: { showUnchanged?: boolean } = {}): string[] {
  const lines: string[] = [];
  const count = (k: CaseChange) => d.cases.filter((c) => c.change === k).length;
  lines.push(`${d.suite} vs baseline ${d.baselineSha.slice(0, 12)}: ${ORDER.map((k) => `${k} ${count(k)}`).join(' · ')}`);
  for (const k of ORDER) {
    if (k === 'UNCHANGED' && options.showUnchanged === false) continue;
    for (const c of d.cases.filter((x) => x.change === k)) lines.push(caseLine(c));
  }
  lines.push(...usableLines(d));
  for (const m of d.metrics) {
    if (!['accuracy', 'passed', 'cases', 'criticalFailures', 'errors', 'accuracy.familiar', 'accuracy.heldOut'].includes(m.name)) continue;
    if (m.before === m.after) continue;
    const f = (x: number | null) => (x === null ? '—' : Number.isInteger(x) ? String(x) : x.toFixed(3));
    lines.push(`  metric ${m.name}: ${f(m.before)} → ${f(m.after)}`);
  }
  return lines;
}

/**
 * The owner-usable level's own before → after, on the cases both runs graded at that level:
 * which recovered, which regressed, the counts and the net percentage-point change. Silent
 * when neither run carries the level (a suite without it, or a baseline from before it).
 */
export function usableLines(d: BenchDiff): string[] {
  const both = d.cases.filter((c) => c.before?.usable && c.after?.usable);
  if (both.length === 0) return [];
  const before = both.filter((c) => c.before!.usable!.pass).length;
  const after = both.filter((c) => c.after!.usable!.pass).length;
  const recovered = both.filter((c) => !c.before!.usable!.pass && c.after!.usable!.pass).map((c) => c.id);
  const regressed = both.filter((c) => c.before!.usable!.pass && !c.after!.usable!.pass).map((c) => c.id);
  const pp = (100 * (after - before)) / both.length;
  return [
    `  owner-usable: ${before}/${both.length} → ${after}/${both.length} (${pp >= 0 ? '+' : ''}${pp.toFixed(1)} pp) · recovered ${recovered.length} · regressed ${regressed.length}`,
    ...(recovered.length ? [`    recovered: ${recovered.join(', ')}`] : []),
    ...(regressed.length ? [`    REGRESSED: ${regressed.join(', ')}`] : []),
  ];
}
