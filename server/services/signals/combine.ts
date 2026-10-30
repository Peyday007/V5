/**
 * Combined signals: several related findings about one organisation or place,
 * linked by ordinary code.
 *
 * A detector output or a trigger-bucket finding says one thing happened. Two or
 * more different things for the same subject can point at a need none of them
 * shows alone (expansion + hiring + a supply shortage). That is still a
 * SIGNAL: it never establishes a buyer, and nothing here calls a model.
 *
 * Established patterns are rows in `PATTERNS` and run over whole batches in one
 * pass. A combination no pattern covers is not guessed at: it is returned once
 * per shape in `unfamiliar`, for research to propose a pattern that is then
 * added here, with tests, as code.
 */
import { employerKey } from '../feeds/detectors.ts';
import type { SignalSubjectKind } from '../../domain/signals.ts';

/** What a member finding is about, in the vocabulary patterns are written in. */
export type SignalKind = 'HIRING' | 'EXPANSION' | 'SUPPLY_SHORTAGE' | 'LEADERSHIP_CHANGE' | 'NEW_RULE' | 'PLATFORM_SUNSET' | 'COMPLAINTS' | 'COMPETITOR_MOVE' | 'FUNDING';

export interface SignalMember {
  /** The detection or finding id, as stored. */
  id: string;
  origin: 'DETECTOR' | 'TRIGGER';
  kind: SignalKind | string;
  subjectKind: SignalSubjectKind;
  /** Organisation name or place name as the source printed it. */
  subject: string;
  at: string | null;
}

export interface CombinationPattern {
  id: string;
  /** Every one of these kinds, from distinct members, must be present. */
  requires: readonly string[];
  industryHint: string;
  possibleNeed: string;
  captureMethods: readonly string[];
}

/** Established patterns. Adding one is a new entry here and its tests. */
export const PATTERNS: readonly CombinationPattern[] = Object.freeze([
  {
    id: 'EXPANSION_HIRING',
    requires: ['EXPANSION', 'HIRING'],
    industryHint: 'expanding operator',
    possibleNeed: 'Onboarding material, process documents and tracking for a team growing into a new site.',
    captureMethods: ['email to the business contact it publishes', 'document or spreadsheet delivered by email'],
  },
  {
    id: 'EXPANSION_HIRING_SUPPLY',
    requires: ['EXPANSION', 'HIRING', 'SUPPLY_SHORTAGE'],
    industryHint: 'expanding operator with constrained supply',
    possibleNeed: 'Supplier sourcing, comparison and backup-supplier lists while capacity grows.',
    captureMethods: ['supplier research report', 'email to the business contact it publishes'],
  },
  {
    id: 'FUNDED_HIRING',
    requires: ['FUNDING', 'HIRING'],
    industryHint: 'newly funded company',
    possibleNeed: 'Prospect lists and outreach material for a company building a sales team.',
    captureMethods: ['lead list delivered by email'],
  },
  {
    id: 'LEADERSHIP_HIRING',
    requires: ['LEADERSHIP_CHANGE', 'HIRING'],
    industryHint: 'company under new leadership',
    possibleNeed: 'Reports, trackers and process documents a new leader commissions.',
    captureMethods: ['spreadsheet or document delivered by email'],
  },
  {
    id: 'RULE_PLATFORM_DEADLINE',
    requires: ['NEW_RULE', 'PLATFORM_SUNSET'],
    industryHint: 'business facing two deadlines',
    possibleNeed: 'Compliance notices and data migration before the earlier deadline.',
    captureMethods: ['document and data file delivered by email'],
  },
]);

export interface CombinedResult {
  subjectKind: SignalSubjectKind;
  subjectKey: string;
  pattern: string;
  memberDetectionIds: string[];
  /** A name the industry resolver can look up; null when the pattern names none. */
  industryHint: string;
  possibleNeed: string;
  captureMethods: string[];
  label: 'SIGNAL';
  /** Always carried: a combination is a signal, not demand. */
  qualifiers: string[];
}

