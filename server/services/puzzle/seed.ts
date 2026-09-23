/**
 * The things a person does to this kernel directly.
 *
 * ---------------------------------------------------------------------------
 * Naming a format is a person's, and the schema enforces it
 * ---------------------------------------------------------------------------
 *
 * `puzzle_formats.origin` is `SEED` or `DISCOVERED`, and a CHECK requires
 * every `DISCOVERED` row to carry the claim that established it. So Brain
 * cannot write a `SEED` format at all: there is no code path that could,
 * because there is no way for it to produce a row with no claim and a seeded
 * origin. §22's split at the table that decides what the universe is.
 *
 * Seeding spends nothing and starts nothing. It creates a row; the allocator
 * decides when that format is asked about, the discovery grant decides whether
 * that may run, and the evidence gate decides what may be claimed.
 *
 * ---------------------------------------------------------------------------
 * Recording what happened is a person's for a different reason
 * ---------------------------------------------------------------------------
 *
 * An observation is the one kind of fact here that no source publishes and no
 * validator computes: whether the editor accepted the submission, whether the
 * book sold, whether a reader could not finish puzzle 43, whether the playtest
 * found it dull. It comes from an attempt somebody made, so it comes from them.
 *
 * Two of the kinds are load-bearing rather than informational.
 * `HUMAN_EDIT_PASSED` is the only thing that can move a format to SELLABLE,
 * and there is no flag anywhere that stands in for it. `ROUTE_REJECTED` is the
 * only thing that archives a route in the ledger — which keeps the route
 * visible with its reason rather than making it disappear.
 */
import { recordCashEvent } from '../../repos/cashMode.ts';
import {
  createPuzzleFormat,
  createPuzzleMaster,
  getPuzzleFormat,
  recordPuzzleObservation,
  retirePuzzleFormat,
} from '../../repos/puzzle.ts';
import { corpus, mayCompileCommercially } from '../../domain/puzzleCorpora.ts';
import { formatFor, implementedFormats } from './formats/index.ts';
import { MONETIZATION_ROUTES } from './ledger.ts';
import type {
  PuzzleDifficulty,
  PuzzleFormatEntry,
  PuzzleMaster,
  PuzzleObservation,
  PuzzleObservationKind,
} from '../../domain/types.ts';

const SEEDED = 'PUZZLE_FORMAT_SEEDED';
const RETIRED = 'PUZZLE_FORMAT_RETIRED';
const OBSERVED = 'PUZZLE_OUTCOME_OBSERVED';
const MASTER_DEFINED = 'PUZZLE_SYSTEM_DEFINED';

export async function seedFormat(input: {
  projectId: string;
  actorRef: string;
  name: string;
  note?: string | null;
}): Promise<{ format: PuzzleFormatEntry; created: boolean }> {
  const result = await createPuzzleFormat({
    projectId: input.projectId,
    name: input.name,
    note: input.note ?? null,
    origin: 'SEED',
    sourceClaimId: null,
  });
  if (result.created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: SEEDED,
      actorRef: input.actorRef,
      summary: `${result.format.name} was seeded as a puzzle format.`,
      detail: {
        formatId: result.format.id,
        formatKey: result.format.formatKey,
        /*
         * Whether this repository can actually make one, recorded at the
         * moment it is seeded — so a person naming a format Brain has never
         * heard of is told immediately rather than finding out when nothing
         * ever gets generated.
         */
        generates: formatFor(result.format.formatKey)?.render != null,
        validates: formatFor(result.format.formatKey) != null,
      },
    });
  }
  return result;
}

/**
 * Stop asking about a format.
 *
 * Never a delete. A retired format is evidence about where Brain has already
 * looked, and deleting it would make the same format arrive again on the next
 * round as a fresh discovery — §5, and §38's own argument for the same column
 * on `industry_nodes`. Its masters, puzzles and products keep their rows too:
 * a format no longer worth pursuing is still one whose output was real.
 */
export async function retireFormat(input: {
  projectId: string;
  actorRef: string;
  formatId: string;
  reason: string;
}): Promise<PuzzleFormatEntry | null> {
  const before = await getPuzzleFormat(input.formatId);
  if (!before || before.projectId !== input.projectId) return null;
  const after = await retirePuzzleFormat({ formatId: input.formatId, reason: input.reason });
  if (after && before.retiredAt === null) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: RETIRED,
      actorRef: input.actorRef,
      summary: `${before.name} was retired: ${input.reason}`,
      detail: { formatId: before.id, reason: input.reason },
    });
  }
  return after;
}

export type DefineResult = { master: PuzzleMaster } | { refused: string };

