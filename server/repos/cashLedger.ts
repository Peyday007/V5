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
import crypto from 'node:crypto';
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
    commitmentId: row.commitment_id,
    idempotencyKey: row.idempotency_key,
    payloadFingerprint: row.payload_fingerprint,
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

export interface MoneyWrite {
  projectId: string;
  opportunityId?: string | null;
  commitmentId?: string | null;
  kind: CashMoneyKind;
  amountCents: number;
  currency: string;
  verifiedReference?: string | null;
  fundsAvailableAt?: string | null;
  occurredAt?: string;
  note?: string | null;
  recordedBy: string;
  /**
   * What names this operation, scoped to the project by the index.
   *
   * Required of everything that reaches this, because without one a retry after
   * a lost response records the money twice — a retried $750 settlement
   * reported $1,500, which is §20's rule unapplied at the one table where the
   * consequence is money.
   */
  idempotencyKey: string;
}

export interface MoneyOutcome {
  ok: boolean;
  entry: CashMoneyEntry | null;
  /** Safe to show a person. */
  reason: string;
  /** True when this call collided with an equivalent one already written. */
  replayed: boolean;
}

/**
 * What identifies this operation, from its inputs alone.
 *
 * Outputs are deliberately absent — §20's rule that inputs identify an
 * operation and outputs do not — and so is the clock, because a fingerprint
 * over `occurredAt` would make every retry a different operation and the key
 * would protect nothing.
 */
export function moneyFingerprint(input: {
  kind: CashMoneyKind;
  amountCents: number;
  currency: string;
  opportunityId?: string | null;
  commitmentId?: string | null;
  verifiedReference?: string | null;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        input.kind,
        String(Math.max(0, Math.trunc(input.amountCents))),
        input.currency,
        input.opportunityId ?? '',
        input.commitmentId ?? '',
        input.verifiedReference ?? '',
      ].join('\u0000'),
      'utf8',
    )
    .digest('hex');
}

/**
 * Write one money event, exactly once per key.
 *
 * `ON CONFLICT DO NOTHING` on `(project_id, idempotency_key)`, then read back:
 * a repeat of the same operation replays the row it collided with, and a key
 * that comes back carrying a **different payload** is refused rather than
 * silently replayed as the first one. Ignoring that difference would let a key
 * become a way to overwrite an amount; replaying it as the original would tell
 * a caller their $900 was recorded when $750 was.
 */
export async function recordMoney(input: MoneyWrite): Promise<MoneyOutcome> {
  const id = newId('cme');
  const at = ledgerNow();
  const fingerprint = moneyFingerprint(input);

  await getDb().run(
    `INSERT INTO cash_money_entries
       (id, project_id, opportunity_id, commitment_id, idempotency_key, payload_fingerprint,
        kind, amount_cents, currency,
        verified_reference, funds_available_at, occurred_at, note, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, idempotency_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId ?? null,
      input.commitmentId ?? null,
      input.idempotencyKey,
      fingerprint,
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

  const existing = (
    await getDb().all<CashMoneyEntryRow>(
      'SELECT * FROM cash_money_entries WHERE project_id = ? AND idempotency_key = ?',
      [input.projectId, input.idempotencyKey],
    )
  )[0];
  if (!existing) {
    return { ok: false, entry: null, reason: 'the money entry could not be written', replayed: false };
  }
  if (existing.id === id) {
    return { ok: true, entry: mapEntry(existing), reason: 'recorded', replayed: false };
  }
  if (existing.payload_fingerprint !== fingerprint) {
    return {
      ok: false,
      entry: null,
      reason:
        'that key has already recorded a different entry in this account. A key names one ' +
        'operation; reusing it for another is a new operation and needs its own key.',
      replayed: false,
    };
  }
  return { ok: true, entry: mapEntry(existing), reason: 'already recorded', replayed: true };
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
  currency?: string;
  limit?: number;
}): Promise<CashMoneyEntry[]> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  if (input.currency) {
    where.push('currency = ?');
    params.push(input.currency);
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
  /**
   * The sprint's own currency.
   *
   * Filtered in the query rather than trusted to every writer refusing a
   * mismatch, because the figure this feeds carries a single currency label:
   * without it a USD and a EUR entry are added as if interchangeable, and the
   * label makes the result look checked.
   */
  currency?: string;
}): Promise<Record<CashMoneyKind, number>> {
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  if (input.currency) {
    where.push('currency = ?');
    params.push(input.currency);
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
