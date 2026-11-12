/**
 * The RunPod account's money, read from RunPod (§108): the balance, what it is
 * spending per hour, and how long the balance lasts at that rate.
 *
 * Production, 2026-11-12: balance $15.48 at $0.196/h — about 79 hours. RunPod
 * deletes every pod when the balance reaches zero (2026-11-10), so the runway
 * is the number that decides whether a GPU change is affordable at all.
 */
import type { Fetch } from './runpod.ts';

export interface AccountReading {
  balance: number | null;
  spendPerHour: number | null;
  /** Hours the balance lasts at the current spend; null when either is unknown or nothing is spent. */
  runwayHours: number | null;
  error: string | null;
}

export function runway(balance: number | null, spendPerHour: number | null): number | null {
  if (balance === null || spendPerHour === null || spendPerHour <= 0) return null;
  return balance / spendPerHour;
}

export async function accountReading(apiKey: string, fetchImpl: Fetch = fetch): Promise<AccountReading> {
  try {
    const res = await fetchImpl('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: '{ myself { clientBalance currentSpendPerHr } }' }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number } }; errors?: { message: string }[] };
    const me = body.data?.myself;
    if (!me) return { balance: null, spendPerHour: null, runwayHours: null, error: body.errors?.[0]?.message ?? `HTTP ${res.status}` };
    const balance = Number.isFinite(Number(me.clientBalance)) ? Number(me.clientBalance) : null;
    const spend = Number.isFinite(Number(me.currentSpendPerHr)) ? Number(me.currentSpendPerHr) : null;
    return { balance, spendPerHour: spend, runwayHours: runway(balance, spend), error: null };
  } catch (error) {
    return { balance: null, spendPerHour: null, runwayHours: null, error: (error as Error).message };
  }
}
