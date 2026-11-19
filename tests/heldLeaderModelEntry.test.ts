/**
 * A held leader reaches the model, not only the construction (P4, 2026-11-19).
 *
 * Production, goal wst_7b4fcbb5f2384f31b6c3, release 1a4ea56e (#1123): the
 * readings at 02:52Z and 03:23Z led with "homeowner: Brain produces it and
 * charges a fee" (arr_19a99390e28b, reach 55.3%, p50 $16,939). After the
 * release the construction reported "4 held as the plan's leaders, 336 on
 * observed or verified evidence", and the plan led with a 24.5% arrangement.
 * Holding a leader through the construction cap does not hold it in the model:
 * `selectEstimatedArrangements` admits 12 of the ~400 composed, on a screen
 * that saturates at the remaining amount, so the tie is decided by evidence
 * tier, observation count and the constructor's order — by which other
 * arrangements were composed. 336 evidenced arrangements outrank a leader on
 * that tie, the leader is cut before the engine sees it, gets no evaluation row
 * in the reading, and two readings later is no longer held at all.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { LEADER_SLOTS, MAX_ESTIMATED_ARRANGEMENTS, selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import { recordReadingEvaluations, rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';
import { clearConstructionMemo, constructArrangements } from '../server/services/cash/construct.ts';
import { createNode } from '../server/repos/industry.ts';
import { listConstructedArrangements } from '../server/repos/monetization.ts';
import { freshProject } from './helpers.ts';

function arrangement(key: string, over: { p50: number; tier: string; observations: number; base?: 'PRODUCE' | 'BROKER'; leader?: boolean }): ConstructedArrangement {
  const base = over.base ?? 'BROKER';
  return {
    key,
    structure: base,
    design: { base, funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'services',
    demand: { name: `buyers of ${key}`, claimId: null, from: 'EVENT_GRAPH', ref: `hyp_${key}`, path: `GRAPH_BUYER:${key}` },
    need: null,
    supply: null,
    label: `Arrangement ${key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: { tier: over.tier, p10: over.p50 / 2, p50: over.p50, p90: over.p50 * 2, observations: over.observations },
    unknownParts: ['buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    signature: `sig_${key}`,
    inputsDigest: `in_${key}`,
    ...(over.leader ? { leader: true } : {}),
  } as ConstructedArrangement;
}

const input = { projectId: 'prj_x', currency: 'USD', beforeProofCents: 37_500, remaining: 10_000, exclusions: [], daysLeft: 30 };
const admitted = (arrangements: ConstructedArrangement[]) => selectEstimatedArrangements(arrangements, input).selection.picked.map((one) => one.arrangementKey);

describe('a held leader reaches the model', () => {
  // The leader: a strong design whose screen saturates at the remaining amount, on a component price.
  const leader = (held: boolean) => arrangement('homeowner', { p50: 3_000, tier: 'COMPONENT', observations: 4, base: 'PRODUCE', leader: held });
  // The pass before the release: few competitors, all weaker.
  const before = Array.from({ length: 20 }, (_, i) => arrangement(`weak${i}`, { p50: 40, tier: 'COMPONENT', observations: 4 }));
  // After it: many evidenced designs of the same structure, each saturating the same screen on a better-evidenced price.
  const evidenced = Array.from({ length: 30 }, (_, i) => arrangement(`evid${String(i).padStart(2, '0')}`, { p50: 3_000, tier: 'DIRECT', observations: 20, base: 'PRODUCE' }));

  it('reproduces the drop: a leader the model admitted is cut once other composed arrangements tie it on the saturated screen', () => {
    expect(admitted([leader(false), ...before])).toContain('homeowner');
    const after = admitted([...evidenced, leader(false)]);
    expect(after).toHaveLength(MAX_ESTIMATED_ARRANGEMENTS);
    expect(after).not.toContain('homeowner');
  });

  it('holds it: a leader takes one of the first slots whatever else was composed', () => {
    const after = selectEstimatedArrangements([...evidenced, leader(true)], input).selection;
    expect(after.picked.map((one) => one.arrangementKey)).toContain('homeowner');
    expect(after.picked.find((one) => one.arrangementKey === 'homeowner')!.slot).toBe('LEADER');
    expect(after.picked).toHaveLength(MAX_ESTIMATED_ARRANGEMENTS);
    // The leader slots are bounded: leaders never crowd the model's diversity out.
    const many = Array.from({ length: 10 }, (_, i) => arrangement(`lead${i}`, { p50: 3_000, tier: 'COMPONENT', observations: 4, leader: true }));
    const crowded = selectEstimatedArrangements([...evidenced, ...many], input).selection.picked;
    expect(crowded.filter((one) => one.slot === 'LEADER')).toHaveLength(LEADER_SLOTS);
  });

  it('is never stored: whether it led is per goal and per pass, so the library row does not change', async () => {
    const { project } = await freshProject();
    await rememberArrangements(project.id, 'wst_goal', [leader(false)], '2026-11-19T00:00:00.000Z');
    const [plain] = await listConstructedArrangements(project.id);
    expect(await rememberArrangements(project.id, 'wst_goal', [leader(true)], '2026-11-19T01:00:00.000Z')).toEqual({ created: 0, updated: 0, unchanged: 1 });
    const [stored] = await listConstructedArrangements(project.id);
    expect(stored!.design['arrangement']).toEqual(plain!.design['arrangement']);
    expect((stored!.design['arrangement'] as Record<string, unknown>)['leader']).toBeUndefined();
  });

  it('round trip: what a stored reading picked comes back marked as the leader on the next construction', async () => {
    const { project } = await freshProject();
    const root = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Home improvement', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'homeowner', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'landlords', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: root.node.id, kind: 'FULFILMENT_SOURCE', name: 'roofing contractors', origin: 'SEED' });
    const now = new Date('2026-11-19T03:23:00.000Z');
    const pass = { projectId: project.id, goalId: 'wst_goal', currency: 'USD', delivers: ['business document'], capitalCeilingCents: null, daysLeft: 30, now };
    clearConstructionMemo();
    const first = await constructArrangements(pass);
    expect(first.some((one) => one.leader)).toBe(false);
    await rememberArrangements(project.id, 'wst_goal', first, now.toISOString());
    const homeowner = first.find((one) => one.origin === 'FORWARD' && one.demand.name === 'homeowner')!;
    expect(homeowner).toBeDefined();
    // The stored reading picked it: the evaluation is written by the reading's own opportunity id (arr_<key>).
    await recordReadingEvaluations({
      projectId: project.id,
      goalId: 'wst_goal',
      readingId: 'gpr_0323',
      demand: [{ opportunityId: `arr_${homeowner.key}`, refused: null, revenue: { p50: 16_939 } }],
      picked: new Set([`arr_${homeowner.key}`]),
      prefix: 'arr_',
    });
    clearConstructionMemo();
    const next = await constructArrangements({ ...pass, now: new Date('2026-11-19T05:30:00.000Z') });
    const marked = next.filter((one) => one.leader);
    expect(marked.map((one) => one.signature)).toContain(homeowner.signature);
    expect(marked.every((one) => one.signature === homeowner.signature)).toBe(true);
  });
});
