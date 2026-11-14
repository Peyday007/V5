/**
 * F-AMOUNT-UNKNOWN-RECORDED-REFUSED-BUT-ALLOWED (AUTH-20-3 / AUTH-34).
 *
 * `commitSpend` deliberately states no amount to `checkCommercialAuthority`
 * (the sum is judged against the ceilings inside the commitment's own
 * transaction, so a replay is never judged as a second commitment). The check
 * used to record that decision as REFUSED (AMOUNT_UNKNOWN) and then return ok,
 * so every real spend left a ledger row saying it was refused while the money
 * was committed — the ledger hid spending. These tests drive the real spend
 * path and read the rows it writes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AMOUNT_JUDGED_AT_COMMIT,
  AUTHORITY_DECISION_KIND,
  checkCommercialAuthority,
} from '../server/services/cash/authority.ts';
import { commitSpend, recordMoneyEvent } from '../server/services/cash/opportunities.ts';

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
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
});

async function grant(allowedActions: string[]) {
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Commercial authority',
    allowedActions,
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

async function fund(amountCents: number) {
  const funded = await recordMoneyEvent({
    projectId,
    kind: 'CAPITAL_IN',
    amountCents,
    currency: 'USD',
    verifiedReference: `seed-${Math.random().toString(36).slice(2, 10)}`,
    idempotencyKey: `seed:${Math.random().toString(36).slice(2, 10)}`,
    actorRef: userId,
  });
  expect(funded.ok).toBe(true);
}

const decisions = async () =>
  (await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).map((row) => row.detail as Record<string, unknown>);

describe('a spend that states no amount is never ledgered as refused while it is allowed', () => {
  it('commitSpend commits the money and its decision row says AUTHORIZED, not REFUSED', async () => {
    await grant(['SPEND_FROM_ALLOWANCE']);
    await fund(500_00);
    const outcome = await commitSpend({
      projectId,
      action: 'SPEND_FROM_ALLOWANCE',
      amountCents: 2_500,
      purpose: 'Buy a supplier quote',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop at one quote',
      idempotencyKey: 'amount-commit',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(true);
    const rows = await decisions();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.disposition).toBe('AUTHORIZED');
      expect(row.ok).toBe(true);
      expect(row.cause).toBe(AMOUNT_JUDGED_AT_COMMIT);
      expect(row.cause).not.toBe('AMOUNT_UNKNOWN');
    }
  });

  it('every allowed answer agrees with the row it wrote, for every spending action stated without a sum', async () => {
    const spending = ['SPEND_FROM_ALLOWANCE', 'ENGAGE_CONTRACTOR', 'PURCHASE_TOOL_OR_DATA', 'RUN_PAID_TEST'];
    await grant(spending);
    for (const action of spending) {
      const decision = await checkCommercialAuthority({ projectId, action, principal: userId });
      expect(decision.ok).toBe(true);
      const rows = await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND);
      const row = rows.find((one) => one.id === decision.decisionId)?.detail as Record<string, unknown>;
      expect(row.action).toBe(action);
      expect(row.ok).toBe(decision.ok);
      expect(row.disposition).toBe('AUTHORIZED');
    }
    expect((await decisions()).some((row) => row.disposition === 'REFUSED')).toBe(false);
  });

  it('a stated sum is still judged here: over the ceiling is refused and ledgered as refused', async () => {
    await grant(['SPEND_FROM_ALLOWANCE']);
    const decision = await checkCommercialAuthority({ projectId, action: 'SPEND_FROM_ALLOWANCE', amountCents: 50_000, principal: userId });
    expect(decision.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ disposition: 'REFUSED', cause: 'OVER_PER_ACTION_CEILING', ok: false });
  });

  it('a stated but unjudgeable sum stays refused, and the answer and the row agree', async () => {
    await grant(['SPEND_FROM_ALLOWANCE']);
    const decision = await checkCommercialAuthority({ projectId, action: 'SPEND_FROM_ALLOWANCE', amountCents: -1, principal: userId });
    expect(decision.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ disposition: 'REFUSED', cause: 'AMOUNT_UNKNOWN', ok: false });
  });

  it('with no grant, an unstated sum is still refused as NO_AUTHORITY', async () => {
    const decision = await checkCommercialAuthority({ projectId, action: 'SPEND_FROM_ALLOWANCE', principal: userId });
    expect(decision.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ disposition: 'REFUSED', ok: false });
    expect(row?.cause).not.toBe(AMOUNT_JUDGED_AT_COMMIT);
  });
});
