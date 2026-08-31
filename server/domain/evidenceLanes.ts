/**
 * What a fragment is asking for, as something a claim can point at.
 *
 * A lane is the unit the gate's coverage check works in: for each one it asks
 * whether any accepted claim filled it. That makes the lane a *key*, and the
 * first fresh acceptance packet showed what happens when a key is prose.
 * Its lanes were sentences like:
 *
 *   "Definitions in NY Real Property Law Art. 12-A deciding whether 'real
 *    estate broker' activity includes or excludes arranging a business sale
 *    with no realty transferred"
 *
 * — 160 characters, matched by exact string equality, three per fragment. A
 * worker had to reproduce one byte-for-byte for its evidence to count. Nothing
 * in that is unreasonable as a *description*; all of it is unreasonable as an
 * identifier.
 *
 * So a lane now has three parts, and they do three different jobs:
 *
 * - **`id`** — short, stable, machine-shaped. This is what `evidence_lane`
 *   carries and what coverage compares. `operative_authority`, not a sentence.
 * - **`description`** — the prose, which is where the real question lives and
 *   which the worker actually needs in order to research it. Never used for
 *   matching.
 * - **`necessity`** — whether an empty lane blocks the fragment.
 *
 * That last one is its own correction. Every lane was mandatory, including
 * ones whose own description ended "…if any exists on point". A lane that asks
 * whether something exists cannot be satisfied only by its existing: an
 * acceptable *category* of source is not automatically a mandatory coverage
 * requirement, and treating it as one fails a fragment for correctly reporting
 * that a regulator has published nothing.
 */
import type { EvidenceLane, LaneNecessity } from './types.ts';

export const LANE_NECESSITIES: LaneNecessity[] = ['REQUIRED', 'OPTIONAL', 'CONDITIONAL'];

/**
 * The shape of an id, and the reason it is narrow.
 *
 * Lowercase, starts with a letter, then letters, digits and underscores, at
 * most 40 characters. Narrow enough that a sentence cannot be one by accident,
 * short enough to retype, and stable enough to compare — which are the three
 * things the old prose lanes were not.
 */
export const LANE_ID = /^[a-z][a-z0-9_]{1,39}$/;

export function isLaneId(value: string): boolean {
  return LANE_ID.test(value);
}

/**
 * An id derived from a description, for a plan that gave only prose.
 *
 * Deterministic, so the same description always produces the same id and two
 * runs of an equivalent plan agree. Built from the first few meaningful words
 * rather than the whole sentence, because an id made by slugging 160
 * characters is the same mistake with hyphens in it.
 *
 * This is a fallback for a plan that did not declare ids, not the intended
 * path: a derived id names whatever the description happened to open with,
 * where a declared one names the concept.
 */
export function laneIdFrom(description: string, fallback = 'evidence'): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
  const id = words.slice(0, 4).join('_').slice(0, 40).replace(/_+$/, '');
  return isLaneId(id) ? id : fallback;
}

/** Words that carry no meaning in an identifier built from a question. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of',
  'on', 'or', 'that', 'the', 'to', 'was', 'were', 'whether', 'which', 'with',
]);

/**
 * Read lanes from a stored row.
 *
 * A bare string is a lane from before this shape existed: its text becomes the
 * description, its id is derived, and it stays `REQUIRED` — which is what it
 * meant when every lane was mandatory. Conservative on purpose, and it means
 * no row has to be rewritten to be read correctly.
 */
export function parseLanes(raw: unknown): EvidenceLane[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? safeJson(raw) : [];
  const lanes: EvidenceLane[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const description = entry.trim();
      if (description.length === 0) continue;
      lanes.push({ id: laneIdFrom(description), description, necessity: 'REQUIRED' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const description = typeof row['description'] === 'string' ? row['description'].trim() : '';
    const declared = typeof row['id'] === 'string' ? row['id'].trim() : '';
    const id = isLaneId(declared) ? declared : laneIdFrom(description || declared);
    const necessity = LANE_NECESSITIES.includes(row['necessity'] as LaneNecessity)
      ? (row['necessity'] as LaneNecessity)
      : 'REQUIRED';
    if (!description && !declared) continue;
    lanes.push({ id, description: description || declared, necessity });
  }
  return dedupe(lanes);
}

function safeJson(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One lane per id.
 *
 * Two lanes sharing an id would make coverage ambiguous — a claim tagged with
 * it would fill both, or neither, depending on which the loop reached first —
 * so the first wins and the rest are dropped. Refusing the whole plan is the
 * alternative and it is worse: a duplicate id is a naming slip, not a reason
 * to throw away a plan somebody waited for.
 */
function dedupe(lanes: EvidenceLane[]): EvidenceLane[] {
  const seen = new Map<string, EvidenceLane>();
  for (const lane of lanes) if (!seen.has(lane.id)) seen.set(lane.id, lane);
  return [...seen.values()];
}

export function serializeLanes(lanes: EvidenceLane[]): EvidenceLane[] {
  return lanes.map((lane) => ({
    id: lane.id,
    description: lane.description,
    necessity: lane.necessity,
  }));
}

/** The ids, which is what a claim's `evidence_lane` is compared against. */
export function laneIds(lanes: EvidenceLane[]): string[] {
  return lanes.map((lane) => lane.id);
}

/** The lanes an empty result actually fails the fragment on. */
export function requiredLanes(lanes: EvidenceLane[]): EvidenceLane[] {
  return lanes.filter((lane) => lane.necessity === 'REQUIRED');
}

/** `id — description` , for a prompt, a refusal or a report. */
export function describeLane(lane: EvidenceLane): string {
  const mark = lane.necessity === 'REQUIRED' ? '' : ` (${lane.necessity.toLowerCase()})`;
  return `${lane.id}${mark} — ${lane.description}`;
}
