/**
 * How far this repository has actually got with one puzzle format.
 *
 * ---------------------------------------------------------------------------
 * Ten rungs, derived, and three of them unreachable by construction
 * ---------------------------------------------------------------------------
 *
 * The brief asks for the maturity of each format to be shown honestly, and the
 * mechanism that makes it honest is not a policy: it is that the things which
 * would claim a rung falsely do not exist. `GENERATABLE` is read from the
 * format registry, which is a directory of implementations somebody can open;
 * `VALIDATABLE` needs an instance that actually passed; `REVENUE_PROVEN` needs
 * a settled row in the money ledger, which only a real payment writes. There
 * is no column, flag or override anywhere that moves any of them, and a format
 * with forty demand signals and no generator reads RESEARCHED for ever, which
 * is the correct and useful answer.
 *
 * ---------------------------------------------------------------------------
 * The ladder stops at the first rung that is not met
 * ---------------------------------------------------------------------------
 *
 * No partial credit and no highest-rung-reached: a format with a generator, no
 * validator and a signed licensing deal is not SELLABLE, it is stuck below
 * VALIDATABLE with a deal it cannot supply. Reporting the highest rung
 * anything satisfied would describe a format nobody has, which is exactly the
 * comfortable half-truth a maturity display exists to prevent.
 *
 * Each rung carries what it is waiting for, because "RESEARCHED" on its own
 * sends somebody to look at the wrong thing — the remedy for a missing
 * generator is a code change, and the remedy for a missing channel is a
 * question.
 */
import { formatFor } from './formats/index.ts';
import { PUZZLE_MATURITY_RUNGS } from '../../domain/types.ts';
import type {
  PuzzleConstraint,
  PuzzleDemand,
  PuzzleFormatEntry,
  PuzzleInstance,
  PuzzleMasterRow,
  PuzzleMaturityRung,
  PuzzleObservation,
  PuzzleProduct,
  PuzzleRoute,
} from '../../domain/types.ts';
import type { Qualification } from './products.ts';

export interface FormatMaturity {
  formatKey: string;
  name: string;
  rung: PuzzleMaturityRung;
  /** What stops the next rung, and who would resolve it. */
  waitingOn: string;
  /** Who resolves it: a code change, a question, a person, or a payment. */
  remedy: 'CODE' | 'RESEARCH' | 'PERSON' | 'MONEY' | 'NOTHING';
  /** Every rung it did reach, so a reader can see the shape rather than a word. */
  reached: PuzzleMaturityRung[];
  /**
   * What actually exists behind it, counted.
   *
   * Carried because the rung alone loses the difference between two formats
   * stuck at the same place, and driving this live showed what that costs: a
   * crossword Brain cannot even generate sorted above a sudoku with forty
   * proved puzzles and two products, because both were at DISCOVERED and the
   * tie fell through to the name. The counts are the tie-break and they are
   * worth printing on their own — *stuck at DISCOVERED with nothing* and
   * *stuck at DISCOVERED with a catalog* are the same rung and completely
   * different situations.
   */
  evidence: {
    validPuzzles: number;
    products: number;
    buyers: number;
    channels: number;
  };
  /** What this repository can and cannot say about the format, if it implements it. */
  limitation: string | null;
}

export interface MaturityInput {
  formats: readonly PuzzleFormatEntry[];
  masters: readonly { id: string; formatKey: string }[];
  instances: readonly PuzzleInstance[];
  products: readonly PuzzleProduct[];
  qualifications: readonly Qualification[];
  demand: readonly PuzzleDemand[];
  routes: readonly PuzzleRoute[];
  constraints: readonly PuzzleConstraint[];
  observations: readonly PuzzleObservation[];
  /** Opportunity ids against which a settlement has actually landed. */
  settledOpportunityIds: ReadonlySet<string>;
  /**
   * Capabilities a person has declared this operation holds, from §39's
   * programme.
   *
   * Read rather than duplicated. A printing or binding capability is a
   * manufacturing capability, it is recorded where every other one is, and a
   * second ladder here would be the parallel universe the brief forbids and
   * the one nobody reconciles. The top rung is the only thing that reads it.
   */
  heldCapabilities: readonly string[];
}

