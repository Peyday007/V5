/**
 * Compiling a master into products, and deciding whether a product is a new
 * one or the same one in a different cover.
 *
 * ---------------------------------------------------------------------------
 * The multiplier the brief asks for, and the thing that would fake it
 * ---------------------------------------------------------------------------
 *
 * *Ten systems producing fifty outputs* is a real and reachable shape: one
 * validated word-search system produces genuinely different books for
 * different audiences, difficulties, languages, occasions and buyers, and each
 * of them is a thing somebody would pay for separately. It is also the easiest
 * number in this whole kernel to fake, because fifty covers over one set of
 * puzzles satisfies the arithmetic and nothing else.
 *
 * So `qualify` is a *derivation over rows* rather than a field a compiler
 * fills in, and it rests on two things that cannot be asserted. The content
 * dimension is measured from `puzzle_product_instances` — two products sharing
 * their puzzles share them, whatever anybody says. And every other dimension
 * comes from a column with a closed meaning, in a table that has **no cover
 * column, no title variant and no page order**, so a reskin has nowhere to be
 * declared as a difference in the first place.
 *
 * A reordering is explicitly not a difference: `position` exists because the
 * order puzzles print in is part of the product, and shuffling a hundred
 * puzzles produces a book with the same hundred puzzles.
 *
 * ---------------------------------------------------------------------------
 * Nothing here decides whether a product is worth making
 * ---------------------------------------------------------------------------
 *
 * `qualify` answers *is this a distinct thing*, which is a question about
 * rows. Whether anybody would buy it is `maturity.ts` reading demand and a
 * channel, and what it would earn is `economics.ts` reading published figures.
 * Keeping the three apart is what stops a qualified product reading as a
 * proven one — which is §33's tier distinction, at a second kernel.
 */
import {
  createPuzzleProduct,
  getPuzzleMaster,
  listPuzzleInstances,
  listPuzzleProducts,
  productMembership,
} from '../../repos/puzzle.ts';
import { formatFor } from './formats/index.ts';
import type {
  PuzzleDifficulty,
  PuzzleProduct,
  PuzzleProductClass,
  PuzzleSkuDimension,
} from '../../domain/types.ts';

/**
 * How much two products may share before they are the same puzzles.
 *
 * Half, measured as the share of the smaller product's instances that also
 * appear in the other. Not Jaccard: a fifty-puzzle sampler drawn entirely from
 * a two-hundred-puzzle book has a Jaccard index of 0.25 and is, to anybody who
 * owns the book, fifty puzzles they already have. What matters is how much of
 * the *smaller* thing is already in the buyer's hands.
 */
export const CONTENT_OVERLAP_CEILING = 0.5;

export interface Qualification {
  productId: string;
  verdict: 'QUALIFIED' | 'RESKIN';
  /** Which dimension makes it distinct. Empty exactly when the verdict is RESKIN. */
  dimensions: PuzzleSkuDimension[];
  /** The sibling it is closest to, and why that is or is not enough. */
  because: string;
}

/**
 * Whether each product is a distinct commercial output.
 *
 * Derived over the whole set at once rather than one product at a time,
 * because the answer is a property of the *collection*: a product is a reskin
 * of something, and which something changes as siblings are compiled. A stored
 * verdict would be right on the day it was written and wrong the next time
 * anybody compiled anything — `tier.ts`'s argument, one kernel along.
 */
