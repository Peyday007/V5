/**
 * Detectors defined by data rather than by code.
 *
 * A learned detector is built from at least three positive example titles and
 * any number of negatives, starts in SHADOW, and is measured on items people
 * or checks have judged. It is promoted to ACTIVE only when its measured
 * precision clears the threshold stored with it, and demoted when it falls
 * below. An ACTIVE one files its detections through the same `runDetectors`
 * path the code detectors use, so the items it covers skip the free-model
 * screen; anything under the firing confidence is left uncovered, and so goes
 * to the cheap lane and then the daily Claude shortlist exactly as before.
 *
 * Nothing here calls a model, creates a research packet or assigns Claude.
 */
import {
  createLearnedDetector,
  listDetectorExamples,
  listLearnedDetectors,
  setDetectorMode,
} from '../../repos/searchMethods.ts';
import type {
  LearnedDetector,
  ScopeRef,
  SearchReader,
} from '../../domain/searchIntelligence.ts';
import type { DetectedSignal, Detector, DetectorRecord } from './detectors.ts';

export const MIN_POSITIVES = 3;
/** Judged firings needed before precision is a measurement. */
export const MIN_JUDGED_FOR_PROMOTION = 5;
/** Confidence at or above which the detector fires; between LOW_FLOOR and this is escalated. */
export const FIRE_AT = 0.6;
export const LOW_FLOOR = 0.3;

export interface LearnedDefinition {
  sources: string[];
  /** Words shared by the positives and absent from every negative. */
  terms: string[];
  positives: number;
  negatives: number;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'you', 'your', 'our', 'new']);

export function tokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** Build a definition from examples, or refuse and say why. Pure. */
export function defineFromExamples(input: {
  sources: readonly string[];
  positives: readonly string[];
  negatives: readonly string[];
}): { ok: true; definition: LearnedDefinition } | { ok: false; reason: string } {
  if (input.sources.length === 0) return { ok: false, reason: 'A detector must name the feed sources it reads.' };
  if (input.positives.length < MIN_POSITIVES) {
    return { ok: false, reason: `A detector needs at least ${MIN_POSITIVES} positive examples.` };
  }
  const pos = input.positives.map(tokens);
  const neg = input.negatives.map(tokens);
  const need = Math.ceil((pos.length * 2) / 3);
  const counts = new Map<string, number>();
  for (const set of pos) for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1);
  const terms = [...counts.entries()]
    .filter(([t, n]) => n >= need && !neg.some((set) => set.has(t)))
    .map(([t]) => t)
    .sort();
  if (terms.length === 0) {
    return { ok: false, reason: 'The examples share no term that the negatives lack, so there is nothing to detect on.' };
  }
  return {
    ok: true,
    definition: { sources: [...input.sources], terms, positives: pos.length, negatives: neg.length },
  };
}

/** Fraction of the definition's terms present in a title. */
export function confidenceOf(definition: LearnedDefinition, title: string): number {
  if (definition.terms.length === 0) return 0;
  const present = tokens(title);
  return definition.terms.filter((t) => present.has(t)).length / definition.terms.length;
}

/** Create a detector from examples. It always starts in SHADOW. */
export async function createDetectorFromExamples(
  scope: ScopeRef & {
    detectorKey: string;
    methodId?: string | null;
    sources: readonly string[];
    positives: readonly string[];
    negatives: readonly string[];
    /** The precision it must show before it may go ACTIVE, 0..1. */
    threshold: number;
  },
): Promise<{ ok: true; detector: LearnedDetector } | { ok: false; reason: string }> {
  if (!(scope.threshold > 0 && scope.threshold <= 1)) return { ok: false, reason: 'The threshold must be above 0 and at most 1.' };
  const built = defineFromExamples(scope);
  if (!built.ok) return built;
  const detector = await createLearnedDetector({
    scope: scope.scope,
    projectId: scope.projectId ?? null,
    userId: scope.userId ?? null,
    detectorKey: scope.detectorKey,
    methodId: scope.methodId ?? null,
    definition: built.definition,
    threshold: scope.threshold,
  });
  return { ok: true, detector };
}

export interface DetectorMeasure {
  judged: number;
  confirmed: number;
  rejected: number;
  precision: number | null;
}

/** Precision over judged firings only: an example that did not fire says nothing about a firing. */
export async function measureDetector(reader: SearchReader, detectorId: string): Promise<DetectorMeasure> {
  const examples = await listDetectorExamples(reader, detectorId);
  let confirmed = 0;
  let rejected = 0;
  for (const e of examples) {
    if (!e.fired) continue;
    if (e.verdict === 'CONFIRMED') confirmed += 1;
    else rejected += 1;
  }
  const judged = confirmed + rejected;
  return { judged, confirmed, rejected, precision: judged > 0 ? confirmed / judged : null };
}

export type ModeDecision =
  | { change: 'PROMOTED' | 'DEMOTED'; reason: string }
  | { change: 'NONE'; reason: string };

