/**
 * The commerce kernel's door (§73).
 *
 * Every route resolves through `requireProject`, so absent and forbidden are
 * the same 404 with the same body (invariant 23), and every handler calls
 * `requirePerson`, which refuses a worker by principal *type* — beside the
 * ADMIN level `services/identity/policy.ts` puts on every write here. Two
 * guards, because a guard on one entrance is not a guard.
 *
 * Reading is the default READ: every member can see the products, where each
 * stands and what Brain would ask next, and reading opens no round. A project
 * with no programme answers 200 with `programme: null` rather than a second
 * 404 sentence (§47's manufacturing correction).
 *
 * **There is no route here that orders, lists, advertises or spends**, and
 * that is not an omission to be filled in later: each of those needs an
 * account a person owns and a grant a person gives.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import {
  moveCommerceProgramme,
  retireCommerceProductDecision,
  seedCommerceProduct,
  startCommerceProgramme,
} from '../services/commerce/programme.ts';
import { commerceView } from '../services/commerce/view.ts';

export const commerceRouter = Router();

commerceRouter.get(
  '/projects/:projectId/commerce',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return { commerce: await commerceView(project.id) };
  }),
);

commerceRouter.post(
  '/projects/:projectId/commerce',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const outcome = await startCommerceProgramme({
      projectId: project.id,
      actorUserId: principal.id,
      objective: requiredString(body['objective'], 'objective'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { programme: outcome.programme, created: outcome.created };
  }),
);

commerceRouter.patch(
  '/projects/:projectId/commerce',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const to = requiredString(bodyOf(req)['state'], 'state');
    if (to !== 'ACTIVE' && to !== 'PAUSED') throw badRequest('"state" must be ACTIVE or PAUSED.');
    const outcome = await moveCommerceProgramme({ projectId: project.id, actorUserId: principal.id, to });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { programme: outcome.programme };
  }),
);

commerceRouter.post(
  '/projects/:projectId/commerce/products',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const outcome = await seedCommerceProduct({
      projectId: project.id,
      actorUserId: principal.id,
      name: requiredString(body['name'], 'name'),
      note: optionalString(body['note'], 'note') ?? null,
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { product: outcome.product, created: outcome.created };
  }),
);

commerceRouter.post(
  '/projects/:projectId/commerce/products/:productId/retire',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const outcome = await retireCommerceProductDecision({
      projectId: project.id,
      actorUserId: principal.id,
      productId: pathId(req, 'productId'),
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);
    return { retired: true };
  }),
);
