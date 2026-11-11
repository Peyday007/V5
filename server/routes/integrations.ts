/**
 * The Integrations page's door (§103): every connected service, which Brain
 * components use it, its health, what is missing, the repairs Brain made and
 * the owner's actions. Brain-wide, so a Brain administrator's — the same rule
 * as provider connections, and for the same reason: none of it belongs to a
 * project. Nothing returned carries a credential value.
 */
import { Router } from 'express';
import { checkAndRecord, integrationsView } from '../services/integrations/health.ts';
import { brainAdminOnly, handler } from './helpers.ts';

export const integrationsRouter = Router();

// Scoped to the path: an unscoped guard on a root-mounted router refuses every
// ordinary member on every route (providers.ts, measured).
integrationsRouter.use('/integrations', brainAdminOnly());

integrationsRouter.get('/integrations', handler(async () => integrationsView()));

/** Check now: run every live probe (none sends anything) and record the readings. */
integrationsRouter.post(
  '/integrations/check',
  handler(async () => {
    await checkAndRecord({ source: 'integrations page' });
    return integrationsView();
  }),
);
