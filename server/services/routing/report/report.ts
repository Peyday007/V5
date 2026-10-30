/**
 * The savings-and-quality report: which resource ran each unit of work, what it
 * cost in premium jobs, what failed and why, and what the output was worth.
 *
 * Read-only. `buildReport` is pure over rows already read, so what it printed
 * is answerable from its input. A figure Brain cannot measure is `UNKNOWN`,
 * never zero: nothing here invents an allowance, a usage number or a saving.
 * Counts are broken out per kind of work, because a total over unlike
 * workloads compares nothing with nothing. The stored baseline is a replay of a
 * fixed workload and the live rows are production, so they are printed beside
 * each other and never subtracted.
 */
import { getDb } from '../../../db/database.ts';
import { listDecisions, type RoutingDecision, type RoutingResource } from '../../../repos/workRouting.ts';
import { readBaseline, type BaselineReadings } from '../baseline/index.ts';

export const UNKNOWN = 'UNKNOWN' as const;
export type Measured<T> = T | typeof UNKNOWN;

export interface ProviderReading {
  model: string;
  calls: number;
  valid: number;
  /** valid / calls, or UNKNOWN below one call. */
  reliability: Measured<number>;
}

export interface QualityReading {
  claimsGated: number;
  accepted: number;
  rejected: number;
  /** accepted / gated, or UNKNOWN when nothing was gated in the window. */
  verificationPassRate: Measured<number>;
}

export interface KindReport {
  workKind: string;
  decisions: number;
  byResource: Record<RoutingResource, number>;
  reused: number;
  prevented: number;
  escalations: number;
  failuresByCause: Record<string, number>;
  validated: number;
  settled: number;
}

export interface RoutingReport {
  projectId: string;
  since: string | null;
  decisions: number;
  /** Jobs each resource ran, over every kind of work. */
  totals: { code: number; cheap: number; claude: number; reused: number; prevented: number; escalations: number };
  failuresByCause: Record<string, number>;
  kinds: KindReport[];
  providers: ProviderReading[];
  quality: QualityReading;
  /** Claude jobs the ledger records. What the allowance consumed is not visible from here. */
  premiumJobs: number;
  premiumAllowanceUsed: typeof UNKNOWN;
  baseline: { label: string; takenAt: string; readings: BaselineReadings } | null;
  unknown: string[];
}

export interface ReportInput {
  projectId: string;
  since: string | null;
  decisions: RoutingDecision[];
  providers: ProviderReading[];
  quality: QualityReading;
  baseline: RoutingReport['baseline'];
}

const emptyResources = (): Record<RoutingResource, number> => ({ CODE: 0, CHEAP: 0, STRONG: 0 });
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

export function buildReport(input: ReportInput): RoutingReport {
  const kinds = new Map<string, KindReport>();
  const failuresByCause: Record<string, number> = {};
  const totals = { code: 0, cheap: 0, claude: 0, reused: 0, prevented: 0, escalations: 0 };

  for (const d of input.decisions) {
    let k = kinds.get(d.workKind);
    if (!k) {
      k = { workKind: d.workKind, decisions: 0, byResource: emptyResources(), reused: 0, prevented: 0, escalations: 0, failuresByCause: {}, validated: 0, settled: 0 };
      kinds.set(d.workKind, k);
    }
    k.decisions += 1;
    k.byResource[d.resource] += 1;
    if (d.resource === 'CODE') totals.code += 1;
    else if (d.resource === 'CHEAP') totals.cheap += 1;
    else totals.claude += 1;
    if (d.reusedResultId) { k.reused += 1; totals.reused += 1; }
    if (d.outcome === 'PREVENTED') { k.prevented += 1; totals.prevented += 1; }
    if (d.escalatedFrom) { k.escalations += 1; totals.escalations += 1; }
    if (d.failureClass) { bump(k.failuresByCause, d.failureClass); bump(failuresByCause, d.failureClass); }
    if (d.outcome) k.settled += 1;
    if (d.validationResult === 'PASS') k.validated += 1;
  }

  const unknown = [
    'Premium allowance consumed: Brain cannot read a Claude subscription balance; only jobs the ledger records are counted.',
    'Jobs never recorded in the routing ledger are not counted anywhere; the ledger starts when routing was first recorded.',
  ];
  if (input.decisions.length === 0) unknown.push('No routing decision is recorded in this window, so no resource count is measured.');
  if (input.quality.verificationPassRate === UNKNOWN) unknown.push('Verification pass rate: no claim was gated in this window.');
  if (!input.baseline) unknown.push('No stored baseline for this project: nothing to print beside the live figures.');

  return {
    projectId: input.projectId, since: input.since, decisions: input.decisions.length, totals,
    failuresByCause, kinds: [...kinds.values()].sort((a, b) => a.workKind.localeCompare(b.workKind)),
    providers: input.providers, quality: input.quality, premiumJobs: totals.claude,
    premiumAllowanceUsed: UNKNOWN, baseline: input.baseline, unknown,
  };
}

