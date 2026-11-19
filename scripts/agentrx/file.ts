/**
 * File AgentRx findings into Hermes' inventory through its own owner,
 * `upsertInventory` (server/services/operator/inventory.ts): the same write
 * `brain_operator_inventory` makes, recorded with its history, read by
 * `inventoryDeficiencies` on Hermes' next run. Nothing else is written.
 *
 * Runs inside the Brain over `flyctl ssh` (.github/workflows/agentrx.yml):
 *
 *   node --import tsx scripts/agentrx/file.ts --findings <base64 JSON array>
 *
 * Prints one `AGENTRX_FILED <json>` line per finding, then `AGENTRX: OK`.
 */
import { closeDatabase, initDatabase } from '../../server/db/database.ts';
import { getInventoryItem, listInventory, upsertInventory } from '../../server/services/operator/inventory.ts';
import { planFiling, type AgentRxFinding } from './filing.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--findings');
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (!raw) throw new Error('--findings <base64 JSON array> is required');
  const findings = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as AgentRxFinding[];
  await initDatabase();
  try {
    for (const f of findings) {
      const item = await getInventoryItem(f.id);
      const updatedAt = item ? ((await listInventory()).find((x) => x.id === item.id)?.updatedAt ?? null) : null;
      const plan = planFiling(item ? { ...item, updatedAt } : null, f);
      const result = await upsertInventory(plan, { runId: null, actor: 'agentrx' });
      console.log(`AGENTRX_FILED ${JSON.stringify({ id: f.id, confidence: f.confidence, status: plan.status ?? item?.status ?? 'DISCOVERED', result })}`);
    }
  } finally {
    await closeDatabase();
    console.log('AGENTRX: OK');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
