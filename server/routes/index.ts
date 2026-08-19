/**
 * The `/api` surface, assembled.
 *
 * Mount order matters only at the end: the catch-all 404 and the error
 * middleware come last so every route above them can throw freely and still
 * produce `{ error, detail? }` instead of an HTML stack trace.
 */
import { Router } from 'express';
import { auditsRouter } from './audits.ts';
import { chatRouter } from './chat.ts';
import { documentsRouter } from './documents.ts';
import { healthRouter } from './health.ts';
import { layersRouter } from './layers.ts';
import { projectsRouter } from './projects.ts';
import { runsRouter } from './runs.ts';
import { apiNotFound, errorMiddleware } from './helpers.ts';

export function createApiRouter(): Router {
  const router = Router();

  router.use(healthRouter);
  // Audit routes carry their own prefixes (/runs/:id/..., /layers/:id/...),
  // so they mount at the root ahead of the entity routers.
  router.use(auditsRouter);
  router.use('/projects', projectsRouter);
  router.use('/layers', layersRouter);
  router.use('/runs', runsRouter);
  router.use('/documents', documentsRouter);
  router.use('/chat', chatRouter);

  router.use(apiNotFound);
  router.use(errorMiddleware);

  return router;
}

export const apiRouter: Router = createApiRouter();

export default apiRouter;
