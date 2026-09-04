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

  router.use(apiNotFound);
  router.use(errorMiddleware);

  return router;
}

export const apiRouter: Router = createApiRouter();

export default apiRouter;
