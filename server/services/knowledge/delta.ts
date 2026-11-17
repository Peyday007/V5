/**
 * Delta processing over source records (KNOW-25-1, "avoid recreating old
 * understanding").
 *
 * A source record has a stable identity (its source and its own record id or
 * address) and, each time it is read, a content fingerprint. This module keeps
 * every version of every record it has seen, and on each new batch says, per
 * record, whether it is NEW, CHANGED, UNCHANGED, or must be REPARSED because
 * the parser that read it has since changed. Only what changed is re-read, and
 * only the facts and dependent models the changed record's previous version
 * produced are recomputed — never the whole store.
 *
 * Established entity mappings (a name read as one entity) are kept across
 * passes and are only reopened when the record that set them is being re-read.
 * A tested parsing method is kept by recording which parser version read each
 * version: a parser change re-reads exactly the records that parser read.
 *
 * Nothing here opens a source, owns a schedule or stores anything (§10.3,
 * §20.4). The working index lives in memory for one pass; what a caller keeps
 * between passes is its carried form (`carryDeltaIndex`): the latest version
 * of each record only, without the per-record dependents — and, because the
 * row a caller keeps it in may be append-only, a caller writes that full form
 * only occasionally and otherwise a journal of what one pass changed
 * (`journalDeltaIndex`), and rebuilds the index from the last full form and
 * the journals after it (`restoreDeltaIndex`). The history of every version is
 * the append-only pass records themselves, never a copy re-written each pass.
 * Pure.
 */
import { createHash } from 'node:crypto';

export const DELTA_INDEX_SCHEMA = 'knowledge-delta/1';

export type DeltaStatus = 'NEW' | 'CHANGED' | 'UNCHANGED' | 'REPARSE';

/** One record as a batch presents it, before it is read. */
export interface SourceRecord {
  source: string;
  /** The record's own id or address at its source. */
  recordId: string;
  /** What the record says; its fingerprint never includes when or where it was fetched. */
  content: unknown;
}

/** One version of a record: what it was, which parser read it, and what that reading produced. */
export interface RecordVersion {
  version: number;
  fingerprint: string;
  seenAt: string;
  /** The parser version that read this version, or null until it is read. */
  parserVersion: string | null;
  /** Fact keys the reading of this version produced. */
  factKeys: string[];
  /** Entities the reading of this version concerned. */
  entities: string[];
  /** Dependent models (graph neighbourhoods, plans, positions) built from those facts. */
  dependents: string[];
}

export interface RecordHistory {
  identity: string;
  /**
   * Versions, oldest first. Within one pass a changed record holds its previous
   * version and the new one; the carried form keeps only the latest, so this
   * never grows across passes. Earlier versions are in the pass records.
   */
  versions: RecordVersion[];
}

export interface EntityMapping {
  /** The entity a name was established as. */
  entityId: string;
  /** The record identity whose reading established it. */
  setBy: string;
  setAt: string;
}

export interface DeltaIndex {
  schema: typeof DELTA_INDEX_SCHEMA;
  records: Record<string, RecordHistory>;
  /** Normalized name -> the entity it was established as. */
  entityMappings: Record<string, EntityMapping>;
}

export interface DeltaChange {
  identity: string;
  status: DeltaStatus;
  /** The version this batch's content is (unchanged: the existing latest). */
  version: number;
  fingerprint: string;
  previousFingerprint: string | null;
  /** Why it is (or is not) re-read. */
  reason: string;
}

export interface DeltaPlan {
  changes: DeltaChange[];
  /** Record identities to read now: NEW, CHANGED and REPARSE only. */
  toRead: string[];
  /** Fact keys the previous versions of changed or re-parsed records produced: these, and only these, are recomputed. */
  affectedFactKeys: string[];
  /** Entities those previous versions concerned. */
  affectedEntities: string[];
  /** Dependent models built from those facts. */
  affectedDependents: string[];
  counts: Record<DeltaStatus, number>;
  /** The index with the new versions appended (readings not yet attached). */
  index: DeltaIndex;
}

/** A reading of one record version, attached after the caller read it. */
export interface RecordReading {
  identity: string;
  parserVersion: string;
  factKeys: readonly string[];
  entities?: readonly string[];
  dependents?: readonly string[];
  /** Names this reading resolved to entities. */
  entityMappings?: Readonly<Record<string, string>>;
}

