/**
 * The production check for GOV-22-1: readiness kept apart from urgency, and a
 * prepared requirement promoted from a measured blocker and demoted when its
 * need vanishes — read from production rows, never asserted.
 *
 * `priority.ts` decides (pure). This module reads the rows it decides over and
 * registers the program's fixed check, `probe r01.gov-22-1`, in the probe
 * registry the program coordinator runs (`factory/program/probes.ts`). It is
 * imported for that effect by `tick.ts`, which the server loads, so the probe
 * exists in the same process `runRequirementChecks` asks.
 *
 *  - Capability records are the architecture program's own requirements:
 *    status from the coordinator's derived reading, `prepared` from the
 *    installed map, prerequisites met only when every requirement it depends on
 *    reads PRODUCTION_VERIFIED. What no row states (need, costs, uncertainty)
 *    stays null, which never promotes and never demotes.
 *  - Blocked transactions are the untriggered `cash_reopen_conditions` whose
 *    blocker names a program requirement (`CAPABILITY:<requirement key>`): an
 *    opportunity a person or Brain set aside because that capability is
 *    missing. Its value is the opportunity's stated price, or null.
 *
 * The check passes only when production rows actually produced a promotion
 * from measured blockers or a demotion of a vanished need. A program whose
 * prepared requirements nothing has yet blocked answers false and says so: a
 * mechanism no row has exercised is not demonstrated (§37).
 */
import { registerProbe, type ProbeResult } from '../factory/program/probes.ts';
import { reconcileCapabilities, type BlockedTransactionRow, type CapabilityReconciliation, type CapabilityRecordRow } from './priority.ts';
import type { RequirementMap, RequirementStatus } from '../../domain/factoryProgram.ts';

export const GOV_22_1_PROBE = 'r01.gov-22-1';

/** Capability records from the map and each requirement's derived status. Pure. */
export function capabilityRecordsFrom(map: RequirementMap, statuses: ReadonlyMap<string, RequirementStatus>): CapabilityRecordRow[] {
  return map.requirements.map((r) => {
    const deps = r.dependsOn ?? [];
    const prerequisitesMet = deps.every((d) => statuses.get(d) === 'PRODUCTION_VERIFIED');
    return {
      id: r.key,
      status: statuses.get(r.key) ?? 'SPECIFIED',
      prepared: r.prepared === true,
      prerequisitesMet,
      needStillExists: null,
      dueAt: null,
      workaroundCostCents: null,
      buildCostCents: null,
      interfaceChanged: null,
      otherBeneficiaries: null,
      uncertainty: null,
      opportunityCostCents: null,
    };
  });
}

/** Blocked transactions from reopen-condition rows naming a requirement key. Pure. */
export function blockedTransactionsFrom(
  rows: readonly { opportunity_id: string; project_id: string; blocker_key: string; price_cents: number | null }[],
  requirementKeys: ReadonlySet<string>,
): BlockedTransactionRow[] {
  const out: BlockedTransactionRow[] = [];
  for (const row of rows) {
    if (!row.blocker_key.startsWith('CAPABILITY:')) continue;
    const key = row.blocker_key.slice('CAPABILITY:'.length);
    if (!requirementKeys.has(key)) continue;
    out.push({ transactionId: row.opportunity_id, capabilityId: key, valueCents: typeof row.price_cents === 'number' ? row.price_cents : null, businessKey: row.project_id });
  }
  return out;
}

/** What the probe answers, from a reconciliation over production rows. Pure. */
export function judgeReconciliation(
  where: string,
  records: readonly CapabilityRecordRow[],
  blocked: readonly BlockedTransactionRow[],
  result: CapabilityReconciliation,
): ProbeResult {
  const prepared = records.filter((r) => r.prepared).length;
  const measured = result.promotions.filter((p) => p.decision.evidence.length > 0);
  const counts = `${records.length} requirement(s), ${prepared} prepared, ${blocked.length} blocked transaction(s) naming a requirement`;
  if (measured.length === 0 && result.demotions.length === 0) {
    return { ok: false, detail: `${where}: ${counts}; no production row has yet promoted a prepared requirement from a measured blocker or demoted a vanished need` };
  }
  const first = measured[0];
  return {
    ok: true,
    detail: `${where}: ${counts}; ${measured.length} promotion(s) from measured blockers${first ? ` (e.g. ${first.id}: ${first.decision.evidence.join('; ')})` : ''}, ${result.demotions.length} demotion(s) with the requirement retained`,
  };
}

/** Read the rows and reconcile. Never throws: an unreadable side is a failure that names it. */
export async function capabilityReconciliationOnProduction(): Promise<ProbeResult> {
  try {
    const { getDb } = await import('../../db/database.ts');
    const { getMap, getProgram } = await import('../../repos/factoryProgram.ts');
    const { ARCHITECTURE_PROGRAM_KEY } = await import('../factory/program/probes.ts');
    const row = await getDb().get<{ id: string }>(`SELECT id FROM factory_programs WHERE submission_key = ? ORDER BY created_at LIMIT 1`, [ARCHITECTURE_PROGRAM_KEY]);
    const program = row ? await getProgram(row.id) : null;
    if (!program) return { ok: false, detail: `no program filed under "${ARCHITECTURE_PROGRAM_KEY}"` };
    const map = await getMap(program.id);
    if (!map) return { ok: false, detail: `program ${program.id} has no installed map` };
    const { readProgram } = await import('../factory/program/coordinator.ts');
    const { productionPorts } = await import('../factory/program/ports.ts');
    const reading = await readProgram(program.id, productionPorts());
    const statuses = new Map(reading.requirements.map((r) => [r.key, r.status] as const));
    const records = capabilityRecordsFrom(map.map, statuses);
    const conditions = await getDb().all<{ opportunity_id: string; project_id: string; blocker_key: string; price_cents: number | null }>(
      `SELECT c.opportunity_id, c.project_id, c.blocker_key, o.price_cents
         FROM cash_reopen_conditions c LEFT JOIN cash_opportunities o ON o.id = c.opportunity_id
        WHERE c.triggered_at IS NULL AND c.blocker_key LIKE ?`,
      ['CAPABILITY:%'],
    );
    const blocked = blockedTransactionsFrom(conditions, new Set(records.map((r) => r.id)));
    const result = reconcileCapabilities(records, blocked, { parallelWorkers: null });
    return judgeReconciliation(`program ${program.id} map v${map.version}`, records, blocked, result);
  } catch (error) {
    return { ok: false, detail: `the capability reconciliation could not be read: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` };
  }
}

registerProbe(GOV_22_1_PROBE, capabilityReconciliationOnProduction);
