/**
 * The pass that keeps what Brain has learned about searching honest.
 *
 * Each pass, from recorded runs and judged examples only: a method's trust
 * moves if its results earned it, a failing method is classified (source
 * unavailable, nothing suitable, false positives) and paused or flagged for
 * revision rather than rerun, a learned detector is promoted or demoted on its
 * measured precision, and a subject left with no method that may run is
 * reported as needing one developed. Developing a method is the only work that
 * routes to Claude (`routeRequest`), and this pass never creates it: it names
 * the need, and a person or a goal decides.
 *
 * It reads each row through the reader its own scope implies, so a private
 * method is judged from its own runs and nothing is shown to anyone else.
 */
import { listAllLearnedDetectors, listAllSearchMethods, listMethodRuns } from '../../repos/searchMethods.ts';
import type { SearchMethod, SearchReader } from '../../domain/searchIntelligence.ts';
import { decideMethod, subjectStatus, type MethodDecision, type SubjectMethod } from '../research/searchFailures/classify.ts';
import { settleTrust } from '../research/searchMethods/lifecycle.ts';
import { routeRequest, type Route } from '../research/searchRouting/route.ts';
import { settleDetectorMode } from './learned.ts';

export interface SearchMaintenanceReport {
  methods: { methodKey: string; trustState: string; decision: MethodDecision }[];
  /** Subjects with no method that may run and none waiting. */
  subjectsNeedingAMethod: { subjectId: string; route: Route }[];
  detectors: { detectorKey: string; change: string; mode: string }[];
}

const readerFor = (m: Pick<SearchMethod, 'projectId' | 'userId'>): SearchReader => ({
  projectIds: m.projectId ? [m.projectId] : [],
  userId: m.userId,
});

/** Whether a method may be executed now. Executors ask this before they run one. */
export async function methodMayRun(method: SearchMethod, now: Date = new Date()): Promise<MethodDecision> {
  return decideMethod(await listMethodRuns(readerFor(method), method.id), now.toISOString());
}

export async function runSearchMaintenance(now: Date = new Date()): Promise<SearchMaintenanceReport> {
  const report: SearchMaintenanceReport = { methods: [], subjectsNeedingAMethod: [], detectors: [] };
  const bySubject = new Map<string, SubjectMethod[]>();
  for (const listed of await listAllSearchMethods()) {
    const reader = readerFor(listed);
    const method = (await settleTrust(reader, listed.id)) ?? listed;
    if (method.trustState === 'RETIRED') continue;
    const decision = decideMethod(await listMethodRuns(reader, method.id), now.toISOString());
    report.methods.push({ methodKey: method.methodKey, trustState: method.trustState, decision });
    if (method.subjectId) bySubject.set(method.subjectId, [...(bySubject.get(method.subjectId) ?? []), { methodId: method.id, decision }]);
  }
  for (const [subjectId, methods] of bySubject) {
    if (subjectStatus(methods).needsNewMethod) report.subjectsNeedingAMethod.push({ subjectId, route: routeRequest(null) });
  }
  for (const detector of await listAllLearnedDetectors()) {
    const settled = await settleDetectorMode(readerFor(detector), detector.id);
    report.detectors.push({ detectorKey: detector.detectorKey, change: settled.change, mode: settled.mode });
  }
  return report;
}