export function qualify(input: {
  products: readonly PuzzleProduct[];
  membership: ReadonlyMap<string, readonly string[]>;
}): Qualification[] {
  const live = input.products.filter((one) => one.retiredAt === null);
  const out: Qualification[] = [];

  for (const product of live) {
    const mine = new Set(input.membership.get(product.id) ?? []);
    /*
     * Compared only against siblings of the same master. Two products from
     * two masters are two different puzzle systems and cannot be a reskin of
     * each other whatever they share — and they share nothing, because an
     * instance belongs to exactly one master.
     */
    const siblings = live.filter(
      (one) => one.id !== product.id && one.masterId === product.masterId,
    );
    if (siblings.length === 0) {
      out.push({
        productId: product.id,
        verdict: 'QUALIFIED',
        dimensions: ['PUZZLE_CONTENT'],
        because: 'The first product compiled from this system, so there is nothing to repeat.',
      });
      continue;
    }

    let worst: { sibling: PuzzleProduct; overlap: number; dimensions: PuzzleSkuDimension[] } | null =
      null;
    for (const sibling of siblings) {
      const theirs = new Set(input.membership.get(sibling.id) ?? []);
      const shared = [...mine].filter((one) => theirs.has(one)).length;
      const smaller = Math.min(mine.size, theirs.size);
      const overlap = smaller === 0 ? 0 : shared / smaller;
      const dimensions = differingDimensions(product, sibling);
      if (
        worst === null ||
        overlap > worst.overlap ||
        (overlap === worst.overlap && dimensions.length < worst.dimensions.length)
      ) {
        worst = { sibling, overlap, dimensions };
      }
    }
    if (!worst) continue;

    const newContent = worst.overlap < CONTENT_OVERLAP_CEILING;
    const dimensions: PuzzleSkuDimension[] = [
      ...(newContent ? (['PUZZLE_CONTENT'] as const) : []),
      ...worst.dimensions,
    ];

    if (dimensions.length === 0) {
      out.push({
        productId: product.id,
        verdict: 'RESKIN',
        dimensions: [],
        because:
          `${Math.round(worst.overlap * 100)}% of the smaller of this and "${worst.sibling.title}" ` +
          'is the same puzzles, and the two differ on no dimension this kernel recognises as a ' +
          'difference. A cover, a title and a page order are not among them, deliberately: ' +
          'this is one product twice.',
      });
      continue;
    }

    out.push({
      productId: product.id,
      verdict: 'QUALIFIED',
      dimensions,
      because: newContent
        ? `Only ${Math.round(worst.overlap * 100)}% of the smaller of this and "${worst.sibling.title}" ` +
          'is shared, so most of what a buyer gets is puzzles they do not already have' +
          (worst.dimensions.length > 0
            ? `, and it also differs by ${worst.dimensions.join(', ').toLowerCase()}.`
            : '.')
        : `It holds substantially the puzzles "${worst.sibling.title}" does, and is a distinct ` +
          `product because it differs by ${worst.dimensions.join(', ').toLowerCase()} — which is ` +
          'a real reason somebody buys both.',
    });
  }
  return out;
}

/**
 * The dimensions two products genuinely differ on.
 *
 * A `Record`-shaped list rather than a loop over keys, so a column added to
 * `puzzle_products` that ought to count is a visible edit here rather than a
 * silent omission — and one that ought *not* to count, like a cover, has to be
 * argued for in this file rather than smuggled in as a field.
 *
 * A null on one side and a value on the other is a difference: a book aimed at
 * nobody in particular and the same book aimed at care homes are two products,
 * and the second is the one with the audience.
 */
function differingDimensions(a: PuzzleProduct, b: PuzzleProduct): PuzzleSkuDimension[] {
  const out: PuzzleSkuDimension[] = [];
  const same = (x: string | null, y: string | null): boolean =>
    (x ?? '').trim().toLowerCase() === (y ?? '').trim().toLowerCase();
  if (a.productClass !== b.productClass) out.push('FORMAT');
  if (!same(a.audience, b.audience)) out.push('AUDIENCE');
  if (!same(a.useOccasion, b.useOccasion)) out.push('USE_OCCASION');
  if (!same(a.language, b.language)) out.push('LANGUAGE');
  if (a.difficulty !== b.difficulty) out.push('DIFFICULTY');
  if (!same(a.channel, b.channel)) out.push('CHANNEL');
  if (!same(a.buyer, b.buyer)) out.push('BUYER');
  return out;
}

export interface CompileRefusal {
  refused: string;
}

export type CompileResult = { product: PuzzleProduct } | CompileRefusal;

export function isRefusal(result: CompileResult): result is CompileRefusal {
  return 'refused' in result;
}

