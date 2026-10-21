/**
 * The launch's rows (§74): one per qualified product Brain puts on sale, the
 * ad tests run for it, and the store orders it took.
 *
 * Every insert is idempotent by a unique index, and every state change is a
 * guarded UPDATE naming the state it moves from, so two ticks produce one
 * effect and the loser is an ordinary outcome.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';

export interface CommerceLaunch {
  id: string;
  projectId: string;
  productId: string;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  supplierName: string | null;
  supplierUnitCents: number | null;
  supplierShippingCents: number | null;
  supplierLogistic: string | null;
  supplierMaxDays: number | null;
  supplierImageUrl: string | null;
  matchedAt: string | null;
  priceCents: number | null;
  currency: string | null;
  storeProductId: string | null;
  storeVariantId: string | null;
  storeHandle: string | null;
  listedAt: string | null;
  publishedAt: string | null;
  problem: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AdTestState = 'PENDING' | 'RUNNING' | 'STOPPED' | 'ENDED' | 'UNCERTAIN';

export interface CommerceAdTest {
  id: string;
  projectId: string;
  launchId: string;
  round: number;
  commitmentId: string | null;
  dailyBudgetCents: number;
  days: number;
  campaignId: string | null;
  startedAt: string | null;
  endsAt: string | null;
  spendCents: number | null;
  state: AdTestState;
  outcome: 'WON' | 'LOST' | null;
  stopReason: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrderState = 'PAID' | 'ORDERED' | 'SHIPPED' | 'FULFILLED' | 'NEEDS_PERSON';

export interface CommerceOrder {
  id: string;
  projectId: string;
  launchId: string;
  storeOrderId: string;
  storeOrderName: string;
  quantity: number;
  amountCents: number;
  currency: string;
  paidAt: string;
  supplierOrderNumber: string;
  supplierOrderId: string | null;
  supplierCostCents: number | null;
  commitmentId: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  state: OrderState;
  problem: string | null;
  createdAt: string;
  updatedAt: string;
}

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function mapRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'seq') continue;
    out[camel(key)] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out as T;
}

/**
 * Write the named fields, guarded on the row still being in the state the
 * caller read. Returns whether a row changed.
 */
async function patch(
  table: string,
  id: string,
  fields: Record<string, unknown>,
  guard: Record<string, unknown> = {},
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries({ ...fields, updatedAt: nowIso() })) {
    sets.push(`${snake(key)} = ?`);
    values.push(value);
  }
  const where = ['id = ?'];
  values.push(id);
  for (const [key, value] of Object.entries(guard)) {
    if (value === null) where.push(`${snake(key)} IS NULL`);
    else {
      where.push(`${snake(key)} = ?`);
      values.push(value);
    }
  }
  const result = await getDb().run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, values as never[]);
  return result.changes > 0;
}

/* --------------------------------------------------------------------------
 * Launches
 * ------------------------------------------------------------------------ */

