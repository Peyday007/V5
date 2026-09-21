/**
 * The question each puzzle round actually asks.
 *
 * ---------------------------------------------------------------------------
 * Every one asks what a published source establishes
 * ---------------------------------------------------------------------------
 *
 * Not one of these asks a model what it thinks. "Would this sell" is
 * unanswerable and a worker asked it would answer something; "what does a
 * publisher's own submission page state it pays for a puzzle of this kind" is
 * answerable from a source. That difference is §8 at the questions that decide
 * what this operation makes — and the declarations they ask for come from
 * closed sets so that a paragraph of prose can never move a row.
 *
 * ---------------------------------------------------------------------------
 * A negative is asked for explicitly, and is worth as much as a positive
 * ---------------------------------------------------------------------------
 *
 * §14 is the standard: a claim that something does not exist is established by
 * a documented search of the places it would be, or not at all. The rights
 * question is where this matters most — an *established absence* of a
 * constraint is exactly what lets a generator be built, and an undocumented
 * silence is not. So `NO_CONSTRAINT_FOUND` is in the vocabulary and the
 * question asks for it by name.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per project for the same format would relaunch work already done.
 */
import {
  PRICE_BASES,
  PRODUCT_CLASSES,
  PRODUCTION_METHODS,
  PUZZLE_BUYERS,
  PUZZLE_CHANNELS,
  RIGHTS_CONSTRAINTS,
} from '../../domain/types.ts';
import type { PuzzleRoundPurpose } from '../../domain/types.ts';

export interface QuestionSubject {
  /** The format's name, or null for the universe question. */
  format: string | null;
  /** What Brain can currently do with it, carried as context rather than as scope. */
  standing: string;
}

export interface Composed {
  title: string;
  question: string;
}

const NOTE =
  'Report figures as published rather than converted, averaged or estimated. Where a source ' +
  'gives a range, say so and give the range. A vendor or publisher is conclusive about what it ' +
  'says and worth nothing as independent confirmation of anybody else — say which it is.';

