/**
 * The construction cap is deterministic and evidence-first (P4, 2026-11-18).
 *
 * Production, goal wst_7b4fcbb5f2384f31b6c3: 400 of ~16,000 candidate
 * arrangements were composed a pass, the plan's leader swapped among seven
 * arrangements over 38 readings, and a five-week-old arrangement led the first
 * time it was weighed. What is proved here:
 *   * a candidate whose buyers carry observed or verified evidence — a price,
 *     a run cost from an accepted claim — is always composed, wherever the
 *     existing rank would have put it;
 *   * the goal's leader is composed on every pass, and two passes that learned
 *     nothing new compose the same ranked set;
 *   * the rotation slots reach every candidate within considered / slots passes;
 *   * the leaders are read back from the goal's own readings.
 */
import { describe, expect, it } from 'vitest';
import {
  arrangementSignature,
  forEachCandidate,
  MAX_CONSTRUCTIONS,
  ROTATION_SLOTS,
  selectCandidates,
  type Candidate,
  type ConstructionJob,
  type Primitive,
} from '../server/services/cash/construct.ts';
import type { Observation } from '../server/domain/quant.ts';
import { freshProject } from './helpers.ts';
import { recentLeaderSignatures, recordArrangementEvaluations, recordConstructedArrangements } from '../server/repos/monetization.ts';

const p = (name: string, claimId: string | null = null): Primitive => ({ name, claimId, from: 'INDUSTRY_MAP', ref: `ref:${name}`, path: `NODE:${name.toLowerCase()}` });
const limits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: null, capitalBeforeProofCents: null, bestReachCents: null };
const sig = (one: Candidate) => arrangementSignature(one.design, one.demand, one.need, one.supply);

/** Four buyer populations in two sectors, ten needs and ten suppliers each: thousands of candidates against a cap of 400. */
function job(extra: Partial<ConstructionJob> = {}, size = 10): ConstructionJob {
  const needs = Array.from({ length: size }, (_, i) => p(`need ${i}`));
  const supply = Array.from({ length: size }, (_, i) => p(`supplier ${i}`));
  return {
    sectors: [
      { name: 'services', demand: [p('buyer a'), p('buyer b')], needs, supply },
      { name: 'trades', demand: [p('buyer c'), p('late buyer')], needs, supply },
    ],
    opportunities: [],
    precedent: [],
    capability: null,
    priced: [],
    tiedUp: [],
    input: { projectId: 'p', currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, limits },
    limits,
    targets: [],
    exclusions: [],
    now: new Date('2026-11-18T00:00:00Z'),
    ...extra,
  };
}

const observation = (id: string, payer: string): Observation => ({
  id,
  value: { kind: 'POINT', value: 900 },
  context: { payer, industry: 'trades', arrangement: 'held' },
  lineage: [`claim:${id}`],
  source: { kind: 'CLAIM', ref: id },
  measures: 'fixed_cost_per_run: a run',
});

/** One pass's library write: every composed candidate is stored with this pass's time (as `rememberArrangements` sets `last_composed_at`). */
function remember(known: Map<string, { verdict: null; p50: number; composedAt: string }>, selected: readonly Candidate[], at: string): void {
  for (const one of selected) known.set(sig(one), { verdict: null, p50: 0, composedAt: at });
}

