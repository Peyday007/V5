/**
 * A route is assembled from the answer that found it, not re-researched from blank.
 *
 * A goal's discovery round asks, for each way money could be made, who pays,
 * what they are shown paying, how they are reached, who does the work, what it
 * costs, how many such buyers there are and when the money settles. A worker
 * answers in several claims — one per evidence lane — because each part has its
 * own standard of evidence. The harvest then filed the one claim that carried an
 * `opportunity_signal` as an opening and left every sibling behind: the price,
 * the fulfiller, the market's size and the payment terms the same report had
 * just established. Production, 2026-11-24: 0 of 46 fresh requests reached a
 * usable plan, every goal held openings titled "buyer not yet named", and each
 * card field was then researched again from scratch by its own mission
 * (docs/PLANNING-9-10-INVESTIGATION-2026-11-24.md; trace break points 1–3).
 *
 * So, right after the harvest files an opening, the accepted claims of the same
 * research fragment that are about the same route are written onto that
 * opening's card as EVIDENCE, through the one writer every research answer uses
 * (`writeEvidenceAnswer`). Which field a claim answers is its declared lane — a
 * column, never read from its prose — and which route it is about is decided by
 * what the claims themselves state:
 *
 *   - the same buyer population (`population`), or
 *   - the same source (`sourceUrl`), or
 *   - the fragment established exactly one opening, so its answer is about it.
 *
 * A claim about another route of the same answer is left for that route. Nothing
 * is estimated or inferred: a part no claim states stays unknown, and the
 * planner's own links still decide whether the route is complete. An earlier
 * answer is never replaced (`mayReplace`), so a second report cannot overwrite
 * what the first established.
 */
import { citableClaims } from '../../repos/research.ts';
import { namesABuyerPopulation } from '../../domain/industry.ts';
import type { CashOpportunity, ResearchClaim } from '../../domain/types.ts';
import { writeEvidenceAnswer } from './answers.ts';
import { updateOpportunity } from '../../repos/cashPortfolio.ts';
import { brainProduces } from '../goals/pathways.ts';
import { DELIVERABLE_KINDS, DELIVERABLE_LABEL } from './deliverables/spec.ts';
import { deliverableCapabilityId } from './capabilities.ts';

/**
 * The card field each route lane answers (compiler profile `GOAL_MECHANISM`).
 *
 * `economics` is the inherited discovery lane: what it pays, as a published
 * price or rate, read as the revenue range the planner takes the low end of.
 * The `route_*` lanes are the parts of a route the goal's question asks for and
 * no lane used to carry.
 */
export const ROUTE_FIELD_BY_LANE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // What these buyers are shown paying: the price (its low figure, `figureFor`), the published range the
  // plan reads, and the economics `proposeTerms` quotes from. A claim of the same population only (`sameRoute`).
  economics: ['price', 'revenueRange', 'economics'],
  route_channel: ['access'],
  route_fulfiller: ['fulfillment'],
  route_cost: ['directCosts'],
  route_effort: ['hours'],
  route_volume: ['buyerVolume'],
  route_settlement: ['timeToFirstCash'],
});

/** A buyer population, compared as words: case, punctuation and plural ending ignored. */
export function populationKey(text: string | null | undefined): string | null {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'who', 'that', 'their'].includes(w))
    .map((w) => w.replace(/ies$/, 'y').replace(/(s|x|z|ch|sh)es$/, '$1').replace(/([^s])s$/, '$1'));
  return words.length ? [...new Set(words)].sort().join(' ') : null;
}

/**
 * Whether a sibling claim of the same fragment is about the route `claim` established. Pure.
 *
 * The route the worker named on each claim decides first: the same name is the same way,
 * a different name is another. A claim's `population` is its fragment's declared scope
 * (`submission.ts`), the same for every claim of one answer, so it decides only where it
 * differs. Without either, the same source joins, and a fragment that found exactly one
 * way owns its unnamed claims.
 */
export function sameRoute(
  claim: Pick<ResearchClaim, 'id' | 'population' | 'sourceUrl'> & { route?: string | null },
  sibling: Pick<ResearchClaim, 'id' | 'population' | 'sourceUrl'> & { route?: string | null },
  openingsInFragment: number,
): boolean {
  if (sibling.id === claim.id) return false;
  const ra = populationKey(claim.route);
  const rb = populationKey(sibling.route);
  if (ra && rb) return ra === rb;
  const a = populationKey(claim.population);
  const b = populationKey(sibling.population);
  if (a && b && a !== b) return false;
  if (claim.sourceUrl && sibling.sourceUrl && claim.sourceUrl === sibling.sourceUrl) return true;
  // A sibling naming another route is about that route; one naming none belongs to the fragment's only opening.
  return openingsInFragment === 1 && !rb;
}

