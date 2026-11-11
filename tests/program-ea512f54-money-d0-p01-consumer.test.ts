/**
 * MONEY-13-4, repair F6: the route money figures must reach a production
 * record, not only a unit test. The goal scenario reads a project's quantitative
 * knowledge through `loadCashKnowledge`; that knowledge now carries each route's
 * ledger-measured money velocity, and the goal model reconstructs an opening's
 * direct cost, money tied up and days to cash from what its own ledger (and its
 * comparables' ledgers) actually recorded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { composeGoalModel } from '../server/services/cash/goalScenario.ts';
import { forgetKnowledge, inferCashQuantity, ledgerObservations, ledgerValue, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashMoneyKind, CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let seq = 0;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `money-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function opening(title: string, priceCents: number): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'PRODUCTIZED_SERVICE',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
    source: 'A publisher',
    requiredCapabilities: ['PRODUCE_SPREADSHEET'],
  });
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, 'Sell a monthly report to each buyer.');
  await fact('payer', 'Property managers');
  await fact('delivery', 'A spreadsheet Brain produces.');
  await updateOpportunity(o.id, { payer: 'Property managers', price_cents: priceCents, offer_scope: 'One report', reachable_channel: 'Published emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-2) });
  await fact('price', `$${priceCents / 100}`);
  await fact('buyerVolume', '400 property managers are listed in the state directory; each orders monthly.');
  return o;
}

async function money(opportunityId: string, kind: CashMoneyKind, cents: number, at: string, extra: { fundsAvailableAt?: string } = {}) {
  seq += 1;
  const out = await recordMoney({
    projectId,
    opportunityId,
    kind,
    amountCents: cents,
    currency: 'USD',
    occurredAt: at,
    recordedBy: userId,
    idempotencyKey: `route-${seq}`,
    verifiedReference: kind === 'CUSTOMER_PAYMENT' ? `pi_route_${seq}` : null,
    ...extra,
  });
  expect(out.ok, out.reason).toBe(true);
}

/** One route's whole cycle on the ledger: agreed $400, $100 out before $400 comes in, settled two days later. */
async function cycle(o: CashOpportunity) {
  await money(o.id, 'PIPELINE_AGREED', 40_000, inDays(-20));
  await money(o.id, 'COST', 10_000, inDays(-18));
  await money(o.id, 'CUSTOMER_PAYMENT', 40_000, inDays(-10));
  await money(o.id, 'SETTLEMENT', 40_000, inDays(-8), { fundsAvailableAt: inDays(-8) });
}

describe('MONEY-13-4 figures reach the running Brain through the goal model', () => {
  it('loads every route the ledger states into the knowledge the goal scenario reads', async () => {
    const o = await opening('Route with a recorded cycle', 40_000);
    await cycle(o);
    const knowledge = await loadCashKnowledge(projectId);
    expect(knowledge.routeMoneyError).toBeNull();
    const route = knowledge.routeMoney.get(o.id)!;
    expect(route).toBeDefined();
    expect(route.identities.GROSS_BILLINGS).toBe(400);
    expect(route.identities.SETTLED_CASH).toBe(400);
    // The $100 cost left before the customer's $400 arrived: the ledger rows say the route self-funded it.
    expect(route.unattributedSpend).toBe(0);
    expect(route.selfFundedSpend).toBe(100);
    expect(route.customerFundedSpend).toBe(0);
    expect(route.peakWorkingCapital).toBe(100);
    expect(route.receivables).toBe(0);
    expect(route.daysCommitmentToFunds).toBeCloseTo(10, 5);
    expect(route.daysFundsToUsableCash).toBeCloseTo(2, 5);
    // Shares travel between prices: $100 out on $400 billed is a quarter, both as cost and as capital held.
    expect(ledgerValue(route, 'costShare')).toEqual({ kind: 'POINT', value: 0.25, exact: true });
    expect(ledgerValue(route, 'capitalShare')).toEqual({ kind: 'POINT', value: 0.25, exact: true });
    const obs = ledgerObservations(knowledge, 'costShare', o);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.source).toMatchObject({ kind: 'LEDGER_ENTRY', ref: o.id });
  });

  it("a customer's deposit funds the cost that follows it, read from production ledger rows alone", async () => {
    const o = await opening('Deposit-funded route', 40_000);
    await money(o.id, 'PIPELINE_AGREED', 40_000, inDays(-20));
    await money(o.id, 'CUSTOMER_PAYMENT', 15_000, inDays(-19));
    await money(o.id, 'COST', 25_000, inDays(-18));
    const route = (await loadCashKnowledge(projectId)).routeMoney.get(o.id)!;
    expect(route.customerFundedSpend).toBe(150);
    expect(route.selfFundedSpend).toBe(100);
    expect(route.unattributedSpend).toBe(0);
  });

  it('a route the ledger does not state contributes nothing, never a zero', async () => {
    const o = await opening('Agreed but nothing paid', 40_000);
    await money(o.id, 'PIPELINE_AGREED', 40_000, inDays(-5));
    const knowledge = await loadCashKnowledge(projectId);
    const route = knowledge.routeMoney.get(o.id)!;
    expect(ledgerValue(route, 'costShare')).toBeNull();
    expect(ledgerValue(route, 'capitalShare')).toBeNull();
    expect(ledgerValue(route, 'daysToCash')).toBeNull();
    expect(inferCashQuantity(knowledge, 'costShare', o)).toBeNull();
  });

  it("the goal model reconstructs a new opening's direct cost from what comparable routes' ledgers recorded", async () => {
    for (const i of [0, 1, 2]) await cycle(await opening(`Comparable route ${i}`, 40_000));
    const target = await opening('New route with no cost research', 40_000);
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 500_000, currency: 'USD', projectId, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const w = (await getWorkstream(g.id))!;
    const model = await composeGoalModel({ goal: w, target: (await readTarget(w))! });
    const modelled = model.considered.find((one) => one.opportunity.id === target.id)!;
    expect(modelled.directCost.inferred).toBeDefined();
    expect(modelled.directCost.inferred!.observations).toBeGreaterThanOrEqual(2);
    // A quarter of a $400 price, measured on three routes' ledgers.
    expect(modelled.directCost.inferred!.p50).toBeGreaterThan(50);
    expect(modelled.directCost.inferred!.p50).toBeLessThan(200);
    expect(modelled.directCost.note).toMatch(/inferred/);
  });
});
