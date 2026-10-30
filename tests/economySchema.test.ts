/**
 * The goal engine's tables and repositories: evidence rules, user scoping,
 * supersession instead of overwrite, and reconsideration by indexed key.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { currentVariables, listEdgesAt, recordEdge, recordVariable, retireEdge } from '../server/repos/economy.ts';
import {
  addCondition, addPossibilityEdge, createPossibility, getPossibility, listCombinedSignals,
  listMeasurements, listPossibilities, reconsiderOnChange, recordCombinedSignal, recordMeasurement,
  transitionPossibility,
} from '../server/repos/signals.ts';

let projectId = '';
let alice = '';
let bob = '';

async function user(name: string): Promise<string> {
  return (await createUser({
    email: `${name}-${Math.random().toString(36).slice(2, 10)}@example.com`,
    displayName: name,
    password: 'a-long-enough-password',
    isBrainAdmin: false,
  })).id;
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  alice = await user('alice');
  bob = await user('bob');
});

describe('economic edges and variables', () => {
  it('requires a claim for VERIFIED and a basis for ESTIMATE, and is idempotent', async () => {
    const base = { projectId, ownerUserId: alice, fromKind: 'NODE', fromId: 'a', toKind: 'ACTIVITY', toId: 'b', relation: 'SUPPLIES' } as const;
    await expect(recordEdge({ ...base, status: 'VERIFIED' })).rejects.toThrow(/claim/);
    await expect(recordEdge({ ...base, status: 'ESTIMATE' })).rejects.toThrow(/basis/);
    const first = await recordEdge({ ...base, status: 'ESTIMATE', basis: 'two suppliers named in a trade note' });
    const again = await recordEdge({ ...base, status: 'UNKNOWN' });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.edge.id).toBe(first.edge.id);
  });

  it('the database refuses a VERIFIED row with no claim even around the repository', async () => {
    await expect(getDb().run(
      `INSERT INTO economic_edges (id, project_id, from_kind, from_id, to_kind, to_id, relation, status, created_at)
       VALUES ('x', ?, 'NODE', 'a', 'NODE', 'b', 'REQUIRES', 'VERIFIED', 'now')`, [projectId],
    )).rejects.toThrow();
  });

  it('scopes reads: private rows only to their owner, ownerless rows to everyone', async () => {
    await recordEdge({ projectId, ownerUserId: alice, fromKind: 'NODE', fromId: 'n', toKind: 'NODE', toId: 'p', relation: 'BUYS_FROM', status: 'UNKNOWN' });
    await recordEdge({ projectId, ownerUserId: null, fromKind: 'NODE', fromId: 'n', toKind: 'NODE', toId: 'q', relation: 'ENABLES', status: 'UNKNOWN' });
    expect((await listEdgesAt(projectId, alice, 'n')).map((e) => e.toId).sort()).toEqual(['p', 'q']);
    expect((await listEdgesAt(projectId, bob, 'n')).map((e) => e.toId)).toEqual(['q']);
  });

  it('retires an edge without deleting it', async () => {
    const { edge } = await recordEdge({ projectId, ownerUserId: null, fromKind: 'NODE', fromId: 'n', toKind: 'NODE', toId: 'z', relation: 'COMPETES', status: 'UNKNOWN' });
    expect(await retireEdge(projectId, edge.id)).toBe(true);
    expect(await retireEdge(projectId, edge.id)).toBe(false);
    expect(await listEdgesAt(projectId, alice, 'n')).toEqual([]);
    expect(await getDb().all('SELECT id FROM economic_edges WHERE id = ?', [edge.id])).toHaveLength(1);
  });

  it('a new variable reading supersedes the old one and keeps it', async () => {
    const v = { projectId, ownerUserId: null, activityId: 'act', name: 'margin', unit: 'ratio', operatorKind: 'ESTABLISHED_OPERATOR' } as const;
    await recordVariable({ ...v, valueNumber: 0.2, status: 'ESTIMATE', basis: 'guess' });
    await recordVariable({ ...v, valueNumber: 0.3, status: 'VERIFIED', sourceClaimId: 'clm_1' });
    await recordVariable({ ...v, operatorKind: 'REPRODUCIBLE_BY_NEW_OPERATOR', valueNumber: 0.1, status: 'ESTIMATE', basis: 'new entrant' });
    const current = await currentVariables(projectId, alice, 'act');
    expect(current.map((c) => [c.operatorKind, c.valueNumber])).toEqual([
      ['ESTABLISHED_OPERATOR', 0.3], ['REPRODUCIBLE_BY_NEW_OPERATOR', 0.1],
    ]);
    expect(await getDb().all('SELECT id FROM activity_variables WHERE activity_id = ?', ['act'])).toHaveLength(3);
  });

  it('an UNKNOWN variable carries no value and a known one must', async () => {
    await recordVariable({ projectId, ownerUserId: null, activityId: 'a2', name: 'refund_rate', status: 'UNKNOWN', operatorKind: 'ESTABLISHED_OPERATOR' });
    await expect(recordVariable({ projectId, ownerUserId: null, activityId: 'a2', name: 'margin', status: 'ESTIMATE', basis: 'b', operatorKind: 'ESTABLISHED_OPERATOR' })).rejects.toThrow();
    await expect(recordVariable({ projectId, ownerUserId: null, activityId: 'a2', name: 'margin', valueNumber: NaN, status: 'ESTIMATE', basis: 'b', operatorKind: 'ESTABLISHED_OPERATOR' })).rejects.toThrow(/finite/);
  });
});

describe('combined signals', () => {
  it('needs two detections, is always a SIGNAL, and is idempotent per pattern', async () => {
    const base = { projectId, ownerUserId: null, subjectKind: 'ORGANISATION', subjectKey: '  Acme  Co ', patternKey: 'expansion+hiring' } as const;
    await expect(recordCombinedSignal({ ...base, memberDetectionIds: ['d1'] })).rejects.toThrow(/two/);
    const first = await recordCombinedSignal({ ...base, memberDetectionIds: ['d2', 'd1'], captureMethods: ['staffing'] });
    const again = await recordCombinedSignal({ ...base, subjectKey: 'acme co', memberDetectionIds: ['d1', 'd2'] });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(first.signal.label).toBe('SIGNAL');
    expect(first.signal.memberDetectionIds).toEqual(['d1', 'd2']);
    await expect(getDb().run(
      `UPDATE combined_signals SET label = 'CONFIRMED_DEMAND' WHERE id = ?`, [first.signal.id],
    )).rejects.toThrow();
    expect(await listCombinedSignals(projectId, bob)).toHaveLength(1);
  });
});

describe('the possibility store', () => {
  it('keeps possibilities private to their owner', async () => {
    const p = await createPossibility({ projectId, ownerUserId: alice, title: 'Mobile detailing', requirements: { capital: '$2k', skills: ['driving'] } });
    expect(await getPossibility(projectId, bob, p.id)).toBeNull();
    expect(await listPossibilities(projectId, bob)).toEqual([]);
    expect((await listPossibilities(projectId, alice))[0]?.requirements.skills).toEqual(['driving']);
  });

  it('edges need two owned possibilities, are idempotent, and refuse a self-loop', async () => {
    const a = await createPossibility({ projectId, ownerUserId: alice, title: 'A' });
    const b = await createPossibility({ projectId, ownerUserId: alice, title: 'B' });
    const c = await createPossibility({ projectId, ownerUserId: bob, title: 'C' });
    const first = await addPossibilityEdge({ projectId, ownerUserId: alice, fromId: a.id, toId: b.id, relation: 'UNLOCKS_AFTER' });
    const again = await addPossibilityEdge({ projectId, ownerUserId: alice, fromId: a.id, toId: b.id, relation: 'UNLOCKS_AFTER' });
    expect([first.created, again.created]).toEqual([true, false]);
    await expect(addPossibilityEdge({ projectId, ownerUserId: alice, fromId: a.id, toId: a.id, relation: 'REQUIRES' })).rejects.toThrow();
    await expect(addPossibilityEdge({ projectId, ownerUserId: alice, fromId: a.id, toId: c.id, relation: 'REQUIRES' })).rejects.toThrow(/owns/);
  });

  it('reconsiders by indexed key, once per ref, only for the owner, and never moves adopted work', async () => {
    const a = await createPossibility({ projectId, ownerUserId: alice, title: 'A' });
    const b = await createPossibility({ projectId, ownerUserId: alice, title: 'B' });
    const other = await createPossibility({ projectId, ownerUserId: bob, title: 'C' });
    for (const p of [a, b]) await addCondition({ projectId, ownerUserId: alice, possibilityId: p.id, conditionKey: 'CAPITAL_CHANGED' });
    await addCondition({ projectId, ownerUserId: bob, possibilityId: other.id, conditionKey: 'CAPITAL_CHANGED' });
    await transitionPossibility({ projectId, ownerUserId: alice, id: b.id, from: 'KEPT', to: 'ADOPTED' });

    const moved = await reconsiderOnChange({ projectId, ownerUserId: alice, conditionKey: 'CAPITAL_CHANGED', changeRef: 'cap-1' });
    expect(moved).toEqual([a.id]);
    expect((await getPossibility(projectId, alice, a.id))!.state).toBe('RECONSIDER');
    expect((await getPossibility(projectId, alice, b.id))!.state).toBe('ADOPTED');
    expect((await getPossibility(projectId, bob, other.id))!.state).toBe('KEPT');
    expect(await reconsiderOnChange({ projectId, ownerUserId: alice, conditionKey: 'CAPITAL_CHANGED', changeRef: 'cap-1' })).toEqual([]);
  });

  it('transitions are guarded on the state moved from', async () => {
    const a = await createPossibility({ projectId, ownerUserId: alice, title: 'A' });
    expect(await transitionPossibility({ projectId, ownerUserId: alice, id: a.id, from: 'RETIRED', to: 'KEPT' })).toBe(false);
    expect(await transitionPossibility({ projectId, ownerUserId: bob, id: a.id, from: 'KEPT', to: 'RETIRED' })).toBe(false);
  });
});

describe('stage measurements', () => {
  it('derives duration, refuses bad counts, and reads only the owner\'s', async () => {
    const m = await recordMeasurement({
      projectId, ownerUserId: alice, goalId: 'g1', stage: 'CODE_SCREEN',
      startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:02.500Z', screened: 40, rejected: 31, advanced: 9,
    });
    expect(m.durationMs).toBe(2500);
    await expect(recordMeasurement({ projectId, ownerUserId: alice, goalId: 'g1', stage: 'EXECUTION', startedAt: '2026-10-30T10:00:00.000Z', screened: -1 })).rejects.toThrow();
    expect(await listMeasurements(projectId, alice, 'g1')).toHaveLength(1);
    expect(await listMeasurements(projectId, bob, 'g1')).toEqual([]);
  });
});
