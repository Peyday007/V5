/**
 * The things a person says, which no derivation could recover.
 *
 * Three, and each is a decision rather than a reading: that this operation
 * makes puzzles of this kind, that a reusable system exists with its content
 * standing on a particular rights basis, and that a compiled edition is a
 * genuinely different product.
 *
 * ---------------------------------------------------------------------------
 * Declaring spends nothing and starts nothing
 * ---------------------------------------------------------------------------
 *
 * Every function here writes a row. None of them generates a puzzle, opens a
 * research round, spends an allowance, publishes anything or engages anybody.
 * The kernel decides when a format is asked about, the standing authority
 * decides whether that may run, the evidence gate decides what may be claimed,
 * and a person decides what is sold.
 *
 * ---------------------------------------------------------------------------
 * A generator key nothing implements is refused here
 * ---------------------------------------------------------------------------
 *
 * §27 records the rule at a factory worker kind: a kind nothing implements is
 * refused at registration rather than discovered at dispatch. A master naming
 * a missing generator would look perfectly healthy until the first batch, and
 * the refusal would then arrive at the worst moment with the least context.
 */
import { recordEvent } from '../../repos/events.ts';
import {
  createEdition,
  createMaster,
  getFormat,
  getMaster,
  listEditions,
  upsertFormat,
} from '../../repos/puzzles.ts';
import { supportFor, supportForGenerator, supportedSlugs } from './registry.ts';
import { rightsPermitPublication } from '../../domain/puzzles.ts';
import type {
  DistinctnessAxis,
  ProductClass,
  PuzzleEdition,
  PuzzleFormat,
  PuzzleMaster,
  RightsBasis,
} from '../../domain/types.ts';

export type Declared<T> = { ok: true; value: T; created: boolean } | { ok: false; reason: string };

/**
 * Put a format on the map.
 *
 * Accepts a name this Brain cannot generate, deliberately. The universe is
 * what exists in the world and the registry is what Brain's hands can do; a
 * map that refused everything Brain cannot yet make would be unable to record
 * the very gaps that decide what to build next. The reading says plainly which
 * it is.
 */
export async function declareFormat(input: {
  projectId: string;
  name: string;
  description?: string | null;
  actorRef: string;
}): Promise<Declared<PuzzleFormat>> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'A format needs a name.' };

  const result = await upsertFormat({
    projectId: input.projectId,
    name,
    description: input.description ?? null,
    origin: 'SEED',
    declaredByRef: input.actorRef,
  });

  if (result.created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'puzzle_format',
      entityId: result.format.id,
      eventType: 'PUZZLE_DECLARED',
      payload: {
        what: 'FORMAT',
        name: result.format.name,
        slug: result.format.slug,
        generatable: supportFor(result.format.slug) !== null,
        actorRef: input.actorRef,
      },
    });
  }

  return { ok: true, value: result.format, created: result.created };
}

