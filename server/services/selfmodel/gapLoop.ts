/**
 * The capability-gap loop, one recorded step at a time (AUTO-20-2, §87/§88).
 *
 * A gap is a weakness the improvement loop or a capability map has already
 * named, identified by its key. This module adds no scheduler, no table and no
 * authority path: each step of working a gap is an append-only `bin_events` row
 * (`CAPABILITY_GAP_STEP`, `workload_class` = the gap's key, `provider` = the
 * step), and where a loop has got to is read back from those rows, so a worker
 * that dies, a context that is lost or a deploy that restarts the process
 * loses nothing — the next reader asks the rows what comes next.
 *
 * The steps are a vocabulary, not a pipeline. They may be recorded in any order
 * a case needs, a loop may skip one it can say is not needed, several loops run
 * at once, and a later step may send a loop back (a failed verification reopens
 * acquisition). Two things only are refused, because they are the point:
 *
 *  - constructing before reuse was checked: ACQUIRE is refused until
 *    SEARCH_EXISTING is on the gap's record, and
 *  - claiming a capability works on the strength of tests alone: VERIFY records
 *    its baseline and its real-world comparison or it is refused.
 *
 * Nothing here decides whether a gap is worth closing; VALUE records a judgment
 * somebody made from evidence. A figure that is not known is recorded as unknown.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { ownerExists } from './capabilities.ts';
import { listComponents } from './scan.ts';

export const GAP_LOOP_STEPS = [
  'NOTICE', // a missing capability or resource, inferred from real constraints, failures, idle capacity
  'HYPOTHESIS', // what the missing piece enables, which measure moves, how the decision could fail
  'SEARCH_EXISTING', // what already exists: capabilities, code, data, connectors, Factory ownership
  'VALUE', // expected decision value, cost, latency, opportunity cost of the next step
  'ACQUIRE', // handed to the existing execution owner
  'VERIFY', // compared with a baseline in the real environment
  'INTEGRATE', // registered as a versioned reusable capability, or retired
  'CONTINUE', // the loop resumed other work and scheduled its own reconsideration
] as const;
export type GapLoopStep = (typeof GAP_LOOP_STEPS)[number];

/** What kind of shortfall the gap is. The causes differ and so do the remedies. */
export const GAP_CAUSES = [
  'MISSING_DATASET',
  'REASONING_DEFECT',
  'PERMISSION_GAP',
  'UNAVAILABLE_PROVIDER',
  'MARKET_LIMITATION',
  'METHOD_INADEQUATE',
  'OTHER',
] as const;
export type GapCause = (typeof GAP_CAUSES)[number];

export const GAP_EVENT = 'CAPABILITY_GAP_STEP';

