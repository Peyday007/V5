/**
 * Repeated AI work of one shape, counted from the routing ledger.
 *
 * A "shape" is the work kind. When the same shape has been run on a model
 * (CHEAP or STRONG) at least `REPEAT_THRESHOLD` times, it is a candidate to
 * become code. A candidate is only a proposal: it is handed to the
 * search-intelligence method/detector path through a sink, which owns SHADOW,
 * precision checks and Factory approval. Nothing here activates code, stores a
 * second learning record, or reads another project's rows.
 */
import type { RoutingDecision } from '../../../repos/workRouting.ts';

export const REPEAT_THRESHOLD = 5;

export interface ConversionCandidate {
  projectId: string;
  workKind: string;
  /** How many model-run decisions of this shape the ledger holds. */
  aiRuns: number;
  strongRuns: number;
  cheapRuns: number;
  /** Decisions already served by code or by a reused result; they are not repeats. */
  decisionIds: string[];
  /** Always false: activation belongs to the method path's SHADOW/precision checks. */
  activate: false;
  status: 'PROPOSED';
}

/** Counts same-shape AI decisions within one project's decisions. */
export function findRepeatedShapes(
  projectId: string,
  decisions: readonly RoutingDecision[],
  threshold: number = REPEAT_THRESHOLD,
): ConversionCandidate[] {
  const byKind = new Map<string, RoutingDecision[]>();
  for (const d of decisions) {
    if (d.projectId !== projectId) continue; // private rows never cross projects
    if (d.resource === 'CODE' || d.reusedResultId) continue;
    const list = byKind.get(d.workKind) ?? [];
    list.push(d);
    byKind.set(d.workKind, list);
  }
  const out: ConversionCandidate[] = [];
  for (const [workKind, list] of byKind) {
    if (list.length < threshold) continue;
    out.push({
      projectId, workKind, aiRuns: list.length,
      strongRuns: list.filter((d) => d.resource === 'STRONG').length,
      cheapRuns: list.filter((d) => d.resource === 'CHEAP').length,
      decisionIds: list.map((d) => d.id).sort(), activate: false, status: 'PROPOSED',
    });
  }
  return out.sort((a, b) => b.strongRuns - a.strongRuns || b.aiRuns - a.aiRuns || (a.workKind < b.workKind ? -1 : 1));
}

/** Where candidates go: the search-intelligence method/detector path. */
export type CandidateSink = (candidate: ConversionCandidate) => Promise<'EMITTED' | 'DUPLICATE'>;

export interface EmitResult { emitted: number; duplicates: number; candidates: ConversionCandidate[] }

/** Emits each candidate once through the sink; a missing sink emits nothing. */
export async function emitCandidates(
  candidates: readonly ConversionCandidate[],
  sink: CandidateSink | null,
): Promise<EmitResult> {
  let emitted = 0, duplicates = 0;
  if (sink) {
    for (const c of candidates) (await sink(c)) === 'EMITTED' ? emitted++ : duplicates++;
  }
  return { emitted, duplicates, candidates: [...candidates] };
}

export interface WorkloadMeasure {
  jobs: number;
  claudeAssignments: number;
  verificationPassed: number;
  verificationTotal: number;
}

export interface RepeatComparison {
  claudeSaved: number;
  baselinePassRate: number | null;
  codeFirstPassRate: number | null;
  /** True only when fewer Claude assignments were used and the pass rate did not drop. */
  improved: boolean;
  /** Why the comparison cannot be trusted, when it cannot. */
  unknown: string | null;
}

const rate = (m: WorkloadMeasure) => (m.verificationTotal > 0 ? m.verificationPassed / m.verificationTotal : null);

/** Like-for-like only: the same number of jobs, or the figure is UNKNOWN. */
export function compareToBaseline(baseline: WorkloadMeasure, codeFirst: WorkloadMeasure): RepeatComparison {
  const b = rate(baseline), c = rate(codeFirst);
  const unknown = baseline.jobs !== codeFirst.jobs ? 'UNKNOWN: the two workloads differ in size'
    : b === null || c === null ? 'UNKNOWN: no verification results to compare' : null;
  const saved = baseline.claudeAssignments - codeFirst.claudeAssignments;
  return {
    claudeSaved: saved, baselinePassRate: b, codeFirstPassRate: c,
    improved: unknown === null && saved > 0 && c! >= b!, unknown,
  };
}
