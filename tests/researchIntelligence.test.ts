/**
 * The judgement layer, written as the ways it could be wrong.
 *
 * Every test here is a decision that used to have no home: which unknown could
 * wreck the path, what a finding should change about the plan, when a
 * disagreement has to be attacked before anything is written up, when research
 * has done its job, and which questions are genuinely a person's rather than
 * Brain declining its own work.
 *
 * Three rules shape the file:
 *
 * - **Nothing is proved against a fixture the production path cannot produce.**
 *   The rows are made with `createFragments`, `createRequirements` and the real
 *   tools, so a decision that only works on a hand-built state fails here.
 * - **Every scenario is run in more than one domain.** A faculty that only
 *   works on commercial questions is a Cash planner with a general name, so the
 *   same director decides a licensing question, a software reliability question
 *   and a film-history question.
 * - **The refusals are the half that matters.** A proposal that widens its own
 *   authority, a person-only request over discoverable work, a challenge to a
 *   challenge, a depth allocation that lowers a bar — each one is asserted to be
 *   refused, because those are the failures nobody would notice.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  getFragment,
  listClaimsForFragment,
  listFragments,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { listCoverage, listRequirements } from '../server/repos/reconciliation.ts';
import { getDb } from '../server/db/database.ts';
import { getOrchestration } from '../server/repos/research.ts';
import { claimWork, enqueueWork, listWorkItems } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { advancePacket, approvePlan } from '../server/services/research/packetRunner.ts';
import { allocateDepth, floorFor, strongerDepth } from '../server/services/research/intelligence/depth.ts';
import {
  ensureProblemModel,
  inheritedWeight,
  readExamples,
  reviseProblemModel,
} from '../server/services/research/intelligence/model.ts';
import {
  direct,
  type DirectorSnapshot,
} from '../server/services/research/intelligence/director.ts';
import {
  rank,
  readGraph,
  seedUncertainties,
} from '../server/services/research/intelligence/uncertainty.ts';
import { directResearch } from '../server/services/research/intelligence/apply.ts';
import {
  assessSufficiency,
  mayProceedToSynthesis,
} from '../server/services/research/intelligence/sufficiency.ts';
import { applyProposal } from '../server/services/research/intelligence/proposals.ts';
import {
  measureCampaign,
  recordRetrospective,
  reconcileRetrospectives,
} from '../server/services/research/intelligence/retrospective.ts';
import { researchIntelligenceView } from '../server/services/research/intelligence/view.ts';
import {
  currentProblemModel,
  getUncertainty,
  listPlanRevisions,
  listUncertainties,
  listUncertaintyLinks,
  openUncertainty,
  reusableLessons,
  setUncertaintyDisposition,
} from '../server/repos/researchIntelligence.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  Project,
  ResearchFragment,
  ResearchOrchestration,
  WorkerScope,
} from '../server/domain/types.ts';

const FULL: WorkerScope[] = [
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

let project: Project;
let layer: Layer;
let workerId = '';

async function principalFor(scopes: WorkerScope[] = FULL): Promise<Principal> {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'test-worker',
    displayName: 'Test Worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_test',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_test',
        projectId: project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'seed',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      },
    ],
    requestId: 'req_test',
  };
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: await principalFor(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    await call(name, args);
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  }
  throw new Error(`${name} was expected to refuse and did not.`);
}

/**
 * Three domains, run through the same faculty.
 *
 * The point is that nothing below reads a word of them: the director decides on
 * statuses, link kinds and claim states, so an opportunity question, a
 * reliability question and a film-history question take the identical path. A
 * decision that needed the subject would fail on two of the three.
 */
const DOMAINS = [
  {
    name: 'a commercial opportunity',
    title: 'Whether transcription overflow work is worth taking',
    question: 'Is there an identifiable buyer who already pays for transcription overflow?',
    decisive: 'reachable-payer',
    dependent: 'fulfilment-cost',
  },
  {
    name: 'an operational reliability question',
    title: 'Why the nightly export fails intermittently',
    question: 'Does the export failure correlate with the storage provider\'s published incidents?',
    decisive: 'failure-is-external',
    dependent: 'retry-policy-shape',
  },
  {
    name: 'a film-history question',
    title: 'Whether the 1927 cut survives anywhere',
    question: 'Does any archive hold a print of the 1927 cut?',
    decisive: 'print-survives',
    dependent: 'restoration-feasibility',
  },
] as const;

async function makeOrchestration(title: string, assignment: string): Promise<ResearchOrchestration> {
  const run = await createRun({
    projectId: project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: assignment,
  });
  return await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title,
    assignment,
    provider: 'WORKER',
    autoApprove: false,
  });
}

async function makeFragment(
  orchestration: ResearchOrchestration,
  over: Partial<Parameters<typeof createFragments>[0][number]> & { fragmentKey: string },
): Promise<ResearchFragment> {
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: project.id,
      layerId: layer.id,
      fragmentIndex: 0,
      question: `Question for ${over.fragmentKey}.`,
      geography: 'United States',
      timeframe: 'as at 2026',
      population: null,
      definitions: null,
      requiredEvidence: [{ id: 'primary', description: 'a primary source', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['statute', 'official register'],
      excludedSourceTypes: ['blog'],
      completionCriteria: ['One source that answers yes or no.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
      ...over,
    },
  ]);
  return fragment!;
}

/** A snapshot with the packet's real rows in it, so nothing is hand-built. */
async function snapshotOf(
  orchestration: ResearchOrchestration,
  extra: Partial<DirectorSnapshot> = {},
): Promise<DirectorSnapshot> {
  const graph = await readGraph(orchestration.id);
  const fragments = await listFragments(orchestration.id);
  const claims = [];
  for (const fragment of fragments) claims.push(...(await listClaimsForFragment(fragment.id)));
  return {
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    fragments,
    claims,
    uncertainties: graph.uncertainties,
    links: graph.links,
    requirements: await listRequirements(orchestration.id),
    coverage: await listCoverage(orchestration.id),
    mayRecordGaps: orchestration.unresolvedGapPolicy === 'RECORD_GAPS',
    ...extra,
  };
}

async function claimFor(
  orchestration: ResearchOrchestration,
  type: string,
  fragment: ResearchFragment | null,
  payload: Record<string, unknown> = {},
): Promise<ClaimedWork> {
  const definition = workType(type);
  await enqueueWork({
    projectId: project.id,
    workType: type,
    payload: definition.validate(payload),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: fragment?.id ?? null,
    createdByType: 'SYSTEM',
  });
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId: project.id, scopes: FULL }],
    workTypes: [type],
  });
  if (!claimed) throw new Error(`nothing claimable of type ${type}`);
  return claimed;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

const SOURCED = {
  claim: 'The register lists 412 active holders as at March 2026.',
  claim_type: 'SOURCED_FACT',
  source_url: 'https://example.gov/register/holders',
  source_title: 'Register of active holders',
  source_publisher: 'State register',
  source_date: '2026-03-01',
  evidence_excerpt: 'Active holders: 412.',
  evidence_locator: 'table 1',
  evidence_lane: 'primary',
  retrieved_at: '2026-08-28',
  confidence: 0.95,
  primary_source: true,
};

const MATCHES = {
  geography: 'MATCH',
  timeframe: 'MATCH',
  population: 'MATCH',
  definitions: 'MATCH',
  geography_basis: 'Judged against the geography the fragment declares.',
  timeframe_basis: 'Judged against the timeframe the fragment declares.',
  population_basis: 'Judged against the population the fragment declares.',
  definitions_basis: 'Judged against the definitions the fragment declares.',
};

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layer = await fixture.layerByName('Monetization Logic');
  const worker = await createWorker({
    name: 'test-worker',
    displayName: 'Test Worker',
    createdByType: 'SYSTEM',
    createdById: 'seed',
  });
  workerId = worker.id;
  await grantMembership({
    projectId: project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: FULL,
    grantedByType: 'SYSTEM',
    grantedById: 'seed',
  });
});