export interface UnfamiliarShape {
  /** The sorted kinds present, which is the shape research is asked about once. */
  shape: string;
  kinds: string[];
  subjects: string[];
  memberIds: string[];
}

export interface CombineReport {
  results: CombinedResult[];
  unfamiliar: UnfamiliarShape[];
  considered: number;
  skipped: number;
  /** Always 0: this module has no model call to count. Asserted by the tests. */
  modelJobs: 0;
  elapsedMs: number;
}

/** A subject identity that never merges two different organisations or places. */
export function subjectKeyFor(kind: SignalSubjectKind, subject: string): string | null {
  if (kind === 'ORGANISATION') return employerKey(subject);
  const key = subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return key.length >= 2 ? key : null;
}

const QUALIFIERS = [
  'a combination of signals; it does not establish that anyone would pay for anything',
  'each member finding keeps its own limits',
];

export function combineSignals(
  members: readonly SignalMember[],
  options: { patterns?: readonly CombinationPattern[]; now?: () => number } = {},
): CombineReport {
  const clock = options.now ?? (() => performance.now());
  const started = clock();
  const patterns = options.patterns ?? PATTERNS;
  const bySubject = new Map<string, { kind: SignalSubjectKind; key: string; names: string[]; members: SignalMember[] }>();
  let skipped = 0;
  for (const member of members) {
    const key = subjectKeyFor(member.subjectKind, member.subject);
    if (!key) { skipped++; continue; } // an unnamed subject is never grouped
    const id = `${member.subjectKind}|${key}`;
    const group = bySubject.get(id) ?? { kind: member.subjectKind, key, names: [], members: [] };
    group.members.push(member);
    group.names.push(member.subject.trim());
    bySubject.set(id, group);
  }

  const results: CombinedResult[] = [];
  const unfamiliar = new Map<string, UnfamiliarShape>();
  const sortedPatterns = [...patterns].sort((a, b) => b.requires.length - a.requires.length || a.id.localeCompare(b.id));

  for (const group of [...bySubject.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    // One member per finding id; the same finding listed twice counts once.
    const unique = [...new Map(group.members.map((m) => [m.id, m])).values()];
    const kinds = [...new Set(unique.map((m) => m.kind))].sort();
    if (unique.length < 2 || kinds.length < 2) continue; // repeats of one kind are not a combination
    const covered = new Set<string>();
    for (const pattern of sortedPatterns) {
      if (!pattern.requires.every((kind) => kinds.includes(kind))) continue;
      // A larger pattern already using these kinds supersedes its own subsets.
      if (pattern.requires.every((kind) => covered.has(kind)) && results.some((r) => r.subjectKey === group.key && r.subjectKind === group.kind)) continue;
      const ids = unique.filter((m) => pattern.requires.includes(m.kind)).map((m) => m.id).sort();
      if (ids.length < 2) continue;
      results.push({
        subjectKind: group.kind, subjectKey: group.key, pattern: pattern.id, memberDetectionIds: ids,
        industryHint: pattern.industryHint, possibleNeed: pattern.possibleNeed,
        captureMethods: [...pattern.captureMethods], label: 'SIGNAL', qualifiers: [...QUALIFIERS],
      });
      pattern.requires.forEach((kind) => covered.add(kind));
    }
    if (!kinds.every((kind) => covered.has(kind))) {
      const left = kinds.filter((kind) => !covered.has(kind));
      if (covered.size === 0 || left.length >= 2) {
        const shape = (covered.size === 0 ? kinds : left).join('+');
        const entry = unfamiliar.get(shape) ?? { shape, kinds: covered.size === 0 ? kinds : left, subjects: [], memberIds: [] };
        entry.subjects.push(group.key);
        entry.memberIds.push(...unique.map((m) => m.id));
        unfamiliar.set(shape, entry);
      }
    }
  }

  return {
    results,
    unfamiliar: [...unfamiliar.values()].sort((a, b) => a.shape.localeCompare(b.shape)),
    considered: members.length, skipped, modelJobs: 0, elapsedMs: clock() - started,
  };
}
