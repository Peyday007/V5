/**
 * How a goal's openings have actually moved together (PORT-05, finding F6).
 *
 * The streams reading used to state every correlation as an assumption: the
 * same risk group took a configured coefficient and everything else zero. The
 * ledger holds what each opening's buyers actually paid, dated, so for a pair
 * with enough shared history the co-movement is a measurement, not a guess.
 *
 * This reads rows and writes nothing. The arithmetic is `measureCoMovement` in
 * `streams.ts`, so the reading and the measurement cannot disagree.
 */
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { measureCoMovement, type MeasuredCoMovement } from './streams.ts';

/** The ledger kind that is a buyer's money arriving — the stream's own outcome. */
export const CO_MOVEMENT_KIND = 'CUSTOMER_PAYMENT' as const;

export const CO_MOVEMENT_SOURCE = `cash_money_entries (kind = ${CO_MOVEMENT_KIND}), weekly by occurred_at`;

/** Each opening's dated customer payments in the goal's currency, and the pairwise co-movement they show. */
export async function readCoMovement(input: { projectId: string; currency: string; opportunityIds: readonly string[]; now: Date }): Promise<MeasuredCoMovement[]> {
  const ids = [...new Set(input.opportunityIds)];
  if (ids.length < 2) return [];
  const series = new Map<string, Array<{ at: string; amount: number }>>();
  for (const id of ids) {
    const entries = await listMoneyEntries({ projectId: input.projectId, opportunityId: id, currency: input.currency, limit: 2000 });
    series.set(
      id,
      entries.filter((e) => e.kind === CO_MOVEMENT_KIND).map((e) => ({ at: e.occurredAt, amount: e.amountCents })),
    );
  }
  return measureCoMovement(series, { now: input.now, source: CO_MOVEMENT_SOURCE });
}
