/**
 * Facts recorded against a goal's industry construction (§92). Append-only:
 * there is no update and no delete, because a fact that replaced another is
 * resolved at read time and the one it replaced stays history (invariant 17).
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { isFactKey, type Fact, type FactStatus } from '../domain/construction.ts';
import type { ConstructionFactRow } from '../domain/types.ts';

export interface RecordedFact extends Fact {
  id: string;
  workstreamId: string;
  recordedBy: string;
  createdAt: string;
}

export function mapConstructionFact(row: ConstructionFactRow): RecordedFact | null {
  if (!isFactKey(row.fact_key)) return null;
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    key: row.fact_key,
    segment: row.segment,
    low: Number(row.low),
    high: Number(row.high),
    status: row.status as FactStatus,
    measures: row.measures,
    source: { title: row.source_title, url: row.source_url, kind: row.status === 'OBSERVED' ? 'OUTCOME' : 'OPERATOR' },
    geography: null,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  };
}

export async function recordConstructionFact(input: {
  projectId: string | null;
  workstreamId: string;
  fact: Omit<Fact, 'source' | 'geography'> & { sourceTitle: string; sourceUrl: string | null };
  recordedBy: string;
}): Promise<RecordedFact> {
  const row: ConstructionFactRow = {
    id: newId('cfa'),
    project_id: input.projectId,
    workstream_id: input.workstreamId,
    fact_key: input.fact.key,
    segment: input.fact.segment,
    low: Math.min(input.fact.low, input.fact.high),
    high: Math.max(input.fact.low, input.fact.high),
    status: input.fact.status,
    measures: input.fact.measures,
    source_title: input.fact.sourceTitle,
    source_url: input.fact.sourceUrl,
    recorded_by: input.recordedBy,
    created_at: nowIso(),
  };
  await getDb().run(
    `INSERT INTO construction_facts (id, project_id, workstream_id, fact_key, segment, low, high, status, measures, source_title, source_url, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.project_id, row.workstream_id, row.fact_key, row.segment, row.low, row.high, row.status, row.measures, row.source_title, row.source_url, row.recorded_by, row.created_at],
  );
  return mapConstructionFact(row)!;
}

export async function listConstructionFacts(workstreamId: string): Promise<RecordedFact[]> {
  const rows = await getDb().all<ConstructionFactRow>(
    'SELECT * FROM construction_facts WHERE workstream_id = ? ORDER BY created_at ASC, id ASC',
    [workstreamId],
  );
  return rows.map(mapConstructionFact).filter((f): f is RecordedFact => f !== null);
}
