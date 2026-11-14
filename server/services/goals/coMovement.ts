/**
 * Measured co-movement between revenue streams (PORT-05, review finding F6).
 *
 * The portfolio's stream correlations were entirely assumed: one coefficient
 * for openings sharing the outreach, a hard-coded default for any other named
 * group, and zero for everything else. This reads how the openings' own money
 * actually moved together — the weekly cash each one took in, from the
 * append-only ledger (`cash_money_entries`, CUSTOMER_PAYMENT less REFUND) —
 * and gives a pair a measured coefficient only when both had activity over
 * enough overlapping weeks and both series varied. A pair the record cannot
 * measure stays assumed, and says so: a missing measurement is never read as
 * independence or as a known coefficient (invariant 39).
 *
 * It is a reader with a cache, not a store: nothing is written, and the goals
 * tick refreshes it (`refreshCoMovementIfDue`) so the synchronous portfolio
 * evaluation can read the last measurement (`cachedCoMovement`).
 */

/** Weeks of overlap two streams need before their co-movement is measured. */
export const MIN_CO_MOVEMENT_WEEKS = 8;
/** How far back the ledger is read. */
export const CO_MOVEMENT_WINDOW_WEEKS = 26;
/** A measured coefficient is bounded like the optimizer's: never a certainty. */
export const MAX_ABS_COEFFICIENT = 0.95;
/** How often the goals tick re-reads the ledger. */
export const CO_MOVEMENT_REFRESH_MS = 60 * 60_000;

const WEEK_MS = 7 * 86_400_000;

export interface CashObservation {
  opportunityId: string;
  /** ISO time the money moved. */
  at: string;
  /** Signed: money in is positive, a refund negative. */
  amount: number;
}

export interface MeasuredCoMovement {
  coefficient: number;
  /** Overlapping weeks the coefficient was computed over. */
  weeks: number;
  source: string;
}

export interface CoMovementReading {
  readAt: string;
  window: { since: string; until: string };
  pairs: Map<string, MeasuredCoMovement>;
  /** Openings with any cash in the window: the ones a pair could be measured for. */
  observed: number;
}

/** The key of an unordered pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 2) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Weekly co-movement of every pair of openings in `observations`. A stream's
 * series runs from the week of its first observation to `until`; two streams
 * are compared only over the weeks both were running, and only when that is at
 * least `minWeeks` and both series vary. Pure.
 */
export function measureCoMovement(
  observations: readonly CashObservation[],
  window: { since: string; until: string },
  minWeeks: number = MIN_CO_MOVEMENT_WEEKS,
): Map<string, MeasuredCoMovement> {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  const weeks = Math.max(0, Math.ceil((until - since) / WEEK_MS));
  const series = new Map<string, { first: number; values: number[] }>();
  for (const o of observations) {
    const at = Date.parse(o.at);
    if (!Number.isFinite(at) || at < since || at > until || !Number.isFinite(o.amount)) continue;
    const w = Math.min(weeks - 1, Math.floor((at - since) / WEEK_MS));
    if (w < 0) continue;
    const s = series.get(o.opportunityId) ?? { first: w, values: new Array<number>(weeks).fill(0) };
    s.first = Math.min(s.first, w);
    s.values[w] = (s.values[w] ?? 0) + o.amount;
    series.set(o.opportunityId, s);
  }
  const ids = [...series.keys()].sort();
  const out = new Map<string, MeasuredCoMovement>();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = series.get(ids[i]!)!;
      const b = series.get(ids[j]!)!;
      const start = Math.max(a.first, b.first);
      const overlap = weeks - start;
      if (overlap < minWeeks) continue;
      const r = pearson(a.values.slice(start), b.values.slice(start));
      if (r === null) continue;
      out.set(pairKey(ids[i]!, ids[j]!), {
        coefficient: Math.max(-MAX_ABS_COEFFICIENT, Math.min(MAX_ABS_COEFFICIENT, r)),
        weeks: overlap,
        source: `weekly cash in (customer payments less refunds) on the ledger, ${overlap} overlapping week(s)`,
      });
    }
  }
  return out;
}

let cache: CoMovementReading | null = null;
let lastRefresh = 0;

/** The last measurement the goals tick read, or null when none has been read. */
export function cachedCoMovement(): CoMovementReading | null {
  return cache;
}

/** Replace the cached measurement (the tick's refresh, and tests). */
export function setCoMovement(reading: CoMovementReading | null): void {
  cache = reading;
}

/** Read the ledger and measure every pair. Reads only. */
export async function readCoMovement(now: Date = new Date()): Promise<CoMovementReading> {
  const { getDb } = await import('../../db/database.ts');
  const until = now.toISOString();
  const since = new Date(now.getTime() - CO_MOVEMENT_WINDOW_WEEKS * WEEK_MS).toISOString();
  const rows = await getDb().all<{ opportunity_id: string; kind: string; amount_cents: number | string; occurred_at: string }>(
    `SELECT opportunity_id, kind, amount_cents, occurred_at FROM cash_money_entries
      WHERE opportunity_id IS NOT NULL AND kind IN ('CUSTOMER_PAYMENT', 'REFUND') AND occurred_at >= ? AND occurred_at <= ?`,
    [since, until],
  );
  const observations: CashObservation[] = rows.map((r) => ({
    opportunityId: r.opportunity_id,
    at: r.occurred_at,
    amount: (r.kind === 'REFUND' ? -1 : 1) * Number(r.amount_cents) / 100,
  }));
  const window = { since, until };
  return { readAt: until, window, pairs: measureCoMovement(observations, window), observed: new Set(observations.map((o) => o.opportunityId)).size };
}

/** At most once per `CO_MOVEMENT_REFRESH_MS`, from the goals tick. A failure keeps the last reading and is returned, never thrown. */
export async function refreshCoMovementIfDue(nowMs: number = Date.now(), read: (now: Date) => Promise<CoMovementReading> = readCoMovement): Promise<CoMovementReading | { error: string } | null> {
  if (nowMs - lastRefresh < CO_MOVEMENT_REFRESH_MS) return null;
  lastRefresh = nowMs;
  try {
    cache = await read(new Date(nowMs));
    return cache;
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}
