/**
 * The whole loop, once, on one assignment.
 *
 * Every other test file takes one subsystem apart. This one puts them back
 * together and walks the path a real assignment takes: an archive that already
 * answers part of the question, a goal that becomes a requirement graph, the
 * archive checked before anything is researched, fragments for the genuine gaps
 * only, a plan a person approves, compatible fragments sharing a job, evidence
 * judged by what kind of claim it is, a failure repaired rather than retried, a
 * report written from accepted evidence alone, and an audit on the result.
 *
 * The thing it is really testing is that none of those steps quietly stopped
 * talking to the next one.
 *
 * What it deliberately does not test is whether the research tool works on this
 * machine. That is a different question with a different answer, and a scripted
 * provider passing here says nothing about it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { importFile } from '../server/services/importer.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { getDocument } from '../server/repos/documents.ts';
import {
  currentFragments,
  getOrchestration,
  listClaims,
  listFragments,
} from '../server/repos/research.ts';
import { listCoverage, listRequirements } from '../server/repos/reconciliation.ts';
import { listJobs } from '../server/repos/jobs.ts';
import { runOrchestration, startResearch } from '../server/services/research/orchestrator.ts';
import { applyReviewDecisions, buildReview } from '../server/services/research/review.ts';
import { assessPacket, packetEvidence } from '../server/services/research/packet.ts';
import { progressSnapshot } from '../server/services/research/progress.ts';
import type {
  AIProvider,
  AuditResponse,
  ChatResponse,
  ProviderStatus,
  ResearchRequest,
  ResearchResponse,
} from '../server/providers/types.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});
afterEach(async () => {
  await teardown();
});

/** An archive document that already answers one of the requirements. */
const ARCHIVE = [
  'World Model v1 — recognition of custody transfer',
  '',
  'Employment in the outsourced telemarketing occupation was 81,580 in 2024 according to the',
  'Bureau of Labor Statistics. https://www.bls.gov/oes/current/oes419041.htm',
  '',
  'Census Bureau statistics put employment in the same outsourced telemarketing occupation at a',
  'comparable level for 2024. https://www.census.gov/programs-surveys/susb.html',
  '',
  'Custody transfer is recognised at the point of the recorded act, per the 2024 filings.',
].join('\n');

