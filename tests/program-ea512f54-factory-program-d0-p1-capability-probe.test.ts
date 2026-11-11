/**
 * GOV-22-1's fixed check, `probe r01.gov-22-1`, is registered in the process
 * that runs program checks, and it answers from production rows: true only
 * when a prepared requirement was promoted from a measured blocker or a
 * vanished need was demoted, false (naming why) otherwise.
 */
import { describe, expect, it } from 'vitest';
import { getProbe } from '../server/services/factory/program/probes.ts';
import {
  blockedTransactionsFrom,
  capabilityRecordsFrom,
  GOV_22_1_PROBE,
  judgeReconciliation,
} from '../server/services/goals/capabilityProbe.ts';
import { reconcileCapabilities } from '../server/services/goals/priority.ts';
import type { RequirementMap, RequirementStatus } from '../server/domain/factoryProgram.ts';

const requirement = (key: string, over: Record<string, unknown> = {}) => ({ key, dependsOn: [], prepared: false, ...over });
const map = (reqs: ReturnType<typeof requirement>[]) => ({ requirements: reqs }) as unknown as RequirementMap;

describe('the probe is registered where checks run', () => {
  it('is registered once the goal tick module loads', async () => {
    await import('../server/services/goals/tick.ts');
    expect(GOV_22_1_PROBE).toBe('r01.gov-22-1');
    expect(getProbe('r01.gov-22-1')).toBeTypeOf('function');
  });
});

describe('records and blockers come from rows, unknowns stay unknown', () => {
  it('takes prepared from the map and prerequisites only from verified dependencies', () => {
    const statuses = new Map<string, RequirementStatus>([['A', 'PRODUCTION_VERIFIED'], ['B', 'SPECIFIED'], ['C', 'SPECIFIED']]);
    const records = capabilityRecordsFrom(map([requirement('A'), requirement('B', { prepared: true, dependsOn: ['A'] }), requirement('C', { prepared: true, dependsOn: ['B'] })]), statuses);
    expect(records.map((r) => [r.id, r.prepared, r.prerequisitesMet])).toEqual([['A', false, true], ['B', true, true], ['C', true, false]]);
    expect(records.every((r) => r.needStillExists === null && r.buildCostCents === null)).toBe(true);
  });

  it('keeps only reopen conditions that name a requirement key', () => {
    const rows = [
      { opportunity_id: 'o1', project_id: 'p1', blocker_key: 'CAPABILITY:B', price_cents: 50_000 },
      { opportunity_id: 'o2', project_id: 'p2', blocker_key: 'CAPABILITY:B', price_cents: null },
      { opportunity_id: 'o3', project_id: 'p1', blocker_key: 'CAPABILITY:SEND_A_MESSAGE', price_cents: 900 },
      { opportunity_id: 'o4', project_id: 'p1', blocker_key: 'SUPPLIER:x', price_cents: 900 },
    ];
    expect(blockedTransactionsFrom(rows, new Set(['A', 'B']))).toEqual([
      { transactionId: 'o1', capabilityId: 'B', valueCents: 50_000, businessKey: 'p1' },
      { transactionId: 'o2', capabilityId: 'B', valueCents: null, businessKey: 'p2' },
    ]);
  });
});

describe('what the probe answers', () => {
  const statuses = new Map<string, RequirementStatus>([['A', 'PRODUCTION_VERIFIED'], ['B', 'SPECIFIED']]);
  const records = capabilityRecordsFrom(map([requirement('A'), requirement('B', { prepared: true, dependsOn: ['A'] })]), statuses);

  it('fails, saying why, while no row has exercised promotion or demotion', () => {
    const answer = judgeReconciliation('program p', records, [], reconcileCapabilities(records, [], { parallelWorkers: null }));
    expect(answer.ok).toBe(false);
    expect(answer.detail).toMatch(/1 prepared, 0 blocked transaction/);
    expect(answer.detail).toMatch(/no production row has yet promoted/);
  });

  it('passes when blocked transactions in two businesses promote the prepared requirement, and names the evidence', () => {
    const blocked = blockedTransactionsFrom(
      [
        { opportunity_id: 'o1', project_id: 'p1', blocker_key: 'CAPABILITY:B', price_cents: 50_000 },
        { opportunity_id: 'o2', project_id: 'p2', blocker_key: 'CAPABILITY:B', price_cents: 20_000 },
      ],
      new Set(['A', 'B']),
    );
    const answer = judgeReconciliation('program p', records, blocked, reconcileCapabilities(records, blocked, { parallelWorkers: null }));
    expect(answer.ok).toBe(true);
    expect(answer.detail).toMatch(/1 promotion\(s\) from measured blockers \(e\.g\. B: 2 valued transactions blocked, 70000 cents in all; 2 businesses would use it\)/);
  });

  it('does not promote a prepared requirement whose prerequisites are not verified', () => {
    const unmet = capabilityRecordsFrom(map([requirement('A'), requirement('B', { prepared: true, dependsOn: ['A'] })]), new Map([['A', 'SPECIFIED'], ['B', 'SPECIFIED']]));
    const blocked = blockedTransactionsFrom(
      [
        { opportunity_id: 'o1', project_id: 'p1', blocker_key: 'CAPABILITY:B', price_cents: 50_000 },
        { opportunity_id: 'o2', project_id: 'p2', blocker_key: 'CAPABILITY:B', price_cents: 20_000 },
      ],
      new Set(['A', 'B']),
    );
    expect(judgeReconciliation('program p', unmet, blocked, reconcileCapabilities(unmet, blocked, { parallelWorkers: null })).ok).toBe(false);
  });
});
