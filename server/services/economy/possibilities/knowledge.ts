/**
 * A kept possibility that HOLDs on a missing fact asks the shared Brain before
 * it asks for research.
 *
 * The shared_findings boundary (`services/knowledge/shared.ts`) is what lets a
 * fact established for one goal support a later one without the research being
 * repeated. Nothing here decides what may be reused: `eligibleFindings` is the
 * one rule, and it already excludes the asking project, rejected claims,
 * contested claims and revoked or expired findings. This module only reads a
 * finding into the store's own `name:value` shape and refuses every match it
 * cannot defend:
 *
 *   * the fact is read from the claim's `definition` scope field, written in the
 *     same `name:value` form a requirement uses (`paidAfterDays:14`), and parsed
 *     by the screen's own `numericFact` — so no unit is guessed from prose;
 *   * the claim's `population` must name the possibility's stated `subject`; a
 *     possibility that states no subject cannot be matched, and stays HOLD;
 *   * a finding scoped to a geography is used only for a possibility that
 *     states that geography — not knowing the scope is an answer, never a fit;
 *   * the value needs the same independence the coverage classifier asks before
 *     research stops: two publishers agreeing. One shared finding cannot
 *     suppress research on its own, and findings that disagree fill nothing.
 *
 * What crosses is the claim and its evidence. Nothing about the originating
 * project — its possibilities, its owner, its decisions — is read.
 */
import { eligibleFindings, type SharedFindingEvidence } from '../../../repos/sharedFindings.ts';
import {
  getPossibility, triggerCondition, updatePossibilityRequirements, watchCondition, watchersOf,
} from '../../../repos/economy.ts';
import type { Possibility, PossibilityRequirements } from '../../../domain/economy.ts';
import { factKey, numericFact, screenPossibility, type GoalLimits, type ScreenResult } from './screen.ts';
import { requirePerson, type Actor } from './store.ts';

/** The independence the coverage classifier requires before research stops. */
export const MIN_INDEPENDENT_PUBLISHERS = 2;

/** Requirement category the answered facts are written into, as `name:value`. */
export const KNOWLEDGE_CATEGORY = 'knowledge';
/** Requirement category recording which shared findings answered each fact. */
export const SHARED_FINDINGS_CATEGORY = 'sharedFindings';

export interface SharedAnswer {
  fact: string;
  value: number;
  findingIds: string[];
  publishers: string[];
}

export interface Unanswered {
  fact: string;
  reason: string;
}

const norm = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function publisherOf(f: SharedFindingEvidence): string {
  const named = norm(f.sourcePublisher);
  if (named) return named;
  try {
    return f.sourceUrl ? new URL(f.sourceUrl).host.toLowerCase() : '';
  } catch {
    return '';
  }
}

function factMissing(screen: ScreenResult): string[] {
  return screen.watch.filter((k) => k.startsWith('FACT:')).map((k) => k.slice('FACT:'.length));
}

/**
 * Whether the shared pool answers one fact for this possibility, and if not,
 * exactly why. Pure: the caller hands in the eligible findings.
 */
export function answerFact(
  fact: string, requirements: PossibilityRequirements, findings: SharedFindingEvidence[],
): SharedAnswer | Unanswered {
  const subjects = new Set((requirements['subject'] ?? []).map(norm).filter(Boolean));
  if (subjects.size === 0) {
    return { fact, reason: `${fact}: the possibility states no subject, so no shared finding can be matched to it.` };
  }
  const places = new Set((requirements.geography ?? []).map(norm).filter(Boolean));
  const byValue = new Map<number, SharedFindingEvidence[]>();
  for (const f of findings) {
    if (!f.definition) continue;
    const value = numericFact({ d: [f.definition] }, fact);
    if (value === null) continue;
    if (!subjects.has(norm(f.population))) continue;
    if (norm(f.geography) && !places.has(norm(f.geography))) continue;
    byValue.set(value, [...(byValue.get(value) ?? []), f]);
  }
  if (byValue.size === 0) return { fact, reason: `${fact}: nothing shared answers it.` };
  if (byValue.size > 1) {
    return { fact, reason: `${fact}: shared findings disagree (${[...byValue.keys()].join(' vs ')}), so none is used.` };
  }
  const [[value, matched]] = [...byValue.entries()] as [[number, SharedFindingEvidence[]]];
  const publishers = [...new Set(matched.map(publisherOf).filter(Boolean))].sort();
  if (publishers.length < MIN_INDEPENDENT_PUBLISHERS) {
    return {
      fact,
      reason: `${fact}: only ${publishers.length} independent publisher(s) state it; ${MIN_INDEPENDENT_PUBLISHERS} are needed before research is skipped.`,
    };
  }
  return { fact, value, findingIds: matched.map((f) => f.findingId).sort(), publishers };
}

export interface SharedKnowledgeResult {
  possibility: Possibility;
  screen: ScreenResult;
  answered: SharedAnswer[];
  /** Facts still missing: these, and only these, are left for research. */
  unanswered: Unanswered[];
}

/**
 * Fill a HOLDing possibility's missing facts from the shared pool, re-screen
 * it, and trigger the fact watches that are now met (once each). Research is
 * left only for what the pool could not answer.
 */
export async function answerFromSharedKnowledge(input: {
  actor: Actor; projectId: string; ownerUserId: string; possibilityId: string; limits: GoalLimits;
  now?: string;
}): Promise<SharedKnowledgeResult> {
  requirePerson(input.actor, input.ownerUserId);
  const possibility = await getPossibility(input.projectId, input.ownerUserId, input.possibilityId);
  if (!possibility) throw new Error('There is nothing here for you to see.');
  const before = screenPossibility(possibility.requirements, input.limits);
  const missing = factMissing(before);
  if (missing.length === 0) return { possibility, screen: before, answered: [], unanswered: [] };

  const findings = await eligibleFindings({
    excludeProjectId: input.projectId, ...(input.now ? { now: input.now } : {}),
  });
  const answered: SharedAnswer[] = [];
  const unanswered: Unanswered[] = [];
  for (const fact of missing) {
    const r = answerFact(fact, possibility.requirements, findings);
    if ('value' in r) answered.push(r);
    else unanswered.push(r);
  }
  if (answered.length === 0) return { possibility, screen: before, answered, unanswered };

  const requirements: PossibilityRequirements = {
    ...possibility.requirements,
    [KNOWLEDGE_CATEGORY]: [
      ...(possibility.requirements[KNOWLEDGE_CATEGORY] ?? []),
      ...answered.map((a) => `${a.fact}:${a.value}`),
    ],
    [SHARED_FINDINGS_CATEGORY]: [
      ...(possibility.requirements[SHARED_FINDINGS_CATEGORY] ?? []),
      ...answered.map((a) => `${a.fact}=${a.findingIds.join(',')}`),
    ],
  };
  const screen = screenPossibility(requirements, input.limits);
  await updatePossibilityRequirements({
    projectId: input.projectId, ownerUserId: input.ownerUserId, id: possibility.id, requirements,
    parkedReason: screen.verdict === 'ADVANCE' ? null : screen.reasons.join(' '),
  });
  for (const a of answered) {
    const watches = await watchersOf(input.projectId, factKey(a.fact));
    for (const w of watches) {
      if (w.possibilityId === possibility.id) await triggerCondition(w.id, `shared:${a.findingIds.join(',')}`);
    }
  }
  for (const key of screen.watch) {
    await watchCondition({ projectId: input.projectId, possibilityId: possibility.id, conditionKey: key });
  }
  return { possibility: { ...possibility, requirements }, screen, answered, unanswered };
}
