/**
 * The design kernel's door.
 *
 * §42's tables carry no `project_id` (`design_surfaces`, `design_cycles`,
 * `design_findings`, `design_corrections`, `design_patterns`,
 * `design_capabilities`, `design_expansions`), so the kernel's state is
 * Brain-wide rather than anything one project owns. `services/design/scope.ts`'s
 * `designProject` only chooses where the kernel *files its own bins* and may
 * return `null` — it is not a readership boundary, and reading it as one would
 * let a project's own `ADMIN` see machinery that has nothing to do with their
 * project.
 *
 * So this is guarded the way `routes/people.ts` guards Brain-wide account
 * infrastructure: `requirePerson()` refuses a worker by type, and
 * `requireBrainAdmin()` is the level, exactly as `POST /people/:userId/claude/
 * adopt` and `GET /members` already have it. There is no design policy module
 * and there must never be one.
 *
 * The one route here is thin on purpose: every reading is
 * `services/design/view.ts`'s `designKernelView()`, called verbatim and with no
 * write anywhere in the chain.
 */
import { Router } from 'express';
import { handler, requireBrainAdmin, requirePerson } from './helpers.ts';
import { designKernelView } from '../services/design/view.ts';

export const designRouter = Router();

designRouter.get(
  '/design/kernel',
  handler(async () => {
    requirePerson();
    await requireBrainAdmin();
    return await designKernelView();
  }),
);
