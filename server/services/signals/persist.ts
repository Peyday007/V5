/** Writing combined signals: one row per (subject, pattern), idempotent, always SIGNAL. */
import { recordCombinedSignal } from '../../repos/signals.ts';
import { listProjects } from '../../repos/projects.ts';
import { listNodes } from '../../repos/industry.ts';
import { detectionMembers } from '../feeds/detectors.ts';
import { triggerFindings } from '../cash/triggers.ts';
import { combineSignals, type CombinedResult, type SignalMember, type UnfamiliarShape } from './combine.ts';

/** Resolves an industry hint to a node id, or null. The industry kernel owns the lookup. */
export type IndustryResolver = (hint: string) => Promise<string | null>;

export async function persistCombined(
  projectId: string,
  results: readonly CombinedResult[],
  resolveIndustry: IndustryResolver = async () => null,
): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  for (const r of results) {
    const out = await recordCombinedSignal({
      projectId, subjectKind: r.subjectKind, subjectKey: r.subjectKey, pattern: r.pattern,
      memberDetectionIds: r.memberDetectionIds, industryNodeId: await resolveIndustry(r.industryHint),
      possibleNeed: r.possibleNeed, captureMethods: r.captureMethods,
    });
    if (out.created) created++; else existing++;
  }
  return { created, existing };
}

/**
 * Resolves a hint to one of the project's own live industry nodes by name, or
 * null. Exact (case- and space-insensitive) only: a near match is a guess.
 */
export async function industryResolverFor(projectId: string): Promise<IndustryResolver> {
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const byName = new Map<string, string>();
  for (const node of await listNodes(projectId)) {
    if (node.retiredAt) continue;
    const key = norm(node.name);
    if (!byName.has(key)) byName.set(key, node.id);
  }
  return async (hint) => byName.get(norm(hint)) ?? null;
}

export interface SignalCombinationReport {
  projects: number;
  detections: number;
  triggerFindings: number;
  considered: number;
  created: number;
  existing: number;
  /** Shapes no pattern covers yet, for research to propose a pattern once. */
  unfamiliar: UnfamiliarShape[];
  /** Always 0: combining is code. */
  modelJobs: 0;
  elapsedMs: number;
}

/**
 * The batch that populates `combined_signals`: open detections (public feed
 * data, the same for every project) and each project's own trigger findings
 * are combined by code and written under that project. A project's findings
 * are only ever combined with public detections and its own findings — never
 * another project's. Idempotent: a second run finds the rows the first wrote.
 */
export async function runSignalCombination(input: { now?: Date; projectIds?: readonly string[] } = {}): Promise<SignalCombinationReport> {
  const started = performance.now();
  const now = input.now ?? new Date();
  const projectIds = input.projectIds ?? (await listProjects()).map((one) => one.id);
  const detections: SignalMember[] = (await detectionMembers(now)).map((d) => ({
    id: d.id, origin: 'DETECTOR', kind: d.kind, subjectKind: 'ORGANISATION', subject: d.subject, at: d.at,
  }));
  const findings = await triggerFindings(projectIds);
  const byProject = new Map<string, SignalMember[]>();
  for (const f of findings) {
    const list = byProject.get(f.projectId) ?? [];
    list.push({ id: f.id, origin: 'TRIGGER', kind: f.kind, subjectKind: 'ORGANISATION', subject: f.subject, at: f.at });
    byProject.set(f.projectId, list);
  }
  const report: SignalCombinationReport = {
    projects: 0, detections: detections.length, triggerFindings: findings.length,
    considered: 0, created: 0, existing: 0, unfamiliar: [], modelJobs: 0, elapsedMs: 0,
  };
  const unfamiliar = new Map<string, UnfamiliarShape>();
  for (const projectId of projectIds) {
    const members = [...detections, ...(byProject.get(projectId) ?? [])];
    if (members.length < 2) continue;
    const combined = combineSignals(members);
    report.projects += 1;
    report.considered += combined.considered;
    for (const shape of combined.unfamiliar) if (!unfamiliar.has(shape.shape)) unfamiliar.set(shape.shape, shape);
    if (combined.results.length === 0) continue;
    const out = await persistCombined(projectId, combined.results, await industryResolverFor(projectId));
    report.created += out.created;
    report.existing += out.existing;
  }
  report.unfamiliar = [...unfamiliar.values()].sort((a, b) => a.shape.localeCompare(b.shape));
  report.elapsedMs = performance.now() - started;
  return report;
}
