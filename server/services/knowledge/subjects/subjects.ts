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
import { listLearnedSubjects, upsertLearnedSubject } from '../../../repos/searchMethods.ts';
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

/** Case, spacing and punctuation never make two spellings two subjects. */
export function subjectKeyFor(label: string, kind: string = 'OTHER'): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind.toLowerCase()}:${slug}`;
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
