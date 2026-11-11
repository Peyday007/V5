/**
 * MONEY-13-4, repair F3: a route's figures are read from its whole ledger. The
 * project-wide ledger read is bounded and newest-first, so on a project with more
 * rows than the bound it used to drop a route's oldest rows (its PIPELINE_AGREED
 * billing and first COST) while keeping its later receipt — a wrong commitment
 * date, receivables and peak working capital presented as measured.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { listMoneyEntries, recordMoney } from '../server/repos/cashLedger.ts';
import { LEDGER_READ_LIMIT, readRouteMoney } from '../server/services/quant/deadline.ts';
import type { CashMoneyKind, CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let seq = 0;
const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

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

async function money(opportunityId: string, kind: CashMoneyKind, cents: number, occurredAt: string) {
  seq += 1;
  const out = await recordMoney({
    projectId,
    opportunityId,
    kind,
    amountCents: cents,
    currency: 'USD',
    occurredAt,
    recordedBy: userId,
    idempotencyKey: `ledger-read-${seq}`,
    verifiedReference: kind === 'CUSTOMER_PAYMENT' ? `pi_ledger_${seq}` : null,
  });
  expect(out.ok, out.reason).toBe(true);
}

describe('MONEY-13-4 route money reads every row of a route, past the ledger read bound', () => {
  it('keeps an old billing and cost when newer rows fill the project read, and marks a route its own read truncated', async () => {
    const early = await opening('Route agreed long ago');
    const busy = await opening('Route with many rows');
    // The early route's billing and cost are the project's oldest rows.
    await money(early.id, 'PIPELINE_AGREED', 40_000, at(100_000));
    await money(early.id, 'COST', 10_000, at(99_000));
    // A busy route fills the whole bound with newer rows, all on its own.
    for (let i = 0; i < LEDGER_READ_LIMIT; i += 1) await money(busy.id, 'CAPITAL_IN', 100, at(90_000 - i));
    // The early route's receipt is the newest row.
    await money(early.id, 'CUSTOMER_PAYMENT', 40_000, at(1));

    // The bounded project read really does drop the early route's oldest rows.
    const projectRead = await listMoneyEntries({ projectId, currency: 'USD', limit: LEDGER_READ_LIMIT });
    expect(projectRead).toHaveLength(LEDGER_READ_LIMIT);
    expect(projectRead.some((e) => e.opportunityId === early.id && e.kind === 'PIPELINE_AGREED')).toBe(false);

    const routes = new Map((await readRouteMoney({ projectId, currency: 'USD' })).map((r) => [r.routeKey, r] as const));
    const route = routes.get(early.id)!;
    expect(route.identities.GROSS_BILLINGS).toBe(400);
    expect(route.receivables).toBe(0);
    expect(route.unattributedSpend).toBe(100);
    expect(route.peakWorkingCapital).toBe(100);
    expect(route.daysCommitmentToFunds).not.toBeNull();
    expect(route.unknowns.some((u) => /ledger read stopped/.test(u))).toBe(false);

    // The busy route's own read fills the bound, so it says its figures are incomplete.
    const crowded = routes.get(busy.id)!;
    expect(crowded.unknowns.some((u) => /ledger read stopped at 2000 rows/.test(u))).toBe(true);
  }, 120_000);
});