export function emptyDeltaIndex(): DeltaIndex {
  return { schema: DELTA_INDEX_SCHEMA, records: {}, entityMappings: {} };
}

/** The stable identity of a source record. */
export function recordIdentity(source: string, recordId: string): string {
  return `${source}\u0000${recordId}`;
}

/** JSON with object keys sorted, so the same content always serializes the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** The content fingerprint of a record: sha256 of its canonical content. */
export function fingerprintOf(content: unknown): string {
  return createHash('sha256').update(typeof content === 'string' ? content : canonical(content)).digest('hex');
}

/** A JSON-read index, or an empty one when the value is not a delta index this module wrote. */
export function readDeltaIndex(value: unknown): DeltaIndex {
  const v = value as Partial<DeltaIndex> | null;
  if (!v || v.schema !== DELTA_INDEX_SCHEMA || typeof v.records !== 'object' || v.records === null) return emptyDeltaIndex();
  return { schema: DELTA_INDEX_SCHEMA, records: v.records as Record<string, RecordHistory>, entityMappings: (v.entityMappings ?? {}) as Record<string, EntityMapping> };
}

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort();

function cloneIndex(index: DeltaIndex): DeltaIndex {
  return JSON.parse(JSON.stringify(index)) as DeltaIndex;
}

/**
 * Classify a batch against the index. A record whose fingerprint matches its
 * latest version and which was read by the current parser is UNCHANGED and
 * costs nothing. A changed fingerprint appends a new version (the old ones
 * stay) and recomputes what the previous version produced. A record whose
 * latest version was read by a different parser is REPARSED: same version,
 * read again. Pure; the input index is not modified.
 */
export function planDelta(input: { index: DeltaIndex; batch: readonly SourceRecord[]; parserVersion: string; now: string }): DeltaPlan {
  const index = cloneIndex(input.index);
  const changes: DeltaChange[] = [];
  const affectedFacts = new Set<string>();
  const affectedEntities = new Set<string>();
  const affectedDependents = new Set<string>();
  const seen = new Set<string>();
  const carry = (v: RecordVersion | undefined) => {
    if (!v) return;
    for (const k of v.factKeys) affectedFacts.add(k);
    for (const e of v.entities) affectedEntities.add(e);
    for (const d of v.dependents) affectedDependents.add(d);
  };
  for (const record of input.batch) {
    const identity = recordIdentity(record.source, record.recordId);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const fingerprint = fingerprintOf(record.content);
    const history = index.records[identity];
    const latest = history?.versions[history.versions.length - 1];
    if (!history || !latest) {
      index.records[identity] = { identity, versions: [{ version: 1, fingerprint, seenAt: input.now, parserVersion: null, factKeys: [], entities: [], dependents: [] }] };
      changes.push({ identity, status: 'NEW', version: 1, fingerprint, previousFingerprint: null, reason: 'first time this record is seen' });
      continue;
    }
    if (latest.fingerprint !== fingerprint) {
      carry(latest);
      const version = latest.version + 1;
      history.versions.push({ version, fingerprint, seenAt: input.now, parserVersion: null, factKeys: [], entities: [], dependents: [] });
      changes.push({ identity, status: 'CHANGED', version, fingerprint, previousFingerprint: latest.fingerprint, reason: `content changed since version ${latest.version}` });
      continue;
    }
    if (latest.parserVersion !== input.parserVersion) {
      carry(latest);
      changes.push({
        identity,
        status: 'REPARSE',
        version: latest.version,
        fingerprint,
        previousFingerprint: latest.fingerprint,
        reason: latest.parserVersion === null ? 'never read' : `read by ${latest.parserVersion}, the parser is now ${input.parserVersion}`,
      });
      continue;
    }
    changes.push({ identity, status: 'UNCHANGED', version: latest.version, fingerprint, previousFingerprint: latest.fingerprint, reason: `same content, already read by ${latest.parserVersion}` });
  }
  const counts: Record<DeltaStatus, number> = { NEW: 0, CHANGED: 0, UNCHANGED: 0, REPARSE: 0 };
  for (const c of changes) counts[c.status] += 1;
  return {
    changes,
    toRead: changes.filter((c) => c.status !== 'UNCHANGED').map((c) => c.identity),
    affectedFactKeys: sortedUnique(affectedFacts),
    affectedEntities: sortedUnique(affectedEntities),
    affectedDependents: sortedUnique(affectedDependents),
    counts,
    index,
  };
}

