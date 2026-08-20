/**
 * Reading what the project already knows, before researching anything.
 *
 * The behaviour under test is refusal in both directions: refusing to research a
 * requirement the archive already answers, and refusing to accept an answer that
 * only looks like one. The second is the harder half — a polished old report
 * asserting a number with no citation, a real figure about a different country,
 * a true statement from three years before the timeframe.
 *
 * These are not model calls. The claim reader and the coverage matrix are
 * deterministic, so what they conclude can be checked exactly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import type { BoundaryContract, Requirement } from '../server/domain/types.ts';
import { importFile } from '../server/services/importer.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { updateDocument } from '../server/repos/documents.ts';
import {
  createBoundaryContract,
  createRequirements,
  listCoverage,
  listExistingClaims,
  updateExistingClaim,
} from '../server/repos/reconciliation.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { inventoryDocument, extractClaimCandidates } from '../server/services/reconcile/claims.ts';
import { assessRequirement, buildCoverageMatrix } from '../server/services/reconcile/coverage.ts';
import {
  inventoryProject,
  planFragmentsFromGaps,
  reconcile,
} from '../server/services/reconcile/plan.ts';

let fixture: TestProject;
let orchestrationId: string;

/** An orchestration to hang requirements and coverage off. */
function newAssignment(): string {
  const layer = fixture.layerByName('World Model');
  const run = createRun({
    projectId: fixture.project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'RUNNING',
  });
  return createOrchestration({
    projectId: fixture.project.id,
    layerId: layer.id,
    runId: run.id,
    title: 'Custody recognition',
    assignment: 'Establish how custody transfer is recognised.',
    provider: 'mock',
  }).id;
}

function contract(overrides: Partial<Parameters<typeof createBoundaryContract>[0]> = {}): BoundaryContract {
  return createBoundaryContract({
    orchestrationId,
    projectId: fixture.project.id,
    layerId: fixture.layerByName('World Model').id,
    primaryQuestion: 'How is custody transfer recognised?',
    geography: 'United States',
    timeframe: '2023 onwards',
    population: 'distressed receivables',
    ...overrides,
  });
}

function requirement(statement: string, overrides: Partial<Requirement> = {}): Requirement {
  const [created] = createRequirements([
    {
      orchestrationId,
      projectId: fixture.project.id,
      layerId: fixture.layerByName('World Model').id,
      requirementKey: statement.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      ordinal: 0,
      statement,
      necessity: overrides.necessity ?? 'MANDATORY',
      kind: overrides.kind ?? 'RESEARCH',
      requiredEvidence: overrides.requiredEvidence ?? ['official statistics'],
      completionCriteria: ['a sourced figure'],
      dependsOn: [],
    },
  ]);
  return created!;
}

/** Import a document with known contents and read it. */
async function addDocument(name: string, text: string): Promise<string> {
  const result = importFile({
    projectId: fixture.project.id,
    originalFilename: name,
    contents: Buffer.from(text),
    layerId: fixture.layerByName('World Model').id,
    version: 'v1',
    documentType: 'FOUNDATION',
  });
  await whenExtractionIdle();
  return result.documentId!;
}

const SOURCED = [
  'Recognition of custody transfer in the United States',
  '',
  'Employment in the outsourced telemarketing occupation was 81,580 in 2024 according to the',
  'Bureau of Labor Statistics. https://www.bls.gov/oes/current/oes419041.htm',
  '',
  'Census Bureau statistics put employment in the same outsourced telemarketing occupation at a',
  'comparable level for 2023. https://www.census.gov/programs-surveys/susb.html',
  '',
  'Custody transfer is recognised at the point of the recorded act in 2024 filings.',
].join('\n');

beforeEach(() => {
  fixture = freshProject();
  orchestrationId = newAssignment();
});
afterEach(() => {
  teardown();
});

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

