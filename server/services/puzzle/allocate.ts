/**
 * Which puzzle question is next, and why.
 *
 * ---------------------------------------------------------------------------
 * Finishing outranks starting, and that ordering is the whole design
 * ---------------------------------------------------------------------------
 *
 * §38 records making this ordering the other way round and correcting it, and
 * the argument is the same here: the research that found a format has already
 * been paid for, and a format with a compiled product and no route to a buyer
 * is *one question* from being sellable. A broad search for more formats is
 * the cheapest thing to start and the furthest from money, so it goes last —
 * and it still runs whenever nothing narrower is waiting, which is what stops
 * this being a ceiling rather than an ordering.
 *
 * ---------------------------------------------------------------------------
 * Pure over a recorded snapshot, and useless as a safety mechanism
 * ---------------------------------------------------------------------------
 *
 * Deliberately. `router.ts` draws the line first: being pure is what makes
 * *why did Brain research that* answerable afterwards from a recorded input,
 * and it also means two ticks can both decide correctly and both try. The
 * exclusion is the unique index on `puzzle_rounds`, and a loser is an ordinary
 * outcome rather than an error.
 *
 * ---------------------------------------------------------------------------
 * It stops, and every bound is a bound rather than a preference
 * ---------------------------------------------------------------------------
 *
 * One live round per question per format, a cool-off on a settled one, and a
 * question asked `BARREN_ROUNDS` times for nothing is not asked again —
 * because Brain has documented that there is nothing there, and §13's rule
 * about not researching what the archive already answers applies to Brain's
 * own history. What is **not** here is a lifetime quota: §24 removed exactly
 * that kind of number and recorded why, and what bounds this is how many
 * questions may be open at once, which is real provider capacity.
 */
import { PUZZLE_PRODUCT_CLASSES } from '../../domain/puzzle.ts';
import type { PuzzleProductClass, PuzzleRound, PuzzleRoundPurpose } from '../../domain/types.ts';
import type { FormatView, PuzzleSnapshot } from './graph.ts';
import type { UnitEconomics } from './economics.ts';

/** How many of this kernel's questions may be live at once, across the project. */
export const MAX_OPEN_PUZZLE_ROUNDS = 3;

/** How long after a round settles before the same question may be asked again. */
export const ROUND_COOL_OFF_MS = 6 * 60 * 60 * 1000;

/** How many times one question may come back with nothing before it is retired. */
export const BARREN_ROUNDS = 2;

export interface Ask {
  purpose: PuzzleRoundPurpose;
  formatKey: string | null;
  /** The format as it is spelled, for the question that must name it verbatim. */
  formatName: string | null;
  productClass: PuzzleProductClass | null;
  round: number;
  /** The allocator's own reason, recorded beside the work it produces. */
  why: string;
  /** Where it came in the ordering. Recorded, never compared to a threshold. */
  rank: number;
}

export interface Declined {
  subject: string;
  why: string;
}

export interface Allocation {
  asks: Ask[];
  declined: Declined[];
}

interface Candidate {
  purpose: PuzzleRoundPurpose;
  format: FormatView | null;
  productClass: PuzzleProductClass | null;
  why: string;
}

export function allocate(input: {
  snapshot: PuzzleSnapshot;
  economics: readonly UnitEconomics[];
  slots: number;
  now?: number;
}): Allocation {
  const { snapshot } = input;
  const now = input.now ?? Date.now();
  const declined: Declined[] = [];
  const asks: Ask[] = [];

  const ordered: Candidate[] = [
    ...finishing(snapshot, input.economics),
    ...starting(snapshot),
  ];

  let rank = 0;
  for (const candidate of ordered) {
    rank += 1;
    const subject = describe(candidate);
    if (asks.length >= Math.max(0, input.slots)) {
      declined.push({
        subject,
        why:
          `No free slot: ${snapshot.openRounds} of ${MAX_OPEN_PUZZLE_ROUNDS} question(s) are ` +
          'already live. This is next when one settles.',
      });
      continue;
    }

    const formatKey = candidate.format?.key ?? null;
    const history = snapshot.rounds.filter(
      (one) =>
        one.purpose === candidate.purpose &&
        one.formatKey === formatKey &&
        one.productClass === candidate.productClass,
    );

    const live = history.find((one) => one.state === 'OPEN');
    if (live) {
      declined.push({
        subject,
        why: `Already being asked: round ${live.round} is open (${live.id}).`,
      });
      continue;
    }

    const settled = history.filter((one) => one.state === 'SETTLED');
    const barren = settled.filter((one) => (one.found ?? 0) === 0);
    if (barren.length >= BARREN_ROUNDS) {
      declined.push({
        subject,
        why:
          `Asked ${barren.length} time(s) and nothing was established. Brain has documented ` +
          'that there is nothing there, and asking again spends the allowance to learn what ' +
          'its own history already says.',
      });
      continue;
    }

    const cooling = coolingUntil(settled, now);
    if (cooling !== null) {
      declined.push({
        subject,
        why:
          `A round settled recently; the same question is not re-asked until ${new Date(
            cooling,
          ).toISOString()}.`,
      });
      continue;
    }

    asks.push({
      purpose: candidate.purpose,
      formatKey,
      formatName: candidate.format?.name ?? null,
      productClass: candidate.productClass,
      round: history.length + 1,
      why: candidate.why,
      rank,
    });
  }

  return { asks, declined };
}