/**
 * Set up a puzzle system.
 *
 * Both a person and the tick reach this, and the refusals are the same for
 * both — which is the point. A master that names a format nothing implements,
 * or a corpus this repository may not sell from, is refused at the moment it
 * is defined rather than producing a system that silently generates nothing.
 * The rights refusal in particular belongs here and not at generation time: by
 * then there would be a system somebody had set up and expected to work.
 */
export async function defineMaster(input: {
  projectId: string;
  actorRef: string;
  title: string;
  formatName: string;
  corpusId: string;
  difficulty: PuzzleDifficulty;
  parameters?: Readonly<Record<string, string | number>>;
}): Promise<DefineResult> {
  const implementation = formatFor(input.formatName);
  if (!implementation) {
    return {
      refused:
        `Nothing in this repository generates or checks "${input.formatName}". The formats it ` +
        `implements are ${implementedFormats()
          .map((one) => one.title)
          .join(', ')}. Adding one is a code change somebody reviews.`,
    };
  }
  if (!implementation.render) {
    return {
      refused:
        `${implementation.title} is authored rather than generated: its content is editorial ` +
        'work with no correctness criterion, so there is a validator here and deliberately no ' +
        'generator. Brain can check one somebody else wrote.',
    };
  }
  const source = corpus(input.corpusId);
  if (!source) {
    return { refused: `No corpus named ${input.corpusId} is shipped with this repository.` };
  }
  if (!mayCompileCommercially(source.rights)) {
    return {
      refused:
        `The corpus ${source.id} reads ${source.rights}, so nothing may be compiled from it ` +
        `for sale. ${source.rightsBasis}`,
    };
  }

  const master = await createPuzzleMaster({
    projectId: input.projectId,
    title: input.title,
    formatName: input.formatName,
    corpusId: input.corpusId,
    parameters: input.parameters ?? {},
    difficulty: input.difficulty,
    /*
     * The version a repair would change. A fix to a generator produces
     * different output from the same seed, so instances made before and after
     * it are not interchangeable — and §5 forbids editing what the old one
     * made. A repair is a new version and a new master.
     */
    generatorVersion: `${implementation.key}@1`,
  });

  await recordCashEvent({
    projectId: input.projectId,
    kind: MASTER_DEFINED,
    actorRef: input.actorRef,
    summary: `${master.title} was set up as a ${implementation.title} system.`,
    detail: {
      masterId: master.id,
      formatKey: master.formatKey,
      corpusId: master.corpusId,
      rights: source.rights,
      difficulty: master.difficulty,
      generatorVersion: master.generatorVersion,
    },
  });
  return { master };
}

export async function observe(input: {
  projectId: string;
  actorRef: string;
  kind: PuzzleObservationKind;
  formatName?: string | null;
  productId?: string | null;
  monetizationRoute?: string | null;
  statement: string;
}): Promise<{ observation: PuzzleObservation } | { refused: string }> {
  /*
   * A rejection has to name a route that exists, because the ledger is a
   * constant and a rejection naming nothing would archive nothing while
   * looking like it had. The refusal lists what may be named rather than only
   * saying no.
   */
  if (input.monetizationRoute) {
    const known = MONETIZATION_ROUTES.some((one) => one.id === input.monetizationRoute);
    if (!known) {
      return {
        refused:
          `"${input.monetizationRoute}" is not a route in the monetization ledger. The ledger ` +
          'is a reviewed constant rather than a table, so a rejection has to name one of its ' +
          `entries: ${MONETIZATION_ROUTES.map((one) => one.id).join(', ')}.`,
      };
    }
  }
  if (input.kind === 'ROUTE_REJECTED' && !input.monetizationRoute) {
    return {
      refused:
        'A rejection has to say which route was turned down. Without one it archives nothing, ' +
        'and a route nobody can see was rejected is one that gets proposed again next week.',
    };
  }

  const observation = await recordPuzzleObservation({
    projectId: input.projectId,
    kind: input.kind,
    formatName: input.formatName ?? null,
    productId: input.productId ?? null,
    monetizationRoute: input.monetizationRoute ?? null,
    statement: input.statement,
    recordedBy: input.actorRef,
  });
  await recordCashEvent({
    projectId: input.projectId,
    kind: OBSERVED,
    actorRef: input.actorRef,
    summary: `${input.kind} recorded: ${input.statement}`,
    detail: {
      observationId: observation.id,
      kind: observation.kind,
      formatKey: observation.formatKey,
      productId: observation.productId,
      monetizationRoute: observation.monetizationRoute,
    },
  });
  return { observation };
}
