/**
 * MONEY-13-4: money velocity and deal structure, with distinct cash identities,
 * demonstrated on production rows (S-0105). Reads the project's own money ledger
 * through the released reader (`readRouteMoney`) and judges each route it finds.
 *
 * - UNKNOWN when no ledger row exists anywhere, or no route yet measures both a
 *   funding split and a timing leg: nothing to look at is not a demonstration
 *   (§39), and no code change could make it one.
 * - FAIL when a route's figure is impossible (not finite, or negative where a
 *   quantity cannot be), when the cash identities are missing or collapsed, or
 *   when a figure is null without the reading saying why.
 * - PASS when every route reads cleanly and at least one measures customer- vs
 *   self-funded spend and a lead→commitment→funds→usable leg from its rows.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';

const NON_NEGATIVE = [
  'customerFundedSpend', 'selfFundedSpend', 'unattributedSpend', 'daysLeadToCommitment', 'daysCommitmentToFunds',
  'daysFundsToUsableCash', 'refundsAndChargebacks', 'receivables', 'peakWorkingCapital', 'restrictedCash',
] as const;
const TIMING = ['daysLeadToCommitment', 'daysCommitmentToFunds', 'daysFundsToUsableCash'] as const;

type Route = Record<string, unknown> & { routeKey: string; identities?: Record<string, unknown>; unknowns?: unknown };

/** Why one route's reading is impossible, or null. Pure. */
export function routeMoneyProblem(route: Route): string | null {
  for (const key of NON_NEGATIVE) {
    const v = route[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${key} is not a number`;
    if (v < 0) return `${key} is negative (${v})`;
  }
  const identities = route.identities;
  if (!identities || typeof identities !== 'object') return 'carries no cash identities';
  const keys = Object.keys(identities);
  if (keys.length < 9) return `carries ${keys.length} cash identities, not the nine`;
  for (const k of keys) {
    const v = identities[k];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) return `identity ${k} is not a number`;
  }
  const nulls = [...NON_NEGATIVE, 'peakWorkingCapital'].filter((k) => route[k] === null);
  if (nulls.length > 0 && (!Array.isArray(route.unknowns) || route.unknowns.length === 0)) {
    return `leaves ${nulls.join(', ')} unknown without saying why`;
  }
  return null;
}

export function routeMoneyDemonstrates(route: Route): boolean {
  const funded = typeof route.customerFundedSpend === 'number' || typeof route.selfFundedSpend === 'number';
  const timed = TIMING.some((k) => typeof route[k] === 'number');
  return funded && timed;
}

export async function moneyVelocityHoldsOnRows(): Promise<ProbeResult> {
  const ledgers = await getDb().all<{ project_id: string; currency: string }>(
    `SELECT DISTINCT project_id, currency FROM cash_money_entries ORDER BY project_id, currency`,
  );
  if (ledgers.length === 0) return { ok: null, detail: 'no money ledger row on production: no route to quantify yet' };
  const { readRouteMoney } = (await import('../../../quant/deadline.ts' as string)) as {
    readRouteMoney?: (input: { projectId: string; currency: string }) => Promise<Route[]>;
  };
  if (!readRouteMoney) return { ok: false, detail: 'the route money reader is not deployed in this Brain' };
  let routes = 0;
  let demonstrated = 0;
  for (const ledger of ledgers) {
    for (const route of await readRouteMoney({ projectId: ledger.project_id, currency: ledger.currency })) {
      routes += 1;
      const problem = routeMoneyProblem(route);
      if (problem) return { ok: false, detail: `route ${route.routeKey} (${ledger.currency}) ${problem}` };
      if (routeMoneyDemonstrates(route)) demonstrated += 1;
    }
  }
  if (demonstrated === 0) {
    return { ok: null, detail: `${routes} route(s) read cleanly, none yet measures both a funding split and a timing leg from its rows` };
  }
  return { ok: true, detail: `${routes} route(s) read from the ledger; ${demonstrated} measure customer- vs self-funded spend and lead→funds timing, each with the nine cash identities` };
}
