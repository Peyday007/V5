/**
 * An arrangement Brain produces keeps its identity when an unrelated
 * deliverable is added (2026-11-19, found while fixing P4, #1123/#1125).
 *
 * `arrangementSignature` hashed the capability part's path, and that path was
 * spelt from the project's whole deliverables list
 * (`CAPABILITY:a>b>c`, construct.ts `heldEvidence`). Adding a deliverable that
 * has nothing to do with an arrangement gave every arrangement Brain produces
 * a new signature: the goal's held leaders (`recentLeaderSignatures`) stopped
 * matching, a research verdict stayed on a row nothing composed any more, and
 * the library's reuse missed.
 *
 * Proved here against real rows: the reproduction (a leader stays the leader
 * across the list change), the pure identity, and continuity for what was
 * stored under the old spelling — the row is re-signed in place, so its
 * verdict and the goal's leader carry over, and a refutation reached under the
 * same evidence still holds.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createNode } from '../server/repos/industry.ts';
import { listConstructedArrangements, recordArrangementVerdict } from '../server/repos/monetization.ts';
import { recordReadingEvaluations, refutedUnderSameInputs, rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';
import {
  arrangementSignature,
  BRAIN_CAPABILITY_PATH,
  canonicalSignature,
  capabilityPart,
  clearConstructionMemo,
  constructArrangements,
  type ConstructedArrangement,
  type Primitive,
} from '../server/services/cash/construct.ts';

async function seeded() {
  const { project } = await freshProject();
  const root = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'Home improvement', origin: 'SEED' });
  await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'homeowner', origin: 'SEED' });
  await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'landlords', origin: 'SEED' });
  await createNode({ projectId: project.id, parentId: root.node.id, kind: 'FULFILMENT_SOURCE', name: 'roofing contractors', origin: 'SEED' });
  return project;
}

const pass = (projectId: string, delivers: string[], now: string) => ({ projectId, goalId: 'wst_goal', currency: 'USD', delivers, capitalCeilingCents: null, daysLeft: 30, now: new Date(now) });
const produced = (all: ConstructedArrangement[]) => all.find((one) => one.origin === 'FORWARD' && one.demand.name === 'homeowner' && one.supply?.from === 'CAPABILITY')!;

async function pick(projectId: string, one: ConstructedArrangement, readingId: string): Promise<void> {
  await recordReadingEvaluations({
    projectId,
    goalId: 'wst_goal',
    readingId,
    demand: [{ opportunityId: `arr_${one.key}`, refused: null, revenue: { p50: 16_939 } }],
    picked: new Set([`arr_${one.key}`]),
    prefix: 'arr_',
  });
}

describe("an arrangement Brain produces is identified by the capability it uses, not the deliverables list", () => {
  it('reproduces and fixes the drop: the leader keeps its signature and stays held when an unrelated deliverable is added', async () => {
    const project = await seeded();
    clearConstructionMemo();
    const first = await constructArrangements(pass(project.id, ['business document'], '2026-11-19T03:23:00.000Z'));
    await rememberArrangements(project.id, 'wst_goal', first, '2026-11-19T03:23:00.000Z');
    const leader = produced(first);
    expect(leader).toBeDefined();
    await pick(project.id, leader, 'gpr_0323');

    // An unrelated deliverable joins the list; nothing about the homeowner arrangement changed.
    clearConstructionMemo();
    const next = await constructArrangements(pass(project.id, ['business document', 'market research report'], '2026-11-19T05:30:00.000Z'));
    const same = next.find((one) => one.key === leader.key)!;
    expect(same).toBeDefined();
    expect(same.signature).toBe(leader.signature);
    expect(same.leader).toBe(true);
    expect(next.filter((one) => one.leader).map((one) => one.signature)).toEqual([leader.signature]);
    // And it is one library row, not a second one beside an orphan.
    await rememberArrangements(project.id, 'wst_goal', next, '2026-11-19T05:30:00.000Z');
    expect((await listConstructedArrangements(project.id)).filter((one) => one.legacyKey === leader.key)).toHaveLength(1);
  }, 120_000);

  it('signs the one capability: any deliverables list is the same part, and Brain producing it differs from a named supplier or none', () => {
    const design = { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE_BUYER', repeat: 'ONE_OFF' } as unknown as ConstructedArrangement['design'];
    const demand: Primitive = { name: 'homeowner', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_1', path: 'BUYER_TYPE:home improvement>homeowner' };
    const a = capabilityPart(['business document'])!;
    const b = capabilityPart(['market research report', 'business document'])!;
    expect(a.path).toBe(BRAIN_CAPABILITY_PATH);
    expect(b.name).toBe('market research report, business document');
    expect(arrangementSignature(design, demand, null, a)).toBe(arrangementSignature(design, demand, null, b));
    // A capability stored under the old list spelling signs the same.
    const stored: Primitive = { ...a, path: 'CAPABILITY:business document>spreadsheet' };
    expect(arrangementSignature(design, demand, null, stored)).toBe(arrangementSignature(design, demand, null, a));
    expect(arrangementSignature(design, demand, null, a)).not.toBe(arrangementSignature(design, demand, null, null));
    const supplier: Primitive = { name: 'roofing contractors', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_2', path: 'FULFILMENT_SOURCE:home improvement>roofing contractors' };
    expect(arrangementSignature(design, demand, null, a)).not.toBe(arrangementSignature(design, demand, null, supplier));
    // Only an arrangement Brain produces is re-signed; any other keeps what was stored.
    expect(canonicalSignature('sig_other', { design, demand, need: null, supply: supplier })).toBe('sig_other');
    expect(capabilityPart([])).toBeNull();
  });

  it('carries what was stored under the old spelling: the row is re-signed in place with its verdict, the leader, and a refutation on the same evidence', async () => {
    const project = await seeded();
    const at = '2026-11-19T03:23:00.000Z';
    clearConstructionMemo();
    const composed = await constructArrangements(pass(project.id, ['business document'], at));
    const leader = produced(composed);
    const refuted = composed.find((one) => one !== leader && one.supply?.from === 'CAPABILITY' && one.legacyInputsDigest)!;
    expect(leader.legacyInputsDigest).toBeTruthy();
    expect(refuted).toBeDefined();
    // What the release before this one stored: the list-spelt capability path, its signature and inputs digest.
    const legacy = (one: ConstructedArrangement): ConstructedArrangement => ({
      ...one,
      supply: { ...one.supply!, path: 'CAPABILITY:business document' },
      signature: `legacy_${one.key}`,
      inputsDigest: one.legacyInputsDigest!,
      legacyInputsDigest: undefined,
    } as ConstructedArrangement);
    await rememberArrangements(project.id, 'wst_goal', [legacy(leader), legacy(refuted)], at);
    const before = await listConstructedArrangements(project.id);
    const leaderRow = before.find((one) => one.signature === `legacy_${leader.key}`)!;
    const refutedRow = before.find((one) => one.signature === `legacy_${refuted.key}`)!;
    await recordArrangementVerdict({ pathId: leaderRow.pathId, verdict: 'CONFIRMED', inputsDigest: leaderRow.inputsDigest, roundId: 'cdr_1', at });
    await recordArrangementVerdict({ pathId: refutedRow.pathId, verdict: 'REFUTED', inputsDigest: refutedRow.inputsDigest, roundId: 'cdr_2', at });
    await pick(project.id, leader, 'gpr_0323');

    // The first pass of this release, on the list those rows were stored under.
    clearConstructionMemo();
    const next = await constructArrangements(pass(project.id, ['business document'], '2026-11-19T05:30:00.000Z'));
    await rememberArrangements(project.id, 'wst_goal', next, '2026-11-19T05:30:00.000Z');
    const after = await listConstructedArrangements(project.id);
    const moved = after.find((one) => one.pathId === leaderRow.pathId)!;
    expect(moved.signature).toBe(leader.signature);
    expect(moved.verdict?.verdict).toBe('CONFIRMED');
    expect(moved.evaluatedCount).toBe(1);
    // No second row beside it: the arrangement is one row, under its current signature.
    expect(after.filter((one) => one.legacyKey === leader.key)).toHaveLength(1);
    expect(next.find((one) => one.signature === leader.signature)?.leader).toBe(true);
    // The refutation was reached on the same evidence: it still holds, and is still not asked again.
    const refutedNow = after.find((one) => one.pathId === refutedRow.pathId)!;
    expect(refutedNow.signature).toBe(refuted.signature);
    const recomposed = next.find((one) => one.signature === refuted.signature)!;
    expect(refutedNow.verdict?.inputsDigest).toBe(refutedNow.inputsDigest);
    expect(refutedUnderSameInputs(refutedNow, recomposed)).toBe(true);
    // Nothing transient reached the library row.
    expect((moved.design['arrangement'] as Record<string, unknown>)['legacyInputsDigest']).toBeUndefined();
    // And a second pass writes nothing more: nothing is left under a legacy signature.
    const rows = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM monetization_paths WHERE project_id = ? AND design_signature LIKE 'legacy_%'", [project.id]);
    expect(Number(rows[0]!.n)).toBe(0);

    // Then an unrelated deliverable is added: the leader, its verdict and the refutation all still hold.
    clearConstructionMemo();
    const later = await constructArrangements(pass(project.id, ['business document', 'market research report'], '2026-11-19T07:30:00.000Z'));
    await rememberArrangements(project.id, 'wst_goal', later, '2026-11-19T07:30:00.000Z');
    expect(later.find((one) => one.signature === leader.signature)?.leader).toBe(true);
    const final = await listConstructedArrangements(project.id);
    expect(final.find((one) => one.pathId === leaderRow.pathId)!.verdict?.verdict).toBe('CONFIRMED');
    const stillRefuted = final.find((one) => one.pathId === refutedRow.pathId)!;
    expect(refutedUnderSameInputs(stillRefuted, later.find((one) => one.signature === refuted.signature)!)).toBe(true);
    expect(final).toHaveLength(after.length);
  }, 120_000);
});
