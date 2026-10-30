import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createNode } from '../server/repos/industry.ts';
import {
  currentVariables, edgesAround, keepPossibility, linkPossibilities, listPossibilities,
  recordEconomicEdge, recordStageMeasurement, recordVariable, stageMeasurements, triggerCondition,
  watchCondition, watchersOf,
} from '../server/repos/economy.ts';
import { recordCombinedSignal, signalsForNode } from '../server/repos/signals.ts';

let projectId = '';
let userId = '';
let otherUserId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const mk = async (n: string) =>
    (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: n, password: 'correct horse battery staple' })).id;
  userId = await mk('one');
  otherUserId = await mk('two');
});

describe('economic edges and variables', () => {
  it('refuses a status its evidence does not support, and is idempotent by identity', async () => {
    const base = { projectId, fromKind: 'ACTIVITY', fromRef: 'a', toKind: 'ACTIVITY', toRef: 'b', relation: 'SUPPLIES', operatorKind: 'ESTABLISHED_OPERATOR' } as const;
    await expect(recordEconomicEdge({ ...base, status: 'VERIFIED' })).rejects.toThrow(/claim/);
    await expect(recordEconomicEdge({ ...base, status: 'ESTIMATE' })).rejects.toThrow(/basis/);
    const first = await recordEconomicEdge({ ...base, status: 'ESTIMATE', basis: 'operator interview' });
    const again = await recordEconomicEdge({ ...base, status: 'ESTIMATE', basis: 'operator interview' });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.edge.id).toBe(first.edge.id);
    expect((await edgesAround(projectId, 'b'))).toHaveLength(1);
  });

  it('refuses a database row that skips the check, and keeps unknown valueless', async () => {
    await expect(getDb().run(
      `INSERT INTO economic_edges (id, project_id, from_kind, from_ref, to_kind, to_ref, relation, status, operator_kind, created_at)
       VALUES ('x', ?, 'NODE', 'a', 'NODE', 'b', 'REQUIRES', 'VERIFIED', 'ESTABLISHED_OPERATOR', 'now')`, [projectId])).rejects.toThrow();
    await expect(recordVariable({ projectId, activityRef: 'a', name: 'margin', value: 3, status: 'UNKNOWN', operatorKind: 'ESTABLISHED_OPERATOR' })).rejects.toThrow(/no value/);
  });

  it('keeps the latest reading per variable and operator kind, and history', async () => {
    const o = { projectId, activityRef: 'a', name: 'upfront capital', unit: 'cents', status: 'ESTIMATE', basis: 'quote' } as const;
    await recordVariable({ ...o, value: 100, operatorKind: 'ESTABLISHED_OPERATOR' });
    await recordVariable({ ...o, value: 200, operatorKind: 'ESTABLISHED_OPERATOR' });
    await recordVariable({ ...o, value: 900, operatorKind: 'REPRODUCIBLE_BY_NEW_OPERATOR' });
    await recordVariable({ projectId, activityRef: 'a', name: 'refund rate', value: null, status: 'UNKNOWN', operatorKind: 'ESTABLISHED_OPERATOR' });
    const current = await currentVariables(projectId, 'a');
    expect(current).toHaveLength(3);
    expect(current.find((v) => v.name === 'upfront capital' && v.operatorKind === 'ESTABLISHED_OPERATOR')!.value).toBe(200);
    expect(current.find((v) => v.name === 'refund rate')!.value).toBeNull();
  });
});

describe('combined signals', () => {
  it('is labelled SIGNAL, needs two detections, and is idempotent', async () => {
    const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Freight', origin: 'SEED' });
    const input = { projectId, subjectKind: 'ORGANISATION' as const, subjectKey: '  Acme  Freight ', pattern: 'EXPANSION_HIRING', memberDetectionIds: ['d2', 'd1'], industryNodeId: node.node.id, captureMethods: ['supply staffing'] };
    await expect(recordCombinedSignal({ ...input, memberDetectionIds: ['d1'] })).rejects.toThrow();
    const a = await recordCombinedSignal(input);
    const b = await recordCombinedSignal(input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.signal.label).toBe('SIGNAL');
    expect(a.signal.subjectKey).toBe('acme freight');
    expect(a.signal.memberDetectionIds).toEqual(['d1', 'd2']);
    expect(await signalsForNode(projectId, node.node.id)).toHaveLength(1);
    await expect(getDb().run(`UPDATE combined_signals SET label = 'DEMAND'`)).rejects.toThrow();
  });
});

describe('the possibility store', () => {
  it('is scoped by owner, keeps edges, and reconsiders once per watch by indexed key', async () => {
    const req = { capital: ['$500'], skills: ['driving'] };
    const a = await keepPossibility({ projectId, ownerUserId: userId, kind: 'OPPORTUNITY', title: 'Courier run', requirements: req, sourceRef: 'opp:1' });
    const dup = await keepPossibility({ projectId, ownerUserId: userId, kind: 'OPPORTUNITY', title: 'Courier run', requirements: req, sourceRef: 'opp:1' });
    expect(dup.created).toBe(false);
    expect(dup.possibility.id).toBe(a.possibility.id);
    const b = await keepPossibility({ projectId, ownerUserId: userId, kind: 'VENTURE', title: 'Courier firm', requirements: {} });
    await keepPossibility({ projectId, ownerUserId: otherUserId, kind: 'ACTIVITY', title: 'Private', requirements: {} });
    expect((await listPossibilities(projectId, userId)).map((p) => p.title)).toEqual(['Courier run', 'Courier firm']);
    expect(await listPossibilities(projectId, otherUserId)).toHaveLength(1);
    expect(a.possibility.requirements.capital).toEqual(['$500']);

    const edge = await linkPossibilities({ projectId, fromId: a.possibility.id, toId: b.possibility.id, relation: 'UNLOCKS_AFTER' });
    expect(edge.relation).toBe('UNLOCKS_AFTER');
    await expect(linkPossibilities({ projectId, fromId: a.possibility.id, toId: a.possibility.id, relation: 'REQUIRES' })).rejects.toThrow();

    const w = await watchCondition({ projectId, possibilityId: a.possibility.id, conditionKey: 'CAPITAL_CHANGED' });
    const w2 = await watchCondition({ projectId, possibilityId: a.possibility.id, conditionKey: 'CAPITAL_CHANGED' });
    expect(w2.id).toBe(w.id);
    expect(await watchersOf(projectId, 'CAPITAL_CHANGED')).toHaveLength(1);
    expect(await triggerCondition(w.id, 'capital@1')).toBe(true);
    expect(await triggerCondition(w.id, 'capital@2')).toBe(false);
    expect(await watchersOf(projectId, 'CAPITAL_CHANGED')).toHaveLength(0);
  });
});

describe('stage measurements', () => {
  it('records per goal and stage, scoped to the owner', async () => {
    const m = { projectId, ownerUserId: userId, goalId: 'g1', stage: 'CODE_SCREEN', durationMs: 1200, screened: 50, rejected: 40, advanced: 10, researchJobs: 0, premiumAiJobs: 0 } as const;
    await recordStageMeasurement(m);
    await expect(recordStageMeasurement({ ...m, durationMs: -1 })).rejects.toThrow();
    expect(await stageMeasurements(projectId, userId, 'g1')).toHaveLength(1);
    expect(await stageMeasurements(projectId, otherUserId, 'g1')).toHaveLength(0);
  });
});
