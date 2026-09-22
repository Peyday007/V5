/**
 * What this repository can actually do about puzzles, read rather than
 * declared.
 *
 * ---------------------------------------------------------------------------
 * Only the capabilities that are about making puzzles are here
 * ---------------------------------------------------------------------------
 *
 * Sending a message, issuing an invoice, taking a payment, publishing a
 * listing and signing an agreement are the same capabilities whichever kernel
 * wants them, they already have readings in `services/cash/capabilities.ts`,
 * and restating them here would be two vocabularies for one question — which
 * is the *two readers of one fact* defect this repository keeps correcting.
 * `commercialCapabilities` reads them from there and this module adds none of
 * its own.
 *
 * What is here is the half nothing else answers: whether Brain can make a
 * puzzle, check one, typeset one for print, or hold the rights to the material
 * a particular format needs.
 *
 * ---------------------------------------------------------------------------
 * PRESENT is a reading, MISSING is a claim, and UNKNOWN is neither
 * ---------------------------------------------------------------------------
 *
 * `MISSING` says Brain understands the capability and does not have it, which
 * is a claim worth making only about things somebody has thought through.
 * `UNKNOWN` says nobody has told Brain what the thing is. Collapsing them
 * would make an unrecognised capability read as a settled absence, which is
 * §30's rule in the expensive direction: *we could not tell* must never read
 * the same as *we checked*.
 */
import { CORPORA, mayCompileCommercially } from '../../domain/puzzleCorpora.ts';
import { implementedFormats } from './formats/index.ts';
import { readCapabilities, type CapabilityReading } from '../cash/capabilities.ts';

export interface PuzzleCapability {
  id: string;
  state: 'PRESENT' | 'MISSING' | 'UNKNOWN';
  /** What it does, or would. */
  does: string;
  /** What it is, right now, in the words a reader needs. */
  reading: string;
  /** The first thing somebody would actually do about it. */
  nextStep: string | null;
}

/**
 * The commercial capabilities, read from the module that owns them.
 *
 * The five every route in the ledger eventually needs. Every one of them reads
 * MISSING on this Brain because no integration of that kind exists, and that
 * is the honest answer rather than a gap in this kernel: the message is sent
 * by a person and recorded as an action, which is what `cash_actions` is for.
 */
export async function commercialCapabilities(): Promise<CapabilityReading[]> {
  return readCapabilities([
    'RESEARCH_A_QUESTION',
    'SEND_A_MESSAGE',
    'ISSUE_AN_INVOICE',
    'TAKE_A_PAYMENT',
    'PUBLISH_A_LISTING',
  ]);
}

/**
 * What Brain can do about the puzzles themselves.
 *
 * Every state is derived from code and constants somebody can open rather than
 * from a row, because each of these is a fact about this repository. A
 * generator either exists in the registry or it does not; a corpus either
 * carries commercial rights or it does not. There is nothing here a row could
 * assert and nothing a model could move.
 */
export function puzzleCapabilities(): PuzzleCapability[] {
  const formats = implementedFormats();
  const generated = formats.filter((one) => one.render !== null);
  const authored = formats.filter((one) => one.render === null);
  const sellableCorpora = Object.values(CORPORA).filter((one) =>
    mayCompileCommercially(one.rights),
  );
  const blockedCorpora = Object.values(CORPORA).filter(
    (one) => !mayCompileCommercially(one.rights),
  );

  return [
    {
      id: 'GENERATE_A_PUZZLE',
      state: generated.length > 0 ? 'PRESENT' : 'MISSING',
      does: 'Produce a puzzle deterministically from a seed, with its solution and answer key.',
      reading:
        `${generated.length} format(s) generate: ${generated.map((one) => one.title).join(', ')}.` +
        (authored.length > 0
          ? ` ${authored.map((one) => one.title).join(', ')} ${
              authored.length === 1 ? 'is' : 'are'
            } authored rather than generated, which is a decision rather than a gap.`
          : ''),
      nextStep:
        'A format on the map with nothing here is a generator somebody writes, which is a code ' +
        'change with a review on it.',
    },
    {
      id: 'PROVE_A_PUZZLE',
      state: formats.length > 0 ? 'PRESENT' : 'MISSING',
      does:
        'Establish, from the printed artifact alone, that a puzzle is solvable, that its ' +
        'answer key is right, and — where the format allows it — that its answer is unique.',
      reading:
        `${formats.length} format(s) have a validator, and every one of them is handed the ` +
        'artifact with no access to how it was made. What each can and cannot establish is ' +
        'stated on the format: uniqueness is proved for sudoku and maze, and is explicitly ' +
        'not claimed for cryptogram.',
      nextStep: null,
    },
    {
      id: 'HOLD_RIGHTS_IN_SOURCE_MATERIAL',
      state: sellableCorpora.length > 0 ? 'PRESENT' : 'MISSING',
      does: 'Compile a sellable product from source material whose rights position is known.',
      reading:
        `${sellableCorpora.length} corpus/corpora may be sold from: ` +
        `${sellableCorpora.map((one) => `${one.id} (${one.rights})`).join(', ')}.` +
        (blockedCorpora.length > 0
          ? ` ${blockedCorpora.map((one) => `${one.id} (${one.rights})`).join(', ')} may not, ` +
            'so nothing compiles from ' +
            (blockedCorpora.length === 1 ? 'it' : 'them') +
            '.'
          : ''),
      nextStep:
        blockedCorpora.length > 0
          ? 'A corpus reading UNKNOWN is unlocked by a person establishing its position and ' +
            'the constant being changed in a reviewed commit — never by research, because no ' +
            'amount of reading published sources establishes what this repository may sell.'
          : null,
    },
    {
      id: 'IMPORT_A_LICENSED_CORPUS',
      state: 'MISSING',
      does:
        'Take in a bought or licensed word list, clue bank or artwork set and use it under its ' +
        'licence.',
      reading:
        'No route exists. It is deliberately absent rather than half-built: it needs a rights ' +
        'record somebody signs, provenance per entry, and an answering transition for when a ' +
        'licence lapses — and a table with nothing that could honestly fill it is a mechanism ' +
        'nothing calls.',
      nextStep:
        'It is the single thing that would unlock crosswords, which are the largest ' +
        'syndication market in this trade and the one format here that cannot be generated.',
    },
    {
      id: 'TYPESET_FOR_PRINT',
      state: 'MISSING',
      does:
        'Lay a validated puzzle out as a printable page: trim size, margins, typography, page ' +
        'numbers, and the answer section at the back.',
      reading:
        'Nothing here produces a PDF. A puzzle renders as text, which is enough to prove it ' +
        'and not enough to print it — and a printed page is what every physical route in the ' +
        'ledger sells.',
      nextStep:
        'The first thing that turns a validated catalog into a downloadable product, and the ' +
        'cheapest capability on this list to build.',
    },
  ];
}

/** Everything, for the surface that shows what Brain can and cannot do. */
export async function allCapabilities(): Promise<{
  puzzle: PuzzleCapability[];
  commercial: CapabilityReading[];
}> {
  return { puzzle: puzzleCapabilities(), commercial: await commercialCapabilities() };
}
