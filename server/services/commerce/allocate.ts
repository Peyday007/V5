/**
 * Which commerce question is next, and why (§73).
 *
 * ---------------------------------------------------------------------------
 * Finishing a product outranks finding another
 * ---------------------------------------------------------------------------
 *
 * A product with a supplier and a price is one question from knowing whether
 * it can pay for its own advertising, and the research that got it there is
 * already spent. A broad search for more products is the cheapest question to
 * start and the furthest from a sale, so it goes last — and it still runs
 * whenever nothing narrower is waiting, which is what keeps this an ordering
 * rather than a ceiling. §38 records getting this the other way round.
 *
 * Within finishing, the order is the ladder read backwards: what one order
 * costs (COSTS), then what it sells for (PRICE), then who supplies it (SOURCE),
 * then a qualified product's niche (NICHE).
 *
 * ---------------------------------------------------------------------------
 * A bounded front, not every product ever named
 * ---------------------------------------------------------------------------
 *
 * Only the strongest `MAX_PRODUCTS_PURSUED` products get follow-up questions:
 * the most independent recent demand sources first, then the most recent
 * signal. A discovery round names a dozen products; researching every one of
 * them to the bottom would spend the fleet on the weakest. The rest are kept,
 * reported as declined with the reason, and move up the moment new evidence
 * puts them ahead.
 *
 * ---------------------------------------------------------------------------
 * Pure over a recorded snapshot, and useless as a safety mechanism
 * ---------------------------------------------------------------------------
 *
 * Two ticks can both decide correctly and both try. The exclusion is the
 * unique index on `commerce_rounds`; a loser is an ordinary outcome.
 */
import { isPursuable, type ProductStanding } from './standing.ts';
import type { CommerceRound, CommerceRoundPurpose } from '../../domain/types.ts';
import type { CommerceSnapshot } from './graph.ts';

/** How many of this kernel's questions may be live at once, across the project. */
export const MAX_OPEN_COMMERCE_ROUNDS = 3;

/** How many products may be pursued past discovery at once. */
export const MAX_PRODUCTS_PURSUED = 6;

/** How long after a round settles before the same question may be asked again. */
export const ROUND_COOL_OFF_MS = 6 * 60 * 60 * 1000;

/** How many times one question may come back with nothing before it is retired. */
export const BARREN_ROUNDS = 2;

export interface Ask {
  purpose: CommerceRoundPurpose;
  productKey: string | null;
  /** The product as it is spelled, for the question that must name it verbatim. */
  productName: string | null;
  round: number;
  why: string;
  rank: number;
}

export interface Declined {
  subject: string;
  why: string;
}

interface Candidate {
  purpose: CommerceRoundPurpose;
  product: ProductStanding | null;
  why: string;
}

export function allocate(input: {
  snapshot: CommerceSnapshot;
  slots: number;
  now?: number;
}): { asks: Ask[]; declined: Declined[] } {
  const { snapshot } = input;
  const now = input.now ?? Date.now();
  const asks: Ask[] = [];
  const declined: Declined[] = [];

  const front = pursued(snapshot.standing);
  for (const product of snapshot.standing) {
    if (!isPursuable(product.stage) || product.stage === 'ON_MAP' || product.stage === 'STALE') continue;
    if (front.some((one) => one.productId === product.productId)) continue;
    declined.push({
      subject: product.name,
      why:
        `Not among the ${MAX_PRODUCTS_PURSUED} strongest products (${product.demandSources} recent ` +
        'demand source(s)). It moves up when new evidence puts it ahead.',
    });
  }

  const ordered: Candidate[] = [...finishing(front), discover(snapshot)];

  let rank = 0;
  for (const candidate of ordered) {
    rank += 1;
    const subject = candidate.product
      ? `${candidate.purpose} for ${candidate.product.name}`
      : `${candidate.purpose} for products selling now`;
    if (asks.length >= Math.max(0, input.slots)) {
      declined.push({
        subject,
        why:
          `No free slot: ${snapshot.openRounds} of ${MAX_OPEN_COMMERCE_ROUNDS} question(s) are ` +
          'already live. This is next when one settles.',
      });
      continue;
    }
    const productKey = candidate.product?.productKey ?? null;
    const history = snapshot.rounds.filter(
      (one) => one.purpose === candidate.purpose && one.productKey === productKey,
    );
    const live = history.find((one) => one.state === 'OPEN');
    if (live) {
      declined.push({ subject, why: `Already being asked: round ${live.round} is open (${live.id}).` });
      continue;
    }
    const settled = history.filter((one) => one.state !== 'OPEN');
    const barren = settled.filter((one) => (one.found ?? 0) === 0);
    if (barren.length >= BARREN_ROUNDS) {
      declined.push({
        subject,
        why:
          `Asked ${barren.length} time(s) and nothing was established. Asking again spends the ` +
          'allowance to learn what Brain’s own history already says.',
      });
      continue;
    }
    const cooling = coolingUntil(settled, now);
    if (cooling !== null) {
      declined.push({
        subject,
        why: `A round settled recently; not re-asked until ${new Date(cooling).toISOString()}.`,
      });
      continue;
    }
    asks.push({
      purpose: candidate.purpose,
      productKey,
      productName: candidate.product?.name ?? null,
      round: history.length + 1,
      why: candidate.why,
      rank,
    });
  }
  return { asks, declined };
}