export function compose(input: {
  purpose: PuzzleRoundPurpose;
  subject: QuestionSubject;
  round: number;
}): Composed {
  const { subject, round } = input;
  const name = subject.format ?? 'puzzles';
  const again =
    round > 1
      ? ' This is asking again — report what has been published, changed or withdrawn since, ' +
        'and say so plainly where nothing has.'
      : '';

  switch (input.purpose) {
    case 'UNIVERSE':
      return {
        title: 'Which puzzle formats, mechanics and products exist',
        question:
          'What kinds of puzzle and puzzle-led game are actually published and sold — including ' +
          'obscure formats, regional and non-English ones, formats built for particular ' +
          'audiences such as children, learners, older solvers or people with low vision, ' +
          'mechanics that appear inside other products, and puzzle products that are physical ' +
          'objects rather than pages? For each one, name it as its own sources name it and say ' +
          'what distinguishes it from the nearest format it could be confused with. ' +
          `${subject.standing} ` +
          'Declare each format you establish with puzzle_finding set to PUZZLE_FORMAT and ' +
          'puzzle_subject set to that format’s own short name. A format described in prose and ' +
          'not declared does not reach the map. ' +
          'What is wanted here is breadth and specificity rather than the well-known list: a ' +
          'format nobody here has heard of, with a source, is worth more than a confirmation ' +
          `that crosswords exist.${again}`,
      };

    case 'DEMAND':
      return {
        title: `Who actually buys ${name}, and what it is published to pay`,
        question:
          `Who buys ${name}, and what do published sources say they pay? Establish specific ` +
          'buyers rather than a market size: a publication with an open submissions page and a ' +
          'stated rate, a retailer stocking a named product at a named price, a syndicate’s ' +
          'published terms, an institution’s procurement notice, a platform’s published ' +
          'revenue share. ' +
          `${subject.standing} ` +
          `Declare each buyer with puzzle_finding set to BUYER_DEMAND and puzzle_subject set to ` +
          `one of: ${PUZZLE_BUYERS.join(', ')}. ` +
          'Where a source states a figure, declare it separately with puzzle_finding set to ' +
          `PRICE_POINT, puzzle_subject set to the product class it prices — one of ` +
          `${PRODUCT_CLASSES.join(', ')} — puzzle_price_cents in minor units and ` +
          `puzzle_qualifier set to one of ${PRICE_BASES.join(', ')}. A per-book price recorded ` +
          'as a per-puzzle one is wrong by two orders of magnitude silently, so the basis is ' +
          'not optional. ' +
          'If you searched the places such buyers would be published and found none, say so as ' +
          `a negative claim naming what you searched. ${NOTE}${again}`,
      };

    case 'CHANNEL':
      return {
        title: `Where ${name} reaches a buyer, and on what terms`,
        question:
          `By what published routes does ${name} actually reach a buyer, and what does each ` +
          'route take? Cover the terms that decide whether anything is left: platform or ' +
          'retailer share, distributor and wholesale discount, returns policy, payment timing, ' +
          'exclusivity, rights the channel requires, and any eligibility rule about who may ' +
          'list at all. ' +
          `${subject.standing} ` +
          `Declare each route with puzzle_finding set to DISTRIBUTION_CHANNEL and ` +
          `puzzle_subject set to one of: ${PUZZLE_CHANNELS.join(', ')}. A route with no ` +
          'published price is still a real finding — submit it without a figure rather than ' +
          'leaving it out, because an unknown rate is recorded as unknown and is never read as ' +
          'cheap. ' +
          'Report what a channel requires as well as what it pays: a route that pays well and ' +
          `cannot be entered is not a route. ${NOTE}${again}`,
      };

    case 'RIGHTS':
      return {
        title: `What constrains the rights to ${name}`,
        question:
          `What do published sources establish about the rights position for producing and ` +
          `selling ${name}? Cover copyright in individual puzzles and in compilations, ` +
          'trademarks over format names, any mechanic that is licensed rather than free to ' +
          'use, rights in word lists, lexicons, clue banks and databases, licences for fonts ' +
          'and artwork, the terms of the platforms it would be sold on, and any safety or ' +
          'labelling rule that applies to it as a physical product. ' +
          `${subject.standing} ` +
          `Declare each constraint with puzzle_finding set to RIGHTS_CONSTRAINT and ` +
          `puzzle_subject set to one of: ${RIGHTS_CONSTRAINTS.join(', ')}. ` +
          '**An established absence is the most valuable result this question can return.** ' +
          'Where you searched the places a constraint would be published — registries, the ' +
          'holder’s own terms, the licence a corpus is released under — and found none, declare ' +
          'it as NO_CONSTRAINT_FOUND and name exactly what you searched. That is what lets ' +
          'something be built; an undocumented silence is not, and must not be submitted as ' +
          `one. ${NOTE}${again}`,
      };

    case 'PRODUCTION':
      return {
        title: `What producing ${name} physically costs, and by what method`,
        question:
          `How is ${name} actually manufactured, and what do published sources say each step ` +
          'costs? Cover the method, minimum order quantities, per-unit and setup costs at ' +
          'different volumes, materials and components, tooling and prepress, lead times, ' +
          'freight and storage, spoilage and defect rates, and what the same work costs ' +
          'outsourced against what the equipment to do it in-house costs to buy and run. ' +
          `${subject.standing} ` +
          `Declare each method with puzzle_finding set to PRODUCTION_METHOD and puzzle_subject ` +
          `set to one of: ${PRODUCTION_METHODS.join(', ')}, and declare published prices as ` +
          'PRICE_POINT findings with their basis. ' +
          'Report the figures that decide whether ownership beats outsourcing — throughput at ' +
          'the slowest step, changeover time, staffed utilisation rather than advertised ' +
          'machine speed, maintenance, and resale value — as published facts. Nothing here ' +
          'authorises buying, ordering, tooling or committing to anything: this establishes ' +
          `what is true, and a person decides what is done about it. ${NOTE}${again}`,
      };
  }
}

/**
 * The sentence that says what Brain can currently do with this format.
 *
 * Carried as *context* rather than as scope: it says which findings are worth
 * reporting and it can widen nothing — the envelope, the evidence gate and the
 * source classes are all the compiler's.
 */
export function standingFor(input: {
  format: string | null;
  generatable: boolean;
  validated: number;
  blocker: string | null;
}): string {
  if (!input.format) {
    return (
      'This is for an operation that generates and validates puzzles in code and sells the ' +
      'output. What is worth reporting is a format that could be produced repeatably, not a ' +
      'one-off artistic construction.'
    );
  }
  if (input.generatable && input.validated > 0) {
    return (
      `This operation can already generate ${input.format} in code and has ${input.validated} ` +
      'puzzle(s) that passed every check, so what is missing is commercial rather than ' +
      'technical.'
    );
  }
  if (input.blocker) {
    return (
      `This operation cannot currently produce ${input.format}. What stops it: ${input.blocker} ` +
      'So what is worth reporting is whatever bears on that.'
    );
  }
  return `This operation is deciding whether to build the capability to produce ${input.format}.`;
}
