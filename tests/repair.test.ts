/**
 * What a second attempt is told.
 *
 * The failure mode this file exists to prevent is the retry disguised as a
 * repair: the same prompt, the same search, the same sources, a wasted slice of
 * the user's allowance, and then a fragment abandoned as unanswerable when what
 * was unanswerable was that one search. So every plan here has to differ from
 * the ones before it, and when the ladder runs out the plan says to report the
 * gap rather than to try again.
 */
import { describe, expect, it } from 'vitest';
import { buildRepairPlan, describeRepairPlan } from '../server/services/research/repair.ts';
import type { RepairPlan, ResearchClaim, ResearchFragment } from '../server/domain/types.ts';
import type { GateResult } from '../server/services/research/gate.ts';

function fragment(overrides: Partial<ResearchFragment> = {}): ResearchFragment {
  return {
    requirementIds: ['req_1'],
    evidenceLane: 'official statistics',
    whyItMatters: 'The layer cannot be written without it.',
    missingEvidence: 'A published figure for the occupation.',
    whyExistingInsufficient: 'Nothing in the project measures it.',
    existingClaimIds: [],
    excludedScope: null,
    expectedClaimTypes: ['SOURCED_FACT'],
    preferredSourceTypes: ['official statistics'],
    prohibitedEvidence: [],
    requiredComparisons: [],
    requiredCalculations: [],
    contradictionTargets: [],
    failureConditions: [],
    uncertaintyTolerance: null,
    priority: 5,
    estimatedEffort: 'MEDIUM',
    maxRepairs: 2,
    splitFromId: null,
    repairPlan: null,
    cancelledReason: null,
    id: 'frg_1',
    orchestrationId: 'orch_1',
    projectId: 'proj_1',
    layerId: 'layer_1',
    fragmentIndex: 0,
    fragmentKey: 'fragment-1',
    question: 'How many people work in the outsourced SDR occupation?',
    geography: 'United States',
    timeframe: '2023',
    population: 'B2B firms',
    definitions: 'Outsourced SDR: an external firm booking qualified meetings.',
    requiredEvidence: [{ id: 'official_statistics', description: 'official statistics', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['government dataset'],
    excludedSourceTypes: [],
    completionCriteria: ['a figure with its definition'],
    dependsOn: [],
    minIndependentSources: 2,
    nextRetryAt: null,
    status: 'BLOCKED',
    attempt: 1,
    parentFragmentId: null,
    repairReason: null,
    repairStrategy: null,
    integrityVerdict: 'PASS',
    sufficiencyVerdict: 'INSUFFICIENT',
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

function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    claimType: 'SOURCED_FACT',
    sourceGroup: 'host:bls.gov',
    primarySource: true,
    geography: 'United States',
    timeframe: '2023',
    population: 'B2B firms',
    definition: null,
    requirementIds: ['req_1'],
    jobId: null,
    reconciliation: null,
    reconciledClaimId: null,
    contradictionKind: null,
    reconciliationDetail: null,
    id: 'clm_1',
    orchestrationId: 'orch_1',
    fragmentId: 'frg_1',
    passId: null,
    passKey: 'BROAD_SCAN',
    claim: 'Employment in the occupation was 81,580.',
    sourceUrl: 'https://www.bls.gov/oes/current/oes419041.htm',
    sourceTitle: 'Occupational Employment and Wage Statistics',
    sourcePublisher: 'Bureau of Labor Statistics',
    sourceDate: '2024-04-03',
    evidenceExcerpt: 'Employment: 81,580 telemarketers employment estimate',
    evidenceLocator: 'National estimates table',
    evidenceLane: 'official statistics',
    retrievedAt: '2025-01-05',
    confidence: 0.8,
    contradictionState: 'UNCHALLENGED',
    retrievalState: 'RETRIEVED',
    contradictionNote: null,
    validationState: 'SOURCED',
    validationDetail: null,
    sourced: true,
    derived: false,
    derivedFrom: [],
    accepted: true,
    rejectionReason: null,
    scopeMatch: null,
    contentHash: 'hash',
    createdAt: '2025-01-05T00:00:00.000Z',
    ...overrides,
  };
}

function gate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    integrity: 'PASS',
    sufficiency: 'INSUFFICIENT',
    claims: [],
    acceptedClaims: 2,
    rejectedClaims: 0,
    independentSources: 1,
    coverage: [],
    duplicateSourceGroups: [],
    failedConditions: ['COVERAGE'],
    reasons: ['The accepted evidence rests on one publisher.'],
    unresolvedGaps: [],
    unresolvedRetrieval: [],
    ...overrides,
  };
}

