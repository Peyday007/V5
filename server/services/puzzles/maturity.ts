/**
 * How far this Brain has actually got with one format.
 *
 * ---------------------------------------------------------------------------
 * Derived on every read, and two rungs cannot be claimed by any row
 * ---------------------------------------------------------------------------
 *
 * `GENERATABLE` is a function existing in `registry.ts`. `VALIDATABLE` is that
 * function's checks having actually passed on a real puzzle. Neither is a
 * column, neither can be set, and deleting a registry entry drops the format
 * back down the ladder on the next read with nothing to update. That is the
 * brief's "do not falsely claim support for puzzle formats lacking real
 * validators" made structural — §37's rule that a definition is not an
 * implementation, at a product somebody would buy.
 *
 * ---------------------------------------------------------------------------
 * The ladder is contiguous, so a later rung cannot paper over an earlier gap
 * ---------------------------------------------------------------------------
 *
 * `reached` is the highest rung whose every predecessor is also established.
 * A format with a qualified edition and no revenue stops at `SELLABLE` even
 * though `SCALABLE`'s own condition may hold, and the fact that it holds is
 * reported separately as an observation rather than promoted into the reading.
 * A ladder that let a high rung be reported over a missing low one would say a
 * format was scaling when nothing had ever been sold.
 *
 * ---------------------------------------------------------------------------
 * Three rungs are not readable here, and that is reported rather than faked
 * ---------------------------------------------------------------------------
 *
 * `REVENUE_PROVEN`, `REPEATABLE` and `PRODUCTION_OWNED` are facts about money
 * and about machines. Money lives in Cash Mode's ledger (§30) and owned
 * production in the manufacturing programme (§39), and nothing links an
 * edition to either. So their conditions answer `UNKNOWN` with the link that
 * would establish them named — invariant 39, and §30's rule that *we could not
 * tell* must never read the same as *we checked*. Reporting them as NOT_MET
 * would be a confident claim that nothing has ever sold, which is a different
 * and unestablished statement.
 */
import { FORMAT_MATURITIES, type FormatMaturity } from '../../domain/types.ts';
import { supportFor, unimplementedReason } from './registry.ts';
import { readValidation } from './validate.ts';
import type { EditionContext, EditionReading } from './editions.ts';
import type { PuzzleFormat, PuzzleRound } from '../../domain/types.ts';

export type RungState = 'MET' | 'NOT_MET' | 'UNKNOWN';

export interface Rung {
  rung: FormatMaturity;
  state: RungState;
  why: string;
}

export interface FormatReading {
  formatId: string;
  slug: string;
  name: string;
  /** The highest rung whose every predecessor is also MET. */
  reached: FormatMaturity;
  rungs: Rung[];
  /** What stops the next rung, and what would move it. Null when nothing is left to read. */
  blocker: { rung: FormatMaturity; why: string } | null;
  /** Rungs whose own condition holds but which the ladder has not reached. */
  aheadOfItself: FormatMaturity[];
  /** What this format's support does not establish, from the registry. */
  knownGaps: readonly string[];
  counts: {
    masters: number;
    instances: number;
    validated: number;
    failing: number;
    unchecked: number;
    editions: number;
    qualifiedEditions: number;
  };
}

export interface MaturityInput {
  format: PuzzleFormat;
  context: EditionContext;
  readings: readonly EditionReading[];
  rounds: readonly PuzzleRound[];
}

