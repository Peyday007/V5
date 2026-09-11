/**
 * `throughput.ts`, driven the way `metrics.ts` itself is: a recorded
 * `CampaignMetrics` snapshot in, evidence-classed numbers out, no database
 * needed for the pure half.
 */
import { describe, expect, it } from 'vitest';
import { computeMetrics, type MetricsInput } from '../server/services/factory/metrics.ts';
import { computeThroughput, throughputReport } from '../server/services/factory/throughput.ts';
import { freshProject, teardown } from './helpers.ts';
import { approveChangeRequest, ensureCampaign, ensureChangeRequest } from '../server/repos/factory.ts';
import type {
  FactoryEvent,
  FactoryIntegration,
  FactorySession,
  FactoryWorkUnit,
} from '../server/domain/factory.ts';

function session(over: Partial<FactorySession> = {}): FactorySession {
  return {
    id: 'fss_1',
    campaignId: 'c1',
    unitId: 'u1',
    workerId: 'w1',
    accountRef: 'acct-1',
    attempt: 1,
    role: 'IMPLEMENTER',
    externalSessionId: null,
    model: 'sonnet',
    state: 'FINISHED',
    exitReason: null,
    durationMs: 60_000,
    numTurns: null,
    usage: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...over,
  };
}

function unit(over: Partial<FactoryWorkUnit> = {}): FactoryWorkUnit {
  return {
    id: 'u1',
    campaignId: 'c1',
    unitKey: 'u1',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'a unit',
    objective: 'do the thing',
    acceptance: ['it works'],
    ownedPaths: ['src/a/**'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a diff',
    risk: 'LOW',
    criticalPath: false,
    downstreamCount: 0,
    priority: 5,
    modelClass: 'FAST',
    state: 'INTEGRATED',
    attempt: 1,
    maxAttempts: 3,
    leaseGeneration: 1,
    leaseId: null,
    leaseWorkerId: null,
    leaseSessionId: null,
    leasedAt: null,
    leaseExpiresAt: null,
    worktreePath: null,
    branch: null,
    headSha: null,
    baseSha: null,
    workerSummary: null,
    terminalResult: null,
    failureCategory: null,
    failureDetail: null,
    notBefore: null,
    repairsFindingId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...over,
  };
}

function integration(over: Partial<FactoryIntegration> = {}): FactoryIntegration {
  return {
    id: 'fig_1',
    campaignId: 'c1',
    unitId: 'u1',
    attempt: 1,
    outcome: 'MERGED',
    reason: 'clean merge',
    rejectedPaths: [],
    beforeSha: 'base',
    afterSha: 'head',
    verification: [],
    integratorSessionId: null,
    createdAt: '2026-01-01T00:01:30.000Z',
    ...over,
  };
}

function event(over: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    id: 'fev_1',
    campaignId: 'c1',
    unitId: null,
    workerId: null,
    sessionId: null,
    accountRef: null,
    kind: 'UNIT_READY',
    phase: null,
    durationMs: null,
    evidenceClass: 'MEASURED',
    detail: {},
    at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function emptyMetricsInput(campaignId = 'c1'): MetricsInput {
  return { campaignId, units: [], sessions: [], integrations: [], events: [], reviews: [], findings: [] };
}

describe('computeThroughput over a campaign with no sessions', () => {
  it('reports the observed concurrency ceiling as UNKNOWN with a null value, never as zero', () => {
    const report = computeThroughput(computeMetrics(emptyMetricsInput()));
    expect(report.ceiling.evidence).toBe('UNKNOWN');
    expect(report.ceiling.value).toBeNull();
    expect(report.maxObservedConcurrency.evidence).toBe('UNKNOWN');
    expect(report.maxObservedConcurrency.value).toBeNull();
    expect(report.concurrency.observed).toEqual(report.ceiling);
  });

  it('reports every breakdown as empty rather than inventing an entry', () => {
    const report = computeThroughput(computeMetrics(emptyMetricsInput()));
    expect(report.perWorker).toEqual([]);
    expect(report.perRole).toEqual([]);
    expect(report.perAccountRef).toEqual([]);
  });

  it('never treats a declared concurrency as observed evidence', () => {
    const report = computeThroughput(computeMetrics(emptyMetricsInput()));
    expect(report.concurrency.declared.evidence).toBe('UNKNOWN');
  });
});

describe('computeThroughput over a campaign with two timed sessions', () => {
  const units = [unit({ id: 'u1', unitKey: 'u1' }), unit({ id: 'u2', unitKey: 'u2' })];
  const sessions = [
    session({ id: 's1', unitId: 'u1', workerId: 'w1', accountRef: 'acct-1', durationMs: 60_000 }),
    session({ id: 's2', unitId: 'u2', workerId: 'w2', accountRef: 'acct-2', durationMs: 120_000 }),
  ];
  const integrations = [
    integration({ id: 'i1', unitId: 'u1', attempt: 1, outcome: 'MERGED' }),
    integration({ id: 'i2', unitId: 'u2', attempt: 1, outcome: 'MERGED' }),
  ];
  const events = [
    event({ id: 'e1', kind: 'UNIT_READY', unitId: 'u1', at: '2026-01-01T00:00:00.000Z' }),
    event({
      id: 'e2',
      kind: 'UNIT_CLAIMED',
      unitId: 'u1',
      workerId: 'w1',
      sessionId: 's1',
      accountRef: 'acct-1',
      at: '2026-01-01T00:00:05.000Z',
    }),
    event({ id: 'e3', kind: 'UNIT_READY', unitId: 'u2', at: '2026-01-01T00:10:00.000Z' }),
    event({
      id: 'e4',
      kind: 'UNIT_CLAIMED',
      unitId: 'u2',
      workerId: 'w2',
      sessionId: 's2',
      accountRef: 'acct-2',
      at: '2026-01-01T00:10:03.000Z',
    }),
    event({ id: 'e5', kind: 'INTEGRATION_MERGED', unitId: 'u2', at: '2026-01-01T01:00:00.000Z' }),
  ];
  const metrics = computeMetrics({ campaignId: 'c1', units, sessions, integrations, events, reviews: [], findings: [] });
  const report = computeThroughput(metrics);

  it('reports MEASURED session durations', () => {
    expect(report.sessionDurations.total).toEqual({
      value: 180_000,
      evidence: 'MEASURED',
      basis: expect.stringContaining('factory_sessions.duration_ms'),
    });
    expect(report.sessionDurations.samples.value).toBe(2);
    expect(report.sessionDurations.samples.evidence).toBe('MEASURED');
    expect(report.sessionDurations.average.evidence).toBe('DERIVED');
    expect(report.sessionDurations.average.value).toBe(90_000);
  });

  it('reports a DERIVED units-per-hour, from measured merges over measured wall clock', () => {
    expect(report.unitsPerHour.evidence).toBe('DERIVED');
    expect(report.unitsPerHour.value).not.toBeNull();
    expect(report.unitsPerHour.basis).toContain('MERGED');
  });

  it('attributes units-per-hour to each worker from that worker\'s own measured sessions', () => {
    const w1 = report.perWorker.find((w) => w.id === 'w1');
    const w2 = report.perWorker.find((w) => w.id === 'w2');
    expect(w1?.accountRef).toBe('acct-1');
    expect(w2?.accountRef).toBe('acct-2');
    expect(w1?.unitsPerHour.evidence).toBe('DERIVED');
    expect(w2?.unitsPerHour.evidence).toBe('DERIVED');
    expect(w1?.sessionDurations.total.value).toBe(60_000);
    expect(w2?.sessionDurations.total.value).toBe(120_000);
  });

  it('groups perAccountRef from the sessions\' own account_ref, not a fresh claim', () => {
    const accounts = report.perAccountRef.map((a) => a.id).sort();
    expect(accounts).toEqual(['acct-1', 'acct-2']);
  });

  it('leaves perRole without a merge attribution RoleMetrics never tracked', () => {
    const implementer = report.perRole.find((r) => r.id === 'IMPLEMENTER');
    expect(implementer?.unitsMerged.evidence).toBe('UNKNOWN');
    expect(implementer?.unitsMerged.value).toBeNull();
  });

  it('separates the observed peak from an unreached ceiling: two sessions overlapped but nothing was ever refused', () => {
    // Both sessions share the default startedAt/endedAt from the `session()`
    // builder, so they genuinely overlapped and the peak is a real MEASURED 2 —
    // but neither session is RATE_LIMITED, so that peak must not be reported as
    // a ceiling. Asserting only on `maxObservedConcurrency` (as the pre-repair
    // `return observed` did) would pass even if `ceiling` were wired straight
    // back to it; this pins the two numbers apart.
    expect(report.maxObservedConcurrency.value).toBe(2);
    expect(report.maxObservedConcurrency.evidence).toBe('MEASURED');
    expect(report.ceiling.value).toBeNull();
    expect(report.ceiling.evidence).toBe('UNKNOWN');
    expect(report.ceiling).not.toEqual(report.maxObservedConcurrency);
  });
});

describe('computeThroughput over a campaign with a RATE_LIMITED session', () => {
  const units = [unit({ id: 'u1', unitKey: 'u1' }), unit({ id: 'u2', unitKey: 'u2' })];
  const sessions = [
    session({ id: 's1', unitId: 'u1', workerId: 'w1', accountRef: 'acct-1', durationMs: 60_000 }),
    session({
      id: 's2',
      unitId: 'u2',
      workerId: 'w2',
      accountRef: 'acct-2',
      durationMs: 30_000,
      state: 'RATE_LIMITED',
    }),
  ];
  const metrics = computeMetrics({
    campaignId: 'c1',
    units,
    sessions,
    integrations: [],
    events: [],
    reviews: [],
    findings: [],
  });
  const report = computeThroughput(metrics);

  it('reports the same overlapped peak as both the observed number and, now labelled PROVIDER_ENFORCED, the ceiling', () => {
    expect(report.maxObservedConcurrency.value).toBe(2);
    expect(report.maxObservedConcurrency.evidence).toBe('MEASURED');
    expect(report.ceiling.value).toBe(2);
    expect(report.ceiling.evidence).toBe('PROVIDER_ENFORCED');
    expect(report.ceiling.basis).toContain('RATE_LIMITED');
  });
});

describe('throughputReport against real rows', () => {
  it('returns an all-UNKNOWN shape for an unknown campaign id, and never throws', async () => {
    await freshProject();
    try {
      const report = await throughputReport('no-such-campaign');
      expect(report.ceiling.evidence).toBe('UNKNOWN');
      expect(report.ceiling.value).toBeNull();
      expect(report.concurrency.declared.evidence).toBe('UNKNOWN');
      expect(report.perWorker).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('shows the campaign\'s declared lane target beside the observed peak, labelled UNKNOWN', async () => {
    const fixture = await freshProject();
    try {
      const { changeRequest } = await ensureChangeRequest({
        projectId: fixture.project.id,
        submissionKey: 'throughput-test',
        objective: 'Prove the throughput report reads a real campaign.',
        expectedOutcome: 'A report with a declared lane target.',
        nonGoals: [],
        acceptanceConditions: [
          { id: 'A01', statement: 'it happened', verification: 'look', mandatory: true },
        ],
        repository: '/tmp/not-a-real-repo',
        baseBranch: 'main',
        baseSha: 'deadbeef',
        environment: 'LOCAL',
        riskClass: 'LOW',
        mutationScope: ['src/**'],
        deploymentPolicy: 'NONE',
        rollbackRequirement: 'discard the branch',
        verificationCommands: [],
      });
      await approveChangeRequest({
        changeRequestId: changeRequest.id,
        via: 'PERSON',
        userId: null,
        authorityId: null,
      });
      const { campaign } = await ensureCampaign({
        changeRequestId: changeRequest.id,
        projectId: fixture.project.id,
        baseSha: changeRequest.baseSha,
        laneTarget: 4,
        laneTargetReason: 'initial',
      });

      const report = await throughputReport(campaign.id);
      expect(report.concurrency.declared).toEqual({
        value: 4,
        evidence: 'UNKNOWN',
        basis: expect.stringContaining('lane_target'),
      });
      // No session has run yet: the observed peak must stay UNKNOWN, not 0.
      expect(report.ceiling.evidence).toBe('UNKNOWN');
      expect(report.ceiling.value).toBeNull();
    } finally {
      await teardown();
    }
  });
});
