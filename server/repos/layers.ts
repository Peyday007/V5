import { getDb } from '../db/database.ts';
import type { Layer, LayerRow, LayerStatus, StatusSource } from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, parseJson, slugify, toBool, toJson } from './util.ts';

export function mapLayer(row: LayerRow): Layer {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    orderIndex: Number(row.order_index),
    status: row.status as LayerStatus,
    statusSource: row.status_source as StatusSource,
    manualStatus: (row.manual_status as LayerStatus | null) ?? null,
    manualStatusReason: row.manual_status_reason,
    currentVersion: row.current_version,
    currentWave: Number(row.current_wave),
    canonicalDocumentId: row.canonical_document_id,
    expectedVersions: parseJson<string[]>(row.expected_versions, []),
    parked: toBool(row.parked),
    parkedNote: row.parked_note,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateLayerInput {
  projectId: string;
  name: string;
  orderIndex: number;
  slug?: string;
  expectedVersions?: string[];
  currentWave?: number;
  notes?: string | null;
  parked?: boolean;
  parkedNote?: string | null;
}

export async function createLayer(input: CreateLayerInput): Promise<Layer> {
  const db = getDb();
  const ts = nowIso();
  const id = newId('lyr');
  await db.run(
    `INSERT INTO layers (id, project_id, slug, name, order_index, status, status_source,
       current_wave, expected_versions, parked, parked_note, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'NOT_STARTED', 'DERIVED', ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.slug ?? slugify(input.name), input.name, input.orderIndex,
      input.currentWave ?? 1, toJson(input.expectedVersions ?? []), fromBool(input.parked),
      input.parkedNote ?? null, input.notes ?? null, ts, ts],
  );
  return (await getLayer(id))!;
}

export async function listLayers(projectId: string): Promise<Layer[]> {
  return (await getDb().all<LayerRow>('SELECT * FROM layers WHERE project_id = ? ORDER BY order_index', [projectId]))
    .map(mapLayer);
}

export async function getLayer(id: string): Promise<Layer | null> {
  const row = await getDb().get<LayerRow>('SELECT * FROM layers WHERE id = ?', [id]);
  return row ? mapLayer(row) : null;
}

export async function getLayerBySlug(projectId: string, slug: string): Promise<Layer | null> {
  const row = await getDb().get<LayerRow>('SELECT * FROM layers WHERE project_id = ? AND slug = ?', [
    projectId,
    slug,
  ]);
  return row ? mapLayer(row) : null;
}

export interface UpdateLayerInput {
  name?: string;
  status?: LayerStatus;
  statusSource?: StatusSource;
  manualStatus?: LayerStatus | null;
  manualStatusReason?: string | null;
  currentVersion?: string | null;
  currentWave?: number;
  canonicalDocumentId?: string | null;
  expectedVersions?: string[];
  parked?: boolean;
  parkedNote?: string | null;
  notes?: string | null;
  orderIndex?: number;
}

export async function updateLayer(id: string, patch: UpdateLayerInput): Promise<Layer | null> {
  const { clause, values } = buildUpdate({
    name: patch.name,
    status: patch.status,
    status_source: patch.statusSource,
    manual_status: patch.manualStatus,
    manual_status_reason: patch.manualStatusReason,
    current_version: patch.currentVersion,
    current_wave: patch.currentWave,
    canonical_document_id: patch.canonicalDocumentId,
    expected_versions: patch.expectedVersions ? toJson(patch.expectedVersions) : undefined,
    parked: patch.parked === undefined ? undefined : fromBool(patch.parked),
    parked_note: patch.parkedNote,
    notes: patch.notes,
    order_index: patch.orderIndex,
  });
  if (!clause) return getLayer(id);
  await getDb().run(`UPDATE layers SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getLayer(id);
}