/** The kind of buyer a route name leads with ("Michigan dental practices · HIPAA risk assessment"), or null. Pure. */
export function routeBuyer(route: string | null | undefined): string | null {
  const head = (route ?? '').split(/\s+[·|—–-]\s+/)[0]?.trim() ?? '';
  return head && namesABuyerPopulation(head) ? head : null;
}

export interface JoinedRouteEvidence {
  /** Fields written, with the claim each rests on. */
  written: { field: string; claimId: string }[];
}

/**
 * Write the route parts the opening's own research fragment established onto
 * its card (see the module comment). Best-effort per field: a field that cannot
 * be written (no figure in a money claim, an earlier answer stands) is skipped.
 */
export async function joinRouteEvidence(input: {
  opportunity: CashOpportunity;
  claim: ResearchClaim;
  orchestrationId: string;
  fragmentId: string | null;
  /** The deliverable kinds Brain has proved it produces here (`executionFrame().delivers`). */
  delivers?: readonly string[];
}): Promise<JoinedRouteEvidence> {
  const written: JoinedRouteEvidence['written'] = [];
  if (!input.fragmentId) return { written };
  const fragment = (await citableClaims(input.orchestrationId)).filter((one) => one.fragmentId === input.fragmentId && one.sourceUrl);
  const openings = fragment.filter((one) => one.opportunitySignal && one.claimType !== 'NEGATIVE_EXISTENCE').length;

  // Who pays: the buyer the route names (its part before "·"), else the fragment's population, where it is
  // a kind of buyer a list can be built of.
  const population = routeBuyer(input.claim.route) ?? (input.claim.population ?? '').trim();
  if (population && namesABuyerPopulation(population)) {
    const payerClaim = { ...input.claim, claim: population };
    if (await writeEvidenceAnswer({ opportunity: input.opportunity, field: 'payer', claim: payerClaim, needId: null })) {
      written.push({ field: 'payer', claimId: input.claim.id });
    }
  }

  for (const sibling of fragment) {
    const fields = sibling.evidenceLane ? ROUTE_FIELD_BY_LANE[sibling.evidenceLane] : undefined;
    if (!fields) continue;
    if (!sameRoute(input.claim, sibling, openings)) continue;
    for (const field of fields) {
      if (written.some((one) => one.field === field)) continue;
      if (await writeEvidenceAnswer({ opportunity: input.opportunity, field, claim: sibling, needId: null })) {
        written.push({ field, claimId: sibling.id });
      }
    }
  }
  /*
   * Who does the work, where it is a deliverable Brain has proved it produces (2026-11-25).
   * A research answer cannot establish that — it is a fact about Brain, not the market — so
   * a route whose offer is, by its own words, a kind of deliverable Brain has proved (a
   * document, a spreadsheet, a data set, a website…) requires that capability, exactly as
   * a play bucket's opening does, and the plan reads Brain as its fulfiller from Brain's own
   * proof. An offer that names no proved kind is left to research and to a named fulfiller.
   */
  if (input.opportunity.requiredCapabilities.length === 0 && input.delivers && input.delivers.length > 0) {
    const offer = routeOffer(input.claim.route);
    const label = brainProduces(`${offer ?? ''} ${input.claim.route ?? ''} ${input.claim.claim}`, { delivers: [...input.delivers], puzzleFormats: [] });
    const kind = label ? DELIVERABLE_KINDS.find((one) => DELIVERABLE_LABEL[one] === label) : undefined;
    if (kind) {
      await updateOpportunity(input.opportunity.id, { required_capabilities: JSON.stringify([deliverableCapabilityId(kind)]) } as never);
      written.push({ field: 'requiredCapabilities', claimId: input.claim.id });
    }
  }
  return { written };
}

/** What a route name says its buyers pay for (its part after "·"), or null. Pure. */
export function routeOffer(route: string | null | undefined): string | null {
  const parts = (route ?? '').split(/\s+[·|—–]\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ').trim() || null : null;
}
