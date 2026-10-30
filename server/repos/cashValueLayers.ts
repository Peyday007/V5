/** The seven value layers of an opportunity; one row per layer, replaced rather than accumulated. */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { ValueLayerReading, ValueLayerRow } from '../domain/cashValueLayers.ts';
import type { LayerInput } from '../services/cash/valueLayers.ts';
import { refuseLayer } from '../services/cash/valueLayers.ts';
import type { LayerStatus, ValueLayer } from '../domain/cashValueLayers.ts';

function map(row: ValueLayerRow): ValueLayerReading {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    layer: row.layer as ValueLayer,
    status: row.status as LayerStatus,
    amountCents: row.amount_cents,
    currency: row.currency,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listValueLayers(projectId: string, opportunityId: string): Promise<ValueLayerReading[]> {
  const rows = await getDb().all<ValueLayerRow>(
    'SELECT * FROM cash_value_layers WHERE project_id = ? AND opportunity_id = ? ORDER BY layer',
    [projectId, opportunityId],
  );
  return rows.map(map);
}

/** Record one layer. Refuses a layer that breaks the rules rather than storing it. */
export async function recordValueLayer(
  projectId: string,
  opportunityId: string,
  input: LayerInput,
): Promise<ValueLayerReading> {
  const refusal = refuseLayer(input);
  if (refusal) throw new Error(refusal);
  const at = nowIso();
  await getDb().run(
    `INSERT INTO cash_value_layers
       (id, project_id, opportunity_id, layer, status, amount_cents, currency, source, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (opportunity_id, layer) DO UPDATE SET
       status = excluded.status, amount_cents = excluded.amount_cents, currency = excluded.currency,
       source = excluded.source, note = excluded.note, updated_at = excluded.updated_at`,
    [newId('cvl'), projectId, opportunityId, input.layer, input.status, input.amountCents ?? null,
      input.currency ?? null, input.source ?? null, input.note ?? null, at, at],
  );
  const found = (await listValueLayers(projectId, opportunityId)).find((r) => r.layer === input.layer);
  if (!found) throw new Error('The value layer disappeared immediately after being written.');
  return found;
}
