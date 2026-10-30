import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { combineSignals, type SignalMember } from '../server/services/signals/combine.ts';

const m = (id: string, kind: string, subject: string, origin: 'DETECTOR' | 'TRIGGER' = 'TRIGGER'): SignalMember =>
  ({ id, origin, kind, subjectKind: 'ORGANISATION', subject, at: null });

describe('combineSignals', () => {
  it('turns expansion + hiring for one organisation into one SIGNAL', () => {
    const r = combineSignals([m('a', 'EXPANSION', 'Acme Foods, Inc.'), m('b', 'HIRING', 'ACME FOODS LLC', 'DETECTOR')]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ pattern: 'EXPANSION_HIRING', label: 'SIGNAL', subjectKey: 'acme foods' });
    expect(r.results[0]!.possibleNeed).toBeTruthy();
    expect(r.results[0]!.qualifiers.join(' ')).toMatch(/does not establish that anyone would pay/);
  });
  it('uses the largest pattern and does not also emit its subset', () => {
    const r = combineSignals([m('a', 'EXPANSION', 'Acme'), m('b', 'HIRING', 'Acme'), m('c', 'SUPPLY_SHORTAGE', 'Acme')]);
    expect(r.results.map((x) => x.pattern)).toEqual(['EXPANSION_HIRING_SUPPLY']);
  });
  it('never merges different organisations or combines repeats of one kind', () => {
    expect(combineSignals([m('a', 'EXPANSION', 'Acme'), m('b', 'HIRING', 'Apex')]).results).toEqual([]);
    expect(combineSignals([m('a', 'HIRING', 'Acme'), m('b', 'HIRING', 'Acme')]).results).toEqual([]);
    expect(combineSignals([m('a', 'HIRING', 'Acme'), m('a', 'EXPANSION', 'Acme')]).results).toEqual([]);
  });
  it('skips unnamed subjects', () => {
    const r = combineSignals([m('a', 'EXPANSION', ''), m('b', 'HIRING', '')]);
    expect(r.results).toEqual([]);
    expect(r.skipped).toBe(2);
  });
  it('reports an unfamiliar shape once, not a guessed pattern', () => {
    const r = combineSignals([
      m('a', 'COMPLAINTS', 'One'), m('b', 'COMPETITOR_MOVE', 'One'),
      m('c', 'COMPLAINTS', 'Two'), m('d', 'COMPETITOR_MOVE', 'Two'),
    ]);
    expect(r.results).toEqual([]);
    expect(r.unfamiliar).toHaveLength(1);
    expect(r.unfamiliar[0]).toMatchObject({ shape: 'COMPETITOR_MOVE+COMPLAINTS', subjects: ['one', 'two'] });
  });
  it('is deterministic regardless of input order', () => {
    const rows = [m('a', 'EXPANSION', 'Acme'), m('b', 'HIRING', 'Acme'), m('c', 'FUNDING', 'Zed'), m('d', 'HIRING', 'Zed')];
    const x = combineSignals(rows); const y = combineSignals([...rows].reverse());
    expect(y.results).toEqual(x.results);
  });
  it('processes 1000 records by code with zero model jobs, and measures it', () => {
    const rows: SignalMember[] = [];
    for (let i = 0; i < 500; i++) {
      rows.push(m(`e${i}`, 'EXPANSION', `Company ${i}`), m(`h${i}`, 'HIRING', `Company ${i}`, 'DETECTOR'));
    }
    const r = combineSignals(rows);
    expect(r.considered).toBe(1000);
    expect(r.results).toHaveLength(500);
    expect(r.modelJobs).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.elapsedMs).toBeLessThan(5000);
  });
  it('imports no model provider', () => {
    const src = readFileSync('server/services/signals/combine.ts', 'utf8');
    expect(src).not.toMatch(/providers\/|cheap\/|anthropic/i);
  });
});
