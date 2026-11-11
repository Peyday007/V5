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
 * Nothing here calls a model: it reads answers already given.
 */
import { getDb } from '../../db/database.ts';
import { createLearnedDetector, listLearnedDetectors, recordDetectorExample } from '../../repos/searchMethods.ts';
import type { LearnedDetector } from '../../domain/searchIntelligence.ts';
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
    const detector = await createLearnedDetector({ scope: 'GENERAL', detectorKey: key, definition, threshold: PROPOSED_THRESHOLD });
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

export interface LearnReport {
  labelled: number;
  proposed: number;
  judged: number;
}

/** One pass: read the agreed screen labels, propose what they define, judge every GENERAL detector on them. */
export async function learnFromScreens(now: Date): Promise<LearnReport> {
  const labels = await screenLabels(now);
  if (labels.length === 0) return { labelled: 0, proposed: 0, judged: 0 };
  const proposed = await proposeDetectors(labels, await listLearnedDetectors(FEED_READER));
  const judged = await judgeFirings(labels, await listLearnedDetectors(FEED_READER));
  return { labelled: labels.length, proposed: proposed.length, judged };
}