export async function ensureLaunch(input: { projectId: string; productId: string }): Promise<CommerceLaunch> {
  const now = nowIso();
  await getDb().run(
    `INSERT INTO commerce_launches (id, project_id, product_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('cln'), input.projectId, input.productId, now, now],
  );
  const row = await getDb().get<Record<string, unknown>>('SELECT * FROM commerce_launches WHERE product_id = ?', [
    input.productId,
  ]);
  if (!row) throw new Error('The launch disappeared immediately after being written.');
  return mapRow<CommerceLaunch>(row);
}

export async function getLaunch(id: string): Promise<CommerceLaunch | null> {
  const row = await getDb().get<Record<string, unknown>>('SELECT * FROM commerce_launches WHERE id = ?', [id]);
  return row ? mapRow<CommerceLaunch>(row) : null;
}

export async function listLaunches(projectId: string): Promise<CommerceLaunch[]> {
  const rows = await getDb().all<Record<string, unknown>>(
    'SELECT * FROM commerce_launches WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map((row) => mapRow<CommerceLaunch>(row));
}

export async function patchLaunch(
  id: string,
  fields: Partial<Omit<CommerceLaunch, 'id' | 'projectId' | 'productId' | 'createdAt' | 'updatedAt'>>,
  guard: Partial<CommerceLaunch> = {},
): Promise<boolean> {
  return await patch('commerce_launches', id, fields, guard);
}

/* --------------------------------------------------------------------------
 * Ad tests
 * ------------------------------------------------------------------------ */

export async function ensureAdTest(input: {
  projectId: string;
  launchId: string;
  round: number;
  dailyBudgetCents: number;
  days: number;
}): Promise<CommerceAdTest> {
  const now = nowIso();
  await getDb().run(
    `INSERT INTO commerce_ad_tests
       (id, project_id, launch_id, round, daily_budget_cents, days, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?) ON CONFLICT DO NOTHING`,
    [newId('cat'), input.projectId, input.launchId, input.round, input.dailyBudgetCents, input.days, now, now],
  );
  const row = await getDb().get<Record<string, unknown>>(
    'SELECT * FROM commerce_ad_tests WHERE launch_id = ? AND round = ?',
    [input.launchId, input.round],
  );
  if (!row) throw new Error('The ad test disappeared immediately after being written.');
  return mapRow<CommerceAdTest>(row);
}

export async function listAdTests(projectId: string): Promise<CommerceAdTest[]> {
  const rows = await getDb().all<Record<string, unknown>>(
    'SELECT * FROM commerce_ad_tests WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map((row) => mapRow<CommerceAdTest>(row));
}

export async function patchAdTest(
  id: string,
  fields: Partial<Omit<CommerceAdTest, 'id' | 'projectId' | 'launchId' | 'round' | 'createdAt' | 'updatedAt'>>,
  guard: Partial<CommerceAdTest> = {},
): Promise<boolean> {
  return await patch('commerce_ad_tests', id, fields, guard);
}

/* --------------------------------------------------------------------------
 * Orders
 * ------------------------------------------------------------------------ */

export async function recordStoreOrder(input: {
  projectId: string;
  launchId: string;
  storeOrderId: string;
  storeOrderName: string;
  quantity: number;
  amountCents: number;
  currency: string;
  paidAt: string;
}): Promise<{ order: CommerceOrder; created: boolean }> {
  const id = newId('cor');
  const now = nowIso();
  await getDb().run(
    `INSERT INTO commerce_orders
       (id, project_id, launch_id, store_order_id, store_order_name, quantity, amount_cents,
        currency, paid_at, supplier_order_number, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, ?) ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.launchId,
      input.storeOrderId,
      input.storeOrderName,
      input.quantity,
      input.amountCents,
      input.currency,
      input.paidAt,
      // Brain's own number for the supplier order: derived from this row's id,
      // so it is stable across every retry and unique by index.
      `BRN${id.replace(/[^A-Za-z0-9]/g, '').slice(-20)}`,
      now,
      now,
    ],
  );
  const row = await getDb().get<Record<string, unknown>>(
    'SELECT * FROM commerce_orders WHERE project_id = ? AND store_order_id = ?',
    [input.projectId, input.storeOrderId],
  );
  if (!row) throw new Error('The order disappeared immediately after being written.');
  const order = mapRow<CommerceOrder>(row);
  return { order, created: order.id === id };
}

export async function listOrders(projectId: string): Promise<CommerceOrder[]> {
  const rows = await getDb().all<Record<string, unknown>>(
    'SELECT * FROM commerce_orders WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map((row) => mapRow<CommerceOrder>(row));
}

export async function patchOrder(
  id: string,
  fields: Partial<Omit<CommerceOrder, 'id' | 'projectId' | 'launchId' | 'storeOrderId' | 'createdAt' | 'updatedAt'>>,
  guard: Partial<CommerceOrder> = {},
): Promise<boolean> {
  return await patch('commerce_orders', id, fields, guard);
}
