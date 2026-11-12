/**
 * The feed run is where learned search runs for real.
 *
 * `runDetectors` is called on every feeds pass of Russell's tick. Before this
 * module, the learned detectors, the search-method records they serve, the
 * failure classification and the trust lifecycle were each correct in a test
 * and reached by nothing in production: no pass installed a learned detector,
 * settled its mode, recorded a run against its method or stopped a failing one.
 *
 * On each pass, for the GENERAL scope only (feed items and detections are
 * shared rows, so a project's or a person's private pattern never fires here):
 *
 *   0. the cheap lane's agreed screen answers propose new SHADOW detectors and
 *      judge every detector's firings on items it was not built from
 *      (`learnFromScreens.ts`), so precision is measured from production rows;
 *   1. every learned detector's mode is settled from its measured precision —
 *      promoted to ACTIVE or demoted to SHADOW by the stored threshold;
 *   2. a detector serving a search method whose recent runs say PAUSE or
 *      REVISE (`decideMethod`) is not run: a failing method waits, or waits
 *      for revision, instead of repeating itself;
 *   3. after it runs, a pass over items that arrived since the method's last
 *      run is recorded as one CODE run and the method's trust is settled from
 *      its runs. The run is FOUND when it surfaced something, FALSE_POSITIVES
 *      when it surfaced something but the detector's judged firings are mostly
 *      rejected, and NOTHING_SUITABLE when it surfaced nothing. A pass that saw
 *      nothing new records nothing — unless every pull of the detector's
 *      sources since the method's last run failed, which is SOURCE_UNAVAILABLE:
 *      the source could not be read, so nothing new says nothing about whether
 *      anything is there.
 *
 * Nothing here calls a model.
 */
import { getSearchMethod, listDetectorExamples, listLearnedDetectors, listMethodComparisons, listMethodRuns } from '../../repos/searchMethods.ts';
import { compareMethods, type MethodComparison, type MethodResult } from '../research/searchMethods/compare.ts';
import type { LearnedDetector, SearchReader } from '../../domain/searchIntelligence.ts';
import { decideMethod, type MethodDecision } from '../research/searchFailures/classify.ts';
import { recordRunAndSettle } from '../research/searchMethods/lifecycle.ts';
import { pullsSince } from '../../repos/feeds.ts';
import { asDetector, measureDetector, MIN_JUDGED_FOR_PROMOTION, settleDetectorMode, type LearnedDefinition } from './learned.ts';
import type { Detector, DetectorRecord } from './detectors.ts';

/** Feed items are shared rows: only GENERAL learning may act on them. */
export const FEED_READER: SearchReader = { projectIds: [], userId: null };

export interface InstalledLearned {
  learned: LearnedDetector;
  detector: Detector;
}

export interface HeldLearned {
  detectorKey: string;
  methodId: string;
  decision: MethodDecision;
}

/** Settle modes, then the learned detectors this pass may run and those held back. */
export async function installLearned(now: Date): Promise<{ run: InstalledLearned[]; held: HeldLearned[] }> {
  /*
   * The producer: detectors proposed from the cheap lane's agreed screen
   * answers, and every detector's firings judged on items it was not built
   * from (`learnFromScreens.ts`). It runs before the modes are settled, so a
   * pass promotes or demotes on the judgments it just recorded. A fault there
   * never stops the detectors that already exist.
   */
  try {
    const { learnFromScreens } = await import('./learnFromScreens.ts');
    await learnFromScreens(now);
  } catch {
    /* settle and run what already exists */
  }
  for (const d of await listLearnedDetectors(FEED_READER)) await settleDetectorMode(FEED_READER, d.id);
  const run: InstalledLearned[] = [];
  const held: HeldLearned[] = [];
  for (const learned of await listLearnedDetectors(FEED_READER)) {
    if (learned.methodId) {
      const decision = decideMethod(await listMethodRuns(FEED_READER, learned.methodId), now.toISOString());
      if (decision.action !== 'RUN') {
        held.push({ detectorKey: learned.detectorKey, methodId: learned.methodId, decision });
        continue;
      }
    }
    run.push({ learned, detector: asDetector(learned) });
  }
  return { run, held };
}

/** Below this measured precision, what a detector surfaces is mostly wrong. */
export const FALSE_POSITIVE_PRECISION = 0.5;

/**
 * Record one pass of a learned detector as a run of its method. Returns false
 * when nothing was recorded (no method, or no item new since the last run and
 * no failed pull of its sources since then either).
 */
