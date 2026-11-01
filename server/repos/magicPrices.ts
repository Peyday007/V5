/**
 * Price snapshots per exact printing, in integer cents.
 *
 * A Scryfall price is an ESTIMATE and this repository will not store one as
 * CONFIRMED: only a price somebody entered with a shop or league source can be.
 * Snapshots are append-only; locking one marks it and never edits the figure.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { MagicPriceSnapshotRow, PriceStatus } from '../domain/magicTypes.ts';

export interface PriceSnapshot {
  id: string;
  ownerUserId: string | null;
  printingId: string;
  priceCents: number;
  status: PriceStatus;
  source: string;
  observedOn: string;
  locked: boolean;
  createdAt: string;
}

const map = (r: MagicPriceSnapshotRow): PriceSnapshot => ({
  id: r.id, ownerUserId: r.owner_user_id, printingId: r.printing_id, priceCents: Number(r.price_cents), status: r.status,
  source: r.source, observedOn: r.observed_on, locked: Number(r.locked) === 1, createdAt: r.created_at,
});

export class PriceRefused extends Error {}

export async function recordPriceSnapshot(input: {
  ownerUserId: string | null; printingId: string; priceCents: number; status: PriceStatus; source: string; observedOn: string; locked?: boolean;
}): Promise<PriceSnapshot> {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) throw new PriceRefused('A price is a whole number of cents, zero or more.');
  if (!input.source.trim()) throw new PriceRefused('A price needs a source.');
  if (!/^\d{4}-\d{2}-\d{2}/.test(input.observedOn)) throw new PriceRefused('A price needs the date it was observed.');
  if (input.status === 'CONFIRMED') {
    if (/scryfall/i.test(input.source)) throw new PriceRefused('A Scryfall price is an estimate, not a confirmed market price.');
    if (!input.ownerUserId) throw new PriceRefused('Only a person can confirm a price.');
  }
  const id = newId('mps');
  await getDb().run(
    `INSERT INTO magic_price_snapshots (id, owner_user_id, printing_id, price_cents, status, source, observed_on, locked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.ownerUserId, input.printingId, input.priceCents, input.status, input.source, input.observedOn, input.locked ? 1 : 0, nowIso()],
  );
  return map((await getDb().get<MagicPriceSnapshotRow>('SELECT * FROM magic_price_snapshots WHERE id = ?', [id]))!);
}

export async function lockPriceSnapshot(ownerUserId: string, id: string): Promise<boolean> {
  const r = await getDb().run('UPDATE magic_price_snapshots SET locked = 1 WHERE id = ? AND owner_user_id = ? AND locked = 0', [id, ownerUserId]);
  return r.changes === 1;
}

/** The owner's own newest snapshot for the printing; shared (null-owner) estimates are the fallback. */
export async function latestPrice(printingId: string, ownerUserId: string): Promise<PriceSnapshot | null> {
  const row = await getDb().get<MagicPriceSnapshotRow>(
    `SELECT * FROM magic_price_snapshots
      WHERE printing_id = ? AND (owner_user_id = ? OR owner_user_id IS NULL)
      ORDER BY CASE WHEN owner_user_id IS NULL THEN 1 ELSE 0 END, observed_on DESC, created_at DESC, id DESC
      LIMIT 1`,
    [printingId, ownerUserId],
  );
  return row ? map(row) : null;
}

export async function listPriceSnapshots(printingId: string, ownerUserId: string): Promise<PriceSnapshot[]> {
  const rows = await getDb().all<MagicPriceSnapshotRow>(
    `SELECT * FROM magic_price_snapshots WHERE printing_id = ? AND (owner_user_id = ? OR owner_user_id IS NULL)
      ORDER BY observed_on DESC, created_at DESC, id DESC`,
    [printingId, ownerUserId],
  );
  return rows.map(map);
}
