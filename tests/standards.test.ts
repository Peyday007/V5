/**
 * Evidence standards that vary by claim type, and sources that only look
 * independent.
 *
 * The general "two independent sources" rule is gone, because it was wrong in
 * both directions: it refused a statute that says exactly what the claim says,
 * and it accepted two outlets carrying the same press release. What replaces it
 * is a standard per claim type, applied per claim, plus an independence check
 * that looks at where a figure actually came from.
 */
import { describe, expect, it } from 'vitest';
import type { ResearchClaim, ResearchFragment } from '../server/domain/types.ts';
import { applyGate } from '../server/services/research/gate.ts';
import {
  countIndependentSources,
  duplicateGroups,
  effectiveStandard,
  independenceGroup,
  isDisputedQuantity,
  standardFor,
} from '../server/services/research/standards.ts';
import { planDependencies, shouldSplit } from '../server/services/research/splitting.ts';

/** A claim with everything the gate reads, and sensible defaults. */
function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: `clm_${Math.random().toString(36).slice(2, 10)}`,
    orchestrationId: 'orc_test',
    fragmentId: 'frg_test',
    passId: null,
    passKey: 'BROAD_SCAN',
    claim: 'Employment in the occupation was 81,580 in 2024.',
    claimType: 'SOURCED_FACT',
    sourceUrl: 'https://www.bls.gov/oes/current/oes419041.htm',
    sourceTitle: 'OEWS',
    sourcePublisher: 'Bureau of Labor Statistics',
    sourceDate: '2024-04-03',
    evidenceExcerpt: 'Employment: 81,580',
    evidenceLocator: 'National estimates, row 1',
    evidenceLane: 'official statistics',
    retrievedAt: '2026-01-05',
    confidence: 0.8,
    contradictionState: 'UNCHALLENGED',
    contradictionNote: null,
    validationState: 'SOURCED',
    validationDetail: null,
    sourced: true,
    derived: false,
    derivedFrom: [],
    accepted: false,
    rejectionReason: null,
    scopeMatch: null,
    sourceGroup: 'host:bls.gov',
    primarySource: true,
    geography: null,
    timeframe: null,
    population: null,
    definition: null,
    requirementIds: [],
    jobId: null,
    reconciliation: null,
    reconciledClaimId: null,
    contradictionKind: null,
    reconciliationDetail: null,
    contentHash: 'hash',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fragment(overrides: Partial<ResearchFragment> = {}): ResearchFragment {
  return {
    id: 'frg_test',
    orchestrationId: 'orc_test',
    projectId: 'prj_test',
    layerId: 'lyr_test',
    fragmentIndex: 0,
    fragmentKey: 'employment',
    question: 'What is employment in the occupation?',
    geography: null,
    timeframe: null,
    population: null,
    definitions: null,
    requiredEvidence: ['official statistics'],
    acceptableSourceTypes: ['government statistics'],
    excludedSourceTypes: [],
    completionCriteria: ['a sourced figure'],
    dependsOn: [],
    minIndependentSources: 1,
    status: 'RUNNING',
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requirementIds: [],
    evidenceLane: 'official statistics',
    whyItMatters: null,
    missingEvidence: null,
    whyExistingInsufficient: null,
    existingClaimIds: [],
    excludedScope: null,
    expectedClaimTypes: [],
    preferredSourceTypes: [],
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
    ...overrides,
  };
}

const MATCH = {
  geography: 'MATCH' as const,
  timeframe: 'MATCH' as const,
  population: 'MATCH' as const,
  definitions: 'MATCH' as const,
};

function verificationFor(claims: ResearchClaim[], overrides: Record<string, boolean> = {}) {
  return {
    verdicts: new Map(
      claims.map((entry) => [
        entry.id,
        { supportsClaim: overrides[entry.id] ?? true, scopeMatch: MATCH, note: 'states it directly' },
      ]),
    ),
    sufficiency: 'SUFFICIENT' as const,
    missingLanes: [] as string[],
    unresolvedGaps: [] as string[],
  };
}

// ---------------------------------------------------------------------------
// The standards themselves
// ---------------------------------------------------------------------------

