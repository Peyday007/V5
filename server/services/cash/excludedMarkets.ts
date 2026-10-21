/**
 * Markets the owner has ruled out of Cash Mode, as code rather than as prose.
 *
 * Both rules below lived only as operator text pasted into every discovery
 * question. A worker can read past a sentence; it cannot read past a filter.
 * On 2026-10-21 a Navy solicitation listed on SAM.gov was researched as fast
 * cash although nobody here holds a SAM registration, which is exactly the
 * failure a sentence permits.
 *
 * * **Federal contract bids.** Bidding on a U.S. federal solicitation needs an
 *   active SAM.gov registration (a Unique Entity ID), and none is held. The
 *   registration takes weeks, so a federal bid is never fast cash here. An
 *   opening whose source is a federal procurement portal, or whose own text
 *   says the bid goes through SAM.gov, is out.
 * * **The owner's home metros.** Cash Mode does not target Detroit or
 *   Cleveland: the owner is moving his work away from his local area. An
 *   opening whose own text places it in either city is out.
 *
 * A reviewed constant in both cases: widening or narrowing either list is a
 * code change somebody reads, not a setting a session can flip. Neither rule
 * says anything about where money is reachable in general (§38) — only where
 * the owner has decided not to look.
 */
import type { CashOpportunity } from '../../domain/types.ts';

/** Hosts whose pages are U.S. federal procurement listings or registrations. */
export const FEDERAL_PROCUREMENT_HOSTS: readonly string[] = Object.freeze([
  'sam.gov',
  'fpds.gov',
  'grants.gov',
  'ebuy.gsa.gov',
  'gsaadvantage.gov',
  'fbo.gov',
]);

/** Text that says a bid needs a federal vendor registration this company does not hold. */
const FEDERAL_REGISTRATION_TEXT = /\bsam\.gov\b|\bunique entity id(?:entifier)?\b|\bsystem for award management\b/i;

/** Cities the owner has excluded, matched as whole words. */
export const EXCLUDED_CITIES: readonly string[] = Object.freeze(['Detroit', 'Cleveland']);

const EXCLUDED_CITY_TEXT = new RegExp(`\\b(${EXCLUDED_CITIES.join('|')})\\b`, 'i');

export type ExcludedMarket =
  | { kind: 'FEDERAL_BID'; evidence: string }
  | { kind: 'EXCLUDED_CITY'; city: string };

/** Whether a URL's host is, or sits under, a federal procurement host. */
export function federalProcurementHost(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const name of FEDERAL_PROCUREMENT_HOSTS) {
    if (host === name || host.endsWith(`.${name}`)) return name;
  }
  return null;
}

/** The opening's own words: everything a person or worker wrote about it. */
function textOf(opportunity: CashOpportunity): string {
  return [
    opportunity.title,
    opportunity.industry,
    opportunity.source,
    opportunity.payer,
    opportunity.reachableChannel,
    opportunity.buyingSignal,
    opportunity.offerScope,
  ]
    .filter((one): one is string => typeof one === 'string' && one.length > 0)
    .join('\n');
}

/**
 * The first owner rule this opening breaks, or null.
 *
 * Pure. `sourceUrl` is the source claim's URL where the caller has it; the
 * opening's own text is always read.
 */
export function excludedMarket(opportunity: CashOpportunity, sourceUrl?: string | null): ExcludedMarket | null {
  const host = federalProcurementHost(sourceUrl) ?? federalProcurementHost(opportunity.source);
  if (host) return { kind: 'FEDERAL_BID', evidence: `its source is ${host}` };
  const text = textOf(opportunity);
  const registration = FEDERAL_REGISTRATION_TEXT.exec(text);
  if (registration) return { kind: 'FEDERAL_BID', evidence: `it names ${registration[0]}` };
  const city = EXCLUDED_CITY_TEXT.exec(text);
  if (city) {
    const name = EXCLUDED_CITIES.find((one) => one.toLowerCase() === city[1]!.toLowerCase()) ?? city[1]!;
    return { kind: 'EXCLUDED_CITY', city: name };
  }
  return null;
}

export function describeExcludedMarket(reason: ExcludedMarket): string {
  switch (reason.kind) {
    case 'FEDERAL_BID':
      return (
        `a federal contract bid (${reason.evidence}) — bidding needs a SAM.gov registration this company ` +
        'does not hold, and registering takes weeks, so it is not fast cash'
      );
    case 'EXCLUDED_CITY':
      return `it targets ${reason.city}, which the owner has ruled out of Cash Mode`;
  }
}
