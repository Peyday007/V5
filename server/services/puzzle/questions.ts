/**
 * The question each round actually asks, carrying the directive's own words.
 *
 * ---------------------------------------------------------------------------
 * Brain supplies the vocabulary, which is how the formats converge
 * ---------------------------------------------------------------------------
 *
 * `formatKey` is deliberately the weakest matcher that could work — case and
 * whitespace, nothing else — so two workers writing "word search" and
 * "wordsearch" produce two formats that join to nothing. The fix is not a
 * cleverer matcher (§37: one that tried harder produces confident wrong
 * answers) but a question that carries the format **verbatim from Brain's own
 * rows** and asks for it back unchanged. That is a convergence mechanism
 * somebody can read rather than a similarity threshold nobody can audit.
 *
 * ---------------------------------------------------------------------------
 * The seed is a spread to search, not the taxonomy
 * ---------------------------------------------------------------------------
 *
 * The opening question names **sources rather than formats** — publishers,
 * retail listings, syndicates, marketplaces — and carries the directive's seed
 * list beside the directive's own refusal to be limited by it, as one string.
 * That is what lets discovery reach outside whatever is already on the map;
 * §39 records what happens to a kernel whose every question is about something
 * already in its own rows, which is that it explores a cone for ever while
 * every row reads healthy.
 *
 * ---------------------------------------------------------------------------
 * Nothing here authorizes an effect
 * ---------------------------------------------------------------------------
 *
 * Every question below asks what a published source **says**. None asks a
 * worker to contact anybody, list anything for sale, place an order, sign up
 * for a platform or spend anything, and the envelope these compile under
 * carries `CASH_FORBIDDEN_ACTIONS` so a plan that described doing any of them
 * is refused at the planning pass. `tests/puzzleKernel.test.ts` runs every
 * rendered question through that screen, because a brief that trips it is a
 * round that can never run — §39 had to add the same test for the same reason.
 */
import { brief, ledgerSeed, universeSeed, type PuzzleDirective } from './directive.ts';
import {
  ECONOMIC_COMPONENTS,
  RIGHTS_KINDS,
  ROUTE_CLASSES,
  VALIDATION_CHECKS,
} from '../../domain/puzzle.ts';

export interface Composed {
  title: string;
  question: string;
}

/** The instruction every question ends with, so a finding lands somewhere. */
function declare(lines: readonly string[]): string {
  return (
    'Declare what each claim establishes so it can be filed: set puzzle_finding on every claim ' +
    'that establishes one of these, and leave it off the ones that do not. ' +
    lines.join(' ') +
    ' A claim with no declaration is still recorded as evidence; it simply does not become a ' +
    'row anybody can act on, so declare where you can.'
  );
}

const FORMAT_RULE =
  'Wherever you name a puzzle format, use the words the trade itself uses, and where this ' +
  'assignment already names a format, declare that format back verbatim in puzzle_format — two ' +
  'spellings of one format are two formats here, and the second one joins to nothing.';

/* --------------------------------------------------------------------------
 * UNIVERSE — the opening question
 * ------------------------------------------------------------------------ */

export const UNIVERSE_TITLE = 'Which puzzle formats are actually published and sold';