// ---------------------------------------------------------------------------
// What Brain believes it was asked
// ---------------------------------------------------------------------------

describe('the reading of the objective', () => {
  it('records a default as a default, never as something somebody said', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment about something.');
    const model = await ensureProblemModel(orchestration);

    // Nobody has stated the stakes, so the row says MODERATE and says where the
    // reading came from. A packet nobody has told Brain the stakes of is not a
    // low-stakes packet, and it is not a critical one.
    expect(model.stakes).toBe('MODERATE');
    expect(model.derivedFrom).toBe('ASSIGNMENT');
    expect(model.version).toBe(1);
    // Never a paraphrase of the question dressed as a decision.
    expect(model.decisionSupported).toBeNull();
  });

  it('is versioned rather than edited, so the plan stays explicable', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const first = await ensureProblemModel(orchestration);
    const second = await reviseProblemModel({
      orchestration,
      derivedFrom: 'PERSON',
      reason: 'The owner said this decides whether to sign.',
      revision: { decisionSupported: 'Whether to sign the contract', stakes: 'CRITICAL' },
    });

    expect(second.version).toBe(2);
    expect(second.revisedFromVersion).toBe(1);
    expect(second.stakes).toBe('CRITICAL');
    // The old reading is untouched: it is what explains the plan that already
    // ran, and a campaign whose interpretation could be rewritten afterwards is
    // one whose fragments cannot be accounted for.
    const current = await currentProblemModel(orchestration.id);
    expect(current?.version).toBe(2);
    expect(first.stakes).toBe('MODERATE');
  });

  it('never lets a revision widen the authority the packet holds', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await updateOrchestration(orchestration.id, {
      approvalEnvelopeId: 'RUSSELL_PUBLIC_RECORDS_V1',
    });
    const reloaded = { ...orchestration, approvalEnvelopeId: 'RUSSELL_PUBLIC_RECORDS_V1' };
    const first = await ensureProblemModel(reloaded);
    expect(first.authorityGranted.length).toBeGreaterThan(0);

    const revised = await reviseProblemModel({
      orchestration: reloaded,
      derivedFrom: 'PROPOSAL',
      reason: 'A worker read the objective more carefully.',
      revision: { stakes: 'HIGH' },
    });
    // Carried verbatim. There is no field on the revision that could change it.
    expect(revised.authorityGranted).toEqual(first.authorityGranted);
  });

  /**
   * Required scenario 2, at the layer where it is decided.
   *
   * The examples a person gives illustrate a property. Stored without it, the
   * only safe reading is a whitelist and search never looks past the three
   * things they happened to name.
   */
  it('reads examples as properties to generalise over, not as a whitelist', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const revised = await reviseProblemModel({
      orchestration,
      derivedFrom: 'PERSON',
      reason: 'The owner listed some industries as illustrations.',
      revision: {
        examples: [
          { statement: 'legal transcription', property: 'a buyer who already outsources this' },
          { statement: 'medical transcription', property: 'a buyer who already outsources this' },
          { statement: 'court reporting', property: null },
        ],
      },
    });

    const reading = readExamples(revised);
    expect(reading.generalisableProperties).toEqual(['a buyer who already outsources this']);
    expect(reading.exhaustiveWouldBeWrong).toBe(true);
    // The one with no property is kept verbatim and is not turned into a
    // property by guessing. Inferring it would be the compiler reading intent.
    expect(reading.unexplained.map((one) => one.statement)).toEqual(['court reporting']);
  });

  it('inherits weight from the packet rather than defaulting every question', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await reviseProblemModel({
      orchestration,
      derivedFrom: 'PERSON',
      reason: 'Irreversible.',
      revision: { stakes: 'HIGH', reversibility: 'IRREVERSIBLE' },
    });
    const model = await currentProblemModel(orchestration.id);
    expect(inheritedWeight(model)).toEqual({
      consequence: 'HIGH',
      reversibility: 'IRREVERSIBLE',
    });
    expect(inheritedWeight(null)).toEqual({
      consequence: 'MODERATE',
      reversibility: 'REVERSIBLE',
    });
  });
});

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

describe('how hard to look', () => {
  it('reaches for more only, and names the input that decided it', () => {
    const conflicted = allocateDepth({
      consequence: 'LOW',
      reversibility: 'REVERSIBLE',
      invalidating: false,
      conflictingClaims: 2,
      expectedClaimTypes: ['STATUTORY'],
    });
    expect(conflicted.depth).toBe('CONTESTED_DEEP');
    expect(conflicted.basis).toContain('disagree');

    const decisive = allocateDepth({
      consequence: 'LOW',
      reversibility: 'REVERSIBLE',
      invalidating: true,
      conflictingClaims: 0,
      expectedClaimTypes: [],
    });
    expect(decisive.depth).toBe('CONTESTED_DEEP');

    const irreversible = allocateDepth({
      consequence: 'LOW',
      reversibility: 'IRREVERSIBLE',
      invalidating: false,
      conflictingClaims: 0,
      expectedClaimTypes: [],
    });
    expect(irreversible.depth).toBe('CONTESTED_DEEP');
  });

  /**
   * Required scenario 8: one directly inspected primary source settles a
   * statutory fact, and padding the source count buys nothing.
   */
  it('settles a statutory fact on one primary source when nothing rides on it', () => {
    const decision = allocateDepth({
      consequence: 'LOW',
      reversibility: 'REVERSIBLE',
      invalidating: false,
      conflictingClaims: 0,
      expectedClaimTypes: ['STATUTORY'],
    });
    expect(decision.depth).toBe('SINGLE_PRIMARY');
    expect(floorFor('SINGLE_PRIMARY')).toBe(1);
  });

  it('will not take the downgrade when the claim type was never stated', () => {
    // A plan that said nothing about what kind of claim will answer the question
    // has not earned the one rung that reduces corroboration.
    const decision = allocateDepth({
      consequence: 'LOW',
      reversibility: 'REVERSIBLE',
      invalidating: false,
      conflictingClaims: 0,
      expectedClaimTypes: [],
    });
    expect(decision.depth).toBe('CORROBORATED');
  });

  it('compares rungs by order, so a raise can never become a cut', () => {
    expect(strongerDepth('SINGLE_PRIMARY', 'CONTESTED_DEEP')).toBe('CONTESTED_DEEP');
    expect(strongerDepth('CONTESTED_DEEP', 'SINGLE_PRIMARY')).toBe('CONTESTED_DEEP');
    expect(floorFor('CONTESTED_DEEP')).toBeGreaterThan(floorFor('CORROBORATED'));
  });
});

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

