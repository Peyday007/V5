/**
 * Where learned detectors and their judged firings come from in production.
 *
 * `learned.ts` can build a detector from examples and measure it on judged
 * firings, and `learnedRun.ts` settles and runs what exists. Without this
 * module nothing in the running Brain created a detector or judged a firing,
 * so precision could never reach `MIN_JUDGED_FOR_PROMOTION` and no detector
 * could ever be promoted, avoid an AI job, or escalate anything.
 *
 * The judge is the one the feed run already pays for: the cheap lane's
 * SCREEN_LEAD answers in `cheap_results`. An item is labelled only when two
 * models answered and agreed (`combineLeads`). A KEEP that names a deliverable
 * is a positive and a DROP is a negative. UNSURE, a disagreement or a single
 * answer labels nothing. On each feeds pass:
 *
 *   1. propose — for each feed source whose agreed positives define a
 *      pattern (`defineFromExamples`), one GENERAL detector is created in
 *      SHADOW, keyed by its source and terms, so the same pattern is never
 *      created twice. Feed items are shared rows, so only GENERAL learning
 *      may act on them (`FEED_READER`). The items it was built from are kept
 *      in its definition (`trainedOn`).
 *   2. judge — every GENERAL detector's firing on an agreed-labelled item it
 *      was *not* built from is recorded as a `detector_examples` row (fired,
 *      CONFIRMED or REJECTED). A miss is recorded too, as `fired: false`, which
 *      `measureDetector` ignores for precision. The first label for an item
 *      stands. A detector is never measured on its own training examples.
 *
 * `installLearned` then settles each mode from the measured precision. An
 * ACTIVE detector's confident items skip the screen, so it accrues further
 * judgments only from items it came close on or missed. A demotion therefore
 * needs judged firings recorded while it was still in SHADOW, or later ones.
 *
 * Every screen-proposed detector serves a GENERAL search method keyed by its
 * detector key (`methodForDetector`), created with it, and a detector proposed
 * before that rule is linked on the next pass (`linkDetectorMethods`). Without
 * the method, `recordLearnedPass` records no CODE run, so nothing the detector
 * did — the runs done without Claude, the screens its ACTIVE coverage skipped —
 * could reach the search report as automatic or as AI usage avoided.
 *
 * Every such method names its feed source's subject (`subjectForFeedSource`),
 * so the detectors built over one source are methods for one subject. After
 * the judging, `compareDetectorMethods` compares those methods on the items
 * every one of them was judged on — identical data — and records the
 * comparison (`compareMethods`) whenever that data or the set of methods has
 * changed, so which method outranks which is read from a row rather than
 * asked of a person.
 *
 * Nothing here calls a model: it reads answers already given.
 */
import { getDb } from '../../db/database.ts';
import {
  attachDetectorMethod,
  createLearnedDetector,
  createSearchMethod,
  getSearchMethod,
  linkMethodSubject,
  listDetectorExamples,
  listLearnedDetectors,
  listMethodComparisons,
  recordDetectorExample,
} from '../../repos/searchMethods.ts';
import type { DetectorExample, LearnedDetector, SearchMethod } from '../../domain/searchIntelligence.ts';
import { subjectForFeedSource } from '../knowledge/subjects/subjects.ts';
import { compareMethods, type MethodResult } from '../research/searchMethods/compare.ts';
import { combineLeads, parseLead, type LeadOutput } from '../cheap/lane.ts';
import { confidenceOf, defineFromExamples, FIRE_AT, type LearnedDefinition } from './learned.ts';
import { FEED_READER } from './learnedRun.ts';
import { CODE_SIGNAL_SOURCE } from './detectors.ts';
import { SITE_SOURCE } from './sites.ts';

/** Who labelled an example made from the screen. */
export const SCREEN_LABELLER = 'cheap-lane:SCREEN_LEAD';
/** Precision a screen-proposed detector must measure before it may go ACTIVE. */
export const PROPOSED_THRESHOLD = 0.8;
/** How far back screened items are read. */
export const LEARN_WINDOW_MS = 30 * 86_400_000;
/** Bounds one pass's reading, so the feeds pass stays cheap. */
export const LEARN_ITEM_LIMIT = 5_000;

