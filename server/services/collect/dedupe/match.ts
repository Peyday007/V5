/**
 * Exact and near-duplicate matching within and across sources. A match is a
 * link to the earlier record and to every contributing source, never a second
 * row. Near matching needs the same organisation and the same title words
 * within a few days; undated records match only exactly.
 */
import { canonicalUrl, recordContentHash, recordKey, type CollectedRecord } from './keys.ts';
import { titleKey } from '../../feeds/detectors.ts';

export type MatchKind = 'SAME_SOURCE_ID' | 'SAME_URL' | 'SAME_CONTENT' | 'SAME_KEY' | 'NEAR';

export interface KnownRecord extends CollectedRecord {
  id: string;
  /** Every source that has delivered this record. */
  sources: readonly string[];
}

export interface Match {
  kind: MatchKind;
  earlierId: string;
}

export const NEAR_WINDOW_MS = 3 * 86_400_000;
export const NEAR_MIN_SIMILARITY = 0.85;

const words = (title: string): Set<string> => new Set(titleKey(title).split(' ').filter(Boolean));

/** Jaccard similarity of title words, 0 when either title has none. */
export function titleSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** The earliest known record this one repeats, or null. Deterministic: strongest evidence, then lowest id. */
export function findDuplicate(record: CollectedRecord, known: readonly KnownRecord[]): Match | null {
  const order = [...known].sort((a, b) => a.id.localeCompare(b.id));
  const url = canonicalUrl(record.url);
  const key = recordKey(record);
  const hash = recordContentHash(record);
  const tests: [MatchKind, (k: KnownRecord) => boolean][] = [
    ['SAME_SOURCE_ID', (k) => k.source === record.source && k.externalId === record.externalId],
    ['SAME_URL', (k) => url !== null && canonicalUrl(k.url) === url],
    ['SAME_CONTENT', (k) => recordContentHash(k) === hash],
    ['SAME_KEY', (k) => key !== null && recordKey(k) === key],
    ['NEAR', (k) => isNear(record, k)],
  ];
  for (const [kind, test] of tests) {
    const hit = order.find(test);
    if (hit) return { kind, earlierId: hit.id };
  }
  return null;
}

function isNear(a: CollectedRecord, b: CollectedRecord): boolean {
  const orgA = recordKey({ ...a, title: 'x' })?.split('|')[0];
  const orgB = recordKey({ ...b, title: 'x' })?.split('|')[0];
  if (!orgA || orgA !== orgB) return false;
  const ta = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
  const tb = b.publishedAt ? Date.parse(b.publishedAt) : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > NEAR_WINDOW_MS) return false;
  return titleSimilarity(a.title, b.title) >= NEAR_MIN_SIMILARITY;
}

/** The sources a linked record is now known from, order-stable and without repeats. */
export const mergeSources = (existing: readonly string[], incoming: string): string[] =>
  [...new Set([...existing, incoming])].sort();
