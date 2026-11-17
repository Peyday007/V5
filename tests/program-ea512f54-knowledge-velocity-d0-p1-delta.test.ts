/**
 * KNOW-25-1, delta processing (`server/services/knowledge/delta.ts`): source
 * records are versioned by identity and content fingerprint; an unchanged
 * record costs nothing, a changed one recomputes exactly what its previous
 * version produced plus its dependents; old versions are kept; established
 * entity mappings survive; a parser change re-reads only the records it read;
 * and the index round-trips through JSON.
 */
import { describe, expect, it } from 'vitest';
import {
  commitReadings,
  emptyDeltaIndex,
  fingerprintOf,
  foldSlices,
  planDelta,
  readDeltaIndex,
  recordIdentity,
  recordsReadByOtherParser,
  sliceOf,
  type DeltaIndex,
  type SourceRecord,
} from '../server/services/knowledge/delta.ts';

const T1 = '2026-11-17T00:00:00.000Z';
const T2 = '2026-11-17T01:00:00.000Z';
const T3 = '2026-11-17T02:00:00.000Z';
const P1 = 'feeds-extract/3';

const rec = (id: string, content: unknown, source = 'feed-a'): SourceRecord => ({ source, recordId: id, content });
const idOf = (id: string, source = 'feed-a') => recordIdentity(source, id);

/** Plan, then read every record the plan asks for, as a caller would. */
function pass(index: DeltaIndex, batch: SourceRecord[], now: string, parser = P1) {
  const plan = planDelta({ index, batch, parserVersion: parser, now });
  const readings = plan.toRead.map((identity) => {
    const id = identity.split('\u0000')[1]!;
    return { identity, parserVersion: parser, factKeys: [`price:${id}`, `date:${id}`], entities: [`ent:${id}`], dependents: [`nbhd:${id}`], entityMappings: { [`acme-${id}`]: `ent:${id}` } };
  });
  return { plan, index: commitReadings(plan.index, readings, now) };
}

