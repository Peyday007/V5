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
import { lessonsForPrompt } from './intelligence/retrospective.ts';
import { composeGuidance, type ResearchGuidance } from './prompts.ts';

/** How far back "recently could not read" looks. */
export const REACHABILITY_WINDOW_MS = 7 * 86_400_000;

/**
 * Stored lessons plus the usefulness lessons derived from the last 30 days of
 * research rows (`retrospective.ts` `lessonsForPrompt`). The derivation is an
 * aggregate over a month of passes, so it is read at most every ten minutes
 * per project rather than once per assignment (§61).
 */
const LESSON_CACHE_MS = 10 * 60_000;
const lessonCache = new Map<string, { at: number; value: { abstraction: string; lesson: string }[] }>();

export function resetLessonCache(): void {
  lessonCache.clear();
}

async function lessonsFor(projectId: string, now: number): Promise<{ abstraction: string; lesson: string }[]> {
  const hit = lessonCache.get(projectId);
  if (hit && now - hit.at >= 0 && now - hit.at < LESSON_CACHE_MS) return hit.value;
  const value = (await lessonsForPrompt(projectId)).map((one) => ({
    abstraction: one.abstraction,
    lesson: one.lesson,
  }));
  lessonCache.set(projectId, { at: now, value });
  return value;
}

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
    lessonsFor(input.projectId, input.now ?? Date.now()).catch(() => []),
  ]);
  return composeGuidance({
    fragment: input.fragment,
    siblings: input.siblings,
    reachability,
    lessons,
  });
}