function fence(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/**
 * The plan the worker returns: a boundary, and four requirements — one of which
 * the archive above already answers.
 */
const PLAN = {
  boundary: {
    primaryQuestion: 'How is custody transfer recognised, and how large is the occupation?',
    decisionSupported: 'Whether routing can rely on a single recognition point.',
    audience: 'The World Model layer',
    includedSubjects: ['custody transfer', 'occupation size'],
    excludedSubjects: ['tax treatment'],
    geography: 'United States',
    timeframe: '2024',
    population: 'B2B firms with a sales team',
    definitions: [
      { term: 'Outsourced SDR', definition: 'An external firm booking qualified meetings.' },
    ],
    requiredComparisons: [],
    requiredCalculations: [],
    expectedOutput: 'A layer report with the recognised moment and the occupation size.',
    requiredConfidence: 'Sourced to primary statistics or primary law.',
    acceptableUncertainty: 'Regimes with no published rule may be reported as unknown.',
    prohibitedAssumptions: ['That control and ownership pass together.'],
    sourceConstraints: [],
    completionStandard: 'Every requirement has a sourced answer or a stated gap.',
    ambiguities: [],
  },
  requirements: [
    {
      // The archive answers this one, from two independent publishers.
      key: 'employment',
      statement: 'Employment in the outsourced telemarketing occupation',
      necessity: 'MANDATORY',
      kind: 'RESEARCH',
      rationale: 'The layer cannot size the market without it.',
      requiredEvidence: ['official statistics'],
      completionCriteria: ['a figure with its definition and measurement date'],
      dependsOn: [],
      owningLayer: '',
    },
    {
      key: 'recognition-point',
      statement: 'The moment custody transfer is legally recognised in each regime',
      necessity: 'MANDATORY',
      kind: 'RESEARCH',
      rationale: 'Routing depends on it.',
      requiredEvidence: ['primary legislation'],
      completionCriteria: ['the statutory provision, quoted'],
      dependsOn: [],
      owningLayer: '',
    },
    {
      key: 'vendor-count',
      statement: 'How many vendors operate in the distressed receivables market',
      necessity: 'SUPPORTING',
      kind: 'RESEARCH',
      rationale: 'It bounds the routing problem.',
      requiredEvidence: ['official registries'],
      completionCriteria: ['a count with its source'],
      dependsOn: [],
      owningLayer: '',
    },
    {
      key: 'settlement-window',
      statement: 'How long settlement takes after the recognised moment',
      necessity: 'SUPPORTING',
      kind: 'RESEARCH',
      rationale: 'It sets the routing deadline.',
      requiredEvidence: ['official statistics'],
      completionCriteria: ['a duration with its source'],
      dependsOn: [],
      owningLayer: '',
    },
  ],
};

interface ScriptedClaim {
  claim: string;
  url: string | null;
  publisher: string;
  claimType?: string;
  primarySource?: boolean;
}

function claimBlock(list: ScriptedClaim[], lane = 'official statistics'): unknown {
  return {
    searchQueries: ['site:bls.gov telemarketers employment'],
    claims: list.map((entry) => ({
      claim: entry.claim,
      evidenceLane: lane,
      sourceUrl: entry.url,
      sourceTitle: 'A published source',
      sourcePublisher: entry.publisher,
      sourceDate: '2024-04-03',
      evidenceExcerpt: entry.claim,
      evidenceLocator: 'table 1',
      retrievedAt: '2025-01-05',
      confidence: 0.8,
      claimType: entry.claimType ?? 'SOURCED_FACT',
      primarySource: entry.primarySource ?? true,
      searchedRepositories: [],
      derived: false,
      derivedFrom: [],
    })),
    unresolved: [],
    notes: '',
  };
}

function verification(count: number): unknown {
  return {
    claimVerdicts: Array.from({ length: count }, (_value, index) => ({
      claimIndex: index,
      supportsClaim: true,
      scopeMatch: {
        geography: 'MATCH',
        timeframe: 'MATCH',
        population: 'MATCH',
        definitions: 'MATCH',
      },
      contradictionState: 'UNCHALLENGED',
      note: 'The source states this directly.',
    })),
    sufficiency: 'SUFFICIENT',
    missingLanes: [],
    unresolvedGaps: [],
    reasoning: 'Checked against the cited passages.',
  };
}

const REPORT = [
  '# Layer report',
  '',
  'The record establishes the recognised moment for custody transfer and the size of the',
  'occupation, each traceable to the source in the ledger below. Where the evidence does not',
  'exist, this report says so rather than estimating around it.',
  '',
  '## The recognised moment',
  '',
  'Recognition attaches to the recorded act rather than to the transfer of possession, and the',
  'sources say so directly rather than by implication. The distinction matters for routing:',
  'a rule that keyed on possession would fire at a different time in every regime surveyed,',
  'and the report says which regimes were surveyed and which were not.',
  '',
  '## The size of the occupation',
  '',
  'Employment in the occupation is measured annually by the statistical agency and published',
  'with its definition and its measurement date. The published definition is broader than the',
  'population this layer cares about, which is stated here rather than adjusted away, because',
  'an adjustment nobody published is an estimate wearing a citation.',
  '',
  '## What is not established',
  '',
  'Where a fragment could not be evidenced, the gap is named in the ledger below with the',
  'reason it stayed open. Nothing in this report rests on an unsourced calculation, and no',
  'figure here has been carried over from a rejected finding.',
].join('\n');

const AUDIT_PRIMARY = {
  assignment_satisfied: 'YES',
  requirement_findings: [],
  structural_findings: [],
  boundary_findings: [],
  consistency_findings: [],
  candidate_gaps: [],
  notes: '',
};
const AUDIT_ADVERSARIAL = { attacks: [], strongest_reason_not_to_advance: '' };
const AUDIT_JUDGE = {
  verdict: 'PASS',
  summary: 'The report is sourced throughout and states its gaps.',
  confidence: 0.8,
  gap_classifications: [],
  foundational_gap_count: 0,
  targeted_research_runs_required: 0,
  blocking_dependencies: [],
  required_patches: [],
  other_layer_handoffs: [],
  synthesis_ready: false,
  freeze_ready: false,
  next_action: 'Review the report.',
};

/**
 * A worker whose first attempt at one fragment rests on a single publisher, so
 * the repair path is exercised rather than described.
 */
class AcceptanceWorker implements AIProvider {
  readonly name = 'mock';
  readonly calls: { kind: string; prompt: string }[] = [];
  readonly #attempts = new Map<string, number>();

  #kind(prompt: string): string {
    if (prompt.startsWith('You are working out what a research assignment')) return 'PLAN';
    if (prompt.startsWith('You are checking')) return 'VERIFICATION';
    if (prompt.startsWith('You are writing the layer report')) return 'SYNTHESIS';
    return 'RESEARCH';
  }

  #keys(prompt: string): string[] {
    return [...prompt.matchAll(/^FRAGMENT: (\S+)$/gm)].map((match) => match[1]!);
  }

  /**
   * The lane this fragment actually asked for.
   *
   * A worker that answers in a lane nobody asked for has not answered: the gate
   * counts coverage per lane, so the script has to read the brief the same way
   * a real worker would.
   */
  #lane(prompt: string, key: string): string {
    const after = prompt.slice(prompt.indexOf(`FRAGMENT: ${key}`));
    const lanes = /^REQUIRED EVIDENCE LANES: (.+)$/m.exec(after)?.[1] ?? 'official statistics';
    return lanes.split('|')[0]!.trim();
  }

  async runResearch(request: ResearchRequest): Promise<ResearchResponse> {
    const kind = this.#kind(request.prompt);
    this.calls.push({ kind, prompt: request.prompt });

    if (kind === 'PLAN') return this.#reply(PLAN);
    if (kind === 'SYNTHESIS') {
      return this.#reply({ report: REPORT, citedClaimIds: [], unresolvedGaps: [] });
    }

    const keys = this.#keys(request.prompt);
    if (kind === 'VERIFICATION') {
      // One ledger at a time, however many claims are in it.
      const claims = (request.prompt.match(/^\[\d+\]/gm) ?? []).length;
      return this.#reply(verification(Math.max(1, claims)));
    }

    const answer = (key: string): unknown => {
      const attempt = (this.#attempts.get(key) ?? 0) + 1;
      this.#attempts.set(key, attempt);
      const lane = this.#lane(request.prompt, key);
      // The vendor-count fragment comes back on one publisher first, and is
      // repaired onto a second.
      if (key.includes('vendor') && attempt === 1) {
        return claimBlock(
          [
            { claim: 'There are 1,200 vendors.', url: 'https://www.sec.gov/a.htm', publisher: 'SEC' },
            { claim: 'The count rose in 2024.', url: 'https://www.sec.gov/b.htm', publisher: 'SEC' },
          ],
          lane,
        );
      }
      return claimBlock(
        [
          {
            claim: `Finding for ${key} from the first publisher.`,
            url: 'https://www.bls.gov/one.htm',
            publisher: 'Bureau of Labor Statistics',
          },
          {
            claim: `Finding for ${key} from a second, independent publisher.`,
            url: 'https://www.census.gov/two.html',
            publisher: 'Census Bureau',
          },
        ],
        lane,
      );
    };

    if (keys.length > 1) {
      return this.#reply({
        fragments: keys.map((key) => ({
          fragmentKey: key,
          ...(answer(key) as Record<string, unknown>),
        })),
      });
    }
    return this.#reply(answer(keys[0] ?? 'unknown'));
  }

  #reply(value: unknown): ResearchResponse {
    return { text: fence(value), externalResponseId: 'job_acceptance', model: null };
  }

  async audit(request: { prompt: string }): Promise<AuditResponse> {
    const pass = /^BRAIN AUDIT PASS: (\w+)/m.exec(request.prompt)?.[1] ?? 'JUDGE';
    if (pass === 'PRIMARY' || pass === 'EXTRACTION') {
      return { text: fence(AUDIT_PRIMARY), externalResponseId: null };
    }
    if (pass === 'ADVERSARIAL') return { text: fence(AUDIT_ADVERSARIAL), externalResponseId: null };
    return { text: fence(AUDIT_JUDGE), externalResponseId: null };
  }

  async chat(): Promise<ChatResponse> {
    throw new Error('not used');
  }

  getStatus(): ProviderStatus {
    return {
      name: this.name,
      available: true,
      reason: 'scripted for the acceptance run',
      model: null,
      capabilities: { chat: false, research: true, audit: true },
      placeholder: false,
    };
  }
}

