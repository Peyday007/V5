import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashFunnel } from '../server/services/cash/funnel.ts';
import { assessOpportunityRole } from '../server/services/cash/exclusions.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let currency = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `com135f-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  expect(outcome.ok).toBe(true);
  const mode = (await getCashMode(projectId))!;
  cashModeId = mode.id;
  currency = mode.currency;
});

async function settledOpening(title: string, cents: number): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency });
  const r = await recordMoney({ projectId, opportunityId: o.id, kind: 'SETTLEMENT', amountCents: cents, currency, verifiedReference: `ref-${o.id}`, recordedBy: userId, idempotencyKey: `settle-${o.id}` });
  expect(r.ok).toBe(true);
  return o.id;
}

describe('COM-13-5 repair: the funnel counts settled cash through the opening-aware role reader', () => {
  it('reads a regulated activity stated only on the opening row and holds its settlement back, not excluded', async () => {
    const id = await settledOpening('Earn insurance commissions on policies sold to homeowners we refer', 50_000);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.settledByCurrency).toEqual({ [currency]: 50_000 });
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 0 });
    const held = reading.outcomes.heldBack.find((h) => h.opportunityId === id);
    expect(held).toBeDefined();
    // Assessed as a regulated role whose rights are not stated — not "names no activity".
    expect(held!.position).toBe('UNKNOWN');
    expect(held!.reason).toContain('Not stated in the record');
    expect(held!.reason).not.toContain('names no activity');
  });

  it('funnel and probe reader assess the same opening identically', async () => {
    const regulated = await settledOpening('Broker mortgages for borrowers for a commission', 20_000);
    const plain = await settledOpening('Photo prints for a cafe wall', 10_000);
    const reading = await cashFunnel({ projectId });
    const regulatedProbe = await assessOpportunityRole({ projectId, opportunityId: regulated });
    const held = reading.outcomes.heldBack.find((h) => h.opportunityId === regulated);
    expect(held).toEqual({ opportunityId: regulated, position: regulatedProbe.position, reason: regulatedProbe.reason });
    // The ordinary opening: the same reader finds it unregulated from its rows, and the funnel counts it.
    const plainProbe = await assessOpportunityRole({ projectId, opportunityId: plain });
    expect(plainProbe.position).toBe('COMPLIANT');
    expect(plainProbe.countEconomics).toBe(true);
    expect(reading.outcomes.heldBack.find((h) => h.opportunityId === plain)).toBeUndefined();
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 10_000 });
  });

  it('counts the settled cash of an ordinary opening, and holds back only the regulated one', async () => {
    await settledOpening('Photo prints for a cafe wall', 10_000);
    await settledOpening('Spreadsheet cleanup for a bakery', 7_500);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.settledByCurrency).toEqual({ [currency]: 17_500 });
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 17_500 });
    expect(reading.outcomes.heldBack).toEqual([]);
  });
});
