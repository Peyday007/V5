/**
 * F-AMOUNT-UNKNOWN-RECORDED-REFUSED-BUT-ALLOWED: a spending action checked with
 * no amount stated (commitSpend judges its sum inside `commitCents`) used to be
 * ledgered as REFUSED / AMOUNT_UNKNOWN and then returned as allowed, so every
 * real spend left a refusal row beside committed money. What is recorded must
 * be what is returned, and the ceilings must still hold where money is committed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  checkCommercialAuthority,
  judgeAction,
} from '../server/services/cash/authority.ts';
import { commitSpend, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `amount-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const active = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
  expect(active.ok).toBe(true);
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Commercial authority',
    allowedActions: ['SPEND_FROM_ALLOWANCE'],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
  const funded = await recordMoneyEvent({
    projectId,
    kind: 'CAPITAL_IN',
    amountCents: 100_000,
    currency: 'USD',
    verifiedReference: `seed-${Math.random().toString(36).slice(2, 10)}`,
    idempotencyKey: `seed:${Math.random().toString(36).slice(2, 10)}`,
    actorRef: userId,
  });
  expect(funded.ok).toBe(true);
});

const decisions = async () =>
  (await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).map((row) => row.detail as Record<string, unknown>);

const spend = (amountCents: number, key: string) =>
  commitSpend({
    projectId,
    action: 'SPEND_FROM_ALLOWANCE',
    amountCents,
    purpose: 'Buy a supplier quote',
    expectedResult: 'A quotable cost',
    stopCondition: 'Stop at one quote',
    idempotencyKey: key,
    actorRef: userId,
  });

describe('a spend whose amount is judged at the commit', () => {
  it('a committed spend leaves no refusal row: the decision is recorded as performed', async () => {
    const outcome = await spend(2_500, 'amount-committed');
    expect(outcome).toMatchObject({ ok: true });
    const rows = await decisions();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.disposition).not.toBe('REFUSED');
      expect(row.cause).not.toBe('AMOUNT_UNKNOWN');
      expect(row.ok).toBe(true);
    }
    expect(rows).toContainEqual(expect.objectContaining({ action: 'SPEND_FROM_ALLOWANCE', disposition: 'PERFORMED', cause: 'CEILING_AT_COMMIT', ok: true }));
  });

  it('the gate returns exactly what it records', async () => {
    const decision = await checkCommercialAuthority({ projectId, action: 'SPEND_FROM_ALLOWANCE', principal: userId });
    expect(decision.ok).toBe(true);
    const [row] = await decisions();
    expect(row).toMatchObject({ ok: true, disposition: 'PERFORMED', cause: 'CEILING_AT_COMMIT' });
  });

  it('the ceilings still hold where the money is committed', async () => {
    const outcome = await spend(40_001, 'amount-over-ceiling');
    expect(outcome.ok).toBe(false);
    // The gate allowed it (ceilings pending) and the commit refused it: no committed row, and no refusal row that hides one.
    expect(await decisions()).toContainEqual(expect.objectContaining({ cause: 'CEILING_AT_COMMIT', ok: true }));
  });

  it('a stated amount is still judged at the gate, and an over-ceiling one is refused and recorded as refused', async () => {
    const decision = await checkCommercialAuthority({ projectId, action: 'SPEND_FROM_ALLOWANCE', amountCents: 50_000, principal: userId });
    expect(decision.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ ok: false, disposition: 'REFUSED', cause: 'OVER_PER_ACTION_CEILING' });
  });

  it('a grant-level refusal is never softened by an unstated amount', async () => {
    const decision = await checkCommercialAuthority({ projectId, action: 'ENGAGE_CONTRACTOR', principal: userId });
    expect(decision.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ ok: false, disposition: 'REFUSED', cause: 'NOT_COVERED' });
  });

  it('the pure judgment still refuses an unstated amount on a direct action path', () => {
    const decision = judgeAction(
      { projectId, action: 'SPEND_FROM_ALLOWANCE', path: 'BROWSER' },
      {
        authority: {
          id: 'a', projectId, policyVersion: 1, allowedActions: ['SPEND_FROM_ALLOWANCE'], prohibitions: [],
          maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD',
          startsAt: '2000-01-01T00:00:00.000Z', expiresAt: null,
        } as never,
        revoked: false,
        heldCents: 0,
      },
    );
    expect(decision.ok).toBe(false);
    expect(decision.ledger.cause).toBe('AMOUNT_UNKNOWN');
  });
});
