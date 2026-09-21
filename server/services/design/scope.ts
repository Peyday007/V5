/**
 * Which project the design kernel's own work is filed against.
 *
 * One reader, because three of them would eventually disagree. The expansion
 * loop files research here, the render lane opens its bin here, and the judged
 * lane opens its review here — and a kernel whose render bin lived in one
 * project while its review bin lived in another would be a kernel whose worker
 * routing, project scoping and independence lineage all had to be configured
 * twice. §27 records the cost of that arrangement at `bins/routing.ts`; this is
 * the same rule, at a project id.
 *
 * It was `architectureProject` inside `expand.ts` and is lifted out unchanged,
 * which is the correction its own comment already argued for one level down.
 */
import { getDb } from '../../db/database.ts';
import { getProjectBySlug } from '../../repos/projects.ts';
import { ARCHITECTURE_SLUG } from '../capability/ingest.ts';

/**
 * The project Brain's own architecture work is filed against.
 *
 * `ARCHITECTURE_SLUG` first, which is the capability kernel's own answer to the
 * same question. Two kernels resolving *Brain's architecture scope* by two
 * different rules would eventually file into two different projects, and the
 * disagreement would look like work going missing.
 *
 * `purpose = 'TECHNICAL'` is the fallback, because migration 028 declares that
 * column for exactly this and a Brain whose architecture scope somebody named
 * differently still has one.
 *
 * **It reads and never creates.** `ensureArchitectureScope` exists and is
 * deliberately not called: creating a project is a person's decision on
 * `npm run admin` (§22, §26), and a loop that made one to have somewhere to put
 * its own work would be a machine creating its own scope. Null is a real state
 * on a fresh Brain, and every caller reports it rather than inventing one.
 */
export async function designProject(): Promise<string | null> {
  try {
    const named = await getProjectBySlug(ARCHITECTURE_SLUG);
    if (named) return named.id;
    const row = await getDb().get<{ id: string }>(
      `SELECT id FROM projects WHERE purpose = 'TECHNICAL' ORDER BY created_at ASC, id ASC`,
    );
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** What to tell somebody when there is nowhere to file design work. */
export const NO_DESIGN_PROJECT =
  'This Brain has no architecture project for design work to be filed against, so no bin can be ' +
  'opened for it. Creating one is `npm run admin` — a person’s decision, which is why nothing ' +
  'here creates it.';