/**
 * Attach readings to each record's latest version, and keep entity mappings.
 * An established mapping stays as it is unless the record that set it is one
 * of the records read now — then the new reading may reopen it. A name no
 * mapping covers yet is established by the reading that names it first. Pure.
 */
export function commitReadings(index: DeltaIndex, readings: readonly RecordReading[], now: string): DeltaIndex {
  const next = cloneIndex(index);
  const reread = new Set(readings.map((r) => r.identity));
  for (const reading of readings) {
    const history = next.records[reading.identity];
    const latest = history?.versions[history.versions.length - 1];
    if (!latest) continue;
    latest.parserVersion = reading.parserVersion;
    latest.factKeys = sortedUnique(reading.factKeys);
    latest.entities = sortedUnique(reading.entities ?? []);
    latest.dependents = sortedUnique(reading.dependents ?? []);
  }
  for (const reading of readings) {
    for (const [name, entityId] of Object.entries(reading.entityMappings ?? {})) {
      const held = next.entityMappings[name];
      if (held && !reread.has(held.setBy)) continue;
      if (held && held.setBy !== reading.identity && reread.has(held.setBy)) {
        // Reopened only by the record that set it; another record's reading does not move it.
        continue;
      }
      if (held && held.entityId === entityId) continue;
      next.entityMappings[name] = { entityId, setBy: reading.identity, setAt: now };
    }
  }
  return next;
}

/** Records whose latest version was read by a parser other than `parserVersion`: what a parser change re-reads. */
export function recordsReadByOtherParser(index: DeltaIndex, parserVersion: string): string[] {
  return Object.values(index.records)
    .filter((h) => {
      const latest = h.versions[h.versions.length - 1];
      return !!latest && latest.parserVersion !== null && latest.parserVersion !== parserVersion;
    })
    .map((h) => h.identity)
    .sort();
}

// ---------------------------------------------------------------------------
// The carried form: what a caller keeps between passes.
// ---------------------------------------------------------------------------

export const CARRIED_DELTA_SCHEMA = 'knowledge-delta-carried/2';

/** One record's latest version, compactly: version, fingerprint, parser, when, fact keys, entities. No dependents. */
export type CarriedRecord = [version: number, fingerprint: string, parserVersion: string | null, seenAt: string, factKeys: string[], entities: string[]];

/** An entity mapping, compactly: entity, the record that set it, when. */
export type CarriedMapping = [entityId: string, setBy: string, setAt: string];

/** The whole index in its carried form: the latest version of each record and the established mappings. */
export interface CarriedDeltaIndex {
  schema: typeof CARRIED_DELTA_SCHEMA;
  kind: 'SNAPSHOT';
  records: Record<string, CarriedRecord>;
  mappings: Record<string, CarriedMapping>;
}

/** What one pass changed: the records and mappings whose carried form differs from before, and nothing else. */
export interface DeltaJournal {
  schema: typeof CARRIED_DELTA_SCHEMA;
  kind: 'JOURNAL';
  records: Record<string, CarriedRecord>;
  mappings: Record<string, CarriedMapping>;
  /** Records dropped from the index by the caller's bound, so a restore drops them too. */
  dropped: string[];
}

function carriedRecordOf(history: RecordHistory): CarriedRecord | null {
  const latest = history.versions[history.versions.length - 1];
  if (!latest) return null;
  return [latest.version, latest.fingerprint, latest.parserVersion, latest.seenAt, [...latest.factKeys], [...latest.entities]];
}