export function universeQuestion(directive: PuzzleDirective, round: number): string {
  return [
    'Which specific formats of puzzle are actually published, sold, licensed or commissioned ' +
      'today, and who is each one for? Work from what publishers, syndicates, retailers, ' +
      'marketplaces, magazines, newsletters, educational suppliers and institutional buyers ' +
      'have themselves published — catalogues, product listings, submission guidelines, rate ' +
      'cards, contributor pages and category pages.',
    'For each format, name it as the trade names it, say who buys or plays it, and say what ' +
      'makes it a distinct format rather than a variant of another one.',
    `The operator's own seed list, and the operator's own instruction about it: ${universeSeed(
      directive,
    )}`,
    round > 1
      ? `This is round ${round}. Earlier rounds have already established some of these. Look ` +
        'deliberately outside them: obscure formats, underserved audiences, other languages, ' +
        'accessibility needs, seasonal or occasion-specific products, and institutional rather ' +
        'than consumer buyers.'
      : '',
    FORMAT_RULE,
    declare([
      'FORMAT_EXISTS for each format, with puzzle_subject as the format name and puzzle_format ' +
        'the same value.',
      'MONETIZATION_ROUTE where a source also shows how money is captured, with puzzle_value ' +
        `one of ${ROUTE_CLASSES.join(', ')}.`,
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* --------------------------------------------------------------------------
 * DEMAND — who buys this
 * ------------------------------------------------------------------------ */

export function demandTitle(subject: string): string {
  return `Who actually buys ${subject}`;
}

export function demandQuestion(input: {
  directive: PuzzleDirective;
  subject: string;
  formatName: string | null;
  round: number;
}): string {
  const { subject, formatName } = input;
  return [
    `Which named organisations, publications, platforms, retailers, institutions or channels ` +
      `have published that they buy, commission, license or pay for ${subject}? Work only from ` +
      'what they published themselves — submission and contributor guidelines, rate cards, ' +
      'procurement notices, supplier pages, tender records, catalogue listings, job and ' +
      'freelance postings, and published pricing.',
    'For every buyer, record the date the source carries. An undated buying signal cannot be ' +
      'told apart from one somebody remembers from years ago, so a signal with no date is not ' +
      'a signal.',
    `The operator's instruction about what counts: ${brief(input.directive, 'PROOF LADDER', 500)}`,
    'If a careful search of the places such a buyer would publish turns up nobody, that is a ' +
      'finding and one of the most useful ones — report it as DEMAND_ABSENCE and name in ' +
      'searched_repositories exactly where you looked. "Nobody has looked" and "somebody looked ' +
      'and there is nothing" must never read the same.',
    formatName ? FORMAT_RULE : '',
    declare([
      'BUYER_DEMAND for each buyer, with puzzle_subject the buyer as the source names them and ' +
        'puzzle_observed_on the date the source carries.',
      'DEMAND_ABSENCE where a documented search found nobody.',
      `ECONOMIC_FIGURE where a source publishes what it pays, with puzzle_value one of ` +
        `${ECONOMIC_COMPONENTS.join(', ')} and puzzle_basis what the figure is per.`,
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* --------------------------------------------------------------------------
 * ROUTE — how money is captured
 * ------------------------------------------------------------------------ */

export const ROUTE_TITLE = 'How money is actually captured in the puzzle trade';

export function routeQuestion(directive: PuzzleDirective, round: number): string {
  return [
    'How is money actually captured in and around the puzzle trade? For each way, work from ' +
      'evidence that somebody is doing it rather than from what sounds plausible: a published ' +
      'rate card, a syndication catalogue, a licensing page, a marketplace fee schedule, a ' +
      'wholesale term sheet, a published subscription price, a job posting for the work, or a ' +
      'trade report describing the arrangement.',
    'Say, for each, who pays whom, what they pay for, and what a supplier has to already have ' +
      'before that route is open to them.',
    `The operator's own seed list of routes, and the instruction that it is a seed: ${ledgerSeed(
      directive,
    )}`,
    round > 1
      ? `This is round ${round}. Look deliberately at the routes the earlier rounds did not ` +
        'reach — institutional and educational buyers, white-label and private-label supply, ' +
        'software and tooling sold to other publishers, and acquisitions of existing catalogues.'
      : '',
    declare([
      `MONETIZATION_ROUTE for each, with puzzle_value one of ${ROUTE_CLASSES.join(', ')}.`,
      'BUYER_DEMAND where a source names somebody actually paying through it, with ' +
        'puzzle_observed_on set.',
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* --------------------------------------------------------------------------
 * ECONOMICS — what it pays and what it costs
 * ------------------------------------------------------------------------ */

export function economicsTitle(subject: string): string {
  return `What ${subject} pays, and what it costs to supply`;
}

export function economicsQuestion(input: {
  directive: PuzzleDirective;
  subject: string;
  round: number;
}): string {
  return [
    `What does ${input.subject} actually pay a supplier, and what does supplying it cost? ` +
      'Establish each figure from a source that publishes it: a rate card, a fee schedule, a ' +
      'printer’s published price list, a distributor’s published terms, a platform’s ' +
      'published commission, a published wholesale discount.',
    'Report every figure exactly as published, in the currency it is published in, and say ' +
      'what it is per — one copy, one print run of a stated size, one month, one commission, ' +
      'one thousand impressions. A figure whose basis nobody stated cannot be added to another ' +
      'one, and a figure relabelled into a currency the source did not use is a number nobody ' +
      'can check. Do not convert between currencies and do not annualise a monthly figure.',
    `What the operator asks be modelled: ${brief(input.directive, 'PHYSICAL PRODUCTION LADDER', 900)}`,
    'Where a figure is genuinely not published, say so rather than estimating one. A stated ' +
      'gap is useful; an estimate presented beside published figures is a number that looks ' +
      'checked and is not.',
    declare([
      `ECONOMIC_FIGURE for each published figure, with puzzle_value one of ` +
        `${ECONOMIC_COMPONENTS.join(', ')}, puzzle_amount_minor in minor units, ` +
        'puzzle_currency the published currency, and puzzle_basis what it is per.',
    ]),
  ].join('\n\n');
}

/* --------------------------------------------------------------------------
 * RIGHTS — what may not be done
 * ------------------------------------------------------------------------ */

export function rightsTitle(formatName: string): string {
  return `What the rights rules are for ${formatName}`;
}

export function rightsQuestion(input: {
  directive: PuzzleDirective;
  formatName: string;
  round: number;
}): string {
  return [
    `What published rules govern what may lawfully be made and sold in the format ` +
      `"${input.formatName}"? Establish each from the instrument or the publisher that states ` +
      'it: copyright guidance and case reporting on grids, clues, compilations and artwork; ' +
      'trademark registers for format and product names; the licence terms of word lists, ' +
      'lexicons, fonts and artwork that such products are built from; and the published ' +
      'content and originality policies of the marketplaces and retailers that carry them.',
    `The operator's standard, in their own words: ${brief(input.directive, 'RIGHTS STANDARD', 700)}`,
    'Where a rule turns on something being in the public domain, say what establishes that ' +
      'rather than asserting it — a stated term of protection, an explicit dedication, or a ' +
      'register entry. A public-domain claim nobody sourced is the most expensive kind of ' +
      'mistake this catalog could make.',
    FORMAT_RULE,
    declare([
      `RIGHTS_CONSTRAINT for each rule, with puzzle_value one of ${RIGHTS_KINDS.join(', ')} and ` +
        'puzzle_format the format it binds.',
    ]),
  ].join('\n\n');
}

/* --------------------------------------------------------------------------
 * STANDARD — what a good one must satisfy
 * ------------------------------------------------------------------------ */

export function standardTitle(formatName: string): string {
  return `What a publishable ${formatName} must satisfy`;
}

export function standardQuestion(input: {
  directive: PuzzleDirective;
  formatName: string;
  round: number;
}): string {
  return [
    `What does the trade demand of a "${input.formatName}" before it is fit to publish? ` +
      'Establish each requirement from somebody who states it: a publisher’s or ' +
      'syndicate’s submission specification, an editor’s published construction rules, ' +
      'a competition or association standard, a style guide, or a published account of how such ' +
      'puzzles are checked before they go out.',
    'Each requirement must be reported as a check something could actually run, chosen from ' +
      `exactly this list: ${VALIDATION_CHECKS.join(', ')}. Put the requirement in the source’s ` +
      'own words in the claim itself, and put the check it corresponds to in puzzle_value. A ' +
      'standard nothing can run is a sentence rather than a gate, and a requirement that fits ' +
      'none of those checks should be reported in the claim without a declaration rather than ' +
      'forced into the nearest one.',
    `The operator's own quality standard: ${brief(input.directive, 'QUALITY STANDARD', 900)}`,
    FORMAT_RULE,
    declare([
      `QUALITY_STANDARD for each requirement, with puzzle_value one of ` +
        `${VALIDATION_CHECKS.join(', ')} and puzzle_format the format it applies to.`,
    ]),
  ].join('\n\n');
}

/* --------------------------------------------------------------------------
 * CHEAP_BOOK — the reverse-engineering the directive names explicitly
 * ------------------------------------------------------------------------ */

export const CHEAP_BOOK_TITLE = 'What a one-dollar puzzle book actually earns its publisher';

export function cheapBookQuestion(directive: PuzzleDirective, round: number): string {
  return [
    'Reverse-engineer the economics of the mass-market puzzle book that retails for around one ' +
      'dollar in discount and dollar-store chains. Establish, from published sources, what the ' +
      'publisher actually receives from such a sale, what share the retailer and any ' +
      'distributor take, what print quantities and printing methods such runs use, and what ' +
      'the physical specification is — page count, paper weight, ink, binding, trim size, ' +
      'packaging and case pack.',
    'Then establish what it costs: the printing, the paper and materials, the freight ' +
      '(including how many copies travel on a pallet), the editorial and puzzle content, the ' +
      'allowance for returns and markdowns, and the working capital a run of that size ties up ' +
      'until it sells. Establish the sell-through such a product needs, and how large a ' +
      'catalogue and how frequent a release schedule this business is normally run at.',
    `The operator's instruction about how to read the answer: ${brief(
      directive,
      'CHEAP BOOK INVESTIGATION',
      900,
    )}`,
    'Use published industry sources: printer price lists and quote calculators, publishers’ ' +
      'own filings and trade reporting, distributor and retailer published terms, freight ' +
      'tariffs, and trade-association surveys. Report every figure as published, with its ' +
      'currency and what it is per, and say plainly where a figure is not published rather ' +
      'than estimating one.',
    declare([
      `ECONOMIC_FIGURE for each published figure, with puzzle_value one of ` +
        `${ECONOMIC_COMPONENTS.join(', ')}, puzzle_currency and puzzle_basis set.`,
      'MONETIZATION_ROUTE where the arrangement itself is the finding.',
    ]),
  ].join('\n\n');
}
