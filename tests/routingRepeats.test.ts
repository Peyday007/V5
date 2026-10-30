import { describe, expect, it } from 'vitest';
import type { RoutingDecision } from '../server/repos/workRouting.ts';
import { compareToBaseline, emitCandidates, findRepeatedShapes, REPEAT_THRESHOLD } from '../server/services/routing/repeats/repeats.ts';

let n = 0;
const dec = (o: Partial<RoutingDecision> = {}): RoutingDecision => ({
  id: `d${++n}`, projectId: 'p1', workKind: 'parse-notice', workRef: null, resource: 'STRONG', reasons: [], alternatives: [],
  reusedResultId: null, failureClass: null, escalatedFrom: null, outcome: null, validationResult: null, general: false,
  createdAt: '2026-10-01T00:00:00.000Z', settledAt: null, ...o });
const many = (k: number, o: Partial<RoutingDecision> = {}) => Array.from({ length: k }, () => dec(o));

describe('repeated AI work', () => {
  it('counts same-shape model runs and proposes a conversion candidate, never an activation', () => {
    const out = findRepeatedShapes('p1', [...many(REPEAT_THRESHOLD), ...many(2, { workKind: 'rare' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workKind: 'parse-notice', aiRuns: REPEAT_THRESHOLD, status: 'PROPOSED', activate: false });
  });
  it('does not count code runs or reused results, nor another project', () => {
    const rows = [...many(4), ...many(10, { resource: 'CODE' }), ...many(10, { reusedResultId: 'r' }), ...many(10, { projectId: 'p2' })];
    expect(findRepeatedShapes('p1', rows)).toEqual([]);
  });
  it('emits each candidate through the sink once; no sink emits nothing', async () => {
    const cands = findRepeatedShapes('p1', many(6));
    const seen = new Set<string>();
    const sink = async (c: { workKind: string }) => (seen.has(c.workKind) ? 'DUPLICATE' as const : (seen.add(c.workKind), 'EMITTED' as const));
    expect((await emitCandidates(cands, sink)).emitted).toBe(1);
    expect((await emitCandidates(cands, sink)).duplicates).toBe(1);
    expect((await emitCandidates(cands, null)).emitted).toBe(0);
  });
  it('code-first uses fewer Claude assignments with no pass-rate drop', () => {
    const base = { jobs: 20, claudeAssignments: 20, verificationPassed: 18, verificationTotal: 20 };
    expect(compareToBaseline(base, { ...base, claudeAssignments: 4 })).toMatchObject({ claudeSaved: 16, improved: true });
    expect(compareToBaseline(base, { ...base, claudeAssignments: 4, verificationPassed: 15 }).improved).toBe(false);
  });
  it('reports UNKNOWN for unlike workloads or missing verification', () => {
    const base = { jobs: 20, claudeAssignments: 20, verificationPassed: 18, verificationTotal: 20 };
    expect(compareToBaseline(base, { ...base, jobs: 10, claudeAssignments: 1 })).toMatchObject({ improved: false });
    expect(compareToBaseline(base, { ...base, verificationTotal: 0 }).unknown).toMatch(/UNKNOWN/);
  });
});
