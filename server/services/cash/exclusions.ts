/**
 * What a goal's owner said to leave out, read from their own words (§82).
 *
 * "Avoid government contracts" is an instruction about which openings a goal
 * may rely on, and it was written in exactly two places a person writes: the
 * goal's own text and the sprint's operator additions. Neither is a list, so
 * the instruction is read the way the conversation gate already reads one:
 * a class is excluded only when one of its trigger words sits in a clause a
 * negator governs ("avoid", "without", "do not", "leave out", "exclude",
 * "no …"). Mentioning a class is not excluding it — *"subcontract work that
 * government buyers pay for"* excludes nothing.
 *
 * The vocabulary is closed and small on purpose. A class is added when a person
 * has asked to leave something out and the existing words cannot say it; each
 * says what text it recognises in an opening, so an exclusion applies to rows
 * by matching, never by a model deciding what a person meant.
 */
import { clauseBefore, NEGATORS } from '../russell/negation.ts';
import { getCashMode } from '../../repos/cashMode.ts';

export const EXCLUSION_CLASSES = {
  GOVERNMENT_CONTRACTING: {
    label: 'government and public-sector contracts',
    triggers: /\b(?:government|federal|public[- ]sector|public procurement|state agenc(?:y|ies)|municipal)\b/i,
    matches: /\b(?:government|federal|sam\.gov|public[- ]sector|procurement|solicitation|rfp|rfq|rfi|tender|state agenc(?:y|ies)|municipal|county (?:commission|board|government)|city of|department of|commonwealth of|navy|army|air force|veterans affairs|bureau of)\b/i,
  },
  WEBSITE_REPAIR: {
    label: 'broken-website and website-repair plays',
    triggers: /\b(?:broken[- ]website|website[- ](?:repair|fix)|broken site)/i,
    matches: /\b(?:broken (?:web)?site|website (?:repair|fix|rebuild|redesign)|fix(?:ing)? (?:their|the|a) (?:web)?site|dead links?|site (?:is )?down|outdated website)\b/i,
  },
} as const satisfies Record<string, { label: string; triggers: RegExp; matches: RegExp }>;
export type ExclusionClass = keyof typeof EXCLUSION_CLASSES;
export const EXCLUSION_KEYS = Object.keys(EXCLUSION_CLASSES) as ExclusionClass[];

/** Negators this reader adds to the shared ones: an exclusion only ever removes, so a wider net costs a narrower search, never a wrong action. */
const EXCLUDING = /\b(?:exclude|excluding|leave out|leaving out|no|not|skip|steer clear of|stay away from|other than)\b/i;

/** The classes a person's text excludes. */
export function exclusionsIn(text: string | null | undefined): ExclusionClass[] {
  if (!text) return [];
  const out = new Set<ExclusionClass>();
  for (const key of EXCLUSION_KEYS) {
    const pattern = new RegExp(EXCLUSION_CLASSES[key].triggers.source, 'gi');
    for (const hit of text.matchAll(pattern)) {
      const clause = clauseBefore(text, hit.index ?? 0);
      if (NEGATORS.test(clause) || EXCLUDING.test(clause)) out.add(key);
    }
  }
  return EXCLUSION_KEYS.filter((key) => out.has(key));
}

/** The first excluded class some text falls in, or null. */
export function excludedBy(text: string | null | undefined, classes: readonly ExclusionClass[]): ExclusionClass | null {
  if (!text) return null;
  return classes.find((key) => EXCLUSION_CLASSES[key].matches.test(text)) ?? null;
}

/** A sentence for a research question, naming what to leave out. */
export function exclusionSentence(classes: readonly ExclusionClass[]): string {
  if (classes.length === 0) return '';
  return ` Leave out ${classes.map((key) => EXCLUSION_CLASSES[key].label).join(' and ')}: the goal's owner excluded them.`;
}

/**
 * The classes a goal excludes: its own words, and the sprint's operator
 * additions for the project its ledger counts in. Both are text a person wrote.
 */
export async function goalExclusions(goal: { title: string; intent: string; outcome: string | null; target: { projectId: string; resources?: string | null } | null }): Promise<ExclusionClass[]> {
  const parts = [goal.title, goal.intent, goal.outcome ?? '', goal.target?.resources ?? ''];
  if (goal.target?.projectId) {
    const mode = await getCashMode(goal.target.projectId);
    // The whole stored objective: the canonical mandate excludes nothing, and the operator's additions follow it.
    if (mode) parts.push(mode.objective);
  }
  return exclusionsIn(parts.filter(Boolean).join('\n'));
}
