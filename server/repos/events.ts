import { getDb } from '../db/database.ts';
import type { EventType, ProjectEvent, ProjectEventRow } from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

function mapEvent(row: ProjectEventRow): ProjectEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventType: row.event_type as EventType,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: row.created_at,
  };
}

export interface RecordEventInput {
  projectId: string;
  layerId?: string | null;
  entityType: string;
  entityId?: string | null;
  eventType: EventType;
  payload?: Record<string, unknown>;
}

/**
 * Append-only. Invariant 3: no important action without an event.
 * History is never rewritten, only added to.
 */
export async function recordEvent(input: RecordEventInput): Promise<ProjectEvent> {
  const id = newId('evt');
  await getDb().run(
    `INSERT INTO project_events (id, project_id, layer_id, entity_type, entity_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.layerId ?? null, input.entityType, input.entityId ?? null,
      input.eventType, toJson(input.payload ?? {}), nowIso()],
  );
  return (await getDb().all<ProjectEventRow>('SELECT * FROM project_events WHERE id = ?', [id]))
    .map(mapEvent)[0]!;
}

export async function listEvents(projectId: string, limit = 200): Promise<ProjectEvent[]> {
  return (await getDb().all<ProjectEventRow>(
      'SELECT * FROM project_events WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [projectId, limit],
    ))
    .map(mapEvent);
}

export async function listEventsByLayer(layerId: string, limit = 100): Promise<ProjectEvent[]> {
  return (await getDb().all<ProjectEventRow>(
      'SELECT * FROM project_events WHERE layer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [layerId, limit],
    ))
    .map(mapEvent);
}

export async function listEventsByEntity(entityType: string, entityId: string): Promise<ProjectEvent[]> {
  return (await getDb().all<ProjectEventRow>(
      'SELECT * FROM project_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC',
      [entityType, entityId],
    ))
    .map(mapEvent);
}