/** Pass rate over claims the gate decided; UNKNOWN rather than 0 when none were. */
export function passRate(accepted: number, gated: number): Measured<number> {
  return gated > 0 ? accepted / gated : UNKNOWN;
}

export async function readRoutingReport(projectId: string, opts: { baselineLabel?: string; limit?: number } = {}): Promise<RoutingReport> {
  const db = getDb();
  let baseline: RoutingReport['baseline'] = null;
  if (opts.baselineLabel) {
    const b = await readBaseline(projectId, opts.baselineLabel);
    if (b) baseline = { label: opts.baselineLabel, takenAt: b.takenAt, readings: b.readings };
  }
  const since = baseline?.takenAt ?? null;
  const decisions = (await listDecisions(projectId, { limit: opts.limit ?? 5000 }))
    .filter((d) => since === null || d.createdAt >= since);

  const claimRows = await db.all<{ accepted: number; n: number }>(
    `SELECT c.accepted AS accepted, COUNT(*) AS n
       FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id
      WHERE o.project_id = ? ${since ? 'AND c.created_at >= ?' : ''}
      GROUP BY c.accepted`,
    since ? [projectId, since] : [projectId],
  );
  let accepted = 0; let rejected = 0;
  for (const r of claimRows) { if (Number(r.accepted) === 1) accepted += Number(r.n); else rejected += Number(r.n); }

  // Free-model results are keyed by model, not project: provider reliability is a fact about the provider.
  const providerRows = await db.all<{ model: string; calls: number; valid: number }>(
    `SELECT model, COUNT(*) AS calls, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS valid
       FROM cheap_results ${since ? 'WHERE created_at >= ?' : ''} GROUP BY model ORDER BY model`,
    since ? [since] : [],
  );
  const providers: ProviderReading[] = providerRows.map((p) => {
    const calls = Number(p.calls); const valid = Number(p.valid ?? 0);
    return { model: p.model, calls, valid, reliability: calls > 0 ? valid / calls : UNKNOWN };
  });

  return buildReport({
    projectId, since, decisions, providers, baseline,
    quality: { claimsGated: accepted + rejected, accepted, rejected, verificationPassRate: passRate(accepted, accepted + rejected) },
  });
}

const pct = (v: Measured<number>): string => (v === UNKNOWN ? UNKNOWN : `${(v * 100).toFixed(1)}%`);

export function formatReport(r: RoutingReport): string {
  const lines: string[] = [];
  lines.push(`project ${r.projectId}  window ${r.since ?? 'all recorded'} -> now  decisions ${r.decisions}`);
  lines.push('');
  lines.push('RESOURCE   code-only ' + r.totals.code + '   free-AI ' + r.totals.cheap + '   claude ' + r.totals.claude +
    '   reused ' + r.totals.reused + '   prevented ' + r.totals.prevented + '   escalations ' + r.totals.escalations);
  lines.push(`PREMIUM    claude jobs recorded ${r.premiumJobs}   allowance consumed ${r.premiumAllowanceUsed}`);
  lines.push(`QUALITY    verification pass rate ${pct(r.quality.verificationPassRate)}   gate rejections ${r.quality.rejected} of ${r.quality.claimsGated} claims gated`);
  lines.push('FAILURES   ' + (Object.keys(r.failuresByCause).length
    ? Object.entries(r.failuresByCause).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join('   ')
    : 'none recorded'));
  lines.push('');
  lines.push('BY KIND OF WORK (like-for-like only)');
  if (r.kinds.length === 0) lines.push('  none recorded');
  for (const k of r.kinds) {
    lines.push(`  ${k.workKind.padEnd(28)} code ${k.byResource.CODE}  free-AI ${k.byResource.CHEAP}  claude ${k.byResource.STRONG}` +
      `  reused ${k.reused}  prevented ${k.prevented}  escalated ${k.escalations}  validated ${k.validated}/${k.settled} settled`);
  }
  lines.push('');
  lines.push('PROVIDER RELIABILITY (free lane, valid answers / calls)');
  if (r.providers.length === 0) lines.push('  no free-model call recorded');
  for (const p of r.providers) lines.push(`  ${p.model.padEnd(28)} ${p.valid}/${p.calls}  ${pct(p.reliability)}`);
  lines.push('');
  if (r.baseline) {
    const b = r.baseline.readings;
    lines.push(`BASELINE ${r.baseline.label} (stored replay of ${b.workload.items} items, taken ${r.baseline.takenAt}; a replay, not production, so not subtracted from the live figures)`);
    lines.push(`  code covered ${b.codeCovered}   cheap calls ${b.cheapCalls}   valid ${b.cheapValidAnswers}   failed ${b.cheapFailedAnswers}   premium jobs ${b.premiumJobsLaunched}`);
  } else {
    lines.push('BASELINE none stored for this project');
  }
  lines.push('');
  lines.push('UNKNOWN / NOT MEASURED');
  for (const u of r.unknown) lines.push(`  - ${u}`);
  return lines.join('\n') + '\n';
}
