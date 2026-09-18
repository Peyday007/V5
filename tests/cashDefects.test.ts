/**
 * The defects an external review found in the first Cash Mode pass.
 *
 * Every test here was written to **fail** against commit `1dd7262`, and each
 * one reproduces a concrete scenario from that review rather than asserting the
 * shape of the fix. They are kept as a suite rather than folded into
 * `cashAuthority` and `cashMoney` because what they have in common is not a
 * module — it is that each of them silently produces a **wrong number or a
 * disclosure** while every surface reads as healthy, which is the failure mode
 * this repository cares about most and the one no passing test noticed.
 *
 * The review's own summary of why that happened is worth keeping: 2,812 passing
 * tests did not establish any of this, because every one of them exercised a
 * single caller on a single account taking a single unrepeated action.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  createAuthority,
  heldCentsForProject,
  revokeAuthority,
} from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  commitSpend,
  recordMoneyEvent,
  settleSpend,
} from '../server/services/cash/opportunities.ts';
import { cashPosition } from '../server/services/cash/money.ts';

let alice = '';
let bob = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  alice = fixture.project.id;
  bob = (await createProject({ name: 'The second private operation' })).id;
  const user = await createUser({
    email: `defect-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function sprint(projectId: string, over: { maxCommittedCents?: number; maxPerActionCents?: number } = {}) {
  await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'grant',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: over.maxCommittedCents ?? 100_000,
    maxPerActionCents: over.maxPerActionCents ?? 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

function spend(projectId: string, key: string, amountCents: number, purpose = 'Remove the missing supplier price') {
  return commitSpend({
    projectId,
    action: 'RUN_PAID_TEST',
    amountCents,
    purpose,
    expectedResult: 'A quotable cost',
    stopCondition: 'Stop after one quote',
    idempotencyKey: key,
    actorRef: userId,
  });
}

function capital(projectId: string, cents: number, key: string) {
  return recordMoneyEvent({
    projectId,
    kind: 'CAPITAL_IN',
    amountCents: cents,
    currency: 'USD',
    idempotencyKey: key,
    actorRef: userId,
  });
}

describe('an idempotency key is one account’s, not the Brain’s', () => {
  it('does not hand account B account A’s commitment when they pick the same key', async () => {
    /*
     * The key was `UNIQUE (idempotency_key)` across the whole table, so the
     * second account's INSERT collided with the first's and the replay branch
     * returned **that row** — a foreign project's amount, purpose, expected
     * result and stop condition, reported as this caller's own success.
     *
     * Two failures in one: account B learns what account A is spending money on,
     * and account B reserves nothing while being told it did.
     */
    await sprint(alice);
    await sprint(bob);
    await capital(alice, 100_000, 'alice-capital');
    await capital(bob, 100_000, 'bob-capital');

    const first = await spend(alice, 'same-key', 20_000, "Alice's private purpose");
    expect(first.ok).toBe(true);

    const second = await spend(bob, 'same-key', 30_000, "Bob's own purpose");
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;

    // Two distinct commitments, in two projects, for two amounts.
    expect(second.value.id).not.toBe(first.value.id);
    expect(second.value.projectId).toBe(bob);
    expect(second.value.amountCents).toBe(30_000);
    expect(second.value.purpose).toBe("Bob's own purpose");

    // And each project holds only its own.
    expect(await heldCentsForProject(alice)).toBe(20_000);
    expect(await heldCentsForProject(bob)).toBe(30_000);
  });
});

