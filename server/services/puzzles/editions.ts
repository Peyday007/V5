/**
 * What makes an edition a real product rather than a second cover.
 *
 * ---------------------------------------------------------------------------
 * Qualification is derived, and every condition can stop being true
 * ---------------------------------------------------------------------------
 *
 * There is no `qualified` column. An edition qualifies because of facts that
 * all move — a validator version changes, a master's rights basis is
 * established, a sibling edition appears carrying the same puzzles — so a
 * stored verdict would be stale the moment one of them did. §33's tier and
 * §38's third rule, at a product.
 *
 * ---------------------------------------------------------------------------
 * The anti-reskin rule is computable, which is the whole point
 * ---------------------------------------------------------------------------
 *
 * The brief says a cover change, a title change or a reordering does not
 * create a new qualified output, and the tempting implementation is a rule in
 * a document that somebody remembers. Here it is arithmetic over rows: an
 * edition claiming `DISTINCT_CONTENT` must carry at least one puzzle no
 * *earlier* edition of its master carries, and one claiming any other axis
 * must name a value no earlier edition on that axis already named. Position is
 * deliberately not an axis, so reordering the same puzzles can never qualify
 * anything.
 *
 * The comparison runs against what came *before*, and `judgeDistinct` records
 * why: without that, a reskin filled with the original's own puzzles made the
 * **original** stop qualifying.
 *
 * `COSMETIC` is recorded and never counted. Refusing to store one would be
 * worse: the reskin exists either way, and a schema that cannot hold it makes
 * misdeclaring the axis the only way to record it.
 *
 * ---------------------------------------------------------------------------
 * Three answers per condition, never two
 * ---------------------------------------------------------------------------
 *
 * `UNKNOWN` is a real answer and is never `MET` — §39's readiness at an
 * edition, and invariant 39 at the gate that decides whether something may be
 * sold. An edition whose puzzles are in a format nothing can check is not
 * *failing* validation; nothing has established anything about it, and those
 * two have different remedies.
 */
import {
  addEditionInstance,
  getEdition,
  getInstance,
  getMaster,
  listAllEditionInstances,
  listEditions,
  listFormats,
  listInstances,
  listMasters,
  listValidations,
} from '../../repos/puzzles.ts';
import { readValidation } from './validate.ts';
import { axisQualifies, rightsPermitPublication } from '../../domain/puzzles.ts';
import type {
  PuzzleEdition,
  PuzzleFormat,
  PuzzleInstance,
  PuzzleMaster,
  PuzzleValidation,
} from '../../domain/types.ts';

export type ConditionState = 'MET' | 'NOT_MET' | 'UNKNOWN';

export interface EditionCondition {
  key: 'HAS_CONTENT' | 'ALL_VALIDATED' | 'RIGHTS_CLEAR' | 'DISTINCT';
  state: ConditionState;
  why: string;
}

export interface EditionReading {
  editionId: string;
  /** Qualified only when all four conditions are MET. */
  qualified: boolean;
  conditions: EditionCondition[];
  /** How many puzzles it carries. */
  carried: number;
  /** How many of those are validated. */
  validated: number;
  /** The single sentence a person reads. */
  summary: string;
}

/** Everything one reading needs, fetched once so a list is not N queries. */
export interface EditionContext {
  editions: readonly PuzzleEdition[];
  members: ReadonlyMap<string, { instanceId: string; position: number }[]>;
  instances: ReadonlyMap<string, PuzzleInstance>;
  masters: ReadonlyMap<string, PuzzleMaster>;
  formats: ReadonlyMap<string, PuzzleFormat>;
  validations: ReadonlyMap<string, PuzzleValidation[]>;
}

/**
 * Whether this edition differs from its siblings, and how it was decided.
 *
 * Siblings are the other live editions of the *same master*, because the
 * multiplier being protected is master-to-SKU: two editions of two different
 * masters are two products whatever they have in common.
 */
