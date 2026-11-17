import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectForDeepening, type DeepeningCandidate } from '../server/services/knowledge/deepening.ts';

const routine = (i: number): DeepeningCandidate => ({ id: `r${i}`, decisionValue: 5, uncertainty: 0.02, novelty: 0, statement: `routine link ${i}` });
const valuable = (i: number): DeepeningCandidate => ({ id: `v${i}`, decisionValue: 1000 * (i + 1), uncertainty: 0.6, novelty: 0.5 });

describe('selectForDeepening promotes by value of information within capacity', () => {
  it('with fixed capacity promotes only the highest-VOI candidates, up to capacity', () => {
    const cands = [...Array.from({ length: 6 }, (_, i) => valuable(i)), ...Array.from({ length: 50 }, (_, i) => routine(i))];
    const r = selectForDeepening(cands, { capacity: 3, costPerDeepening: 10 });
    const promoted = r.decisions.filter((d) => d.promote).map((d) => d.id).sort();
    expect(promoted).toEqual(['v3', 'v4', 'v5']);
    expect(r.promoted).toBe(3);
    expect(r.threshold).not.toBeNull();
  });

  it('routine, certain, low-value candidates are never promoted however many and however much capacity', () => {
    const cands = Array.from({ length: 10_000 }, (_, i) => routine(i));
    const r = selectForDeepening(cands, { capacity: 10_000, costPerDeepening: 10 });
    expect(r.promoted).toBe(0);
    expect(r.threshold).toBeNull();
    expect(r.decisions.every((d) => d.reasons.some((x) => x.includes('cost of deepening')))).toBe(true);
  });

  it('more capacity promotes more and lowers the threshold; less promotes fewer and raises it', () => {
    const cands = Array.from({ length: 10 }, (_, i) => valuable(i));
    const low = selectForDeepening(cands, { capacity: 2 });
    const mid = selectForDeepening(cands, { capacity: 5 });
    const high = selectForDeepening(cands, { capacity: 9 });
    expect([low.promoted, mid.promoted, high.promoted]).toEqual([2, 5, 9]);
    expect(low.threshold!).toBeGreaterThan(mid.threshold!);
    expect(mid.threshold!).toBeGreaterThan(high.threshold!);
    expect(selectForDeepening(cands, { capacity: 0 }).promoted).toBe(0);
  });

  it('a recorded contradiction and novelty raise priority over an otherwise equal candidate', () => {
    const base = { decisionValue: 1000, uncertainty: 0.3, novelty: 0 };
    const r = selectForDeepening(
      [
        { id: 'plain', ...base },
        { id: 'contradicted', ...base, contradicted: true },
        { id: 'novel', ...base, novelty: 0.4 },
      ],
      { capacity: 1 },
    );
    expect(r.decisions.find((d) => d.promote)?.id).toBe('contradicted');
  });

  it('candidates differing only in wording get the same decision, even at the capacity edge', () => {
    const nums = { decisionValue: 500, uncertainty: 0.5, novelty: 0.2 };
    const a = { id: 'a', ...nums, statement: 'Acme Corp buys widgets in Ohio' };
    const b = { id: 'b', ...nums, statement: 'Widgets are purchased by ACME Corporation (OH)' };
    const top = { id: 'top', decisionValue: 10_000, uncertainty: 0.9, novelty: 1 };
    for (const capacity of [1, 2, 3, 5]) {
      const r = selectForDeepening([top, a, b], { capacity });
      const da = r.decisions.find((d) => d.id === 'a')!;
      const db = r.decisions.find((d) => d.id === 'b')!;
      expect(da.promote).toBe(db.promote);
      expect(da.score).toBe(db.score);
    }
  });

  it('every decision carries reasons naming its value, threshold and capacity', () => {
    const r = selectForDeepening([valuable(0), valuable(1), routine(0)], { capacity: 1, costPerDeepening: 10 });
    for (const d of r.decisions) {
      expect(d.reasons.length).toBeGreaterThanOrEqual(3);
      expect(d.reasons[0]).toMatch(/expected value of information/);
    }
    expect(r.decisions.find((d) => d.promote)!.reasons.at(-1)).toMatch(/threshold .*capacity 1/);
    expect(r.decisions.find((d) => d.id === 'v0')!.reasons.at(-1)).toMatch(/below the capacity-derived threshold/);
  });

  it('the decision reads no keyword or category list', () => {
    const src = readFileSync(new URL('../server/services/knowledge/deepening.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.statement/);
    expect(code).not.toMatch(/keyword|category|industry|whitelist|allowlist|RegExp|\.includes\(|\.test\(/i);
  });
});
