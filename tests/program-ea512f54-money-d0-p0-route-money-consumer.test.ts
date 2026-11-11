/**
 * MONEY-13-4, finding F6: the route money model must have a production
 * consumer.
 *
 * The figures `quantifyRouteMoney` derives from the append-only ledger are read
 * by `loadCashKnowledge`, which the goal planner's cash model
 * (`composeGoalModel`, and through it `readGoalPlan`) already consumes. This
 * suite drives that real path from real ledger rows: if nothing read the
 * ledger, the measured days-to-cash would not reach the plan and these fail.
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
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { composeGoalModel } from '../server/services/cash/goalScenario.ts';
import { forgetKnowledge, ledgerFigure, loadCashKnowledge, observationsFor } from '../server/services/quant/knowledge.ts';
import { quantifyRouteMoney, routeMoneyByOpportunity } from '../server/services/quant/deadline.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashMoneyEntry, CashMoneyKind, CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `money-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function opening(title: string, priceCents: number, currency = 'USD'): Promise<CashOpportunity> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'PRODUCTIZED_SERVICE',
    currency,
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

/** One completed deal on the ledger: agreed day 0, a supplier cost, paid on `paidDay`, settled on `settledDay`. */
async function deal(o: CashOpportunity, start: number, paidDay: number, settledDay: number, currency = 'USD'): Promise<void> {
  const row = (kind: CashMoneyKind, cents: number, day: number, extra: Record<string, string> = {}) =>
    recordMoney({ projectId, opportunityId: o.id, kind, amountCents: cents, currency, occurredAt: inDays(start + day), recordedBy: userId, idempotencyKey: `${o.id}-${kind}-${start}`, ...extra });
  expect((await row('PIPELINE_AGREED', 40_000, 0)).ok).toBe(true);
  expect((await row('COST', 10_000, 1)).ok).toBe(true);
  expect((await row('CUSTOMER_PAYMENT', 40_000, paidDay, { verifiedReference: `ref-${o.id}-${start}` })).ok).toBe(true);
  expect((await row('SETTLEMENT', 40_000, settledDay, { fundsAvailableAt: inDays(start + settledDay), verifiedReference: `set-${o.id}-${start}` })).ok).toBe(true);
}

async function goal(amountCents: number, days: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

describe('route money reaches the goal plan through cash knowledge (MONEY-13-4, F6)', () => {
  it('loadCashKnowledge quantifies every route from the ledger rows', async () => {
    const o = await opening('Report with a real deal', 40_000);
    await deal(o, -20, 7, 9);
    const knowledge = await loadCashKnowledge(projectId);
    const money = knowledge.routeMoney.get(o.id)!;
    expect(money).toBeTruthy();
    expect(money.identities.GROSS_BILLINGS).toBe(400);
    expect(money.identities.SETTLED_CASH).toBe(400);
    expect(money.receivables).toBe(0);
    expect(money.daysCommitmentToFunds).toBeCloseTo(7, 5);
    expect(money.daysFundsToUsableCash).toBeCloseTo(2, 5);
    expect(money.peakWorkingCapital).toBe(100);
    // The funder of the cost is stated by no row, so it stays unattributed rather than assumed self-funded.
    expect(money.selfFundedSpend).toBeNull();
    expect(money.unattributedSpend).toBe(100);

    const days = observationsFor(knowledge, 'daysToCash', o).find((one) => one.source.kind === 'LEDGER_ENTRY')!;
    expect(days.value).toMatchObject({ kind: 'POINT' });
    expect((days.value as { value: number }).value).toBeCloseTo(9, 5);
    const capital = observationsFor(knowledge, 'capitalShare', o).find((one) => one.source.kind === 'LEDGER_ENTRY')!;
    expect((capital.value as { value: number }).value).toBeCloseTo(0.25, 5);
    const cost = observationsFor(knowledge, 'costShare', o).find((one) => one.source.kind === 'LEDGER_ENTRY')!;
    expect((cost.value as { value: number }).value).toBeCloseTo(0.25, 5);
  });

  it('the plan a person reads infers days to cash from measured deals on comparable routes', async () => {
    for (const [i, paid] of [8, 10, 12].entries()) {
      const o = await opening(`Paid report ${i}`, 40_000);
      await deal(o, -40 + i, paid, paid + 2);
    }
    const target = await opening('New report, terms unknown', 45_000);
    const id = await goal(500_000, 30);
    const w = (await getWorkstream(id))!;
    const model = await composeGoalModel({ goal: w, target: (await readTarget(w))! });
    const modelled = model.considered.find((one) => one.opportunity.id === target.id)!;
    expect(modelled.daysToCash.inferred).toBeTruthy();
    expect(modelled.daysToCash.inferred!.p50).toBeGreaterThan(9);
    expect(modelled.daysToCash.inferred!.p50).toBeLessThan(15);

    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.inferred.some((one) => one.opportunityId === target.id && one.field === 'daysToCash')).toBe(true);
  });

  it('holds each route to its own currency and leaves unstated stages unknown', () => {
    const entry = (kind: CashMoneyKind, cents: number, day: number, currency = 'USD', fundsAvailableAt: string | null = null): CashMoneyEntry => ({
      id: `e-${kind}-${day}-${currency}`,
      projectId: 'p',
      opportunityId: 'o1',
      commitmentId: null,
      idempotencyKey: null,
      payloadFingerprint: null,
      kind,
      amountCents: cents,
      currency,
      verifiedReference: null,
      fundsAvailableAt,
      occurredAt: inDays(day),
      note: null,
      recordedBy: 'u',
      createdAt: inDays(day),
    });
    const routes = routeMoneyByOpportunity(
      [entry('PIPELINE_AGREED', 10_000, 0), entry('CUSTOMER_PAYMENT', 10_000, 5), entry('CUSTOMER_PAYMENT', 99_999, 3, 'EUR')],
      (id) => (id === 'o1' ? 'USD' : null),
    );
    const money = routes.get('o1')!;
    expect(money.identities.SETTLED_CASH).toBe(100);
    // No settlement row: funds-to-usable is unknown, so days to cash is not stated — never zero.
    expect(money.daysFundsToUsableCash).toBeNull();
    expect(ledgerFigure(money, 'daysToCash')).toBeNull();
    // No outlay row: neither cost nor capital share is invented.
    expect(ledgerFigure(money, 'costShare')).toBeNull();
    expect(ledgerFigure(quantifyRouteMoney({ routeKey: 'x', events: [] }), 'capitalShare')).toBeNull();
    // An opportunity the caller does not know belongs to no route.
    expect(routeMoneyByOpportunity([entry('PIPELINE_AGREED', 1, 0)], () => null).size).toBe(0);
  });
});
