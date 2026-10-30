/**
 * Established trigger rules run in code over changes — zero Claude jobs and
 * zero cheap-lane calls for a record a rule matched. A change no rule matched
 * is routed, not discarded: unusual ones go to the cheap lane.
 */
import { DETECTORS, type Detector, type DetectorRecord } from '../../feeds/detectors.ts';
import type { RecordChange } from './diff.ts';

export type Route = 'MATCHED_BY_CODE' | 'CHEAP_LANE' | 'IGNORE';

export interface RoutedChange {
  change: RecordChange;
  route: Route;
  rules: string[];
}

const toDetectorRecord = (change: RecordChange): DetectorRecord | null => {
  const r = change.after;
  if (!r) return null;
  return { id: change.recordId ?? change.externalId, source: r.source, url: r.url ?? '', title: r.title, organization: r.organization, publishedAt: r.publishedAt, fetchedAt: r.publishedAt ?? '' };
};

/** A change is unusual when a field a reader relies on moved, or a record vanished. */
export const isUnusual = (c: RecordChange): boolean =>
  c.kind === 'DISAPPEARED' || (c.kind === 'CHANGED' && c.fields.some((f) => f === 'title' || f === 'organization'));

export function routeChanges(
  changes: readonly RecordChange[],
  existing: readonly DetectorRecord[],
  now: Date,
  detectors: readonly Detector[] = DETECTORS,
): RoutedChange[] {
  const incoming = changes.map(toDetectorRecord).filter((r): r is DetectorRecord => r !== null);
  const merged = [...existing.filter((e) => !incoming.some((i) => i.id === e.id)), ...incoming];
  const matched = new Map<string, string[]>();
  for (const d of detectors) {
    for (const signal of d.detect(merged, now)) {
      for (const id of signal.memberIds) matched.set(id, [...(matched.get(id) ?? []), `${d.id}@${d.version}`]);
    }
  }
  return changes.map((change) => {
    const rules = matched.get(change.recordId ?? change.externalId) ?? [];
    if (rules.length > 0) return { change, route: 'MATCHED_BY_CODE', rules };
    return { change, route: isUnusual(change) ? 'CHEAP_LANE' : 'IGNORE', rules: [] };
  });
}

export interface RuleOutcome { rule: string; fired: number; falsePositives: number }

/** Per-rule false-positive rate from downstream outcomes; null when nothing fired. */
export const falsePositiveRate = (o: RuleOutcome): number | null => (o.fired === 0 ? null : o.falsePositives / o.fired);