describe('the uncertainty graph', () => {
  it('opens one question per planned fragment and reads the dependency kinds', async () => {
    const orchestration = await makeOrchestration('Licensing', 'Whether a licence is needed.');
    const trigger = await makeFragment(orchestration, { fragmentKey: 'trigger', fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      dependsOn: [{ key: 'trigger', kind: 'CONDITIONAL' }],
    });
    await makeFragment(orchestration, {
      fragmentKey: 'context',
      fragmentIndex: 2,
      dependsOn: [{ key: 'trigger', kind: 'SEQUENCING' }],
    });
    await makeFragment(orchestration, {
      fragmentKey: 'definition-user',
      fragmentIndex: 3,
      dependsOn: [{ key: 'trigger', kind: 'HARD' }],
    });

    const model = await ensureProblemModel(orchestration);
    const fragments = await listFragments(orchestration.id);
    const seeded = await seedUncertainties({ orchestration, fragments, model, planVersion: 1 });
    expect(seeded.opened).toHaveLength(4);

    const links = await listUncertaintyLinks(orchestration.id);
    const kindFor = (to: string): string | undefined =>
      links.find((link) => link.toKey === to)?.kind;
    expect(kindFor('penalty')).toBe('CONDITIONAL');
    // Sequencing becomes evidentiary rather than being dropped: it says the two
    // bear on each other and that a failure costs nothing.
    expect(kindFor('context')).toBe('EVIDENTIARY');
    expect(kindFor('definition-user')).toBe('HARD_PREREQUISITE');

    // The one something is HARD-built on is the one that can wreck the path, and
    // that is read from `depends_on` rather than inferred from any prose.
    const trig = await getUncertainty(orchestration.id, 'trigger');
    expect(trig?.invalidating).toBe(true);
    expect(trig?.consequence).toBe('CRITICAL');
    expect(trigger.fragmentKey).toBe('trigger');
  });

  it('is idempotent, so a restart re-derives nothing', async () => {
    const orchestration = await makeOrchestration('Licensing', 'Whether a licence is needed.');
    await makeFragment(orchestration, { fragmentKey: 'one', fragmentIndex: 0 });
    const model = await ensureProblemModel(orchestration);
    const fragments = await listFragments(orchestration.id);

    const first = await seedUncertainties({ orchestration, fragments, model, planVersion: 1 });
    const second = await seedUncertainties({ orchestration, fragments, model, planVersion: 1 });
    expect(first.opened).toHaveLength(1);
    expect(second.opened).toHaveLength(0);
    expect(await listUncertainties(orchestration.id)).toHaveLength(1);
  });

  it('ranks by what can wreck the path, then consequence, then connectivity', async () => {
    const orchestration = await makeOrchestration('Ordering', 'What to look at first.');
    for (const [key, over] of [
      ['ordinary', {}],
      ['high-stakes', { consequence: 'HIGH' as const }],
      ['decisive', { invalidating: true }],
    ] as const) {
      await openUncertainty({
        orchestrationId: orchestration.id,
        projectId: project.id,
        uncertaintyKey: key,
        question: `Question ${key}`,
        whyItMatters: 'Because.',
        consumerKind: 'DECISION',
        stoppingCondition: 'Answered.',
        ...over,
      });
    }
    const graph = await readGraph(orchestration.id);
    const ordered = rank(graph.uncertainties, graph.links).map((one) => one.uncertainty.uncertaintyKey);
    expect(ordered).toEqual(['decisive', 'high-stakes', 'ordinary']);
    // And the sentence says which tier put it there, rather than a number.
    const top = rank(graph.uncertainties, graph.links)[0]!;
    expect(top.why).toContain('pointless');
  });
});

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