describe('delta classification', () => {
  it('an unchanged record yields no recomputation', () => {
    const first = pass(emptyDeltaIndex(), [rec('1', { title: 'a' }), rec('2', { title: 'b' })], T1);
    expect(first.plan.counts).toMatchObject({ NEW: 2, CHANGED: 0, UNCHANGED: 0 });
    const second = pass(first.index, [rec('1', { title: 'a' }), rec('2', { title: 'b' })], T2);
    expect(second.plan.counts).toMatchObject({ NEW: 0, CHANGED: 0, UNCHANGED: 2, REPARSE: 0 });
    expect(second.plan.toRead).toEqual([]);
    expect(second.plan.affectedFactKeys).toEqual([]);
    expect(second.plan.affectedDependents).toEqual([]);
  });

  it('a changed record recomputes exactly its prior fact keys and its dependents, nothing else', () => {
    const first = pass(emptyDeltaIndex(), [rec('1', { title: 'a' }), rec('2', { title: 'b' }), rec('3', { title: 'c' })], T1);
    const second = pass(first.index, [rec('1', { title: 'a' }), rec('2', { title: 'b changed' }), rec('3', { title: 'c' })], T2);
    expect(second.plan.counts).toMatchObject({ CHANGED: 1, UNCHANGED: 2 });
    expect(second.plan.toRead).toEqual([idOf('2')]);
    expect(second.plan.affectedFactKeys).toEqual(['date:2', 'price:2']);
    expect(second.plan.affectedEntities).toEqual(['ent:2']);
    expect(second.plan.affectedDependents).toEqual(['nbhd:2']);
  });

  it('fingerprints ignore key order and duplicates in a batch are one record', () => {
    expect(fingerprintOf({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(fingerprintOf({ b: [1, { x: 1, y: 2 }], a: 1 }));
    const p = planDelta({ index: emptyDeltaIndex(), batch: [rec('1', 'x'), rec('1', 'x')], parserVersion: P1, now: T1 });
    expect(p.changes).toHaveLength(1);
    // The same record id at another source is another record.
    const q = planDelta({ index: emptyDeltaIndex(), batch: [rec('1', 'x'), rec('1', 'x', 'feed-b')], parserVersion: P1, now: T1 });
    expect(q.counts.NEW).toBe(2);
  });
});

describe('versions', () => {
  it('increase per identity and old versions are kept, never overwritten', () => {
    let { index } = pass(emptyDeltaIndex(), [rec('1', 'v1')], T1);
    index = pass(index, [rec('1', 'v2')], T2).index;
    index = pass(index, [rec('1', 'v3')], T3).index;
    const history = index.records[idOf('1')]!;
    expect(history.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(history.versions.map((v) => v.fingerprint)).toEqual([fingerprintOf('v1'), fingerprintOf('v2'), fingerprintOf('v3')]);
    expect(history.versions[0]!.factKeys).toEqual(['date:1', 'price:1']);
    expect(history.versions[0]!.seenAt).toBe(T1);
  });

  it('planning does not modify the index it was given', () => {
    const { index } = pass(emptyDeltaIndex(), [rec('1', 'v1')], T1);
    const before = JSON.stringify(index);
    planDelta({ index, batch: [rec('1', 'v2')], parserVersion: P1, now: T2 });
    expect(JSON.stringify(index)).toBe(before);
  });
});

describe('established entity mappings', () => {
  it('survive a delta pass unless the record that set them changed', () => {
    let { index } = pass(emptyDeltaIndex(), [rec('1', 'v1'), rec('2', 'v1')], T1);
    expect(index.entityMappings['acme-1']).toMatchObject({ entityId: 'ent:1', setBy: idOf('1') });
    // Another record claiming the same name does not move an established mapping.
    const plan = planDelta({ index, batch: [rec('2', 'v2')], parserVersion: P1, now: T2 });
    index = commitReadings(plan.index, [{ identity: idOf('2'), parserVersion: P1, factKeys: [], entityMappings: { 'acme-1': 'ent:OTHER' } }], T2);
    expect(index.entityMappings['acme-1']).toMatchObject({ entityId: 'ent:1', setBy: idOf('1'), setAt: T1 });
    // An unchanged pass keeps it as it was.
    index = pass(index, [rec('1', 'v1')], T3).index;
    expect(index.entityMappings['acme-1']).toMatchObject({ entityId: 'ent:1', setAt: T1 });
    // The record that set it changed and its new reading resolves the name differently: reopened.
    const changed = planDelta({ index, batch: [rec('1', 'v2')], parserVersion: P1, now: T3 });
    index = commitReadings(changed.index, [{ identity: idOf('1'), parserVersion: P1, factKeys: [], entityMappings: { 'acme-1': 'ent:NEW' } }], T3);
    expect(index.entityMappings['acme-1']).toMatchObject({ entityId: 'ent:NEW', setBy: idOf('1'), setAt: T3 });
  });
});

describe('tested parsing methods', () => {
  it('a parser version change re-reads only the records that parser read', () => {
    let { index } = pass(emptyDeltaIndex(), [rec('1', 'a'), rec('2', 'b')], T1, 'parser/1');
    index = pass(index, [rec('3', 'c')], T2, 'parser/2').index;
    expect(recordsReadByOtherParser(index, 'parser/2')).toEqual([idOf('1'), idOf('2')]);
    const plan = planDelta({ index, batch: [rec('1', 'a'), rec('2', 'b'), rec('3', 'c')], parserVersion: 'parser/2', now: T3 });
    expect(plan.counts).toMatchObject({ REPARSE: 2, UNCHANGED: 1, CHANGED: 0, NEW: 0 });
    expect(plan.toRead).toEqual([idOf('1'), idOf('2')]);
    // Re-reading keeps the version; it is the same content.
    expect(plan.changes.filter((c) => c.status === 'REPARSE').every((c) => c.version === 1)).toBe(true);
    expect(plan.affectedFactKeys).toEqual(['date:1', 'date:2', 'price:1', 'price:2']);
  });
});

describe('serialization', () => {
  it('the index round-trips through JSON and a foreign value reads as empty', () => {
    const { index } = pass(emptyDeltaIndex(), [rec('1', { title: 'a' })], T1);
    const back = readDeltaIndex(JSON.parse(JSON.stringify(index)));
    expect(back).toEqual(index);
    expect(planDelta({ index: back, batch: [rec('1', { title: 'a' })], parserVersion: P1, now: T2 }).counts.UNCHANGED).toBe(1);
    expect(readDeltaIndex({ schema: 'other' })).toEqual(emptyDeltaIndex());
    expect(readDeltaIndex(null)).toEqual(emptyDeltaIndex());
  });
});

/*
 * Repair: the whole carried index was written into every append-only extraction row
 * (up to 5000 histories with every version and the batch-wide dependents on each), so
 * each pass permanently wrote another full copy. A pass now writes only its slice, and
 * the next pass folds the recent slices back into the index.
 */
describe('a pass writes its slice of the index, never the whole of it', () => {
  /** One pass over `batch` against `index`, every record read, with `dependents` per record. */
  const pass = (index: DeltaIndex, batch: SourceRecord[], now: string, dependents: (id: string) => string[] = () => []) => {
    const plan = planDelta({ index, batch, parserVersion: P1, now });
    const next = commitReadings(
      plan.index,
      plan.toRead.map((identity) => ({ identity, parserVersion: P1, factKeys: [`k:${identity}`], entities: [`e:${identity}`], dependents: dependents(identity), entityMappings: { [`n:${identity}`]: `ent:${identity}` } })),
      now,
    );
    return { plan, next, slice: sliceOf(next, plan.changes.map((c) => c.identity)) };
  };

  it('a slice is bounded by the batch, not by the index or a record\'s history', () => {
    // An index already at the cap, as the reviewer simulated it: 5000 records with 8 fact keys and 40 dependents each.
    let index = emptyDeltaIndex();
    const big = Array.from({ length: 5000 }, (_, i) => rec(`r${i}`, { v: 1 }));
    const fortyDependents = (identity: string) => Array.from({ length: 40 }, (_, j) => `hood:${identity}:${j}`);
    index = pass(index, big, T1, fortyDependents).next;
    const fullSize = JSON.stringify(index).length;

    // One record changed three times: the index keeps its versions within the pass, the slice only the latest.
    let state = index;
    for (const [n, at] of [[2, T2], [3, T3]] as const) state = pass(state, [rec('r1', { v: n })], at).next;
    expect(state.records[idOf('r1')]!.versions.map((v) => v.version)).toEqual([1, 2, 3]);

    const { slice } = pass(state, [rec('r1', { v: 4 }), rec('r2', { v: 1 }), rec('new', { v: 1 })], '2026-11-17T03:00:00.000Z');
    expect(Object.keys(slice.records).sort()).toEqual([idOf('new'), idOf('r1'), idOf('r2')].sort());
    for (const history of Object.values(slice.records)) expect(history.versions).toHaveLength(1);
    expect(slice.records[idOf('r1')]!.versions[0]!.version).toBe(4);
    // Only the mappings the named records set.
    expect(Object.values(slice.entityMappings).every((m) => m.setBy in slice.records)).toBe(true);
    // Three records: orders of magnitude below the full index the row used to carry.
    expect(JSON.stringify(slice).length * 100).toBeLessThan(fullSize);
  });

  it('folding the recent slices classifies exactly as the carried index did', () => {
    const p1 = pass(emptyDeltaIndex(), [rec('a', { t: 1 }), rec('b', { t: 1 })], T1);
    const p2 = pass(foldSlices([p1.slice], 5000), [rec('c', { t: 1 }), rec('a', { t: 2 })], T2);
    const folded = foldSlices([p2.slice, p1.slice], 5000);
    // The newest slice wins for a record both name.
    expect(folded.records[idOf('a')]!.versions[0]!.version).toBe(2);
    expect(Object.keys(folded.records).sort()).toEqual([idOf('a'), idOf('b'), idOf('c')].sort());
    expect(folded.entityMappings[`n:${idOf('b')}`]).toMatchObject({ setBy: idOf('b') });
    const third = planDelta({ index: folded, batch: [rec('a', { t: 2 }), rec('b', { t: 1 }), rec('c', { t: 9 }), rec('d', {})], parserVersion: P1, now: T3 });
    expect(Object.fromEntries(third.changes.map((c) => [c.identity, c.status]))).toEqual({
      [idOf('a')]: 'UNCHANGED',
      [idOf('b')]: 'UNCHANGED',
      [idOf('c')]: 'CHANGED',
      [idOf('d')]: 'NEW',
    });
    // A changed record still recomputes what its previous version produced.
    expect(third.affectedFactKeys).toEqual([`k:${idOf('c')}`]);
  });

  it('a fold keeps at most the cap, newest first, and skips what is not a slice', () => {
    const older = pass(emptyDeltaIndex(), [rec('x', 1), rec('y', 1)], T1).slice;
    const newer = pass(emptyDeltaIndex(), [rec('z', 1)], T2).slice;
    const folded = foldSlices([newer, { schema: 'other' }, null, older], 2);
    expect(Object.keys(folded.records).sort()).toEqual([idOf('x'), idOf('z')].sort());
    expect(Object.values(folded.entityMappings).every((m) => m.setBy in folded.records)).toBe(true);
  });
});
