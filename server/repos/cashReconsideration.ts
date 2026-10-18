/**
 * Reopen conditions, the ledger of changes already consumed, and per-source
 * watermarks (OPPORTUNITY-INTELLIGENCE §3.2(b)).
 *
 * Three tables and one rule. **A reconsideration arises only from a distinct
 * change.** There is no lifetime count of how many times a piece may be looked
 * at again; what bounds it is that `cash_reconsideration_triggers` is keyed by
 * `(opportunity_id, change_ref)`, so the same change can never reconsider the
 * same piece twice. Every path that consumes a change goes through
 * `consumeChange`, and the insert that lands is the arbiter — two passes
 * reading the same change produce one trigger and one ordinary loser.
 *
 * A reopen condition is a **watch**, not a need. A need is something Brain is
 * trying to obtain now and the review shows it as such; a reopen condition is a
 * fact nobody is pursuing, held by a dormant piece. Folding them together would
 * fill "What Brain needs" with dormant work, which §33 already corrected once.
 *
 * Append-only. The only columns ever written after an insert are
 * `triggered_at` and `trigger_change_ref`, once, by a guarded UPDATE — either
 * because a change met the watch, or because a sibling watch already reopened
 * the same dormancy (`retireSiblingConditions`); and a watermark's position, by
 * a compare-and-swap on the position the caller read.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import {
  parseBlockerKey,
  REOPEN_RECORDED_FROM,
  RECONSIDERATION_TRIGGER_KINDS,
} from '../domain/types.ts';
import type {
  BlockerKey,
  CashChangeWatermark,
  CashChangeWatermarkRow,
  CashReconsiderationTrigger,
  CashReconsiderationTriggerRow,
  CashReopenCondition,
  CashReopenConditionRow,
  ReconsiderationTriggerKind,
  ReopenRecordedFrom,
} from '../domain/types.ts';

function mapCondition(row: CashReopenConditionRow): CashReopenCondition {
  const key = parseBlockerKey(row.blocker_key);
  if (!key) throw new Error(`Reopen condition ${row.id} holds an unreadable blocker key.`);
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    blockerKey: key,
    recordedFrom: (REOPEN_RECORDED_FROM as readonly string[]).includes(row.recorded_from)
      ? (row.recorded_from as ReopenRecordedFrom)
      : 'ARCHIVE',
    observedAtRecord: row.observed_at_record,
    actorRef: row.actor_ref,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
    triggerChangeRef: row.trigger_change_ref,
  };
}

function mapTrigger(row: CashReconsiderationTriggerRow): CashReconsiderationTrigger {
  return {
    opportunityId: row.opportunity_id,
    changeRef: row.change_ref,
    projectId: row.project_id,
    blockerKey: parseBlockerKey(row.blocker_key),
    kind: (RECONSIDERATION_TRIGGER_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as ReconsiderationTriggerKind)
      : 'REOPEN_CONDITION',
    createdAt: row.created_at,
  };
}

function mapWatermark(row: CashChangeWatermarkRow): CashChangeWatermark {
  return {
    projectId: row.project_id,
    source: row.source,
    through: row.through,
    marker: row.marker,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------------ */
/* Reopen conditions                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Record one watch, or read back the live one that already holds this key.
 *
 * One untriggered condition per (opportunity, key), enforced by a partial
 * unique index, so archiving twice or a proposal and a person naming the same
 * key both produce one watch rather than two that would each want to fire.
 */
