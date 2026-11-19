import { describe, expect, it } from 'vitest';
import { findingId, planFiling, type AgentRxFinding } from '../scripts/agentrx/filing.ts';

const finding = (over: Partial<AgentRxFinding> = {}): AgentRxFinding => ({
  id: 'RX-RESEARCH_AUDIT-LEASE_EXPIRED',
  confidence: 'CONFIRMED',
  status: 'ROOT_CAUSE_CONFIRMED',
  capability: 'Brain work queue: RESEARCH_AUDIT',
  symptom: 'RESEARCH_AUDIT work items fail with LEASE_EXPIRED (47 in the last 7 days)',
  evidence: 'work_leases wls_838f9abd6b84438abbf5: heartbeats 0',
  root_cause: 'CONFIRMED by AgentRx: the worker never renewed its lease',
  severity: 'BLOCKING',
  verification_criteria: 'no new RESEARCH_AUDIT item fails with LEASE_EXPIRED in 24h',
  note: 'AgentRx diagnosis (CONFIRMED). Proposed correction: heartbeat while working.',
  failedAt: '2026-11-18T16:03:03.401Z',
  ...over,
});

describe('AgentRx findings filed into the operator inventory', () => {
  it('keys a failure class, not an item, so one cause on many items is one finding', () => {
    expect(findingId('RESEARCH_AUDIT', 'LEASE_EXPIRED')).toBe('RX-RESEARCH_AUDIT-LEASE_EXPIRED');
    expect(findingId('RESEARCH_FRAGMENT', null)).toBe('RX-RESEARCH_FRAGMENT-FAILED');
    expect(findingId('X'.repeat(80), 'Y')).toHaveLength(48);
  });

  it('creates a new finding with the confirmed status only when AgentRx confirmed it', () => {
    expect(planFiling(null, finding()).status).toBe('ROOT_CAUSE_CONFIRMED');
    const suspected = planFiling(null, finding({ confidence: 'SUSPECTED', status: 'DISCOVERED', root_cause: 'SUSPECTED by AgentRx: …' }));
    expect(suspected.status).toBeUndefined();
    expect(suspected.rootCause).toContain('SUSPECTED');
  });

  it('never downgrades a confirmed cause with a suspected reading', () => {
    const plan = planFiling({ status: 'ROOT_CAUSE_CONFIRMED', owner: null, rootCause: 'confirmed earlier', verification: null }, finding({ confidence: 'SUSPECTED', status: 'DISCOVERED', root_cause: 'guess' }));
    expect(plan.status).toBeUndefined();
    expect(plan.rootCause).toBeUndefined();
    expect(plan.note).toContain('confirmed cause stands');
  });

  it('does not rewrite a finding somebody owns; the diagnosis goes to its note', () => {
    const plan = planFiling({ status: 'REPAIRING', owner: 'operator', rootCause: 'theirs', verification: null }, finding());
    expect(plan).toEqual({ id: 'RX-RESEARCH_AUDIT-LEASE_EXPIRED', note: expect.stringContaining('AgentRx (CONFIRMED)') });
  });

  it('reopens a verified fix when the class failed again after the verification', () => {
    const existing = { status: 'VERIFIED_FIXED' as const, owner: null, rootCause: 'x', verification: { kind: 'DEPLOY' as const, ref: '44357471351', detail: 'live', recordedAt: '2026-11-18T18:00:00.000Z' } as never };
    expect(planFiling(existing, finding({ failedAt: '2026-11-19T01:00:00.000Z' })).status).toBe('DISCOVERED');
    expect(planFiling(existing, finding({ failedAt: '2026-11-18T16:03:03.401Z' })).status).toBeUndefined();
  });
});
