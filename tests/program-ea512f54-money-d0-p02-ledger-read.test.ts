/**
 * MONEY-13-4, repair F3: a route's money figures must come from all of its
 * ledger rows. `readRouteMoney` once read the newest 2000 entries of the whole
 * project, so on a busy project an older route's agreement and first cost fell
 * out of the read while its later receipt stayed, and the commitment date,
 * receivables, margin and peak working capital were wrong yet reported as
 * measured. Each route is now read on its own, and a route whose own read is
 * cut at the limit is reported as partial with every figure unknown.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { LEDGER_READ_LIMIT, readRouteMoney } from '../server/services/quant/deadline.ts';
import type { CashMoneyKind, CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let seq = 0;
const now = Date.now();
const inDays = (n: number) => new Date(now + n * 86_400_000).toISOString();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `ledger-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
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
    idempotencyKey: `ledger-read-${seq}`,
    verifiedReference: kind === 'CUSTOMER_PAYMENT' ? `pi_ledger_${seq}` : null,
    ...extra,
  });
  expect(out.ok, out.reason).toBe(true);
}

/** An old route's whole cycle: agreed $400, $100 out before $400 comes in, settled two days later. */
async function oldCycle(o: CashOpportunity) {
  await money(o.id, 'PIPELINE_AGREED', 40_000, inDays(-60));
  await money(o.id, 'COST', 10_000, inDays(-58));
  await money(o.id, 'CUSTOMER_PAYMENT', 40_000, inDays(-1));
  await money(o.id, 'SETTLEMENT', 40_000, inDays(-1), { fundsAvailableAt: inDays(0) });
}

describe('MONEY-13-4 route money reads every row of a route', () => {
  it('keeps an old route whole when the project holds more entries than one read returns', async () => {
    const old = await opening('Old route');
    const busy = await opening('Busy route');
    await oldCycle(old);
    // Newer than the old route's agreement and cost, older than its receipt: a
    // project-wide newest-first read of LEDGER_READ_LIMIT rows drops exactly those two.
    for (let i = 0; i < LEDGER_READ_LIMIT - 2; i += 1) await money(busy.id, 'COST', 100, inDays(-50 + i / 1000));

    const routes = await readRouteMoney({ projectId, currency: 'USD' });
    const route = routes.find((r) => r.routeKey === old.id)!;
    expect(route).toBeDefined();
    expect(route.identities.GROSS_BILLINGS).toBe(400);
    expect(route.identities.GROSS_MARGIN).toBe(300);
    expect(route.receivables).toBe(0);
    expect(route.supplierOutlays).toEqual([{ at: inDays(-58), amount: 100 }]);
    expect(route.selfFundedSpend).toBe(100);
    expect(route.peakWorkingCapital).toBe(100);
    expect(route.daysCommitmentToFunds).toBeCloseTo(59, 5);
    expect(route.unknowns.some((u) => u.includes('ledger read stopped'))).toBe(false);

    // The busy route fits under the limit on its own, so it is measured, not partial.
    const busyRoute = routes.find((r) => r.routeKey === busy.id)!;
    expect(busyRoute.supplierOutlays).toHaveLength(LEDGER_READ_LIMIT - 2);
    expect(busyRoute.unknowns.some((u) => u.includes('ledger read stopped'))).toBe(false);
  }, 120_000);

  it('reports a route whose own read reaches the limit as partial, every figure unknown', async () => {
    const o = await opening('Truncated route');
    await oldCycle(o);
    const complete = (await readRouteMoney({ projectId, currency: 'USD', rowLimit: 5 })).find((r) => r.routeKey === o.id)!;
    expect(complete.identities.GROSS_BILLINGS).toBe(400);

    const cut = (await readRouteMoney({ projectId, currency: 'USD', rowLimit: 4 })).find((r) => r.routeKey === o.id)!;
    expect(cut.unknowns[0]).toContain('ledger read stopped at 4 rows');
    expect(cut.identities.GROSS_BILLINGS).toBeNull();
    expect(cut.identities.GROSS_MARGIN).toBeNull();
    expect(cut.receivables).toBeNull();
    expect(cut.peakWorkingCapital).toBeNull();
    expect(cut.daysCommitmentToFunds).toBeNull();
    expect(cut.usableCash).toBeNull();
    expect(cut.supplierOutlays).toEqual([]);
  });
});