function judgeDistinct(
  edition: PuzzleEdition,
  context: EditionContext,
): EditionCondition {
  if (!axisQualifies(edition.distinctnessAxis)) {
    return {
      key: 'DISTINCT',
      state: 'NOT_MET',
      why:
        'This is declared a cosmetic variant. It is recorded honestly and is never counted as ' +
        'a qualified output — a different cover on the same puzzles is not a second product.',
    };
  }

  /*
   * Siblings are the ones that came *first*, and that asymmetry is the whole
   * of this rule working.
   *
   * The first version compared against every live sibling in both directions,
   * and running it found what that costs: declaring a cosmetic reskin of
   * "Volume One" and filling it with Volume One's own puzzles made **Volume
   * One** stop qualifying, because every puzzle it carried now appeared
   * somewhere else too. A copy had retroactively unmade the thing it copied,
   * and the catalog's qualified count went from one to nought on a change that
   * added nothing.
   *
   * Precedence fixes it without weakening anything: an edition is judged
   * against what already existed when it was declared, so the original keeps
   * what it earned and the duplicate is the one refused. The order is
   * `created_at` with the id as a tiebreak, because two rows written in the
   * same millisecond still have to compare deterministically — the same reason
   * §27 records for an `ORDER BY` that must be sayable twice.
   */
  const precedes = (one: PuzzleEdition) =>
    one.createdAt < edition.createdAt ||
    (one.createdAt === edition.createdAt && one.id < edition.id);

  const siblings = context.editions.filter(
    (one) => one.id !== edition.id && one.masterId === edition.masterId && one.retiredAt === null && precedes(one),
  );
  if (siblings.length === 0) {
    return {
      key: 'DISTINCT',
      state: 'MET',
      why:
        'Nothing of this master came before it, so there is nothing for it to repeat. A later ' +
        'edition is judged against this one rather than the other way round.',
    };
  }

  if (edition.distinctnessAxis === 'DISTINCT_CONTENT') {
    const mine = new Set((context.members.get(edition.id) ?? []).map((one) => one.instanceId));
    const elsewhere = new Set<string>();
    for (const sibling of siblings) {
      for (const member of context.members.get(sibling.id) ?? []) elsewhere.add(member.instanceId);
    }
    const unique = [...mine].filter((one) => !elsewhere.has(one));
    if (unique.length === 0) {
      return {
        key: 'DISTINCT',
        state: 'NOT_MET',
        why:
          `Every one of its ${mine.size} puzzle(s) already appears in an earlier edition of ` +
          'this master, so it claims distinct content and has none. A collection of puzzles a ' +
          'buyer may already own is a real product — but its axis is the form, the occasion or ' +
          'the channel, not the content.',
      };
    }
    return {
      key: 'DISTINCT',
      state: 'MET',
      why: `${unique.length} of its ${mine.size} puzzle(s) appear in no earlier edition.`,
    };
  }

  const clash = siblings.find(
    (one) =>
      one.distinctnessAxis === edition.distinctnessAxis &&
      (one.distinctnessValue ?? '').toLowerCase() ===
        (edition.distinctnessValue ?? '').toLowerCase(),
  );
  if (clash) {
    return {
      key: 'DISTINCT',
      state: 'NOT_MET',
      why:
        `"${clash.name}" was already the ${edition.distinctnessAxis} ` +
        `"${edition.distinctnessValue}" edition of this master. Two editions differing on the ` +
        'same axis by the same value are one product twice, and the later one is the repeat.',
    };
  }
  return {
    key: 'DISTINCT',
    state: 'MET',
    why:
      `No earlier live edition of this master is the ${edition.distinctnessAxis} ` +
      `"${edition.distinctnessValue}".`,
  };
}