describe('one assignment, end to end', () => {
  it('reads the archive, plans only the gaps, waits, researches, repairs, and files', async () => {
    // --- The archive the project already has ------------------------------
    const imported = await importFile({
      projectId: fixture.project.id,
      originalFilename: 'World Model v1.txt',
      contents: Buffer.from(ARCHIVE),
      layerId: (await fixture.layerByName('World Model')).id,
      version: 'v1',
      documentType: 'FOUNDATION',
    });
    await whenExtractionIdle();
    expect(await getDocument(imported.documentId!)).toBeTruthy();

    // --- The goal, planned but not started --------------------------------
    const worker = new AcceptanceWorker();
    const orchestration = await startResearch({
      layerId: (await fixture.layerByName('World Model')).id,
      title: 'Custody recognition and occupation size',
      assignment: 'Establish how custody transfer is recognised and how large the occupation is.',
      requireApproval: true,
    });
    const planned = await runOrchestration(orchestration.id, { provider: worker });
    const id = orchestration.id;

    // The goal became a requirement graph, and nothing was researched yet.
    expect(planned.orchestration.status).toBe('AWAITING_APPROVAL');
    expect(await listRequirements(id)).toHaveLength(4);
    expect(worker.calls.filter((call) => call.kind === 'RESEARCH')).toHaveLength(0);

    // The archive was read first, and its claims mapped to a requirement.
    const review = await buildReview(id);
    expect(review.alreadyAnswered.length).toBeGreaterThan(0);
    const satisfied = review.alreadyAnswered[0]!;
    expect(satisfied.evidence.length).toBeGreaterThan(0);
    expect(satisfied.needsResearch).toBe(false);

    // Fragments exist for the gaps and not for what the archive settles.
    const gapKeys = new Set(review.gaps.map((entry) => entry.requirement.id));
    expect(gapKeys.size).toBeGreaterThan(0);
    for (const entry of review.fragments) {
      for (const requirementId of entry.fragment.requirementIds) {
        expect(requirementId).not.toBe(satisfied.requirement.id);
      }
    }
    // The count came from the gaps rather than from a fixed range.
    expect(review.fragments.length).toBe(review.gaps.length);
    // Compatible fragments share a job, and there are fewer jobs than fragments.
    expect(review.jobs.length).toBeGreaterThan(0);
    expect(review.jobs.length).toBeLessThanOrEqual(review.fragments.length);

    // --- Approval is what starts the work ---------------------------------
    await applyReviewDecisions(id, { approve: true, note: 'Checked the gaps.' });
    expect((await getOrchestration(id))!.approvedAt).not.toBeNull();

    const outcome = await runOrchestration(id, { provider: worker });
    await whenExtractionIdle();

    // --- What happened --------------------------------------------------
    expect(worker.calls.filter((call) => call.kind === 'RESEARCH').length).toBeGreaterThan(0);

    // A fragment that came back on one publisher was repaired, not accepted.
    const vendorAttempts = (await listFragments(id)).filter((entry) =>
      entry.fragmentKey.includes('vendor'),
    );
    expect(vendorAttempts.length).toBeGreaterThanOrEqual(2);
    expect(vendorAttempts[0]!.sufficiencyVerdict).toBe('INSUFFICIENT');
    expect(vendorAttempts[0]!.repairPlan).toBeNull();
    expect(vendorAttempts[1]!.repairPlan).not.toBeNull();
    expect(vendorAttempts[1]!.repairPlan!.strategies.length).toBeGreaterThan(0);
    expect(vendorAttempts.at(-1)!.status).toBe('ACCEPTED');

    // Bundled fragments kept separate verdicts and separate claims.
    const jobs = await listJobs(id);
    expect(jobs.length).toBeGreaterThan(0);
    const bundled = jobs.find((job) => job.fragmentIds.length > 1);
    if (bundled) {
      const claimsByFragment = new Map<string, number>();
      for (const claim of await listClaims(id)) {
        if (!claim.fragmentId) continue;
        claimsByFragment.set(claim.fragmentId, (claimsByFragment.get(claim.fragmentId) ?? 0) + 1);
      }
      for (const fragmentId of bundled.fragmentIds) {
        expect(claimsByFragment.get(fragmentId) ?? 0).toBeGreaterThan(0);
      }
    }

    // The packet was checked against the whole goal before anything was written.
    const coverage = await assessPacket({ orchestrationId: id, projectId: fixture.project.id });
    expect(coverage.checks.length).toBeGreaterThan(5);

    // --- What was filed ---------------------------------------------------
    expect(outcome.documentId).toBeTruthy();
    const filed = (await getDocument(outcome.documentId!))!;
    expect(filed.canonicalName.length).toBeGreaterThan(0);
    expect(outcome.auditId).toBeTruthy();
    expect(outcome.verdict).toBe('PASS');
    expect((await getOrchestration(id))!.status).toBe('COMPLETE');

    // Synthesis used accepted evidence only, and every claim behind it resolves
    // to a source and a passage.
    const evidence = await packetEvidence({ orchestrationId: id, projectId: fixture.project.id });
    expect(evidence.newClaims.length).toBeGreaterThan(0);
    for (const claim of evidence.newClaims) {
      expect(claim.accepted).toBe(true);
      expect(claim.sourceUrl).toMatch(/^https:\/\//);
      expect((claim.evidenceExcerpt ?? '').length).toBeGreaterThan(0);
      expect(claim.requirementIds.length).toBeGreaterThan(0);
    }
    // A rejected claim contributed nothing.
    const rejected = (await listClaims(id)).filter((claim) => !claim.accepted);
    for (const claim of rejected) {
      expect(evidence.newClaims.some((entry) => entry.id === claim.id)).toBe(false);
    }

    // Coverage moved as evidence landed, rather than staying where the archive
    // left it.
    const coverageRows = await listCoverage(id);
    expect(coverageRows.some((entry) => entry.status === 'SATISFIED')).toBe(true);

    // --- What the user would see -----------------------------------------
    const progress = (await progressSnapshot(id))!;
    expect(progress.requirements.total).toBe(4);
    expect(progress.fragments.accepted).toBeGreaterThan(0);
    expect(progress.evidence.acceptedClaims).toBeGreaterThan(0);
    expect(progress.evidence.repairAttempts).toBeGreaterThan(0);
    expect(progress.synthesis.ready).toBe(true);
    expect(progress.audit.verdict).toBe('PASS');
    expect(progress.disposition).toMatch(/finished/i);
    // Every fragment settled; nothing is left silently open.
    for (const fragment of await currentFragments(id)) {
      expect(['ACCEPTED', 'REJECTED', 'CANCELLED', 'NEEDS_HUMAN']).toContain(fragment.status);
    }
  }, 60_000);
});
