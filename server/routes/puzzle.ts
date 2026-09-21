/**
 * The puzzle kernel's door.
 *
 * Every route resolves through `requireProject`, which is `decideProjectAccess`
 * against the authenticated principal, so absent and forbidden are the same 404
 * **with the same body** — invariant 23.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at the writes by level and by `MISSING_SCOPE`; this refuses it by *type*, at
 * the reads as well, because no membership configuration turns a machine into a
 * person — and §22's rule that a worker cannot create its own work matters most
 * at a surface where the work has a product and a price on the end of it. Two
 * independent guards, because a guard on one entrance is not a guard.
 *
 * There is **no puzzle policy module and there must never be one.** Which level
 * each of these needs is declared in `services/identity/policy.ts` beside every
 * other route, for §21's reason: a second security model is a second thing to
 * keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/puzzle/`; these resolve the project, hand over the principal, and
 * turn a refusal into a status.
 *
 * **Nothing here publishes, prices, sells or contacts anybody.** Releasing an
 * output records that a person decided it is ready; pursuing it is Cash Mode's
 * machinery, behind the standing commercial authority a person granted
 * separately.
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
  compileOutput,
  decideRoute,
  declareFormat,
  declareMaster,
  declareRoute,
  recordPersonObservation,
  releaseOutput,
  retireFormatByPerson,
  retireMasterByPerson,
  retireOutputByPerson,
  reviewMaster,
  usableInstances,
} from '../services/puzzle/declare.ts';
import { produceBatch } from '../services/puzzle/produce.ts';
import { puzzleView } from '../services/puzzle/view.ts';
import {
  isDifferentiatorAxis,
  isProductionClass,
  isPuzzleObservationKind,
  isRouteClass,
  isRouteDisposition,
} from '../domain/puzzle.ts';
import {
  DIFFERENTIATOR_AXES,
  PRODUCTION_CLASSES,
  PUZZLE_OBSERVATION_KINDS,
  ROUTE_CLASSES,
  ROUTE_DISPOSITIONS,
} from '../domain/types.ts';

export const puzzleRouter = Router();

/** The one place a refusal becomes a status, so every handler reads the same. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw unprocessable(result.reason);
  return result.value;
}

/** The signed-in person, for the columns that record whose decision it was. */
function personId(): string {
  return requirePerson().id;
}

/* --------------------------------------------------------------------------
 * Reading it
 *
 * Any project member's, and deliberately so. What exists, how far it has got,
 * what is being researched, what the economics say and what needs a person are
 * exactly the things somebody working on this project needs to see without
 * asking an administrator.
 * ------------------------------------------------------------------------ */

puzzleRouter.get(
  '/projects/:projectId/puzzle',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return puzzleView(project.id);
  }),
);

puzzleRouter.get(
  '/projects/:projectId/puzzle/masters/:masterId/instances',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return {
      instances: await usableInstances({
        projectId: project.id,
        masterId: pathId(req, 'masterId'),
      }),
    };
  }),
);

/* --------------------------------------------------------------------------
 * Naming a format or a route
 *
 * ADMIN plus `requirePerson`, the pair every membership-shaped decision
 * already carries — and for a related reason. `SEED` is the one origin Brain
 * itself may never write, because a machine that could name its own formats
 * would be deciding what the universe is, and a machine that could archive a
 * route would be deleting the ledger one row at a time.
 * ------------------------------------------------------------------------ */

puzzleRouter.post(
  '/projects/:projectId/puzzle/formats',
  handler(async (req) => {
    personId();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    return unwrap(
      await declareFormat({
        projectId: project.id,
        name: requiredString(body['name'], 'name'),
        audience: optionalString(body['audience'], 'audience'),
        note: optionalString(body['note'], 'note'),
      }),
    );
  }),
);

puzzleRouter.post(
  '/projects/:projectId/puzzle/formats/:formatId/retire',
  handler(async (req) => {
    personId();
    await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    return unwrap(
      await retireFormatByPerson({
        id: pathId(req, 'formatId'),
        reason: requiredString(body['reason'], 'reason'),
      }),
    );
  }),
);

puzzleRouter.post(
  '/projects/:projectId/puzzle/routes',
  handler(async (req) => {
    personId();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const routeClass = requiredString(body['routeClass'], 'routeClass');
    if (!isRouteClass(routeClass)) {
      throw badRequest(`routeClass must be one of ${ROUTE_CLASSES.join(', ')}.`);
    }
    return unwrap(
      await declareRoute({
        projectId: project.id,
        name: requiredString(body['name'], 'name'),
        routeClass,
        note: optionalString(body['note'], 'note'),
      }),
    );
  }),
);

/**
 * A person's disposition on a route.
 *
 * The only way a route leaves the active list, and there is no delete at all.
 * The directive says never to hide the slow, the blocked or the long-term
 * paths, so this records a decision with a name and a reason on it rather than
 * removing a row.
 */
puzzleRouter.post(
  '/projects/:projectId/puzzle/routes/:routeId/disposition',
  handler(async (req) => {
    const byId = personId();
    await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const disposition = requiredString(body['disposition'], 'disposition');
    if (!isRouteDisposition(disposition)) {
      throw badRequest(`disposition must be one of ${ROUTE_DISPOSITIONS.join(', ')}.`);
    }
    return unwrap(
      await decideRoute({
        id: pathId(req, 'routeId'),
        disposition,
        reason: optionalString(body['reason'], 'reason') ?? '',
        byId,
      }),
    );
  }),
);

/* --------------------------------------------------------------------------
 * Masters, and the review the directive requires of every one
 * ------------------------------------------------------------------------ */