describe('a repair plan', () => {
  it('says what failed, where has been searched, and what to try instead', () => {
    const plan = buildRepairPlan({
      fragment: fragment(),
      gate: gate(),
      history: [fragment()],
      claims: [claim(), claim({ id: 'clm_2', sourceUrl: 'https://www.bls.gov/two.htm' })],
      splitRequired: false,
      remainingBudget: 2,
    });

    expect(plan.missingEvidence).toMatch(/different publishers/i);
    expect(plan.ecosystemsAttempted).toEqual(['bls.gov']);
    expect(plan.alternativeEcosystems.length).toBeGreaterThan(0);
    expect(plan.strategies.length).toBeGreaterThan(0);
    expect(plan.strategies).not.toContain('MARK_UNRESOLVED');
    expect(plan.remainingBudget).toBe(2);

    const text = describeRepairPlan(plan);
    expect(text).toMatch(/already searched/i);
    expect(text).toMatch(/bls\.gov/);
    expect(text).toMatch(/2 attempts remain/);
  });

  /**
   * The failure the first fresh acceptance packet was told it had, and did not.
   *
   * Five fragments returned claims that were sourced, verified, in scope and
   * accepted, and every declared lane read empty because none of them carried
   * an `evidence_lane`. The plan said "No accepted evidence in: statute" — so
   * the repair went looking for a statute the fragment had already quoted,
   * spent the attempt, and failed identically.
   *
   * A plan that misdiagnoses is worse than no plan: it converts a free
   * correction into a spent research attempt.
   */
  it('says the evidence is unlabelled, not missing, when that is what happened', () => {
    const plan = buildRepairPlan({
      fragment: fragment({ requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }] }),
      gate: gate({
        coverage: [{ lane: 'statute', description: 'statute', necessity: 'REQUIRED', acceptedClaims: 0, independentSources: 0, meetsThreshold: false }],
      }),
      history: [fragment()],
      claims: [
        claim({ accepted: true, evidenceLane: null }),
        claim({ id: 'clm_2', accepted: true, evidenceLane: null }),
      ],
      splitRequired: false,
      remainingBudget: 2,
    });

    expect(plan.missingEvidence).toMatch(/carry no evidence lane/i);
    expect(plan.missingEvidence).toMatch(/not missing — it is unlabelled/i);
    expect(plan.missingEvidence).toContain('statute');
  });

  /**
   * A repair is planned for lanes that actually blocked, and nothing else.
   *
   * A CONDITIONAL lane left empty does not fail the fragment, so naming it as
   * missing evidence would spend a research attempt filling something that
   * cost nothing — and would send the worker looking for a regulator advisory
   * that the gate has already accepted may not exist.
   */
  it('names only the lanes that actually blocked, not the optional ones', () => {
    const plan = buildRepairPlan({
      fragment: fragment({
        requiredEvidence: [
          { id: 'operative_authority', description: 'The statute.', necessity: 'REQUIRED' },
          { id: 'regulator_guidance', description: 'Guidance, if any.', necessity: 'CONDITIONAL' },
          { id: 'commentary', description: 'Commentary.', necessity: 'OPTIONAL' },
        ],
      }),
      gate: gate({
        coverage: [
          {
            lane: 'operative_authority',
            description: 'The statute.',
            necessity: 'REQUIRED',
            acceptedClaims: 0,
            independentSources: 0,
            meetsThreshold: false,
          },
          {
            lane: 'regulator_guidance',
            description: 'Guidance, if any.',
            necessity: 'CONDITIONAL',
            acceptedClaims: 0,
            independentSources: 0,
            meetsThreshold: false,
          },
          {
            lane: 'commentary',
            description: 'Commentary.',
            necessity: 'OPTIONAL',
            acceptedClaims: 0,
            independentSources: 0,
            meetsThreshold: false,
          },
        ],
      }),
      history: [fragment()],
      claims: [claim({ accepted: false, evidenceLane: 'operative_authority' })],
      splitRequired: false,
      remainingBudget: 2,
    });

    // The id that blocked, and the description saying what it asks for.
    expect(plan.missingEvidence).toContain('operative_authority');
    expect(plan.missingEvidence).toContain('The statute.');
    // Not the ones that did not.
    expect(plan.missingEvidence).not.toContain('regulator_guidance');
    expect(plan.missingEvidence).not.toContain('commentary');
  });

  it('still says the evidence is missing when the lane is genuinely empty', () => {
    const plan = buildRepairPlan({
      fragment: fragment({ requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }] }),
      gate: gate({
        coverage: [{ lane: 'statute', description: 'statute', necessity: 'REQUIRED', acceptedClaims: 0, independentSources: 0, meetsThreshold: false }],
      }),
      history: [fragment()],
      // Tagged, and rejected — so the lane really has nothing in it.
      claims: [claim({ accepted: false, evidenceLane: 'statute' })],
      splitRequired: false,
      remainingBudget: 2,
    });

    expect(plan.missingEvidence).toMatch(/no accepted evidence in: statute/i);
    expect(plan.missingEvidence).not.toMatch(/unlabelled/i);
  });

  it('takes its alternative terminology from what the sources actually said', () => {
    const plan = buildRepairPlan({
      fragment: fragment({ question: 'How many people work in the occupation?' }),
      gate: gate({ failedConditions: ['SCOPE_MATCH'] }),
      history: [fragment()],
      claims: [
        claim({ evidenceExcerpt: 'telemarketers employment estimate' }),
        claim({ id: 'clm_2', evidenceExcerpt: 'telemarketers employment estimate' }),
      ],
      splitRequired: false,
      remainingBudget: 2,
    });
    // "telemarketers" is what the source calls it; the fragment never said it.
    expect(plan.alternativeTerminology).toContain('telemarketers');
  });

  it('never repeats a strategy an earlier attempt already used', () => {
    const first = buildRepairPlan({
      fragment: fragment(),
      gate: gate(),
      history: [fragment()],
      claims: [claim()],
      splitRequired: false,
      remainingBudget: 3,
    });
    const attemptTwo = fragment({ id: 'frg_2', attempt: 2, repairPlan: first });

    const second = buildRepairPlan({
      fragment: attemptTwo,
      gate: gate(),
      history: [fragment(), attemptTwo],
      claims: [claim({ sourceUrl: 'https://www.census.gov/data.html' })],
      splitRequired: false,
      remainingBudget: 2,
    });
    for (const strategy of second.strategies) {
      expect(first.strategies).not.toContain(strategy);
    }
  });

  it('offers classification codes when the evidence kept measuring the wrong thing', () => {
    const plan = buildRepairPlan({
      fragment: fragment(),
      gate: gate({ failedConditions: ['SCOPE_MATCH'] }),
      history: [fragment()],
      claims: [claim({ accepted: false, rejectionReason: 'Measured a different population.' })],
      splitRequired: false,
      remainingBudget: 3,
    });
    expect(plan.strategies).toContain('USE_CLASSIFICATION_CODES');
    expect(plan.alternativeClassifications.length).toBeGreaterThan(0);
    expect(plan.affectedClaims[0]!.why).toMatch(/different population/i);
  });

  it('recovers a canonical link when the source did not support the claim', () => {
    const plan = buildRepairPlan({
      fragment: fragment(),
      gate: gate({ failedConditions: ['SOURCE_SUPPORTS'], integrity: 'FAIL' }),
      history: [fragment()],
      claims: [claim({ accepted: false, rejectionReason: 'The page does not state this.' })],
      splitRequired: false,
      remainingBudget: 3,
    });
    expect(plan.strategies).toContain('RESOLVE_CANONICAL_LINK');
    expect(describeRepairPlan(plan)).toMatch(/canonical version/i);
    expect(plan.rejectedEvidence).toContain('https://www.bls.gov/oes/current/oes419041.htm');
  });

  it('carries the unresolved contradiction into the next attempt', () => {
    const plan = buildRepairPlan({
      fragment: fragment(),
      gate: gate({ failedConditions: ['CONTRADICTIONS'] }),
      history: [fragment()],
      claims: [
        claim({
          contradictionState: 'CONTESTED',
          retrievalState: 'RETRIEVED',
          contradictionNote: 'Another agency publishes a different figure.',
        }),
      ],
      splitRequired: false,
      remainingBudget: 2,
    });
    expect(plan.unresolvedContradiction).toMatch(/different figure/i);
    expect(describeRepairPlan(plan)).toMatch(/unresolved contradiction to settle/i);
  });

  it('narrows the question to the part evidence can actually support', () => {
    // The ladder tries the searches that could still find the right measure
    // first; when those are used up, narrowing is the honest response — answer
    // the part a source states directly and say plainly what is not covered.
    const first = buildRepairPlan({
      fragment: fragment(),
      gate: gate({ failedConditions: ['SCOPE_MATCH'] }),
      history: [fragment()],
      claims: [claim()],
      splitRequired: false,
      remainingBudget: 4,
    });
    const second = fragment({ id: 'frg_2', attempt: 2, repairPlan: first });

    const narrowed = buildRepairPlan({
      fragment: second,
      gate: gate({ failedConditions: ['SCOPE_MATCH'] }),
      history: [fragment(), second],
      claims: [claim()],
      splitRequired: false,
      remainingBudget: 3,
    });
    expect(narrowed.strategies).toContain('NARROW_THE_CLAIM');
    expect(narrowed.narrowerQuestion).toMatch(/only the part a published source states directly/i);
    expect(narrowed.narrowerQuestion).toMatch(/United States, 2023/);
    expect(describeRepairPlan(narrowed)).toMatch(/a narrower question worth answering/i);
  });

  it('says to report the gap rather than try again once the budget is spent', () => {
    const plan = buildRepairPlan({
      fragment: fragment(),
      gate: gate(),
      history: [fragment()],
      claims: [claim()],
      splitRequired: false,
      remainingBudget: 1,
    });
    expect(plan.strategies).toEqual(['MARK_UNRESOLVED']);
    const text = describeRepairPlan(plan);
    expect(text).toMatch(/last attempt/i);
    expect(text).toMatch(/list where you looked/i);
  });

  it('falls back to marking it unresolved when every strategy has been tried', () => {
    const everything: RepairPlan = {
      failedRequirement: 'x',
      affectedClaims: [],
      missingEvidence: 'x',
      rejectedEvidence: [],
      unresolvedContradiction: null,
      ecosystemsAttempted: [],
      alternativeEcosystems: [],
      alternativeTerminology: [],
      alternativeClassifications: [],
      narrowerQuestion: null,
      splitRequired: false,
      remainingBudget: 1,
      strategies: [
        'FIND_PRIMARY_DATA',
        'TRY_DIFFERENT_REPOSITORIES',
        'USE_OFFICIAL_FILINGS',
        'USE_REGULATORY_RECORDS',
        'USE_PROCUREMENT_RECORDS',
        'USE_CLASSIFICATION_CODES',
        'CHANGE_TERMINOLOGY',
        'NARROW_THE_CLAIM',
        'REPLACE_ESTIMATE_WITH_RANGE',
        'MARK_UNRESOLVED',
      ],
    };
    const plan = buildRepairPlan({
      fragment: fragment({ repairPlan: everything }),
      gate: gate(),
      history: [fragment({ repairPlan: everything })],
      claims: [claim()],
      splitRequired: false,
      remainingBudget: 5,
    });
    expect(plan.strategies).toEqual(['MARK_UNRESOLVED']);
  });
});
