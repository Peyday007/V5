/**
 * MONEY-13-4, repair "figures without consumer": the S-0105 figures beyond the
 * three the scenario turns into numbers must have a reader in the running
 * Brain. The goal model reads them through `loadCashKnowledge`: the margin
 * identity (refunds, chargebacks and owed supplier costs) decides direct cost,
 * restricted money counts as money tied up, every route is scored for capital
 * turnover and risk-adjusted collectible contribution, and every figure —
 * including the nine distinct identities — is stated on the ledger source the
 * plan carries.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { forgetKnowledge, ledgerObservations, ledgerValue, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { CASH_IDENTITIES, quantifyRouteMoney, routeMoneyStatement } from '../server/services/quant/deadline.ts';
import type { CashMoneyKind, CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let seq = 0;
const now = Date.now();
const inDays = (n: number) => new Date(now + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `figures-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function opening(title: string): Promise<CashOpportunity> {
  return createOpportunity({
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
    idempotencyKey: `figures-${seq}`,
    verifiedReference: kind === 'CUSTOMER_PAYMENT' ? `pi_figures_${seq}` : null,
    ...extra,
  });
  expect(out.ok, out.reason).toBe(true);
}

const route = (k: Awaited<ReturnType<typeof loadCashKnowledge>>, id: string) => k.routeMoney.get(id)!;

describe('MONEY-13-4 figures beyond the three scenario numbers are read in production', () => {
  it('a refund and an owed supplier cost are direct cost, and a reserve is money tied up', async () => {
    const o = await opening('Route with a refund, an owed cost and a reserve');
    await money(o.id, 'PIPELINE_AGREED', 100_000, inDays(-20));
    await money(o.id, 'COST', 20_000, inDays(-18));
    await money(o.id, 'CUSTOMER_PAYMENT', 100_000, inDays(-10));
    await money(o.id, 'SETTLEMENT', 100_000, inDays(-8), { fundsAvailableAt: inDays(-8) });
    await money(o.id, 'REFUND', 10_000, inDays(-6));
    await money(o.id, 'UNPAID_COMMITMENT', 5_000, inDays(-5));
    await money(o.id, 'RESERVE', 15_000, inDays(-4));
    const knowledge = await loadCashKnowledge(projectId);
    expect(knowledge.routeMoneyError).toBeNull();
    const route = knowledge.routeMoney.get(o.id)!;
    expect(route.refundsAndChargebacks).toBe(100);
    expect(route.supplierLiabilityOutstanding).toBe(50);
    expect(route.restrictedCash).toBe(150);
    expect(route.identities.GROSS_MARGIN).toBe(1000 - 100 - 200 - 50);
    // Cost is billings less the margin: outlays 200 + refund 100 + owed 50 = 350 of 1000.
    expect(ledgerValue(route, 'costShare')).toEqual({ kind: 'POINT', value: 0.35, exact: true });
    // Tied up: the 200 carried before the receipt, plus the 150 still reserved.
    expect(route.peakWorkingCapital).toBe(200);
    expect(ledgerValue(route, 'capitalShare')).toEqual({ kind: 'POINT', value: 0.35, exact: true });
  });

  it('every route is scored, and the plan-bound source states every figure and identity distinctly', async () => {
    const o = await opening('Route with a whole cycle');
    await money(o.id, 'PIPELINE_AGREED', 40_000, inDays(-20));
    await money(o.id, 'COST', 10_000, inDays(-18));
    await money(o.id, 'CUSTOMER_PAYMENT', 40_000, inDays(-10));
    await money(o.id, 'SETTLEMENT', 40_000, inDays(-8), { fundsAvailableAt: inDays(-8) });
    const knowledge = await loadCashKnowledge(projectId);
    const score = knowledge.routeScores.get(o.id)!;
    expect(score).toBeDefined();
    expect(score.riskAdjustedContribution).toBe(300);
    // The opening row (the lead) was created after these back-dated rows, so the cycle time is
    // inconsistent and turnover is unknown — stated as unknown on the source, never as zero.
    expect(route(knowledge, o.id).daysLeadToCommitment).toBeNull();
    expect(score.capitalTurnover).toBeNull();
    const [obs] = ledgerObservations(knowledge, 'costShare', o);
    const note = obs!.source.note!;
    expect(note).toMatch(/customer-funded 0, self-funded 100/);
    expect(note).toMatch(/receivables 0/);
    expect(note).toMatch(/refunds\/chargebacks unknown/);
    expect(note).toMatch(/usable cash 400/);
    expect(note).toMatch(/capital turnover unknown, risk-adjusted collectible contribution 300/);
    for (const k of CASH_IDENTITIES) expect(note).toContain(k.toLowerCase());
    // Distinct, and unknown where no row states it — never zero.
    expect(note).toMatch(/gross_billings 400/);
    expect(note).toMatch(/settled_cash 400/);
    expect(note).toMatch(/enterprise_value unknown/);
    expect(note).toMatch(/retained_cash unknown/);
  });

  it('a scored route states its capital turnover', () => {
    const at = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString();
    const m = quantifyRouteMoney({
      routeKey: 'r',
      leadAt: at(0),
      commitmentAt: at(2),
      usableCashAt: at(12),
      fundingFromReceipts: true,
      events: [
        { at: at(2), kind: 'BILLING', amount: 400 },
        { at: at(3), kind: 'SUPPLIER_OUTLAY', amount: 100 },
        { at: at(10), kind: 'FUNDS_RECEIVED', amount: 400 },
      ],
    });
    const text = routeMoneyStatement(m, { routeKey: 'r', capitalTurnover: 300 / (100 * 12), riskAdjustedContribution: 300 });
    expect(text).toMatch(/capital turnover 0\.250, risk-adjusted collectible contribution 300/);
    expect(text).toMatch(/days lead→commitment 2, commitment→funds 8, funds→usable 2/);
  });

  it('an unstated figure is written unknown, never zero', () => {
    const blank = quantifyRouteMoney({ routeKey: 'r', events: [] });
    const text = routeMoneyStatement(blank);
    expect(text).toMatch(/customer-funded unknown, self-funded unknown/);
    expect(text).toMatch(/receivables unknown/);
    expect(text).toMatch(/usable cash unknown/);
    expect(text).not.toMatch(/capital turnover/);
  });
});