export async function recordReopenCondition(input: {
  projectId: string;
  opportunityId: string;
  blockerKey: BlockerKey;
  recordedFrom: ReopenRecordedFrom;
  observedAtRecord?: string | null;
  actorRef: string;
  at?: string;
}): Promise<{ condition: CashReopenCondition; created: boolean }> {
  const id = newId('crc');
  const at = input.at ?? nowIso();
  const result = await getDb().run(
    `INSERT INTO cash_reopen_conditions
       (id, project_id, opportunity_id, blocker_key, recorded_from, observed_at_record,
        actor_ref, created_at, triggered_at, trigger_change_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.blockerKey,
      input.recordedFrom,
      input.observedAtRecord ?? null,
      input.actorRef,
      at,
    ],
  );
  if (result.changes === 1) {
    const written = await getReopenCondition(id);
    if (written) return { condition: written, created: true };
  }
  const rows = await getDb().all<CashReopenConditionRow>(
    `SELECT * FROM cash_reopen_conditions
      WHERE opportunity_id = ? AND blocker_key = ? AND triggered_at IS NULL`,
    [input.opportunityId, input.blockerKey],
  );
  if (!rows[0]) throw new Error('The reopen condition disappeared immediately after being written.');
  return { condition: mapCondition(rows[0]), created: false };
}

export async function getReopenCondition(id: string): Promise<CashReopenCondition | null> {
  const rows = await getDb().all<CashReopenConditionRow>(
    'SELECT * FROM cash_reopen_conditions WHERE id = ?',
    [id],
  );
  return rows[0] ? mapCondition(rows[0]) : null;
}

/** Every condition one piece has ever held, oldest first — triggered ones included. */
export async function reopenConditionsFor(opportunityId: string): Promise<CashReopenCondition[]> {
  const rows = await getDb().all<CashReopenConditionRow>(
    `SELECT * FROM cash_reopen_conditions WHERE opportunity_id = ?
      ORDER BY created_at, id`,
    [opportunityId],
  );
  return rows.map(mapCondition);
}

/** Every condition in one project, for a pass that composes standing for all of it. */
export async function reopenConditionsForProject(projectId: string): Promise<CashReopenCondition[]> {
  const rows = await getDb().all<CashReopenConditionRow>(
    `SELECT * FROM cash_reopen_conditions WHERE project_id = ?
      ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map(mapCondition);
}

/**
 * The fan-out read: every untriggered watch on one fact in one project.
 *
 * One indexed query over `idx_cash_reopen_untriggered`, which is what makes
 * reconsideration O(changed keys × affected rows) rather than O(portfolio).
 */
export async function untriggeredConditionsForKey(
  projectId: string,
  blockerKey: BlockerKey,
): Promise<CashReopenCondition[]> {
  const rows = await getDb().all<CashReopenConditionRow>(
    `SELECT * FROM cash_reopen_conditions
      WHERE project_id = ? AND blocker_key = ? AND triggered_at IS NULL
      ORDER BY created_at, id`,
    [projectId, blockerKey],
  );
  return rows.map(mapCondition);
}

/* ------------------------------------------------------------------------ */
/* The ledger of consumed changes                                            */
/* ------------------------------------------------------------------------ */

/**
 * Consume one change for one piece, exactly once.
 *
 * True only for the call whose insert landed. A change ref must name a
 * distinct change (for example `capabilities@<watermark>` or `PERSON:<event id>`);
 * the key is what makes "the same change can never trigger the same
 * opportunity twice" a property of the schema.
 */
export async function consumeChange(input: {
  projectId: string;
  opportunityId: string;
  changeRef: string;
  blockerKey?: BlockerKey | null;
  kind: ReconsiderationTriggerKind;
  at?: string;
}): Promise<boolean> {
  const ref = input.changeRef.trim();
  if (!ref) return false;
  const result = await getDb().run(
    `INSERT INTO cash_reconsideration_triggers
       (opportunity_id, change_ref, project_id, blocker_key, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      input.opportunityId,
      ref,
      input.projectId,
      input.blockerKey ?? null,
      input.kind,
      input.at ?? nowIso(),
    ],
  );
  return result.changes === 1;
}

/** Whether this change has already been consumed for this piece. */
export async function changeConsumed(opportunityId: string, changeRef: string): Promise<boolean> {
  const rows = await getDb().all<{ found: number }>(
    `SELECT 1 AS found FROM cash_reconsideration_triggers
      WHERE opportunity_id = ? AND change_ref = ?`,
    [opportunityId, changeRef],
  );
  return rows.length > 0;
}

export async function reconsiderationTriggersFor(
  opportunityId: string,
): Promise<CashReconsiderationTrigger[]> {
  const rows = await getDb().all<CashReconsiderationTriggerRow>(
    `SELECT * FROM cash_reconsideration_triggers WHERE opportunity_id = ?
      ORDER BY created_at, change_ref`,
    [opportunityId],
  );
  return rows.map(mapTrigger);
}

/**
 * A distinct change met one watch: consume it and stamp the condition, in one
 * transaction.
 *
 * Both halves or neither. The consumption is the arbiter — a second condition
 * on the same piece met by the same change stays untriggered, because one
 * change reconsiders a piece once — and the stamp is guarded on the condition
 * still being untriggered, so a condition is triggered once whatever races.
 * Moves no opportunity state: what a trigger *does* (a request to a person, or
 * a flag Brain re-derives) is the caller's, and a person's decision is never
 * reversed here.
 */
export async function triggerReopenCondition(input: {
  conditionId: string;
  changeRef: string;
  at?: string;
}): Promise<boolean> {
  const ref = input.changeRef.trim();
  if (!ref) return false;
  const db = getDb();
  const at = input.at ?? nowIso();
  try {
    return await db.transaction(async () => {
      const condition = await getReopenCondition(input.conditionId);
      if (!condition || condition.triggeredAt !== null) return false;
      const consumed = await consumeChange({
        projectId: condition.projectId,
        opportunityId: condition.opportunityId,
        changeRef: ref,
        blockerKey: condition.blockerKey,
        kind: 'REOPEN_CONDITION',
        at,
      });
      if (!consumed) return false;
      const stamped = await db.run(
        `UPDATE cash_reopen_conditions
            SET triggered_at = ?, trigger_change_ref = ?
          WHERE id = ? AND triggered_at IS NULL`,
        [at, ref, condition.id],
      );
      if (stamped.changes !== 1) throw new LostTrigger();
      return true;
    });
  } catch (error) {
    if (error instanceof LostTrigger) return false;
    throw error;
  }
}

/** Rolls back the consumption when the stamp lost a race. Never escapes. */
class LostTrigger extends Error {}

/** The `trigger_change_ref` prefix a watch carries when its dormancy was reopened by a sibling. */
export const SUPERSEDED_BY_PREFIX = 'superseded-by:';

/**
 * A dormancy reopens once: when one of a piece's watches fired and the piece
 * was flagged for re-evaluation, the other watches it was holding stop
 * guarding anything.
 *
 * A failed screen records `EVIDENCE:payer` and `FIELD:payer` together, as
 * alternatives. Left live after the first one reopened the piece, the second
 * then fired on the payer the re-dive *itself* wrote onto the card — the
 * consequence of the reconsideration counted as a second, distinct change —
 * and opened another epoch with a fresh round budget (found by the
 * Opportunity Intelligence walk: two extra full dives, nothing new learned).
 *
 * Stamped, never deleted, with `superseded-by:<changeRef>` so a reader can
 * tell a watch that was met from one that was retired. Guarded on
 * `triggered_at IS NULL` like every stamp. Consumes no change: nothing was
 * reconsidered by it. If the reopened piece goes dormant again, the pass that
 * says so records fresh watches, because these no longer hold the key.
 */
export async function retireSiblingConditions(input: {
  opportunityId: string;
  exceptConditionId: string;
  changeRef: string;
  at?: string;
}): Promise<number> {
  const ref = input.changeRef.trim();
  if (!ref) return 0;
  const result = await getDb().run(
    `UPDATE cash_reopen_conditions
        SET triggered_at = ?, trigger_change_ref = ?
      WHERE opportunity_id = ? AND id <> ? AND triggered_at IS NULL`,
    [input.at ?? nowIso(), `${SUPERSEDED_BY_PREFIX}${ref}`, input.opportunityId, input.exceptConditionId],
  );
  return result.changes;
}

/**
 * A distinct change asked for a *live* piece (or a derived dead end) to be
 * re-evaluated: consume it and set the request, in one transaction.
 *
 * Used for pieces where nothing a person decided is being overruled. Never
 * call it for an ARCHIVED or DECLINED piece — those raise a request to a
 * person instead — and the statement refuses them anyway.
 */
export async function requestReconsideration(input: {
  projectId: string;
  opportunityId: string;
  changeRef: string;
  blockerKey?: BlockerKey | null;
  at?: string;
}): Promise<boolean> {
  const ref = input.changeRef.trim();
  if (!ref) return false;
  const db = getDb();
  const at = input.at ?? nowIso();
  try {
    return await db.transaction(async () => {
      const consumed = await consumeChange({
        projectId: input.projectId,
        opportunityId: input.opportunityId,
        changeRef: ref,
        blockerKey: input.blockerKey ?? null,
        kind: 'LIVE_REQUEST',
        at,
      });
      if (!consumed) return false;
      const flagged = await db.run(
        `UPDATE cash_opportunities
            SET reconsider_requested_at = ?, last_reconsider_change_ref = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND state NOT IN ('ARCHIVED', 'DECLINED')`,
        [at, ref, at, input.opportunityId, input.projectId],
      );
      if (flagged.changes !== 1) throw new LostTrigger();
      return true;
    });
  } catch (error) {
    if (error instanceof LostTrigger) return false;
    throw error;
  }
}

/* ------------------------------------------------------------------------ */
/* Watermarks                                                                */
/* ------------------------------------------------------------------------ */

export async function getWatermark(
  projectId: string,
  source: string,
): Promise<CashChangeWatermark | null> {
  const rows = await getDb().all<CashChangeWatermarkRow>(
    'SELECT * FROM cash_change_watermarks WHERE project_id = ? AND source = ?',
    [projectId, source],
  );
  return rows[0] ? mapWatermark(rows[0]) : null;
}

export async function listWatermarks(projectId: string): Promise<CashChangeWatermark[]> {
  const rows = await getDb().all<CashChangeWatermarkRow>(
    'SELECT * FROM cash_change_watermarks WHERE project_id = ? ORDER BY source',
    [projectId],
  );
  return rows.map(mapWatermark);
}

/**
 * Move a source's watermark, guarded on the position the caller read.
 *
 * `from: null` means "I read none": the first writer inserts and every other
 * first writer loses. Otherwise the UPDATE matches only while the row still
 * says `from`, so two passes that read one position produce one move. A loser
 * re-reads; nothing is skipped and nothing is read twice as new.
 */
export async function advanceWatermark(input: {
  projectId: string;
  source: string;
  from: string | null;
  through: string;
  marker?: string | null;
  /**
   * The marker the caller read, for a source whose position alone cannot say
   * whether anything moved. When given, the swap is guarded on it as well.
   */
  fromMarker?: string | null;
  at?: string;
}): Promise<boolean> {
  const at = input.at ?? nowIso();
  if (input.from === null) {
    const inserted = await getDb().run(
      `INSERT INTO cash_change_watermarks (project_id, source, through, marker, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [input.projectId, input.source, input.through, input.marker ?? null, at],
    );
    return inserted.changes === 1;
  }
  const guardMarker = input.fromMarker !== undefined;
  const moved = await getDb().run(
    `UPDATE cash_change_watermarks
        SET through = ?, marker = ?, updated_at = ?
      WHERE project_id = ? AND source = ? AND through = ?${
        guardMarker ? " AND COALESCE(marker, '') = ?" : ''
      }`,
    [
      input.through,
      input.marker ?? null,
      at,
      input.projectId,
      input.source,
      input.from,
      ...(guardMarker ? [input.fromMarker ?? ''] : []),
    ],
  );
  return moved.changes === 1;
}
