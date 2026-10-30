/**
 * Record-level diffs: a re-pull against what is held says which records are
 * new, changed or gone, and an unchanged record costs nothing downstream.
 * Versions are append-only values; collected text stays RAW INFORMATION and
 * never becomes a finding here.
 */
import { recordContentHash, type CollectedRecord } from '../dedupe/keys.ts';

export type ChangeKind = 'NEW' | 'CHANGED' | 'DISAPPEARED';

export interface HeldRecord extends CollectedRecord {
  id: string;
  contentHash: string;
}

export interface RecordChange {
  kind: ChangeKind;
  externalId: string;
  recordId: string | null;
  /** Names of fields whose value differs (CHANGED only). */
  fields: string[];
  before: CollectedRecord | null;
  after: CollectedRecord | null;
}

const FIELDS = ['title', 'organization', 'publishedAt', 'body', 'url'] as const;

export function diffPull(input: {
  held: readonly HeldRecord[];
  pulled: readonly CollectedRecord[];
  /** Only a pull that fully covered the source may call a record gone. */
  complete: boolean;
}): { changes: RecordChange[]; unchanged: number } {
  const held = new Map(input.held.map((r) => [r.externalId, r]));
  const seen = new Set<string>();
  const changes: RecordChange[] = [];
  let unchanged = 0;
  for (const after of input.pulled) {
    if (seen.has(after.externalId)) continue; // duplicate delivery is idempotent
    seen.add(after.externalId);
    const before = held.get(after.externalId);
    if (!before) {
      changes.push({ kind: 'NEW', externalId: after.externalId, recordId: null, fields: [], before: null, after });
    } else if (before.contentHash !== recordContentHash(after)) {
      const fields = FIELDS.filter((f) => (before[f] ?? null) !== (after[f] ?? null));
      changes.push({ kind: 'CHANGED', externalId: after.externalId, recordId: before.id, fields: [...fields], before, after });
    } else unchanged += 1;
  }
  if (input.complete) {
    for (const before of input.held) {
      if (!seen.has(before.externalId)) {
        changes.push({ kind: 'DISAPPEARED', externalId: before.externalId, recordId: before.id, fields: [], before, after: null });
      }
    }
  }
  return { changes, unchanged };
}

/** Page-change watch: unchanged content (same hash) is not re-processed. */
export function pageChanged(previousHash: string | null, currentHash: string): 'FIRST' | 'CHANGED' | 'UNCHANGED' {
  if (previousHash === null) return 'FIRST';
  return previousHash === currentHash ? 'UNCHANGED' : 'CHANGED';
}
