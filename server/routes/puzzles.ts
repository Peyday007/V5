/**
 * The puzzle kernel's door.
 *
 * Every route resolves through `requireProject`, which is `decideProjectAccess`
 * against the authenticated principal, so absent and forbidden are the same 404
 * **with the same body** — invariant 23, where the thing being hidden is what
 * somebody else's operation makes.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at the writes by level and by `MISSING_SCOPE`; this refuses it by *type*, at
 * the reads as well, because no membership configuration turns a machine into
 * a person — and a machine that could declare what its own output's content
 * stands on, or clear a block put on it for producing wrong puzzles, is
 * precisely what §22's split exists to prevent. Two independent guards, because
 * a guard on one entrance is not a guard.
 *
 * There is **no puzzle policy module and there must never be one.** Which level
 * each of these needs is declared in `services/identity/policy.ts` beside every
 * other route, for §21's reason: a second security model is a second thing to
 * keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/puzzles/`; these resolve the project, hand over the principal, and
 * turn a refusal into a status.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import {
  getEdition,
  getInstance,
  getMaster,
  listEditionInstances,
  listValidationsForInstance,
  retireEdition,
  retireFormat,
  retireMaster,
  unblockMaster,
} from '../repos/puzzles.ts';
import { declareEdition, declareFormat, declareMaster } from '../services/puzzles/declare.ts';
import { produceBatch, MAX_BATCH } from '../services/puzzles/produce.ts';
import { placeInEdition, readEditions } from '../services/puzzles/editions.ts';
import { compileEdition } from '../services/puzzles/compile.ts';
import { puzzleView } from '../services/puzzles/view.ts';
import { supportForGenerator, supportedSlugs } from '../services/puzzles/registry.ts';
import { readValidation } from '../services/puzzles/validate.ts';
import { isDistinctnessAxis, isProductClass, isRightsBasis } from '../domain/puzzles.ts';
import { DISTINCTNESS_AXES, PRODUCT_CLASSES, RIGHTS_BASES } from '../domain/types.ts';
import { listFormats } from '../repos/puzzles.ts';

export const puzzlesRouter = Router();

/* --------------------------------------------------------------------------
 * Reading it
 *
 * Any project member's, and deliberately so. What this operation makes, how
 * much of it passed its checks, which of the catalog is a real product and
 * which is a second cover on the same puzzles are exactly the things a person
 * working on this project needs to see without asking an administrator.
 * ------------------------------------------------------------------------ */

puzzlesRouter.get(
  '/projects/:projectId/puzzles',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return puzzleView(project.id);
  }),
);

/**
 * One puzzle, with what every check actually said about it.
 *
 * The verdicts are returned whole rather than summarised into a boolean,
 * because `UNSUPPORTED` and `FAIL` are different facts with different remedies
 * and a summary is exactly where they would collapse.
 */
puzzlesRouter.get(
  '/projects/:projectId/puzzles/instances/:instanceId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const instance = await getInstance(pathId(req, 'instanceId'));
    if (!instance || instance.projectId !== project.id) throw notFound('No puzzle with that id.');

    const formats = await listFormats(project.id);
    const format = formats.find((one) => one.id === instance.formatId) ?? null;
    const validations = await listValidationsForInstance(instance.id);

    return {
      instance,
      format: format ? { id: format.id, name: format.name, slug: format.slug } : null,
      validation: readValidation({
        formatSlug: format?.slug ?? '',
        instance,
        validations,
      }),
      // Every verdict ever recorded against these bytes, including ones from
      // an older validator version — history rather than evidence, and kept
      // because a check that changed its mind is worth being able to see.
      verdicts: validations,
    };
  }),
);

/* --------------------------------------------------------------------------
 * The three things a person declares
 *
 * ADMIN plus `requirePerson`, the pair every decision-shaped route already
 * carries. Declaring spends nothing and starts nothing: it writes a row, and
 * the kernel decides when a format is asked about, the standing authority
 * decides whether that may run, and the evidence gate decides what may be
 * claimed.
 * ------------------------------------------------------------------------ */

puzzlesRouter.post(
  '/projects/:projectId/puzzles/formats',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const result = await declareFormat({
      projectId: project.id,
      name: requiredString(body['name'], 'name'),
      description: optionalString(body['description'], 'description') ?? null,
      actorRef: principal.id,
    });
    if (!result.ok) throw unprocessable(result.reason);

    return {
      format: result.value,
      created: result.created,
      message: result.created
        ? `${result.value.name} is on the map. Whether Brain can actually produce one is a ` +
          'separate question the reading answers — the map is what exists in the world, and ' +
          'the registry is what this Brain’s hands can do.'
        : `${result.value.name} was already on the map, so nothing changed.`,
    };
  }),
);

