/**
 * Job bundling: what may share one execution, and what may never be shared.
 *
 * A fragment is a logical evidence unit; a job is an execution container. Six
 * fragments about the same statute in the same jurisdiction do not need six
 * conversations, six retrievals of the same sources and six slices of the
 * user's quota — but they do need six separate answers, because the moment one
 * fragment's evidence can be mistaken for another's the whole ledger is
 * untrustworthy.
 *
 * So these tests care about two things: that compatible work is packed
 * together, and that nothing about the packing leaks between the fragments.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSeparable,
  bundleFragments,
  modelFor,
  MAX_FRAGMENTS_PER_JOB,
} from '../server/services/research/bundling.ts';
import type { ResearchFragment } from '../server/domain/types.ts';

function fragment(overrides: Partial<ResearchFragment> & { fragmentKey: string }): ResearchFragment {
  return {
    requirementIds: [],
    evidenceLane: null,
    whyItMatters: null,
    missingEvidence: null,
    whyExistingInsufficient: null,
    existingClaimIds: [],
    excludedScope: null,
    expectedClaimTypes: [],
    preferredSourceTypes: ['official statistics'],
    prohibitedEvidence: [],
    requiredComparisons: [],
    requiredCalculations: [],
    contradictionTargets: [],
    failureConditions: [],
    uncertaintyTolerance: null,
    priority: 5,
    estimatedEffort: null,
    maxRepairs: 2,
    splitFromId: null,
    repairPlan: null,
    cancelledReason: null,
    id: `frag_${overrides.fragmentKey}`,
    fragmentIndex: 0,
    orchestrationId: 'orch_1',
    projectId: 'proj_1',
    layerId: 'layer_1',
    question: `What does the record show about ${overrides.fragmentKey}?`,
    geography: 'United States',
    timeframe: '2023',
    population: 'B2B firms',
    definitions: 'Outsourced SDR: an external firm booking qualified meetings.',
    requiredEvidence: [{ id: 'official_statistics', description: 'official statistics', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['government dataset', 'regulator publication'],
    excludedSourceTypes: [],
    completionCriteria: ['a figure with its definition'],
    dependsOn: [],
    minIndependentSources: 2,
    nextRetryAt: null,
    status: 'PLANNED',
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
  };
}

describe('fragments that can share one job', () => {
  it('bundles fragments with the same scope and source ecosystem', () => {
    const bundles = bundleFragments([
      fragment({ fragmentKey: 'a' }),
      fragment({ fragmentKey: 'b' }),
      fragment({ fragmentKey: 'c' }),
    ]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.fragments.map((entry) => entry.fragmentKey)).toEqual(['a', 'b', 'c']);
    // The rationale is a sentence a person can check, not an internal id.
    expect(bundles[0]!.rationale).toMatch(/United States/);
    expect(bundles[0]!.rationale).toMatch(/a, b, c/);
  });

  it('never exceeds the fragments-per-job limit', () => {
    const many = Array.from({ length: MAX_FRAGMENTS_PER_JOB * 2 + 1 }, (_value, index) =>
      fragment({ fragmentKey: `f${index}` }),
    );
    const bundles = bundleFragments(many);
    expect(bundles.length).toBeGreaterThanOrEqual(3);
    for (const bundle of bundles) {
      expect(bundle.fragments.length).toBeLessThanOrEqual(MAX_FRAGMENTS_PER_JOB);
    }
    // Nothing is dropped on the way into a job.
    expect(bundles.flatMap((bundle) => bundle.fragments)).toHaveLength(many.length);
  });

  it('keeps a job to one scope', () => {
    const bundles = bundleFragments([
      fragment({ fragmentKey: 'us' }),
      fragment({ fragmentKey: 'uk', geography: 'United Kingdom' }),
      fragment({ fragmentKey: 'later', timeframe: '2024' }),
      fragment({ fragmentKey: 'other-population', population: 'Consumer households' }),
      fragment({
        fragmentKey: 'other-definition',
        definitions: 'Outsourced SDR: any contractor making calls.',
      }),
    ]);
    expect(bundles).toHaveLength(5);
  });

  it('does not bundle unrelated source ecosystems', () => {
    const bundles = bundleFragments([
      fragment({ fragmentKey: 'stats' }),
      fragment({
        fragmentKey: 'law',
        acceptableSourceTypes: ['statute', 'case law'],
        preferredSourceTypes: ['statute'],
      }),
    ]);
    expect(bundles).toHaveLength(2);
  });

  it('never puts a fragment in the same job as the fragment it depends on', () => {
    const bundles = bundleFragments([
      fragment({ fragmentKey: 'base' }),
      fragment({ fragmentKey: 'derived', dependsOn: [{ key: 'base', kind: 'HARD' }] }),
    ]);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.fragments[0]!.fragmentKey).toBe('base');
    expect(bundles[1]!.fragments[0]!.fragmentKey).toBe('derived');
  });

  it('gives a contradiction the stronger model, and cheap discovery the lighter one', () => {
    const investigation = bundleFragments([
      fragment({ fragmentKey: 'contested', contradictionTargets: ['Two agencies disagree.'] }),
    ])[0]!;
    expect(investigation.jobKind).toBe('INVESTIGATION');
    expect(modelFor(investigation.jobKind, { light: 'light-model', strong: 'strong-model' })).toBe(
      'strong-model',
    );

    const discovery = bundleFragments([fragment({ fragmentKey: 'broad', priority: 7 })])[0]!;
    expect(discovery.jobKind).toBe('DISCOVERY');
    expect(modelFor(discovery.jobKind, { light: 'light-model', strong: 'strong-model' })).toBe(
      'light-model',
    );
    // With only one model configured, the work still runs — on that model.
    expect(modelFor(discovery.jobKind, { light: null, strong: 'strong-model' })).toBe('strong-model');
  });
});

describe('output that cannot be attributed', () => {
  it('is rejected rather than untangled', () => {
    const bundle = bundleFragments([fragment({ fragmentKey: 'a' }), fragment({ fragmentKey: 'b' })])[0]!;
    const verdict = assertSeparable(
      bundle,
      new Map<string, unknown[]>([
        ['a', [{}]],
        ['somebody-elses-fragment', [{}]],
      ]),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/somebody-elses-fragment/);
  });

  it('accepts a result keyed by the fragments that were actually in the job', () => {
    const bundle = bundleFragments([fragment({ fragmentKey: 'a' }), fragment({ fragmentKey: 'b' })])[0]!;
    // A fragment answering nothing is that fragment's failure, not the job's.
    expect(assertSeparable(bundle, new Map<string, unknown[]>([['a', [{}]]])).ok).toBe(true);
  });
});
