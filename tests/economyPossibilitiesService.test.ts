import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { linkPossibilities, watchersOf } from '../server/repos/economy.ts';
import {
  chainsFrom, reachOf, researchNext, screenPossibility,
} from '../server/services/economy/possibilities/screen.ts';
import {
  keepScreened, reconsiderOnChange, visiblePossibilities, type Actor,
} from '../server/services/economy/possibilities/store.ts';

let projectId = '';
let alice: Actor;
let bob: Actor;
const limits = (capitalLimitCents: number | null) => ({ capitalLimitCents, cashDeadlineDays: 30 });

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const mk = async (n: string) =>
    (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: n, password: 'correct horse battery staple' })).id;
  alice = { type: 'PERSON', userId: await mk('alice') };
  bob = { type: 'PERSON', userId: await mk('bob') };
});

const keep = (actor: Actor, title: string, requirements: Record<string, string[]>, lim = limits(100_000)) =>
  keepScreened({ actor, projectId, ownerUserId: actor.userId, kind: 'OPPORTUNITY', title, requirements, limits: lim });

describe('screening', () => {
  it('rejects over-capital and late-paid in code, naming the limit, with no deep job', async () => {
    const a = await keep(alice, 'Big', { capital: ['ownerCapitalCents:500000'], time: ['paidAfterDays:5'] });
    expect(a.screen.verdict).toBe('REJECT');
    expect(a.screen.launchDeep).toBe(false);
    expect(a.screen.reasons.join(' ')).toContain('100000');
    const b = await keep(alice, 'Slow', { capital: ['ownerCapitalCents:10'], time: ['paidAfterDays:60'] });
    expect(b.screen.verdict).toBe('REJECT');
    expect(b.screen.reasons.join(' ')).toContain('30 days');
  });

  it('holds on a missing fact rather than assuming it', () => {
    const r = screenPossibility({ capital: [] }, limits(100));
    expect(r.verdict).toBe('HOLD');
    expect(r.launchDeep).toBe(false);
  });
});

describe('reconsideration', () => {
  it('raising the capital limit reconsiders exactly the affected, counted by rows touched', async () => {
    const small = await keep(alice, 'Small', { capital: ['ownerCapitalCents:200000'], time: ['paidAfterDays:5'] });
    const huge = await keep(alice, 'Huge', { capital: ['ownerCapitalCents:9000000'], time: ['paidAfterDays:5'] });
    for (let i = 0; i < 20; i++) await keep(alice, `Fine ${i}`, { capital: ['ownerCapitalCents:1'], time: ['paidAfterDays:1'] });
    const r = await reconsiderOnChange({
      projectId, ownerUserId: alice.userId, conditionKey: 'CAPITAL_LIMIT', changeRef: 'chg1', limits: limits(300_000),
    });
    expect(r.rowsTouched).toBe(2);
    expect(r.reconsidered.map((x) => x.possibilityId)).toEqual([small.possibility.id]);
    expect(r.stillBlocked).toEqual([huge.possibility.id]);
    expect((await watchersOf(projectId, 'CAPITAL_LIMIT')).map((w) => w.possibilityId)).toEqual([huge.possibility.id]);
    // replay triggers nothing twice
    const again = await reconsiderOnChange({
      projectId, ownerUserId: alice.userId, conditionKey: 'CAPITAL_LIMIT', changeRef: 'chg1', limits: limits(300_000),
    });
    expect(again.reconsidered).toHaveLength(0);
  });

  it("never reads or touches another owner's possibilities", async () => {
    const mine = await keep(alice, 'Mine', { capital: ['ownerCapitalCents:200000'], time: ['paidAfterDays:5'] });
    await keep(bob, 'Theirs', { capital: ['ownerCapitalCents:200000'], time: ['paidAfterDays:5'] });
    const r = await reconsiderOnChange({
      projectId, ownerUserId: alice.userId, conditionKey: 'CAPITAL_LIMIT', changeRef: 'c', limits: limits(1_000_000),
    });
    expect(r.reconsidered.map((x) => x.possibilityId)).toEqual([mine.possibility.id]);
    expect((await visiblePossibilities(alice, projectId, alice.userId)).map((p) => p.title)).toEqual(['Mine']);
  });

  it('refuses a worker principal and another person', async () => {
    const worker: Actor = { type: 'WORKER', userId: alice.userId };
    await expect(keep(worker, 'x', {})).rejects.toThrow(/nothing here/);
    await expect(visiblePossibilities(bob, projectId, alice.userId)).rejects.toThrow(/nothing here/);
  });
});

describe('graph reads', () => {
  it('derives chains and skips zero reach while stronger candidates remain', async () => {
    const mk = async (t: string) => (await keep(alice, t, { capital: ['ownerCapitalCents:1'], time: ['paidAfterDays:1'] })).possibility;
    const op = await mk('op'); const svc = await mk('service'); const venture = await mk('venture'); const lone = await mk('lone');
    const e1 = await linkPossibilities({ projectId, fromId: op.id, toId: svc.id, relation: 'ENABLES' });
    const e2 = await linkPossibilities({ projectId, fromId: svc.id, toId: venture.id, relation: 'UNLOCKS_AFTER' });
    const edges = [e1, e2];
    expect(chainsFrom(op.id, edges)).toEqual([[op.id, svc.id, venture.id]]);
    expect(reachOf(op.id, edges)).toBe(2);
    expect(reachOf(lone.id, edges)).toBe(0);
    const next = researchNext([op, svc, venture, lone], edges, new Set());
    expect(next).not.toContain(lone.id);
    expect(next[0]).toBe(op.id);
    expect(researchNext([lone], edges, new Set())).toEqual([lone.id]);
  });
});