describe.each(DOMAINS)('the director, on $name', (domain) => {
  /**
   * Required scenario 1, and the ordering lesson behind it.
   *
   * The decisive prerequisite fails. Everything that only matters if it holds is
   * retired with the reason, and work that would have contributed anyway is
   * left alone.
   */
  it('retires what only mattered if the decisive question held, and nothing else', async () => {
    const orchestration = await makeOrchestration(domain.title, domain.question);
    await makeFragment(orchestration, { fragmentKey: domain.decisive, fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: domain.dependent,
      fragmentIndex: 1,
      dependsOn: [{ key: domain.decisive, kind: 'HARD' }],
    });
    await makeFragment(orchestration, {
      fragmentKey: 'background',
      fragmentIndex: 2,
      dependsOn: [{ key: domain.decisive, kind: 'SEQUENCING' }],
    });

    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    // The decisive question ran out of attempts on its own evidence.
    const decisive = (await listFragments(orchestration.id)).find(
      (fragment) => fragment.fragmentKey === domain.decisive,
    )!;
    // Out of attempts rather than merely failed. `attempt` is deliberately not
    // writable — §5 keeps the history — so the budget is what is lowered, which
    // is the same fact from the other side: `buildRepairPlan` plans
    // MARK_UNRESOLVED once there is no further search worth spending on.
    await updateFragment(decisive.id, {
      status: 'BLOCKED',
      maxRepairs: 0,
      blockedReason: 'No source establishes it and the repair ladder is exhausted.',
    });

    const verdict = direct(await snapshotOf(orchestration));
    const kinds = verdict.decisions.map((one) => one.kind);
    expect(kinds).toContain('MARK_UNRESOLVABLE');

    const retired = verdict.decisions.filter((one) => one.kind === 'RETIRE_BRANCH');
    expect(retired.map((one) => one.uncertaintyKey)).toEqual([domain.dependent]);
    // The reason names the finding rather than being a bare status.
    expect(retired[0]!.why).toContain('could not be established');

    // Required scenario 5: the evidentiary dependent is untouched. A failure
    // there costs nothing, and cancelling it would throw away work that can
    // still contribute.
    expect(retired.map((one) => one.uncertaintyKey)).not.toContain('background');
  });

  /**
   * Required scenario 4: an unreadable source is a fact about the network, not
   * a finding about the world.
   */
  it('records an access failure without closing the question', async () => {
    const orchestration = await makeOrchestration(domain.title, domain.question);
    const fragment = await makeFragment(orchestration, {
      fragmentKey: domain.decisive,
      fragmentIndex: 0,
      status: 'QUEUED',
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', {
      ...proof(claimed),
      claims: [{ ...SOURCED, retrieval_state: 'PAYWALLED' }],
    });
    await updateFragment(fragment.id, {
      status: 'BLOCKED',
      blockedReason: 'The only source was behind a paywall.',
    });

    const verdict = direct(await snapshotOf(orchestration));
    const access = verdict.decisions.find((one) => one.kind === 'MARK_ACCESS_BLOCKED');
    expect(access).toBeDefined();
    // Not refuted, not unresolvable, not resolved. The question is exactly as
    // open as it was, which is the whole distinction.
    expect(verdict.decisions.some((one) => one.kind === 'MARK_UNRESOLVABLE')).toBe(false);

    await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    const after = await getUncertainty(orchestration.id, domain.decisive);
    expect(after?.disposition).toBe('INVESTIGATING');
    expect(after?.dispositionReason).toContain('could not be opened');
  });

  /**
   * Required scenario 6: two credible sources disagree, the disagreement
   * becomes work, and nothing is written up over it in the meantime.
   */
  it('turns a disagreement into targeted work and refuses synthesis until it is done', async () => {
    const orchestration = await makeOrchestration(domain.title, domain.question);
    const fragment = await makeFragment(orchestration, {
      fragmentKey: domain.decisive,
      fragmentIndex: 0,
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', {
      ...proof(claimed),
      claims: [
        SOURCED,
        {
          ...SOURCED,
          claim: 'A second publisher puts the figure at 260 for the same month.',
          source_url: 'https://example.org/second/count',
          source_title: 'Second count',
          source_publisher: 'Another publisher',
        },
      ],
    });
    const stored = await listClaimsForFragment(fragment.id);
    await call('brain_report_contradiction', {
      ...proof(claimed),
      claim_id: stored[0]!.id,
      conflicting_claim_id: stored[1]!.id,
      state: 'CONTESTED',
      note: 'The two publishers give different totals for the same month.',
    });
    await call('brain_complete_work', { ...proof(claimed), summary: 'claims in' });

    // Verified and accepted. A contested claim with an account of the challenge
    // still clears the gate — what it must not do is reach a synthesis with
    // nobody having investigated the disagreement.
    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: stored.map((claim) => ({
        claim_id: claim.id,
        supports_claim: true,
        ...MATCHES,
        note: 'Reads directly.',
      })),
      sufficiency: 'SUFFICIENT',
    });
    expect(
      (await listClaimsForFragment(fragment.id)).filter((claim) => claim.accepted).length,
    ).toBeGreaterThan(0);

    /*
     * Nothing is called by hand from here. `brain_submit_verification`
     * advances the packet, the runner runs the director, and the challenge
     * exists because the production path made it — which is the only version
     * of this test worth having.
     */
    const created = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === `${domain.decisive}--challenge`,
    );
    expect(created).toBeDefined();
    // Never "pick the higher figure" — the stopping condition is to explain the
    // disagreement or find a source that settles it.
    expect(created!.question).toContain('Establish the disagreement');
    expect(created!.status).toBe('PLANNED');
    expect(created!.geography).toBe(fragment.geography);
    expect(created!.minIndependentSources).toBeGreaterThanOrEqual(fragment.minIndependentSources);
    // The claims the challenge is about, carried onto the fragment so the
    // packet check can see a conflict fragment is open. One rather than two:
    // `brain_report_contradiction` marks the claim being challenged, and the
    // claim it conflicts with keeps its own state until somebody challenges it
    // too — the director reads rows, so it carries what the rows say.
    expect(created!.contradictionTargets).toEqual([stored[0]!.id]);

    // And the depth went up, because a live disagreement is the one condition
    // where more looking is certain to buy something.
    expect((await getUncertainty(orchestration.id, domain.decisive))?.depth).toBe(
      'CONTESTED_DEEP',
    );

    // A second pass creates nothing: the challenge is opened once.
    const again = await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    expect(again.created).toBe(0);

    // And the packet may not be written up while it is outstanding.
    const graph = await readGraph(orchestration.id);
    const reading = assessSufficiency({
      uncertainties: graph.uncertainties,
      links: [],
      requirements: [],
      coverage: [],
      claims: await listClaimsForFragment(fragment.id),
      fragments: await listFragments(orchestration.id),
      mayRecordGaps: false,
    });
    expect(reading.verdict).toBe('CONTRADICTION_OPEN');
    expect(mayProceedToSynthesis(reading).ok).toBe(false);
  });

  it('will not open a challenge to a challenge', async () => {
    const orchestration = await makeOrchestration(domain.title, domain.question);
    await makeFragment(orchestration, { fragmentKey: domain.decisive, fragmentIndex: 0 });
    await openUncertainty({
      orchestrationId: orchestration.id,
      projectId: project.id,
      uncertaintyKey: `${domain.decisive}--challenge`,
      question: 'Which account is right?',
      whyItMatters: 'Two sources disagree.',
      consumerKind: 'CONCLUSION',
      stoppingCondition: 'The disagreement is explained.',
      origin: 'CONTRADICTION',
    });

    const outcome = await applyProposal({
      orchestration,
      actorRef: 'wkr_test',
      actions: [
        {
          action: 'OPEN_UNCERTAINTY',
          why: 'A second disagreement about the resolution.',
          uncertainty_key: `${domain.decisive}--challenge--challenge`,
          question: 'Which resolution of the disagreement is right?',
          why_it_matters: 'Two sources disagree about the disagreement.',
          stopping_condition: 'Settled.',
        },
      ],
    });
    // A worker may still *open the question* — that is judgement and it is
    // recorded. What is refused is Brain spending another automatic round on it.
    expect(outcome.ok).toBe(true);

    const fragments = await listFragments(orchestration.id);
    const verdict = direct({
      ...(await snapshotOf(orchestration)),
      fragments,
    });
    const challenges = verdict.decisions.filter((one) => one.kind === 'OPEN_CHALLENGE');
    expect(challenges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adaptive planning
// ---------------------------------------------------------------------------

describe('changing the plan while it runs', () => {
  /**
   * Required scenario 7. An early finding makes part of the plan irrelevant and
   * raises a new decisive question; both happen without a person rewriting
   * anything, and both are recorded with reasons.
   */
  it('retires what stopped mattering and turns a new question into real work', async () => {
    const orchestration = await makeOrchestration(
      'Whether overflow transcription is worth taking',
      'Establish whether there is a payer and what it would cost to serve them.',
    );
    await makeFragment(orchestration, { fragmentKey: 'scout-payer', fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: 'fulfilment',
      fragmentIndex: 1,
      dependsOn: [{ key: 'scout-payer', kind: 'HARD' }],
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    // The scout comes back with a finding nothing could derive from a status:
    // the buyers exist but buy through an intermediary nobody can reach.
    const proposal = await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'OPEN_UNCERTAINTY',
          why: 'The scout found the demand sits behind one intermediary.',
          uncertainty_key: 'intermediary-access',
          question: 'Can the intermediary be reached on published terms?',
          why_it_matters: 'Every buyer found so far buys only through it.',
          stopping_condition: 'Published terms of access are found, or their absence documented.',
          consequence: 'CRITICAL',
          invalidating: true,
          because_of: 'scout-payer',
        },
      ],
    });
    expect(proposal.ok).toBe(true);
    expect((proposal as { applied: string[] }).applied[0]).toContain('intermediary-access');

    // The follow-up is linked to what raised it, so "what changed the plan" has
    // an answer.
    const links = await listUncertaintyLinks(orchestration.id);
    expect(
      links.find((link) => link.toKey === 'intermediary-access')?.kind,
    ).toBe('FOLLOW_UP');

    // The new question becomes work — PLANNED, so it still goes through this
    // packet's own approval.
    const applied = await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    expect(applied.created).toBe(1);
    const created = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === 'intermediary-access',
    );
    expect(created?.status).toBe('PLANNED');

    // Now the original scout fails, and what only mattered if it held is retired.
    const scout = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === 'scout-payer',
    )!;
    await updateFragment(scout.id, {
      status: 'BLOCKED',
      maxRepairs: 0,
      blockedReason: 'No reachable payer could be established.',
    });
    await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });

    const fulfilment = await getUncertainty(orchestration.id, 'fulfilment');
    expect(fulfilment?.disposition).toBe('RETIRED');
    expect(fulfilment?.dispositionReason).toContain('only bears on the decision if it could');

    // Every change is on the record, with what was refused kept beside it.
    const revisions = await listPlanRevisions(orchestration.id);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions.map((one) => one.reason)).toContain('BRANCH_RETIRED');
  });

  it('defers opening work while a worker is still holding something', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await makeFragment(orchestration, { fragmentKey: 'one', fragmentIndex: 0 });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });
    await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'OPEN_UNCERTAINTY',
          why: 'A finding raised it.',
          uncertainty_key: 'follow-up',
          question: 'A new question.',
          why_it_matters: 'It decides the answer.',
          stopping_condition: 'Settled.',
        },
      ],
    });

    const held = await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: false,
    });
    expect(held.created).toBe(0);
    expect(held.refused.join(' ')).toContain('work is in flight');

    // And it is not lost: the next quiescent pass opens it.
    const quiet = await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    expect(quiet.created).toBe(1);
  });

  it('stops growing the plan rather than growing it forever', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await makeFragment(orchestration, { fragmentKey: 'seed', fragmentIndex: 0 });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    for (let index = 0; index < 14; index += 1) {
      await openUncertainty({
        orchestrationId: orchestration.id,
        projectId: project.id,
        uncertaintyKey: `follow-${index}`,
        question: `Follow-up ${index}`,
        whyItMatters: 'A finding raised it.',
        consumerKind: 'CONCLUSION',
        stoppingCondition: 'Settled.',
        origin: 'FINDING',
      });
    }

    let guard = 0;
    let created = 0;
    // Run to quiescence, exactly as the runner would.
    while (guard < 20) {
      const pass = await directResearch({
        orchestration,
        fragments: await listFragments(orchestration.id),
        mayCreateWork: true,
      });
      created += pass.created;
      if (pass.created === 0) break;
      guard += 1;
    }
    expect(created).toBeLessThanOrEqual(12);

    const last = await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    // And it says so out loud rather than silently doing nothing.
    expect(last.refused.join(' ')).toContain('needs a person');
  });
});

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

