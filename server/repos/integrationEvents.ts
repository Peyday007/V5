/**
 * The integration registry's append-only record (§103): health readings,
 * automatic repairs and metered calls. Rows are never updated or deleted; the
 * current health of a service is its latest CHECK row, and a paid service's
 * spend today is a count of its USAGE rows.
 */
import { getDb } from '../db/database.ts';
import type { IntegrationEventRow } from '../domain/types.ts';
import { newId, nowIso } from './util.ts';

export type IntegrationEventKind = IntegrationEventRow['kind'];

export interface IntegrationEvent {
  id: string;
  integrationId: string;
  kind: IntegrationEventKind;
  state: string;
  detail: string;
  source: string;
  recordedAt: string;
}

function map(row: IntegrationEventRow): IntegrationEvent {
  return {
    id: row.id,
    integrationId: row.integration_id,
    kind: row.kind,
    state: row.state,
    detail: row.detail,
    source: row.source,
    recordedAt: row.recorded_at,
  };
}

export async function recordIntegrationEvent(input: {
  integrationId: string;
  kind: IntegrationEventKind;
  state: string;
  detail: string;
  source: string;
}): Promise<IntegrationEvent> {
  const row: IntegrationEventRow = {
    id: newId('ie'),
    integration_id: input.integrationId,
    kind: input.kind,
    state: input.state,
    detail: input.detail.slice(0, 2000),
    source: input.source.slice(0, 200),
    recorded_at: nowIso(),
  };
  await getDb().run(
    `INSERT INTO integration_events (id, integration_id, kind, state, detail, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.integration_id, row.kind, row.state, row.detail, row.source, row.recorded_at],
  );
  return map(row);
}

/** The newest events of one kind, newest first, across every integration. */
export async function listIntegrationEvents(kind: IntegrationEventKind, limit = 200): Promise<IntegrationEvent[]> {
  return (await getDb().all<IntegrationEventRow>(
    'SELECT * FROM integration_events WHERE kind = ? ORDER BY recorded_at DESC, id DESC LIMIT ?',
    [kind, limit],
  )).map(map);
}

/** How many metered calls an integration made since a moment (the ceiling's count). */
export async function countIntegrationUsage(integrationId: string, sinceIso: string): Promise<number> {
  const rows = await getDb().all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM integration_events WHERE integration_id = ? AND kind = 'USAGE' AND recorded_at >= ?`,
    [integrationId, sinceIso],
  );
  return Number(rows[0]?.n ?? 0);
}
