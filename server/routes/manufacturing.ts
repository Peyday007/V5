/**
 * The manufacturing programme's door.
 *
 * Every route here resolves through `requireProject`, which is
 * `decideProjectAccess` against the authenticated principal, so absent and
 * forbidden are the same 404 **with the same body** — invariant 23 at a new
 * door.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at every write by level, because `services/identity/policy.ts` puts all four
 * at ADMIN; this refuses it by *type*, at the reads as well, because no
 * membership configuration turns a machine into a person. Two independent
 * guards, because a guard on one entrance is not a guard.
 *
 * There is **no manufacturing policy module and there must never be one.**
 * Which level each of these needs is declared in `services/identity/policy.ts`
 * beside every other route, for §21's reason: a second security model is a
 * second thing to keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/manufacturing/`; these resolve the project, hand over the
 * principal, and turn a refusal into a status.
 *
 * **There is no route here that builds, buys, tools or enters anything**, and
 * that is not an omission to be filled in later. Everything this kernel does is
 * read published sources and record what a person decides; producing a machine
 * is a decision with a factory on the end of it, and it has no API.
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
import { MACHINE_CATEGORY_KINDS, type MachineCategoryKind } from '../domain/types.ts';
import { moveProgramme, startProgramme } from '../services/manufacturing/program.ts';
import {
  declareHeld,
  ledger,
  retireCategoryDecision,
  seedCategory,
  withdrawHeld,
} from '../services/manufacturing/declare.ts';
import { programmeView } from '../services/manufacturing/view.ts';

export const manufacturingRouter = Router();

/* --------------------------------------------------------------------------
 * Reading
 *
 * The default READ level, so every member of the project can see the ladder,
 * what each category is missing, and what Brain would ask next. Reading
 * performs no effect: no round is opened, no category created and no capability
 * held, which the tests assert against the rows rather than trusting to this
 * sentence.
 * ------------------------------------------------------------------------ */

manufacturingRouter.get(
  '/projects/:projectId/manufacturing',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const view = await programmeView(project.id);
    if (!view) {
      throw notFound('This project has no manufacturing programme.');
    }
    return view;
  }),
);

manufacturingRouter.get(
  '/projects/:projectId/manufacturing/capabilities',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { capabilities: await ledger(project.id) };
  }),
);

/* --------------------------------------------------------------------------
 * Starting and moving a programme
 * ------------------------------------------------------------------------ */

manufacturingRouter.post(
  '/projects/:projectId/manufacturing',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await startProgramme({
      projectId: project.id,
      // The programme belongs to whoever is named as its owner, defaulting to
      // the person starting it. Both come from the authenticated principal or
      // from a field a person supplied, and neither decides anything about
      // authorization: `requireProject` has already settled that.
      ownerUserId: optionalString(body['ownerUserId'], 'ownerUserId') ?? principal.id,
      actorUserId: principal.id,
      objective: requiredString(body['objective'], 'objective'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { program: outcome.program, created: outcome.created };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const to = requiredString(body['state'], 'state');
    if (to !== 'ACTIVE' && to !== 'PAUSED' && to !== 'ARCHIVED') {
      throw badRequest('"state" must be ACTIVE, PAUSED or ARCHIVED.');
    }
    const outcome = await moveProgramme({
      projectId: project.id,
      actorUserId: principal.id,
      to,
      reason: optionalString(body['reason'], 'reason') ?? null,
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { program: outcome.program, changed: outcome.changed };
  }),
);

/* --------------------------------------------------------------------------
 * Naming a category, and retiring one
 *
 * `SEED` is the one category origin Brain itself may never write: a machine
 * that could name its own categories would be deciding what this company is.
 * Retiring is the one verdict no derivation could reach, and it destroys
 * nothing — the category keeps its id, its evidence and every round ever run
 * against it.
 * ------------------------------------------------------------------------ */

manufacturingRouter.post(
  '/projects/:projectId/manufacturing/categories',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const kindRaw = optionalString(body['kind'], 'kind');
    if (kindRaw && !(MACHINE_CATEGORY_KINDS as readonly string[]).includes(kindRaw)) {
      throw badRequest(`"kind" must be one of: ${MACHINE_CATEGORY_KINDS.join(', ')}.`);
    }

    const outcome = await seedCategory({
      projectId: project.id,
      name: requiredString(body['name'], 'name'),
      kind: (kindRaw as MachineCategoryKind | undefined) ?? undefined,
      description: optionalString(body['description'], 'description') ?? null,
      parentId: optionalString(body['parentId'], 'parentId') ?? null,
      actorRef: principal.id,
      reason: optionalString(body['reason'], 'reason') ?? null,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { category: outcome.category, created: outcome.created };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing/categories/:categoryId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await retireCategoryDecision({
      projectId: project.id,
      categoryId: pathId(req, 'categoryId'),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { category: outcome };
  }),
);

/* --------------------------------------------------------------------------
 * What this company can actually do
 *
 * The most consequential write in this kernel, and the one no research path can
 * reach. A capability a product *teaches* is not a capability this company
 * *holds*; everything downstream — what is enterable, what is missing, what to
 * build next — turns on the difference, and only a person can establish it.
 * ------------------------------------------------------------------------ */

manufacturingRouter.post(
  '/projects/:projectId/manufacturing/capabilities',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    /*
     * The note is read as optional here and required by the service, which is
     * deliberate rather than lax.
     *
     * `requiredString` refuses an empty one with *"note" is required and must
     * be a non-empty string* — true, and useless about why. `declareHeld` says
     * what a note is for: *say what was hired, bought, built or delivered; a
     * capability held for no stated reason is indistinguishable afterwards from
     * one somebody guessed.* That is the sentence a person should read at the
     * one control that records the most consequential fact in this kernel, so
     * the route stops pre-empting the rule and lets the rule speak.
     *
     * Nothing is weakened: the service refuses either way, and the refusal is
     * still the server's rather than the screen's.
     */
    const outcome = await declareHeld({
      projectId: project.id,
      capabilityId: optionalString(body['capabilityId'], 'capabilityId') ?? null,
      name: optionalString(body['name'], 'name') ?? null,
      note: optionalString(body['note'], 'note') ?? '',
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { capability: outcome.capability, changed: outcome.changed };
  }),
);

manufacturingRouter.patch(
  '/projects/:projectId/manufacturing/capabilities/:capabilityId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const outcome = await withdrawHeld({
      projectId: project.id,
      capabilityId: pathId(req, 'capabilityId'),
      reason: requiredString(body['reason'], 'reason'),
      actorRef: principal.id,
    });
    if ('error' in outcome) throw unprocessable(outcome.error);
    return { capability: outcome };
  }),
);
