/**
 * Production probe for MEM-32: every goal plan reading is kept as one
 * immutable decision record — the decision faced, the alternatives, the
 * evidence with its fingerprint, the authority it was made under, when, why,
 * and the chain from evidence to the result row that will judge it.
 *
 * It reads `workstream_events` of kind GOAL_DECISION_RECORDED and the
 * `goal_plan_readings` they name, and nothing else; it does not import the
 * code that writes them (a judge that called the writer would be marking its
 * own work).
 *  - FAIL: a record that is not keyed by its reading, names a reading that does
 *    not exist or belongs to another goal, or is missing any part of the record.
 *  - PASS: at least one record, every one complete and linked.
 *  - UNKNOWN: no plan reading has been recorded as a decision yet (§39 — an
 *    absence is not a demonstration either way).
 */
import type { ProbeResult } from '../probes.ts';

export const DECISION_KIND = 'GOAL_DECISION_RECORDED';
const PREFIX = 'wse_gdr_';
/** Newest records judged per reading of the probe. */
const READ_LIMIT = 500;

export interface DecisionEventRow {
  id: string;
  workstream_id: string;
  detail: string | null;
}

export interface ReadingRow {
  id: string;
  workstream_id: string;
  created_at: string;
}

const text = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** What is wrong with one record, or null. Pure. */
export function decisionRecordProblem(event: DecisionEventRow, reading: ReadingRow | undefined): string | null {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(event.detail ?? '') as Record<string, unknown>;
  } catch {
    return `decision record ${event.id} is not readable`;
  }
  if (!r || typeof r !== 'object') return `decision record ${event.id} is not readable`;
  const readingId = r.readingId;
  if (!text(readingId) || event.id !== `${PREFIX}${String(readingId)}`) return `decision record ${event.id} is not keyed by the reading it records`;
  if (!reading) return `decision record ${event.id} names reading ${String(readingId)}, which does not exist`;
  if (reading.workstream_id !== event.workstream_id || r.goalId !== event.workstream_id) return `decision record ${event.id} is filed under a goal its reading does not belong to`;
  if (!text(r.decision)) return `decision record ${event.id} does not state the decision faced`;
  if (!Array.isArray(r.alternatives)) return `decision record ${event.id} keeps no alternatives`;
  if (!Array.isArray(r.evidence)) return `decision record ${event.id} keeps no evidence`;
  for (const e of r.evidence as Array<Record<string, unknown>>) {
    if (!e || !text(e.kind) || !text(e.sourceRowId) || !text(e.fingerprint)) return `decision record ${event.id} carries evidence without its kind, source row or fingerprint`;
  }
  if (!Array.isArray(r.conditions)) return `decision record ${event.id} does not say what it assumed`;
  const authority = r.authority as Record<string, unknown> | undefined;
  if (!authority || !text(authority.actor) || !text(authority.verdict)) return `decision record ${event.id} does not say under what authority it was made`;
  if (r.decidedAt !== reading.created_at) return `decision record ${event.id} is not dated by its reading`;
  if (!text(r.reason)) return `decision record ${event.id} gives no reason for its choice`;
  const chain = r.chain as Record<string, unknown> | undefined;
  const results = chain?.results as Record<string, unknown> | undefined;
  if (!chain || !Array.isArray(chain.evidence) || !Array.isArray(chain.actions) || results?.readingId !== readingId) {
    return `decision record ${event.id} does not link evidence through to the result that will judge it`;
  }
  return null;
}

/** MEM-32 on given rows. Pure. */
export function decisionMemoryHolds(events: readonly DecisionEventRow[], readings: ReadonlyMap<string, ReadingRow>): ProbeResult {
  if (events.length === 0) return { ok: null, detail: 'no goal plan reading has been recorded as a decision on production yet' };
  for (const event of events) {
    const problem = decisionRecordProblem(event, readings.get(event.id.slice(PREFIX.length)));
    if (problem) return { ok: false, detail: problem };
  }
  const goals = new Set(events.map((e) => e.workstream_id)).size;
  return { ok: true, detail: `${events.length} decision record(s) across ${goals} goal(s), each keyed by its reading, complete, and linked from evidence to result` };
}

export async function decisionMemoryHoldsOnRows(): Promise<ProbeResult> {
  const { getDb } = await import('../../../../db/database.ts');
  const db = getDb();
  const events = await db.all<DecisionEventRow>(
    `SELECT id, workstream_id, detail FROM workstream_events WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ${READ_LIMIT}`,
    [DECISION_KIND],
  );
  const readings = new Map<string, ReadingRow>();
  const ids = [...new Set(events.filter((e) => e.id.startsWith(PREFIX)).map((e) => e.id.slice(PREFIX.length)))];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const rows = await db.all<ReadingRow>(
      `SELECT id, workstream_id, created_at FROM goal_plan_readings WHERE id IN (${slice.map(() => '?').join(', ')})`,
      slice,
    );
    for (const row of rows) readings.set(row.id, row);
  }
  return decisionMemoryHolds(events, readings);
}
