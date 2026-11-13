/**
 * The history's own append-only event log.
 *
 * `project_events` needs a project, and a person's history belongs to the
 * person before it belongs to any project, so memory keeps its own log with the
 * same rule: rows are inserted and never updated or deleted. When a decision
 * reaches a project (an idea promoted into one), that project's own
 * `project_events` row is written as well.
 *
 * Payloads carry ids and counts, never conversation text: this log is read by
 * reports and must be safe to print.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, toJson } from '../../repos/util.ts';

export async function recordMemoryEvent(
  ownerId: string,
  entityType: string,
  entityId: string | null,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await getDb().run(
    `INSERT INTO memory_events (id, owner_user_id, entity_type, entity_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId('mev'), ownerId, entityType, entityId, eventType, toJson(payload), nowIso()],
  );
}

export async function getCursor(ownerId: string, name: string): Promise<string | null> {
  const row = await getDb().get<{ value: string }>(
    'SELECT value FROM memory_cursors WHERE owner_user_id = ? AND name = ?',
    [ownerId, name],
  );
  return row?.value ?? null;
}

export async function setCursor(ownerId: string, name: string, value: string): Promise<void> {
  await getDb().run(
    `INSERT INTO memory_cursors (owner_user_id, name, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner_user_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [ownerId, name, value, nowIso()],
  );
}
