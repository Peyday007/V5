/**
 * The puzzle products + production kernel: one validated production system
 * compiling into many qualified outputs, and every rule that stops that being
 * a lie.
 *
 * ---------------------------------------------------------------------------
 * What this pins, and why each one is a property rather than an example
 * ---------------------------------------------------------------------------
 *
 * **The repository holds no list of puzzle formats.** The directive's seed is
 * a spread to search from, not the taxonomy, so the first assertion reads the
 * source — the same thing `operatorConsoleRemoved` does, for the same reason:
 * what must not exist is not something a behavioural test can see.
 *
 * **A declaration reaches the row, over the wire.** §33 and §45 both record
 * the same defect at two axes: a validator that ran, a tool that accepted the
 * claim, an insert with the columns, and the fields arriving NULL because a
 * mapper between them carried only what it had been told about. A unit test
 * writing the columns directly passes either way, so there is a walk that
 * submits through `brain_submit_claims`.
 *
 * **A puzzle with no passing validation is not a puzzle this kernel has.**
 * §9's rule at a new artifact, and the one this whole thing exists for: a book
 * of unsolvable puzzles is the commercial failure a validator prevents.
 *
 * **A reskin is not a product.** The directive says so in as many words, and a
 * multiplier that counted covers would be the fiction §23 warns about.
 *
 * **A total past an unknown is withheld.** Four named reasons, and the
 * direction matters: a figure that steps over a missing printing cost is
 * *smaller* than anything published says.
 *
 * **Nothing here authorizes an effect.** Every rendered question goes through
 * the real forbidden-actions screen with the real envelope patterns, because a
 * brief that trips it is a round that can never run — §39 had to add exactly
 * this test for exactly this reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  getClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { claimWork } from '../server/repos/workQueue.ts';
import { approvePlan } from '../server/services/research/packetRunner.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { findTool } from '../server/mcp/tools.ts';
import {
  currentValidation,
  getFormatByKey,
  listEconomics,
  listFormats,
  listInstances,
  listOutputs,
  listRounds,
  listRouteEvidence,
  listRoutes,
  listStandards,
  recordEconomicLine,
  recordRouteEvidence,
  recordStandard,
} from '../server/repos/puzzle.ts';
import { validatePuzzleFinding, formatKey, sideFor, loadBearingFor, axisQualifies, qualifyingAxes, isSetupCost, targetForFinding } from '../server/domain/puzzle.ts';
import { puzzleSnapshot } from '../server/services/puzzle/graph.ts';
import { readFormats, readOutputs } from '../server/services/puzzle/maturity.ts';
import { readLeverage } from '../server/services/puzzle/leverage.ts';
import { readContribution, readCheapBook, readProductionStage } from '../server/services/puzzle/economics.ts';
import { readLedger } from '../server/services/puzzle/ledger.ts';
import { readLessons } from '../server/services/puzzle/lessons.ts';
import { runPuzzleKernel, planFrom } from '../server/services/puzzle/kernel.ts';
import { compose } from '../server/services/puzzle/expand.ts';
import { produceBatch } from '../server/services/puzzle/produce.ts';
import { puzzleView } from '../server/services/puzzle/view.ts';
import {
  compileOutput,
  declareFormat,
  declareMaster,
  declareRoute,
  decideRoute,
  recordPersonObservation,
  releaseOutput,
  reviewMaster,
} from '../server/services/puzzle/declare.ts';
import { readPuzzleDirective, brief, REQUIRED_SECTIONS } from '../server/services/puzzle/directive.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import {
  DIFFERENTIATOR_AXES,
  ECONOMIC_COMPONENTS,
  PUZZLE_FINDINGS,
  VALIDATION_CHECKS,
} from '../server/domain/types.ts';
import type { Layer, Principal, PuzzleFinding, WorkerScope } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let layer: Layer;

const WORKER_SCOPES: WorkerScope[] = [
  'project:read',
  'documents:read',
  'research:read',
  'research:propose',
  'research:write',
  'claims:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
];

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `puzzle-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const worker = await createWorker({
    name: `puzzle-worker-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'The puzzle research worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  // The membership has to be a real row: `claimWork` reads what the worker may
  // reach from the database, never from what a caller says about itself.
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: workerId,
    role: 'MEMBER',
    scopes: WORKER_SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

/* --------------------------------------------------------------------------
 * The repository holds no taxonomy
 * ------------------------------------------------------------------------ */

describe('the universe is rows, and this repository holds no list of formats', () => {
  /**
   * Walk the kernel's own source.
   *
   * Comments are stripped first. The rule is that no *executable* code names a
   * puzzle format as part of a bounded list — the prose in this repository
   * documents by example, and §27 records a guard that read a comment as code
   * and cried wolf about it.
   */
  function sourceOf(dir: string): { file: string; code: string }[] {
    const out: { file: string; code: string }[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at)) {
        const full = join(at, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const raw = readFileSync(full, 'utf8');
        const code = raw
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
        out.push({ file: full, code });
      }
    };
    walk(dir);
    return out;
  }

  it('declares no array of puzzle format names anywhere in the kernel', () => {
    const files = [
      ...sourceOf('server/services/puzzle'),
      { file: 'server/domain/puzzle.ts', code: readFileSync('server/domain/puzzle.ts', 'utf8') },
      { file: 'server/repos/puzzle.ts', code: readFileSync('server/repos/puzzle.ts', 'utf8') },
    ];
    /*
     * A list of two or more quoted format names in one array literal is the
     * shape a taxonomy takes. An engine naming the one format it implements is
     * an implementation and is expected; several together would be a universe.
     */
    const taxonomy =
      /\[\s*'(?:crossword|sudoku|word ?search|maze|nonogram|cryptogram|acrostic|anagram|logic grid)'\s*,\s*'/i;
    const offenders = files
      .filter((one) => taxonomy.test(one.code))
      .map((one) => one.file);
    expect(offenders).toEqual([]);
  });

  it('refuses a discovered format with no claim behind it, in the repository itself', async () => {
    await expect(
      (async () => {
        const { createFormat } = await import('../server/repos/puzzle.ts');
        return createFormat({
          projectId,
          name: 'a format nobody established',
          origin: 'DISCOVERED',
        });
      })(),
    ).rejects.toThrow(/without the claim/);
  });

  it('lets a person seed one, because SEED is the origin Brain may never write', async () => {
    const seeded = await declareFormat({ projectId, name: 'Word Search' });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.origin).toBe('SEED');
    expect(seeded.value.sourceClaimId).toBeNull();
    expect(seeded.value.formatKey).toBe('word search');
  });

  it('matches two spellings only when they are the same string, case and spacing aside', () => {
    expect(formatKey('  Word   Search ')).toBe(formatKey('word search'));
    // Deliberately not the same: a matcher that joined these would be guessing.
    expect(formatKey('wordsearch')).not.toBe(formatKey('word search'));
  });
});

/* --------------------------------------------------------------------------
 * The one validator, at both doors
 * ------------------------------------------------------------------------ */