export interface ScreenLabel {
  id: string;
  source: string;
  title: string;
  verdict: 'CONFIRMED' | 'REJECTED';
}

/**
 * What two agreeing answers say about an item, or null when they do not say
 * enough to be a judgment. Pure.
 */
export function labelOf(answers: readonly (LeadOutput | null)[]): 'CONFIRMED' | 'REJECTED' | null {
  if (answers.filter((one) => one !== null).length < 2) return null;
  const merged = combineLeads([...answers]);
  if (!merged) return null;
  if (merged.verdict === 'KEEP') return merged.deliverable === 'NONE' ? null : 'CONFIRMED';
  if (merged.verdict === 'DROP') return 'REJECTED';
  return null;
}

/** Agreed screen labels for recent feed items, read back from rows. */
export async function screenLabels(now: Date): Promise<ScreenLabel[]> {
  const since = new Date(now.getTime() - LEARN_WINDOW_MS).toISOString();
  const rows = await getDb().all<{ id: string; source: string; title: string; model: string; ok: number; output: string | null }>(
    `SELECT f.id, f.source, f.title, c.model, c.ok, c.output
       FROM feed_items f JOIN cheap_results c ON c.subject_id = f.id AND c.kind = 'SCREEN_LEAD'
      WHERE f.fetched_at >= ? AND f.source NOT IN (?, ?)
      ORDER BY f.fetched_at DESC, f.id, c.created_at DESC
      LIMIT ${LEARN_ITEM_LIMIT * 2}`,
    [since, CODE_SIGNAL_SOURCE, SITE_SOURCE],
  );
  // The latest answer per model per item, as the feed run reads them.
  const byItem = new Map<string, { source: string; title: string; answers: (LeadOutput | null)[]; models: Set<string> }>();
  for (const row of rows) {
    const slot = byItem.get(row.id) ?? { source: row.source, title: row.title, answers: [], models: new Set<string>() };
    if (slot.models.has(row.model)) continue;
    slot.models.add(row.model);
    slot.answers.push(row.ok && row.output ? parseLead(row.output) : null);
    byItem.set(row.id, slot);
  }
  const out: ScreenLabel[] = [];
  for (const [id, slot] of byItem) {
    const verdict = labelOf(slot.answers);
    if (verdict) out.push({ id, source: slot.source, title: slot.title, verdict });
  }
  return out;
}

/** The stable key of a screen-proposed detector: its source and its terms. Pure. */
export function proposedKey(source: string, terms: readonly string[]): string {
  return `screen:${source}:${[...terms].sort().join('+')}`.slice(0, 200);
}

/** The definition a detector stores, with the items it was built from. */
type StoredDefinition = LearnedDefinition & { trainedOn?: string[] };

/**
 * The GENERAL search method a screen-proposed detector serves, keyed by the
 * detector's key so a second call returns the same row. Null when the
 * definition cannot be shared (the privacy guard refused it): the detector
 * still exists, it just records no run.
 */
export async function methodForDetector(detectorKey: string, definition: Pick<LearnedDefinition, 'sources' | 'terms'>) {
  try {
    const subjectId = await feedSubjectOf(definition.sources);
    const method = await createSearchMethod({
      scope: 'GENERAL',
      methodKey: detectorKey,
      subjectId,
      finds: `feed items from ${definition.sources.join(', ')} whose titles carry ${definition.terms.join(' ')}`.slice(0, 2_000),
      usefulWhen: 'a feeds pass over items newly pulled from those sources',
      sources: [...definition.sources],
      requiredInputs: [],
      query: definition.terms.join(' '),
      checkProcedure:
        'Each firing on an item the detector was not built from is judged by two agreeing cheap-lane screen answers; precision over judged firings decides ACTIVE or SHADOW.',
    });
    return await withSubject(method, subjectId);
  } catch {
    return null;
  }
}

/**
 * The subject a detector over these sources searches: its one feed source's.
 * A detector over several sources has no single subject and names none.
 */
async function feedSubjectOf(sources: readonly string[]): Promise<string | null> {
  const distinct = [...new Set(sources)];
  if (distinct.length !== 1) return null;
  return (await subjectForFeedSource(distinct[0]!)).id;
}

