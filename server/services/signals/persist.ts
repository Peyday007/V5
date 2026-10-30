/** Writing combined signals: one row per (subject, pattern), idempotent, always SIGNAL. */
import { recordCombinedSignal } from '../../repos/signals.ts';
import type { CombinedResult } from './combine.ts';

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