/** The products worth following up, strongest first. */
export function pursued(standing: readonly ProductStanding[]): ProductStanding[] {
  return standing
    .filter((one) => isPursuable(one.stage) && one.stage !== 'ON_MAP' && one.stage !== 'STALE')
    .sort(
      (a, b) =>
        b.demandSources - a.demandSources ||
        (b.latestDemandOn ?? '').localeCompare(a.latestDemandOn ?? '') ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MAX_PRODUCTS_PURSUED);
}

function finishing(front: readonly ProductStanding[]): Candidate[] {
  const out: Candidate[] = [];
  for (const product of front) {
    if (product.stage === 'PRICED' || (product.stage === 'COSTED' && product.economics.supplier?.days === null)) {
      out.push({
        purpose: 'COSTS',
        product,
        why:
          `${product.name} has a supplier and a price; what one order costs is not settled ` +
          `(${product.economics.withheld ?? 'no published delivery time'}). That is one question ` +
          'from knowing what it can spend to win a customer.',
      });
    }
  }
  for (const product of front) {
    if (product.stage === 'SOURCED') {
      out.push({
        purpose: 'PRICE',
        product,
        why: `${product.name} has a supplier offer and no published retail price or competitor.`,
      });
    }
  }
  for (const product of front) {
    if (product.stage === 'DEMAND_SEEN') {
      out.push({
        purpose: 'SOURCE',
        product,
        why:
          `${product.name} is selling now (${product.demandSources} source(s)) and nobody has ` +
          'established who would ship it or at what unit cost.',
      });
    }
  }
  for (const product of front) {
    if (product.stage === 'DEMAND_SEEN') {
      out.push({
        purpose: 'PRICE',
        product,
        why: `${product.name} is selling now and its published retail prices are not on the map.`,
      });
    }
  }
  for (const product of front) {
    if (product.stage === 'QUALIFIED' && product.niches.length === 0 && product.complaints.length === 0) {
      out.push({
        purpose: 'NICHE',
        product,
        why:
          `${product.name} qualifies and nothing establishes a sub-audience or a complaint to ` +
          'build a better angle on. Selling the same thing as everyone else is the weakest position.',
      });
    }
  }
  return out;
}

/**
 * The broad question, last and never removed: the only one here that reaches
 * outside what is already on the map (§39's correction).
 */
function discover(snapshot: CommerceSnapshot): Candidate {
  const asked = snapshot.rounds.filter((one) => one.purpose === 'DISCOVER').length;
  return {
    purpose: 'DISCOVER',
    product: null,
    why:
      snapshot.products.length === 0
        ? 'Nothing is on the map yet, so the first question is which products are selling now.'
        : `${snapshot.products.length} product(s) are on the map from ${asked} earlier round(s). ` +
          'This is the only question that finds new ones.',
  };
}

function coolingUntil(settled: readonly CommerceRound[], now: number): number | null {
  let latest = 0;
  for (const one of settled) {
    const at = one.settledAt ? Date.parse(one.settledAt) : 0;
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest === 0) return null;
  const until = latest + ROUND_COOL_OFF_MS;
  return until > now ? until : null;
}