describe('the standard depends on what is being claimed', () => {
  it('accepts one authoritative source for a statutory fact', () => {
    const only = claim({ claimType: 'SOURCED_FACT', primarySource: true });
    const result = applyGate({
      fragment: fragment({ minIndependentSources: 1 }),
      claims: [only],
      verification: verificationFor([only]),
    });

    expect(result.claims[0]!.accepted).toBe(true);
    expect(result.integrity).toBe('PASS');
    expect(standardFor('SOURCED_FACT').minIndependentSources).toBe(1);
  });

  it('will not present an organisation\'s self-description as fact on its own', () => {
    const self = claim({
      claimType: 'SELF_REPORT',
      claim: 'The company states that it books forty qualified meetings a month.',
      sourceUrl: 'https://vendor.example.com/about',
      sourcePublisher: 'Vendor',
      sourceGroup: 'host:vendor.example.com',
      primarySource: false,
    });
    const result = applyGate({
      fragment: fragment(),
      claims: [self],
      verification: verificationFor([self]),
    });

    expect(result.claims[0]!.accepted).toBe(false);
    expect(result.claims[0]!.reason).toMatch(/independent/i);
    expect(standardFor('SELF_REPORT').requiresLabel).toBe(true);
  });

  it('accepts a self-report once somebody independent confirms it', () => {
    const self = claim({
      id: 'clm_self',
      claimType: 'SELF_REPORT',
      claim: 'The vendor books forty qualified meetings a month for its clients.',
      sourceUrl: 'https://vendor.example.com/about',
      sourceGroup: 'host:vendor.example.com',
      primarySource: false,
    });
    const independent = claim({
      id: 'clm_regulator',
      claim: 'The vendor books forty qualified meetings a month, per its regulatory filing.',
      sourceUrl: 'https://www.sec.gov/filing',
      sourceGroup: 'host:sec.gov',
    });
    const result = applyGate({
      fragment: fragment(),
      claims: [self, independent],
      verification: verificationFor([self, independent]),
    });

    expect(result.claims.find((entry) => entry.claimId === 'clm_self')!.accepted).toBe(true);
  });

  it('requires corroboration for a market-scale figure from a secondary source', () => {
    const estimate = claim({
      claim: 'The outsourced SDR market is worth 4.2 billion dollars.',
      sourceUrl: 'https://analyst.example.com/report',
      sourcePublisher: 'Analyst House',
      sourceGroup: 'host:analyst.example.com',
      primarySource: false,
    });
    expect(isDisputedQuantity(estimate)).toBe(true);
    expect(effectiveStandard(estimate).minIndependentSources).toBe(2);

    const result = applyGate({
      fragment: fragment(),
      claims: [estimate],
      verification: verificationFor([estimate]),
    });
    expect(result.claims[0]!.accepted).toBe(false);
    expect(result.claims[0]!.failedCondition).toBe('INDEPENDENCE');
  });

  it('does not require corroboration when the figure comes from the body that produced it', () => {
    const primary = claim({
      claim: 'The agency reports 81,580 people employed in the occupation, 4 percent lower.',
      primarySource: true,
    });
    expect(isDisputedQuantity(primary)).toBe(false);
    const result = applyGate({
      fragment: fragment(),
      claims: [primary],
      verification: verificationFor([primary]),
    });
    expect(result.claims[0]!.accepted).toBe(true);
  });

  it('says what a forecast and a claimed absence each need', () => {
    expect(standardFor('FORECAST').requiresLabel).toBe(true);
    expect(standardFor('FORECAST').rationale).toMatch(/projection/i);
    expect(standardFor('NEGATIVE_EXISTENCE').requiresDocumentedSearch).toBe(true);
    expect(standardFor('CALCULATION').requiresAcceptedInputs).toBe(true);
    expect(standardFor('INFERENCE').requiresAcceptedInputs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

describe('sources that are really one source', () => {
  it('treats two pages on one site as one source', () => {
    const first = claim({ id: 'a', sourceUrl: 'https://www.bls.gov/one.htm', sourceGroup: null });
    const second = claim({ id: 'b', sourceUrl: 'https://bls.gov/two.htm', sourceGroup: null });
    expect(countIndependentSources([first, second])).toBe(1);
  });

  it('treats a press release carried by three wires as one source', () => {
    const wires = ['prnewswire.com', 'businesswire.com', 'globenewswire.com'].map((host) =>
      independenceGroup({
        sourceUrl: `https://www.${host}/news/vendor-announces`,
        sourcePublisher: 'Vendor Inc',
        evidenceExcerpt: null,
      }),
    );
    expect(new Set(wires).size).toBe(1);
    expect(wires[0]).toBe('release:vendor inc');
  });

  it('credits the upstream estimate rather than whoever restated it', () => {
    const group = independenceGroup({
      sourceUrl: 'https://news.example.com/story',
      sourcePublisher: 'Example News',
      evidenceExcerpt: 'The market reached 4.2 billion dollars, according to Analyst House.',
    });
    expect(group).toBe('upstream:analyst house');
  });

  it('reports the duplicates rather than quietly counting them once', () => {
    const claims = [
      claim({ id: 'a', sourceGroup: 'release:vendor inc', sourcePublisher: 'PR Newswire' }),
      claim({ id: 'b', sourceGroup: 'release:vendor inc', sourcePublisher: 'Business Wire' }),
      claim({ id: 'c', sourceGroup: 'host:sec.gov', sourcePublisher: 'SEC' }),
    ];
    const groups = duplicateGroups(claims);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.claimIds).toEqual(['a', 'b']);
    expect(groups[0]!.publishers).toContain('PR Newswire');
  });

  it('counts fragment coverage by independent source, not by claim', () => {
    const claims = [
      claim({ id: 'a', sourceGroup: 'release:vendor inc', evidenceLane: 'official statistics' }),
      claim({ id: 'b', sourceGroup: 'release:vendor inc', evidenceLane: 'official statistics' }),
    ];
    const result = applyGate({
      fragment: fragment({ minIndependentSources: 2 }),
      claims,
      verification: verificationFor(claims),
    });
    expect(result.independentSources).toBe(1);
    expect(result.sufficiency).toBe('INSUFFICIENT');
    expect(result.reasons.join(' ')).toMatch(/independent source/i);
    expect(result.duplicateSourceGroups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Splitting and dependencies
// ---------------------------------------------------------------------------

describe('a fragment that is really several', () => {
  it('is split when it asks more than one question', () => {
    const signal = shouldSplit(
      fragment({
        question: 'What is employment in the occupation? And what do the agencies charge for it?',
      }),
      null,
    );
    expect(signal).toBeTruthy();
    expect(signal!.questions).toHaveLength(2);
    expect(signal!.reason).toMatch(/more than one question/i);
  });

  it('is split when some evidence lanes are complete and others are empty', () => {
    const target = fragment({ requiredEvidence: ['statutory text', 'regulator guidance'] });
    const signal = shouldSplit(target, {
      integrity: 'PASS',
      sufficiency: 'INSUFFICIENT',
      claims: [],
      acceptedClaims: 2,
      rejectedClaims: 0,
      independentSources: 2,
      coverage: [
        { lane: 'statutory text', acceptedClaims: 2, independentSources: 2, meetsThreshold: true },
        { lane: 'regulator guidance', acceptedClaims: 0, independentSources: 0, meetsThreshold: false },
      ],
      duplicateSourceGroups: [],
      failedConditions: ['COVERAGE'],
      reasons: [],
      unresolvedGaps: [],
    });

    expect(signal).toBeTruthy();
    expect(signal!.questions).toHaveLength(1);
    expect(signal!.questions[0]).toMatch(/regulator guidance/);
  });

  it('is left alone when it is one bounded question', () => {
    expect(shouldSplit(fragment(), null)).toBeNull();
  });
});

describe('the dependency graph', () => {
  it('orders foundations before what rests on them', () => {
    const fragments = [
      fragment({ fragmentKey: 'downstream', dependsOn: ['definition'], priority: 5 }),
      fragment({ fragmentKey: 'definition', dependsOn: [], priority: 1 }),
    ];
    const plan = planDependencies(fragments);
    expect(plan.order.indexOf('definition')).toBeLessThan(plan.order.indexOf('downstream'));
    expect(plan.cycles).toHaveLength(0);
  });

  it('surfaces a circular dependency instead of quietly picking a side', () => {
    const fragments = [
      fragment({ fragmentKey: 'a', dependsOn: ['b'] }),
      fragment({ fragmentKey: 'b', dependsOn: ['a'] }),
    ];
    const plan = planDependencies(fragments);
    expect(plan.cycles.length).toBeGreaterThan(0);
    expect(plan.cycles[0]!.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a dependency on a fragment nobody planned', () => {
    const plan = planDependencies([fragment({ fragmentKey: 'a', dependsOn: ['missing'] })]);
    expect(plan.danglingDependencies).toEqual([{ key: 'a', missing: ['missing'] }]);
  });
});