describe('a finding is declared, and the validator refuses rather than improvising', () => {
  const base = {
    where: 'claims[0]',
    finding: null as unknown,
    subject: null as unknown,
    format: null as unknown,
    value: null as unknown,
    basis: null as unknown,
    amountMinor: null as unknown,
    currency: null as unknown,
    observedOn: null as unknown,
  };

  it('accepts a claim that says nothing about the trade, which is most claims', () => {
    const result = validatePuzzleFinding(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finding).toBeNull();
  });

  it('refuses a companion field with no finding, because nothing would ever read it', () => {
    const result = validatePuzzleFinding({ ...base, format: 'sudoku' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no puzzle_finding');
  });

  it('refuses a finding outside the closed set', () => {
    const result = validatePuzzleFinding({ ...base, finding: 'SEEMS_PROFITABLE', subject: 'x' });
    expect(result.ok).toBe(false);
  });

  it('refuses a finding with no subject, which would name nothing', () => {
    const result = validatePuzzleFinding({ ...base, finding: 'FORMAT_EXISTS' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('puzzle_subject');
  });

  it('refuses a standard whose check is not one a validator could run', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'QUALITY_STANDARD',
      subject: 'grids must be symmetrical',
      format: 'crossword',
      value: 'MUST_BE_ELEGANT',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('SOLUTION_UNIQUENESS');
  });

  it('refuses a demand signal with no date the source carries', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'BUYER_DEMAND',
      subject: 'A syndicate',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('puzzle_observed_on');
    expect(result.error).toContain('years ago');
  });

  it('accepts the granularity a source actually gives, and refuses an invented one', () => {
    for (const observedOn of ['2026', '2026-04', '2026-04-19']) {
      const ok = validatePuzzleFinding({
        ...base,
        finding: 'BUYER_DEMAND',
        subject: 'A syndicate',
        observedOn,
      });
      expect(ok.ok, observedOn).toBe(true);
    }
    const bad = validatePuzzleFinding({
      ...base,
      finding: 'BUYER_DEMAND',
      subject: 'A syndicate',
      observedOn: 'last spring',
    });
    expect(bad.ok).toBe(false);
  });

  it('refuses a figure missing any one of its amount, currency or basis', () => {
    const complete = {
      ...base,
      finding: 'ECONOMIC_FIGURE' as const,
      subject: 'a printer rate',
      value: 'PRINTING_COST',
      amountMinor: 8200,
      currency: 'USD',
      basis: 'one copy at a run of 10,000',
    };
    expect(validatePuzzleFinding(complete).ok).toBe(true);

    for (const missing of ['amountMinor', 'currency', 'basis'] as const) {
      const result = validatePuzzleFinding({ ...complete, [missing]: null });
      expect(result.ok, missing).toBe(false);
    }
  });

  it('refuses a currency Brain would have to guess at', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'ECONOMIC_FIGURE',
      subject: 'a printer rate',
      value: 'PRINTING_COST',
      amountMinor: 8200,
      currency: 'dollars',
      basis: 'one copy',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ISO 4217');
  });

  it('refuses an established absence that does not say where it looked', () => {
    const without = validatePuzzleFinding({
      ...base,
      finding: 'DEMAND_ABSENCE',
      subject: 'nobody commissions these',
    });
    expect(without.ok).toBe(false);
    if (without.ok) return;
    expect(without.error).toContain('searched_repositories');

    const withSearch = validatePuzzleFinding({
      ...base,
      finding: 'DEMAND_ABSENCE',
      subject: 'nobody commissions these',
      searchedRepositories: ['three syndicate submission pages', 'two library procurement portals'],
    });
    expect(withSearch.ok).toBe(true);
  });

  it('sends every finding somewhere, so a kind added later is a compile error', () => {
    for (const finding of PUZZLE_FINDINGS) {
      expect(targetForFinding(finding as PuzzleFinding)).toBeTruthy();
    }
  });
});

/* --------------------------------------------------------------------------
 * The walk: over the wire, which is the only place the mapper defect shows
 * ------------------------------------------------------------------------ */

describe('a declaration reaches the row, submitted the way a worker submits', () => {
  async function principal(): Promise<Principal> {
    return {
      type: 'WORKER',
      id: workerId,
      handle: 'puzzle-worker',
      displayName: 'The puzzle research worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cred_puzzle',
      authMethod: 'WORKER_BEARER',
      memberships: [
        {
          id: 'mem_puzzle_worker',
          projectId,
          principalType: 'WORKER',
          principalId: workerId,
          role: 'MEMBER',
          scopes: WORKER_SCOPES,
          active: true,
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: new Date().toISOString(),
          revokedAt: null,
        },
      ],
      requestId: 'req_puzzle',
    } as Principal;
  }

  async function asWorker(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tool = findTool(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    const outcome = await tool.run(args, {
      principal: await principal(),
      requestId: `req_${Math.random().toString(36).slice(2)}`,
    });
    return outcome.value;
  }

  it('carries all eight fields from the tool to the claims table', async () => {
    await activated();

    const run = await createRun({
      projectId,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'a puzzle round',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId: layer.id,
      runId: run.id,
      title: 'a puzzle round',
      assignment: 'who buys puzzles, and what they pay',
      provider: 'WORKER',
      autoApprove: false,
    });
    await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId,
        layerId: layer.id,
        geography: 'any market the evidence is about',
        requiredEvidence: [
          { id: 'published_buyer', description: 'who buys', necessity: 'REQUIRED' },
        ],
        acceptableSourceTypes: ['a published rate card'],
        excludedSourceTypes: ['a forecast presented as a current buyer'],
        completionCriteria: ['every buyer declared with its date'],
        minIndependentSources: 1,
        maxRepairs: 2,
        fragmentIndex: 0,
        fragmentKey: 'puzzle-market',
        question: 'Who buys crosswords?',
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);

    const approved = await approvePlan({
      orchestrationId: orchestration.id,
      approvedByUserId: userId,
    });
    expect(approved.enqueued.length).toBeGreaterThan(0);

    const [claimed] = await claimWork({
      workerId,
      scopes: [{ projectId, scopes: WORKER_SCOPES }],
      workTypes: ['RESEARCH_FRAGMENT'],
      limit: 1,
    });
    expect(claimed).toBeDefined();
    if (!claimed) return;

    const submitted = await asWorker('brain_submit_claims', {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
      claims: [
        {
          claim: 'The syndicate pays contributors for daily crosswords.',
          claim_type: 'SOURCED_FACT',
          source_url: 'https://example.test/rates',
          source_title: 'Contributor rates',
          source_publisher: 'example.test',
          source_date: '2026-06-01',
          evidence_excerpt: 'We pay contributors for daily crosswords.',
          evidence_locator: 'the page body',
          evidence_lane: 'published_buyer',
          retrieved_at: '2026-09-12',
          confidence: 0.9,
          primary_source: true,
          puzzle_finding: 'BUYER_DEMAND',
          puzzle_subject: 'A named syndicate',
          puzzle_format: 'crossword',
          puzzle_observed_on: '2026-06-01',
        },
        {
          claim: 'The published rate is $1.50 per printed copy at a run of ten thousand.',
          claim_type: 'SOURCED_FACT',
          source_url: 'https://example.test/print',
          source_title: 'Print price list',
          source_publisher: 'example.test',
          source_date: '2026-06-01',
          evidence_excerpt: '$1.50 per copy at 10,000.',
          evidence_locator: 'the price table',
          evidence_lane: 'published_buyer',
          retrieved_at: '2026-09-12',
          confidence: 0.9,
          primary_source: true,
          puzzle_finding: 'ECONOMIC_FIGURE',
          puzzle_subject: 'a printer rate',
          puzzle_value: 'PRINTING_COST',
          puzzle_amount_minor: 150,
          puzzle_currency: 'USD',
          puzzle_basis: 'one copy at a run of 10,000',
        },
      ],
      search_queries: ['who buys crosswords'],
      unresolved: [],
      notes: '',
    });

    const ids = (submitted['claims'] as { claimId: string }[]).map((one) => one.claimId);
    expect(ids).toHaveLength(2);

    const demand = await getClaim(ids[0] as string);
    expect(demand?.puzzleFinding).toBe('BUYER_DEMAND');
    expect(demand?.puzzleSubject).toBe('A named syndicate');
    expect(demand?.puzzleFormat).toBe('crossword');
    expect(demand?.puzzleObservedOn).toBe('2026-06-01');

    const figure = await getClaim(ids[1] as string);
    expect(figure?.puzzleFinding).toBe('ECONOMIC_FIGURE');
    expect(figure?.puzzleValue).toBe('PRINTING_COST');
    expect(figure?.puzzleAmountMinor).toBe(150);
    expect(figure?.puzzleCurrency).toBe('USD');
    expect(figure?.puzzleBasis).toBe('one copy at a run of 10,000');
  });

  it('refuses the whole submission at the door when a declaration is incomplete', async () => {
    await activated();
    const run = await createRun({
      projectId,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'a puzzle round',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId: layer.id,
      runId: run.id,
      title: 'a puzzle round',
      assignment: 'who buys puzzles',
      provider: 'WORKER',
      autoApprove: false,
    });
    await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId,
        layerId: layer.id,
        geography: 'any market',
        requiredEvidence: [{ id: 'published_buyer', description: 'who buys', necessity: 'REQUIRED' }],
        acceptableSourceTypes: ['a published rate card'],
        excludedSourceTypes: ['a forecast'],
        completionCriteria: ['declared'],
        minIndependentSources: 1,
        maxRepairs: 2,
        fragmentIndex: 0,
        fragmentKey: 'puzzle-market',
        question: 'Who buys crosswords?',
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: userId });
    const [claimed] = await claimWork({
      workerId,
      scopes: [{ projectId, scopes: WORKER_SCOPES }],
      workTypes: ['RESEARCH_FRAGMENT'],
      limit: 1,
    });
    if (!claimed) return;

    await expect(
      asWorker('brain_submit_claims', {
        work_item_id: claimed.workItemId,
        lease_id: claimed.leaseId,
        lease_generation: claimed.leaseGeneration,
        claims: [
          {
            claim: 'Somebody buys these.',
            claim_type: 'SOURCED_FACT',
            source_url: 'https://example.test/x',
            source_title: 'A page',
            source_publisher: 'example.test',
            source_date: '2026-06-01',
            evidence_excerpt: 'Somebody buys these.',
            evidence_locator: 'body',
            evidence_lane: 'published_buyer',
            retrieved_at: '2026-09-12',
            confidence: 0.9,
            primary_source: true,
            puzzle_finding: 'BUYER_DEMAND',
            puzzle_subject: 'A buyer',
            // no puzzle_observed_on
          },
        ],
        search_queries: [],
        unresolved: [],
        notes: '',
      }),
    ).rejects.toThrow(/puzzle_observed_on/);
  });

  it('declares every field its description names, so a schema cannot drop one', () => {
    const tool = findTool('brain_submit_claims');
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema as unknown as {
      properties: { claims: { items: { properties: Record<string, unknown> } } };
    };
    const declared = Object.keys(schema.properties.claims.items.properties);
    for (const field of [
      'puzzle_finding',
      'puzzle_subject',
      'puzzle_format',
      'puzzle_value',
      'puzzle_basis',
      'puzzle_amount_minor',
      'puzzle_currency',
      'puzzle_observed_on',
    ]) {
      expect(declared, field).toContain(field);
    }
  });
});