export async function declareMaster(input: {
  projectId: string;
  formatId: string;
  name: string;
  generatorKey: string;
  spec: Record<string, unknown>;
  rightsBasis: RightsBasis;
  rightsStatement: string | null;
  rightsClaimId?: string | null;
  actorRef: string;
}): Promise<Declared<PuzzleMaster>> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'A master needs a name.' };

  const format = await getFormat(input.formatId);
  if (!format || format.projectId !== input.projectId) {
    return { ok: false, reason: 'No format with that id.' };
  }
  if (format.retiredAt) {
    return { ok: false, reason: `${format.name} was retired, so nothing new is built on it.` };
  }

  const support = supportForGenerator(input.generatorKey);
  if (!support) {
    return {
      ok: false,
      reason:
        `No generator named "${input.generatorKey}" exists in this repository, so a master ` +
        'using it could never produce anything. What this Brain can currently generate is: ' +
        `${supportedSlugs().join(', ')}. Adding another is a Software Factory change somebody ` +
        'approves, not a row.',
    };
  }
  if (support.slug !== format.slug) {
    return {
      ok: false,
      reason:
        `${input.generatorKey} produces ${support.slug} and this master is declared under ` +
        `${format.slug}. A master filed under the wrong format would be counted against it in ` +
        'every reading, and the multiplier would be about the wrong thing.',
    };
  }

  if (input.rightsBasis !== 'UNESTABLISHED' && !input.rightsStatement?.trim()) {
    return {
      ok: false,
      reason:
        `A rights basis of ${input.rightsBasis} must say what it actually is — which public ` +
        'domain source, whose own work, which licence. A basis with no statement is an ' +
        'assertion nobody could check later.',
    };
  }

  /*
   * The spec is put through the generator before the row is written.
   *
   * A master whose parameters the generator refuses is one that will refuse
   * every batch, and finding that out at declaration costs one call. §27's
   * rule about a plan validated to death before a row is written, at a
   * smaller scale — a partially-usable master is a row that looks healthy and
   * does nothing.
   */
  const probe = support.generate({ spec: input.spec, seed: `probe:${name}` });
  if (!probe.ok) {
    return {
      ok: false,
      reason: `${support.generatorKey} refuses these parameters: ${probe.error}`,
    };
  }

  const result = await createMaster({
    projectId: input.projectId,
    formatId: format.id,
    name,
    generatorKey: support.generatorKey,
    generatorVersion: support.generatorVersion,
    spec: input.spec,
    rightsBasis: input.rightsBasis,
    rightsStatement: input.rightsStatement?.trim() || null,
    rightsClaimId: input.rightsClaimId ?? null,
    declaredByRef: input.actorRef,
  });

  if (result.created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'puzzle_master',
      entityId: result.master.id,
      eventType: 'PUZZLE_DECLARED',
      payload: {
        what: 'MASTER',
        name: result.master.name,
        formatId: format.id,
        generatorKey: result.master.generatorKey,
        generatorVersion: result.master.generatorVersion,
        rightsBasis: result.master.rightsBasis,
        publishable: rightsPermitPublication(result.master.rightsBasis),
        actorRef: input.actorRef,
      },
    });
  }

  return { ok: true, value: result.master, created: result.created };
}

export async function declareEdition(input: {
  projectId: string;
  masterId: string;
  name: string;
  productClass: ProductClass;
  distinctnessAxis: DistinctnessAxis;
  distinctnessValue: string | null;
  rationale: string;
  actorRef: string;
}): Promise<Declared<PuzzleEdition>> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'An edition needs a name.' };
  if (!input.rationale.trim()) {
    return {
      ok: false,
      reason:
        'An edition must say why it is a different product. That sentence is what a person ' +
        'reads when they ask whether the catalog is real.',
    };
  }

  const master = await getMaster(input.masterId);
  if (!master || master.projectId !== input.projectId) {
    return { ok: false, reason: 'No master with that id.' };
  }
  if (master.retiredAt) {
    return { ok: false, reason: `${master.name} was retired, so nothing new is compiled from it.` };
  }

  if (input.distinctnessAxis !== 'DISTINCT_CONTENT' && !input.distinctnessValue?.trim()) {
    return {
      ok: false,
      reason:
        `An edition differing by ${input.distinctnessAxis} must name the value it differs on. ` +
        'Two editions claiming one axis are compared on their values, and one with no value ' +
        'could not be compared at all.',
    };
  }

  /*
   * A sibling clash is reported at declaration as a *warning* rather than
   * refused, and the edition is still written.
   *
   * Refusing would stop somebody recording a product they have genuinely made,
   * and `readEdition` already refuses to call it qualified — which is the
   * statement that matters, is derived, and comes back by itself if the clash
   * stops holding. §30's rule that a row is not a decision: this is a row.
   */
  const siblings = (await listEditions(input.projectId)).filter(
    (one) => one.masterId === master.id && one.retiredAt === null,
  );
  const clash =
    input.distinctnessAxis !== 'DISTINCT_CONTENT'
      ? siblings.find(
          (one) =>
            one.distinctnessAxis === input.distinctnessAxis &&
            (one.distinctnessValue ?? '').toLowerCase() ===
              (input.distinctnessValue ?? '').trim().toLowerCase(),
        )
      : undefined;

  const result = await createEdition({
    projectId: input.projectId,
    masterId: master.id,
    name,
    productClass: input.productClass,
    distinctnessAxis: input.distinctnessAxis,
    distinctnessValue: input.distinctnessValue?.trim() || null,
    rationale: input.rationale,
    declaredByRef: input.actorRef,
  });

  if (result.created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'puzzle_edition',
      entityId: result.edition.id,
      eventType: 'PUZZLE_DECLARED',
      payload: {
        what: 'EDITION',
        name: result.edition.name,
        masterId: master.id,
        productClass: result.edition.productClass,
        distinctnessAxis: result.edition.distinctnessAxis,
        clashesWith: clash?.id ?? null,
        actorRef: input.actorRef,
      },
    });
  }

  return { ok: true, value: result.edition, created: result.created };
}
