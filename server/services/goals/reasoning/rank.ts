/**
 * The one number a ranker reads from an input (invariant 39, lens S S-5).
 *
 * Every place that orders openings before the engine sees them — §99's default
 * operator target, §101's TOP/REST/FOCUS scopes and seeds, §102's channel
 * targets — used to read an input at the middle of its range. An estimated
 * arrangement's close rate nobody has measured is swept 2–50%; its middle
 * (26%) outranked an evidenced 5–25% (15%), so the least-known candidate was
 * ranked first and every move was pointed at it.
 *
 * A ranker now reads a figure somebody established (a stated value, or a
 * range that is EVIDENCE or HISTORICAL, or a justified inference) at its
 * middle, and anything else — an UNKNOWN sweep, an ASSUMPTION — at the low end
 * of what it might be (its low bound, or its p10). Not knowing a figure never
 * moves a candidate up. This ranks; it never values a plan, which the engine
 * still reads over the whole range.
 */
import type { ModelInput, ModelledOpportunity } from '../../cash/goalScenario.ts';

export function rankValue(x: ModelInput): number | null {
  if (x.value !== null) return x.value;
  const established = x.provenance === 'EVIDENCE' || x.provenance === 'HISTORICAL' || !!x.inferred?.justified;
  if (established) {
    if (x.inferred) return x.inferred.p50;
    if (x.low !== null && x.high !== null) return (x.low + x.high) / 2;
    return x.low ?? x.high ?? null;
  }
  return x.low ?? x.inferred?.p10 ?? x.high ?? null;
}

/** What one interested buyer is worth, read for ranking: price × close, unknowns at their low end. */
export function valuePerInterested(o: Pick<ModelledOpportunity, 'price' | 'close'>): number {
  return (rankValue(o.price) ?? 0) * (rankValue(o.close) ?? 0);
}

/** What one contact is worth, read for ranking: price × close × reply, unknowns at their low end. */
export function valuePerContact(o: Pick<ModelledOpportunity, 'price' | 'close' | 'respond'>): number {
  return valuePerInterested(o) * (rankValue(o.respond) ?? 0);
}
