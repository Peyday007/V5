/**
 * An improvement whose mutation scope holds only tests is not sent to Factory.
 *
 * Production, 2026-11-16: fcp_351dce2b ("Goal research rounds end without a
 * report", attempt 3) and fcp_344f15e6 ("Capability benchmark feasibility misses
 * its target") were submitted with `mutationScope: ["tests/**"]` — the director's
 * scope for a diagnosis that named no owner path. Every architect session
 * answered, correctly, that no plan fits a scope that cannot touch the code that
 * produces the behaviour; both FACTORY_PLAN bins spent all ten attempts that way
 * and then read as waiting for a person. The register now holds such a candidate
 * on the missing owner instead of spending a Factory campaign on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitted: Array<Record<string, unknown>> = [];
vi.mock('../server/services/factory/contract.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/factory/contract.ts')>();
  return {
    ...actual,
    submitObjective: vi.fn(async (input: Record<string, unknown>) => {
      submitted.push(input);
      return { changeRequest: { id: `fcr_test${submitted.length}` }, created: true };
    }),
  };
});
vi.mock('../server/services/factory/start.ts', () => ({
  approveAndStartCampaign: vi.fn(async (input: { changeRequestId: string }) => ({
    ok: true,
    changeRequest: { id: input.changeRequestId, riskClass: 'LOW' },
    campaign: { id: `fcp_for_${input.changeRequestId}` },
    campaignCreated: true,
    execution: { mode: 'REMOTE', note: 'test' },
  })),
}));

import { freshProject } from './helpers.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { setProjectRepository } from '../server/repos/factory.ts';
import { getCandidate, listImprovementEvents, upsertCandidate } from '../server/repos/improvement.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { scopeCarriesAChange, submitExperimentVariant } from '../server/services/improvement/loop.ts';

describe('whether a scope can hold a change to behaviour', () => {
  it('refuses a scope of tests only, and a component label that is not a path', () => {
    expect(scopeCarriesAChange(['tests/**'])).toBe(false);
    expect(scopeCarriesAChange(['tests/**', 'server/foo.test.ts', 'client/__tests__/x.tsx'])).toBe(false);
    expect(scopeCarriesAChange(['operator:CAPABILITY_BELOW_TARGET', 'tests/**'])).toBe(false);
    expect(scopeCarriesAChange([])).toBe(false);
  });
  it('accepts a scope that names production code beside its tests', () => {
    expect(scopeCarriesAChange(['server/services/russell/roundMissions.ts', 'tests/**'])).toBe(true);
    expect(scopeCarriesAChange(['server/services/russell/**'])).toBe(true);
  });
});

describe('submitting an improvement to Factory', () => {
  beforeEach(async () => {
    submitted.length = 0;
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setProjectRepository({ projectId: brainId, grantId: 'brain', repositoryId: 'peyday007/v5', scopeKind: 'WHOLE_REPOSITORY', pathScope: [], reason: 'test', setBy: 'test' });
    await setImprovementSwitch(true, 'owner@example.com', 'test');
  });

  async function candidate(key: string, mutationScope: string[]) {
    const { candidate: row } = await upsertCandidate({
      weaknessKey: key,
      kind: 'OPERATOR:RECURRING_OPERATIONAL_FAILURE',
      title: 'Goal research rounds end without a report',
      problem: '132 research rounds for the goal ended ABANDONED in 7 days.',
      metric: 'OWNER_INTERVENTIONS_PER_DAY',
      downstreamMetric: null,
      ownerComponent: mutationScope[0]!,
      frequency: 132,
      denominator: 132,
      scope: 'GENERAL',
      severity: 'HIGH',
      evidence: { samples: ['round abandoned'], mutationScope },
      attempt: 1,
      parentId: null,
    });
    return row;
  }

  it('holds a tests-only scope on its missing owner and starts no campaign', async () => {
    const row = await candidate('OPERATOR:RECURRING_OPERATIONAL_FAILURE:testsonly', ['tests/**']);
    const result = await submitExperimentVariant(row.id, 'VARIANT');
    expect(result.ok).toBe(false);
    expect(result.did).toContain('owner of the behaviour is not named');
    expect(submitted).toHaveLength(0);
    const after = (await getCandidate(row.id))!;
    expect(after.decision).toBe('HELD');
    expect(after.changeRequestId).toBeNull();
    expect(after.heldOn).toContain('owner_paths');
    const events = await listImprovementEvents({ candidateId: row.id, kinds: ['DECIDED'] });
    expect(events[0]?.detail).toMatchObject({ decision: 'HELD', needsPerson: false, reason: 'SCOPE_HOLDS_NO_OWNER_PATH' });
  });

  it('submits a scope that names the owner of the behaviour', async () => {
    const row = await candidate('OPERATOR:RECURRING_OPERATIONAL_FAILURE:owned', ['server/services/russell/roundMissions.ts', 'tests/**']);
    const result = await submitExperimentVariant(row.id, 'VARIANT');
    expect(result.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!['mutationScope']).toEqual(['server/services/russell/roundMissions.ts', 'tests/**']);
  });
});
