/**
 * What Brain may spend, and the race two workers can run for the last dollar.
 *
 * Two things are proved here and they are different in kind.
 *
 * The **vocabulary** is a closed set: an action outside it refuses the whole
 * grant rather than being stored and compared against nothing later, and the
 * always-prohibited list cannot be omitted by a caller that forgets it.
 *
 * The **ceiling** is a compare-and-swap rather than a count. §6 asks for
 * reservations that are atomic when several workers can spend against one
 * allocation, and the mechanism is the one this repository has needed five
 * times: insert first, rank by a value the claimant does not supply, and stand
 * down if the running total through your own rank is over. It can under-commit
 * and it cannot over-commit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  commit,
  createAuthority,
  heldCents,
  liveAuthority,
  releaseCommitment,
  revokeAuthority,
  settleCommitment,
} from '../server/repos/cashAuthority.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
  checkCommercialAuthority,
  describeAuthority,
  isCommercialAction,
} from '../server/services/cash/authority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture, commitSpend, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { cashPosition } from '../server/services/cash/money.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `auth-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function grant(overrides: Partial<Parameters<typeof createAuthority>[0]> = {}) {
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
    ...overrides,
  });
}

describe('the vocabulary is closed', () => {
  it('refuses an action this Brain does not know how to authorize', async () => {
    await grant();
    const decision = await checkCommercialAuthority({
      projectId,
      action: 'TRANSFER_EVERYTHING',
    });
    expect(decision.ok).toBe(false);
    expect(isCommercialAction('TRANSFER_EVERYTHING')).toBe(false);
  });

  it('refuses an action the grant does not list, even though the set knows it', async () => {
    await grant({ allowedActions: ['QUOTE_AND_INVOICE'] });
    expect((await checkCommercialAuthority({ projectId, action: 'QUOTE_AND_INVOICE' })).ok).toBe(
      true,
    );
    expect((await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' })).ok).toBe(false);
  });

  it('refuses an always-prohibited action however the grant is written', async () => {
    // Written by hand as a grant that tries to authorize one of them. The
    // prohibitions list is what refuses it; the allowed list cannot rescue it,
    // because a prohibition is checked first.
    await grant({
      allowedActions: [...COMMERCIAL_ACTIONS, 'PAID_OVERAGE'],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    });
    const decision = await checkCommercialAuthority({ projectId, action: 'PAID_OVERAGE' });
    expect(decision.ok).toBe(false);
  });

  it('refuses everything when no grant exists', async () => {
    for (const action of COMMERCIAL_ACTIONS) {
      expect((await checkCommercialAuthority({ projectId, action })).ok).toBe(false);
    }
  });

  it('refuses after the grant is withdrawn, on the next check', async () => {
    const authority = await grant();
    expect((await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' })).ok).toBe(true);
    await revokeAuthority({ authorityId: authority.id, actorUserId: userId, reason: 'Enough.' });
    expect((await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' })).ok).toBe(false);
    expect(await liveAuthority(projectId)).toBeNull();
  });

  it('refuses an expired grant without anything having to sweep it', async () => {
    await grant({ expiresAt: '2020-01-01T00:00:00.000Z' });
    expect((await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' })).ok).toBe(false);
  });
});

describe('the words a person reads are the server’s', () => {
  it('names every ceiling and every permanent prohibition', async () => {
    const authority = await grant();
    const lines = describeAuthority(authority).join(' ');
    expect(lines).toContain('1,000.00');
    expect(lines).toContain('400.00');
    for (const never of ALWAYS_PROHIBITED_COMMERCIAL) expect(lines).toContain(never);
  });

  it('says plainly when a grant authorizes nothing', async () => {
    const authority = await grant({ allowedActions: [] });
    expect(describeAuthority(authority).join(' ')).toContain('authorizes no commercial action');
  });
});

describe('the ceiling is spent by insert, not by count', () => {
  it('lets two racing commitments through only as far as the ceiling allows', async () => {
    const authority = await grant({ maxCommittedCents: 50_000, maxPerActionCents: 40_000 });

    // Both read the same remaining balance and both try to take 30,000. Exactly
    // one can be inside a 50,000 ceiling.
    const [first, second] = await Promise.all([
      commit({
        authorityId: authority.id,
        projectId,
        amountCents: 30_000,
        currency: 'USD',
        purpose: 'Buy the supplier price',
        expectedResult: 'A quotable cost',
        stopCondition: 'Stop at one quote',
        idempotencyKey: 'race-a',
        createdBy: userId,
      }),
      commit({
        authorityId: authority.id,
        projectId,
        amountCents: 30_000,
        currency: 'USD',
        purpose: 'Buy the contractor slot',
        expectedResult: 'A confirmed delivery date',
        stopCondition: 'Stop at one slot',
        idempotencyKey: 'race-b',
        createdBy: userId,
      }),
    ]);

    const winners = [first, second].filter((outcome) => outcome.ok);
    expect(winners.length).toBe(1);
    expect(await heldCents(authority.id)).toBe(30_000);

    const loser = [first, second].find((outcome) => !outcome.ok)!;
    expect(loser.refusedBy).toBe('IN_TOTAL');
  });

  it('refuses one commitment larger than the per-action ceiling', async () => {
    const authority = await grant({ maxPerActionCents: 10_000 });
    const outcome = await commit({
      authorityId: authority.id,
      projectId,
      amountCents: 20_000,
      currency: 'USD',
      purpose: 'Too much at once',
      expectedResult: 'Nothing',
      stopCondition: 'Nothing',
      idempotencyKey: 'too-big',
      createdBy: userId,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusedBy).toBe('PER_ACTION');
    // And it left nothing held: a refusal costs no ceiling.
    expect(await heldCents(authority.id)).toBe(0);
  });

  it('gives the ceiling back when a commitment settles', async () => {
    const authority = await grant({ maxCommittedCents: 30_000 });
    const first = await commit({
      authorityId: authority.id,
      projectId,
      amountCents: 30_000,
      currency: 'USD',
      purpose: 'One',
      expectedResult: 'Something',
      stopCondition: 'Here',
      idempotencyKey: 'one',
      createdBy: userId,
    });
    expect(first.ok).toBe(true);
    await settleCommitment(first.commitment!.id, 30_000);
    expect(await heldCents(authority.id)).toBe(0);

    const second = await commit({
      authorityId: authority.id,
      projectId,
      amountCents: 30_000,
      currency: 'USD',
      purpose: 'Two',
      expectedResult: 'Something',
      stopCondition: 'Here',
      idempotencyKey: 'two',
      createdBy: userId,
    });
    expect(second.ok).toBe(true);
  });

  it('is idempotent: the same key twice is one commitment', async () => {
    const authority = await grant();
    const body = {
      authorityId: authority.id,
      projectId,
      amountCents: 10_000,
      currency: 'USD',
      purpose: 'One obstacle',
      expectedResult: 'One result',
      stopCondition: 'One limit',
      idempotencyKey: 'same',
      createdBy: userId,
    };
    const first = await commit(body);
    const second = await commit(body);
    expect(first.ok && second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.commitment!.id).toBe(first.commitment!.id);
    expect(await heldCents(authority.id)).toBe(10_000);
  });

  it('does not revive a released commitment on a retry', async () => {
    /*
     * The deliberate difference from a research reservation. A released
     * research hold is a stand-down on a slot that frees up later; a released
     * commitment is a person saying this money is not being spent, and reviving
     * it on the next retry would re-commit funds somebody had freed — with the
     * retry looking exactly like the original.
     */
    const authority = await grant();
    const body = {
      authorityId: authority.id,
      projectId,
      amountCents: 10_000,
      currency: 'USD',
      purpose: 'One obstacle',
      expectedResult: 'One result',
      stopCondition: 'One limit',
      idempotencyKey: 'released-key',
      createdBy: userId,
    };
    const first = await commit(body);
    await releaseCommitment({ commitmentId: first.commitment!.id, reason: 'Not spending it.' });

    const retry = await commit(body);
    expect(retry.ok).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(await heldCents(authority.id)).toBe(0);
  });

  it('refuses a grant addressed from another project in the same words as a missing one', async () => {
    const authority = await grant();
    const outcome = await commit({
      authorityId: authority.id,
      projectId: 'prj_somebody_elses',
      amountCents: 1_000,
      currency: 'USD',
      purpose: 'Reaching across',
      expectedResult: 'Nothing',
      stopCondition: 'Nothing',
      idempotencyKey: 'cross',
      createdBy: userId,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no such commercial authority');
  });

  it('refuses a currency the grant is not denominated in rather than converting', async () => {
    const authority = await grant();
    const outcome = await commit({
      authorityId: authority.id,
      projectId,
      amountCents: 1_000,
      currency: 'EUR',
      purpose: 'Elsewhere',
      expectedResult: 'Nothing',
      stopCondition: 'Nothing',
      idempotencyKey: 'eur',
      createdBy: userId,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('rate somebody has to choose');
  });
});

describe('the commitment sentence §6 asks for', () => {
  it('refuses a commitment that names no obstacle, result or stopping point', async () => {
    await grant();
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    for (const missing of ['purpose', 'expectedResult', 'stopCondition'] as const) {
      const body = {
        projectId,
        action: 'RUN_PAID_TEST',
        amountCents: 1_000,
        purpose: 'Remove the missing supplier price',
        expectedResult: 'A quotable cost',
        stopCondition: 'Stop after one quote',
        idempotencyKey: `blank-${missing}`,
        actorRef: userId,
      };
      const outcome = await commitSpend({ ...body, [missing]: '   ' });
      expect(outcome.ok).toBe(false);
    }
  });

  it('refuses a commitment the account cannot cover', async () => {
    /*
     * The gate used to ask whether deployable cash was *already* negative,
     * which fires one commitment after the one that did the damage. It asks
     * whether **this** commitment fits now, so the account that cannot cover it
     * is told before the money is committed rather than afterwards.
     */
    await grant();
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    await recordMoneyEvent({
      projectId,
      kind: 'UNPAID_COMMITMENT',
      amountCents: 50_000,
      currency: 'USD',
      idempotencyKey: 'a-bill',
      actorRef: userId,
    });

    const outcome = await commitSpend({
      projectId,
      action: 'RUN_PAID_TEST',
      amountCents: 1_000,
      purpose: 'Remove the missing supplier price',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop after one quote',
      idempotencyKey: 'while-short',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('deployable');
  });

  it('lets a retry through the shortfall gate its own first attempt created', async () => {
    /*
     * The gate blocks **new** discretionary commitments while an account is
     * short. A retry is not a new one — and the first attempt is usually what
     * made the account short, so refusing the retry would leave a caller that
     * lost its response with no way to find out what happened to its money.
     * §20's rule at a new table: a retry is not a second effect.
     */
    await grant();
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    // Exactly enough for one commitment and nothing after it, so the first
    // attempt is what makes the account short.
    await recordMoneyEvent({
      projectId,
      kind: 'CAPITAL_IN',
      amountCents: 20_000,
      currency: 'USD',
      idempotencyKey: 'seed-capital',
      actorRef: userId,
    });
    const body = {
      projectId,
      action: 'RUN_PAID_TEST' as const,
      amountCents: 20_000,
      purpose: 'Remove the missing supplier price',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop after one quote',
      idempotencyKey: 'replay-while-short',
      actorRef: userId,
    };

    const first = await commitSpend(body);
    expect(first.ok).toBe(true);
    // Every cent is spoken for, so nothing new fits.
    expect((await cashPosition({ projectId })).deployableCents).toBe(0);

    const retry = await commitSpend(body);
    expect(retry.ok).toBe(true);
    if (retry.ok && first.ok) expect(retry.value.id).toBe(first.value.id);

    // A genuinely new one is still refused, which is what the gate is for.
    const different = await commitSpend({ ...body, idempotencyKey: 'a-second-decision' });
    expect(different.ok).toBe(false);
    expect((await cashPosition({ projectId })).deployableCents).toBe(0);
  });

  it('refuses a replay whose grant has since been withdrawn', async () => {
    // The half a revocation can change is re-checked on the replay: §20's rule
    // that a replay re-reads and re-authorizes.
    const authority = await grant();
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    await recordMoneyEvent({
      projectId,
      kind: 'CAPITAL_IN',
      amountCents: 10_000,
      currency: 'USD',
      idempotencyKey: 'seed-capital',
      actorRef: userId,
    });
    const body = {
      projectId,
      action: 'RUN_PAID_TEST' as const,
      amountCents: 1_000,
      purpose: 'Remove the missing supplier price',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop after one quote',
      idempotencyKey: 'replay-after-revocation',
      actorRef: userId,
    };
    expect((await commitSpend(body)).ok).toBe(true);
    await revokeAuthority({ authorityId: authority.id, actorUserId: userId, reason: 'Enough.' });
    expect((await commitSpend(body)).ok).toBe(false);
  });

  it('refuses a commitment against an opportunity in another project', async () => {
    await grant();
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A job',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error('capture failed');

    const outcome = await commitSpend({
      projectId: 'prj_not_mine',
      opportunityId: captured.value.id,
      action: 'RUN_PAID_TEST',
      amountCents: 1_000,
      purpose: 'Remove the missing supplier price',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop after one quote',
      idempotencyKey: 'cross-project',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
  });
});