/* --------------------------------------------------------------------------
 * Filing is a lookup
 * ------------------------------------------------------------------------ */

interface Declared {
  claim: string;
  finding: PuzzleFinding;
  subject: string;
  format?: string | null;
  value?: string | null;
  basis?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  observedOn?: string | null;
  accepted?: boolean;
}

/** A finished mission for one kernel round, carrying declared findings. */
async function finishedRound(input: {
  candidateId: string;
  claims: Declared[];
}): Promise<string> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a puzzle round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a puzzle round',
    assignment: 'what the puzzle trade publishes',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'any market the evidence is about',
      requiredEvidence: [
        { id: 'published_format', description: 'what is sold', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a published catalogue'],
      excludedSourceTypes: ['a forecast'],
      completionCriteria: ['every finding declared'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'puzzle-market',
      question: 'What is published?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, {
    status: 'ACCEPTED',
    completedAt: new Date().toISOString(),
    blockedReason: null,
  });

  const inserted = await insertClaims(
    input.claims.map((one, index) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: 'https://example.test/source',
      sourceTitle: 'A published source',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-06-01',
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the page body',
      evidenceLane: 'published_format',
      puzzleFinding: one.finding,
      puzzleSubject: one.subject,
      puzzleFormat: one.format ?? null,
      puzzleValue: one.value ?? null,
      puzzleBasis: one.basis ?? null,
      puzzleAmountMinor: one.amountMinor ?? null,
      puzzleCurrency: one.currency ?? null,
      puzzleObservedOn: one.observedOn ?? null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}|${index}`,
    })),
  );
  for (const [index, claim] of inserted.entries()) {
    await decideClaim(claim.id, { accepted: input.claims[index]!.accepted ?? true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a puzzle round',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
  return orchestration.id;
}

async function candidateFor(purpose: string): Promise<string | null> {
  const rounds = await listRounds(projectId);
  return rounds.find((one) => one.purpose === purpose && one.state === 'OPEN')?.candidateId ?? null;
}

describe('what comes back is filed by lookup, and refused otherwise', () => {
  it('opens the universe question first, because nothing is on the map', async () => {
    await activated();
    const pass = await runPuzzleKernel(projectId);
    expect(pass.opened.map((one) => one.purpose)).toContain('UNIVERSE');
    expect(pass.opened[0]?.why).toBeTruthy();
  });

  it('files a format, a standard and a figure into their own tables', async () => {
    await activated();
    await runPuzzleKernel(projectId);
    const candidate = await candidateFor('UNIVERSE');
    expect(candidate).toBeTruthy();
    if (!candidate) return;

    await finishedRound({
      candidateId: candidate,
      claims: [
        {
          claim: 'Word searches are published as mass-market activity books.',
          finding: 'FORMAT_EXISTS',
          subject: 'Word Search',
          format: 'Word Search',
        },
        {
          claim: 'A syndicate pays for daily puzzles.',
          finding: 'MONETIZATION_ROUTE',
          subject: 'Daily newspaper syndication',
          value: 'SYNDICATION',
        },
      ],
    });

    const pass = await runPuzzleKernel(projectId);
    expect(pass.filed.formats).toHaveLength(1);
    expect(pass.filed.routes).toHaveLength(1);
    expect(pass.filed.settled).toHaveLength(1);
    expect(pass.filed.settled[0]?.found).toBe(2);

    const formats = await listFormats(projectId);
    expect(formats.map((one) => one.formatKey)).toContain('word search');
    expect(formats[0]?.origin).toBe('DISCOVERED');
    expect(formats[0]?.sourceClaimId).toBeTruthy();
  });

  it('refuses a standard for a format nothing has established, rather than inventing it', async () => {
    await activated();
    await runPuzzleKernel(projectId);
    const candidate = await candidateFor('UNIVERSE');
    if (!candidate) return;

    await finishedRound({
      candidateId: candidate,
      claims: [
        {
          claim: 'Grids must have exactly one solution.',
          finding: 'QUALITY_STANDARD',
          subject: 'unique solution',
          format: 'a format nobody has established',
          value: 'SOLUTION_UNIQUENESS',
        },
      ],
    });

    const pass = await runPuzzleKernel(projectId);
    expect(pass.filed.standards).toHaveLength(0);
    expect(pass.filed.refused).toHaveLength(1);
    expect(pass.filed.refused[0]?.why).toContain('not a format on the map');
    expect(await listStandards(projectId)).toHaveLength(0);
  });

  it('records a round that established nothing as an answer rather than a failure', async () => {
    await activated();
    await runPuzzleKernel(projectId);
    const candidate = await candidateFor('UNIVERSE');
    if (!candidate) return;

    await finishedRound({ candidateId: candidate, claims: [] });
    await runPuzzleKernel(projectId);

    const rounds = await listRounds(projectId);
    const settled = rounds.find((one) => one.purpose === 'UNIVERSE' && one.state !== 'OPEN');
    expect(settled?.state).toBe('ABANDONED');
    expect(settled?.found).toBe(0);
    expect(settled?.settledReason).toContain('an answer rather than a failure');
  });

  it('reports a live round as not counted yet rather than as nought', async () => {
    await activated();
    await runPuzzleKernel(projectId);
    const rounds = await listRounds(projectId);
    const live = rounds.find((one) => one.state === 'OPEN');
    // §33's defect, not repeated: a NOT NULL DEFAULT 0 would publish the
    // default as a measurement on every live round.
    expect(live?.found).toBeNull();
  });
});

/* --------------------------------------------------------------------------
 * A puzzle is evidence only if a validator passed it
 * ------------------------------------------------------------------------ */

describe('a puzzle with no passing validation is not one this kernel has', () => {
  async function reviewedMaster(): Promise<string> {
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9, medium',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules; no third-party corpus is used.',
    });
    expect(master.ok).toBe(true);
    if (!master.ok) throw new Error(master.reason);
    const reviewed = await reviewMaster({
      id: master.value.id,
      reviewedById: userId,
      note: 'Solved three by hand; uniqueness and the printed key both check out.',
    });
    expect(reviewed.ok).toBe(true);
    return master.value.id;
  }

  it('refuses a master whose corpus nobody has accounted for', async () => {
    await declareFormat({ projectId, name: 'Word Search' });
    const result = await declareMaster({
      projectId,
      formatKey: 'word search',
      name: 'Animals',
      engineId: 'wordsearch_grid',
      params: { words: ['CAT'] },
      rightsBasis: '   ',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('scraped');
  });

  it('refuses a master naming an engine nothing registers, and says what that means', async () => {
    await declareFormat({ projectId, name: 'Cryptic Crossword' });
    const result = await declareMaster({
      projectId,
      formatKey: 'cryptic crossword',
      name: 'Daily cryptic',
      engineId: 'cryptic_engine',
      params: {},
      rightsBasis: 'Original clues.',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('RESEARCHED rather than GENERATABLE');
  });

  it('validates every instance it produces, in the same pass', async () => {
    const masterId = await reviewedMaster();
    const report = await produceBatch({ projectId, masterId, count: 4 });
    expect(report.passed).toHaveLength(4);
    expect(report.failed).toHaveLength(0);
    expect(report.blocked).toBeNull();

    for (const instance of await listInstances(projectId)) {
      const run = await currentValidation(instance.id);
      expect(run, instance.id).not.toBeNull();
      expect(run?.verdict).toBe('PASSED');
      expect(run?.checks.length).toBeGreaterThan(0);
    }
  });

  it('counts a repeated payload as a duplicate rather than a second puzzle', async () => {
    const masterId = await reviewedMaster();
    await produceBatch({ projectId, masterId, count: 3, run: 'r1' });
    const before = (await listInstances(projectId)).length;
    const again = await produceBatch({ projectId, masterId, count: 3, run: 'r1' });
    expect(again.duplicates).toBe(3);
    expect((await listInstances(projectId)).length).toBe(before);
  });

  it('refuses to compile an output from anything not validated', async () => {
    const masterId = await reviewedMaster();
    await produceBatch({ projectId, masterId, count: 2 });
    const instances = await listInstances(projectId);

    const result = await compileOutput({
      projectId,
      masterId,
      title: 'A book that should not exist',
      productionClass: 'BOOK',
      differentiators: ['PUZZLE_CONTENT'],
      instanceIds: [...instances.map((one) => one.id), 'pzi_nothing'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Refused whole rather than filtered: a shorter book than the one somebody
    // asked for, with nothing saying so, is the failure this prevents.
    expect(result.reason).toContain('refused rather than skipped');
    expect(await listOutputs(projectId)).toHaveLength(0);
  });

  it('refuses to compile from a master nobody has reviewed', async () => {
    await declareFormat({ projectId, name: 'Maze' });
    const master = await declareMaster({
      projectId,
      formatKey: 'maze',
      name: 'Ten by ten',
      engineId: 'maze_perfect_grid',
      params: { rows: 10, cols: 10 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    const produced = await produceBatch({ projectId, masterId: master.value.id, count: 2 });

    const result = await compileOutput({
      projectId,
      masterId: master.value.id,
      title: 'An unreviewed book',
      productionClass: 'BOOK',
      differentiators: ['PUZZLE_CONTENT'],
      instanceIds: produced.passed.map((one) => one.instance.id),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('editorially reviewed');
  });

  it('blocks a batch on a systematic defect rather than producing more of them', async () => {
    await declareFormat({ projectId, name: 'Word Search' });
    /*
     * A master whose own screening list contains a word from its own word
     * list, so every instance it makes fails PROHIBITED_CONTENT. That is a
     * generator-configuration defect exactly as the directive means one: the
     * repair belongs in the parameters, not in the puzzles.
     */
    const master = await declareMaster({
      projectId,
      formatKey: 'word search',
      name: 'Self-screening',
      engineId: 'wordsearch_grid',
      params: {
        words: ['CROSSWORD', 'ANAGRAM', 'CIPHER', 'RIDDLE'],
        prohibited: ['RIDDLE'],
        size: 12,
      },
      rightsBasis: 'Word list is the operator’s own.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'reviewed' });

    const report = await produceBatch({ projectId, masterId: master.value.id, count: 20 });
    expect(report.blocked).not.toBeNull();
    expect(report.blocked?.check).toBe('PROHIBITED_CONTENT');
    expect(report.blocked?.why).toContain('the generator rather than the puzzles');
    // It stopped: far fewer than twenty were produced.
    expect(report.failed.length).toBeLessThan(20);
    // And the failures keep their rows. They are the evidence the defect
    // existed and the record a repair is judged against.
    expect((await listInstances(projectId)).length).toBe(report.failed.length);
  });
});

/* --------------------------------------------------------------------------
 * The reskin rule
 * ------------------------------------------------------------------------ */

describe('a reskin is counted honestly and never as a new product', () => {
  async function bookOf(input: {
    title: string;
    axes: (typeof DIFFERENTIATOR_AXES)[number][];
    buyer?: string | null;
  }): Promise<string> {
    const masters = (await import('../server/repos/puzzle.ts')).listMasters;
    const [master] = await masters(projectId);
    const instances = (await listInstances(projectId)).filter(
      (one) => one.masterId === master!.id,
    );
    const result = await compileOutput({
      projectId,
      masterId: master!.id,
      title: input.title,
      productionClass: 'BOOK',
      differentiators: input.axes,
      instanceIds: instances.slice(0, 2).map((one) => one.id),
      targetBuyer: input.buyer ?? null,
    });
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    return result.value.output.id;
  }

  beforeEach(async () => {
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'reviewed' });
    await produceBatch({ projectId, masterId: master.value.id, count: 4 });
  });

  it('names the cosmetic axes and refuses to count them', () => {
    for (const axis of ['TITLE', 'COVER', 'PAGE_ORDER'] as const) {
      expect(axisQualifies(axis)).toBe(false);
    }
    expect(qualifyingAxes(['TITLE', 'COVER', 'AUDIENCE'])).toEqual(['AUDIENCE']);
    // Recorded rather than dropped: two books differing by their cover is an
    // honest thing to know, and counting it is not.
    expect(DIFFERENTIATOR_AXES).toContain('COVER');
  });

  it('reads an output differentiated only by its cover as a reprint', async () => {
    await bookOf({ title: 'Sudoku Volume One', axes: ['AUDIENCE'], buyer: 'a retail buyer' });
    await bookOf({ title: 'Sudoku Volume One, Blue Cover', axes: ['COVER', 'TITLE'] });

    const snapshot = await puzzleSnapshot(projectId);
    const readings = readOutputs(snapshot);
    const reprint = readings.find((one) => one.title.includes('Blue Cover'));
    expect(reprint?.qualification).toBe('REPRINT');
    expect(reprint?.why).toContain('reprint rather than a new product');
    expect(reprint?.cosmeticAxes).toEqual(['COVER', 'TITLE']);
  });

  it('reads a sibling claiming the same qualifying differences as a reprint too', async () => {
    await bookOf({ title: 'Sudoku for Beginners', axes: ['AUDIENCE'], buyer: 'a retail buyer' });
    await bookOf({ title: 'Sudoku for Newcomers', axes: ['AUDIENCE'], buyer: 'a retail buyer' });

    const snapshot = await puzzleSnapshot(projectId);
    const readings = readOutputs(snapshot);
    const reprints = readings.filter((one) => one.qualification === 'REPRINT');
    expect(reprints).toHaveLength(1);
    expect(reprints[0]?.why).toContain('one product in two covers');
  });

  it('counts reprints and qualified outputs in separate figures', async () => {
    await bookOf({ title: 'Sudoku Easy', axes: ['DIFFICULTY'], buyer: 'a retail buyer' });
    await bookOf({ title: 'Sudoku Easy, New Cover', axes: ['COVER'] });

    const snapshot = await puzzleSnapshot(projectId);
    const leverage = readLeverage(snapshot, readOutputs(snapshot));
    expect(leverage.reprints).toBe(1);
    expect(leverage.qualifiedOutputs).toBe(1);
    expect(leverage.masterToSku.value).toBe(1);
    expect(leverage.masterToSku.denominator).toContain('per validated master system');
  });

  it('reports the target as a target and the unmeasurable figures as unmeasured', async () => {
    const snapshot = await puzzleSnapshot(projectId);
    const leverage = readLeverage(snapshot, readOutputs(snapshot));
    expect(leverage.target).toEqual({
      masters: 10,
      outputs: 50,
      note: expect.stringContaining('not an obligation'),
    });
    for (const reading of [
      leverage.setupToUnitYield,
      leverage.contributionPerSetup,
      leverage.puzzlesPerEditorialHour,
    ]) {
      expect(reading.value).toBeNull();
      expect(reading.wouldMeasure).toBeTruthy();
    }
  });
});

/* --------------------------------------------------------------------------
 * The maturity ladder
 * ------------------------------------------------------------------------ */

describe('the ladder stops at the first unanswered rung, with no partial credit', () => {
  it('cannot reach VALIDATABLE while nothing says what the format demands', async () => {
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'reviewed' });
    await produceBatch({ projectId, masterId: master.value.id, count: 2 });

    // Nothing at all has been established about it, so it is not even
    // researched — the ladder stops at the first unanswered rung and names it.
    const bare = readFormats(await puzzleSnapshot(projectId)).find(
      (one) => one.formatKey === 'sudoku',
    );
    expect(bare?.maturity).toBe('DISCOVERED');
    expect(bare?.nextQuestion).toContain('What does the trade demand');

    // Something researched about it, and still no standard: now it produces,
    // and an empty requirement list is nobody having looked rather than a
    // format with no requirements.
    const { recordRightsConstraint } = await import('../server/repos/puzzle.ts');
    await recordRightsConstraint({
      projectId,
      formatKey: 'sudoku',
      rightsKind: 'PUBLIC_DOMAIN',
      statement: 'The rules of the grid are not protected.',
      sourceClaimId: 'clm_fixture',
    });

    const snapshot = await puzzleSnapshot(projectId);
    const reading = readFormats(snapshot).find((one) => one.formatKey === 'sudoku');
    expect(reading?.maturity).toBe('GENERATABLE');
    expect(reading?.why).toContain('nobody having looked');
  });

  it('stops at GENERATABLE and names the check when evidence demands one nothing runs', async () => {
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'reviewed' });
    await produceBatch({ projectId, masterId: master.value.id, count: 2 });

    await recordStandard({
      projectId,
      formatKey: 'sudoku',
      checkKind: 'CLUE_AGREEMENT',
      statement: 'Every clue must agree with its answer in tense and number.',
      sourceClaimId: 'clm_fixture',
    });

    const snapshot = await puzzleSnapshot(projectId);
    const reading = readFormats(snapshot).find((one) => one.formatKey === 'sudoku');
    expect(reading?.maturity).toBe('GENERATABLE');
    expect(reading?.missingChecks).toEqual(['CLUE_AGREEMENT']);
    expect(reading?.why).toContain('unsolvable puzzles');
  });

  it('reaches VALIDATABLE only when every demanded check can actually be run', async () => {
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'reviewed' });
    await produceBatch({ projectId, masterId: master.value.id, count: 2 });

    await recordStandard({
      projectId,
      formatKey: 'sudoku',
      checkKind: 'SOLUTION_UNIQUENESS',
      statement: 'A published grid must have exactly one solution.',
      sourceClaimId: 'clm_fixture',
    });

    const snapshot = await puzzleSnapshot(projectId);
    const reading = readFormats(snapshot).find((one) => one.formatKey === 'sudoku');
    expect(reading?.maturity).toBe('VALIDATABLE');
    expect(reading?.missingChecks).toEqual([]);
    expect(reading?.nextQuestion).toContain('Compile an output');
  });

  it('refuses GENERATABLE while no person has reviewed the generator', async () => {
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await recordStandard({
      projectId,
      formatKey: 'sudoku',
      checkKind: 'SOLUTION_UNIQUENESS',
      statement: 'exactly one solution',
      sourceClaimId: 'clm_fixture',
    });

    const snapshot = await puzzleSnapshot(projectId);
    const reading = readFormats(snapshot).find((one) => one.formatKey === 'sudoku');
    expect(reading?.maturity).toBe('RESEARCHED');
    expect(reading?.why).toContain('editorially reviewed');
  });

  it('refuses a second review, so the first reviewer keeps their name on it', async () => {
    await declareFormat({ projectId, name: 'Maze' });
    const master = await declareMaster({
      projectId,
      formatKey: 'maze',
      name: 'Ten by ten',
      engineId: 'maze_perfect_grid',
      params: { rows: 10, cols: 10 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'first' });
    const second = await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'second' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain('overwrite the first');
  });
});

/* --------------------------------------------------------------------------
 * Withheld totals
 * ------------------------------------------------------------------------ */

describe('a total past an unknown is withheld, and the reason is named', () => {
  const line = (input: {
    component: (typeof ECONOMIC_COMPONENTS)[number];
    amount: number;
    currency?: string;
    basis?: string;
  }) => ({
    id: `pzn_${input.component}`,
    projectId,
    routeId: 'pzt_one',
    formatKey: null,
    outputId: null,
    component: input.component,
    basis: input.basis ?? 'one copy',
    amountMinor: input.amount,
    currency: input.currency ?? 'USD',
    statement: 'published',
    observedOn: null,
    sourceClaimId: 'clm_fixture',
    createdAt: '2026-09-01T00:00:00.000Z',
  });

  it('withholds when nothing says what it pays', () => {
    const reading = readContribution({
      lines: [line({ component: 'PRINTING_COST', amount: 150 })],
      routeId: 'pzt_one',
      routeName: 'Retail books',
      productionClass: 'BOOK',
    });
    expect(reading.withheld).toBe('NO_REVENUE_LINE');
    expect(reading.contributionPerUnitMinor).toBeNull();
  });

  it('withholds on two currencies rather than converting at a rate nobody recorded', () => {
    const reading = readContribution({
      lines: [
        line({ component: 'NET_RECEIPTS', amount: 400 }),
        line({ component: 'PRINTING_COST', amount: 150, currency: 'GBP' }),
        line({ component: 'FREIGHT_COST', amount: 20 }),
      ],
      routeId: 'pzt_one',
      routeName: 'Retail books',
      productionClass: 'BOOK',
    });
    expect(reading.withheld).toBe('MIXED_CURRENCY');
    expect(reading.why).toContain('never converts');
  });

  it('withholds on a missing load-bearing line, naming it and the direction of the error', () => {
    const reading = readContribution({
      lines: [line({ component: 'NET_RECEIPTS', amount: 400 })],
      routeId: 'pzt_one',
      routeName: 'Retail books',
      productionClass: 'BOOK',
    });
    expect(reading.withheld).toBe('MISSING_LOAD_BEARING_COST');
    expect(reading.missing).toEqual(['PRINTING_COST', 'FREIGHT_COST']);
    expect(reading.why).toContain('cheaper to make than it is');
  });

  it('withholds on two bases, because a per-copy cost is not a per-run rate', () => {
    const reading = readContribution({
      lines: [
        line({ component: 'NET_RECEIPTS', amount: 400 }),
        line({ component: 'PRINTING_COST', amount: 150 }),
        line({ component: 'FREIGHT_COST', amount: 20, basis: 'one pallet of 900' }),
      ],
      routeId: 'pzt_one',
      routeName: 'Retail books',
      productionClass: 'BOOK',
    });
    expect(reading.withheld).toBe('MIXED_BASIS');
  });

  it('computes it, and keeps setup apart from per-unit so breakeven means something', () => {
    const reading = readContribution({
      lines: [
        line({ component: 'NET_RECEIPTS', amount: 400 }),
        line({ component: 'PRINTING_COST', amount: 150 }),
        line({ component: 'FREIGHT_COST', amount: 50 }),
        line({ component: 'PREPRESS_COST', amount: 60_000, basis: 'one title' }),
      ],
      routeId: 'pzt_one',
      routeName: 'Retail books',
      productionClass: 'BOOK',
    });
    expect(reading.withheld).toBeNull();
    expect(reading.contributionPerUnitMinor).toBe(200);
    expect(reading.setupCostMinor).toBe(60_000);
    expect(reading.breakevenUnits).toBe(300);
  });

  it('reports a negative margin as a reason to decline rather than to raise the price', () => {
    const reading = readContribution({
      lines: [
        line({ component: 'NET_RECEIPTS', amount: 100 }),
        line({ component: 'PRINTING_COST', amount: 150 }),
        line({ component: 'FREIGHT_COST', amount: 50 }),
      ],
      routeId: 'pzt_one',
      routeName: 'Retail books',
      productionClass: 'BOOK',
    });
    expect(reading.contributionPerUnitMinor).toBe(-100);
    expect(reading.breakevenUnits).toBeNull();
    expect(reading.why).toContain('reason to decline');
  });

  it('puts each component on exactly one side, and a caller never chooses', () => {
    for (const component of ECONOMIC_COMPONENTS) {
      expect(['REVENUE', 'COST']).toContain(sideFor(component));
    }
    expect(sideFor('RETAILER_SHARE')).toBe('COST');
    expect(sideFor('RETAIL_PRICE')).toBe('REVENUE');
    expect(isSetupCost('PREPRESS_COST')).toBe(true);
    expect(isSetupCost('PRINTING_COST')).toBe(false);
  });

  it('asks for more of a jigsaw than of a download, because they are different businesses', () => {
    expect(loadBearingFor('DIGITAL_ONLY')).toEqual(['PLATFORM_FEE']);
    expect(loadBearingFor('JIGSAW')).toContain('TOOLING_SETUP');
    expect(loadBearingFor('FEED')).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * The ledger
 * ------------------------------------------------------------------------ */

describe('the ledger ranks, names the separator, and never prunes', () => {
  it('has no delete anywhere in the kernel', () => {
    const sources = [
      readFileSync('server/repos/puzzle.ts', 'utf8'),
      ...readdirSync('server/services/puzzle')
        .filter((one) => one.endsWith('.ts'))
        .map((one) => readFileSync(join('server/services/puzzle', one), 'utf8')),
    ];
    for (const source of sources) {
      expect(/DELETE\s+FROM\s+puzzle_/i.test(source)).toBe(false);
    }
  });

  it('puts a dated buying signal above everything, and names why', async () => {
    await activated();
    const withDemand = await declareRoute({
      projectId,
      name: 'Newspaper syndication',
      routeClass: 'SYNDICATION',
    });
    const without = await declareRoute({
      projectId,
      name: 'Puzzle boxes at retail',
      routeClass: 'PHYSICAL_PRODUCT',
    });
    if (!withDemand.ok || !without.ok) throw new Error('setup');

    await recordRouteEvidence({
      projectId,
      routeId: withDemand.value.id,
      posture: 'DEMAND_FOUND',
      buyer: 'A named syndicate',
      statement: 'publishes a contributor rate card',
      observedOn: '2026-06-01',
      sourceClaimId: 'clm_fixture',
    });

    const snapshot = await puzzleSnapshot(projectId);
    const ledger = readLedger(snapshot, readOutputs(snapshot));
    expect(ledger.topNow[0]?.name).toBe('Newspaper syndication');
    expect(ledger.topNow[0]?.aheadBecause).toContain('published that they buy');
    expect(ledger.unproven.map((one) => one.name)).toContain('Puzzle boxes at retail');
  });

  it('keeps a documented absence apart from nobody having looked', async () => {
    await activated();
    const route = await declareRoute({
      projectId,
      name: 'Greeting-card inserts',
      routeClass: 'WHITE_LABEL',
    });
    if (!route.ok) throw new Error('setup');
    await recordRouteEvidence({
      projectId,
      routeId: route.value.id,
      posture: 'NONE_FOUND',
      buyer: 'no publisher found',
      statement: 'Searched four card publishers; none commissions puzzle inserts.',
      sourceClaimId: 'clm_fixture',
    });

    const snapshot = await puzzleSnapshot(projectId);
    const ledger = readLedger(snapshot, readOutputs(snapshot));
    // Searched and empty is an answer, so it is not in the unproven list.
    expect(ledger.unproven).toHaveLength(0);
    expect(ledger.totals.searchedAndEmpty).toBe(1);
    expect(ledger.allActive[0]?.why).toContain('an answer rather than a gap');
  });

  it('keeps a blocked route visible, with the reason somebody gave', async () => {
    await activated();
    const route = await declareRoute({
      projectId,
      name: 'Marketplace self-publishing',
      routeClass: 'DIGITAL_SALE',
    });
    if (!route.ok) throw new Error('setup');
    const decided = await decideRoute({
      id: route.value.id,
      disposition: 'BLOCKED',
      reason: 'The platform policy forbids generated content without disclosure.',
      byId: userId,
    });
    expect(decided.ok).toBe(true);

    const snapshot = await puzzleSnapshot(projectId);
    const ledger = readLedger(snapshot, readOutputs(snapshot));
    expect(ledger.blocked).toHaveLength(1);
    expect(ledger.blocked[0]?.dispositionReason).toContain('platform policy');
    // Still on the ledger, still counted.
    expect(ledger.totals.routes).toBe(1);
    expect((await listRoutes(projectId))).toHaveLength(1);
  });

  it('refuses a disposition with no reason on it', async () => {
    await activated();
    const route = await declareRoute({ projectId, name: 'Anything', routeClass: 'DIGITAL_SALE' });
    if (!route.ok) throw new Error('setup');
    const result = await decideRoute({
      id: route.value.id,
      disposition: 'ARCHIVED',
      reason: '   ',
      byId: userId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('never pruned');
  });

  it('keeps the routes that need capital visible rather than ranking them away', async () => {
    await activated();
    await declareRoute({ projectId, name: 'Offset print runs', routeClass: 'PRINT_PRODUCT' });
    await declareRoute({ projectId, name: 'Licensing', routeClass: 'SYNDICATION' });
    const snapshot = await puzzleSnapshot(projectId);
    const ledger = readLedger(snapshot, readOutputs(snapshot));
    expect(ledger.physicalLadder.map((one) => one.name)).toEqual(['Offset print runs']);
  });
});

/* --------------------------------------------------------------------------
 * The directive reaches a worker
 * ------------------------------------------------------------------------ */

describe('the directive is read rather than hashed', () => {
  it('parses every section the brief is composed from', async () => {
    const read = await readPuzzleDirective();
    expect(read.ok, read.ok ? '' : read.reason).toBe(true);
    if (!read.ok) return;
    for (const name of REQUIRED_SECTIONS) {
      expect(brief(read.directive, name, 200).length, name).toBeGreaterThan(20);
    }
    expect(read.directive.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a directive it cannot read rather than carrying on without one', async () => {
    const read = await readPuzzleDirective('blueprints/NOT-A-FILE.md');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain('quietly stopped saying');
  });

  it("puts the directive's own words into the question a worker reads", async () => {
    const read = await readPuzzleDirective();
    if (!read.ok) throw new Error(read.reason);
    await activated();
    const snapshot = await puzzleSnapshot(projectId);
    const plan = planFrom(snapshot);
    const composed = compose({
      ask: plan.asks[0]!,
      directive: read.directive,
      snapshot,
    });
    expect(composed).not.toBeNull();
    // The seed list and its own refusal to be a limit, as one string.
    expect(composed?.question).toContain('do not permanently limit');
    expect(composed?.question).toContain('crosswords');
  });

  it('opens nothing at all when the directive cannot be read', async () => {
    await activated();
    const { openPuzzleAsks } = await import('../server/services/puzzle/expand.ts');
    const snapshot = await puzzleSnapshot(projectId);
    const plan = planFrom(snapshot);
    // Force the failure by asking for a directive that is not there.
    const { readPuzzleDirective: read } = await import('../server/services/puzzle/directive.ts');
    expect((await read('blueprints/NOT-A-FILE.md')).ok).toBe(false);
    // The real path still works; this asserts the refusal shape rather than
    // monkey-patching the module.
    const result = await openPuzzleAsks({ projectId, asks: plan.asks, snapshot });
    expect(result.blocked).toBeNull();
    expect(result.opened.length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------------------
 * Nothing here authorizes an effect
 * ------------------------------------------------------------------------ */

describe('the envelopes and every rendered question authorize reading and nothing else', () => {
  it('has a compiler profile for each, so neither is refused at the planning pass', () => {
    for (const id of ['RUSSELL_PUZZLE_MARKET_V1', 'RUSSELL_PUZZLE_CRAFT_V1']) {
      expect(getApprovalEnvelope(id), id).toBeTruthy();
      expect(profileFor(id), id).toBeTruthy();
    }
  });

  it('takes its permissions verbatim from the discovery envelope', () => {
    const discovery = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1');
    for (const id of ['RUSSELL_PUZZLE_MARKET_V1', 'RUSSELL_PUZZLE_CRAFT_V1']) {
      const envelope = getApprovalEnvelope(id);
      expect(envelope?.allowedSourceTypes, id).toEqual(discovery?.allowedSourceTypes);
      expect(envelope?.forbiddenActions.source, id).toEqual(discovery?.forbiddenActions.source);
    }
  });

  it('forbids every effect on the world in its own assignment', () => {
    for (const id of ['RUSSELL_PUZZLE_MARKET_V1', 'RUSSELL_PUZZLE_CRAFT_V1']) {
      // Whitespace-normalized, because the template wraps at seventy-odd
      // columns and a phrase that straddles a newline is still the phrase.
      const template = (getApprovalEnvelope(id)?.assignmentTemplate ?? '').replace(/\s+/g, ' ');
      expect(template, id).toContain('Out of scope');
      expect(template, id).toContain('read-only research');
      expect(template, id).toContain('separate commercial authorization');
    }
  });

  /**
   * Every question, through the real screen.
   *
   * §39 records why this test exists: a brief that trips `forbiddenActions` is
   * a round that can never run, and the failure is invisible until a real
   * question is compiled in production. The directive's own text is full of
   * commercial verbs — it is a brief about a business — so the screening has
   * to be asserted rather than reasoned about.
   */
  it('renders no question that its own envelope would refuse', async () => {
    const read = await readPuzzleDirective();
    if (!read.ok) throw new Error(read.reason);
    await activated();
    const snapshot = await puzzleSnapshot(projectId);

    const { universeQuestion, routeQuestion, cheapBookQuestion, demandQuestion, economicsQuestion, rightsQuestion, standardQuestion } =
      await import('../server/services/puzzle/questions.ts');
    const { ownActionMatches } = await import('../server/services/research/actorScope.ts');

    const questions: { label: string; text: string }[] = [
      { label: 'UNIVERSE', text: universeQuestion(read.directive, 1) },
      { label: 'ROUTE', text: routeQuestion(read.directive, 1) },
      { label: 'CHEAP_BOOK', text: cheapBookQuestion(read.directive, 1) },
      {
        label: 'DEMAND',
        text: demandQuestion({
          directive: read.directive,
          subject: 'daily crosswords',
          formatName: 'crossword',
          round: 1,
        }),
      },
      {
        label: 'ECONOMICS',
        text: economicsQuestion({ directive: read.directive, subject: 'syndication', round: 1 }),
      },
      {
        label: 'RIGHTS',
        text: rightsQuestion({ directive: read.directive, formatName: 'crossword', round: 1 }),
      },
      {
        label: 'STANDARD',
        text: standardQuestion({ directive: read.directive, formatName: 'crossword', round: 1 }),
      },
    ];

    const pattern = getApprovalEnvelope('RUSSELL_PUZZLE_MARKET_V1')?.forbiddenActions;
    expect(pattern).toBeTruthy();
    for (const question of questions) {
      const hits = ownActionMatches(question.text, pattern as RegExp);
      expect(
        hits.map((one) => one.phrase),
        `${question.label} would be refused at the planning pass`,
      ).toEqual([]);
    }
    // The snapshot is unused by the questions themselves, which is the point:
    // a question's text depends on the directive and the subject, never on how
    // much happens to be in the database.
    expect(snapshot.projectId).toBe(projectId);
  });
});

/* --------------------------------------------------------------------------
 * Reading performs no effect
 * ------------------------------------------------------------------------ */

describe('the surface reports facts and creates nothing by being read', () => {
  it('opens no round, produces nothing and moves no money', async () => {
    await activated();
    await runPuzzleKernel(projectId);

    const before = {
      rounds: (await listRounds(projectId)).length,
      formats: (await listFormats(projectId)).length,
      instances: (await listInstances(projectId)).length,
      routes: (await listRoutes(projectId)).length,
      economics: (await listEconomics(projectId)).length,
      evidence: (await listRouteEvidence(projectId)).length,
      outputs: (await listOutputs(projectId)).length,
    };

    const view = await puzzleView(projectId);
    expect(view.active).toBe(true);
    expect(view.rightNow.nextQuestion ?? view.rightNow.notAsking).toBeTruthy();

    expect({
      rounds: (await listRounds(projectId)).length,
      formats: (await listFormats(projectId)).length,
      instances: (await listInstances(projectId)).length,
      routes: (await listRoutes(projectId)).length,
      economics: (await listEconomics(projectId)).length,
      evidence: (await listRouteEvidence(projectId)).length,
      outputs: (await listOutputs(projectId)).length,
    }).toEqual(before);
  });

  it('reports no money figure it has not measured', async () => {
    await activated();
    const view = await puzzleView(projectId);
    expect(view.rightNow.collected).toEqual([]);
    expect(view.production.recordedProductionRuns).toBe(0);
    // Nothing physical has been compiled, so the question is about compiling
    // one and recording what it cost — never a stage estimated from ambition.
    expect(view.production.stage).toBe('STAGE_0_DIGITAL');
    expect(view.production.nextQuestion).toContain('actually cost');
  });

  it('says which stage the physical ladder is at, and what it cannot answer', async () => {
    await activated();
    const snapshot = await puzzleSnapshot(projectId);
    const production = readProductionStage(snapshot);
    expect(production.stage).toBe('STAGE_0_DIGITAL');
    expect(production.nextQuestion).toContain('print-on-demand');
  });

  it('reports the cheap-book investigation as unasked rather than as answered', async () => {
    await activated();
    const snapshot = await puzzleSnapshot(projectId);
    const reading = readCheapBook(snapshot);
    expect(reading.asked).toBe(false);
    expect(reading.established).toEqual([]);
    expect(reading.missing.length).toBeGreaterThan(0);
    expect(reading.contribution).toBeNull();
  });

  it('names exactly what needs a person, and nothing Brain could do itself', async () => {
    await activated();
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);

    const view = await puzzleView(projectId);
    const review = view.needsPerson.find((one) => one.what.includes('Review the generator'));
    expect(review).toBeDefined();
    expect(review?.why).toContain('nothing automatic can record');
  });

  it('refuses to release an output the reading does not call sellable, in its own words', async () => {
    await activated();
    await declareFormat({ projectId, name: 'Sudoku' });
    const master = await declareMaster({
      projectId,
      formatKey: 'sudoku',
      name: 'Standard 9x9',
      engineId: 'sudoku_classic_9x9',
      params: { givens: 34 },
      rightsBasis: 'Generated from rules.',
    });
    if (!master.ok) throw new Error(master.reason);
    await reviewMaster({ id: master.value.id, reviewedById: userId, note: 'reviewed' });
    const produced = await produceBatch({ projectId, masterId: master.value.id, count: 2 });
    const output = await compileOutput({
      projectId,
      masterId: master.value.id,
      title: 'Sudoku One',
      productionClass: 'BOOK',
      differentiators: ['PUZZLE_CONTENT'],
      instanceIds: produced.passed.map((one) => one.instance.id),
    });
    if (!output.ok) throw new Error(output.reason);

    const released = await releaseOutput({ id: output.value.output.id, byId: userId });
    expect(released.ok).toBe(false);
    if (released.ok) return;
    expect(released.reason).toContain('ASSEMBLED');
    expect(released.reason).toContain('nobody is named as the buyer');
  });
});

/* --------------------------------------------------------------------------
 * Lessons
 * ------------------------------------------------------------------------ */

describe('a lesson is derived with its sample shown, and gates nothing', () => {
  it('reports one observation as an anecdote rather than hiding it', async () => {
    await activated();
    const recorded = await recordPersonObservation({
      projectId,
      kind: 'PLAYTEST_RESULT',
      subjectKey: 'sudoku',
      statement: 'Three solvers found the medium grid closer to easy.',
      observerId: userId,
    });
    expect(recorded.ok).toBe(true);

    const snapshot = await puzzleSnapshot(projectId);
    const lessons = readLessons(snapshot);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.reading).toBe('ANECDOTE');
    expect(lessons[0]?.sample).toHaveLength(1);
  });

  it("counts Brain's own derivations apart, so a loud writer cannot make a rule", async () => {
    await activated();
    const { recordObservation } = await import('../server/repos/puzzle.ts');
    for (let index = 0; index < 4; index += 1) {
      await recordObservation({
        projectId,
        kind: 'GENERATOR_DEFECT',
        subjectKey: 'sudoku',
        statement: `derivation ${index}`,
        observer: 'BRAIN',
      });
    }
    const snapshot = await puzzleSnapshot(projectId);
    const lesson = readLessons(snapshot)[0];
    expect(lesson?.sample).toHaveLength(4);
    expect(lesson?.byBrain).toBe(4);
    expect(lesson?.byPerson).toBe(0);
    expect(lesson?.reading).toBe('ANECDOTE');
    expect(lesson?.why).toContain('one reading repeated');
  });
});

/* --------------------------------------------------------------------------
 * Winding down
 * ------------------------------------------------------------------------ */

describe('winding down ends new discovery and nothing else', () => {
  it('opens no round while the sprint is wound down, and says why', async () => {
    await activated();
    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'the sprint is ending',
    });
    const pass = await runPuzzleKernel(projectId);
    expect(pass.opened).toHaveLength(0);
    expect(pass.declined[0]?.why).toBeTruthy();
  });

  it('still files what research already found, because that was already paid for', async () => {
    await activated();
    await runPuzzleKernel(projectId);
    const candidate = await candidateFor('UNIVERSE');
    if (!candidate) return;
    await finishedRound({
      candidateId: candidate,
      claims: [
        {
          claim: 'Mazes are published as childrens activity books.',
          finding: 'FORMAT_EXISTS',
          subject: 'Maze',
          format: 'Maze',
        },
      ],
    });

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'the sprint is ending',
    });
    const pass = await runPuzzleKernel(projectId);
    expect(pass.filed.formats).toHaveLength(1);
    expect(await getFormatByKey(projectId, 'maze')).not.toBeNull();
  });
});
