/**
 * The reach ordering of the possibility store, driven through the production
 * read (`researchQueue`, which the `npm run goals -- possibilities` door calls)
 * over persisted rows and edges — not through the pure graph helpers alone.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { linkPossibilities, possibilityEdges } from '../server/repos/economy.ts';
import {
  keepScreened, researchQueue, researchQueueLines, type Actor,
} from '../server/services/economy/possibilities/store.ts';

let projectId = '';
let alice: Actor;
let bob: Actor;
const limits = { capitalLimitCents: 100_000, cashDeadlineDays: 30 };

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const mk = async (n: string) =>
    (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: n, password: 'correct horse battery staple' })).id;
  alice = { type: 'PERSON', userId: await mk('alice') };
  bob = { type: 'PERSON', userId: await mk('bob') };
});

const keep = async (actor: Actor, title: string, capital = 1) =>
  (await keepScreened({
    actor, projectId, ownerUserId: actor.userId, kind: 'OPPORTUNITY', title,
    requirements: { capital: [`ownerCapitalCents:${capital}`], time: ['paidAfterDays:1'] }, limits,
  })).possibility;

describe('research queue over the store', () => {
  it('passes over zero reach while stronger candidates remain, strongest first', async () => {
    const op = await keep(alice, 'cash op');
    const svc = await keep(alice, 'recurring service');
    const venture = await keep(alice, 'larger venture');
    const lone = await keep(alice, 'lone');
    await keep(alice, 'too big', 9_000_000); // parked by the screen
    await linkPossibilities({ projectId, fromId: op.id, toId: svc.id, relation: 'ENABLES' });
    await linkPossibilities({ projectId, fromId: svc.id, toId: venture.id, relation: 'UNLOCKS_AFTER' });

    const q = await researchQueue({ actor: alice, projectId, ownerUserId: alice.userId });
    expect(q.next.map((e) => [e.title, e.reach])).toEqual([['cash op', 2], ['recurring service', 1]]);
    expect(q.passedOver.map((e) => e.title).sort()).toEqual(['larger venture', 'lone']);
    expect(q.parked).toBe(1);
    const lines = researchQueueLines(q).join('\n');
    expect(lines).toContain('2 next, 2 passed over');
    expect(lines).toMatch(/waits\s+\S+ reach=0 {2}lone/);

    // Once the stronger ones are explored, zero reach becomes eligible.
    const later = await researchQueue({
      actor: alice, projectId, ownerUserId: alice.userId, explored: new Set([op.id, svc.id]),
    });
    expect(later.next.map((e) => e.title).sort()).toEqual(['larger venture', 'lone']);
    expect(later.passedOver).toEqual([]);
  });

  it("never lends reach from another owner's possibilities, and refuses others", async () => {
    const mine = await keep(alice, 'mine');
    const other = await keep(alice, 'other');
    const theirs = await keep(bob, 'theirs');
    await linkPossibilities({ projectId, fromId: mine.id, toId: theirs.id, relation: 'ENABLES' });
    expect(await possibilityEdges(projectId, alice.userId)).toEqual([]);
    const q = await researchQueue({ actor: alice, projectId, ownerUserId: alice.userId });
    expect(q.next.map((e) => e.reach)).toEqual([0, 0]);
    expect(q.next.map((e) => e.possibilityId).sort()).toEqual([mine.id, other.id].sort());
    await expect(researchQueue({ actor: bob, projectId, ownerUserId: alice.userId })).rejects.toThrow(/nothing here/);
    await expect(researchQueue({ actor: { type: 'WORKER', userId: alice.userId }, projectId, ownerUserId: alice.userId }))
      .rejects.toThrow(/nothing here/);
  });

  it('is reached from the goals terminal door, so the ordering has a production caller', () => {
    const source = fs.readFileSync(new URL('../scripts/goals.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/import \{[^}]*researchQueue[^}]*\} from '\.\.\/server\/services\/economy\/possibilities\/store\.ts'/);
    expect(source).toMatch(/case 'possibilities':\s*return await possibilities\(\);/);
    expect(source).toMatch(/async function possibilities\(\)[\s\S]*?await researchQueue\(/);
  });
});
