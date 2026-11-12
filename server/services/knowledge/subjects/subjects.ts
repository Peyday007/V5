/**
 * Subjects Brain learned, offered as discovery lenses.
 *
 * A subject a worker discovers is kept as a `learned_subjects` row with the
 * source it came from, and on later runs is merged at read time beside the
 * constant buckets (`SEARCH_BUCKETS`, `TRIGGER_BUCKETS`, `GOAL_LENSES`). The
 * constants are untouched. A lens asks where to look and never what to
 * conclude, so everything it finds still passes the evidence gate. The lens is
 * not tied to cash: a subject can be a supplier class, a public dataset or a
 * technology as well as a market.
 */
import type { SearchBucket } from '../../cash/discovery.ts';
import {
  listLearnedSubjects, reobserveLearnedSubject, retireLearnedSubject, upsertLearnedSubject,
} from '../../../repos/searchMethods.ts';
import type { LearnedSubject, ScopeRef, SearchReader } from '../../../domain/searchIntelligence.ts';

export const SUBJECT_LENS_PREFIX = 'subject-';

/** What kind of thing a subject is. Open set; these are the common ones. */
export const SUBJECT_KINDS = ['MARKET', 'SUPPLIER', 'DATASET', 'TECHNOLOGY', 'OTHER'] as const;

const KIND_PHRASE: Record<string, string> = {
  MARKET: 'who is buying, selling or being paid for',
  SUPPLIER: 'who supplies, at what terms and with what published capacity,',
  DATASET: 'which public datasets exist, who publishes them, how current they are and on what terms, for',
  TECHNOLOGY: 'which technologies, tools or methods exist, who offers them and at what published cost, for',
  OTHER: 'what is currently published about',
};

/** Active learned subjects kept per project. Past it the stalest one is retired, never the newest refused. */
export const MAX_LEARNED_SUBJECTS = 60;

/** A subject is a short noun phrase, never a sentence. */
const MAX_SUBJECT_WORDS = 6;

/** Words that never distinguish one subject from another. */
const KEY_NOISE = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'by', 'at', 'from',
  'service', 'services', 'work', 'works', 'support', 'project', 'projects', 'related',
]);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Case, spacing, punctuation, plurals, filler words and word order never make
 * two spellings two subjects: "Parcel research services" and "research of
 * parcels" are one key.
 */
export function subjectKeyFor(label: string, kind: string = 'OTHER'): string {
  const words = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const meaningful = [...new Set(words.filter((w) => !KEY_NOISE.has(w)).map(singular))].sort();
  const slug = (meaningful.length > 0 ? meaningful : words).join('-');
  return `${kind.toLowerCase()}:${slug}`;
}

/** Whether a label reads as a subject (a short phrase) rather than a claim sentence. */
export function isSubjectLabel(label: string): boolean {
  const text = label.trim();
  if (!text || /[0-9.,;:!?]/.test(text)) return false;
  const words = text.split(/\s+/);
  return words.length >= 1 && words.length <= MAX_SUBJECT_WORDS;
}