/**
 * Work on something that already exists.
 *
 * Within this group the order is itself an ordering statement: a product with
 * no route to a buyer is the most finished thing that cannot earn, so it goes
 * first; the money comes next, because a route whose terms make the product
 * unprofitable is worth knowing before anything is sold through it; then who
 * makes it, which only matters for a physical product; then the rules, which
 * matter most when something is about to be listed.
 */
function finishing(
  snapshot: PuzzleSnapshot,
  economics: readonly UnitEconomics[],
): Candidate[] {
  const out: Candidate[] = [];

  for (const format of snapshot.formats) {
    if (format.products.length > 0 && format.channels.length === 0) {
      out.push({
        purpose: 'CHANNEL',
        format,
        productClass: null,
        why:
          `${format.products.length} product(s) are compiled from ${format.name} and nothing ` +
          'establishes how any of them reaches a buyer. That is one question away from being ' +
          'sellable, and the work behind the product is already spent.',
      });
    }
  }

  for (const format of snapshot.formats) {
    /*
     * The economics of the classes this format is actually being sold as,
     * rather than of all seven. A question about what a boxed jigsaw earns is
     * the wrong thing to ask about a format nobody has compiled a boxed
     * product from.
     */
    const classes = new Set<PuzzleProductClass>(format.products.map((one) => one.productClass));
    for (const productClass of PUZZLE_PRODUCT_CLASSES) {
      if (!classes.has(productClass)) continue;
      const reading = economics.find(
        (one) => one.formatKey === format.key && one.productClass === productClass,
      );
      if (reading && reading.withheld === null) continue;
      out.push({
        purpose: 'ECONOMICS',
        format,
        productClass,
        why: reading
          ? `The money for ${format.name} as a ${productClass} is not settled: ${reading.withheld}`
          : `A product exists as a ${productClass} and no figure at all has been published ` +
            'about what it earns or costs.',
      });
    }
  }

  for (const format of snapshot.formats) {
    const physical = format.products.some(
      (one) => one.productClass === 'PRINT_BOOK' || one.productClass === 'CARD_OR_BOXED',
    );
    if (physical && format.production.length === 0) {
      out.push({
        purpose: 'PRODUCTION',
        format,
        productClass: null,
        why:
          `A physical product is compiled from ${format.name} and nobody has established who ` +
          'would make it or what their minimum is. Every figure about a print run means ' +
          'nothing until somebody has.',
      });
    }
  }

  for (const format of snapshot.formats) {
    if (format.channels.length === 0) continue;
    if (snapshot.constraints.length > 0) continue;
    out.push({
      purpose: 'RIGHTS',
      format,
      productClass: null,
      why:
        `There is a published route for ${format.name} and nothing anywhere about what may ` +
        'not be listed, sold or reproduced. That is the question whose wrong answer is ' +
        'discovered by somebody else.',
    });
  }

  return out;
}

/**
 * Start something new.
 *
 * Demand for a format that can already be made comes before a broader search,
 * for the ordering reason above: a working generator with no buyer is a much
 * shorter distance to money than a format nobody has heard of.
 */
function starting(snapshot: PuzzleSnapshot): Candidate[] {
  const out: Candidate[] = [];

  for (const format of snapshot.formats) {
    if (format.demand.length > 0) continue;
    if (format.validInstances.length === 0) continue;
    out.push({
      purpose: 'DEMAND',
      format,
      productClass: null,
      why:
        `${format.validInstances.length} validated ${format.name} puzzle(s) exist and nobody ` +
        'has established who pays for them. A working generator with no buyer is the shortest ' +
        'distance to money on this map.',
    });
  }

  for (const format of snapshot.formats) {
    if (format.demand.length > 0) continue;
    if (format.validInstances.length > 0) continue;
    out.push({
      purpose: 'DEMAND',
      format,
      productClass: null,
      why:
        `${format.name} is on the map and nothing establishes who buys it. Whether it is worth ` +
        'building a generator for depends on the answer.',
    });
  }

  /*
   * The bootstrap, last and never removed.
   *
   * It is the one question that reaches outside everything already on the
   * map, so it keeps a place in the ordering however full the map gets —
   * §39's own correction, where every allocator rule asked about a category
   * already on the ladder and discovery recursed inside its own subtree for
   * ever. Its round number rises, which is what the cool-off and the barren
   * count act on.
   */
  const seedRounds = snapshot.rounds.filter((one) => one.purpose === 'SEED_FORMATS');
  out.push({
    purpose: 'SEED_FORMATS',
    format: null,
    productClass: null,
    why:
      snapshot.formats.length === 0
        ? 'Nothing is on the map at all, so the first question is which kinds of puzzle are ' +
          'actually published and sold.'
        : `${snapshot.formats.length} format(s) are on the map, all of them found by an earlier ` +
          `round of this same question (${seedRounds.length} so far). It is asked again ` +
          'because it is the only question here that reaches outside what is already known.',
  });

  return out;
}

function coolingUntil(settled: readonly PuzzleRound[], now: number): number | null {
  let latest = 0;
  for (const one of settled) {
    const at = one.settledAt ? Date.parse(one.settledAt) : 0;
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest === 0) return null;
  const until = latest + ROUND_COOL_OFF_MS;
  return until > now ? until : null;
}

function describe(candidate: Candidate): string {
  const subject = candidate.format ? candidate.format.name : 'the puzzle trade';
  return candidate.productClass
    ? `${candidate.purpose} for ${subject} as a ${candidate.productClass}`
    : `${candidate.purpose} for ${subject}`;
}