describe('what a worker may propose', () => {
  it('refuses the whole proposal for one field nobody defined', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const outcome = await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'REFRAME_OBJECTIVE',
          why: 'A better reading.',
          decision_supported: 'Whether to proceed',
        },
        {
          action: 'OPEN_UNCERTAINTY',
          why: 'A finding raised it.',
          uncertainty_key: 'new-one',
          question: 'A question.',
          why_it_matters: 'It matters.',
          stopping_condition: 'Settled.',
          min_independent_sources: 1,
        },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reasons: string[] }).reasons.join(' ')).toContain(
      'min_independent_sources',
    );
    // Nothing was written, including the action that was well formed. A
    // partially applied proposal is a plan with a hole in it.
    expect(await currentProblemModel(orchestration.id)).toBeNull();
    expect(await listUncertainties(orchestration.id)).toHaveLength(0);
  });

  it('matches the action exactly, with no closest match', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const outcome = await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [{ action: 'RETIRE', why: 'Close enough.' }],
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reasons: string[] }).reasons.join(' ')).toContain('RETIRE_UNCERTAINTY');
  });

  it('cannot name a question in another packet', async () => {
    const mine = await makeOrchestration('Mine', 'An assignment.');
    const theirs = await makeOrchestration('Theirs', 'A different assignment.');
    await openUncertainty({
      orchestrationId: theirs.id,
      projectId: project.id,
      uncertaintyKey: 'theirs-only',
      question: 'Their question.',
      whyItMatters: 'Theirs.',
      consumerKind: 'DECISION',
      stoppingCondition: 'Settled.',
    });

    const outcome = await applyProposal({
      orchestration: mine,
      actorRef: workerId,
      actions: [
        {
          action: 'OPEN_UNCERTAINTY',
          why: 'Following on from theirs.',
          uncertainty_key: 'mine-follow',
          question: 'A question.',
          why_it_matters: 'It matters.',
          stopping_condition: 'Settled.',
          because_of: 'theirs-only',
        },
      ],
    });
    expect(outcome.ok).toBe(true);
    expect((outcome as { refused: string[] }).refused.join(' ')).toContain(
      'not a question in this packet',
    );
    expect(await getUncertainty(mine.id, 'mine-follow')).toBeNull();
  });

  /**
   * Required scenario 10, and the correction §30 had to make once: a research
   * system must not ask a person to do its research.
   */
  it('refuses a person-only request over work Brain can do, and says which half is wrong', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await openUncertainty({
      orchestrationId: orchestration.id,
      projectId: project.id,
      uncertaintyKey: 'price',
      question: 'What does this cost?',
      whyItMatters: 'It decides the margin.',
      consumerKind: 'DECISION',
      stoppingCondition: 'A published price is found.',
    });

    for (const kind of ['MISSING_FACT', 'PRICE', 'CONTACT_CHANNEL', 'INTEGRATION_METHOD']) {
      const outcome = await applyProposal({
        orchestration,
        actorRef: workerId,
        actions: [
          {
            action: 'ESCALATE_PERSON_ONLY',
            why: 'We could not find it.',
            uncertainty_key: 'price',
            kind,
            question: 'What does this cost?',
            what_it_authorizes: 'Working out the margin.',
            exactly_what_is_needed: 'The price.',
          },
        ],
      });
      expect(outcome.ok).toBe(true);
      expect((outcome as { refused: string[] }).refused.join(' ')).toContain(
        'is research, and it is Brain',
      );
    }
    expect((await getUncertainty(orchestration.id, 'price'))?.disposition).toBe('OPEN');
  });

  it('accepts a genuine person-only request only when it is answerable', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await openUncertainty({
      orchestrationId: orchestration.id,
      projectId: project.id,
      uncertaintyKey: 'account-access',
      question: 'Which account should the connector authenticate as?',
      whyItMatters: 'Nothing can be read until it does.',
      consumerKind: 'DECISION',
      stoppingCondition: 'The connector authenticates.',
    });

    // A real kind, stated vaguely. Refused: "we need input" is not something a
    // person can act on.
    const vague = await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'ESCALATE_PERSON_ONLY',
          why: 'We are blocked.',
          uncertainty_key: 'account-access',
          kind: 'CREDENTIAL_OR_CONNECTION',
          question: 'What did you do?',
          what_it_authorizes: 'Progress.',
        },
      ],
    });
    expect((vague as { refused: string[] }).refused.join(' ')).toContain('one explicit question');
    expect((await getUncertainty(orchestration.id, 'account-access'))?.disposition).toBe('OPEN');

    const precise = await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'ESCALATE_PERSON_ONLY',
          why: 'The source is behind an account Brain has no credential for.',
          uncertainty_key: 'account-access',
          kind: 'CREDENTIAL_OR_CONNECTION',
          question: 'Which of your accounts should read the county register?',
          what_it_authorizes: 'Reading the register, which settles the decisive question.',
          exactly_what_is_needed: 'A connector for the county register portal.',
        },
      ],
    });
    expect((precise as { applied: string[] }).applied.join(' ')).toContain('account-access');
    const escalated = await getUncertainty(orchestration.id, 'account-access');
    expect(escalated?.disposition).toBe('PERSON_ONLY');
    // The stored sentence carries all four things a person needs to act.
    expect(escalated?.dispositionReason).toContain('Which of your accounts');
    expect(escalated?.dispositionReason).toContain('Answering it would allow');
    expect(escalated?.dispositionReason).toContain('What is needed: A connector');
  });

  it('records a worker proposal as a worker proposal, not as Brain\'s own reading', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'REFRAME_OBJECTIVE',
          why: 'The question is about the decision to sign, not the market.',
          decision_supported: 'Whether to sign',
        },
      ],
    });
    const model = await currentProblemModel(orchestration.id);
    expect(model?.derivedFrom).toBe('PROPOSAL');
    const revision = (await listPlanRevisions(orchestration.id)).at(-1);
    expect(revision?.actorKind).toBe('WORKER');
    expect(revision?.actorRef).toBe(workerId);
  });
});

// ---------------------------------------------------------------------------
// Sufficiency
// ---------------------------------------------------------------------------

