/**
 * The guidance a research worker is handed beside its assignment, read from
 * rows: how this surface fared reaching hosts lately, and what earlier
 * campaigns in this project taught.
 *
 * Context, never a control. Nothing here is read by the evidence gate, the
 * depth allocator, the repair ladder, the approval envelope or any allocation:
 * a lesson can tell a worker where things went wrong before, and it cannot
 * move a bar, a scope or a priority. `composeGuidance` in `prompts.ts` is the
 * one place the text is written, so the in-process prompts and the worker's
 * assignment carry the same words.
 */
import type { ResearchFragment } from '../../domain/types.ts';
import { hostReachability, type ReachabilitySurface } from '../../repos/research.ts';
import { reusableLessons } from '../../repos/researchIntelligence.ts';
import { composeGuidance, type ResearchGuidance } from './prompts.ts';

/** How far back "recently could not read" looks. */
export const REACHABILITY_WINDOW_MS = 7 * 86_400_000;

export async function guidanceFor(input: {
  projectId: string;
  /** Null for a planning pass. */
  fragment: ResearchFragment | null;
  /** The packet's current fragments; the assignment's own are excluded by key. */
  siblings: { fragmentKey: string; question: string }[];
  /** The surface the work runs on, when known. Null reads every surface. */
  surface: ReachabilitySurface | null;
  now?: number;
}): Promise<ResearchGuidance> {
  const since = new Date((input.now ?? Date.now()) - REACHABILITY_WINDOW_MS).toISOString();
  /*
   * Each reading is best-effort: guidance that cannot be read is left out
   * rather than failing the assignment it would only have annotated.
   */
  const [reachability, lessons] = await Promise.all([
    hostReachability(input.surface, since).catch(() => []),
    reusableLessons(input.projectId).catch(() => []),
  ]);
  return composeGuidance({
    fragment: input.fragment,
    siblings: input.siblings,
    reachability,
    lessons,
  });
}