export function readEdition(edition: PuzzleEdition, context: EditionContext): EditionReading {
  const members = context.members.get(edition.id) ?? [];
  const master = context.masters.get(edition.masterId) ?? null;

  const conditions: EditionCondition[] = [];

  conditions.push(
    members.length > 0
      ? { key: 'HAS_CONTENT', state: 'MET', why: `It carries ${members.length} puzzle(s).` }
      : {
          key: 'HAS_CONTENT',
          state: 'NOT_MET',
          why: 'It carries no puzzles at all, so there is nothing for a buyer to receive.',
        },
  );

  /*
   * Validation, read per carried puzzle.
   *
   * The three ways this can be short are kept apart because their remedies
   * are: a failing puzzle means repair the generator, an unchecked one means
   * run the validator, and an uncheckable one means write one. Collapsing them
   * into "not validated" would send everybody to the same wrong place.
   */
  let validated = 0;
  const failing: string[] = [];
  const unproven: string[] = [];
  const uncheckable: string[] = [];
  for (const member of members) {
    const instance = context.instances.get(member.instanceId);
    if (!instance) {
      unproven.push(member.instanceId);
      continue;
    }
    const format = context.formats.get(instance.formatId);
    const reading = readValidation({
      formatSlug: format?.slug ?? '',
      instance,
      validations: context.validations.get(instance.id) ?? [],
    });
    if (reading.state === 'VALIDATED') validated += 1;
    else if (reading.state === 'FAILED') failing.push(instance.id);
    else if (reading.state === 'UNCHECKABLE') uncheckable.push(instance.id);
    else unproven.push(instance.id);
  }

  if (members.length === 0) {
    conditions.push({
      key: 'ALL_VALIDATED',
      state: 'UNKNOWN',
      why: 'There are no puzzles here, so nothing has been checked either way.',
    });
  } else if (failing.length > 0) {
    conditions.push({
      key: 'ALL_VALIDATED',
      state: 'NOT_MET',
      why:
        `${failing.length} of ${members.length} puzzle(s) failed a required check. This edition ` +
        'contains a wrong puzzle, and the remedy is the generator rather than the edition.',
    });
  } else if (uncheckable.length > 0) {
    conditions.push({
      key: 'ALL_VALIDATED',
      state: 'UNKNOWN',
      why:
        `${uncheckable.length} of ${members.length} puzzle(s) are in a format nothing in this ` +
        'repository can check, so nothing has been established about them. That is not a ' +
        'failure and it is not a pass.',
    });
  } else if (unproven.length > 0) {
    conditions.push({
      key: 'ALL_VALIDATED',
      state: 'NOT_MET',
      why:
        `${unproven.length} of ${members.length} puzzle(s) have not been checked at the current ` +
        'validator version. Re-running the validator is the remedy.',
    });
  } else {
    conditions.push({
      key: 'ALL_VALIDATED',
      state: 'MET',
      why: `All ${members.length} puzzle(s) passed every check their format requires.`,
    });
  }

  if (!master) {
    conditions.push({
      key: 'RIGHTS_CLEAR',
      state: 'UNKNOWN',
      why: 'The master this edition was compiled from cannot be read.',
    });
  } else if (rightsPermitPublication(master.rightsBasis)) {
    conditions.push({
      key: 'RIGHTS_CLEAR',
      state: 'MET',
      why:
        `Its master is ${master.rightsBasis}: ` +
        `${master.rightsStatement ?? 'no statement recorded'}`,
    });
  } else {
    conditions.push({
      key: 'RIGHTS_CLEAR',
      state: 'NOT_MET',
      why:
        'Nobody has established what this master’s content may be published on. It may be ' +
        'generated and checked freely — that publishes nothing — and it may not be sold until ' +
        'somebody records a basis.',
    });
  }

  conditions.push(judgeDistinct(edition, context));

  const unmet = conditions.filter((one) => one.state !== 'MET');
  const qualified = unmet.length === 0;

  return {
    editionId: edition.id,
    qualified,
    conditions,
    carried: members.length,
    validated,
    summary: qualified
      ? `${edition.name} is a qualified ${edition.productClass}: ${members.length} validated ` +
        `puzzle(s), rights established, and distinct from its siblings.`
      : `${edition.name} is not a qualified output yet — ${unmet
          .map((one) => one.key)
          .join(' and ')} ${unmet.length === 1 ? 'is' : 'are'} outstanding.`,
  };
}

