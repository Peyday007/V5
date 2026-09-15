/**
 * Money, as append-only rows.
 *
 * There is no balance column anywhere in Cash Mode. Every figure §5 asks for —
 * pipeline, customer payments, available funds, unpaid commitments and
 * reserves, deployable cash, completed contribution — is derived from these
 * entries by `services/cash/money.ts` and stored nowhere. A balance column
 * would be a second master for the same fact, and the one nobody reads is the
 * one that drifts: `bin_events` settled that argument for capacity and it is
 * the same argument here.
 *
 * **There is no update and no delete.** A correction is a new entry, which is
 * what "money events are append-only and reconciled with the provider's own
 * evidence" means in practice: a mistake stays visible beside the row that
 * fixes it, and a reconciliation against a bank statement has something to
 * reconcile against.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import type { CashMoneyEntry, CashMoneyEntryRow, CashMoneyKind } from '../domain/types.ts';

export function ledgerNow(): string {
  return nowIso();
}

function mapEntry(row: CashMoneyEntryRow): CashMoneyEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    kind: row.kind as CashMoneyKind,
    amountCents: row.amount_cents,
    currency: row.currency,
    verifiedReference: row.verified_reference,
    fundsAvailableAt: row.funds_available_at,
    occurredAt: row.occurred_at,
    note: row.note,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  };
}

export async function recordMoney(input: {
  projectId: string;
  opportunityId?: string | null;
  kind: CashMoneyKind;
  amountCents: number;
  currency: string;
  verifiedReference?: string | null;
  fundsAvailableAt?: string | null;
  occurredAt?: string;
  note?: string | null;
  recordedBy: string;
}): Promise<CashMoneyEntry> {
  const id = newId('cme');
  const at = ledgerNow();
  await getDb().run(
    `INSERT INTO cash_money_entries
       (id, project_id, opportunity_id, kind, amount_cents, currency,
        verified_reference, funds_available_at, occurred_at, note, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.opportunityId ?? null,
      input.kind,
      Math.max(0, Math.trunc(input.amountCents)),
      input.currency,
      input.verifiedReference ?? null,
      input.fundsAvailableAt ?? null,
      input.occurredAt ?? at,
      input.note ?? null,
      input.recordedBy,
      at,
    ],
  );
  const created = await getMoneyEntry(id);
  if (!created) throw new Error('The money entry disappeared immediately after being written.');
  return created;
}

export async function getMoneyEntry(id: string): Promise<CashMoneyEntry | null> {
  const rows = await getDb().all<CashMoneyEntryRow>(
    'SELECT * FROM cash_money_entries WHERE id = ?',
    [id],
  );
  return rows[0] ? mapEntry(rows[0]) : null;
}

export async function listMoneyEntries(input: {
  projectId: string;
  opportunityId?: string;
  limit?: number;
}): Promise<CashMoneyEntry[]> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  params.push(Math.max(1, Math.min(2000, input.limit ?? 500)));
  const rows = await getDb().all<CashMoneyEntryRow>(
    `SELECT * FROM cash_money_entries
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?`,
    params,
  );
  return rows.map(mapEntry);
}

/**
 * The totals per kind, summed in the database.
 *
 * One grouped query rather than a fetch-and-reduce, so a project with years of
 * entries costs the same as one with ten. The aggregate is named and the
 * grouping column is in the select list, which is what makes this statement
 * sayable in both dialects.
 */
export async function totalsByKind(input: {
  projectId: string;
  opportunityId?: string;
}): Promise<Record<CashMoneyKind, number>> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  const rows = await getDb().all<{ kind: string; total: number }>(
    `SELECT kind, COALESCE(SUM(amount_cents), 0) AS total
       FROM cash_money_entries
      WHERE ${where.join(' AND ')}
      GROUP BY kind
      ORDER BY kind ASC`,
    params,
  );
  const out = {} as Record<CashMoneyKind, number>;
  for (const row of rows) out[row.kind as CashMoneyKind] = Number(row.total ?? 0);
  return out;
}