export function readMaturity(input: MaturityInput): FormatMaturity[] {
  const out: FormatMaturity[] = [];
  const qualified = new Set(
    input.qualifications.filter((one) => one.verdict === 'QUALIFIED').map((one) => one.productId),
  );

  for (const format of input.formats) {
    if (format.retiredAt !== null) continue;
    const key = format.formatKey;
    const implementation = formatFor(key);
    const masters = input.masters.filter((one) => one.formatKey === key);
    const masterIds = new Set(masters.map((one) => one.id));
    const valid = input.instances.filter(
      (one) => masterIds.has(one.masterId) && one.validationState === 'VALID',
    );
    const products = input.products.filter(
      (one) => masterIds.has(one.masterId) && one.retiredAt === null,
    );
    const qualifiedProducts = products.filter((one) => qualified.has(one.id));
    const demand = input.demand.filter((one) => one.formatKey === key);
    const channels = input.routes.filter((one) => one.formatKey === key && one.kind === 'CHANNEL');
    const production = input.routes.filter(
      (one) => one.formatKey === key && one.kind === 'PRODUCTION',
    );
    const mine = input.observations.filter((one) => one.formatKey === key);
    const settled = products.filter(
      (one) => one.opportunityId !== null && input.settledOpportunityIds.has(one.opportunityId),
    );

    /*
     * The human gate.
     *
     * Two separate things and both are a person's: a format whose defects a
     * machine cannot see needs every instance read, and *every new generator
     * or template* needs one look before anything from it is sold — which is
     * the brief's own words and applies to a format Brain generates perfectly
     * well. Neither has a flag. What clears them is an observation somebody
     * recorded.
     */
    const editRequired = implementation?.requiresHumanEdit ?? true;
    const edited = mine.some((one) => one.kind === 'HUMAN_EDIT_PASSED');
    const playtested = mine.some((one) => one.kind === 'PLAYTEST_RESULT');

    /*
     * Rights are enforced upstream rather than here, and saying where matters.
     *
     * What Brain can enforce is the corpus: `refusalFor` refuses to generate
     * anything at all from source material whose position is UNKNOWN or
     * non-commercial, so a format whose rights are unresolved has no validated
     * instances and never reaches this rung. What Brain cannot enforce is a
     * researched `puzzle_constraints` row — whether a particular trademark or
     * platform rule blocks a particular product is a judgement about that
     * product, and a ladder that refused on a count of constraints would stop
     * a format because somebody had done more research about it. The rows are
     * carried to the surface for a person instead.
     */

    const steps: {
      name: PuzzleMaturityRung;
      met: boolean;
      blocked: string;
      who: FormatMaturity['remedy'];
    }[] = [
      { name: 'DISCOVERED', met: true, blocked: '', who: 'NOTHING' },
      {
        name: 'RESEARCHED',
        met: demand.length > 0 || channels.length > 0,
        blocked:
          'No published buyer and no published channel. A question about who actually pays for ' +
          'this format is the next thing, and it is the cheapest thing here.',
        who: 'RESEARCH',
      },
      {
        name: 'GENERATABLE',
        met: implementation?.render != null,
        blocked: implementation
          ? `${implementation.title} is authored rather than generated here: its content is ` +
            'editorial work with no correctness criterion, so there is a validator and ' +
            'deliberately no generator. Somebody writes one and Brain checks it.'
          : 'Nothing in this repository generates this format. Building a generator and a ' +
            'validator for it is a code change somebody reviews.',
        who: implementation ? 'PERSON' : 'CODE',
      },
      {
        name: 'VALIDATABLE',
        met: valid.length > 0,
        blocked:
          masters.length === 0
            ? 'A generator exists and no puzzle system has been set up from it yet.'
            : 'A system exists and nothing it made has passed validation. The failing checks ' +
              'are recorded against each refused seed, and what they point at is the generator.',
        who: masters.length === 0 ? 'PERSON' : 'CODE',
      },
      {
        name: 'PRODUCTIZABLE',
        met: qualifiedProducts.length > 0,
        blocked:
          products.length === 0
            ? `${valid.length} validated puzzle(s) and nothing compiled into a product yet.`
            : 'Every product compiled from this format is substantially the same puzzles in ' +
              'the same shape as another. A distinct output needs new content, or a real ' +
              'difference of audience, difficulty, occasion, language, format, channel or ' +
              'buyer.',
        who: 'PERSON',
      },
      {
        name: 'SELLABLE',
        met: channels.length > 0 && (edited || (!editRequired && playtested)),
        blocked:
          channels.length === 0
            ? 'There is a product and no published route to a buyer. Which marketplace, ' +
              'syndicate, distributor or retailer takes this, and on what terms, is a question.'
            : editRequired
              ? 'This format needs a person to read what was made before any of it is sold, ' +
                'and no such reading is recorded. There is no flag that stands in for it.'
              : 'Nobody has read or played a sample of what this system produces. A machine ' +
                'check establishes that a puzzle is solvable and cannot establish that it is ' +
                'any good, and the brief asks for a look at every new template.',
        who: channels.length === 0 ? 'RESEARCH' : 'PERSON',
      },
      {
        name: 'REVENUE_PROVEN',
        met: settled.length > 0,
        blocked:
          'Nothing has been paid for. A settled entry in the money ledger is the only thing ' +
          'that moves this, and an agreement, an acceptance or an invoice is not one.',
        who: 'MONEY',
      },
      {
        name: 'REPEATABLE',
        met: settled.length > 1,
        blocked:
          'One sale is a sale. Two from this format, through a route that stayed available, ' +
          'is the difference between something that worked and something that works.',
        who: 'MONEY',
      },
      {
        name: 'SCALABLE',
        met: settled.length > 1 && qualifiedProducts.length > 2,
        blocked:
          'Repeat revenue exists and the catalog behind it is thin. Scaling means more ' +
          'distinct outputs from the same system reaching the same route, not more copies of ' +
          'one.',
        who: 'PERSON',
      },
      {
        name: 'PRODUCTION_OWNED',
        met: production.length > 0 && input.heldCapabilities.length > 0,
        blocked:
          production.length === 0
            ? 'Nobody has established who physically makes this, so ownership is not yet a ' +
              'question with a shape.'
            : 'Production is outsourced. Owning it is the manufacturing programme’s ' +
              'decision and its capital arithmetic, not this kernel’s — and it is only ' +
              'worth asking once the outsourced version is reliably profitable.',
        who: 'PERSON',
      },
    ];

    const reached: PuzzleMaturityRung[] = [];
    let rung: PuzzleMaturityRung = 'DISCOVERED';
    let waitingOn = 'Nothing. This format is fully realised on every rung this ladder has.';
    let remedy: FormatMaturity['remedy'] = 'NOTHING';
    for (const one of steps) {
      if (!one.met) {
        waitingOn = one.blocked;
        remedy = one.who;
        break;
      }
      reached.push(one.name);
      rung = one.name;
    }

    out.push({
      formatKey: key,
      name: format.name,
      rung,
      waitingOn,
      remedy,
      reached,
      evidence: {
        validPuzzles: valid.length,
        products: qualifiedProducts.length,
        buyers: demand.length,
        channels: channels.length,
      },
      limitation: implementation?.limitation ?? null,
    });
  }

  /*
   * Ordered by how far each got, furthest first, because the useful reading is
   * "what is nearly there" rather than the order formats were discovered in.
   *
   * Ties break on what exists rather than on the name. The name was the first
   * version and it put a format nothing can generate above one holding forty
   * proved puzzles and two products, because both were on the same rung — a
   * reading that is technically true and sends somebody to the wrong format.
   * The name stays as the last tiebreak so the order is stable between two
   * reads of an unchanged database.
   */
  const weight = (one: FormatMaturity): number =>
    one.evidence.validPuzzles +
    one.evidence.products * 10 +
    one.evidence.buyers * 10 +
    one.evidence.channels * 10;
  return out.sort((a, b) => {
    const rank = (one: FormatMaturity): number => PUZZLE_MATURITY_RUNGS.indexOf(one.rung);
    return rank(b) - rank(a) || weight(b) - weight(a) || a.name.localeCompare(b.name);
  });
}

/** The masters as the reading wants them, without dragging the row type in. */
export function mastersFor(rows: readonly PuzzleMasterRow[]): { id: string; formatKey: string }[] {
  return rows.map((one) => ({ id: one.id, formatKey: one.format_key }));
}