/** Name a method's subject when it was written before it carried one. */
async function withSubject(method: SearchMethod, subjectId: string | null): Promise<SearchMethod> {
  if (!subjectId || method.subjectId !== null) return method;
  await linkMethodSubject(method.id, subjectId);
  return (await getSearchMethod(FEED_READER, method.id)) ?? method;
}

/** Link every GENERAL detector that serves no method to one. Returns how many were linked. */
export async function linkDetectorMethods(detectors: readonly LearnedDetector[]): Promise<number> {
  let linked = 0;
  for (const detector of detectors) {
    if (detector.scope !== 'GENERAL') continue;
    const def = detector.definition as StoredDefinition | null;
    if (!def || !Array.isArray(def.sources) || !Array.isArray(def.terms)) continue;
    if (detector.methodId) {
      // Linked before methods named their subject: name it now, once.
      const method = await getSearchMethod(FEED_READER, detector.methodId);
      if (method && method.subjectId === null) await withSubject(method, await feedSubjectOf(def.sources));
      continue;
    }
    const method = await methodForDetector(detector.detectorKey, def);
    if (method && (await attachDetectorMethod(detector.id, method.id))) linked += 1;
  }
  return linked;
}

/**
 * Create one SHADOW detector per source whose agreed positives define a
 * pattern no existing detector already holds. Returns the detectors created.
 */
export async function proposeDetectors(labels: readonly ScreenLabel[], existing: readonly LearnedDetector[]): Promise<LearnedDetector[]> {
  const held = new Set(existing.map((d) => d.detectorKey));
  const bySource = new Map<string, ScreenLabel[]>();
  for (const label of labels) bySource.set(label.source, [...(bySource.get(label.source) ?? []), label]);
  const created: LearnedDetector[] = [];
  for (const [source, list] of bySource) {
    const positives = list.filter((l) => l.verdict === 'CONFIRMED');
    const negatives = list.filter((l) => l.verdict === 'REJECTED');
    const built = defineFromExamples({ sources: [source], positives: positives.map((l) => l.title), negatives: negatives.map((l) => l.title) });
    if (!built.ok) continue;
    const key = proposedKey(source, built.definition.terms);
    if (held.has(key)) continue;
    const definition: StoredDefinition = { ...built.definition, trainedOn: [...positives, ...negatives].map((l) => l.id).sort() };
    const method = await methodForDetector(key, built.definition);
    const detector = await createLearnedDetector({ scope: 'GENERAL', detectorKey: key, methodId: method?.id ?? null, definition, threshold: PROPOSED_THRESHOLD });
    held.add(key);
    created.push(detector);
  }
  return created;
}

/**
 * Record every detector's firing (or miss) on each agreed-labelled item of its
 * sources that it was not built from. Returns how many examples were new.
 */
export async function judgeFirings(labels: readonly ScreenLabel[], detectors: readonly LearnedDetector[]): Promise<number> {
  let recorded = 0;
  for (const detector of detectors) {
    const def = detector.definition as StoredDefinition | null;
    if (!def || !Array.isArray(def.sources) || !Array.isArray(def.terms)) continue;
    const trained = new Set(def.trainedOn ?? []);
    for (const label of labels) {
      if (!def.sources.includes(label.source) || trained.has(label.id)) continue;
      const fired = confidenceOf(def, label.title) >= FIRE_AT;
      if (await recordDetectorExample({ detectorId: detector.id, itemRef: label.id, fired, verdict: label.verdict, labelledBy: SCREEN_LABELLER })) {
        recorded += 1;
      }
    }
  }
  return recorded;
}

/** The most items one comparison is recorded over: the newest judged ones. */
export const MAX_COMPARED_ITEMS = 2_000;

export interface DetectorComparisonInput {
  subjectId: string;
  items: string[];
  results: Record<string, MethodResult>;
}

/**
 * What the methods of one subject did on the items every one of them was
 * judged on. Pure. Each method's firings are the union over its detectors; an
 * item it did not fire on is not surfaced, and a judged firing is CONFIRMED or
 * REJECTED by the screen's agreed label. Null when fewer than two methods, or
 * no item, are shared.
 */
