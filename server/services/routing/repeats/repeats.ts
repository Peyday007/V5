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
import { getDb } from '../../../db/database.ts';
import { listDecisions, type RoutingDecision } from '../../../repos/workRouting.ts';

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

/**
 * Where candidates go: the search-intelligence method/detector path. `HELD`
 * means the path could not take it now (nowhere to send it); the next notice
 * offers it again, so nothing is lost and nothing is forced.
 */
export type CandidateSink = (candidate: ConversionCandidate) => Promise<'EMITTED' | 'DUPLICATE' | 'HELD'>;

export interface EmitResult { emitted: number; duplicates: number; held: number; candidates: ConversionCandidate[] }

/** Emits each candidate once through the sink; a missing sink emits nothing. */
export async function emitCandidates(
  candidates: readonly ConversionCandidate[],
  sink: CandidateSink | null,
): Promise<EmitResult> {
  let emitted = 0, duplicates = 0, held = 0;
  if (sink) {
    for (const c of candidates) {
      const status = await sink(c);
      if (status === 'EMITTED') emitted++;
      else if (status === 'DUPLICATE') duplicates++;
      else held++;
    }
  }
  return { emitted, duplicates, held, candidates: [...candidates] };
}

/** One proposal per project and shape, whichever pass raised it. */
export function candidateSubmissionKey(c: Pick<ConversionCandidate, 'projectId' | 'workKind'>): string {
  return `routing-repeat:${c.projectId}:${c.workKind}`;
}

/**
 * The production sink. A detector in the search-intelligence path is code
 * (`server/services/feeds/detectors.ts`: versioned, SHADOW before ACTIVE), so
 * the method/detector path's entrance for a new one is the existing Factory:
 * the candidate becomes a change request there, created as a DRAFT with
 * external spend prohibited, whose acceptance conditions are that path's own
 * SHADOW and measured-precision checks. Nothing is activated here, approval
 * stays a Factory engineering decision, and no second learning record is kept:
 * the change request *is* the record, found again by its submission key.
 * With no single repository onboarded for the project, the candidate is HELD
 * rather than guessed at.
 */
export const factoryDetectorSink: CandidateSink = async (c) => {
  const key = candidateSubmissionKey(c);
  const existing = await getDb().get<{ id: string }>(
    'SELECT id FROM factory_change_requests WHERE project_id = ? AND submission_key = ?',
    [c.projectId, key],
  );
  if (existing) return 'DUPLICATE';
  const { repositoryChoicesFor } = await import('../../russell/software.ts');
  const choices = await repositoryChoicesFor(c.projectId);
  if (choices.length !== 1) return 'HELD';
  const { submitObjective, ContractError } = await import('../../factory/contract.ts');
  try {
    const submitted = await submitObjective({
      projectId: c.projectId,
      objective:
        `Propose a code detector for repeated ${c.workKind} model work: the routing ledger holds ${c.aiRuns} ` +
        `model runs of this shape (${c.strongRuns} on Claude, ${c.cheapRuns} on the free lane). Add it to the ` +
        'search-intelligence detector path (server/services/feeds/detectors.ts) in SHADOW mode; it is not activated by this request.',
      expectedOutcome:
        `A SHADOW detector records what it would have answered for ${c.workKind} beside the model's answers, so its precision is measured before anything relies on it`,
      nonGoals: ['activating the detector', 'a second learning or method store', 'lowering any verification or evidence bar'],
      acceptanceConditions: [
        { statement: `a ${c.workKind} detector exists in SHADOW mode and changes no routing decision while in SHADOW`, verification: 'feed_detections rows with mode SHADOW and an unchanged routing ledger', mandatory: true },
        { statement: 'its precision is measured against real positive and negative examples before any promotion to ACTIVE', verification: 'measured precision recorded from stored examples', mandatory: true },
      ],
      repositoryRemote: choices[0]!.remote,
      submissionKey: key,
    });
    return submitted.created ? 'EMITTED' : 'DUPLICATE';
  } catch (error) {
    if (error instanceof ContractError) return 'HELD';
    throw error;
  }
};

/**
 * The production caller: after a routing seam records a model-run decision,
 * count that project's decisions of the same shape and hand any shape past the
 * threshold to the sink. Reads one project's rows only, and only that shape.
 */
export async function noticeRepeats(
  projectId: string,
  workKind: string,
  sink: CandidateSink | null = factoryDetectorSink,
  threshold: number = REPEAT_THRESHOLD,
): Promise<EmitResult> {
  const decisions = await listDecisions(projectId, { workKind, limit: 1000 });
  return emitCandidates(findRepeatedShapes(projectId, decisions, threshold), sink);
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