export function readFormat(input: MaturityInput): FormatReading {
  const { format, context } = input;
  const support = supportFor(format.slug);

  const masters = [...context.masters.values()].filter((one) => one.formatId === format.id);
  const masterIds = new Set(masters.map((one) => one.id));
  const instances = [...context.instances.values()].filter((one) => one.formatId === format.id);

  let validated = 0;
  let failing = 0;
  let unchecked = 0;
  const validatedIds = new Set<string>();
  for (const instance of instances) {
    const reading = readValidation({
      formatSlug: format.slug,
      instance,
      validations: context.validations.get(instance.id) ?? [],
    });
    if (reading.state === 'VALIDATED') {
      validated += 1;
      validatedIds.add(instance.id);
    } else if (reading.state === 'FAILED') failing += 1;
    else unchecked += 1;
  }

  const editions = context.editions.filter((one) => masterIds.has(one.masterId));
  const byId = new Map(input.readings.map((one) => [one.editionId, one]));
  const qualified = editions.filter((one) => byId.get(one.id)?.qualified === true);

  /* A validated puzzle of this format carried by any edition at all. */
  const carriedValidated = editions.some((edition) =>
    (context.members.get(edition.id) ?? []).some((member) => validatedIds.has(member.instanceId)),
  );

  const settled = input.rounds.filter(
    (one) => one.formatId === format.id && one.state === 'HARVESTED' && (one.found ?? 0) > 0,
  );

  const rungs: Rung[] = [];

  rungs.push({
    rung: 'DISCOVERED',
    state: 'MET',
    why:
      format.origin === 'SEED'
        ? 'A person put it on the map.'
        : 'A gated claim established that it exists, and the claim is on the row.',
  });

  rungs.push(
    settled.length > 0
      ? {
          rung: 'RESEARCHED',
          state: 'MET',
          why: `${settled.length} settled round(s) established something about it.`,
        }
      : {
          rung: 'RESEARCHED',
          state: 'NOT_MET',
          why:
            'No settled round has established anything about its buyers, channels, rights or ' +
            'production. Brain opens those by itself when the project authorizes research.',
        },
  );

  rungs.push(
    support
      ? {
          rung: 'GENERATABLE',
          state: 'MET',
          why: `${support.generatorKey} ${support.generatorVersion} produces one.`,
        }
      : {
          rung: 'GENERATABLE',
          state: 'NOT_MET',
          why: unimplementedReason(format.slug, format.name),
        },
  );

  if (!support) {
    rungs.push({
      rung: 'VALIDATABLE',
      state: 'UNKNOWN',
      why:
        'With no generator there is nothing to check, so nothing has been established either ' +
        'way. A validator without a generator would have nothing to run against.',
    });
  } else if (validated > 0) {
    rungs.push({
      rung: 'VALIDATABLE',
      state: 'MET',
      why:
        `${validated} puzzle(s) passed every check ${support.validatorKey} ` +
        `${support.validatorVersion} requires.`,
    });
  } else if (instances.length === 0) {
    rungs.push({
      rung: 'VALIDATABLE',
      state: 'NOT_MET',
      why:
        `${support.validatorKey} exists and has never been run, because no puzzle of this ` +
        'format has been produced. Producing a batch is the remedy.',
    });
  } else {
    rungs.push({
      rung: 'VALIDATABLE',
      state: 'NOT_MET',
      why:
        `${instances.length} puzzle(s) exist and none of them passed every required check: ` +
        `${failing} failed and ${unchecked} were not established.`,
    });
  }

  rungs.push(
    carriedValidated
      ? {
          rung: 'PRODUCTIZABLE',
          state: 'MET',
          why: 'A validated puzzle of this format is carried by an edition.',
        }
      : {
          rung: 'PRODUCTIZABLE',
          state: 'NOT_MET',
          why:
            validated > 0
              ? 'Validated puzzles exist and no edition carries one yet. Declaring an edition ' +
                'and placing them in it is the remedy.'
              : 'No validated puzzle of this format exists to put in anything.',
        },
  );

  rungs.push(
    qualified.length > 0
      ? {
          rung: 'SELLABLE',
          state: 'MET',
          why: `${qualified.length} edition(s) are validated, rights-clear and distinct.`,
        }
      : {
          rung: 'SELLABLE',
          state: 'NOT_MET',
          why:
            editions.length === 0
              ? 'No edition of this format exists.'
              : `${editions.length} edition(s) exist and none qualifies. Each one says which of ` +
                'its four conditions is outstanding.',
        },
  );

  /*
   * The three that are about money and machines.
   *
   * `UNKNOWN` throughout, with the missing link named. This is the honest
   * answer and not a placeholder: Brain genuinely cannot read these, and a
   * NOT_MET would assert that nothing has ever sold — which nobody has
   * established either.
   */
  const NO_MONEY_LINK =
    'Nothing links an edition to a money entry, so revenue cannot be read from here at all. ' +
    'Cash Mode holds the ledger (§30) and an edition sold through an opening is what would ' +
    'establish this. Until that link exists, silence about revenue is silence rather than zero.';

  rungs.push({ rung: 'REVENUE_PROVEN', state: 'UNKNOWN', why: NO_MONEY_LINK });
  rungs.push({ rung: 'REPEATABLE', state: 'UNKNOWN', why: NO_MONEY_LINK });

  const scalableHolds = masters.some(
    (master) =>
      qualified.filter((edition) => edition.masterId === master.id).length >= 2,
  );
  rungs.push(
    scalableHolds
      ? {
          rung: 'SCALABLE',
          state: 'MET',
          why: 'At least one master of this format has two or more qualified editions.',
        }
      : {
          rung: 'SCALABLE',
          state: 'NOT_MET',
          why: 'No master of this format has two or more qualified editions.',
        },
  );

  rungs.push({
    rung: 'PRODUCTION_OWNED',
    state: 'UNKNOWN',
    why:
      'Nothing links an edition to equipment this operation owns. The manufacturing programme ' +
      '(§39) holds what capabilities are held, and only a person may record one — so this is ' +
      'unreadable here rather than false.',
  });

  const order = new Map(FORMAT_MATURITIES.map((one, index) => [one, index]));
  const byRung = new Map(rungs.map((one) => [one.rung, one]));

  let reached: FormatMaturity = 'DISCOVERED';
  let blocker: FormatReading['blocker'] = null;
  for (const rung of FORMAT_MATURITIES) {
    const entry = byRung.get(rung);
    if (entry?.state === 'MET') {
      reached = rung;
      continue;
    }
    blocker = { rung, why: entry?.why ?? 'Nothing establishes this rung.' };
    break;
  }

  const reachedIndex = order.get(reached) ?? 0;
  const aheadOfItself = rungs
    .filter((one) => one.state === 'MET' && (order.get(one.rung) ?? 0) > reachedIndex)
    .map((one) => one.rung);

  return {
    formatId: format.id,
    slug: format.slug,
    name: format.name,
    reached,
    rungs,
    blocker,
    aheadOfItself,
    knownGaps: support?.knownGaps ?? [],
    counts: {
      masters: masters.length,
      instances: instances.length,
      validated,
      failing,
      unchecked,
      editions: editions.length,
      qualifiedEditions: qualified.length,
    },
  };
}
