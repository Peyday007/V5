/**
 * The 2026-11-09 $10K plan's claims, held by the model that produced them
 * (docs/CASH-10K-PLAN-2026-11-09.md, fast-cash/10k/plan-model-2026-11-09.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINES, MEASURED, NOV9, STRATEGIES, simulate, summarize, wilsonLower } from '../fast-cash/10k/plan-model-2026-11-09.ts';

const doc = readFileSync(new URL('../docs/CASH-10K-PLAN-2026-11-09.md', import.meta.url), 'utf8');

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

describe('the 2026-11-09 $10K plan', () => {
  it('searches several industries, models and structures, and records why each excluded one is out', () => {
    const rows = doc.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.filter((l) => /\| No/.test(l)).every((l) => /No[:,]? \S/.test(l))).toBe(true);
    for (const word of ['broker', 'produce', 'pool', 'subcontract', 'arbitrage']) expect(doc.toLowerCase()).toContain(word);
  });

  it('uses several revenue lines, and its lines fail together through shared factors', () => {
    expect(LINES.length).toBeGreaterThanOrEqual(4);
    const best = STRATEGIES.find((s) => s.key === 'gift_lead')!;
    const worlds = simulate({ ...best, shares: { gift: 0.5, ai: 0.5 } }, NOV9, 4000);
    const correlated = pearson(worlds.map((w) => w.byLine['gift']!), worlds.map((w) => w.byLine['ai']!));
    const naive = simulate({ ...best, shares: { gift: 0.5, ai: 0.5 } }, NOV9, 4000, 7, true);
    const independent = pearson(naive.map((w) => w.byLine['gift']!), naive.map((w) => w.byLine['ai']!));
    expect(correlated).toBeGreaterThan(0.15);
    expect(correlated).toBeGreaterThan(independent);
  });

  it('keeps the goal limits: nothing over $375 before proof, owner does no physical work', () => {
    for (const s of STRATEGIES) {
      expect(s.ads).toBeLessThanOrEqual(375);
      expect(Object.values(s.shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
    expect(doc).toMatch(/\$375 per arrangement before proof, \$750 a week tied up,\s+\$3,000 in all/);
    expect(doc).toContain('No physical work by the owner');
  });

  it('does not claim 90%: on measured rates no strategy comes near it, and the doc says NOT ACCEPTED', () => {
    for (const s of STRATEGIES) {
      const r = summarize(s, MEASURED, 4000);
      expect(wilsonLower(Math.round(r.reachGross * 4000), 4000)).toBeLessThan(0.9);
      expect(r.reachGross).toBeLessThan(0.05);
    }
    expect(doc).toContain('**NOT ACCEPTED. The evidence does not support 90%.**');
    expect(doc).toMatch(/What would raise confidence/);
  });

  it('puts the soonest cash first: the lead line has the earliest-paying, largest-ticket structure', () => {
    const lead = STRATEGIES[0]!;
    const top = Object.entries(lead.shares).sort((a, b) => b[1] - a[1])[0]![0];
    expect(top).toBe('gift');
    expect(LINES.find((l) => l.key === 'gift')!.settled[0]).toBeGreaterThanOrEqual(0.85);
  });

  it('tracks every dollar from opportunity to settlement, with every stage named', () => {
    for (const stage of ['Opportunity', 'Contacted', 'Replied', 'Quoted / invoiced', 'Paid', 'Settled', 'Out: supplier cost']) expect(doc).toContain(`| ${stage}`);
  });
});