describe('when research has done its job', () => {
  const base = {
    links: [],
    requirements: [],
    coverage: [],
    claims: [],
    fragments: [],
    mayRecordGaps: false,
  };

  async function questions(
    orchestration: ResearchOrchestration,
    spec: { key: string; consequence?: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW'; invalidating?: boolean }[],
  ): Promise<void> {
    for (const one of spec) {
      await openUncertainty({
        orchestrationId: orchestration.id,
        projectId: project.id,
        uncertaintyKey: one.key,
        question: `Question ${one.key}`,
        whyItMatters: 'Because.',
        consumerKind: 'DECISION',
        stoppingCondition: 'Answered.',
        consequence: one.consequence ?? 'MODERATE',
        invalidating: one.invalidating ?? false,
      });
    }
  }

  it('keeps going while a question that could change the outcome is open', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await questions(orchestration, [{ key: 'decisive', invalidating: true }]);
    const graph = await readGraph(orchestration.id);
    const reading = assessSufficiency({ ...base, uncertainties: graph.uncertainties });
    expect(reading.verdict).toBe('KEEP_RESEARCHING');
    expect(reading.decisive).toEqual({ settled: 0, total: 1 });
  });

  /** Required scenario 8: stop when the decisive question is settled. */
  it('stops when everything decisive is settled', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await questions(orchestration, [{ key: 'decisive', invalidating: true }]);
    await setUncertaintyDisposition({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'decisive',
      from: ['OPEN'],
      to: 'RESOLVED',
      reason: 'One primary source settles it.',
    });
    const graph = await readGraph(orchestration.id);
    const reading = assessSufficiency({ ...base, uncertainties: graph.uncertainties });
    expect(reading.verdict).toBe('ANSWERED');
    expect(reading.readiness).toBe(100);
  });

  /** Required scenario 9, in both directions. */
  it('is honest about a gap, and will not file short without authorization', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await questions(orchestration, [{ key: 'decisive', invalidating: true }]);
    await setUncertaintyDisposition({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'decisive',
      from: ['OPEN'],
      to: 'UNRESOLVABLE',
      reason: 'No source establishes it.',
    });
    const graph = await readGraph(orchestration.id);

    const unauthorized = assessSufficiency({ ...base, uncertainties: graph.uncertainties });
    expect(unauthorized.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(unauthorized.detail).toContain('nobody has authorized filing short');

    const authorized = assessSufficiency({
      ...base,
      uncertainties: graph.uncertainties,
      mayRecordGaps: true,
    });
    expect(authorized.verdict).toBe('USABLE_WITH_GAPS');
    expect(authorized.detail).toContain('usable only if the reader is told which');
  });

  it('stops when what is left cannot change the decision', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await questions(orchestration, [
      { key: 'decisive', invalidating: true },
      { key: 'trivia', consequence: 'LOW' },
    ]);
    await setUncertaintyDisposition({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'decisive',
      from: ['OPEN'],
      to: 'RESOLVED',
      reason: 'Settled.',
    });
    const graph = await readGraph(orchestration.id);
    const reading = assessSufficiency({ ...base, uncertainties: graph.uncertainties });
    expect(reading.verdict).toBe('NOT_WORTH_CONTINUING');
    expect(reading.detail).toContain('spend the allowance to learn something nobody would act on');
  });

  it('reports nothing to measure as nothing, never as zero or a hundred', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const reading = assessSufficiency({ ...base, uncertainties: [] });
    expect(reading.readiness).toBeNull();
    expect(orchestration.id).toBeTruthy();
  });

  it('only ever refuses a synthesis, never permits one', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await questions(orchestration, [{ key: 'decisive', invalidating: true }]);
    const graph = await readGraph(orchestration.id);
    // KEEP_RESEARCHING is not a refusal here: the mandatory-coverage check is
    // what decides readiness, and this must not be able to overrule it either way.
    const keep = assessSufficiency({ ...base, uncertainties: graph.uncertainties });
    expect(mayProceedToSynthesis(keep).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Evidence that outlives its fragment
// ---------------------------------------------------------------------------

describe('what survives an incomplete fragment', () => {
  /**
   * Required scenario 3. The claims cleared the gate; the fragment did not clear
   * its own bar. Both facts are true and the campaign metrics say so.
   */
  it('counts accepted claims from work that did not itself clear its bar', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const fragment = await makeFragment(orchestration, {
      fragmentKey: 'partly',
      fragmentIndex: 0,
      // Two lanes, and only one of them will be filled.
      requiredEvidence: [
        { id: 'primary', description: 'a primary source', necessity: 'REQUIRED' },
        { id: 'second', description: 'a second, independent kind', necessity: 'REQUIRED' },
      ],
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(claimed), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    await call('brain_complete_work', { ...proof(claimed), summary: 'claims in' });

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'INSUFFICIENT',
    });

    const after = await getFragment(fragment.id);
    // The fragment did not answer its question — one required lane is empty.
    expect(after?.status).not.toBe('ACCEPTED');
    // And the claim inside it is accepted evidence all the same.
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims.filter((claim) => claim.accepted)).toHaveLength(1);

    const metrics = await measureCampaign(orchestration);
    expect(metrics.claimsPreservedFromIncompleteWork).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

describe('what a finished campaign teaches', () => {
  async function finishedCampaign(): Promise<ResearchOrchestration> {
    const orchestration = await makeOrchestration(
      'Whether the branch is worth taking',
      'Establish whether there is a payer, and what it would cost to serve them.',
    );
    await makeFragment(orchestration, { fragmentKey: 'payer', fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: 'fulfilment',
      fragmentIndex: 1,
      dependsOn: [{ key: 'payer', kind: 'HARD' }],
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });
    const payer = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === 'payer',
    )!;
    await updateFragment(payer.id, {
      status: 'BLOCKED',
      maxRepairs: 0,
      blockedReason: 'No reachable payer.',
    });
    await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    await updateOrchestration(orchestration.id, {
      status: 'COMPLETE_WITH_GAPS',
      completedAt: new Date().toISOString(),
    });
    return orchestration;
  }

  it('writes a lesson at the level it is actually true at', async () => {
    const orchestration = await finishedCampaign();
    const lessons = await recordRetrospective(orchestration);
    const byKey = new Map(lessons.map((lesson) => [lesson.lessonKey, lesson]));

    // The outcome is about this packet and is marked as such.
    expect(byKey.get('outcome')?.abstraction).toBe('CAMPAIGN');
    // The ordering lesson is not, and says what it holds for.
    const ordering = byKey.get('retired-before-spending') ?? byKey.get('retired-after-spending');
    expect(ordering?.abstraction).toBe('GENERAL');
    expect(ordering?.lesson).toContain('prerequisite');
    // Every lesson carries the rows it was read off.
    for (const lesson of lessons) expect(lesson.metrics).toHaveProperty('fragmentsPlanned');
  });

  it('never offers a campaign lesson back as guidance', async () => {
    const orchestration = await finishedCampaign();
    await recordRetrospective(orchestration);
    const reusable = await reusableLessons(project.id);
    expect(reusable.length).toBeGreaterThan(0);
    // "Always do what happened last time" is exactly what this filter exists to
    // prevent.
    expect(reusable.every((lesson) => lesson.abstraction !== 'CAMPAIGN')).toBe(true);
  });

  it('is derived from rows on the tick, once, however often it runs', async () => {
    const orchestration = await finishedCampaign();
    const first = await reconcileRetrospectives(20);
    expect(first.find((entry) => entry.orchestrationId === orchestration.id)).toBeDefined();
    const second = await reconcileRetrospectives(20);
    expect(second.find((entry) => entry.orchestrationId === orchestration.id)).toBeUndefined();
  });

  it('writes nothing about a packet the faculty never saw', async () => {
    const orchestration = await makeOrchestration('Untouched', 'An assignment.');
    await updateOrchestration(orchestration.id, {
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
      cancelReason: 'The archive answers it.',
    });
    expect(await recordRetrospective(orchestration)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

describe('what a person is shown', () => {
  it('reads nothing into existence', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await makeFragment(orchestration, { fragmentKey: 'one', fragmentIndex: 0 });
    await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });

    const before = {
      items: (await listWorkItems(project.id, { limit: 100 })).length,
      fragments: (await listFragments(orchestration.id)).length,
      uncertainties: (await listUncertainties(orchestration.id)).length,
      revisions: (await listPlanRevisions(orchestration.id)).length,
      dispositions: (await listUncertainties(orchestration.id)).map((one) => one.disposition),
    };

    await researchIntelligenceView(orchestration);
    await researchIntelligenceView(orchestration);

    expect((await listWorkItems(project.id, { limit: 100 })).length).toBe(before.items);
    expect((await listFragments(orchestration.id)).length).toBe(before.fragments);
    expect((await listUncertainties(orchestration.id)).length).toBe(before.uncertainties);
    expect((await listPlanRevisions(orchestration.id)).length).toBe(before.revisions);
    expect((await listUncertainties(orchestration.id)).map((one) => one.disposition)).toEqual(
      before.dispositions,
    );
  });

  it('says what is next and why, and shows a belief\'s basis beside it', async () => {
    const orchestration = await makeOrchestration('Licensing', 'Whether a licence is needed.');
    await makeFragment(orchestration, { fragmentKey: 'trigger', fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      dependsOn: [{ key: 'trigger', kind: 'HARD' }],
    });
    await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });

    const view = await researchIntelligenceView(orchestration);
    expect(view.next[0]?.key).toBe('trigger');
    expect(view.next[0]?.why).toContain('pointless');
    expect(view.decisive.map((one) => one.key)).toContain('trigger');
    // Never a percentage over fragments, and the denominator is named.
    expect(view.sufficiency.decisive).toEqual({ settled: 0, total: 1 });
    for (const question of view.decisive) {
      expect(['UNKNOWN', 'ASSUMED', 'ARCHIVE', 'EVIDENCE', 'PERSON']).toContain(
        question.beliefBasis,
      );
    }
  });

  it('shows a retired branch as retired, with the reason, rather than hiding it', async () => {
    const orchestration = await makeOrchestration('Licensing', 'Whether a licence is needed.');
    await makeFragment(orchestration, { fragmentKey: 'trigger', fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      dependsOn: [{ key: 'trigger', kind: 'HARD' }],
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });
    const trigger = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === 'trigger',
    )!;
    await updateFragment(trigger.id, {
      status: 'BLOCKED',
      maxRepairs: 0,
      blockedReason: 'Nothing establishes it.',
    });
    await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });

    const view = await researchIntelligenceView(orchestration);
    expect(view.retired.map((one) => one.key)).toEqual(['penalty']);
    expect(view.retired[0]?.reason).toBeTruthy();
    expect(view.changes.some((change) => change.reason === 'BRANCH_RETIRED')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

describe('interrupting the campaign', () => {
  /**
   * Required scenario 13. The faculty holds nothing in memory, so resuming and
   * continuing are the same operation — the property the packet runner already
   * has, extended to the judgement above it.
   */
  it('re-derives the same state and duplicates nothing', async () => {
    const orchestration = await makeOrchestration('Licensing', 'Whether a licence is needed.');
    await makeFragment(orchestration, { fragmentKey: 'trigger', fragmentIndex: 0 });
    await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      dependsOn: [{ key: 'trigger', kind: 'HARD' }],
    });

    const fragments = await listFragments(orchestration.id);
    await directResearch({ orchestration, fragments, mayCreateWork: true });
    const after = {
      uncertainties: await listUncertainties(orchestration.id),
      links: await listUncertaintyLinks(orchestration.id),
      revisions: await listPlanRevisions(orchestration.id),
      models: await currentProblemModel(orchestration.id),
    };

    for (let index = 0; index < 3; index += 1) {
      await directResearch({
        orchestration,
        fragments: await listFragments(orchestration.id),
        mayCreateWork: true,
      });
    }

    expect((await listUncertainties(orchestration.id)).length).toBe(after.uncertainties.length);
    expect((await listUncertaintyLinks(orchestration.id)).length).toBe(after.links.length);
    expect((await listPlanRevisions(orchestration.id)).length).toBe(after.revisions.length);
    expect((await currentProblemModel(orchestration.id))?.version).toBe(after.models?.version);
  });

  it('cannot move a question twice from the same state', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await openUncertainty({
      orchestrationId: orchestration.id,
      projectId: project.id,
      uncertaintyKey: 'one',
      question: 'A question.',
      whyItMatters: 'Because.',
      consumerKind: 'DECISION',
      stoppingCondition: 'Answered.',
    });

    const first = await setUncertaintyDisposition({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'one',
      from: ['OPEN'],
      to: 'RESOLVED',
      reason: 'Settled.',
    });
    const second = await setUncertaintyDisposition({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'one',
      from: ['OPEN'],
      to: 'RETIRED',
      reason: 'A late tick.',
    });
    expect(first).toBe(true);
    // The loser loses. A late writer must never overwrite a decision.
    expect(second).toBe(false);
    expect((await getUncertainty(orchestration.id, 'one'))?.disposition).toBe('RESOLVED');
  });

  it('never re-ranks a question that has already closed', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await openUncertainty({
      orchestrationId: orchestration.id,
      projectId: project.id,
      uncertaintyKey: 'one',
      question: 'A question.',
      whyItMatters: 'Because.',
      consumerKind: 'DECISION',
      stoppingCondition: 'Answered.',
      consequence: 'LOW',
    });
    await setUncertaintyDisposition({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'one',
      from: ['OPEN'],
      to: 'RESOLVED',
      reason: 'Settled.',
    });
    const { reassessUncertainty } = await import('../server/repos/researchIntelligence.ts');
    const moved = await reassessUncertainty({
      orchestrationId: orchestration.id,
      uncertaintyKey: 'one',
      consequence: 'CRITICAL',
    });
    expect(moved).toBe(false);
    expect((await getUncertainty(orchestration.id, 'one'))?.consequence).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// The runner still owns approval
// ---------------------------------------------------------------------------

describe('what the faculty may not do', () => {
  it('creates a directed fragment PLANNED, so the packet\'s own approval decides', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    await makeFragment(orchestration, { fragmentKey: 'seed', fragmentIndex: 0, status: 'ACCEPTED' });
    await applyProposal({
      orchestration,
      actorRef: workerId,
      actions: [
        {
          action: 'OPEN_UNCERTAINTY',
          why: 'A finding raised it.',
          uncertainty_key: 'follow-up',
          question: 'A new question.',
          why_it_matters: 'It decides the answer.',
          stopping_condition: 'Settled.',
        },
      ],
    });

    const result = await advancePacket(orchestration.id);
    const created = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === 'follow-up',
    );
    expect(created?.status).toBe('PLANNED');
    // Nothing was queued: the packet is waiting for the same approval the
    // original plan needed.
    expect(result.waitingOn ?? '').toContain('approve');
    const items = await listWorkItems(project.id, { limit: 100 });
    expect(
      items.filter(
        (item) => item.fragmentId === created?.id && item.workType === 'RESEARCH_FRAGMENT',
      ),
    ).toHaveLength(0);

    // And once a person approves, it runs like anything else.
    await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: 'usr_person' });
    const after = await listWorkItems(project.id, { limit: 100 });
    expect(
      after.filter(
        (item) => item.fragmentId === created?.id && item.workType === 'RESEARCH_FRAGMENT',
      ).length,
    ).toBe(1);
  });

  it('refuses a plan-revision proposal from a caller without the scope', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const fragment = await makeFragment(orchestration, { fragmentKey: 'one', fragmentIndex: 0 });
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const tool = findTool('brain_propose_plan_revision');
    expect(tool).toBeDefined();
    const principal = await principalFor(
      FULL.filter((scope) => scope !== 'research:propose'),
    );
    await expect(
      tool!.run(
        { ...proof(claimed), actions: [{ action: 'RETIRE_UNCERTAINTY', why: 'x', uncertainty_key: 'one' }] },
        { principal, requestId: 'req_x' },
      ),
    ).rejects.toThrow();
  });

  it('refuses a proposal against an item this worker does not hold', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const fragment = await makeFragment(orchestration, { fragmentKey: 'one', fragmentIndex: 0 });
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    const message = await refusal('brain_propose_plan_revision', {
      ...proof(claimed),
      lease_generation: claimed.leaseGeneration + 5,
      actions: [{ action: 'RETIRE_UNCERTAINTY', why: 'x', uncertainty_key: 'one' }],
    });
    expect(message).toBeTruthy();
  });

  it('is a result rather than a transport failure when the proposal is malformed', async () => {
    const orchestration = await makeOrchestration('A question', 'An assignment.');
    const fragment = await makeFragment(orchestration, { fragmentKey: 'one', fragmentIndex: 0 });
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    const value = await call('brain_propose_plan_revision', {
      ...proof(claimed),
      actions: [{ action: 'NOT_A_REAL_ACTION', why: 'x' }],
    });
    // §21: a refusal delivered as a transport error is one the worker cannot
    // see or react to.
    expect(value['accepted']).toBe(false);
    expect(String((value['reasons'] as string[]).join(' '))).toContain('REFRAME_OBJECTIVE');
  });
});

