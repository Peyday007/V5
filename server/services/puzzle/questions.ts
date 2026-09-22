/**
 * The question each round actually asks.
 *
 * ---------------------------------------------------------------------------
 * Brain supplies the vocabulary, which is how the formats converge
 * ---------------------------------------------------------------------------
 *
 * `formatKey` is deliberately the weakest matcher that could work — case and
 * whitespace and nothing else — so two workers writing "word search" and
 * "wordsearch" produce two formats that join with nothing. The fix is not a
 * cleverer matcher (§37: one that tried harder produces confident wrong
 * answers) but a question that carries the format **verbatim from Brain's own
 * rows** and asks for it back unchanged. That is `scanQuestion`'s trick and
 * `demandQuestion`'s one kernel along, and it is a convergence mechanism
 * somebody can read rather than a similarity threshold nobody can audit.
 *
 * ---------------------------------------------------------------------------
 * The seed names examples and says they are examples
 * ---------------------------------------------------------------------------
 *
 * The bootstrap question lists crosswords, sudoku, word searches and the rest
 * because that is the pattern the operator actually described, and then asks
 * the worker to report *the shape of the trade* — which kinds of puzzle are
 * commercially published, by whom, in what form. A constant holding a list of
 * formats would answer the question this kernel exists to ask and would be
 * wrong about every format the trade has taken up since somebody typed it. So
 * there is no such list anywhere in this kernel, and the examples are in a
 * sentence that says in as many words that they are not the boundary.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per sprint for the same subject would relaunch work already done.
 * The sprint's objective is carried as *context* — it says which findings are
 * worth reporting — and it widens nothing: the envelope, the evidence gate and
 * the source classes are all the compiler's.
 */
import { PUZZLE_COST_COMPONENTS, PUZZLE_REVENUE_COMPONENTS } from '../../domain/puzzle.ts';
import type { PuzzleProductClass } from '../../domain/types.ts';

export const SEED_TITLE = 'Which kinds of puzzle are actually published and sold';

/** The one question with no format attached, because its job is to produce the first ones. */
export const SEED_QUESTION =
  'Which specific kinds of puzzle are commercially published and sold — as printed books and ' +
  'magazines, as daily puzzles in newspapers and apps, as downloadable or printable files, as ' +
  'cards, boxed products and physical objects, and as content licensed or syndicated to ' +
  'somebody else? For each kind, name it as the trade itself names it, and name at least one ' +
  'organisation that visibly publishes, sells, commissions or buys it, with a link to where ' +
  'they say so. Crosswords, sudoku, word searches, logic grids, mazes, cryptograms, ' +
  'nonograms, trivia and jigsaws are known examples of this pattern and are not the boundary ' +
  'of it: report the kinds the evidence actually shows, including formats nobody would guess ' +
  'from that list, formats that exist mainly in one language or one country, and formats ' +
  'bought by institutions rather than by readers.';

export function seedQuestion(objective: string, round: number): string {
  const parts = [
    SEED_QUESTION,
    `This is the starting map for a short cash sprint whose goal is: ${objective}`,
    'Declare every kind of puzzle you establish on its own claim: puzzle_finding set to ' +
      'FORMAT_EVIDENCE, puzzle_subject set to the name of the organisation that publishes or ' +
      'sells it, and puzzle_format set to the kind of puzzle as the trade names it. Where an ' +
      'organisation has published a need for puzzle content rather than merely selling some, ' +
      'declare that separately with DEMAND_SIGNAL. A format described in prose and not ' +
      'declared does not reach the map.',
  ];
  if (round > 1) {
    parts.push(
      `This is asking ${round - 1 === 1 ? 'again' : `round ${round}`} — report kinds the ` +
        'earlier rounds did not cover rather than restating them, and say so plainly where ' +
        'there is nothing new.',
    );
  }
  return parts.join(' ');
}

export function demandTitle(format: string): string {
  return `Who publishes a need for ${format}`;
}