describe('a replay observes a finished outcome, never a provisional one', () => {
  it('does not report success for a commitment the same call is about to refuse', async () => {
    /*
     * The row was inserted `HELD` and the ceilings were checked afterwards, so
     * there was a window in which a concurrent retry read the row back and
     * returned "an equivalent commitment already exists" — for money that was
     * released microseconds later. The caller was told yes about a refusal.
     */
    const authority = await sprint(alice, { maxPerActionCents: 40_000 });
    await capital(alice, 200_000, 'alice-capital');

    const [a, b] = await Promise.all([spend(alice, 'race', 45_000), spend(alice, 'race', 45_000)]);

    // Over the per-action ceiling, so neither may succeed — and in particular
    // the replay must not succeed against a row that does not survive.
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(await heldCentsForProject(alice)).toBe(0);
    expect(await heldCentsForProject(authority.projectId)).toBe(0);
  });

  it('agrees with itself when two identical calls race and the commitment is allowed', async () => {
    await sprint(alice);
    await capital(alice, 200_000, 'alice-capital');
    const [a, b] = await Promise.all([spend(alice, 'ok-race', 10_000), spend(alice, 'ok-race', 10_000)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.id).toBe(b.value.id);
    // Committed once, not twice.
    expect(await heldCentsForProject(alice)).toBe(10_000);
  });
});

describe('a commitment must fit the money, not merely avoid a negative balance', () => {
  it('refuses a commitment larger than what is actually deployable', async () => {
    /*
     * The gate asked whether deployable cash was *already* negative, so an
     * account with $100 could commit $400 under a $1,000 grant and create a
     * $300 shortfall — the check fired only on the commitment after the one
     * that did the damage.
     */
    await sprint(alice);
    await capital(alice, 10_000, 'alice-capital');

    const outcome = await spend(alice, 'too-big-for-the-money', 40_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/deployable/i);
    expect((await cashPosition({ projectId: alice })).shortfall).toBe(false);
  });

  it('allows one that fits exactly', async () => {
    await sprint(alice);
    await capital(alice, 40_000, 'alice-capital');
    expect((await spend(alice, 'exact-fit', 40_000)).ok).toBe(true);
    expect((await cashPosition({ projectId: alice })).deployableCents).toBe(0);
  });
});

describe('settling a hold is spending the money, not freeing it', () => {
  it('does not make deployable cash rise when a commitment is marked spent', async () => {
    /*
     * `settleCommitment` removed the hold and wrote no cost, so a $400 hold
     * against $1,000 of capital took deployable cash from $600 back to $1,000 —
     * the account was told it had the money it had just spent.
     */
    await sprint(alice);
    await capital(alice, 100_000, 'alice-capital');
    const committed = await spend(alice, 'to-settle', 40_000);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    expect((await cashPosition({ projectId: alice })).deployableCents).toBe(60_000);

    const settled = await settleSpend({
      commitmentId: committed.value.id,
      spentCents: 40_000,
      actorRef: userId,
    });
    expect(settled.ok).toBe(true);

    const after = await cashPosition({ projectId: alice });
    expect(after.heldCommitmentsCents).toBe(0);
    expect(after.availableFundsCents).toBe(60_000);
    expect(after.deployableCents).toBe(60_000);
  });

  it('returns the unspent remainder when less was spent than was held', async () => {
    await sprint(alice);
    await capital(alice, 100_000, 'alice-capital');
    const committed = await spend(alice, 'partial', 40_000);
    if (!committed.ok) throw new Error('commit failed');

    const settled = await settleSpend({
      commitmentId: committed.value.id,
      spentCents: 15_000,
      actorRef: userId,
    });
    expect(settled.ok).toBe(true);

    const after = await cashPosition({ projectId: alice });
    expect(after.availableFundsCents).toBe(85_000);
    expect(after.heldCommitmentsCents).toBe(0);
    expect(after.deployableCents).toBe(85_000);
  });

  it('refuses to settle for more than was held', async () => {
    await sprint(alice);
    await capital(alice, 100_000, 'alice-capital');
    const committed = await spend(alice, 'over-settle', 10_000);
    if (!committed.ok) throw new Error('commit failed');
    const settled = await settleSpend({
      commitmentId: committed.value.id,
      spentCents: 90_000,
      actorRef: userId,
    });
    expect(settled.ok).toBe(false);
  });

  it('is idempotent: settling twice spends once', async () => {
    await sprint(alice);
    await capital(alice, 100_000, 'alice-capital');
    const committed = await spend(alice, 'settle-twice', 40_000);
    if (!committed.ok) throw new Error('commit failed');

    await settleSpend({ commitmentId: committed.value.id, spentCents: 40_000, actorRef: userId });
    const again = await settleSpend({
      commitmentId: committed.value.id,
      spentCents: 40_000,
      actorRef: userId,
    });
    expect(again.ok).toBe(false);
    expect((await cashPosition({ projectId: alice })).availableFundsCents).toBe(60_000);
  });
});

describe('a replacement grant inherits what the old one is still holding', () => {
  it('counts outstanding project commitments against the new ceiling', async () => {
    /*
     * The ceiling was summed per *authority*, so withdrawing a grant with $400
     * outstanding and making a replacement with the same $500 ceiling permitted
     * another $400 — $800 held against a limit of $500, with every row correct
     * on its own.
     */
    const first = await sprint(alice, { maxCommittedCents: 50_000, maxPerActionCents: 50_000 });
    await capital(alice, 200_000, 'alice-capital');
    expect((await spend(alice, 'under-first-grant', 40_000)).ok).toBe(true);

    await revokeAuthority({ authorityId: first.id, actorUserId: userId, reason: 'Replacing it.' });
    await createAuthority({
      projectId: alice,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'replacement',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 50_000,
      maxPerActionCents: 50_000,
      maxConcurrent: 3,
      currency: 'USD',
    });

    const second = await spend(alice, 'under-replacement', 40_000);
    expect(second.ok).toBe(false);
    expect(await heldCentsForProject(alice)).toBe(40_000);
  });
});

describe('a money entry is written once, however many times it is sent', () => {
  it('does not double a settlement that was retried', async () => {
    /*
     * Every recording request minted a new id, so a retry after a lost response
     * recorded the same $750 settlement twice and the account reported $1,500.
     */
    await sprint(alice);
    const body = {
      projectId: alice,
      kind: 'SETTLEMENT' as const,
      amountCents: 75_000,
      currency: 'USD',
      verifiedReference: 'po_test_1',
      idempotencyKey: 'settlement-1',
      actorRef: userId,
    };
    const first = await recordMoneyEvent(body);
    const retry = await recordMoneyEvent(body);
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.value.id).toBe(first.value.id);
    expect((await cashPosition({ projectId: alice })).availableFundsCents).toBe(75_000);
  });

  it('refuses a key reused for a different amount rather than silently replaying', async () => {
    await sprint(alice);
    const first = await recordMoneyEvent({
      projectId: alice,
      kind: 'SETTLEMENT',
      amountCents: 75_000,
      currency: 'USD',
      verifiedReference: 'po_test_1',
      idempotencyKey: 'settlement-2',
      actorRef: userId,
    });
    expect(first.ok).toBe(true);

    const different = await recordMoneyEvent({
      projectId: alice,
      kind: 'SETTLEMENT',
      amountCents: 90_000,
      currency: 'USD',
      verifiedReference: 'po_test_1',
      idempotencyKey: 'settlement-2',
      actorRef: userId,
    });
    expect(different.ok).toBe(false);
    expect((await cashPosition({ projectId: alice })).availableFundsCents).toBe(75_000);
  });

  it('keeps one account’s key out of another account’s ledger', async () => {
    await sprint(alice);
    await sprint(bob);
    const a = await recordMoneyEvent({
      projectId: alice,
      kind: 'CAPITAL_IN',
      amountCents: 10_000,
      currency: 'USD',
      idempotencyKey: 'shared',
      actorRef: userId,
    });
    const b = await recordMoneyEvent({
      projectId: bob,
      kind: 'CAPITAL_IN',
      amountCents: 20_000,
      currency: 'USD',
      idempotencyKey: 'shared',
      actorRef: userId,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.id).not.toBe(a.value.id);
    expect((await cashPosition({ projectId: alice })).availableFundsCents).toBe(10_000);
    expect((await cashPosition({ projectId: bob })).availableFundsCents).toBe(20_000);
  });
});

describe('two currencies are not one number', () => {
  it('refuses an entry in a currency this sprint is not denominated in', async () => {
    /*
     * The aggregation summed every entry and labelled the result with one
     * currency, so USD and EUR were added as if interchangeable. A sprint is
     * pinned to one currency instead, which is the honest small answer.
     */
    await sprint(alice);
    const outcome = await recordMoneyEvent({
      projectId: alice,
      kind: 'CAPITAL_IN',
      amountCents: 10_000,
      currency: 'EUR',
      idempotencyKey: 'euros',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/USD/);
    expect((await cashPosition({ projectId: alice })).availableFundsCents).toBe(0);
  });
});
