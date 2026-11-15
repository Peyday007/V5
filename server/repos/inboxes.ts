/**
 * Inbox procurement's rows (§110, migration 149). Append-only: nothing here
 * updates or deletes, and no balance is stored — `inboxBudget` derives it.
 */
import { getDb } from '../db/database.ts';
import type { InboxFundRow, InboxPurchaseOutcomeRow, InboxPurchaseRow } from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

export type InboxProvider = 'INSTANTLY' | 'INBOXKIT';
export type InboxKind = 'PREWARMED' | 'NEW';
export type InboxOutcome = 'PLACED' | 'REFUSED' | 'UNKNOWN' | 'WARMUP_ENABLED';

export interface InboxPurchase {
  id: string;
  purchaseKey: string;
  provider: InboxProvider;
  kind: InboxKind;
  domain: string;
  mailboxes: number;
  upfrontCents: number;
  monthlyCents: number;
  quote: Record<string, unknown>;
  actor: string;
  createdAt: string;
  /** The latest outcome that says whether the order happened; null while it is being placed. */
  state: 'PLACED' | 'REFUSED' | 'UNKNOWN' | null;
  warmupEnabled: boolean;
  detail: string | null;
}

export async function addInboxFunds(input: { kind: 'ADD_FUNDS' | 'SET_MONTHLY_CEILING'; amountCents: number; actor: string; note?: string | null }): Promise<void> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw new Error('An amount is a whole, non-negative number of cents.');
  await getDb().run(
    'INSERT INTO inbox_funds (id, kind, amount_cents, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('if'), input.kind, input.amountCents, input.actor, input.note ?? null, nowIso()],
  );
}

export async function inboxFunds(): Promise<{ fundedCents: number; monthlyCeilingCents: number }> {
  const rows = await getDb().all<InboxFundRow>('SELECT * FROM inbox_funds ORDER BY created_at, id');
  let fundedCents = 0;
  let monthlyCeilingCents = 0;
  for (const row of rows) {
    if (row.kind === 'ADD_FUNDS') fundedCents += Number(row.amount_cents);
    else monthlyCeilingCents = Number(row.amount_cents);
  }
  return { fundedCents, monthlyCeilingCents };
}

/**
 * Record an order before it is placed. Returns null when this key already has
 * a row: that order was attempted before, and is never attempted again.
 */
export async function recordInboxPurchase(input: Omit<InboxPurchase, 'id' | 'createdAt' | 'state' | 'warmupEnabled' | 'detail'>): Promise<InboxPurchase | null> {
  const id = newId('ip');
  const result = await getDb().run(
    `INSERT INTO inbox_purchases (id, purchase_key, provider, kind, domain, mailboxes, upfront_cents, monthly_cents, quote, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (purchase_key) DO NOTHING`,
    [id, input.purchaseKey, input.provider, input.kind, input.domain, input.mailboxes, input.upfrontCents, input.monthlyCents, toJson(input.quote), input.actor, nowIso()],
  );
  if (result.changes === 0) return null;
  return (await inboxPurchases()).find((one) => one.id === id) ?? null;
}

export async function recordInboxOutcome(purchaseId: string, outcome: InboxOutcome, detail: string, receipt: Record<string, unknown> = {}): Promise<void> {
  await getDb().run(
    'INSERT INTO inbox_purchase_outcomes (id, purchase_id, outcome, detail, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('io'), purchaseId, outcome, detail, toJson(receipt), nowIso()],
  );
}

export async function inboxPurchases(): Promise<InboxPurchase[]> {
  const db = getDb();
  const rows = await db.all<InboxPurchaseRow>('SELECT * FROM inbox_purchases ORDER BY created_at, id');
  const outcomes = await db.all<InboxPurchaseOutcomeRow>('SELECT * FROM inbox_purchase_outcomes ORDER BY created_at, id');
  return rows.map((row) => {
    const mine = outcomes.filter((one) => one.purchase_id === row.id);
    const decisive = mine.filter((one) => one.outcome !== 'WARMUP_ENABLED').at(-1);
    return {
      id: row.id,
      purchaseKey: row.purchase_key,
      provider: row.provider as InboxProvider,
      kind: row.kind as InboxKind,
      domain: row.domain,
      mailboxes: Number(row.mailboxes),
      upfrontCents: Number(row.upfront_cents),
      monthlyCents: Number(row.monthly_cents),
      quote: parseJson<Record<string, unknown>>(row.quote, {}),
      actor: row.actor,
      createdAt: row.created_at,
      state: (decisive?.outcome as InboxPurchase['state']) ?? null,
      warmupEnabled: mine.some((one) => one.outcome === 'WARMUP_ENABLED'),
      detail: decisive?.detail ?? null,
    };
  });
}
