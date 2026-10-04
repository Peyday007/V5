/**
 * Invoices Brain issues, and what their providers say happened to the money.
 *
 * Every state change is a guarded `UPDATE` naming the state it moves from, so
 * two ticks reading one invoice produce one transition and an ordinary loser.
 * One agreed amount is one invoice: the UNIQUE index on
 * `(project_id, pipeline_entry_id)` decides that, not a check in code.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { CashInvoice, CashInvoiceRow, CashInvoiceState } from '../domain/types.ts';

function map(row: CashInvoiceRow): CashInvoice {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    pipelineEntryId: row.pipeline_entry_id,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    taxTreatment: row.tax_treatment,
    dueDate: row.due_date,
    description: row.description,
    provider: row.provider,
    state: row.state as CashInvoiceState,
    stateReason: row.state_reason,
    providerInvoiceId: row.provider_invoice_id,
    providerStatus: row.provider_status,
    providerNumber: row.provider_number,
    hostedUrl: row.hosted_url,
    paymentEntryId: row.payment_entry_id,
    settlementEntryId: row.settlement_entry_id,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    settledAt: row.settled_at,
    lastReadAt: row.last_read_at,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewInvoice {
  projectId: string;
  opportunityId: string;
  pipelineEntryId: string;
  amountCents: number;
  currency: string;
  customerName: string;
  customerEmail: string;
  taxTreatment: string;
  dueDate: string;
  description: string;
  requestedBy: string;
}

/** Insert once per agreed amount; a repeat returns the row already there. */
export async function draftInvoice(input: NewInvoice): Promise<{ invoice: CashInvoice; created: boolean }> {
  const id = newId('cin');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO cash_invoices
       (id, project_id, opportunity_id, pipeline_entry_id, amount_cents, currency,
        customer_name, customer_email, tax_treatment, due_date, description,
        state, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFTED', ?, ?, ?)
     ON CONFLICT (project_id, pipeline_entry_id) DO NOTHING`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.pipelineEntryId,
      input.amountCents,
      input.currency,
      input.customerName,
      input.customerEmail,
      input.taxTreatment,
      input.dueDate,
      input.description,
      input.requestedBy,
      at,
      at,
    ],
  );
  const row = (
    await getDb().all<CashInvoiceRow>(
      'SELECT * FROM cash_invoices WHERE project_id = ? AND pipeline_entry_id = ?',
      [input.projectId, input.pipelineEntryId],
    )
  )[0];
  if (!row) throw new Error('the invoice could not be written');
  return { invoice: map(row), created: row.id === id };
}

export async function getInvoice(id: string): Promise<CashInvoice | null> {
  const row = (await getDb().all<CashInvoiceRow>('SELECT * FROM cash_invoices WHERE id = ?', [id]))[0];
  return row ? map(row) : null;
}

export async function listInvoices(input: {
  projectId: string;
  states?: readonly CashInvoiceState[];
  opportunityId?: string;
}): Promise<CashInvoice[]> {
  const where = ['project_id = ?'];
  const params: (string | number)[] = [input.projectId];
  if (input.states && input.states.length > 0) {
    where.push(`state IN (${input.states.map(() => '?').join(', ')})`);
    params.push(...input.states);
  }
  if (input.opportunityId) {
    where.push('opportunity_id = ?');
    params.push(input.opportunityId);
  }
  const rows = await getDb().all<CashInvoiceRow>(
    `SELECT * FROM cash_invoices WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`,
    params,
  );
  return rows.map(map);
}

export interface InvoicePatch {
  provider?: string | null;
  stateReason?: string | null;
  providerInvoiceId?: string | null;
  providerStatus?: string | null;
  providerNumber?: string | null;
  hostedUrl?: string | null;
  paymentEntryId?: string | null;
  settlementEntryId?: string | null;
  issuedAt?: string | null;
  paidAt?: string | null;
  settledAt?: string | null;
  lastReadAt?: string | null;
}

const COLUMNS: Record<keyof InvoicePatch, string> = {
  provider: 'provider',
  stateReason: 'state_reason',
  providerInvoiceId: 'provider_invoice_id',
  providerStatus: 'provider_status',
  providerNumber: 'provider_number',
  hostedUrl: 'hosted_url',
  paymentEntryId: 'payment_entry_id',
  settlementEntryId: 'settlement_entry_id',
  issuedAt: 'issued_at',
  paidAt: 'paid_at',
  settledAt: 'settled_at',
  lastReadAt: 'last_read_at',
};

/**
 * Move an invoice from the state it was read in, and write what moved with it.
 *
 * Guarded on `from` in the statement that makes the change, so a second tick
 * holding the same reading matches nothing. `to` may equal `from` to record a
 * reading without a transition.
 */
export async function moveInvoice(input: {
  id: string;
  from: CashInvoiceState;
  to: CashInvoiceState;
  patch?: InvoicePatch;
}): Promise<boolean> {
  const sets = ['state = ?', 'updated_at = ?'];
  const params: (string | number | null)[] = [input.to, nowIso()];
  for (const [field, value] of Object.entries(input.patch ?? {})) {
    if (value === undefined) continue;
    sets.push(`${COLUMNS[field as keyof InvoicePatch]} = ?`);
    params.push(value as string | null);
  }
  params.push(input.id, input.from);
  const result = await getDb().run(
    `UPDATE cash_invoices SET ${sets.join(', ')} WHERE id = ? AND state = ?`,
    params,
  );
  return result.changes > 0;
}