// ---------------------------------------------------------------------------
// The two ways a refusal could have become a stall
// ---------------------------------------------------------------------------

describe('a refusal that nothing could answer', () => {
  /**
   * The livelock this closes, found by reading the diff rather than by a run.
   *
   * `assessSufficiency` refuses a synthesis while an accepted claim is contested
   * and nothing has challenged it. The director only looked at *live* questions,
   * so a contradiction arriving after the gate had already settled one would get
   * no challenge — and the refusal would then hold for ever over work nothing
   * was ever going to create. A loop that looks like progress is worse than a
   * stop; a refusal nobody can answer is worse than either.
   */
  it('challenges a disagreement found after the question was already settled', async () => {
    const orchestration = await makeOrchestration('Counting', 'How many are there?');
    const fragment = await makeFragment(orchestration, {
      fragmentKey: 'count',
      fragmentIndex: 0,
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', {
      ...proof(claimed),
      claims: [SOURCED, { ...SOURCED, claim: 'A second publisher says 260.', source_url: 'https://example.org/second' }],
    });
    const stored = await listClaimsForFragment(fragment.id);
    await call('brain_complete_work', { ...proof(claimed), summary: 'claims in' });
    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: stored.map((one) => ({
        claim_id: one.id,
        supports_claim: true,
        ...MATCHES,
        note: 'Reads directly.',
      })),
      sufficiency: 'SUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'verified' });

    // Settled first. Only then does the disagreement turn up.
    expect((await getUncertainty(orchestration.id, 'count'))?.disposition).toBe('RESOLVED');
    await getDb().run(
      `UPDATE research_claims SET contradiction_state = 'CONTESTED', contradiction_note = ?
        WHERE id = ?`,
      ['A second publisher gives a different total for the same month.', stored[0]!.id],
    );

    const applied = await directResearch({
      orchestration,
      fragments: await listFragments(orchestration.id),
      mayCreateWork: true,
    });
    expect(applied.created).toBe(1);
    expect(
      (await listFragments(orchestration.id)).some((one) => one.fragmentKey === 'count--challenge'),
    ).toBe(true);
  });

  /**
   * And when the challenge genuinely cannot be created, the packet stops for a
   * person rather than sitting in a state that says it is researching.
   *
   * §27's absorbing state: a status nothing picks up and nothing reports. The
   * synthesis branch is only reached when every fragment is terminal, so
   * reaching it with a refusal means nothing is going to create the work — and
   * `NEEDS_HUMAN` is the one status with an answering transition.
   */
  it('stops for a person rather than reporting an empty queue as research', async () => {
    const orchestration = await makeOrchestration('Counting', 'How many are there?');
    const fragment = await makeFragment(orchestration, {
      fragmentKey: 'count',
      fragmentIndex: 0,
    });
    const model = await ensureProblemModel(orchestration);
    await seedUncertainties({
      orchestration,
      fragments: await listFragments(orchestration.id),
      model,
      planVersion: 1,
    });

    /*
     * This question is itself a challenge — the shape a fragment opened by an
     * earlier disagreement has. Set before any work, because the refusal being
     * tested is the director declining to open a *second* automatic round: a
     * disagreement about a disagreement is a person's to settle.
     */
    await getDb().run(
      `UPDATE research_uncertainties SET origin = 'CONTRADICTION'
        WHERE orchestration_id = ? AND uncertainty_key = ?`,
      [orchestration.id, 'count'],
    );

    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', {
      ...proof(claimed),
      claims: [
        SOURCED,
        { ...SOURCED, claim: 'A second reading gives 260.', source_url: 'https://example.org/second' },
      ],
    });
    const stored = await listClaimsForFragment(fragment.id);
    await call('brain_report_contradiction', {
      ...proof(claimed),
      claim_id: stored[0]!.id,
      conflicting_claim_id: stored[1]!.id,
      state: 'CONTESTED',
      note: 'The two readings of the resolution disagree.',
    });
    await call('brain_complete_work', { ...proof(claimed), summary: 'claims in' });

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: stored.map((one) => ({
        claim_id: one.id,
        supports_claim: true,
        ...MATCHES,
        note: 'Reads directly.',
      })),
      sufficiency: 'SUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'verified' });

    // Nothing opened a second challenge, and the packet did not write itself up
    // over the disagreement either.
    expect(
      (await listFragments(orchestration.id)).some((one) => one.fragmentKey.endsWith('--challenge')),
    ).toBe(false);
    expect(
      (await listWorkItems(project.id, { limit: 100 })).filter(
        (item) => item.workType === 'RESEARCH_SYNTHESIZE',
      ),
    ).toHaveLength(0);

    const after = await getOrchestration(orchestration.id);
    expect(after?.status).toBe('NEEDS_HUMAN');
    expect(after?.failureReason ?? '').toContain('disagree');

    // And it stays a decision rather than becoming a loop: advancing again
    // changes nothing and queues nothing.
    const again = await advancePacket(orchestration.id);
    expect(again.status).toBe('NEEDS_HUMAN');
    expect(again.enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The boundary, read from the repository rather than promised
// ---------------------------------------------------------------------------

describe('what the faculty can reach at all', () => {
  /**
   * `docs/RESEARCH-INTELLIGENCE.md` and CLAUDE.md §35 both say the evidence
   * gate, the coverage decision, the audit verdict and the approval are
   * unreachable from here **by absence of an import, rather than by a check
   * somebody could forget**. That is a claim about the repository, so it is
   * checked against the repository — the same shape
   * `tests/operatorConsoleRemoved.test.ts` uses, and for the same reason: a
   * sentence in a comment is not a boundary.
   *
   * It names the functions rather than counting them. A count passes when one
   * is renamed, and renaming the thing that accepts a claim is exactly the
   * change that would quietly widen this.
   */
  const FORBIDDEN = [
    // Deciding evidence.
    'decideClaim',
    'applyGate',
    'gateFragment',
    'recordFragmentClaims',
    // Deciding what the archive covers.
    'upsertCoverage',
    'overrideCoverage',
    'reconcileAcceptedFragment',
    // Deciding a verdict.
    'recordAudit',
    'recordAuditPasses',
    // Deciding that research may start.
    'approvePlan',
    'planFitsEnvelope',
    'startPacket',
    // Spending, or reaching a person's authority.
    'checkAuthority',
    'checkCommercialAuthority',
    'reserve',
  ];

  it('imports nothing that could accept a claim, move coverage, or approve a plan', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'server', 'services', 'research', 'intelligence');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      // Import statements only. The names may appear in prose — this module set
      // is heavily commented and several of those functions are named in the
      // comments explaining why they are *not* called.
      const imports = source.match(/import[\s\S]*?from\s+'[^']+';/g) ?? [];
      for (const statement of imports) {
        for (const name of FORBIDDEN) {
          if (new RegExp(`\\b${name}\\b`).test(statement)) {
            offences.push(`${file} imports ${name}`);
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('creates a fragment only through the one call that lands it PLANNED', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.cwd(), 'server', 'services', 'research', 'intelligence');
    const apply = fs.readFileSync(path.join(dir, 'apply.ts'), 'utf8');

    // One helper, one status. If a second creation path appears it has to be
    // read, which is the point — a directed fragment that reached QUEUED would
    // be a second approval path (§16).
    const creations = apply.match(/createFragments\(/g) ?? [];
    expect(creations).toHaveLength(1);
    expect(apply).toContain("status: 'PLANNED'");
    expect(apply).not.toContain("status: 'QUEUED'");

    // And nowhere else in the faculty creates one at all.
    for (const file of fs.readdirSync(dir).filter((name) => name !== 'apply.ts')) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain('createFragments(');
    }
  });
});
