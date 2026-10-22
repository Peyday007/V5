/**
 * Live bins whose completion contract no longer has an evaluator, retired.
 *
 * `evaluateContract` refuses every bin whose contract has no evaluator, so such
 * a bin can be fired, leased and worked on and can never finish — every
 * activation spent on it is spent for nothing. That happens when a contract is
 * removed from the code while bins under it are still queued. This pass reads
 * the rows and retires each one through `retireBin`, which fences any live
 * lease, keeps every event and unit result, and records why (§5).
 *
 * Derived on every tick and idempotent: a retired bin is terminal, so the next
 * tick finds nothing.
 */
import { getDb } from '../../db/database.ts';
import { getBin, retireBin } from '../../repos/bins.ts';
import { hasEvaluator } from './contracts.ts';

export const UNJUDGEABLE_BIN_REASON =
  'Its completion contract has no evaluator in this version of Brain, so it could never be judged ' +
  'complete; retired rather than fired again.';

export async function retireUnjudgeableBins(limit = 200): Promise<string[]> {
  const rows = await getDb().all<{ completion_contract: string }>(
    `SELECT DISTINCT completion_contract FROM bins
      WHERE state NOT IN ('COMPLETE', 'CANCELLED', 'FAILED')`,
  );
  const missing = rows.map((row) => row.completion_contract).filter((contract) => !hasEvaluator(contract));
  if (missing.length === 0) return [];
  const ids = await getDb().all<{ id: string }>(
    `SELECT id FROM bins
      WHERE state NOT IN ('COMPLETE', 'CANCELLED', 'FAILED')
        AND completion_contract IN (${missing.map(() => '?').join(', ')})
      ORDER BY id
      LIMIT ?`,
    [...missing, Math.max(1, limit)],
  );
  const out: string[] = [];
  for (const { id } of ids) {
    const bin = await getBin(id);
    if (!bin) continue;
    const retired = await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: 'BRAIN',
      reason: UNJUDGEABLE_BIN_REASON,
    });
    if (retired.ok) out.push(bin.id);
  }
  return out;
}