export function demandQuestion(input: {
  format: string;
  objective: string;
  round: number;
  knownBuyers: readonly string[];
}): string {
  const parts = [
    `Which specific organisations or publications have published a need for ${input.format} ` +
      '— submission guidelines or a contributor call, a stated rate for puzzle content, a ' +
      'tender or procurement notice, a commission or freelance listing, a job posting for a ' +
      'puzzle editor or constructor, or a public statement that they are looking for more of ' +
      'it? For each one: the organisation, where it publishes, what it says it wants, what it ' +
      'says it pays if it says anything, and how often it buys.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    `Declare each organisation with puzzle_finding set to DEMAND_SIGNAL, puzzle_subject set ` +
      `to its own name, and puzzle_format set to exactly "${input.format}" — copy that string ` +
      'verbatim, because a different wording is a different format to Brain and will join ' +
      'with nothing.',
  ];
  if (input.knownBuyers.length > 0) {
    parts.push(
      `Brain already holds ${input.knownBuyers.length} buyer` +
        (input.knownBuyers.length === 1 ? '' : 's') +
        ` for this format (${input.knownBuyers.slice(0, 5).join('; ')}` +
        (input.knownBuyers.length > 5 ? ', and others' : '') +
        '). Report organisations those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function channelTitle(format: string): string {
  return `How ${format} reaches buyers, and on what terms`;
}

export function channelQuestion(input: {
  format: string;
  objective: string;
  round: number;
  knownChannels: readonly string[];
}): string {
  const parts = [
    `By which published routes does ${input.format} actually reach buyers, and what are the ` +
      'terms of each? Marketplaces and platforms that sell puzzle products, syndicates and ' +
      'content agencies that place puzzle content with publications, distributors and ' +
      'wholesalers, retailer programmes, and subscription or membership services. For each ' +
      'one, from its own terms page rather than from an article about it: what share it ' +
      'takes, what rights it requires, what its minimums are, how and when it pays, and what ' +
      'it refuses to list.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    `Declare each route with puzzle_finding set to CHANNEL, puzzle_subject set to its own ` +
      `name, and puzzle_format set to exactly "${input.format}". Put the terms in the claim ` +
      'itself: a route whose terms nobody stated cannot be compared to another, and Brain ' +
      'will not fill them in from what such a route usually charges.',
  ];
  if (input.knownChannels.length > 0) {
    parts.push(
      `Brain already holds ${input.knownChannels.slice(0, 5).join('; ')}. Report routes those ` +
        'do not cover.',
    );
  }
  return parts.join(' ');
}

export function productionTitle(format: string): string {
  return `Who physically makes ${format}`;
}

export function productionQuestion(input: {
  format: string;
  objective: string;
  round: number;
}): string {
  return [
    `Who actually manufactures ${input.format} as a physical product, and on what terms? ` +
      'Printers and print-on-demand services, book manufacturers, card and board game ' +
      'manufacturers, jigsaw cutters, and fulfilment houses. For each one, from its own ' +
      'published pricing or terms: what it makes, its stated minimum order, its lead time, ' +
      'and what it charges — at a specification you name, because a print price with no page ' +
      'count, trim size, paper and binding attached is a price for nothing.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare each supplier with puzzle_finding set to PRODUCTION_ROUTE, puzzle_subject set to ' +
      `its own name, and puzzle_format set to exactly "${input.format}". Where it publishes a ` +
      'figure, declare that separately with puzzle_finding set to PRODUCTION_COST, the line ' +
      'in puzzle_value, the amount in puzzle_amount_cents, the currency in puzzle_currency, ' +
      'and what it is per in puzzle_subject.',
  ].join(' ');
}

export function economicsTitle(format: string, productClass: PuzzleProductClass): string {
  return `What ${format} actually earns as a ${describeClass(productClass)}`;
}

export function economicsQuestion(input: {
  format: string;
  productClass: PuzzleProductClass;
  objective: string;
  round: number;
  missing: readonly string[];
}): string {
  const parts = [
    `What does ${input.format} sold as a ${describeClass(input.productClass)} actually earn, ` +
      'and what does it cost to produce and deliver? Work the whole chain from what a buyer ' +
      'pays to what the publisher receives: the shelf or list price, the retailer and ' +
      'distributor share, returns and markdowns, and the amount that actually reaches the ' +
      'publisher per unit sold. Then the cost side: what it costs to produce one, what is ' +
      'spent once per run, and what every intermediary takes.',
    'A retail price is what a shopper pays and a net receipt is what the publisher gets. They ' +
      'differ by most of the margin. Report whichever the source states under its own name, ' +
      'and never a receipt you derived by applying an assumed share to a shelf price — if ' +
      'only a retail price is published, say so plainly and Brain will withhold the ' +
      'contribution rather than compute it.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    `Declare every figure with puzzle_finding set to PRICE_POINT (${PUZZLE_REVENUE_COMPONENTS.join(
      ', ',
    )}) or PRODUCTION_COST (${PUZZLE_COST_COMPONENTS.join(', ')}), the line in puzzle_value, ` +
      `puzzle_format set to exactly "${input.format}", puzzle_product_class set to ` +
      `${input.productClass}, the amount in puzzle_amount_cents and its currency in ` +
      'puzzle_currency. A published zero is a figure and is declared as 0.',
  ];
  if (input.missing.length > 0) {
    parts.push(
      `Brain has no figure at all for ${input.missing.join(', ')}, and cannot report a ` +
        'contribution without them. Those are the most valuable things this question can ' +
        'come back with.',
    );
  }
  return parts.join(' ');
}

export function rightsTitle(format: string): string {
  return `What may not be done with ${format}`;
}

export function rightsQuestion(input: { format: string; objective: string; round: number }): string {
  return [
    `What published rules bear on what may lawfully be made, listed and sold in the ${input.format} ` +
      'trade? Copyright in grids, clues, compilations, word lists, artwork and fonts; ' +
      'trademarks in format names and branded puzzle formats; the listing rules of the ' +
      'marketplaces that sell them, including what they say about AI-generated content; ' +
      'product safety standards where the product is physical or aimed at children; and ' +
      'accessibility requirements where an institutional buyer imposes them. For each, the ' +
      'instrument, register entry, terms page or decision it comes from.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare each rule with puzzle_finding set to RIGHTS_CONSTRAINT, puzzle_value naming which ' +
      'kind it is, and puzzle_subject naming what it is about — the platform, the standard, ' +
      'the mark. Leave puzzle_format out: a rule of this sort applies across formats, and ' +
      'filing it under one would hide it from every other.',
  ].join(' ');
}

function describeClass(productClass: PuzzleProductClass): string {
  switch (productClass) {
    case 'PRINT_BOOK':
      return 'printed book';
    case 'CARD_OR_BOXED':
      return 'boxed or card product';
    case 'DIGITAL_DOWNLOAD':
      return 'downloadable file';
    case 'INTERACTIVE':
      return 'web or app puzzle';
    case 'RECURRING_FEED':
      return 'recurring feed or syndicated series';
    case 'LICENSE':
      return 'licence';
    case 'SERVICE':
      return 'commissioned piece of work';
    default:
      return 'product';
  }
}