/** What the measurement supports for a detector in its current mode. Pure. */
export function decideMode(d: Pick<LearnedDetector, 'mode' | 'threshold'>, m: DetectorMeasure): ModeDecision {
  if (m.precision === null || m.judged < MIN_JUDGED_FOR_PROMOTION) {
    return { change: 'NONE', reason: `Only ${m.judged} judged firing(s); ${MIN_JUDGED_FOR_PROMOTION} are needed to measure precision.` };
  }
  const p = m.precision.toFixed(2);
  if (d.mode === 'SHADOW') {
    return m.precision >= d.threshold
      ? { change: 'PROMOTED', reason: `precision ${p} clears the stored ${d.threshold}` }
      : { change: 'NONE', reason: `precision ${p} is below the stored ${d.threshold}; promotion refused` };
  }
  return m.precision < d.threshold
    ? { change: 'DEMOTED', reason: `precision ${p} fell below the stored ${d.threshold}` }
    : { change: 'NONE', reason: `precision ${p} holds` };
}

/** Apply the measurement: promote, demote or leave. Guarded on the mode read. */
export async function settleDetectorMode(reader: SearchReader, detectorId: string): Promise<ModeDecision & { mode: 'ACTIVE' | 'SHADOW' }> {
  const detector = (await listLearnedDetectors(reader)).find((d) => d.id === detectorId);
  if (!detector) return { change: 'NONE', reason: 'No such detector for this reader.', mode: 'SHADOW' };
  const decision = decideMode(detector, await measureDetector(reader, detectorId));
  if (decision.change === 'PROMOTED' && (await setDetectorMode(detectorId, 'SHADOW', 'ACTIVE'))) return { ...decision, mode: 'ACTIVE' };
  if (decision.change === 'DEMOTED' && (await setDetectorMode(detectorId, 'ACTIVE', 'SHADOW'))) return { ...decision, mode: 'SHADOW' };
  return { ...decision, change: 'NONE', mode: detector.mode };
}

const DAY = 86_400_000;

/** The rule the existing runner understands, built from stored data. */
export function asDetector(learned: LearnedDetector): Detector {
  const definition = learned.definition as LearnedDefinition;
  return {
    id: `learned:${learned.detectorKey}`,
    version: learned.version,
    label: learned.detectorKey,
    mode: learned.mode,
    sources: definition.sources,
    lookbackMs: 30 * DAY,
    detect(records: readonly DetectorRecord[]): DetectedSignal[] {
      const out: DetectedSignal[] = [];
      for (const r of records) {
        if (confidenceOf(definition, r.title) < FIRE_AT) continue;
        out.push({
          groupKey: `${learned.detectorKey}:${r.id}`,
          label: r.title,
          entityKey: null,
          entityName: r.organization,
          category: null,
          windowFrom: r.fetchedAt,
          windowTo: r.fetchedAt,
          memberIds: [r.id],
          memberTitles: [r.title],
          sourceUrls: [r.url],
          qualifiers: [`matched the learned pattern "${definition.terms.join(' ')}"`],
          hypothesis: null,
          deliverable: null,
        });
      }
      return out;
    },
  };
}

/** Re-decide each detector's mode from its measured precision (promote or demote). */
export async function settleLearnedModes(reader: SearchReader): Promise<void> {
  for (const d of await listLearnedDetectors(reader)) await settleDetectorMode(reader, d.id);
}

/** The stored detectors this reader may use, as runnable rules. */
export async function learnedDetectorsFor(reader: SearchReader): Promise<Detector[]> {
  return (await listLearnedDetectors(reader)).map(asDetector);
}

export interface LearnedRouting {
  /** Handled by an ACTIVE detector: no packet, no assignment, no model call. */
  handled: string[];
  /** Fired in SHADOW: measured, but still screened as before. */
  observed: string[];
  /** Close but under the firing confidence: left for the cheap lane, then the Claude shortlist. */
  escalate: string[];
  /** One per item an ACTIVE detector handled: a screen and shortlist slot not spent. */
  aiJobsAvoided: number;
}

/** Decide, for these stored items, what each learned detector covers and what goes on. Pure. */
export function routeRecords(detectors: readonly LearnedDetector[], records: readonly DetectorRecord[]): LearnedRouting {
  const out: LearnedRouting = { handled: [], observed: [], escalate: [], aiJobsAvoided: 0 };
  const taken = new Set<string>();
  for (const d of detectors) {
    const def = d.definition as LearnedDefinition;
    for (const r of records) {
      if (!def.sources.includes(r.source) || taken.has(r.id)) continue;
      const c = confidenceOf(def, r.title);
      if (c >= FIRE_AT) {
        (d.mode === 'ACTIVE' ? out.handled : out.observed).push(r.id);
        if (d.mode === 'ACTIVE') taken.add(r.id);
      } else if (c >= LOW_FLOOR && !out.escalate.includes(r.id)) {
        out.escalate.push(r.id);
      }
    }
  }
  out.escalate = out.escalate.filter((id) => !taken.has(id));
  out.aiJobsAvoided = out.handled.length;
  return out;
}
