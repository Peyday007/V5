/**
 * New evidence against old evidence.
 *
 * The interesting cases are the ones where two claims disagree and the
 * disagreement is not a conflict: a figure for a different year, a different
 * population, a definition three words wider. Filing those as contradictions
 * produces a report full of caveats nobody can act on; averaging them produces
 * a number nobody measured. Both are worse than saying which of the two the
 * assignment asked for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { importFile } from '../server/services/importer.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  decideClaim,
  getFragment,
  insertClaims,
  listClaimsForFragment,
} from '../server/repos/research.ts';
import {
  createRequirements,
  insertExistingClaims,
  listCoverage,
  listExistingClaims,
} from '../server/repos/reconciliation.ts';
import {
  planContradictionFragments,
  reconcileAcceptedFragment,
} from '../server/services/research/replan.ts';
import { PRIORITY_TIERS } from '../server/services/research/quota.ts';
import { classifyContradiction } from '../server/services/research/contradictions.ts';
import { classifyFinding } from '../server/services/research/replan.ts';
import type { ExistingClaim, ResearchClaim } from '../server/domain/types.ts';

function found(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    claimType: 'SOURCED_FACT',
    sourceGroup: 'host:bls.gov',
    primarySource: true,
    geography: 'United States',
    timeframe: '2023',
    population: 'B2B firms',
    definition: 'Outsourced SDR: an external firm booking qualified meetings.',
    requirementIds: ['req_1'],
    jobId: null,
    reconciliation: null,
    reconciledClaimId: null,
    contradictionKind: null,
    reconciliationDetail: null,
    id: 'clm_new',
    orchestrationId: 'orch_1',
    fragmentId: 'frg_1',
    passId: null,
    passKey: 'BROAD_SCAN',
    claim: 'Employment in the outsourced SDR occupation was 81,580 in 2023.',
    sourceUrl: 'https://www.bls.gov/oes/current/oes419041.htm',
    sourceTitle: 'Occupational Employment and Wage Statistics',
    sourcePublisher: 'Bureau of Labor Statistics',
    sourceDate: '2024-04-03',
    evidenceExcerpt: 'Employment: 81,580',
    evidenceLocator: 'National estimates table',
    evidenceLane: 'official statistics',
    retrievedAt: '2025-01-05',
    confidence: 0.8,
    contradictionState: 'UNCHALLENGED',
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

function archived(overrides: Partial<ExistingClaim> = {}): ExistingClaim {
  return {
    id: 'exc_1',
    projectId: 'proj_1',
    documentId: 'doc_1',
    extractionRunId: 'ext_1',
    layerId: 'layer_1',
    claim: 'Employment in the outsourced SDR occupation was 81,580 in 2023.',
    claimType: 'SOURCED_FACT',
    page: 3,
    blockIndex: 4,
    charStart: 0,
    charEnd: 60,
    locator: 'page 3',
    sourceUrl: 'https://www.bls.gov/oes/current/oes419041.htm',
    sourceTitle: 'Occupational Employment and Wage Statistics',
    sourcePublisher: 'Bureau of Labor Statistics',
    sourceDate: '2024-04-03',
    retrievedAt: null,
    supportingPassage: 'Employment: 81,580',
    geography: 'United States',
    timeframe: '2023',
    population: 'B2B firms',
    definition: 'Outsourced SDR: an external firm booking qualified meetings.',
    extractionConfidence: 0.9,
    evidenceConfidence: 0.8,
    contradictionState: 'UNCHALLENGED',
    verificationState: 'VERIFIED',
    verificationDetail: null,
    priorAuditId: null,
    documentVersion: 'v1',
    superseded: false,
    ...overrides,
  } as ExistingClaim;
}

describe('how two claims disagree', () => {
  it('calls a different definition a definition mismatch, not a conflict', () => {
    const verdict = classifyContradiction(
      {
        claim: 'There are 81,580 of them.',
        geography: 'United States',
        timeframe: '2023',
        population: 'B2B firms',
        definition: 'Firms booking qualified meetings.',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'BLS',
      },
      {
        claim: 'There are 240,000 of them.',
        geography: 'United States',
        timeframe: '2023',
        population: 'B2B firms',
        definition: 'Any contractor making outbound calls.',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'A consultancy',
      },
    );
    expect(verdict.kind).toBe('DEFINITION_MISMATCH');
    expect(verdict.material).toBe(false);
    // What settles it is a decision about scope, not more research into who is right.
    expect(verdict.resolutionQuestion).toMatch(/which definition/i);
  });

  it('separates a different year, place and population from a real conflict', () => {
    const base = {
      claim: 'The figure is 100.',
      geography: 'United States',
      timeframe: '2023',
      population: 'B2B firms',
      definition: 'One definition.',
      claimType: 'SOURCED_FACT',
      sourcePublisher: 'A',
    };
    expect(classifyContradiction(base, { ...base, timeframe: '2019', claim: 'The figure is 60.' }).kind).toBe(
      'TIMEFRAME_MISMATCH',
    );
    expect(
      classifyContradiction(base, { ...base, geography: 'Canada', claim: 'The figure is 12.' }).kind,
    ).toBe('GEOGRAPHY_MISMATCH');
    expect(
      classifyContradiction(base, { ...base, population: 'Consumer households', claim: 'The figure is 9.' })
        .kind,
    ).toBe('POPULATION_MISMATCH');
  });

  it('does not treat two projections as a factual conflict', () => {
    const verdict = classifyContradiction(
      {
        claim: 'The market will reach 4 billion by 2030.',
        geography: 'United States',
        timeframe: '2030',
        population: 'B2B firms',
        definition: 'One definition.',
        claimType: 'FORECAST',
        sourcePublisher: 'A',
      },
      {
        claim: 'The market will reach 9 billion by 2030.',
        geography: 'United States',
        timeframe: '2030',
        population: 'B2B firms',
        definition: 'One definition.',
        claimType: 'FORECAST',
        sourcePublisher: 'B',
      },
    );
    expect(verdict.kind).toBe('FORECAST_DISAGREEMENT');
    expect(verdict.material).toBe(false);
    expect(verdict.resolutionQuestion).toMatch(/methodology and assumptions/i);
  });

  it('recognises two measurements of the same thing inside their own uncertainty', () => {
    const verdict = classifyContradiction(
      {
        claim: 'Approximately 81,000 people, plus or minus 3,000.',
        geography: 'US',
        timeframe: '2023',
        population: 'p',
        definition: 'd',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'A',
      },
      {
        claim: 'About 82,000 people.',
        geography: 'US',
        timeframe: '2023',
        population: 'p',
        definition: 'd',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'B',
      },
    );
    expect(verdict.kind).toBe('MEASUREMENT_UNCERTAINTY');
    expect(verdict.material).toBe(false);
  });

  it('flags different methods as material without calling either one wrong', () => {
    const verdict = classifyContradiction(
      {
        claim: 'A survey of members put the figure at 40,000.',
        geography: 'US',
        timeframe: '2023',
        population: 'p',
        definition: 'd',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'A',
      },
      {
        claim: 'Administrative records put the figure at 81,000.',
        geography: 'US',
        timeframe: '2023',
        population: 'p',
        definition: 'd',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'B',
      },
    );
    expect(verdict.kind).toBe('METHODOLOGICAL_DIFFERENCE');
    expect(verdict.material).toBe(true);
    // The one thing that is never the answer.
    expect(verdict.reason).toMatch(/must not be combined/i);
  });

  it('calls a same-scope disagreement what it is', () => {
    const verdict = classifyContradiction(
      {
        claim: 'The figure is 81,000.',
        geography: 'US',
        timeframe: '2023',
        population: 'p',
        definition: 'd',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'BLS',
      },
      {
        claim: 'The figure is 240,000.',
        geography: 'US',
        timeframe: '2023',
        population: 'p',
        definition: 'd',
        claimType: 'SOURCED_FACT',
        sourcePublisher: 'A consultancy',
      },
    );
    expect(verdict.kind).toBe('DIRECT_FACTUAL_CONFLICT');
    expect(verdict.material).toBe(true);
    expect(verdict.resolutionQuestion).toMatch(/which primary source resolves/i);
  });
});

describe('what a finding does to the archive', () => {
  it('confirms an existing claim from the same publisher, and strengthens one from another', () => {
    const sameSource = classifyFinding(found({ sourceUrl: 'https://www.bls.gov/other-page.htm' }), [
      archived(),
    ]);
    expect(sameSource.outcome).toBe('CONFIRMS');
    expect(sameSource.againstClaimId).toBe('exc_1');

    const otherPublisher = classifyFinding(
      found({
        sourceUrl: 'https://www.census.gov/programs-surveys/susb.html',
        sourcePublisher: 'Census Bureau',
      }),
      [archived()],
    );
    expect(otherPublisher.outcome).toBe('STRENGTHENS');
  });

  it('reports a duplicate as a duplicate rather than as corroboration', () => {
    // The same page, found again, is not a second source.
    expect(classifyFinding(found(), [archived()]).outcome).toBe('DUPLICATES');
  });

  it('updates stale evidence without overwriting it', () => {
    const finding = classifyFinding(
      found({
        claim: 'Employment in the outsourced SDR occupation was 84,100 in 2024.',
        timeframe: '2024',
        sourceDate: '2025-04-01',
        sourceUrl: 'https://www.bls.gov/oes/2024/oes419041.htm',
      }),
      [archived({ timeframe: '2023', sourceDate: '2024-04-03' })],
    );
    expect(finding.outcome).toBe('UPDATES_STALE');
    // Both claims survive; what changes is which one the requirement rests on.
    expect(finding.againstClaimId).toBe('exc_1');
    expect(finding.detail).toMatch(/both are kept/i);
  });

  it('contradicts an existing claim when the scopes match and the figures do not', () => {
    const finding = classifyFinding(
      found({
        claim: 'Employment in the outsourced SDR occupation was 240,000 in 2023.',
        sourceUrl: 'https://example.org/report',
        sourcePublisher: 'A consultancy',
        primarySource: false,
      }),
      [archived()],
    );
    expect(finding.outcome).toBe('CONTRADICTS');
    expect(finding.contradiction?.kind).toBe('DIRECT_FACTUAL_CONFLICT');
  });

  it('fills a gap when the archive says nothing about it', () => {
    const finding = classifyFinding(
      found({ claim: 'Sixty-two percent of custody transfers settle within three days.' }),
      [archived()],
    );
    expect(finding.outcome).toBe('FILLS_GAP');
    expect(finding.againstClaimId).toBeNull();
  });

  it('records a rejected claim as failing its requirement, not as evidence', () => {
    const finding = classifyFinding(
      found({ accepted: false, rejectionReason: 'No source URL was given.' }),
      [archived()],
    );
    expect(finding.outcome).toBe('FAILS_REQUIREMENT');
    expect(finding.detail).toMatch(/no source url/i);
  });
});

// ---------------------------------------------------------------------------
// Replanning against the database
// ---------------------------------------------------------------------------

describe('replanning after evidence lands', () => {
  let fixture: TestProject;

  beforeEach(() => {
    fixture = freshProject();
  });
  afterEach(() => {
    teardown();
  });

  /** An assignment with one requirement and two fragments chasing it. */
  function assignment() {
    const layer = fixture.layerByName('World Model');
    const run = createRun({
      projectId: fixture.project.id,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'RUNNING',
    });
    const orchestration = createOrchestration({
      projectId: fixture.project.id,
      layerId: layer.id,
      runId: run.id,
      title: 'Custody recognition',
      assignment: 'Establish how custody transfer is recognised.',
      provider: 'mock',
    });
    const [requirement] = createRequirements([
      {
        orchestrationId: orchestration.id,
        projectId: fixture.project.id,
        layerId: layer.id,
        requirementKey: 'employment-figure',
        ordinal: 0,
        statement: 'How many people work in the occupation?',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
        requiredEvidence: ['official statistics'],
        completionCriteria: ['a sourced figure'],
        dependsOn: [],
      },
    ]);
    return { orchestration, requirement: requirement!, layer };
  }

  function planFragment(input: {
    orchestrationId: string;
    layerId: string;
    key: string;
    requirementIds: string[];
    index: number;
    status?: 'QUEUED' | 'RUNNING';
  }) {
    const [created] = createFragments([
      {
        orchestrationId: input.orchestrationId,
        projectId: fixture.project.id,
        layerId: input.layerId,
        fragmentIndex: input.index,
        fragmentKey: input.key,
        question: 'How many people work in the occupation?',
        requiredEvidence: ['official statistics'],
        acceptableSourceTypes: ['government dataset'],
        excludedSourceTypes: [],
        completionCriteria: ['a sourced figure'],
        dependsOn: [],
        minIndependentSources: 2,
        status: input.status ?? 'QUEUED',
        requirementIds: input.requirementIds,
        evidenceLane: 'official statistics',
      },
    ]);
    return created!;
  }

  /** The fields every stored claim needs, so a test only states what it means. */
  function claimInput(input: {
    orchestrationId: string;
    fragmentId: string;
    claim: string;
    sourceUrl: string;
    sourcePublisher: string;
    excerpt: string;
    requirementIds: string[];
  }) {
    return {
      orchestrationId: input.orchestrationId,
      fragmentId: input.fragmentId,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: input.claim,
      sourceUrl: input.sourceUrl,
      sourceTitle: 'A source',
      sourcePublisher: input.sourcePublisher,
      sourceDate: '2024-04-03',
      evidenceExcerpt: input.excerpt,
      evidenceLocator: 'table 1',
      evidenceLane: 'official statistics',
      retrievedAt: '2025-01-05',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      sourceGroup: `host:${new URL(input.sourceUrl).hostname.replace(/^www\./, '')}`,
      geography: 'United States',
      timeframe: '2023',
      requirementIds: input.requirementIds,
      contentHash: `${input.claim}|${input.sourceUrl}`,
    };
  }

  it('cancels queued work that the accepted evidence made unnecessary', async () => {
    const { orchestration, requirement, layer } = assignment();
    const answered = planFragment({
      orchestrationId: orchestration.id,
      layerId: layer.id,
      key: 'fragment-1',
      requirementIds: [requirement.id],
      index: 0,
      status: 'RUNNING',
    });
    const alsoQueued = planFragment({
      orchestrationId: orchestration.id,
      layerId: layer.id,
      key: 'fragment-2',
      requirementIds: [requirement.id],
      index: 1,
    });

    const inserted = insertClaims([
      claimInput({
        orchestrationId: orchestration.id,
        fragmentId: answered.id,
        claim: 'Employment in the occupation was 81,580 in 2023.',
        sourceUrl: 'https://www.bls.gov/oes/current/oes419041.htm',
        sourcePublisher: 'Bureau of Labor Statistics',
        excerpt: 'Employment: 81,580',
        requirementIds: [requirement.id],
      }),
      claimInput({
        orchestrationId: orchestration.id,
        fragmentId: answered.id,
        claim: 'Employment in the occupation was about 81,000 in 2023.',
        sourceUrl: 'https://www.census.gov/programs-surveys/susb.html',
        sourcePublisher: 'Census Bureau',
        excerpt: 'About 81,000',
        requirementIds: [requirement.id],
      }),
    ]);
    for (const claim of inserted) decideClaim(claim.id, { accepted: true });

    const result = reconcileAcceptedFragment({
      orchestrationId: orchestration.id,
      projectId: fixture.project.id,
      fragment: getFragment(answered.id)!,
    });

    // The requirement is now covered by evidence from two publishers.
    expect(result.requirementsUpdated).toContain(requirement.id);
    const coverage = listCoverage(orchestration.id).find(
      (entry) => entry.requirementId === requirement.id,
    )!;
    expect(coverage.status).toBe('SATISFIED');
    expect(coverage.needsResearch).toBe(false);

    // So the other fragment chasing it is cancelled before it spends a job.
    expect(result.cancelledFragments.map((entry) => entry.fragmentKey)).toContain('fragment-2');
    const cancelled = getFragment(alsoQueued.id)!;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledReason).toMatch(/already has an answer/i);

    // Every finding carries what it did to the archive, not just that it landed.
    const stored = listClaimsForFragment(answered.id);
    expect(stored.every((claim) => claim.reconciliation !== null)).toBe(true);
  });

  it('keeps the requirement open, and the work queued, when the finding contradicts the archive', async () => {
    const { orchestration, requirement, layer } = assignment();
    const documentId = importFile({
      projectId: fixture.project.id,
      originalFilename: 'World Model v1.txt',
      contents: Buffer.from('Employment in the occupation was 240,000 in 2023.'),
      layerId: layer.id,
      version: 'v1',
      documentType: 'FOUNDATION',
    }).documentId!;
    await whenExtractionIdle();

    insertExistingClaims([
      {
        projectId: fixture.project.id,
        documentId,
        extractionRunId: null,
        layerId: layer.id,
        claim: 'Employment in the occupation was 240,000 in 2023.',
        claimType: 'SOURCED_FACT',
        sourceUrl: 'https://example.org/consultancy-report',
        sourcePublisher: 'A consultancy',
        sourceDate: '2024-01-01',
        geography: 'United States',
        timeframe: '2023',
        supportingPassage: 'Employment in the occupation was 240,000 in 2023.',
        verificationState: 'VERIFIED',
        extractionConfidence: 0.9,
        evidenceConfidence: 0.8,
        contentHash: 'archive-claim-hash',
      },
    ]);

    const answered = planFragment({
      orchestrationId: orchestration.id,
      layerId: layer.id,
      key: 'fragment-1',
      requirementIds: [requirement.id],
      index: 0,
      status: 'RUNNING',
    });
    const queued = planFragment({
      orchestrationId: orchestration.id,
      layerId: layer.id,
      key: 'fragment-2',
      requirementIds: [requirement.id],
      index: 1,
    });

    const [claim] = insertClaims([
      claimInput({
        orchestrationId: orchestration.id,
        fragmentId: answered.id,
        claim: 'Employment in the occupation was 81,580 in 2023.',
        sourceUrl: 'https://www.bls.gov/oes/current/oes419041.htm',
        sourcePublisher: 'Bureau of Labor Statistics',
        excerpt: 'Employment: 81,580',
        requirementIds: [requirement.id],
      }),
    ]);
    decideClaim(claim!.id, { accepted: true });

    const result = reconcileAcceptedFragment({
      orchestrationId: orchestration.id,
      projectId: fixture.project.id,
      fragment: getFragment(answered.id)!,
    });

    expect(result.findings[0]!.outcome).toBe('CONTRADICTS');
    expect(result.contradictionsToResolve).toHaveLength(1);

    // A requirement answered two incompatible ways is not answered.
    const coverage = listCoverage(orchestration.id).find(
      (entry) => entry.requirementId === requirement.id,
    )!;
    expect(coverage.status).toBe('CONTRADICTED');
    expect(coverage.needsResearch).toBe(true);
    expect(getFragment(queued.id)!.status).toBe('QUEUED');

    // The archive's claim is still there. New evidence never overwrites it.
    expect(listExistingClaims(fixture.project.id)).toHaveLength(1);

    // And the conflict becomes a fragment whose job is to settle it.
    const resolution = planContradictionFragments({
      orchestrationId: orchestration.id,
      parent: getFragment(answered.id)!,
      contradictions: result.contradictionsToResolve,
      maxFragments: 60,
    });
    expect(resolution).toHaveLength(1);
    expect(resolution[0]!.contradictionTargets).toHaveLength(2);
    expect(resolution[0]!.minIndependentSources).toBe(3);
    // It runs before ordinary evidence work, because everything built on either
    // claim is unsafe until it is settled.
    expect(resolution[0]!.priority).toBe(PRIORITY_TIERS.indexOf('CONTRADICTION_RESOLUTION') + 1);

    // Asked again, it does not plan the same fragment twice.
    expect(
      planContradictionFragments({
        orchestrationId: orchestration.id,
        parent: getFragment(answered.id)!,
        contradictions: result.contradictionsToResolve,
        maxFragments: 60,
      }),
    ).toHaveLength(0);
  });
});
