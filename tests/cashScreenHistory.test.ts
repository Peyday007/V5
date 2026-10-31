/**
 * An opening of a kind Brain has no history with is held to investigate, on the
 * real decision path, and never read as familiar for want of a fact.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { currentDecision } from '../server/repos/cashDecisions.ts';
import { runDecisionPass } from '../server/services/cash/decisions.ts';
import { screenFactsFor, screenFactsWithHistory } from '../server/services/cash/worthResearching.ts';

const NOW = new Date('2026-10-30T00:00:00.000Z');
let projectId = '';
let modeId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `hist-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  modeId = (await getCashMode(projectId))!.id;
});

async function fullyKnown(title: string, mechanism: string) {
  const o = await createOpportunity({ projectId, cashModeId: modeId, ownerUserId: userId, title, mechanism: mechanism as never, currency: 'USD', sourceClaimId: null, source: 'A publisher' });
  await updateOpportunity(o.id, {
    payer: 'Acme', price_cents: 200_000, payment_terms: 'net 10', peak_funding_cents: 10_000,
    signal_observed_at: NOW.toISOString(),
  } as never);
  return (await getOpportunity(o.id))!;
}

describe('type history', () => {
  it('is not assumed: no context means no established history', async () => {
    const o = await fullyKnown('A', 'PRODUCTIZED_SERVICE');
    expect(screenFactsFor(o).typeHasHistory).toBe(false);
    expect((await screenFactsWithHistory(o)).typeHasHistory).toBe(false);
  });

  it('is read from rows: a recorded outcome for the same mechanism makes it familiar', async () => {
    const a = await fullyKnown('A', 'PRODUCTIZED_SERVICE');
    await updateOpportunity(a.id, { validation_state: 'COMPLETE' } as never);
    const b = await fullyKnown('B', 'PRODUCTIZED_SERVICE');
    expect((await screenFactsWithHistory(b)).typeHasHistory).toBe(true);
    const c = await fullyKnown('C', 'EXPLICIT_PAID_REQUEST');
    expect((await screenFactsWithHistory(c)).typeHasHistory).toBe(false);
  });

  it('holds an unfamiliar opening to investigate through the decision pass, and never rejects it for that', async () => {
    const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, capitalCeilingCents: 5_000_000, now: new Date(NOW.getTime() - 60_000) });
    expect(set.ok).toBe(true);
    const o = await fullyKnown('Novel', 'PRODUCTIZED_SERVICE');
    await runDecisionPass(projectId, { now: NOW.toISOString() });
    const decision = await currentDecision(o.id, g.id);
    expect(decision?.verdict).toBe('HOLD');
    expect(decision?.reason).toBe('UNFAMILIAR_TYPE');
  });
});
