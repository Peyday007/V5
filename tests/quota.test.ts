/**
 * Quota-aware execution: what runs first, and what happens when the allowance
 * runs out.
 *
 * The ordering matters because a research allowance is finite and spending it
 * in planning order wastes it — a fragment researched before the definition it
 * depends on may have answered the wrong question entirely.
 *
 * The pause matters more. Running out of quota is an ordinary event, and the
 * one thing it must never do is lower the evidence bar: a fragment that cannot
 * clear its gate stays blocked whether the allowance is full or empty, and
 * nothing is spent on the user's card unless they turned that on themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  assignExecutionPriority,
  executionOrder,
  PRIORITY_TIERS,
  quotaDecision,
  tierOf,
  type TierInput,
} from '../server/services/research/quota.ts';
import type { ProviderQuota, ResearchFragment } from '../server/domain/types.ts';
import type { AIProvider, ProviderStatus } from '../server/providers/types.ts';

function brief(overrides: Partial<TierInput> & { fragmentKey: string }): TierInput {
  return {
    dependsOn: [],
    requirementIds: ['req_1'],
    expectedClaimTypes: ['SOURCED_FACT'],
    requiredCalculations: [],
    contradictionTargets: [],
    evidenceLane: 'official statistics',
    priority: 1,
    ...overrides,
  };
}

describe('what the allowance is spent on first', () => {
  it('settles the boundary before researching inside it', () => {
    // A boundary question is planned with no requirement behind it, because it
    // decides which requirements are in scope at all.
    const boundary = brief({ fragmentKey: 'boundary', requirementIds: [] });
    const definition = brief({ fragmentKey: 'definition', evidenceLane: 'authoritative definition' });
    const ordinary = brief({ fragmentKey: 'ordinary' });

    expect(tierOf(boundary, []).tier).toBe('BOUNDARY_AND_DEFINITION');
    expect(tierOf(definition, []).tier).toBe('BOUNDARY_AND_DEFINITION');
    expect(tierOf(ordinary, []).rank).toBeGreaterThan(tierOf(boundary, []).rank);
  });

  it('ranks the tiers in the order the assignment depends on them', () => {
    const all = [
      brief({ fragmentKey: 'boundary', requirementIds: [] }),
      brief({ fragmentKey: 'premise' }),
      brief({ fragmentKey: 'calc', expectedClaimTypes: ['CALCULATION'] }),
      brief({ fragmentKey: 'contested', contradictionTargets: ['claim_1'] }),
      brief({ fragmentKey: 'mandatory', priority: 1 }),
      brief({ fragmentKey: 'supporting', priority: 5 }),
      brief({ fragmentKey: 'optional', priority: 8 }),
      // Something rests on 'premise', which is what makes it foundational.
      brief({ fragmentKey: 'dependent', dependsOn: ['premise'] }),
    ];
    const tier = (key: string) => tierOf(all.find((entry) => entry.fragmentKey === key)!, all).tier;

    expect(tier('boundary')).toBe('BOUNDARY_AND_DEFINITION');
    expect(tier('premise')).toBe('FOUNDATIONAL_EVIDENCE');
    expect(tier('calc')).toBe('CALCULATION_INPUT');
    expect(tier('contested')).toBe('CONTRADICTION_RESOLUTION');
    expect(tier('mandatory')).toBe('MANDATORY_SYNTHESIS_INPUT');
    expect(tier('supporting')).toBe('SUPPORTING_CONTEXT');
    expect(tier('optional')).toBe('OPTIONAL_ENRICHMENT');

    // The ranks follow the spec's order exactly.
    expect(PRIORITY_TIERS.indexOf(tier('boundary'))).toBeLessThan(
      PRIORITY_TIERS.indexOf(tier('contested')),
    );
    expect(PRIORITY_TIERS.indexOf(tier('contested'))).toBeLessThan(
      PRIORITY_TIERS.indexOf(tier('optional')),
    );
  });

  it('stamps the tier onto the planned fragments as their priority', () => {
    const briefs = [
      brief({ fragmentKey: 'optional', priority: 8 }),
      brief({ fragmentKey: 'boundary', requirementIds: [] }),
    ];
    assignExecutionPriority(briefs);
    expect(briefs[1]!.priority).toBe(1);
    expect(briefs[0]!.priority).toBe(7);
  });
});

function fragment(overrides: Partial<ResearchFragment> & { fragmentKey: string }): ResearchFragment {
  return {
    ...(brief(overrides) as unknown as Record<string, unknown>),
    requirementIds: overrides.requirementIds ?? ['req_1'],
    evidenceLane: overrides.evidenceLane ?? 'official statistics',
    whyItMatters: null,
    missingEvidence: null,
    whyExistingInsufficient: null,
    existingClaimIds: [],
    excludedScope: null,
    expectedClaimTypes: overrides.expectedClaimTypes ?? ['SOURCED_FACT'],
    preferredSourceTypes: [],
    prohibitedEvidence: [],
    requiredComparisons: [],
    requiredCalculations: [],
    contradictionTargets: overrides.contradictionTargets ?? [],
    failureConditions: [],
    uncertaintyTolerance: null,
    priority: overrides.priority ?? 5,
    estimatedEffort: null,
    maxRepairs: 2,
    splitFromId: null,
    repairPlan: null,
    cancelledReason: null,
    id: `frag_${overrides.fragmentKey}`,
    orchestrationId: 'orch_1',
    projectId: 'proj_1',
    layerId: 'layer_1',
    fragmentIndex: 0,
    question: 'q',
    geography: null,
    timeframe: null,
    population: null,
    definitions: null,
    requiredEvidence: [],
    acceptableSourceTypes: [],
    excludedSourceTypes: [],
    completionCriteria: [],
    dependsOn: overrides.dependsOn ?? [],
    minIndependentSources: 2,
    status: 'QUEUED',
    attempt: 1,
    parentFragmentId: null,
    repairReason: null,
    repairStrategy: null,
    integrityVerdict: null,
    sufficiencyVerdict: null,
    verdictDetail: null,
    blockedReason: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    acceptedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as ResearchFragment;
}

describe('choosing between fragments that are all ready', () => {
  it('runs the most foundational one first', () => {
    const all = [
      fragment({ fragmentKey: 'optional', priority: 7, fragmentIndex: 0 }),
      fragment({ fragmentKey: 'premise', priority: 2, fragmentIndex: 1 }),
      fragment({ fragmentKey: 'boundary', requirementIds: [], priority: 1, fragmentIndex: 2 }),
    ];
    const order = executionOrder(all, [...all, fragment({ fragmentKey: 'rests-on', dependsOn: ['premise'] })]);
    expect(order.map((entry) => entry.fragmentKey)).toEqual(['boundary', 'premise', 'optional']);
  });

  it('finishes a repair before opening new work at the same tier', () => {
    const first = fragment({ fragmentKey: 'a', priority: 5, fragmentIndex: 0 });
    const repairing = fragment({ fragmentKey: 'b', priority: 5, fragmentIndex: 1, attempt: 2 });
    const order = executionOrder([first, repairing], [first, repairing]);
    expect(order[0]!.fragmentKey).toBe('b');
  });
});

function workerWithQuota(quota: ProviderQuota | undefined): AIProvider {
  const status: ProviderStatus = {
    name: 'mock',
    available: true,
    reason: 'test',
    model: null,
    capabilities: { chat: false, research: true, audit: false },
    ...(quota ? { quota } : {}),
  };
  return {
    name: 'mock',
    chat: async () => ({ text: '', externalResponseId: null }),
    runResearch: async () => ({ text: '', externalResponseId: null, model: null }),
    audit: async () => ({ text: '', externalResponseId: null }),
    getStatus: () => status,
  };
}

describe('when the allowance runs out', () => {
  it('pauses rather than continuing, and says which allowance is gone', () => {
    const decision = quotaDecision({
      provider: workerWithQuota({
        state: 'EXHAUSTED',
        scope: 'GEMINI',
        detail: 'The Gemini allowance is used up for now.',
        resetsAt: 'midnight UTC',
      }),
      paidOverageEnabled: false,
    });
    expect(decision.canRun).toBe(false);
    expect(decision.detail).toMatch(/own model allowance is exhausted/i);
    expect(decision.detail).toMatch(/midnight UTC/);
    // Everything already done stays done, and the pause says so.
    expect(decision.detail).toMatch(/already accepted is kept/i);
    expect(decision.overageWouldHelp).toBe(true);
  });

  it('never spends money by default, and says that is why it stopped', () => {
    const decision = quotaDecision({
      provider: workerWithQuota({
        state: 'EXHAUSTED',
        scope: 'THIRD_PARTY',
        detail: 'The third-party model allowance is used up for now.',
        resetsAt: null,
      }),
      paidOverageEnabled: false,
    });
    expect(decision.canRun).toBe(false);
    expect(decision.detail).toMatch(/Paid overages are off/);
    expect(decision.detail).toMatch(/will not spend money/i);
  });

  it('continues on a paid overage only when the user turned it on', () => {
    const exhausted: ProviderQuota = {
      state: 'EXHAUSTED',
      scope: 'UNKNOWN',
      detail: 'The model allowance is used up for now.',
      resetsAt: null,
    };
    const decision = quotaDecision({
      provider: workerWithQuota(exhausted),
      paidOverageEnabled: true,
    });
    expect(decision.canRun).toBe(true);
    expect(decision.detail).toMatch(/which you enabled/i);
  });

  it('does not treat a quiet provider as an exhausted one', () => {
    // Most tools say nothing about quota. Refusing to research because of that
    // would stop work that would have succeeded.
    expect(quotaDecision({ provider: workerWithQuota(undefined), paidOverageEnabled: false }).canRun).toBe(
      true,
    );
    const limited = quotaDecision({
      provider: workerWithQuota({
        state: 'LIMITED',
        scope: 'GEMINI',
        detail: 'The allowance is running low.',
        resetsAt: null,
      }),
      paidOverageEnabled: false,
    });
    expect(limited.canRun).toBe(true);
  });
});