export interface GapStepRecord {
  gapKey: string;
  step: GapLoopStep;
  at: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface GapLoopState {
  gapKey: string;
  steps: GapStepRecord[];
  /** Latest record per step, by step. */
  latest: Partial<Record<GapLoopStep, GapStepRecord>>;
  /** Steps not yet recorded, in vocabulary order: what a resuming worker may do next. */
  outstanding: GapLoopStep[];
  /** The first outstanding step, or null when every step is recorded. */
  next: GapLoopStep | null;
  /** True once the loop has recorded INTEGRATE after its last ACQUIRE. */
  integrated: boolean;
  /**
   * True when the loop's last recorded step is CONTINUE: it decided (kept,
   * retired or abandoned the direction) and resumed other work. A later step
   * reopens it. An integrated loop is concluded too.
   */
  concluded: boolean;
  cause: GapCause | null;
}

export class GapStepRefused extends Error {}

/** A step's mandatory content, checked before anything is written. Pure. */
export function refusalFor(step: GapLoopStep, detail: Record<string, unknown>, state: GapLoopState): string | null {
  const text = (key: string): boolean => typeof detail[key] === 'string' && (detail[key] as string).trim().length > 0;
  switch (step) {
    case 'HYPOTHESIS':
      if (!text('enables') || !text('measure') || !text('failureMode')) return 'a hypothesis names what the piece enables, which measure changes and how the decision could fail';
      if (!GAP_CAUSES.includes(detail['cause'] as GapCause)) return `a hypothesis names its cause: one of ${GAP_CAUSES.join(', ')}`;
      return null;
    case 'SEARCH_EXISTING':
      return Array.isArray(detail['searched']) && (detail['searched'] as unknown[]).length > 0
        ? null
        : 'a search of what exists names where it looked';
    case 'VALUE':
      return text('chosen') && text('alternatives') ? null : 'a value judgment names the option chosen and the alternatives it was compared with';
    case 'ACQUIRE':
      if (!state.latest.SEARCH_EXISTING) return 'reuse comes first: record SEARCH_EXISTING before acquiring or constructing anything';
      return text('owner') ? null : 'acquisition names the existing execution owner that does the work';
    case 'VERIFY':
      return text('baseline') && text('comparison') ? null : 'verification records the baseline and the real-world comparison, not tests alone';
    case 'INTEGRATE':
      return text('capability') && text('provenance') && text('owner') ? null : 'integration names the capability, its provenance and its owning subsystem';
    case 'CONTINUE':
      return text('resumed') ? null : 'continuation names what resumed';
    default:
      return text('observation') ? null : 'a notice names what was observed';
  }
}

interface Row {
  at: string;
  provider: string | null;
  reason: string | null;
  measures: string | null;
}

/** Where a gap's loop stands, read from its rows. Pure over the rows. */
export function gapStateFrom(gapKey: string, rows: readonly Row[]): GapLoopState {
  const steps: GapStepRecord[] = [];
  for (const row of rows) {
    const step = GAP_LOOP_STEPS.find((one) => one === row.provider);
    if (!step) continue;
    let detail: Record<string, unknown> = {};
    try {
      detail = (JSON.parse(row.measures ?? '{}') as { detail?: Record<string, unknown> }).detail ?? {};
    } catch {
      // A record that cannot be read teaches nothing; the step stays recorded.
    }
    steps.push({ gapKey, step, at: row.at, summary: row.reason ?? '', detail });
  }
  const latest: Partial<Record<GapLoopStep, GapStepRecord>> = {};
  for (const record of steps) latest[record.step] = record;
  const outstanding = GAP_LOOP_STEPS.filter((step) => !latest[step]);
  const lastAcquire = latest.ACQUIRE?.at ?? null;
  const cause = latest.HYPOTHESIS?.detail['cause'];
  const integrated = Boolean(latest.INTEGRATE && (lastAcquire === null || latest.INTEGRATE.at >= lastAcquire));
  return {
    gapKey,
    steps,
    latest,
    outstanding,
    next: outstanding[0] ?? null,
    integrated,
    concluded: integrated || steps[steps.length - 1]?.step === 'CONTINUE',
    cause: GAP_CAUSES.includes(cause as GapCause) ? (cause as GapCause) : null,
  };
}

/** Read a gap's loop from the database. Works after any loss of context or restart. */
export async function readGapLoop(gapKey: string): Promise<GapLoopState> {
  const rows = await getDb().all<Row>(
    `SELECT at, provider, reason, measures FROM bin_events
      WHERE event_type = ? AND workload_class = ? ORDER BY at ASC, rowid ASC LIMIT 500`,
    [GAP_EVENT, gapKey],
  );
  return gapStateFrom(gapKey, rows);
}

/** Gaps with a recorded loop that has not concluded, newest activity first: what to resume. */
export async function openGapLoops(limit = 20): Promise<GapLoopState[]> {
  const keys = await getDb().all<{ workload_class: string }>(
    `SELECT workload_class FROM bin_events
      WHERE event_type = ? AND workload_class IS NOT NULL
      GROUP BY workload_class ORDER BY MAX(at) DESC LIMIT ?`,
    [GAP_EVENT, Math.max(1, limit) * 3],
  );
  const states = await Promise.all(keys.map((row) => readGapLoop(row.workload_class)));
  return states.filter((state) => !state.concluded).slice(0, limit);
}

/** Record one step on a gap. Refused, and nothing written, when the step's mandatory content is missing. */
export async function recordGapStep(input: {
  gapKey: string;
  step: GapLoopStep;
  summary: string;
  detail?: Record<string, unknown>;
  projectId?: string | null;
}): Promise<GapLoopState> {
  const detail = input.detail ?? {};
  const before = await readGapLoop(input.gapKey);
  const refusal = refusalFor(input.step, detail, before);
  if (refusal) throw new GapStepRefused(refusal);
  await recordBinEvent({
    eventType: GAP_EVENT,
    projectId: input.projectId ?? null,
    provider: input.step,
    workloadClass: input.gapKey,
    outcome: 'RECORDED',
    reason: input.summary.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { gap: input.gapKey, step: input.step, detail },
  });
  return readGapLoop(input.gapKey);
}

export interface ExistingMatch {
  kind: 'COMPONENT' | 'PATH';
  name: string;
  detail: string;
}

/**
 * What already exists for a need, searched before anything is built: the
 * components the system scan has recorded whose name or key mention a term, and
 * any repository path a caller names. A match is a lead to read, not a verdict
 * that the capability works. Terms and paths are the caller's; nothing here is
 * a list of favoured owners.
 */
export async function searchExisting(input: { terms: readonly string[]; paths?: readonly string[]; root?: string }): Promise<ExistingMatch[]> {
  const terms = input.terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 3);
  const found: ExistingMatch[] = [];
  if (terms.length > 0) {
    for (const component of await listComponents()) {
      const hay = `${component.componentKey} ${component.name}`.toLowerCase();
      if (terms.some((term) => hay.includes(term))) {
        found.push({ kind: 'COMPONENT', name: component.name, detail: `${component.kind} ${component.componentKey}` });
      }
    }
  }
  for (const path of input.paths ?? []) {
    if (ownerExists(path, input.root)) found.push({ kind: 'PATH', name: path, detail: 'present in the running image' });
  }
  return found;
}

/** The lines a status page prints for one loop. */
export function formatGapLoop(state: GapLoopState): string[] {
  return [
    `GAP ${state.gapKey} cause=${state.cause ?? 'unknown'} integrated=${state.integrated ? 'yes' : 'no'} next=${state.next ?? 'none'}`,
    ...state.steps.map((one) => `  ${one.at.slice(0, 19)}Z ${one.step.padEnd(15)} ${one.summary}`),
  ];
}