export function detectorComparison(
  subjectId: string,
  byMethod: ReadonlyMap<string, readonly DetectorExample[]>,
  max = MAX_COMPARED_ITEMS,
): DetectorComparisonInput | null {
  if (byMethod.size < 2) return null;
  // An item is shared when every method was judged on it.
  const judgedBy = new Map<string, number>();
  const newest = new Map<string, string>();
  for (const examples of byMethod.values()) {
    for (const item of new Set(examples.map((e) => e.itemRef))) judgedBy.set(item, (judgedBy.get(item) ?? 0) + 1);
    for (const e of examples) if ((newest.get(e.itemRef) ?? '') < e.createdAt) newest.set(e.itemRef, e.createdAt);
  }
  const shared = [...judgedBy].filter(([, n]) => n === byMethod.size).map(([item]) => item);
  if (shared.length === 0) return null;
  const items = shared
    .sort((a, b) => (newest.get(b) ?? '').localeCompare(newest.get(a) ?? '') || a.localeCompare(b))
    .slice(0, max)
    .sort();
  const inSet = new Set(items);
  const results: Record<string, MethodResult> = {};
  for (const [methodId, examples] of byMethod) {
    const surfaced = new Set<string>();
    const confirmed = new Set<string>();
    const rejected = new Set<string>();
    for (const e of examples) {
      if (!e.fired || !inSet.has(e.itemRef)) continue;
      surfaced.add(e.itemRef);
      (e.verdict === 'CONFIRMED' ? confirmed : rejected).add(e.itemRef);
    }
    // One item, two labels across detectors: the first label stands per detector, so take CONFIRMED only when no detector saw it REJECTED.
    for (const x of rejected) confirmed.delete(x);
    results[methodId] = { surfaced: [...surfaced].sort(), confirmed: [...confirmed].sort(), rejected: [...rejected].sort() };
  }
  return { subjectId, items, results };
}

/**
 * Compare, for each feed subject, the methods its detectors serve on the
 * items all of them were judged on, and record the comparison when that data
 * or the set of methods changed since the last one. Returns how many were
 * recorded. A refusal records nothing and stops no other subject.
 */
export async function compareDetectorMethods(detectors: readonly LearnedDetector[]): Promise<number> {
  const bySubject = new Map<string, Map<string, DetectorExample[]>>();
  for (const detector of detectors) {
    if (detector.scope !== 'GENERAL' || !detector.methodId) continue;
    const method = await getSearchMethod(FEED_READER, detector.methodId);
    if (!method?.subjectId || method.trustState === 'RETIRED') continue;
    const methods = bySubject.get(method.subjectId) ?? new Map<string, DetectorExample[]>();
    methods.set(method.id, [...(methods.get(method.id) ?? []), ...(await listDetectorExamples(FEED_READER, detector.id))]);
    bySubject.set(method.subjectId, methods);
  }
  let recorded = 0;
  for (const [subjectId, byMethod] of bySubject) {
    const input = detectorComparison(subjectId, byMethod);
    if (!input) continue;
    const [last] = await listMethodComparisons(FEED_READER, { subjectId, limit: 1 });
    if (last && sameList(last.itemRefs, input.items) && sameList(last.entries.map((e) => e.methodId), Object.keys(input.results))) continue;
    const compared = await compareMethods(FEED_READER, { ...input, scope: { scope: 'GENERAL' } });
    if (compared.ok) recorded += 1;
  }
  return recorded;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

export interface LearnReport {
  labelled: number;
  proposed: number;
  judged: number;
  /** Detectors proposed before they carried a method, linked to one this pass. */
  linked: number;
  /** Comparisons recorded this pass between methods for one feed subject on identical items. */
  compared: number;
}

/** One pass: read the agreed screen labels, propose what they define, judge every GENERAL detector on them. */
export async function learnFromScreens(now: Date): Promise<LearnReport> {
  const linked = await linkDetectorMethods(await listLearnedDetectors(FEED_READER));
  const labels = await screenLabels(now);
  if (labels.length === 0) return { labelled: 0, proposed: 0, judged: 0, linked, compared: 0 };
  const proposed = await proposeDetectors(labels, await listLearnedDetectors(FEED_READER));
  const judged = await judgeFirings(labels, await listLearnedDetectors(FEED_READER));
  const compared = await compareDetectorMethods(await listLearnedDetectors(FEED_READER));
  return { labelled: labels.length, proposed: proposed.length, judged, linked, compared };
}
