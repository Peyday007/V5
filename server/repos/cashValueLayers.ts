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

/**
 * The LEDGER layer, derived from the append-only money entries rather than
 * written by anybody: money agreed (less what was released) or received (less
 * refunds), whichever is larger so the same money is never counted twice.
 * Null when the opportunity has no entry, or its entries span currencies —
 * summing across currencies would invent a figure.
 */
async function derivedLedger(projectId: string, opportunityId: string): Promise<ValueLayerReading | null> {
  const rows = await getDb().all<{ kind: string; currency: string; total: number }>(
    `SELECT kind, currency, SUM(amount_cents) AS total FROM cash_money_entries
      WHERE project_id = ? AND opportunity_id = ?
        AND kind IN ('PIPELINE_AGREED', 'PIPELINE_RELEASED', 'CUSTOMER_PAYMENT', 'REFUND')
      GROUP BY kind, currency`,
    [projectId, opportunityId],
  );
  if (rows.length === 0) return null;
  const currencies = new Set(rows.map((row) => row.currency));
  if (currencies.size !== 1) return null;
  const sum = (kind: string): number => Number(rows.find((row) => row.kind === kind)?.total ?? 0);
  const agreed = Math.max(0, sum('PIPELINE_AGREED') - sum('PIPELINE_RELEASED'));
  const received = Math.max(0, sum('CUSTOMER_PAYMENT') - sum('REFUND'));
  const at = nowIso();
  return {
    id: `derived:ledger:${opportunityId}`,
    projectId,
    opportunityId,
    layer: 'LEDGER',
    status: 'VERIFIED',
    amountCents: Math.max(agreed, received),
    currency: [...currencies][0]!,
    source: 'cash money ledger',
    note: 'Derived from the append-only money entries; not stored here.',
    createdAt: at,
    updatedAt: at,
  };
}

export async function listValueLayers(projectId: string, opportunityId: string): Promise<ValueLayerReading[]> {
  const rows = await getDb().all<ValueLayerRow>(
    'SELECT * FROM cash_value_layers WHERE project_id = ? AND opportunity_id = ? ORDER BY layer',
    [projectId, opportunityId],
  );
  const stored = rows.map(map);
  // The ledger is the authority on money agreed or received, so its derived
  // reading replaces any stored LEDGER row: a hand-written one could only ever
  // disagree with the rows it summarises.
  const ledger = await derivedLedger(projectId, opportunityId);
  if (!ledger) return stored;
  return [...stored.filter((reading) => reading.layer !== 'LEDGER'), ledger];
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