puzzlesRouter.post(
  '/projects/:projectId/puzzles/masters',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const rightsRaw = requiredString(body['rightsBasis'], 'rightsBasis');
    if (!isRightsBasis(rightsRaw)) {
      throw badRequest(
        `"${rightsRaw}" is not a basis this map holds. The set is fixed in code: ` +
          `${RIGHTS_BASES.join(', ')}. UNESTABLISHED is a real answer and means the question ` +
          'is open — a master carrying it may generate and be checked, and may not be sold.',
      );
    }

    const spec = body['spec'];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw badRequest('spec must be an object of parameters for the generator.');
    }

    const result = await declareMaster({
      projectId: project.id,
      formatId: requiredString(body['formatId'], 'formatId'),
      name: requiredString(body['name'], 'name'),
      generatorKey: requiredString(body['generatorKey'], 'generatorKey'),
      spec: spec as Record<string, unknown>,
      rightsBasis: rightsRaw,
      rightsStatement: optionalString(body['rightsStatement'], 'rightsStatement') ?? null,
      rightsClaimId: optionalString(body['rightsClaimId'], 'rightsClaimId') ?? null,
      actorRef: principal.id,
    });
    if (!result.ok) throw unprocessable(result.reason);

    return {
      master: result.value,
      created: result.created,
      generators: supportedSlugs(),
      message: result.created
        ? `${result.value.name} is a reusable system. Its parameters were put through ` +
          `${result.value.generatorKey} before this row was written, so it is known to produce ` +
          'something rather than merely declared to. Brain tops it up on every tick.'
        : `${result.value.name} already existed, so nothing changed.`,
    };
  }),
);

puzzlesRouter.post(
  '/projects/:projectId/puzzles/editions',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const classRaw = requiredString(body['productClass'], 'productClass');
    if (!isProductClass(classRaw)) {
      throw badRequest(
        `"${classRaw}" is not a product class this catalog holds. The set is fixed in code: ` +
          `${PRODUCT_CLASSES.join(', ')}.`,
      );
    }

    const axisRaw = requiredString(body['distinctnessAxis'], 'distinctnessAxis');
    if (!isDistinctnessAxis(axisRaw)) {
      throw badRequest(
        `"${axisRaw}" is not an axis an edition can differ on. The set is fixed in code: ` +
          `${DISTINCTNESS_AXES.join(', ')}. COSMETIC is in it on purpose — a reskin is ` +
          'recorded honestly and is never counted as a qualified output.',
      );
    }

    const result = await declareEdition({
      projectId: project.id,
      masterId: requiredString(body['masterId'], 'masterId'),
      name: requiredString(body['name'], 'name'),
      productClass: classRaw,
      distinctnessAxis: axisRaw,
      distinctnessValue: optionalString(body['distinctnessValue'], 'distinctnessValue') ?? null,
      rationale: requiredString(body['rationale'], 'rationale'),
      actorRef: principal.id,
    });
    if (!result.ok) throw unprocessable(result.reason);

    return {
      edition: result.value,
      created: result.created,
      message: result.created
        ? `${result.value.name} is declared. Whether it is a *qualified* output is derived on ` +
          'every read from four conditions that all move — put validated puzzles in it, and ' +
          'the reading says what is still outstanding.'
        : `${result.value.name} already existed, so nothing changed.`,
    };
  }),
);

/* --------------------------------------------------------------------------
 * Producing
 *
 * The one route that makes something. Every puzzle it produces is checked as
 * it is made, and a required check failing stops the master rather than being
 * patched — the brief's own rule, and the reason there is no other way to
 * write a puzzle row.
 * ------------------------------------------------------------------------ */

puzzlesRouter.post(
  '/projects/:projectId/puzzles/masters/:masterId/produce',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const countRaw = body['count'];
    const count = typeof countRaw === 'number' ? Math.trunc(countRaw) : 10;
    if (!Number.isFinite(count) || count < 1 || count > MAX_BATCH) {
      throw badRequest(`count must be a whole number between 1 and ${MAX_BATCH}.`);
    }

    const outcome = await produceBatch({
      projectId: project.id,
      masterId: pathId(req, 'masterId'),
      count,
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);

    const batch = outcome.value;
    return {
      created: batch.created.length,
      duplicates: batch.duplicates,
      refused: batch.refused,
      failures: batch.failures,
      // Reported beside the failures and never folded into them. A batch that
      // produced puzzles nothing could fully check is a different fact from
      // one that produced validated ones, and a single count reads the same
      // for both.
      unsupported: batch.unsupported,
      blocked: batch.blocked,
      instanceIds: batch.created.map((one) => one.id),
      message: batch.blocked
        ? `This batch stopped the master: ${batch.blocked.reason}`
        : `${batch.created.length} new puzzle(s), every one checked. ` +
          (batch.duplicates > 0
            ? `${batch.duplicates} attempt(s) re-found a puzzle this master had already made, ` +
              'which is the duplicate rule working rather than an error.'
            : ''),
    };
  }),
);

/* --------------------------------------------------------------------------
 * Assembling and compiling
 * ------------------------------------------------------------------------ */

