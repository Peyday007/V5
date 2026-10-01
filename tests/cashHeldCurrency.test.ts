/**
 * A hold in one currency is not a claim on money in another.
 *
 * `heldCentsForProject` summed every HELD commitment with no currency filter
 * while every other term of `cashPosition` is filtered by the sprint's
 * currency, so a hold that outlived a withdrawn USD grant reduced a later EUR
 * sprint's deployable cash by a figure in a different unit. Holds in other
 * currencies are now reported in `otherCurrencies` and never subtracted; no
 * conversion is made.
 *
 * Does `commit()`'s running sum need the same filter? Yes, and it now has it.
 * The reasoning that "ceilings are per grant and a grant has one currency" is
 * true of the ceiling but not of the sum: `heldThroughMine` sums by *project*
 * (deliberately, because a hold outlives its grant), so without a filter a
 * withdrawn USD grant's hold counted against a EUR grant's `maxCommittedCents`.
 * `commit()` already refuses a commitment whose currency differs from its
 * grant's, so filtering the sum by the commitment's own currency is exactly
 * the grant's currency. The second test below pins it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { commit, createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashPosition } from '../server/services/cash/money.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `held-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
});

function grant(currency: string, maxCommittedCents = 100_000) {
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: `grant-${currency}`,
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents,
    maxPerActionCents: maxCommittedCents,
    maxConcurrent: 3,
    currency,
  });
}

function hold(authorityId: string, currency: string, amountCents: number, key: string) {
  return commit({
    authorityId,
    projectId,
    amountCents,
    currency,
    purpose: 'Remove the missing supplier price',
    expectedResult: 'A quotable cost',
    stopCondition: 'Stop after one quote',
    idempotencyKey: key,
    createdBy: userId,
  });
}

describe('held commitments and currency', () => {
  it('leaves a EUR position alone, reports USD, and still reduces a USD position', async () => {
    const usd = await grant('USD');
    expect((await hold(usd.id, 'USD', 20_000, 'usd-hold')).ok).toBe(true);
    // The hold outlives its grant.
    await revokeAuthority({ authorityId: usd.id, actorUserId: userId, reason: 'withdrawn' });

    const eur = await cashPosition({ projectId, currency: 'EUR' });
    expect(eur.deployableCents).toBe(0);
    expect(eur.heldCommitmentsCents).toBe(0);
    expect(eur.otherCurrencies).toContain('USD');

    const usdPosition = await cashPosition({ projectId, currency: 'USD' });
    expect(usdPosition.heldCommitmentsCents).toBe(20_000);
    expect(usdPosition.deployableCents).toBe(-20_000);
    expect(usdPosition.otherCurrencies).not.toContain('USD');
  });

  it('does not count a USD hold against a EUR grant’s committed ceiling', async () => {
    const usd = await grant('USD');
    expect((await hold(usd.id, 'USD', 90_000, 'usd-hold')).ok).toBe(true);
    await revokeAuthority({ authorityId: usd.id, actorUserId: userId, reason: 'withdrawn' });

    const eur = await grant('EUR', 50_000);
    const outcome = await hold(eur.id, 'EUR', 40_000, 'eur-hold');
    expect(outcome.ok).toBe(true);
  });
});
