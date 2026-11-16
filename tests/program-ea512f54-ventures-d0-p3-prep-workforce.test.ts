/**
 * VENT-24-3 — roles come from the labour map's HUMAN_REQUIRED tasks and
 * bottlenecks, are prepared and never filled, and stay dormant until an active
 * objective depends on them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveOrganization } from '../server/services/labor/organization.ts';
import type { TaskCoverage } from '../server/services/labor/map.ts';
import type { Bottleneck } from '../server/services/labor/view.ts';
import type { NecessityReading } from '../server/services/labor/necessity.ts';
import type { HumanNecessityReason, LaborMarketOption } from '../server/domain/types.ts';

function coverage(input: {
  id: string;
  workflow: string;
  output: string;
  verdict: NecessityReading['verdict'];
  reason?: HumanNecessityReason | null;
  capabilityId?: string | null;
  missing?: string | null;
  options?: Array<Partial<LaborMarketOption>>;
}): TaskCoverage {
  return {
    task: { id: input.id, projectId: 'p', workflowId: `wf-${input.workflow}`, name: input.id, output: input.output, origin: 'SEED', capabilityId: input.capabilityId ?? null, declaredByRef: null, retiredAt: null, retiredReason: null, createdAt: '', updatedAt: '' },
    workflow: { id: `wf-${input.workflow}`, projectId: 'p', name: input.workflow, description: null, origin: 'SEED', opportunityId: null, declaredByRef: null, retiredAt: null, retiredReason: null, createdAt: '', updatedAt: '' },
    path: `${input.workflow} / ${input.id}`,
    allocation: null,
    history: [],
    necessity: {
      taskId: input.id,
      verdict: input.verdict,
      reason: input.verdict === 'HUMAN_REQUIRED' ? (input.reason ?? null) : null,
      questions: [],
      blockers: input.missing ? [{ kind: 'CAPABILITY_MISSING', statement: 'missing', remedy: 'source it', capabilityId: input.missing }] : [],
      advantage: 'NOT_ESTABLISHED',
      capability: null,
      summary: `${input.id} reading`,
    },
    options: (input.options ?? []).map((one, i) => ({ id: `o-${input.id}-${i}`, projectId: 'p', taskId: input.id, channel: 'DOMESTIC_CONTRACTOR', jurisdiction: null, rateCents: null, rateBasis: null, statement: 's', sourceClaimId: `claim-${input.id}-${i}`, createdAt: '', updatedAt: '', ...one })),
    rounds: [],
    purposesAsked: new Set(),
    purposesOpen: new Set(),
    roundsByPurpose: { NECESSITY: 0, MARKET: 0, PRECEDENT: 0 },
    foundByPurpose: { NECESSITY: 0, MARKET: 0, PRECEDENT: 0 },
    lastAskedAt: null,
    lastSettledAt: null,
  } as TaskCoverage;
}

const machineOnly = [
  coverage({ id: 't-draft', workflow: 'Content pipeline', output: 'draft copy', verdict: 'BRAIN_DEFENSIBLE' }),
  coverage({ id: 't-qa', workflow: 'Content pipeline', output: 'checked copy', verdict: 'NOT_ESTABLISHED' }),
];

const expanding = [
  ...machineOnly,
  coverage({ id: 't-sign', workflow: 'Quality release', output: 'signed conformity declaration', verdict: 'HUMAN_REQUIRED', reason: 'ACCOUNTABILITY_LICENSING', capabilityId: 'cap-cert', options: [{ channel: 'LICENSED_PROFESSIONAL', rateCents: 15_000, rateBasis: 'PER_HOUR' }] }),
  coverage({ id: 't-audit', workflow: 'Quality release', output: 'annual audit sign-off', verdict: 'HUMAN_REQUIRED', reason: 'ACCOUNTABILITY_LICENSING', capabilityId: 'cap-cert', options: [{ channel: 'LICENSED_PROFESSIONAL', rateCents: 20_000, rateBasis: 'PER_HOUR' }] }),
  coverage({ id: 't-negotiate', workflow: 'Supplier deals', output: 'negotiated supply terms', verdict: 'HUMAN_REQUIRED', reason: 'HUMAN_INTERFACE' }),
  coverage({ id: 't-tooling', workflow: 'Production setup', output: 'calibrated tooling', verdict: 'NOT_ESTABLISHED', missing: 'cap-tooling' }),
  coverage({ id: 't-pack', workflow: 'Fulfilment', output: 'packed orders', verdict: 'HUMAN_REQUIRED', reason: 'PHYSICAL_EXECUTION' }),
];

const bottlenecks: Bottleneck[] = [{ kind: 'CAPABILITY_MISSING', tasks: 1, statement: 'no one holds tooling calibration', remedy: 'source it', capabilityId: 'cap-tooling' }];

describe('VENT-24-3 — roles are derived, never imposed', () => {
  it('a snapshot with no HUMAN_REQUIRED task and no bottleneck yields no roles', () => {
    const reading = deriveOrganization({ snapshot: { coverage: machineOnly }, bottlenecks: [] });
    expect(reading.roles).toEqual([]);
    expect(reading.state).toBe('DORMANT');
    expect(reading.capacityRequested).toBe(0);
  });

  it('groups uncovered tasks by responsibility, with function labels read from their own workflows', () => {
    const reading = deriveOrganization({ snapshot: { coverage: expanding }, bottlenecks, approvedContractors: [{ taskId: 't-pack', contractorRef: 'ctr-1', approvedByRef: 'person:owner' }] });
    const keys = reading.roles.map((one) => one.key);
    expect(keys).toEqual(['ACCOUNTABILITY_LICENSING:cap-cert', 'BOTTLENECK:cap-tooling', 'HUMAN_INTERFACE:wf-Supplier deals']);
    const cert = reading.roles.find((one) => one.key === 'ACCOUNTABILITY_LICENSING:cap-cert')!;
    expect(cert.taskAllocation).toEqual(['t-sign', 't-audit']);
    expect(cert.functions).toEqual(['Quality release']);
    expect(reading.roles.find((one) => one.capabilityId === 'cap-tooling')!.derivedFrom).toEqual(['bottleneck CAPABILITY_MISSING cap-tooling']);
    // Machine-coverable tasks never become a role.
    expect(reading.roles.flatMap((one) => one.taskAllocation)).not.toContain('t-draft');
    expect(reading.roles.flatMap((one) => one.taskAllocation)).not.toContain('t-qa');
  });
});

describe('VENT-24-3 — every role is prepared in full', () => {
  it('carries a specification, cost or withheld cost, sourcing, recruitment, evaluation, onboarding, allocation and accountability', () => {
    const reading = deriveOrganization({ snapshot: { coverage: expanding }, bottlenecks });
    for (const role of reading.roles) {
      expect(role.specification.outputs.length, role.key).toBeGreaterThan(0);
      expect(role.recruitment.length, role.key).toBeGreaterThan(0);
      expect(role.evaluationCriteria.length, role.key).toBeGreaterThan(0);
      expect(role.onboarding.length, role.key).toBeGreaterThan(0);
      expect(role.taskAllocation.length, role.key).toBeGreaterThan(0);
      expect(role.accountability.length, role.key).toBeGreaterThan(0);
      expect(role.cost === null ? role.unpricedTaskIds.length > 0 : role.unpricedTaskIds.length === 0, role.key).toBe(true);
    }
    const cert = reading.roles.find((one) => one.key === 'ACCOUNTABILITY_LICENSING:cap-cert')!;
    expect(cert.cost).toEqual({ rates: [{ basis: 'PER_HOUR', lowCents: 15_000, highCents: 20_000 }], unpricedTaskIds: [] });
    expect(cert.sourcing.map((one) => one.channel)).toEqual(['LICENSED_PROFESSIONAL', 'LICENSED_PROFESSIONAL']);
    // An unpriced task withholds the cost and is named, never read as free.
    const negotiate = reading.roles.find((one) => one.key.startsWith('HUMAN_INTERFACE'))!;
    expect(negotiate.cost).toBeNull();
    expect(negotiate.unpricedTaskIds).toEqual(['t-negotiate']);
  });
});

describe('VENT-24-3 — authority stays with a person', () => {
  it('hiring, offers, candidate data, paid recruiters and agreements are always REQUIRES_AUTHORIZATION', () => {
    const reading = deriveOrganization({ snapshot: { coverage: expanding }, bottlenecks, activeObjectives: [{ id: 'goal-1', taskIds: ['t-sign'] }] });
    for (const role of reading.roles) {
      const gated = role.recruitment.filter((one) => one.status === 'REQUIRES_AUTHORIZATION').map((one) => one.action).sort();
      expect(gated, role.key).toEqual(['BINDING_OFFER', 'ENGAGE_PAID_RECRUITER', 'HIRE_EMPLOYEE', 'SHARE_CANDIDATE_DATA', 'SIGN_AGREEMENT']);
      expect(role.recruitment.filter((one) => one.status === 'PREPARE').every((one) => one.action === null)).toBe(true);
    }
  });

  it('coordinating a contractor a person already approved is permitted, and that task needs no new role', () => {
    const reading = deriveOrganization({ snapshot: { coverage: expanding }, bottlenecks, approvedContractors: [{ taskId: 't-pack', contractorRef: 'ctr-1', approvedByRef: 'person:owner' }] });
    expect(reading.coordination).toEqual([{ taskId: 't-pack', contractorRef: 'ctr-1', status: 'PERMITTED' }]);
    expect(reading.roles.some((one) => one.taskAllocation.includes('t-pack'))).toBe(false);
  });

  it('hiring automation without a job-specific quality and fairness assessment reads NOT_ESTABLISHED', () => {
    const key = 'ACCOUNTABILITY_LICENSING:cap-cert';
    const reading = deriveOrganization({
      snapshot: { coverage: expanding },
      bottlenecks,
      automation: [
        { roleKey: key, tool: 'screener-none', assessment: null },
        { roleKey: key, tool: 'screener-generic', assessment: { jobSpecific: false, quality: 0.9, fairness: 0.9, evidenceRef: 'bench-1' } },
        { roleKey: key, tool: 'screener-partial', assessment: { jobSpecific: true, quality: 0.8, fairness: null, evidenceRef: 'eval-2' } },
        { roleKey: key, tool: 'screener-assessed', assessment: { jobSpecific: true, quality: 0.8, fairness: 0.95, evidenceRef: 'eval-3' } },
      ],
    });
    const statuses = Object.fromEntries(reading.roles.find((one) => one.key === key)!.automation.map((one) => [one.tool, one.status]));
    expect(statuses).toEqual({ 'screener-none': 'NOT_ESTABLISHED', 'screener-generic': 'NOT_ESTABLISHED', 'screener-partial': 'NOT_ESTABLISHED', 'screener-assessed': 'ESTABLISHED' });
  });
});

describe('VENT-24-3 — dormant until an active objective depends on it', () => {
  it('with no active objective depending on a role, the reading is DORMANT and requests no capacity', () => {
    const reading = deriveOrganization({ snapshot: { coverage: expanding }, bottlenecks, activeObjectives: [{ id: 'goal-x', taskIds: ['t-draft'] }] });
    expect(reading.roles.length).toBeGreaterThan(0);
    expect(reading.state).toBe('DORMANT');
    expect(reading.capacityRequested).toBe(0);
    expect(reading.roles.every((one) => one.state === 'DORMANT' && one.dependentObjectives.length === 0)).toBe(true);
  });

  it('an active objective whose tasks depend on a role makes only that role ACTIVE', () => {
    const reading = deriveOrganization({ snapshot: { coverage: expanding }, bottlenecks, activeObjectives: [{ id: 'goal-1', taskIds: ['t-audit'] }] });
    expect(reading.state).toBe('ACTIVE');
    expect(reading.capacityRequested).toBe(1);
    expect(reading.roles.filter((one) => one.state === 'ACTIVE').map((one) => one.key)).toEqual(['ACCOUNTABILITY_LICENSING:cap-cert']);
  });

  it('the module writes nothing: it imports types only', () => {
    const source = readFileSync(new URL('../server/services/labor/organization.ts', import.meta.url), 'utf8');
    expect(source.match(/^import (?!type)/gm)).toBeNull();
  });
});