puzzlesRouter.post(
  '/projects/:projectId/puzzles/editions/:editionId/contents',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const positionRaw = body['position'];
    const existing = await listEditionInstances(pathId(req, 'editionId'));
    const position =
      typeof positionRaw === 'number' && Number.isInteger(positionRaw)
        ? positionRaw
        : existing.length;

    const result = await placeInEdition({
      projectId: project.id,
      editionId: pathId(req, 'editionId'),
      instanceId: requiredString(body['instanceId'], 'instanceId'),
      position,
    });
    if (!result.ok) throw unprocessable(result.reason);

    return {
      created: result.created,
      position,
      message: result.created
        ? 'Placed. Whether the edition is a qualified output is still derived from its ' +
          'conditions, and an unvalidated puzzle in it simply means it does not qualify yet.'
        : 'That puzzle was already in this edition, so nothing changed.',
    };
  }),
);

puzzlesRouter.post(
  '/projects/:projectId/puzzles/editions/:editionId/compile',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));

    const outcome = await compileEdition({
      projectId: project.id,
      editionId: pathId(req, 'editionId'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);

    return {
      ...outcome.value,
      message:
        `Compiled ${outcome.value.puzzles} puzzle(s) and their answer key. **This is a proof ` +
        'sheet, not a press-ready artifact** — it has no typography, page architecture, trim, ' +
        'bleed or imposition, and its first page says so. Brain has no layout compiler and ' +
        'says so rather than implying one.',
    };
  }),
);

/** Every edition with its four conditions, which is what "is the catalog real" means. */
puzzlesRouter.get(
  '/projects/:projectId/puzzles/editions',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { editions: await readEditions(project.id) };
  }),
);

/* --------------------------------------------------------------------------
 * Unblocking, and retiring
 *
 * A block means the generator produced wrong puzzles, so clearing one is a
 * person saying the code is repaired — and it takes the new generator version,
 * because a block cleared without one would be the same code claiming to be
 * different. Brain never clears its own.
 * ------------------------------------------------------------------------ */

puzzlesRouter.patch(
  '/projects/:projectId/puzzles/masters/:masterId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const master = await getMaster(pathId(req, 'masterId'));
    if (!master || master.projectId !== project.id) throw notFound('No master with that id.');

    const reason = optionalString(body['retireReason'], 'retireReason');
    if (reason) {
      const retired = await retireMaster({ id: master.id, projectId: project.id, reason });
      return {
        master: retired,
        message:
          'Retired. Nothing was destroyed: every puzzle it produced keeps its row, its seed ' +
          'and its verdicts, which is what stops the same master arriving again with all of ' +
          'that gone.',
      };
    }

    if (!master.blockedAt) {
      throw unprocessable(
        `${master.name} is not blocked, so there is nothing to clear. Send retireReason to ` +
          'retire it instead.',
      );
    }

    const support = supportForGenerator(master.generatorKey);
    if (!support) {
      throw unprocessable(
        `No generator named ${master.generatorKey} exists in this repository any more, so this ` +
          'master cannot be unblocked into anything that would produce.',
      );
    }
    if (support.generatorVersion === master.generatorVersion) {
      throw unprocessable(
        `${master.generatorKey} is still at ${support.generatorVersion}, which is the version ` +
          'that produced the wrong puzzles. Unblocking now would be the same code claiming to ' +
          'be different. Repair the generator, bump its version, and deploy — then this will ' +
          'clear.',
      );
    }

    const unblocked = await unblockMaster({
      id: master.id,
      projectId: project.id,
      generatorVersion: support.generatorVersion,
    });
    return {
      master: unblocked,
      message:
        `Unblocked at ${support.generatorKey} ${support.generatorVersion}. Every puzzle the ` +
        'broken version made keeps its row and its failing verdicts — they are the evidence ' +
        'that there was something to fix — and the new series starts from its own seeds.',
    };
  }),
);

puzzlesRouter.patch(
  '/projects/:projectId/puzzles/formats/:formatId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const retired = await retireFormat({
      id: pathId(req, 'formatId'),
      projectId: project.id,
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
    });
    if (!retired || retired.projectId !== project.id) throw notFound('No format with that id.');
    return {
      format: retired,
      message:
        'Retired. Never a delete: a retired format is evidence about what was considered, and ' +
        'deleting it would let the same one arrive again as a fresh discovery with that gone.',
    };
  }),
);

puzzlesRouter.patch(
  '/projects/:projectId/puzzles/editions/:editionId',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const edition = await getEdition(pathId(req, 'editionId'));
    if (!edition || edition.projectId !== project.id) throw notFound('No edition with that id.');

    const retired = await retireEdition({
      id: edition.id,
      projectId: project.id,
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
    });
    return {
      edition: retired,
      message:
        'Retired. Its puzzles keep their rows and stay available to every other edition, and ' +
        'it stops counting towards the multiplier — which is the honest effect of deciding it ' +
        'is no longer a product.',
    };
  }),
);
