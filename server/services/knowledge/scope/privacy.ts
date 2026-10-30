/**
 * Whether a search method's definition holds anything private.
 *
 * A method is shared across projects and users only if it is GENERAL and its
 * definition names nobody and nothing of anybody's: no address, phone number,
 * secret-looking token, Brain identifier, or term its owner has said is
 * private. It fails toward refusing: a false positive costs a reworded
 * definition, a false negative discloses somebody's private fact.
 */
import type { SearchMethod } from '../../../domain/searchIntelligence.ts';

type Definition = Pick<
  SearchMethod,
  'finds' | 'usefulWhen' | 'sources' | 'requiredInputs' | 'query' | 'checkProcedure' | 'limits'
>;

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'an email address', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: 'a phone number', re: /(?:\+?\d[\s().-]?){9,}\d/ },
  { name: 'a Brain identifier', re: /\b(?:prj|usr|wkr|opp|cop|ws|doc|orc|mis|rcn|acct|bin)_[a-z0-9]{6,}/i },
  { name: 'a credential', re: /\b(?:brnw|brnc|sk|pk|ghp|xox[bp])[_-][A-Za-z0-9_-]{12,}/ },
  { name: 'a long token', re: /\b[A-Za-z0-9+/_-]{32,}\b/ },
];

function texts(d: Definition): string[] {
  return [d.finds, d.usefulWhen, d.query, d.checkProcedure, d.limits, ...d.sources, ...d.requiredInputs].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
}

/** Every private thing found in a definition, named; empty when it is safe to share. */
export function privateDataIn(
  definition: Definition,
  known: { projectIds?: readonly string[]; userIds?: readonly string[]; terms?: readonly string[] } = {},
): string[] {
  const found = new Set<string>();
  const all = texts(definition);
  for (const text of all) {
    for (const p of PATTERNS) if (p.re.test(text)) found.add(p.name);
    const lower = text.toLowerCase();
    for (const id of [...(known.projectIds ?? []), ...(known.userIds ?? [])]) {
      if (id && lower.includes(id.toLowerCase())) found.add('an id of the project or user it came from');
    }
    for (const term of known.terms ?? []) {
      if (term.trim().length >= 3 && lower.includes(term.trim().toLowerCase())) found.add(`the private term "${term.trim()}"`);
    }
  }
  return [...found];
}
