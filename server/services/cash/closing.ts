/**
 * Whether an opening's recorded closing date has passed.
 *
 * Its own module because two readers that import each other need it: the
 * engine card (which caps a closed opening) and the deep-dive eligibility in
 * `validation.ts` (which refuses to dive one).
 *
 * The column is free text, so only an ISO date or timestamp is read: anything
 * else is unknown, never closed. A bare date closes at the end of that UTC day,
 * not at its first second — which errs a few hours towards open for a deadline
 * stated in American time, so the cost is at most one more look, never a
 * deadline reported as passed before it has.
 */
export function closedBy(expiresAt: string | null, now: string): boolean {
  if (!expiresAt) return false;
  const value = expiresAt.trim();
  let closes: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) closes = Date.parse(`${value}T23:59:59.999Z`);
  else if (/^\d{4}-\d{2}-\d{2}T/.test(value)) closes = Date.parse(value);
  else return false;
  if (!Number.isFinite(closes)) return false;
  return closes <= Date.parse(now);
}