describe('claims are recovered from documents the project already has', () => {
  it('finds asserted sentences with the page and offsets that locate them', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    const candidates = extractClaimCandidates(documentId);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.claim.length).toBeGreaterThan(30);
      expect(candidate.charEnd).toBeGreaterThan(candidate.charStart);
      expect(candidate.locator).toMatch(/block \d+/);
    }
    // The citation next to a claim is credited to it.
    expect(candidates.some((candidate) => candidate.sourceUrl?.includes('bls.gov'))).toBe(true);
  });

  it('tells a sourced fact from an assertion nobody supported', async () => {
    const documentId = await addDocument(
      'World Model v1.txt',
      [
        'Employment was 81,580 in 2024 according to the agency.',
        'https://www.bls.gov/oes/current/oes419041.htm',
        '',
        'The outsourced market is worth approximately 4 billion dollars in 2024.',
      ].join('\n'),
    );
    const claims = inventoryDocument(documentId);

    const sourced = claims.find((claim) => claim.sourceUrl !== null);
    const unsupported = claims.find((claim) => claim.claim.includes('4 billion'));
    expect(sourced?.claimType).toBe('SOURCED_FACT');
    expect(unsupported?.claimType).toBe('UNSUPPORTED_ASSERTION');
    expect(unsupported?.evidenceConfidence).toBeLessThan(sourced!.evidenceConfidence);
  });

  it('labels forecasts, calculations, self-reports and claimed absences separately', async () => {
    const documentId = await addDocument(
      'World Model v1.txt',
      [
        'The market is expected to reach 9 billion dollars by 2032 on current trends.',
        '',
        'Total spend is calculated as 81,580 multiplied by the average annual contract value.',
        '',
        'According to its own website, the company states that it books 40 meetings a month.',
        '',
        'No public dataset separates B2B appointment setting from consumer telemarketing.',
      ].join('\n'),
    );
    const types = new Set(inventoryDocument(documentId).map((claim) => claim.claimType));

    expect(types.has('FORECAST')).toBe(true);
    expect(types.has('CALCULATION')).toBe(true);
    expect(types.has('SELF_REPORT')).toBe(true);
    expect(types.has('NEGATIVE_EXISTENCE')).toBe(true);
  });

  it('re-reading a document replaces its claims rather than doubling them', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    const first = inventoryDocument(documentId);
    const second = inventoryDocument(documentId);
    expect(second).toHaveLength(first.length);
    expect(listExistingClaims(fixture.project.id)).toHaveLength(first.length);
  });

  it('does not inventory a document nobody could read', async () => {
    const documentId = await addDocument('World Model v1.txt', 'too short');
    const inventory = inventoryProject(fixture.project.id);
    expect(inventory.claims.filter((claim) => claim.documentId === documentId)).toHaveLength(0);
    expect(inventory.documentsUnreadable).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The coverage matrix
// ---------------------------------------------------------------------------

describe('the coverage matrix', () => {
  it('marks a requirement satisfied when corroborated evidence answers it', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    const claims = inventoryDocument(documentId);
    const target = requirement('Employment in the outsourced telemarketing occupation');

    const assessment = assessRequirement(target, claims, contract());
    expect(assessment.status).toBe('SATISFIED');
    expect(assessment.needsResearch).toBe(false);
    expect(assessment.claimIds.length).toBeGreaterThan(0);
    expect(assessment.reasons.join(' ')).toMatch(/publisher/i);
  });

  it('marks an answer with no checkable source PRESENT_BUT_UNVERIFIED', async () => {
    const documentId = await addDocument(
      'World Model v1.txt',
      [
        'Outsourced appointment setting employment stands at roughly 80,000 people in 2024.',
        'This is well understood across the industry and needs no further support.',
        'Outsourced appointment setting employment has been stable for several years in 2024.',
      ].join('\n'),
    );
    const claims = inventoryDocument(documentId);
    const target = requirement('Outsourced appointment setting employment');

    const assessment = assessRequirement(target, claims, contract());
    expect(assessment.status).toBe('PRESENT_BUT_UNVERIFIED');
    expect(assessment.needsResearch).toBe(true);
    expect(assessment.gapType).toBe('UNVERIFIABLE_CITATION');
  });

  it('marks evidence from before the timeframe STALE', async () => {
    const documentId = await addDocument(
      'World Model v1.txt',
      [
        'Outsourced appointment setting employment was 74,000 in 2016 according to the agency.',
        'https://www.bls.gov/oes/2016/oes419041.htm',
        '',
        'Outsourced appointment setting employment fell slightly in 2017 on the same measure.',
        'https://www.census.gov/2017.html',
      ].join('\n'),
    );
    const claims = inventoryDocument(documentId);
    const target = requirement('Outsourced appointment setting employment');

    const assessment = assessRequirement(target, claims, contract({ timeframe: '2023 onwards' }));
    expect(assessment.status).toBe('STALE');
    expect(assessment.needsResearch).toBe(true);
  });

  it('marks evidence about another country DEFINITION_MISMATCH', async () => {
    const documentId = await addDocument(
      'World Model v1.txt',
      [
        'Outsourced appointment setting employment in the United Kingdom was 41,000 in 2024.',
        'https://www.ons.gov.uk/employment.html',
      ].join('\n'),
    );
    const claims = inventoryDocument(documentId);
    const target = requirement('Outsourced appointment setting employment');

    const assessment = assessRequirement(target, claims, contract({ geography: 'United States' }));
    expect(assessment.status).toBe('DEFINITION_MISMATCH');
    expect(assessment.gapType).toBe('MISSING_GEOGRAPHY');
  });

  it('marks an unresolved disagreement CONTRADICTED', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    const claims = inventoryDocument(documentId);
    updateExistingClaim(claims[0]!.id, { contradictionState: 'CONTESTED' });
    const target = requirement('Employment in the outsourced telemarketing occupation');

    const assessment = assessRequirement(
      target,
      listExistingClaims(fixture.project.id),
      contract(),
    );
    expect(assessment.status).toBe('CONTRADICTED');
    expect(assessment.gapType).toBe('UNRESOLVED_CONTRADICTION');
  });

  it('marks evidence from a replaced document SUPERSEDED', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    const replacement = await addDocument('World Model v1B.txt', SOURCED);
    updateDocument(documentId, { supersededByDocumentId: replacement });
    const claims = inventoryDocument(documentId);
    const target = requirement('Employment in the outsourced telemarketing occupation');

    const assessment = assessRequirement(target, claims, contract());
    expect(assessment.status).toBe('SUPERSEDED');
    expect(assessment.needsResearch).toBe(true);
  });

  it('marks a requirement with nothing about it MISSING', () => {
    const target = requirement('Custody transfer under Japanese insolvency law');
    const assessment = assessRequirement(target, [], contract());
    expect(assessment.status).toBe('MISSING');
    expect(assessment.gapType).toBe('MISSING_FOUNDATIONAL');
    expect(assessment.needsResearch).toBe(true);
  });

  it('refuses to research what research cannot settle', () => {
    const owned = requirement('Routing rules for distressed assets', { kind: 'OTHER_LAYER' });
    const build = requirement('Build the ingestion pipeline', { kind: 'IMPLEMENTATION' });
    const tune = requirement('Tune the confidence threshold', { kind: 'TUNING' });
    const measure = requirement('Measure conversion once live', { kind: 'EMPIRICAL_VALIDATION' });

    expect(assessRequirement(owned, [], contract()).status).toBe('OWNED_ELSEWHERE');
    expect(assessRequirement(build, [], contract()).status).toBe('NOT_REQUIRED');
    expect(assessRequirement(tune, [], contract()).status).toBe('NOT_REQUIRED');
    expect(assessRequirement(measure, [], contract()).status).toBe('NOT_REQUIRED');
    for (const kind of [owned, build, tune, measure]) {
      expect(assessRequirement(kind, [], contract()).needsResearch).toBe(false);
    }
  });

  it('treats one publisher as corroborating nothing', async () => {
    const documentId = await addDocument(
      'World Model v1.txt',
      [
        'Outsourced appointment setting employment was 81,580 in 2024 per the agency.',
        'https://www.bls.gov/oes/current/oes419041.htm',
        '',
        'Outsourced appointment setting employment rose again in 2024 on the same measure.',
        'https://www.bls.gov/oes/current/oes419041b.htm',
      ].join('\n'),
    );
    const claims = inventoryDocument(documentId);
    const target = requirement('Outsourced appointment setting employment');

    const assessment = assessRequirement(target, claims, contract());
    expect(assessment.status).toBe('PARTIALLY_SATISFIED');
    expect(assessment.gapType).toBe('INSUFFICIENT_INDEPENDENCE');
    expect(assessment.needsResearch).toBe(true);
  });

  it('persists the matrix with its reasons, so the decision can be argued with', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    const claims = inventoryDocument(documentId);
    const requirements = [
      requirement('Employment in the outsourced telemarketing occupation'),
      requirement('Custody transfer under Japanese insolvency law'),
    ];

    const { coverage } = buildCoverageMatrix({
      orchestrationId,
      requirements,
      claims,
      contract: contract(),
    });

    expect(coverage).toHaveLength(2);
    expect(listCoverage(orchestrationId)).toHaveLength(2);
    for (const entry of coverage) {
      expect(entry.reasons.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap-only fragmentation
// ---------------------------------------------------------------------------

describe('fragments are created only for genuine gaps', () => {
  it('creates none for a requirement the archive already answers', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    inventoryDocument(documentId);
    const requirements = [requirement('Employment in the outsourced telemarketing occupation')];

    const result = reconcile({
      orchestrationId,
      projectId: fixture.project.id,
      requirements,
      contract: contract(),
    });
    expect(result.satisfied).toHaveLength(1);

    const fragments = planFragmentsFromGaps({ orchestrationId, reconciliation: result });
    expect(fragments).toHaveLength(0);
  });

  it('creates one for a real gap, carrying why the archive was not enough', async () => {
    const documentId = await addDocument('World Model v1.txt', SOURCED);
    inventoryDocument(documentId);
    const requirements = [
      requirement('Employment in the outsourced telemarketing occupation'),
      requirement('Custody transfer under Japanese insolvency law'),
    ];

    const result = reconcile({
      orchestrationId,
      projectId: fixture.project.id,
      requirements,
      contract: contract(),
    });
    const fragments = planFragmentsFromGaps({ orchestrationId, reconciliation: result });

    expect(fragments).toHaveLength(1);
    const fragment = fragments[0]!;
    expect(fragment.requirementIds).toHaveLength(1);
    expect(fragment.whyExistingInsufficient).toMatch(/nothing in the project/i);
    expect(fragment.missingEvidence).toBeTruthy();
    expect(fragment.geography).toBe('United States');
    expect(fragment.priority).toBe(1);
  });

  it('scales the count to the gaps, above or below any fixed number', () => {
    // Three gaps out of three requirements: fewer than the old floor of five.
    const few = [
      requirement('Custody transfer under Japanese insolvency law'),
      requirement('Custody transfer under Brazilian insolvency law'),
      requirement('Custody transfer under Indian insolvency law'),
    ];
    const small = reconcile({
      orchestrationId,
      projectId: fixture.project.id,
      requirements: few,
      contract: contract(),
    });
    expect(planFragmentsFromGaps({ orchestrationId, reconciliation: small })).toHaveLength(3);

    // And a genuinely open assignment goes well past the old ceiling of fifteen.
    const other = newAssignment();
    const many = Array.from({ length: 22 }, (_value, index) => {
      const [created] = createRequirements([
        {
          orchestrationId: other,
          projectId: fixture.project.id,
          layerId: fixture.layerByName('World Model').id,
          requirementKey: `open-question-${index + 1}`,
          ordinal: index,
          statement: `Custody transfer under jurisdiction number ${index + 1} of the survey`,
          necessity: 'MANDATORY',
          kind: 'RESEARCH',
          requiredEvidence: ['statutory text'],
          completionCriteria: ['the recognised moment, sourced'],
          dependsOn: [],
        },
      ]);
      return created!;
    });
    const large = reconcile({
      orchestrationId: other,
      projectId: fixture.project.id,
      requirements: many,
      contract: contract({ orchestrationId: other } as never),
    });
    expect(planFragmentsFromGaps({ orchestrationId: other, reconciliation: large })).toHaveLength(22);
  });

  it('does not fragment the same requirement forever', () => {
    const target = requirement('Custody transfer under Japanese insolvency law');
    const result = reconcile({
      orchestrationId,
      projectId: fixture.project.id,
      requirements: [target],
      contract: contract(),
    });

    // Calling the planner repeatedly must not keep adding fragments for one gap.
    planFragmentsFromGaps({ orchestrationId, reconciliation: result });
    planFragmentsFromGaps({ orchestrationId, reconciliation: result });
    planFragmentsFromGaps({ orchestrationId, reconciliation: result });
    const fragments = planFragmentsFromGaps({ orchestrationId, reconciliation: result });
    void fragments;

    const total = reconcile({
      orchestrationId,
      projectId: fixture.project.id,
      requirements: [target],
      contract: contract(),
    });
    void total;
    // One fragment for one gap, however many times the planner runs.
    expect(
      planFragmentsFromGaps({ orchestrationId, reconciliation: result }).length,
    ).toBe(0);
  });

  it('turns an unsettled boundary into its own fragment', () => {
    const withAmbiguity = contract({
      ambiguities: [
        {
          question: 'Does "distressed" include performing loans sold at a discount?',
          why: 'Every downstream figure depends on which population is counted.',
        },
      ],
    });
    const result = reconcile({
      orchestrationId,
      projectId: fixture.project.id,
      requirements: [requirement('Custody transfer under Japanese insolvency law')],
      contract: withAmbiguity,
    });
    const fragments = planFragmentsFromGaps({ orchestrationId, reconciliation: result });

    const boundary = fragments.find((fragment) => fragment.fragmentKey.startsWith('boundary-'));
    expect(boundary).toBeTruthy();
    expect(boundary!.priority).toBe(0);
    expect(boundary!.minIndependentSources).toBe(1);
  });
});
