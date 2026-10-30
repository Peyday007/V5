/**
 * Goal-engine schema: evidence-backed economic variables, private rows that
 * never cross users, a possibility store reopened by indexed condition keys,
 * and measurements that distinguish not-measured from zero.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  edgesFrom, edgesTo, recordEconomicEdge, recordStageMeasurement, setActivityVariable, stageMeasurements, variablesFor,
} from '../server/repos/economy.ts';
import {
  combinedSignalsFor, conditionsFor, keepPossibility, linkPossibilities, listPossibilities, meetCondition,
  possibilityEdgesFor, recordCombinedSignal,
} from '../server/repos/signals.ts';

const P = 'prj_a';
const alice = { projectId: P, userId: 'usr_a' };
const bob = { projectId: P, userId: 'usr_b' };
const other = { projectId: 'prj_b', userId: 'usr_a' };

beforeEach(async () => {
  await freshProject();
});

describe('economic edges and variables', () => {
  it('requires a claim to be VERIFIED and a basis to be an ESTIMATE', async () => {
    const base = { projectId: P, fromKind: 'NODE', fromRef: 'n1', relation: 'SUPPLIES', toKind: 'ACTIVITY', toRef: 'a1', operatorKind: 'ESTABLISHED_OPERATOR' } as const;
    await expect(recordEconomicEdge({ ...base, status: 'VERIFIED' })).rejects.toThrow(/claim/);
    await expect(recordEconomicEdge({ ...base, status: 'ESTIMATE', basis: ' ' })).rejects.toThrow(/basis/);
    const edge = await recordEconomicEdge({ ...base, status: 'VERIFIED', claimId: 'clm_1' });
    expect((await recordEconomicEdge({ ...base, status: 'UNKNOWN' })).id).toBe(edge.id);
    expect((await edgesFrom(alice, 'NODE', 'n1')).length).toBe(1);
    expect((await edgesTo(alice, 'ACTIVITY', 'a1')).length).toBe(1);
    expect(await edgesFrom(other, 'NODE', 'n1')).toEqual([]);
  });

  it('keeps the database CHECK behind the repository', async () => {
    await expect(getDb().run(
      `INSERT INTO economic_edges (id, project_id, from_kind, from_ref, relation, to_kind, to_ref, status, operator_kind, created_at)
       VALUES ('x', 'p', 'NODE', 'a', 'SUPPLIES', 'NODE', 'b', 'VERIFIED', 'ESTABLISHED_OPERATOR', 't')`,
    )).rejects.toThrow();
  });

  it('never lets a weaker reading replace a stronger one, and an UNKNOWN has no value', async () => {
    const v = { projectId: P, activityRef: 'a1', name: 'margin', operatorKind: 'ESTABLISHED_OPERATOR' } as const;
    await expect(setActivityVariable({ ...v, status: 'UNKNOWN', valueNum: 3 })).rejects.toThrow(/no value/);
    expect((await setActivityVariable({ ...v, status: 'ESTIMATE', valueNum: 0.2, basis: 'a trade survey' })).written).toBe(true);
    expect((await setActivityVariable({ ...v, status: 'VERIFIED', valueNum: 0.25, claimId: 'clm_9', unit: 'ratio' })).written).toBe(true);
    const weaker = await setActivityVariable({ ...v, status: 'ESTIMATE', valueNum: 0.9, basis: 'a guess' });
    expect(weaker.written).toBe(false);
    expect(weaker.variable.valueNum).toBeCloseTo(0.25);
    expect(weaker.variable.status).toBe('VERIFIED');
  });

  it('keeps an established operator and a new operator apart', async () => {
    const v = { projectId: P, activityRef: 'a1', name: 'conversion', status: 'ESTIMATE', basis: 'b' } as const;
    await setActivityVariable({ ...v, operatorKind: 'ESTABLISHED_OPERATOR', valueNum: 0.3 });
    await setActivityVariable({ ...v, operatorKind: 'REPRODUCIBLE_BY_NEW_OPERATOR', valueNum: 0.05 });
    expect((await variablesFor(alice, 'a1')).map((x) => x.valueNum)).toEqual([0.3, 0.05]);
  });

  it("never shows one user's private rows to another", async () => {
    await setActivityVariable({ projectId: P, ownerUserId: 'usr_a', activityRef: 'a1', name: 'secret', status: 'ESTIMATE', basis: 'mine', valueNum: 1, operatorKind: 'ESTABLISHED_OPERATOR' });
    await setActivityVariable({ projectId: P, activityRef: 'a1', name: 'shared', status: 'ESTIMATE', basis: 'ours', valueNum: 2, operatorKind: 'ESTABLISHED_OPERATOR' });
    expect((await variablesFor(alice, 'a1')).map((x) => x.name)).toEqual(['secret', 'shared']);
    expect((await variablesFor(bob, 'a1')).map((x) => x.name)).toEqual(['shared']);
    expect((await variablesFor({ projectId: P, userId: null }, 'a1')).map((x) => x.name)).toEqual(['shared']);
    expect(await variablesFor(other, 'a1')).toEqual([]);
  });
});

describe('combined signals', () => {
  it('is one row per combination, always a SIGNAL', async () => {
    const input = { projectId: P, subjectKind: 'ORGANISATION' as const, subjectKey: 'acme', comboKey: 'acme:expansion+hiring', detectionIds: ['d2', 'd1'], captureMethods: ['supply'] };
    const a = await recordCombinedSignal(input);
    const b = await recordCombinedSignal(input);
    expect(b.id).toBe(a.id);
    expect(a.label).toBe('SIGNAL');
    expect(a.detectionIds).toEqual(['d1', 'd2']);
    expect((await combinedSignalsFor(alice, 'ORGANISATION', 'acme')).length).toBe(1);
    await expect(getDb().run(`UPDATE combined_signals SET label = 'CONFIRMED_DEMAND' WHERE id = ?`, [a.id])).rejects.toThrow();
  });
});

describe('the possibility store', () => {
  it('reopens what waits on a condition key once, by key, and no other', async () => {
    const a = await keepPossibility({ projectId: P, title: 'A', kind: 'venture', requirements: { capitalCents: 500000, skills: ['welding'] }, conditions: { 'CAPITAL:raised': 'capital reaches 5k' } });
    const b = await keepPossibility({ projectId: P, title: 'B', kind: 'service', conditions: { 'CAPABILITY:welding': 'welding acquired' } });
    expect(a.requirements).toEqual({ capitalCents: 500000, skills: ['welding'] });
    const hit = await meetCondition({ projectId: P, conditionKey: 'CAPITAL:raised', changeRef: 'c1' });
    expect(hit.map((h) => h.possibilityId)).toEqual([a.id]);
    expect(await meetCondition({ projectId: P, conditionKey: 'CAPITAL:raised', changeRef: 'c2' })).toEqual([]);
    expect(await meetCondition({ projectId: 'prj_b', conditionKey: 'CAPABILITY:welding', changeRef: 'c3' })).toEqual([]);
    expect((await listPossibilities(alice, 'RECONSIDERING')).map((p) => p.id)).toEqual([a.id]);
    expect((await listPossibilities(alice, 'KEPT')).map((p) => p.id)).toEqual([b.id]);
    expect((await conditionsFor(alice, a.id))[0]?.metChangeRef).toBe('c1');
  });

  it('chains possibilities only through ones the viewer can read', async () => {
    const mine = await keepPossibility({ projectId: P, ownerUserId: 'usr_a', title: 'mine', kind: 'op' });
    const shared = await keepPossibility({ projectId: P, title: 'shared', kind: 'op' });
    expect(await linkPossibilities(alice, mine.id, shared.id, 'ENABLES')).toBe(true);
    expect(await linkPossibilities(alice, mine.id, shared.id, 'ENABLES')).toBe(false);
    expect(await linkPossibilities(bob, mine.id, shared.id, 'UNLOCKS_AFTER')).toBe(false);
    expect(await linkPossibilities(alice, mine.id, mine.id, 'REQUIRES')).toBe(false);
    expect((await possibilityEdgesFor(alice, shared.id)).length).toBe(1);
    expect(await possibilityEdgesFor(bob, shared.id)).toEqual([]);
    expect((await listPossibilities(bob)).map((p) => p.title)).toEqual(['shared']);
    expect(await conditionsFor(bob, mine.id)).toEqual([]);
  });
});

describe('stage measurements', () => {
  it('keeps not-measured as null and measured zero as zero', async () => {
    await recordStageMeasurement({ projectId: P, goalId: 'g', stage: 'CODE_SCREEN', screened: 40, rejected: 0 });
    const [m] = await stageMeasurements(alice, 'g', 'CODE_SCREEN');
    expect(m?.rejected).toBe(0);
    expect(m?.durationMs).toBeNull();
    expect(m?.premiumJobs).toBeNull();
    expect(await stageMeasurements(other, 'g')).toEqual([]);
    await expect(getDb().run(
      `INSERT INTO stage_measurements (id, project_id, goal_id, stage, recorded_at) VALUES ('z', 'p', 'g', 'GUESSING', 't')`,
    )).rejects.toThrow();
  });
});