puzzleRouter.post(
  '/projects/:projectId/puzzle/masters',
  handler(async (req) => {
    personId();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const params = body['params'];
    return unwrap(
      await declareMaster({
        projectId: project.id,
        formatKey: requiredString(body['formatKey'], 'formatKey'),
        name: requiredString(body['name'], 'name'),
        engineId: requiredString(body['engineId'], 'engineId'),
        params: params && typeof params === 'object' ? (params as Record<string, unknown>) : {},
        corpusRef: optionalString(body['corpusRef'], 'corpusRef'),
        rightsBasis: requiredString(body['rightsBasis'], 'rightsBasis'),
      }),
    );
  }),
);

puzzleRouter.post(
  '/projects/:projectId/puzzle/masters/:masterId/review',
  handler(async (req) => {
    const reviewedById = personId();
    await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    return unwrap(
      await reviewMaster({
        id: pathId(req, 'masterId'),
        reviewedById,
        note: requiredString(body['note'], 'note'),
      }),
    );
  }),
);

puzzleRouter.post(
  '/projects/:projectId/puzzle/masters/:masterId/retire',
  handler(async (req) => {
    personId();
    await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    return unwrap(
      await retireMasterByPerson({
        id: pathId(req, 'masterId'),
        reason: requiredString(body['reason'], 'reason'),
      }),
    );
  }),
);

/**
 * Produce a batch.
 *
 * A person's instruction rather than something the tick does, deliberately:
 * generation is cheap and unbounded, and a kernel that produced on a timer
 * would fill a catalog nobody asked for. Every instance it makes is validated
 * in the same pass, and a run of failures on one check blocks the batch rather
 * than producing more of them.
 */
puzzleRouter.post(
  '/projects/:projectId/puzzle/masters/:masterId/produce',
  handler(async (req) => {
    personId();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const count = Number(body['count'] ?? 0);
    if (!Number.isInteger(count) || count < 1) {
      throw badRequest('count must be a whole number of at least one.');
    }
    try {
      return await produceBatch({
        projectId: project.id,
        masterId: pathId(req, 'masterId'),
        count,
        run: optionalString(body['run'], 'run') ?? undefined,
      });
    } catch (error) {
      throw unprocessable(error instanceof Error ? error.message : 'That batch could not run.');
    }
  }),
);

/* --------------------------------------------------------------------------
 * Outputs
 * ------------------------------------------------------------------------ */

puzzleRouter.post(
  '/projects/:projectId/puzzle/outputs',
  handler(async (req) => {
    personId();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const productionClass = requiredString(body['productionClass'], 'productionClass');
    if (!isProductionClass(productionClass)) {
      throw badRequest(`productionClass must be one of ${PRODUCTION_CLASSES.join(', ')}.`);
    }

    const rawAxes = body['differentiators'];
    if (!Array.isArray(rawAxes)) {
      throw badRequest('differentiators must be an array.');
    }
    const differentiators = rawAxes.map((one) => {
      if (!isDifferentiatorAxis(one)) {
        throw badRequest(
          `Each differentiator must be one of ${DIFFERENTIATOR_AXES.join(', ')}. ` +
            'TITLE, COVER and PAGE_ORDER are recorded honestly and never counted as making a ' +
            'new product.',
        );
      }
      return one;
    });

    const rawInstances = body['instanceIds'];
    if (!Array.isArray(rawInstances) || rawInstances.some((one) => typeof one !== 'string')) {
      throw badRequest('instanceIds must be an array of instance ids.');
    }

    return unwrap(
      await compileOutput({
        projectId: project.id,
        masterId: requiredString(body['masterId'], 'masterId'),
        title: requiredString(body['title'], 'title'),
        productionClass,
        differentiators,
        instanceIds: rawInstances as string[],
        targetBuyer: optionalString(body['targetBuyer'], 'targetBuyer'),
        routeId: optionalString(body['routeId'], 'routeId'),
      }),
    );
  }),
);

/**
 * A person's release decision.
 *
 * It records that somebody decided an output is ready. It publishes nothing,
 * lists nothing for sale and contacts nobody: pursuing a released output is
 * Cash Mode's machinery, behind the standing commercial authority a person
 * granted separately.
 */
puzzleRouter.post(
  '/projects/:projectId/puzzle/outputs/:outputId/release',
  handler(async (req) => {
    const byId = personId();
    await requireProject(pathId(req, 'projectId'));
    return unwrap(await releaseOutput({ id: pathId(req, 'outputId'), byId }));
  }),
);

puzzleRouter.post(
  '/projects/:projectId/puzzle/outputs/:outputId/retire',
  handler(async (req) => {
    personId();
    await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    return unwrap(
      await retireOutputByPerson({
        id: pathId(req, 'outputId'),
        reason: requiredString(body['reason'], 'reason'),
      }),
    );
  }),
);

/* --------------------------------------------------------------------------
 * What a person observed
 *
 * WRITE rather than ADMIN: recording that you played a puzzle and found a clue
 * ambiguous is an ordinary contribution, and it is the one reading no
 * validator here can produce.
 * ------------------------------------------------------------------------ */

puzzleRouter.post(
  '/projects/:projectId/puzzle/observations',
  handler(async (req) => {
    const observerId = personId();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const kind = requiredString(body['kind'], 'kind');
    if (!isPuzzleObservationKind(kind)) {
      throw badRequest(`kind must be one of ${PUZZLE_OBSERVATION_KINDS.join(', ')}.`);
    }
    return unwrap(
      await recordPersonObservation({
        projectId: project.id,
        kind,
        subjectKey: optionalString(body['subjectKey'], 'subjectKey'),
        statement: requiredString(body['statement'], 'statement'),
        observerId,
        masterId: optionalString(body['masterId'], 'masterId'),
        outputId: optionalString(body['outputId'], 'outputId'),
      }),
    );
  }),
);

export default puzzleRouter;