describe('the construction cap is evidence-first', () => {
  it('always composes candidates whose buyers hold observed or verified evidence', () => {
    const plain = selectCandidates(job());
    expect(plain.considered).toBeGreaterThan(MAX_CONSTRUCTIONS * 4);
    // Without evidence, the late buyer's run-cost designs are mostly cut.
    const late = (sel: readonly Candidate[]) => sel.filter((one) => one.demand.name === 'late buyer');
    const total = plain.considered;
    expect(late(plain.selected).length).toBeLessThan(total / 4);

    // A run cost research filed from an accepted claim about the late buyer (fact fixed_cost_per_run): every one of its
    // candidates up to the evidenced share of the cap is composed, ahead of the unevidenced rank.
    const evidenced = selectCandidates(job({ facts: { unitCost: [], volume: [], runCost: [observation('fact:run', 'late buyer')] } }));
    const lateCount = total / 4;
    // The evidenced share of the cap is all theirs; rotation may compose more of them, never fewer.
    expect(evidenced.evidenced).toBeGreaterThanOrEqual(Math.min(lateCount, MAX_CONSTRUCTIONS - ROTATION_SLOTS));
    expect(late(evidenced.selected).length).toBeGreaterThanOrEqual(evidenced.evidenced);
    expect(evidenced.evidencedCut).toBe(lateCount - evidenced.evidenced);

    // A small evidenced population is composed whole, wherever the rank puts it: a published price on a held opening.
    const small = job({ priced: [observation('opp:priced', 'late buyer')] });
    small.sectors[1] = { ...small.sectors[1]!, needs: small.sectors[1]!.needs.slice(0, 1), supply: small.sectors[1]!.supply.slice(0, 1) };
    const smallSelection = selectCandidates(small);
    const lateSmall = late(smallSelection.selected);
    expect(smallSelection.evidencedCut).toBe(0);
    expect(lateSmall.length).toBe(smallSelection.evidenced);
    expect(lateSmall.length).toBeGreaterThan(0);
    // ...and they lead the selection, before the unevidenced rank.
    expect(smallSelection.selected.slice(0, lateSmall.length).every((one) => one.demand.name === 'late buyer')).toBe(true);
  });

  it('holds the goal\'s leader on every pass, and two passes with no new evidence compose the same ranked set', () => {
    const known = new Map<string, { verdict: null; p50: number; composedAt: string }>();
    const first = selectCandidates(job({ known: [...known.entries()] }));
    remember(known, first.selected, '2026-11-18T00:00:00.000Z');
    // The plan led with a candidate neither the rank nor this pass's rotation reached (found weeks ago, as mpx_e6ed1e7dbbe54c08a26d was).
    const probe = selectCandidates(job({ known: [...known.entries()] }));
    const seen = new Set([...first.selected, ...probe.selected].map(sig));
    const all: Candidate[] = [];
    forEachCandidate(job(), (one) => all.push(one));
    const outside = all.filter((one) => !seen.has(sig(one)));
    expect(outside.length).toBeGreaterThan(0);
    const leader = sig(outside[outside.length - 1]!);

    const passes: string[][] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const at = `2026-11-18T0${pass + 1}:00:00.000Z`;
      const selection = selectCandidates(job({ known: [...known.entries()], held: [leader] }));
      expect(selection.selected.map(sig)).toContain(leader);
      expect(selection.selected[0] && sig(selection.selected[0])).toBe(leader);
      expect(selection.held).toBe(1);
      passes.push(selection.selected.slice(0, MAX_CONSTRUCTIONS - ROTATION_SLOTS).map(sig));
      remember(known, selection.selected, at);
    }
    // Nothing new was learned between passes: the held, evidenced and ranked slots are identical; only rotation moves.
    expect(passes[1]).toEqual(passes[0]);
    expect(passes[2]).toEqual(passes[1]);
    // And the same inputs select the same candidates, in the same order.
    const again = selectCandidates(job({ known: [...known.entries()], held: [leader] }));
    expect(again.selected.map(sig)).toEqual(selectCandidates(job({ known: [...known.entries()], held: [leader] })).selected.map(sig));
  });

  it('reaches every candidate within considered / ROTATION_SLOTS passes, by rotation rather than a draw', () => {
    const known = new Map<string, { verdict: null; p50: number; composedAt: string }>();
    const composed = new Set<string>();
    const { considered } = selectCandidates(job({}, 6));
    const bound = Math.ceil((considered - (MAX_CONSTRUCTIONS - ROTATION_SLOTS)) / ROTATION_SLOTS) + 1;
    let passes = 0;
    while (composed.size < considered && passes <= bound) {
      const at = new Date(Date.UTC(2026, 10, 18, 0, passes * 10)).toISOString();
      const selection = selectCandidates(job({ known: [...known.entries()] }, 6));
      expect(selection.selected).toHaveLength(MAX_CONSTRUCTIONS);
      expect(selection.rotated).toBe(ROTATION_SLOTS);
      expect(selection.neverComposed).toBe(considered - composed.size);
      for (const one of selection.selected) composed.add(sig(one));
      remember(known, selection.selected, at);
      passes += 1;
    }
    expect(composed.size).toBe(considered);
    expect(passes).toBeLessThanOrEqual(bound);
    // After every candidate was composed once, rotation turns to the one composed longest ago.
    const next = selectCandidates(job({ known: [...known.entries()] }, 6));
    const rotated = next.selected.slice(MAX_CONSTRUCTIONS - ROTATION_SLOTS);
    const oldest = [...known.values()].map((one) => one.composedAt).sort()[0]!;
    expect(rotated.some((one) => known.get(sig(one))!.composedAt === oldest)).toBe(true);
  });
});

describe('the leaders are read from the goal\'s own readings', () => {
  it('returns what the last two readings picked or led with, and nothing older', async () => {
    const { project } = await freshProject();
    const record = (n: number) => ({
      signature: `sig_${n}`,
      legacyKey: `00000000000${n}`,
      method: 'BROKERAGE' as const,
      title: `arrangement ${n}`,
      thesis: null,
      constructionOrigin: 'FORWARD' as const,
      opportunityId: null,
      industryNodeId: null,
      precedentOpportunityId: null,
      inputsDigest: `d${n}`,
      designJson: '{}',
      positionJson: null,
      positionKey: null,
    });
    await recordConstructedArrangements(project.id, 'wst_goal', [1, 2, 3, 4, 5, 6].map(record));
    const read = (readingId: string, at: string, entries: Array<[number, boolean, number | null]>) =>
      recordArrangementEvaluations({
        projectId: project.id,
        goalId: 'wst_goal',
        readingId,
        at,
        entries: entries.map(([n, picked, cents]) => ({ legacyKey: `00000000000${n}`, picked, refused: false, contributionCents: cents })),
      });
    // An old reading led with 1; the two latest led with 2 (picked) and 3 (picked), 4 contributed most in the latest.
    await read('gpr_old', '2026-11-17T00:00:00.000Z', [[1, true, 900_000]]);
    await read('gpr_prev', '2026-11-18T00:00:00.000Z', [[2, true, 500_000], [5, false, 1]]);
    await read('gpr_now', '2026-11-18T01:00:00.000Z', [[3, true, 400_000], [4, false, 800_000], [5, false, 2], [6, false, null]]);
    const leaders = await recentLeaderSignatures('wst_goal', 2, 1);
    expect(leaders).toEqual(['sig_2', 'sig_3', 'sig_4']);
    expect(await recentLeaderSignatures('wst_other')).toEqual([]);
  });
});
