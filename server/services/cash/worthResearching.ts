/**
 * Whether an opening is worth spending research on now, read from its own rows.
 *
 * Production, 2026-10-21: 340 openings, 269 deep dives, one qualified — and
 * that one was a broker's own fee schedule ($5 membership against an $800
 * deposit) read as revenue. The dives had gone to three kinds of opening no
 * answer could make executable:
 *
 *   * **a freelance-marketplace listing.** Its payer is the client and its
 *     route is the platform's escrow, and this operation takes no freelance
 *     work, so a dive there buys an answer nobody could act on.
 *   * **an opening that closes before a dive could finish** and a person could
 *     act on what it found. A dive runs for hours to a day, and the first
 *     external step needs a grant and a send after that.
 *
 * A third used to be here — an asset to buy that the ledger cannot pay for —
 * and it was removed on 2026-10-28. It refused research on every resale
 * opening while deployable cash was zero, so a whole family of openings could
 * never be qualified, and research is reading, not spending: what an asset
 * costs, whether it can be sold before it is paid for, or bought by somebody
 * else for a fee, is exactly what a dive establishes. Capital is still asked
 * where it binds — `beginExecution` refuses to start what deployable cash
 * cannot cover — exactly as it always was for a service with an exposure.
 *
 * Neither deletes, archives or reclassifies anything, and neither is stored.
 * Each is derived on every read, so it lifts by itself when the row it reads
 * changes, and an opening is never refused for a host it does not name. §65's
 * rule holds: not being able to act today is a named gap, never a reason to
 * drop an opening.
 */
import { getClaim } from '../../repos/research.ts';
import type { CashOpportunity } from '../../domain/types.ts';

/**
 * Hosts whose pages are individual freelance-marketplace listings.
 *
 * Matched on the host's registered name, any subdomain and any country domain
 * (`upwork.com`, `www.peopleperhour.co.uk`). A reviewed constant: adding a
 * marketplace here is a code change somebody reads.
 */
export const MARKETPLACE_HOSTS: readonly string[] = Object.freeze([
  'freelancer',
  'peopleperhour',
  'upwork',
  'fiverr',
  'guru',
  'truelancer',
  'workana',
]);

/** How long before its recorded close an opening stops being worth a dive. */
export const DIVE_RUNWAY_MS = 72 * 60 * 60 * 1000;

/** The marketplace a source URL is a listing on, or null. */
export function marketplaceOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  for (const name of MARKETPLACE_HOSTS) {
    // `upwork.com`, `www.fiverr.ie`, `guru.co.uk` — the name is
    // a whole label, followed only by a public suffix.
    const at = labels.indexOf(name);
    if (at >= 0 && at < labels.length - 1 && labels.slice(at + 1).length <= 2 && labels.slice(at + 1).every((one) => one.length <= 3)) {
      return name;
    }
  }
  return null;
}

/** Whether a recorded closing date falls within the runway. Unknown dates are never "soon". */
export function closesWithin(expiresAt: string | null, now: string, runwayMs = DIVE_RUNWAY_MS): boolean {
  if (!expiresAt) return false;
  const value = expiresAt.trim();
  let closes: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) closes = Date.parse(`${value}T23:59:59.999Z`);
  else if (/^\d{4}-\d{2}-\d{2}T/.test(value)) closes = Date.parse(value);
  else return false;
  if (!Number.isFinite(closes)) return false;
  return closes - Date.parse(now) < runwayMs;
}

export type NotWorthResearching =
  | { kind: 'MARKETPLACE_LISTING'; marketplace: string }
  | { kind: 'CLOSES_TOO_SOON'; at: string };

export function describeNotWorthResearching(reason: NotWorthResearching): string {
  switch (reason.kind) {
    case 'MARKETPLACE_LISTING':
      return 'a freelance-marketplace listing — this operation takes no freelance work, so nothing a dive found could be acted on';
    case 'CLOSES_TOO_SOON':
      return `it closes ${reason.at}, sooner than a dive could finish and the first step be taken`;
  }
}

/**
 * The first reason this opening is not worth researching now, or null.
 * Capital is not one of them: it decides whether work may begin, never
 * whether it may be researched.
 */
export async function notWorthResearching(
  opportunity: CashOpportunity,
  context: { now: string },
): Promise<NotWorthResearching | null> {
  if (opportunity.sourceClaimId) {
    const claim = await getClaim(opportunity.sourceClaimId);
    const marketplace = marketplaceOf(claim?.sourceUrl);
    if (marketplace) return { kind: 'MARKETPLACE_LISTING', marketplace };
  }
  if (closesWithin(opportunity.expiresAt, context.now)) {
    return { kind: 'CLOSES_TOO_SOON', at: opportunity.expiresAt! };
  }
  return null;
}