const sameCarried = (a: CarriedRecord | CarriedMapping | null | undefined, b: CarriedRecord | CarriedMapping | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The carried form of an index: latest version per record, mappings, nothing per-record that is batch-wide. */
export function carryDeltaIndex(index: DeltaIndex): CarriedDeltaIndex {
  const records: Record<string, CarriedRecord> = {};
  for (const [identity, history] of Object.entries(index.records)) {
    const carried = carriedRecordOf(history);
    if (carried) records[identity] = carried;
  }
  const mappings: Record<string, CarriedMapping> = {};
  for (const [name, m] of Object.entries(index.entityMappings)) mappings[name] = [m.entityId, m.setBy, m.setAt];
  return { schema: CARRIED_DELTA_SCHEMA, kind: 'SNAPSHOT', records, mappings };
}

/** What changed between two indexes, in carried form: only the records and mappings this pass moved. */
export function journalDeltaIndex(before: DeltaIndex, after: DeltaIndex): DeltaJournal {
  const a = carryDeltaIndex(before);
  const b = carryDeltaIndex(after);
  const records: Record<string, CarriedRecord> = {};
  for (const [identity, rec] of Object.entries(b.records)) if (!sameCarried(a.records[identity], rec)) records[identity] = rec;
  const mappings: Record<string, CarriedMapping> = {};
  for (const [name, m] of Object.entries(b.mappings)) if (!sameCarried(a.mappings[name], m)) mappings[name] = m;
  const dropped = Object.keys(a.records).filter((identity) => !(identity in b.records)).sort();
  return { schema: CARRIED_DELTA_SCHEMA, kind: 'JOURNAL', records, mappings, dropped };
}

function isCarried(value: unknown, kind: 'SNAPSHOT' | 'JOURNAL'): boolean {
  const v = value as { schema?: unknown; kind?: unknown; records?: unknown } | null;
  return !!v && v.schema === CARRIED_DELTA_SCHEMA && v.kind === kind && typeof v.records === 'object' && v.records !== null;
}

/** True when a JSON-read value is a carried snapshot this module wrote. */
export const isCarriedSnapshot = (value: unknown): value is CarriedDeltaIndex => isCarried(value, 'SNAPSHOT');
/** True when a JSON-read value is a journal this module wrote. */
export const isDeltaJournal = (value: unknown): value is DeltaJournal => isCarried(value, 'JOURNAL');

function applyCarried(index: DeltaIndex, records: Record<string, unknown>, mappings: Record<string, unknown> | undefined): void {
  for (const [identity, raw] of Object.entries(records)) {
    const r = raw as unknown[];
    if (!Array.isArray(r) || typeof r[0] !== 'number' || typeof r[1] !== 'string') continue;
    index.records[identity] = {
      identity,
      versions: [{
        version: r[0],
        fingerprint: r[1],
        parserVersion: typeof r[2] === 'string' ? r[2] : null,
        seenAt: typeof r[3] === 'string' ? r[3] : '',
        factKeys: Array.isArray(r[4]) ? (r[4] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        entities: Array.isArray(r[5]) ? (r[5] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        dependents: [],
      }],
    };
  }
  for (const [name, raw] of Object.entries(mappings ?? {})) {
    const m = raw as unknown[];
    if (!Array.isArray(m) || typeof m[0] !== 'string' || typeof m[1] !== 'string') continue;
    index.entityMappings[name] = { entityId: m[0], setBy: m[1], setAt: typeof m[2] === 'string' ? m[2] : '' };
  }
}

/**
 * Rebuild the working index from a base (a carried snapshot, a legacy full
 * index, or nothing) and the journals written after it, oldest first. Each
 * record comes back holding its latest version only. Pure.
 */
export function restoreDeltaIndex(base: unknown, journals: readonly unknown[]): DeltaIndex {
  let index: DeltaIndex;
  if (isCarriedSnapshot(base)) {
    index = emptyDeltaIndex();
    applyCarried(index, base.records as Record<string, unknown>, base.mappings as Record<string, unknown>);
  } else {
    // A legacy full index (or nothing): keep only each record's latest version.
    const legacy = carryDeltaIndex(readDeltaIndex(base));
    index = emptyDeltaIndex();
    applyCarried(index, legacy.records as Record<string, unknown>, legacy.mappings as Record<string, unknown>);
  }
  for (const journal of journals) {
    if (!isDeltaJournal(journal)) continue;
    for (const identity of Array.isArray(journal.dropped) ? journal.dropped : []) {
      delete index.records[identity];
      for (const [name, m] of Object.entries(index.entityMappings)) if (m.setBy === identity) delete index.entityMappings[name];
    }
    applyCarried(index, journal.records as Record<string, unknown>, journal.mappings as Record<string, unknown>);
  }
  return index;
}
