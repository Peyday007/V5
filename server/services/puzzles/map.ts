/**
 * The whole kernel as one recorded reading.
 *
 * Built once per pass and handed to the allocator, which is pure over it —
 * `services/dispatch/router.ts`' split, for its reason: "why did Brain
 * research that" has to be answerable afterwards from a recorded input rather
 * than from a re-run against a database that has moved on.
 *
 * Every number in here is derived. Nothing in this module writes anything.
 */
import { listFormats, listRounds } from '../../repos/puzzles.ts';
import { editionContext, readEdition, type EditionContext, type EditionReading } from './editions.ts';
import { readFormat, type FormatReading } from './maturity.ts';
import { readLeverage, type LeverageReading } from './leverage.ts';
import { readValidation } from './validate.ts';
import { rightsPermitPublication } from '../../domain/puzzles.ts';
import type { PuzzleFormat, PuzzleMaster, PuzzleRound } from '../../domain/types.ts';

/** What is true of one master, for the readings and for the allocator. */
export interface MasterReading {
  master: PuzzleMaster;
  format: PuzzleFormat | null;
  instances: number;
  validated: number;
  failing: number;
  /** Puzzles whose duplicate key collided, as a share of what was asked for. */
  blocked: boolean;
  /** Whether what it makes could be sold at all, on the rights recorded. */
  publishable: boolean;
  editions: number;
  qualifiedEditions: number;
}

export interface PuzzleSnapshot {
  projectId: string;
  /** The instant the reading was taken, so a pure decision never reads a clock. */
  at: string;
  formats: FormatReading[];
  formatRows: PuzzleFormat[];
  masters: MasterReading[];
  editions: EditionReading[];
  rounds: PuzzleRound[];
  leverage: LeverageReading;
  context: EditionContext;
}

export async function puzzleSnapshot(projectId: string): Promise<PuzzleSnapshot> {
  const [context, formatRows, rounds] = await Promise.all([
    editionContext(projectId),
    listFormats(projectId),
    listRounds(projectId),
  ]);

  const editions = context.editions.map((edition) => readEdition(edition, context));

  const live = formatRows.filter((one) => one.retiredAt === null);
  const formats = live.map((format) =>
    readFormat({ format, context, readings: editions, rounds }),
  );

  const byEdition = new Map(editions.map((one) => [one.editionId, one]));

  const masters: MasterReading[] = [...context.masters.values()].map((master) => {
    const instances = [...context.instances.values()].filter(
      (one) => one.masterId === master.id,
    );
    const format = context.formats.get(master.formatId) ?? null;
    let validated = 0;
    let failing = 0;
    for (const instance of instances) {
      const reading = readValidation({
        formatSlug: format?.slug ?? '',
        instance,
        validations: context.validations.get(instance.id) ?? [],
      });
      if (reading.state === 'VALIDATED') validated += 1;
      else if (reading.state === 'FAILED') failing += 1;
    }
    const mine = context.editions.filter(
      (one) => one.masterId === master.id && one.retiredAt === null,
    );
    return {
      master,
      format,
      instances: instances.length,
      validated,
      failing,
      blocked: master.blockedAt !== null,
      publishable: rightsPermitPublication(master.rightsBasis),
      editions: mine.length,
      qualifiedEditions: mine.filter((one) => byEdition.get(one.id)?.qualified === true).length,
    };
  });

  return {
    projectId,
    at: new Date().toISOString(),
    formats,
    formatRows: live,
    masters,
    editions,
    rounds,
    leverage: readLeverage({ context, readings: editions }),
    context,
  };
}