/**
 * Compile a product from validated instances.
 *
 * Every refusal here is about the *puzzles*, deliberately. Whether anybody
 * wants the product, whether it may be sold, and what it earns are three other
 * readings with three other remedies, and folding them in here would mean a
 * compiler that refused to build something because nobody had researched a
 * channel for it yet.
 */
export async function compileProduct(input: {
  projectId: string;
  masterId: string;
  title: string;
  productClass: PuzzleProductClass;
  count: number;
  audience?: string | null;
  useOccasion?: string | null;
  language?: string | null;
  channel?: string | null;
  buyer?: string | null;
}): Promise<CompileResult> {
  const master = await getPuzzleMaster(input.masterId);
  if (!master || master.projectId !== input.projectId) {
    return { refused: 'No such puzzle system in this project.' };
  }

  const valid = await listPuzzleInstances({
    projectId: input.projectId,
    masterId: master.id,
    state: 'VALID',
  });
  if (valid.length === 0) {
    return {
      refused:
        'This system has no validated puzzles. A product is compiled from instances that ' +
        'passed, and there is no path from an unchecked one to a page.',
    };
  }

  /*
   * Which puzzles go in: the ones no product already holds, oldest first, so
   * a second product from one system gets new content rather than the same
   * puzzles in a different order. Falling back to reuse when there are not
   * enough is deliberate and is not a way round `qualify` — a product built
   * from puzzles that are already out is exactly the case `qualify` reads as a
   * reskin unless something else about it differs, and it says so.
   */
  const membership = await productMembership(input.projectId);
  const used = new Set<string>();
  for (const ids of membership.values()) for (const id of ids) used.add(id);
  const fresh = valid.filter((one) => !used.has(one.id));
  const chosen = [...fresh, ...valid.filter((one) => used.has(one.id))].slice(
    0,
    Math.max(1, input.count),
  );
  if (chosen.length < input.count) {
    return {
      refused:
        `This system holds ${valid.length} validated puzzle(s) and the product asked for ` +
        `${input.count}. Generate more before compiling, rather than shipping a thinner book ` +
        'than the one somebody specified.',
    };
  }

  /*
   * The difficulty a product carries is the one its puzzles were *measured*
   * at, not the one the master was aiming for — and it is only stated when
   * they agree. A book labelled EASY whose puzzles measured HARD is the
   * complaint this column exists to prevent, and a mixed book is honestly
   * unlabelled rather than labelled with the average of two bands.
   */
  const bands = new Set(chosen.map((one) => one.measuredDifficulty).filter(Boolean));
  const difficulty: PuzzleDifficulty | null =
    bands.size === 1 ? ((chosen[0]?.measuredDifficulty ?? null) as PuzzleDifficulty | null) : null;

  const product = await createPuzzleProduct({
    projectId: input.projectId,
    masterId: master.id,
    title: input.title,
    productClass: input.productClass,
    audience: input.audience ?? null,
    useOccasion: input.useOccasion ?? null,
    language: input.language ?? languageOf(master.corpusId),
    difficulty,
    channel: input.channel ?? null,
    buyer: input.buyer ?? null,
    instanceIds: chosen.map((one) => one.id),
  });
  return { product };
}

function languageOf(corpusId: string): string {
  /*
   * From the corpus rather than from a parameter, because the language of a
   * puzzle is a property of the words in it. A product declared French whose
   * words are English is the mislabelling nobody notices until a customer
   * does.
   */
  return corpusId.includes('-fr-') ? 'fr' : 'en';
}

/** Everything `qualify` needs, read once. */
export async function qualifications(projectId: string): Promise<Qualification[]> {
  const [products, membership] = await Promise.all([
    listPuzzleProducts(projectId),
    productMembership(projectId),
  ]);
  return qualify({ products, membership });
}

/** Whether a format requires a person to read each instance before it is sold. */
export function requiresHumanEdit(formatKey: string): boolean {
  return formatFor(formatKey)?.requiresHumanEdit ?? false;
}
