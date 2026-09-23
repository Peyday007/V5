/**
 * The `/api` surface, assembled.
 *
 * Mount order matters only at the end: the catch-all 404 and the error
 * middleware come last so every route above them can throw freely and still
 * produce `{ error, detail? }` instead of an HTML stack trace.
 */
import { Router } from 'express';
import { adminRouter } from './admin.ts';
import { workRouter } from './work.ts';
import { operationsRouter } from './operations.ts';
import { auditsRouter } from './audits.ts';
import { chatRouter } from './chat.ts';
import { documentsRouter } from './documents.ts';
import { healthRouter } from './health.ts';
import { layersRouter } from './layers.ts';
import { projectsRouter } from './projects.ts';
import { providersRouter } from './providers.ts';
import { researchRouter } from './research.ts';
import { runsRouter } from './runs.ts';
import { russellRouter } from './russell.ts';
import { factoryRouter } from './factory.ts';
import { connectRouter } from './connect.ts';
import { cashRouter } from './cash.ts';
import { externalRouter } from './external.ts';
import { laborRouter } from './labor.ts';
import { manufacturingRouter } from './manufacturing.ts';
import { invitationsRouter } from './invitations.ts';
import { passkeyRouter } from './passkeys.ts';
import { peopleRouter } from './people.ts';
import { registerRouter } from './register.ts';
import { bridgeRouter } from './bridge.ts';
import { apiNotFound, errorMiddleware } from './helpers.ts';

export function createApiRouter(): Router {
  const router = Router();

  // Identity administration, behind its own Brain-administrator guard. First,
  // because /api/admin/projects/:id/members must not be swallowed by the
  // projects router's own :projectId routes.
  router.use('/admin', adminRouter);
  // Mounted at the root because its routes carry their own prefixes: some are
  // project-scoped (/projects/:id/work) and some address an item directly
  // (/work/:id), and the two must sit beside each other.
  router.use(workRouter);
  router.use(operationsRouter);

  // An invited person's two routes. Mounted early and at the root because they
  // are addressed by no project and no entity: the invitation's own row is where
  // the project comes from, and a caller who could name one would be choosing
  // which project they are being invited to.
  router.use(invitationsRouter);

  // Passkey enrollment, passkey sign-in, a member's own devices, and the member
  // slots an administrator issues links for. Mounted at the root for the same
  // reason: its routes carry their own prefixes (/enroll/..., /auth/passkey/...,
  // /me/passkeys, /members) and none of them is addressed by a project.
  router.use(passkeyRouter);

  // People & Capacity: who has joined this Brain, and what can run in it. Both
  // are Brain-wide account infrastructure rather than anything about one
  // project, so these routes are addressed by no project and mount at the root
  // beside the identity ones. Every one of them refuses a worker by type.
  router.use(peopleRouter);

  /*
   * The work register. Every route inside is `requirePerson` plus the same
   * `decideProjectAccess` every other door resolves through.
   */
  router.use(registerRouter);

  /*
   * The conversation entrance. `requirePerson` at every route, so a worker is
   * refused by type; minting a credential additionally refuses a caller that
   * arrived on one.
   */
  router.use(bridgeRouter);

  router.use(healthRouter);
  // Audit routes carry their own prefixes (/runs/:id/..., /layers/:id/...),
  // so they mount at the root ahead of the entity routers.
  router.use(auditsRouter);
  // Research routes also carry their own prefixes (/layers/:id/research,
  // /research/:id), for the same reason.
  router.use(researchRouter);
  // Provider connection routes carry their own /providers prefix.
  router.use(providersRouter);
  router.use('/projects', projectsRouter);
  router.use('/layers', layersRouter);
  router.use('/runs', runsRouter);
  router.use('/documents', documentsRouter);
  router.use('/chat', chatRouter);
  // Russell's own surface. Mounted under its own prefix rather than at the root:
  // its routes address conversations, candidates and human requests, and the
  // `/projects/:id/...` ones inside it are Russell's views of a project rather
  // than the project router's.
  router.use('/russell', russellRouter);
  // The Software Factory. Mounted at the root because its routes carry their own
  // prefixes: some are project-scoped (/projects/:id/factory/...) and some
  // address a campaign directly (/factory/campaigns/:id).
  router.use(factoryRouter);
  // A connected site's door. Mounted at the root because its routes carry
  // their own `/projects/:id/connect/...` prefix, and they must sit *before*
  // the projects router so its own `/:projectId/...` routes do not swallow
  // them.
  router.use(connectRouter);
  // Cash Mode (§30). Mounted at the root because its routes carry their own
  // prefixes: some are project-scoped (/projects/:id/cash/...) and some address
  // an opportunity, a commitment or a need directly. Before the projects router
  // so its own `/:projectId/...` routes do not swallow them.
  router.use(cashRouter);
  // External actions (§50). Project-scoped routes under their own
  // `/projects/:id/external` prefix, which the projects router does not claim.
  router.use(externalRouter);
  // The labor kernel (§41). Root-mounted for the same reason and with the same
  // ordering requirement: its routes carry their own `/projects/:id/labor/...`
  // prefix and must sit before the projects router.
  router.use(laborRouter);
  router.use(manufacturingRouter);

  router.use(apiNotFound);
  router.use(errorMiddleware);

  return router;
}

export const apiRouter: Router = createApiRouter();

export default apiRouter;
