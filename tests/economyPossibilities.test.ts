import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { linkPossibilities, listPossibilities, watchersOf } from '../server/repos/economy.ts';
import {
  CHANGE_KEYS, chains, keepScreened, knowledgeForLaterGoal, myPossibilities, ownerEdges,
  reachOf, reconsiderOnChange, researchOrder,
} from '../server/services/economy/possibilities/index.ts';
import type { Principal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let otherId = '';
const mk = async (n: string) =>
  (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: n, password: 'correct horse battery staple' })).id;

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = await mk('one');
  otherId = await mk('two');
});

const keep = (title: string, requirements: Record<string, string[]>, limits = { capitalLimitCents: 100_000, deadlineDays: 30 }, owner = userId) =>
  keepScreened({ projectId, ownerUserId: owner, kind: 'OPPORTUNITY', title, requirements, sourceRef: `s:${title}:${owner}`, limits });

describe('screening in code', () => {
  it('rejects over-limit capital and late payment naming the limit, and holds on missing facts', async () => {
    const cap = await keep('Big', { capital: ['$5,000'], time: ['paid in 10 days'] });
    expect(cap.screen.verdict).toBe('REJECT');
    expect(cap.screen.reason).toMatch(/limit of 100000/);
    const late = await keep('Slow', { capital: ['$200'], time: ['paid in 60 days'] });
    expect(late.screen.verdict).toBe('REJECT');
    expect(late.screen.reason).toMatch(/deadline of 30/);
    const hold = await keep('Unknown', { capital: ['$200'] });
    expect(hold.screen.verdict).toBe('HOLD');
    expect(hold.screen.reason).toMatch(/payment timing/);
    expect(cap.deepJobsLaunched).toBe(0);
    expect((await listPossibilities(projectId, userId))).toHaveLength(3);
  });
});

describe('reconsideration', () => {
  it('raising the capital limit touches only the capital watchers, once, with no scan', async () => {
    const big = await keep('Big', { capital: ['$5,000'], time: ['paid in 10 days'] });
    await keep('Slow', { capital: ['$200'], time: ['paid in 60 days'] });
    await keep('Big2', { capital: ['$9,000'], time: ['paid in 10 days'] });
    await keep('Elsewhere', { capital: ['$5,000'], time: ['paid in 10 days'] }, undefined, otherId);
    const raised = { capitalLimitCents: 600_000, deadlineDays: 30 };
    const r = await reconsiderOnChange({ projectId, ownerUserId: userId, key: CHANGE_KEYS.capital, changeRef: 'cap@1', limits: raised });
    expect(r.rowsTouched).toBe(3);
    expect(r.reopened.map((x) => x.possibilityId)).toEqual([big.possibility.id]);
    expect(r.stillParked).toHaveLength(1);
    const again = await reconsiderOnChange({ projectId, ownerUserId: userId, key: CHANGE_KEYS.capital, changeRef: 'cap@1', limits: raised });
    expect(again.reopened).toHaveLength(0);
    const kept = (await listPossibilities(projectId, userId)).find((p) => p.id === big.possibility.id)!;
    expect(kept.parkedReason).toBeNull();
    // the other owner's watch is untouched
    expect((await watchersOf(projectId, CHANGE_KEYS.capital)).length).toBeGreaterThan(0);
  });
});

describe('reach, research order and chains', () => {
  it('defers zero reach while stronger unexplored candidates remain, and derives chains', async () => {
    const a = (await keep('cash op', {})).possibility.id;
    const b = (await keep('recurring service', {})).possibility.id;
    const c = (await keep('venture', {})).possibility.id;
    const z = (await keep('isolated', {})).possibility.id;
    await linkPossibilities({ projectId, fromId: a, toId: b, relation: 'UNLOCKS_AFTER' });
    await linkPossibilities({ projectId, fromId: b, toId: c, relation: 'ENABLES' });
    const edges = await ownerEdges(projectId, userId);
    expect(reachOf(a, edges)).toBe(2);
    expect(reachOf(z, edges)).toBe(0);
    expect(chains(edges)).toEqual([[a, b, c]]);
    const order = researchOrder([a, b, c, z], edges, new Set());
    expect(order.next).toEqual([a, b]);
    expect([...order.deferredZeroReach].sort()).toEqual([z, c].sort());
    // once the stronger ones are explored, the rest may be
    const later = researchOrder([a, b, c, z], edges, new Set([a, b]));
    expect(later.next).toContain(z);
    expect(await ownerEdges(projectId, otherId)).toEqual([]);
  });
});

describe('isolation', () => {
  const person = (id: string, type: 'HUMAN' | 'WORKER' = 'HUMAN') =>
    ({ type, id, isBrainAdmin: false, memberships: [{ projectId, role: 'MEMBER', active: true, scopes: ['project:read'] }] }) as unknown as Principal;
  it('keeps private rows private and refuses a worker', async () => {
    await keep('mine', {});
    await keep('theirs', {}, undefined, otherId);
    expect((await myPossibilities(person(userId), projectId))!.map((p) => p.title)).toEqual(['mine']);
    expect(await myPossibilities(person(userId, 'WORKER'), projectId)).toBeNull();
    expect(await knowledgeForLaterGoal(person(userId, 'WORKER'), projectId)).toBeNull();
    expect(Array.isArray(await knowledgeForLaterGoal(person(userId), projectId))).toBe(true);
    expect(await getDb().get('SELECT 1 AS x')).toBeTruthy();
  });
});