/**
 * Load everything the readings need, once.
 *
 * One pass over the project rather than a query per edition, because the
 * distinctness check is inherently about siblings: a reading that fetched per
 * edition would have to re-fetch every sibling to answer one of them, and the
 * whole list would be quadratic in the size of the catalog.
 */
export async function editionContext(projectId: string): Promise<EditionContext> {
  const [editions, memberRows, validations, instances, masters, formats] = await Promise.all([
    listEditions(projectId),
    listAllEditionInstances(projectId),
    listValidations(projectId),
    listInstances(projectId),
    listMasters(projectId),
    listFormats(projectId),
  ]);

  const members = new Map<string, { instanceId: string; position: number }[]>();
  for (const [editionId, rows] of memberRows) {
    members.set(
      editionId,
      rows.map((one) => ({ instanceId: one.instanceId, position: one.position })),
    );
  }

  const byInstance = new Map<string, PuzzleValidation[]>();
  for (const one of validations) {
    const list = byInstance.get(one.instanceId) ?? [];
    list.push(one);
    byInstance.set(one.instanceId, list);
  }

  return {
    editions,
    members,
    instances: new Map(instances.map((one) => [one.id, one])),
    masters: new Map(masters.map((one) => [one.id, one])),
    formats: new Map(formats.map((one) => [one.id, one])),
    validations: byInstance,
  };
}

/** Every edition in the project, read. */
export async function readEditions(projectId: string): Promise<EditionReading[]> {
  const context = await editionContext(projectId);
  return context.editions.map((edition) => readEdition(edition, context));
}

/**
 * Put a puzzle in an edition.
 *
 * Deliberately permissive about *validation*: a puzzle that has not passed yet
 * may be placed, and the edition simply does not qualify. That is the right
 * way round — refusing here would stop somebody assembling a book while a
 * validator is being written, and `readEdition` already refuses to call the
 * result a product, which is the statement that actually matters. What is
 * refused is a puzzle from another project and a puzzle from another master,
 * the second because the master-to-SKU multiplier counts editions *of a
 * master* and an edition drawing from two would be counted against both.
 */
export async function placeInEdition(input: {
  projectId: string;
  editionId: string;
  instanceId: string;
  position: number;
}): Promise<{ ok: true; created: boolean } | { ok: false; reason: string }> {
  const [edition, instance] = await Promise.all([
    getEdition(input.editionId),
    getInstance(input.instanceId),
  ]);
  if (!edition || edition.projectId !== input.projectId) {
    return { ok: false, reason: 'No edition with that id.' };
  }
  if (!instance || instance.projectId !== input.projectId) {
    return { ok: false, reason: 'No puzzle with that id.' };
  }
  if (edition.retiredAt) {
    return { ok: false, reason: `${edition.name} was retired, so nothing more goes into it.` };
  }
  if (edition.compiledAt) {
    return {
      ok: false,
      reason:
        `${edition.name} has already been compiled, and its artifact is what a buyer received. ` +
        'Changing what it contains now would make that artifact’s hash describe something ' +
        'else. A different set of puzzles is a different edition.',
    };
  }
  if (instance.masterId !== edition.masterId) {
    return {
      ok: false,
      reason:
        'That puzzle came from a different master. An edition belongs to one master, because ' +
        'the multiplier being counted is editions per master and one drawing from two would ' +
        'be counted against both.',
    };
  }
  return addEditionInstance({
    editionId: input.editionId,
    instanceId: input.instanceId,
    position: input.position,
  }).then((result) => ({ ok: true as const, created: result.created }));
}

/** The master behind an edition, for callers that need its rights basis. */
export async function masterFor(edition: PuzzleEdition): Promise<PuzzleMaster | null> {
  return getMaster(edition.masterId);
}