export async function recordLearnedPass(input: {
  learned: LearnedDetector;
  records: readonly DetectorRecord[];
  signals: readonly { memberIds: readonly string[] }[];
}): Promise<boolean> {
  const methodId = input.learned.methodId;
  if (!methodId) return false;
  const runs = await listMethodRuns(FEED_READER, methodId);
  const last = runs.length ? runs[runs.length - 1]!.finishedAt : null;
  const fresh = last === null ? input.records : input.records.filter((r) => r.fetchedAt > last);
  if (fresh.length === 0) {
    // Nothing new. If every pull of its sources since the last run failed, the
    // source was unreadable: that is a run, and a different fact from "nothing".
    const sources = (input.learned.definition as LearnedDefinition).sources ?? [];
    const pulls = await pullsSince(sources, last);
    if (pulls.failed === 0 || pulls.ok > 0) return false;
    const recorded = await recordRunAndSettle(FEED_READER, {
      methodId,
      executor: 'CODE',
      outcome: 'SOURCE_UNAVAILABLE',
      failureCause: `${pulls.failed} pull(s) of ${sources.join(', ')} failed and none succeeded${pulls.lastError ? `: ${pulls.lastError.slice(0, 200)}` : ''}`,
      examined: 0,
      surfaced: 0,
    });
    return recorded !== null;
  }
  const freshIds = new Set(fresh.map((r) => r.id));
  const surfacedIds = new Set(
    input.signals.flatMap((s) => s.memberIds.filter((id) => freshIds.has(id))),
  );
  const surfaced = input.signals.filter((s) => s.memberIds.some((id) => freshIds.has(id))).length;
  // Judgments of what this pass surfaced, counted once each, so run metrics
  // never re-count a verdict an earlier run already carried.
  let confirmed = 0;
  let rejected = 0;
  for (const e of await listDetectorExamples(FEED_READER, input.learned.id)) {
    if (!e.fired || !surfacedIds.has(e.itemRef)) continue;
    if (e.verdict === 'CONFIRMED') confirmed += 1;
    else rejected += 1;
  }
  let outcome: 'FOUND' | 'NOTHING_SUITABLE' | 'FALSE_POSITIVES' = surfaced > 0 ? 'FOUND' : 'NOTHING_SUITABLE';
  let failureCause: string | null = null;
  if (surfaced > 0) {
    // The detector's precision over every judged firing is the measurement of
    // whether what it surfaces is right; a pass alone is rarely judged yet.
    const measure = await measureDetector(FEED_READER, input.learned.id);
    if (measure.precision !== null && measure.judged >= MIN_JUDGED_FOR_PROMOTION && measure.precision < FALSE_POSITIVE_PRECISION) {
      outcome = 'FALSE_POSITIVES';
      failureCause = `${measure.rejected} of the detector's ${measure.judged} judged firing(s) were rejected (precision ${measure.precision.toFixed(2)})`;
    }
  }
  const recorded = await recordRunAndSettle(FEED_READER, {
    methodId,
    executor: 'CODE',
    outcome,
    failureCause,
    examined: fresh.length,
    surfaced,
    confirmed,
    rejected,
  });
  return recorded !== null;
}

/** One learned detector's pass, as `runDetectors` ran it. */
export interface LearnedPass {
  learned: LearnedDetector;
  records: readonly DetectorRecord[];
  signals: readonly { memberIds: readonly string[] }[];
}

/**
 * Compare, on the same data, every method for one subject that ran in this
 * pass. Nothing here is asked for: whenever two or more learned detectors serve
 * different methods linked to one learned subject, their pass is a comparison.
 *
 * The shared data is the items every one of those detectors read that arrived
 * after the subject's last recorded comparison, so a pass never re-compares
 * items an earlier comparison already judged, and a second pass with nothing
 * new records nothing. Each method's result is what its detector surfaced from
 * those items and the judged firings among them (`CONFIRMED` or not), so
 * methods are ranked by measured precision on identical items through
 * `compareMethods`, which records the comparison. A subject whose methods
 * surfaced nothing new records nothing: there is nothing to rank.
 *
 * GENERAL only, like the rest of the feeds pass. Nothing here calls a model.
 */
export async function compareSubjectPasses(passes: readonly LearnedPass[]): Promise<MethodComparison[]> {
  const bySubject = new Map<string, Map<string, LearnedPass>>();
  for (const pass of passes) {
    const methodId = pass.learned.methodId;
    if (!methodId) continue;
    const method = await getSearchMethod(FEED_READER, methodId);
    if (!method?.subjectId) continue;
    const methods = bySubject.get(method.subjectId) ?? new Map<string, LearnedPass>();
    // One pass per method: a second detector of the same method is the same method.
    if (!methods.has(methodId)) methods.set(methodId, pass);
    bySubject.set(method.subjectId, methods);
  }
  const out: MethodComparison[] = [];
  for (const [subjectId, methods] of bySubject) {
    if (methods.size < 2) continue;
    const last = (await listMethodComparisons(FEED_READER, { subjectId, limit: 1 }))[0]?.createdAt ?? null;
    const readBy = [...methods.values()].map(
      (pass) => new Set(pass.records.filter((r) => last === null || r.fetchedAt > last).map((r) => r.id)),
    );
    const shared = [...readBy[0]!].filter((id) => readBy.every((one) => one.has(id))).sort();
    if (shared.length === 0) continue;
    const items = new Set(shared);
    const results: Record<string, MethodResult> = {};
    let anySurfaced = false;
    for (const [methodId, pass] of methods) {
      const surfaced = [...new Set(pass.signals.flatMap((s) => s.memberIds.filter((id) => items.has(id))))];
      const fired = new Set(surfaced);
      const confirmed: string[] = [];
      const rejected: string[] = [];
      for (const e of await listDetectorExamples(FEED_READER, pass.learned.id)) {
        if (!e.fired || !fired.has(e.itemRef)) continue;
        if (confirmed.includes(e.itemRef) || rejected.includes(e.itemRef)) continue;
        (e.verdict === 'CONFIRMED' ? confirmed : rejected).push(e.itemRef);
      }
      if (surfaced.length > 0) anySurfaced = true;
      results[methodId] = { surfaced, confirmed, rejected };
    }
    if (!anySurfaced) continue;
    const compared = await compareMethods(FEED_READER, { subjectId, items: shared, results, scope: { scope: 'GENERAL' } });
    if (compared.ok) out.push(compared.comparison);
  }
  return out;
}
