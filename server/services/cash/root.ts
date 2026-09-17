/**
 * One Cash Mode, one frontier, one objective.
 *
 * ---------------------------------------------------------------------------
 * The correction this file exists for
 * ---------------------------------------------------------------------------
 *
 * §30 says four private operations means four *projects*, and that is right
 * about money, credentials, decisions and working state. It was applied to
 * **discovery**, and that is wrong: it produced four Cash Modes, four objectives
 * and four opportunity universes, so the same market question would have been
 * researched four times, four archives would each have had to rediscover what
 * the others already knew, and a person would have been asked which of four
 * identical frontiers they wanted before anything could start.
 *
 * Discovery is one shared frontier. **Separation begins when a validated
 * opportunity becomes an execution job**, because that is the first moment
 * there is anything private to separate — an owner, a budget, a credential, a
 * decision. Before that there is only evidence, and evidence about the world is
 * not anybody's private state. §31 already settled the same question one
 * boundary out: a validated finding belongs to the Brain.
 *
 * ---------------------------------------------------------------------------
 * What a root is, and why it is not a new table
 * ---------------------------------------------------------------------------
 *
 * The root is the single project the shared frontier is filed under. It stays a
 * project because a project is what `decideProjectAccess`, the layer, the
 * queue, the packet and the fleet router all already understand — inventing a
 * parallel container would be the second orchestration universe this repository
 * keeps refusing to grow. The four person-derived projects stay exactly where
 * they are, unexposed, and nothing is deleted to tidy a screen.
 *
 * It is resolved rather than configured, in a fixed order, so the answer is the
 * same from every caller and the existing research is adopted rather than
 * stranded:
 *
 *   1. the project that already holds a `cash_modes` row — there may be only
 *      one, and `activate` enforces that;
 *   2. otherwise the project already holding the `Opportunity Research` layer,
 *      which is where a hand-started frontier put its packets before any sprint
 *      existed. **This is the consolidation path**: the ten buckets, nineteen
 *      fragments, accepted claims and the filed synthesis are adopted by being
 *      found, not by being copied;
 *   3. otherwise a project created for the purpose.
 *
 * Nothing here moves a row between projects. Adopting by resolution rather than
 * by migration is what makes this safe to deploy while V1 is mid-packet: a
 * running worker's orchestration, bin, lease and claims are untouched, and the
 * root is simply the project they were already in.
 */
import { createProject, getProject, listProjects } from '../../repos/projects.ts';
import { listLayers } from '../../repos/layers.ts';
import { listCashModes } from '../../repos/cashMode.ts';
import { CASH_LAYER_NAME } from './lifecycle.ts';
import type { Project } from '../../domain/types.ts';

/** The name a created root gets. Display only; nothing resolves on it. */
export const CANONICAL_CASH_PROJECT_NAME = 'Cash Mode';

/**
 * What Cash Mode is for, in Brain's own words.
 *
 * Stored here rather than typed by a person at activation, and that is the
 * point of the whole correction. A person asked to describe the objective in a
 * text box writes what is on their mind that morning, and whatever they leave
 * out silently becomes a boundary the Brain will not search past — an omission
 * nobody can see afterwards, in the one field that decides how wide the
 * frontier is.
 *
 * A person's later input is **additive**: a temporary priority, a prohibited
 * category, a changed budget, a new resource, a deadline, a preference. Those
 * modify this; they never replace it. `constraintsFor` is where that is
 * composed, and it appends rather than substitutes for exactly this reason.
 */
export const CANONICAL_CASH_OBJECTIVE =
  'Continuously discover, validate, assemble, and advance the maximum economically ' +
  'defensible portfolio of lawful opportunities capable of producing usable cash quickly. ' +
  'Optimize for fast first dollar, probability of collection, low capital exposure, strong ' +
  'margin, accessible buyers, feasible fulfillment, and short settlement time. Search ' +
  'autonomously across the full opportunity universe, including opportunities and ' +
  'combinations not named by the user. Continue pursuing valuable longer-cycle ' +
  'opportunities when they do not conflict with short-cash execution. Treat user ' +
  'instructions as additive priorities and constraints, never as an exhaustive boundary ' +
  'on discovery.';

/**
 * The short reading of it, for the card a person actually looks at.
 *
 * Derived by hand rather than by truncation: a sentence cut at 200 characters
 * ends mid-clause and reads like a bug. The full text is sent alongside, so a
 * reader can always see the thing itself rather than a paraphrase of it.
 */
export const CANONICAL_CASH_SUMMARY =
  'Find and validate as many lawful ways to produce usable cash quickly as the evidence ' +
  'supports — favouring a fast first dollar, a high chance of actually collecting, little ' +
  'capital at risk, reachable buyers and short settlement — and keep searching the whole ' +
  'opportunity space, including combinations nobody has named, while work already chosen ' +
  'is being carried out.';

/**
 * A person's additions, folded in without replacing anything.
 *
 * Returns the canonical objective, then whatever was supplied, under a heading
 * that says which is which. A reader — and a worker reading the mission — can
 * therefore always tell the standing mandate from this week's steer, which a
 * single blended paragraph makes impossible.
 */
export function objectiveWith(constraints?: string | null): string {
  const extra = (constraints ?? '').trim();
  if (extra.length === 0) return CANONICAL_CASH_OBJECTIVE;
  return `${CANONICAL_CASH_OBJECTIVE}\n\nAdditional priorities and constraints from the operator (these narrow or reprioritise; they do not replace the mandate above):\n${extra}`;
}

/**
 * The project the shared frontier lives in, without creating anything.
 *
 * Null when there is none yet, which is a real answer: the inactive page needs
 * to say "not started" without a root springing into existence because somebody
 * looked at the screen.
 */
export async function findCashRoot(): Promise<Project | null> {
  const projects = await listProjects();
  const modes = await listCashModes(projects.map((project) => project.id));
  const active = modes[0];
  if (active) return (await getProject(active.projectId)) ?? null;

  /*
   * The adoption path. A frontier started from a terminal has a layer and
   * packets and no sprint row, so the layer is what identifies it — and finding
   * it is how the existing research becomes this root's research, with nothing
   * copied and nothing replayed.
   *
   * Oldest first, so two candidates resolve the same way on every call rather
   * than by whichever the database happened to return.
   */
  const ordered = [...projects].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const project of ordered) {
    const layers = await listLayers(project.id);
    if (layers.some((layer) => layer.name === CASH_LAYER_NAME)) return project;
  }
  return null;
}

/**
 * The root, creating one only if there is genuinely none.
 *
 * Called from activation and from nowhere that merely reads, so a person
 * pressing the one button is what brings a root into existence.
 */
export async function resolveOrCreateCashRoot(): Promise<Project> {
  const existing = await findCashRoot();
  if (existing) return existing;
  return createProject({ name: CANONICAL_CASH_PROJECT_NAME });
}