/** What somebody asked for follows one of these. */
const ASK_CUE = new RegExp(
  '\\b(?:rfps?|rfqs?|rfis?|requests? for (?:proposals?|quotes?|qualifications?|bids?|information)|' +
  'invitations? to bid|solicitations?|tenders?|bids?|quotes?|proposals?|contracts?|grants?|funding|' +
  'seeking|seeks|hiring|looking for|wants?|needs?|buying|buys|purchase of|procurement of|pays?|paying)\\b' +
  '(?:\\s+(?:for|on|of|an?|to provide|to supply|to perform|to deliver|to buy|to hire|someone to|somebody to|' +
  '(?:vendor|contractor|consultant|firm|provider|company|freelancer)s?))*\\s+',
  'gi',
);
/** …or precedes one of these. */
const ASKED_AFTER = /^(.{3,80}?)\s+(?:needed|wanted|required|sought)\b/i;
/** Where the subject phrase ends: punctuation, or a word that starts a date, place, amount or condition. */
const PHRASE_END =
  /[,.;:()!?\u2013\u2014"]|\s-\s|\s(?:due|by|before|until|with|from|in|at|on|within|starting|closing|closes|worth|valued|budget|totaling|totalling|for|to|per|across|through|that|which|who|and is|are|is|was|were|will|has|have)\b/i;
const LEADING_FILLER = /^(?:(?:a|an|the|some|its|their|his|her|our|new|additional|ongoing|several|multiple|various)\s+)+/i;

function phraseFrom(raw: string): string | null {
  const cut = raw.split(PHRASE_END)[0] ?? '';
  const phrase = cut.replace(LEADING_FILLER, '').replace(/\s+/g, ' ').trim();
  if (!phrase || !isSubjectLabel(phrase)) return null;
  if (phrase.split(' ').every((w) => KEY_NOISE.has(w.toLowerCase()))) return null;
  return phrase;
}

/**
 * The subject a claim is about — what somebody asked to buy or be paid for —
 * as a short phrase, or null when the claim does not name one plainly. A claim
 * that names no subject teaches none: a sentence is not a lens.
 */
export function subjectFromClaim(claim: string): string | null {
  const text = claim.replace(/\s+/g, ' ').trim();
  for (const match of text.matchAll(ASK_CUE)) {
    const phrase = phraseFrom(text.slice((match.index ?? 0) + match[0].length));
    if (phrase) return phrase.toLowerCase();
  }
  const after = ASKED_AFTER.exec(text);
  if (after?.[1]) {
    const phrase = phraseFrom(after[1].replace(/^.*\b(?:for|of)\s+/i, ''));
    if (phrase) return phrase.toLowerCase();
  }
  return null;
}

/**
 * What kind of thing a claim's subject is, read from the claim's own words.
 *
 * The harvest used to file every subject as a MARKET, so a claim about a
 * public dataset, a supplier or a technology became a market lens and the
 * same path never ran for any other kind of target. The kind is read from the
 * subject phrase first and then the claim, by plain words; nothing here names
 * a market, an industry or a goal, and a claim that matches none is a MARKET,
 * which is what the harvest's claims (somebody asking to pay) usually are.
 */
const KIND_CUES: readonly [string, RegExp][] = [
  ['DATASET', /\b(?:data ?sets?|open data|data portal|database|registry|public records|statistics|census|bulk download|data feed|api)\b/i],
  ['SUPPLIER', /\b(?:suppliers?|manufacturers?|distributors?|wholesalers?|fabricators?|vendors? of|sourcing|supply of|bulk supply)\b/i],
  ['TECHNOLOGY', /\b(?:software|platforms?|technolog(?:y|ies)|systems? integration|saas|algorithms?|machine learning|automation)\b/i],
];

export function subjectKindFromClaim(claim: string, subject: string | null = subjectFromClaim(claim)): (typeof SUBJECT_KINDS)[number] {
  for (const text of [subject ?? '', claim]) {
    for (const [kind, cue] of KIND_CUES) if (cue.test(text)) return kind as (typeof SUBJECT_KINDS)[number];
  }
  return 'MARKET';
}

export async function learnSubject(input: ScopeRef & {
  label: string; kind?: string; description?: string | null; origin: string; sourceRef: string;
}): Promise<LearnedSubject> {
  const label = input.label.trim();
  if (!label) throw new Error('A subject needs a label.');
  if (!input.sourceRef.trim()) throw new Error('A learned subject carries the source it came from.');
  return upsertLearnedSubject({
    scope: input.scope, projectId: input.projectId ?? null, userId: input.userId ?? null,
    subjectKey: subjectKeyFor(label, input.kind ?? 'OTHER'), label,
    description: input.description ?? null, origin: input.origin, sourceRef: input.sourceRef,
  });
}

/** One subject as a bucket, in the shape discovery already opens rounds from. */
export function lensFor(subject: LearnedSubject): SearchBucket {
  const kind = subject.subjectKey.split(':')[0]?.toUpperCase() ?? 'OTHER';
  const phrase = KIND_PHRASE[kind] ?? KIND_PHRASE['OTHER']!;
  const about = subject.description ? `${subject.label} (${subject.description})` : subject.label;
  return {
    id: `${SUBJECT_LENS_PREFIX}${subject.id}`,
    mechanism: 'OTHER',
    title: `Learned subject: ${subject.label}`,
    question:
      `Looking at ${about}, ${phrase} it — naming, for each finding, one live, dated, published ` +
      'example, who publishes it, and the source it came from?',
  };
}

/** The lenses a reader may see, learned subjects merged in at read time. */
export async function learnedLenses(reader: SearchReader): Promise<SearchBucket[]> {
  return (await listLearnedSubjects(reader)).map(lensFor);
}

/** Lenses for one project: its own subjects plus GENERAL ones. */
export const learnedLensesForProject = (projectId: string) =>
  learnedLenses({ projectIds: [projectId], userId: null });

/**
 * Learn the subject a harvested claim names, for one project.
 *
 * Its kind (market, supplier, dataset, technology) is read from the claim, so
 * a harvested claim about a public dataset or a supplier becomes that kind of
 * lens and runs the same round, method and gate path as a market does.
 *
 * The claim's subject phrase is the label, so near-duplicate claims about the
 * same thing re-observe one subject instead of each becoming a lens. A claim
 * that names no subject teaches nothing. Earlier sentence-shaped subjects from
 * the harvest are retired as they are met, and the set never freezes at its
 * bound: past `MAX_LEARNED_SUBJECTS` the subject observed least recently is
 * retired to make room, and is offered again if it is observed again.
 */
export async function learnSubjectFromClaim(input: {
  projectId: string; claim: string; claimId: string; max?: number;
  /** The subject's kind when the caller knows it; otherwise read from the claim (`subjectKindFromClaim`). */
  kind?: string;
}): Promise<LearnedSubject | null> {
  const label = subjectFromClaim(input.claim);
  if (!label) return null;
  const kind = input.kind ?? subjectKindFromClaim(input.claim, label);
  const max = Math.max(1, input.max ?? MAX_LEARNED_SUBJECTS);
  const mine = (await listLearnedSubjects({ projectIds: [input.projectId], userId: null }))
    .filter((s) => s.scope === 'PROJECT' && s.projectId === input.projectId);

  // A claim sentence stored as a subject by the earlier harvest is not a subject.
  for (const s of mine) {
    if (s.origin === 'harvest' && !isSubjectLabel(s.label)) await retireLearnedSubject(s.id);
  }

  const subject = await learnSubject({
    scope: 'PROJECT', projectId: input.projectId, label, kind,
    origin: 'harvest', sourceRef: `claim:${input.claimId}`,
  });
  await reobserveLearnedSubject(subject.id);

  const active = (await listLearnedSubjects({ projectIds: [input.projectId], userId: null }))
    .filter((s) => s.scope === 'PROJECT' && s.projectId === input.projectId && s.id !== subject.id)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.createdAt.localeCompare(b.createdAt));
  for (const stale of active.slice(0, Math.max(0, active.length + 1 - max))) {
    await retireLearnedSubject(stale.id);
  }
  return subject;
}
