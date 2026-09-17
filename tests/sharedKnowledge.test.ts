/**
 * One shared Brain, four private operations.
 *
 * ---------------------------------------------------------------------------
 * What this suite is about
 * ---------------------------------------------------------------------------
 *
 * A validated research finding is a fact about the world. Four people running
 * four private operations in one Brain should not each pay to establish the
 * same one, and §13's rule — that the default is *not* to research — is exactly
 * as true one boundary out as it is inside a single project.
 *
 * What must not cross is everything that makes a project somebody's own work:
 * unfinished research, private threads, who owns which opportunity, what a
 * person decided, what a worker is currently assigned, and every claim the gate
 * rejected.
 *
 * ---------------------------------------------------------------------------
 * Why the finding here is produced rather than written
 * ---------------------------------------------------------------------------
 *
 * The promotion rule reads rows the gate writes, so a fixture that hand-wrote
 * those rows would be testing the fixture. Ana's finding goes through the real
 * path: a `WORKER` principal claims a `RESEARCH_FRAGMENT` off the durable
 * queue, submits through `brain_submit_claims`, and the gate decides acceptance
 * from `brain_submit_verification`. The pass lineage the provenance reports is
 * therefore Brain's own record of who executed it, not a value this file chose.
 *
 * **Two things this is not**, said rather than left to be assumed. It is not a
 * live Cowork session: no Routine is fired, no provider is called, no token is
 * minted and nothing external is read. And it is the tool *layer* rather than
 * the MCP *transport* — `tests/mcp.test.ts` and `tests/oauth.test.ts` cover the
 * wire. The external edge is the same declared fixture the rest of the suite
 * already declares: the sentences a worker found, and the two judgements only
 * somebody who read the source can make.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { russellRouter } from '../server/routes/russell.ts';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createLayer, listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  insertClaims,
  listClaims,
  markContradiction,
} from '../server/repos/research.ts';
import {
  createBoundaryContract,
  createRequirements,
} from '../server/repos/reconciliation.ts';
import { approvePlan, advancePacket } from '../server/services/research/packetRunner.ts';
import { reconcile } from '../server/services/reconcile/plan.ts';
import { coverBeforeWork } from '../server/services/russell/coverage.ts';
import {
  eligibleFindings,
  getFinding,
  listFindings,
  promoteEligibleClaims,
  revokeFinding,
  setFindingHorizon,
  SHARED_PROMOTION_RULE,
} from '../server/repos/sharedFindings.ts';
import {
  describeForReader,
  sharedClaimsForProject,
  sharedPoolForReader,
} from '../server/services/knowledge/shared.ts';
import { findTool } from '../server/mcp/tools.ts';
import { tick } from '../server/services/russell/loop.ts';
import { addMessage, createConversation } from '../server/repos/russellConversations.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  ProjectMembership,
  WorkerScope,
} from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = [
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

/**
 * The sentence every consumer is asked about.
 *
 * Deliberately one statement, so the relevance score against the requirement
 * below is 1.0 and the thing under test is the boundary rather than the
 * classifier's vocabulary matching — which `coverage.test.ts` already pins.
 */
const SUBJECT = 'Michigan counties require an electronic recording cover sheet';

interface Operation {
  who: string;
  userId: string;
  projectId: string;
  layer: Layer;
  workerId: string;
  credentialId: string;
}

let ana: Operation;
let ben: Operation;
let cara: Operation;

function principalFor(operation: Operation): Principal {
  return {
    type: 'WORKER',
    id: operation.workerId,
    handle: `worker-${operation.who}`,
    displayName: `Worker for ${operation.who}`,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: operation.credentialId,
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: `mem_${operation.who}`,
        projectId: operation.projectId,
        principalType: 'WORKER',
        principalId: operation.workerId,
        role: 'MEMBER',
        scopes: SCOPES,
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      } as ProjectMembership,
    ],
    requestId: `req_${operation.who}`,
  } as Principal;
}

/** A person, with exactly the memberships they were granted and no more. */
function personFor(
  operation: Operation,
  options: { role?: 'ADMIN' | 'MEMBER'; also?: Operation[] } = {},
): Principal {
  const on = [operation, ...(options.also ?? [])];
  return {
    type: 'HUMAN',
    id: operation.userId,
    handle: `${operation.who}@example.test`,
    displayName: operation.who,
    // Deliberately not a Brain administrator: §30's own deployment rule is that
    // the four daily accounts must not be, because a Brain administrator
    // reaches every project by design and would make this boundary untestable.
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `sess_${operation.who}`,
    authMethod: 'SESSION_COOKIE',
    memberships: on.map((target) => ({
      id: `mem_person_${target.who}`,
      projectId: target.projectId,
      principalType: 'HUMAN',
      principalId: operation.userId,
      role: options.role ?? 'ADMIN',
      scopes: ['project:read'],
      active: true,
      grantedByType: 'SYSTEM',
      grantedById: 'test',
      grantedAt: new Date().toISOString(),
      revokedAt: null,
    })) as ProjectMembership[],
    requestId: `req_person_${operation.who}`,
  } as Principal;
}

async function tool(
  name: string,
  args: Record<string, unknown>,
  operation: Operation,
): Promise<Record<string, any>> {
  const found = findTool(name);
  if (!found) throw new Error(`no such tool: ${name}`);
  const outcome = await found.run(args, {
    principal: principalFor(operation),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, any>;
}

async function makeOperation(
  who: string,
  seeded?: { projectId: string; layer: Layer },
): Promise<Operation> {
  const user = await createUser({
    email: `${who}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: who,
    password: 'correct horse battery staple',
  });
  const projectId =
    seeded?.projectId ??
    (
      await createProject({
        name: `${who}'s operation`,
        slug: `${who}-${Math.random().toString(36).slice(2, 8)}`,
      })
    ).id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: user.id,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const layer =
    seeded?.layer ??
    (await listLayers(projectId))[0] ??
    (await createLayer({ projectId, name: 'Opportunity Research', orderIndex: 0 }));

  const worker = await createWorker({
    name: `worker-${who}-${Math.random().toString(36).slice(2, 8)}`,
    displayName: `Worker for ${who}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  return {
    who,
    userId: user.id,
    projectId,
    layer,
    workerId: worker.id,
    credentialId: `cred_${who}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

async function claimQueued(operation: Operation, type: string): Promise<ClaimedWork> {
  const outcome = await tool(
    'brain_claim_work',
    { project_id: operation.projectId, work_types: [type], limit: 1 },
    operation,
  );
  const [claimed] = (outcome['claimed'] ?? []) as ClaimedWork[];
  if (!claimed) {
    throw new Error(
      `Brain queued nothing of type ${type} for ${operation.who}: ` +
        JSON.stringify(outcome).slice(0, 600),
    );
  }
  return claimed;
}

/**
 * One worker session's result for one fragment, through the real tools.
 *
 * The lanes, the claims and the two verification judgements are the declared
 * external edge. Everything they pass through — the scope check, the lease and
 * generation proof, the lane validation, the pass records and Brain's own
 * seven-condition gate — actually runs.
 */
async function workerResearches(input: {
  operation: Operation;
  question: string;
  claims: {
    claim: string;
    sourceUrl: string;
    sourceDate?: string;
    /** What a reader of the source said. False is how the gate rejects one. */
    supports?: boolean;
  }[];
  /** Left INSUFFICIENT to produce a fragment that is genuinely unfinished. */
  sufficiency?: 'SUFFICIENT' | 'INSUFFICIENT';
  fragmentKey?: string;
}): Promise<{ orchestrationId: string; claimIds: string[] }> {
  const { operation } = input;
  const run = await createRun({
    projectId: operation.projectId,
    layerId: operation.layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: input.question,
  });
  const orchestration = await createOrchestration({
    projectId: operation.projectId,
    layerId: operation.layer.id,
    runId: run.id,
    title: input.question,
    assignment: input.question,
    provider: 'WORKER',
    autoApprove: false,
  });
  const lanes = [
    {
      id: 'official_source',
      description: 'the recording requirement as an official body states it',
      necessity: 'REQUIRED' as const,
    },
  ];
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: operation.projectId,
      layerId: operation.layer.id,
      requiredEvidence: lanes,
      acceptableSourceTypes: ['an official page or a county register of deeds'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published source'],
      minIndependentSources: input.claims.length > 1 ? 2 : 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: input.fragmentKey ?? `fragment-${operation.who}`,
      question: input.question,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const approved = await approvePlan({
    orchestrationId: orchestration.id,
    approvedByUserId: operation.userId,
  });
  expect(approved.enqueued.length).toBeGreaterThan(0);

  const researching = await claimQueued(operation, 'RESEARCH_FRAGMENT');
  const submitted = await tool(
    'brain_submit_claims',
    {
      ...proof(researching),
      claims: input.claims.map((one) => ({
        claim: one.claim,
        claim_type: 'SOURCED_FACT',
        source_url: one.sourceUrl,
        source_title: 'A published page',
        source_publisher: new URL(one.sourceUrl).hostname,
        source_date: one.sourceDate ?? '2026-09-10',
        evidence_excerpt: one.claim,
        evidence_locator: 'the page body',
        evidence_lane: 'official_source',
        retrieved_at: '2026-09-12',
        confidence: 0.9,
        primary_source: true,
      })),
      search_queries: [input.question],
    },
    operation,
  );
  // The worker never decides acceptance, and nothing here pretends otherwise.
  expect(submitted['accepted']).toBe(0);
  const stored = submitted['claims'] as { claimId: string }[];
  await tool(
    'brain_complete_work',
    { ...proof(researching), result_ref: String(submitted['recorded']), summary: 'claims submitted' },
    operation,
  );

  await advancePacket(orchestration.id);
  const verifying = await claimQueued(operation, 'RESEARCH_VERIFY');
  await tool(
    'brain_submit_verification',
    {
      ...proof(verifying),
      verdicts: stored.map((row, index) => ({
        claim_id: row.claimId,
        supports_claim: input.claims[index]!.supports ?? true,
        geography: 'MATCH',
        timeframe: 'MATCH',
        population: 'MATCH',
        definitions: 'MATCH',
        geography_basis: 'Judged against the geography the fragment declares.',
        timeframe_basis: 'Judged against the timeframe the fragment declares.',
        population_basis: 'Judged against the population the fragment declares.',
        definitions_basis: 'Judged against the definitions the fragment declares.',
        note: 'Read the page.',
      })),
      sufficiency: input.sufficiency ?? 'SUFFICIENT',
      missing_lanes: input.sufficiency === 'INSUFFICIENT' ? ['official_source'] : [],
      unresolved_gaps: [],
    },
    operation,
  );
  await tool(
    'brain_complete_work',
    { ...proof(verifying), result_ref: 'gated', summary: 'verified and gated' },
    operation,
  );

  return { orchestrationId: orchestration.id, claimIds: stored.map((row) => row.claimId) };
}

/** Ana establishes the shared fact, from two independent publishers. */
async function anaEstablishesTheFact(): Promise<{ orchestrationId: string; claimIds: string[] }> {
  return workerResearches({
    operation: ana,
    question: `Do ${SUBJECT.toLowerCase()}?`,
    claims: [
      {
        claim: `${SUBJECT} on every submitted deed.`,
        sourceUrl: 'https://legislature.example.gov/mcl/565-201',
      },
      {
        claim: `${SUBJECT}, according to the county register of deeds.`,
        sourceUrl: 'https://records.example.org/oakland/e-recording',
      },
      /*
       * A third claim the source turns out not to support.
       *
       * The fragment still clears its bar on the two above, so this is the case
       * that separates "the fragment was accepted" from "this claim was": a
       * rejected claim keeps its rejection reason for ever and may never
       * re-enter, and crossing into another project would be exactly that.
       */
      {
        claim: `${SUBJECT} and the state waives the fee for every filer.`,
        sourceUrl: 'https://records.example.org/oakland/fees',
        supports: false,
      },
    ],
  });
}

/** What a consuming project asks. One requirement, the subject stated plainly. */
const ASK = [{ key: 'erecording', statement: SUBJECT }];

async function coverageFor(operation: Operation) {
  return coverBeforeWork({
    projectId: operation.projectId,
    layerId: operation.layer.id,
    requirements: ASK,
  });
}

beforeEach(async () => {
  const fixture = await freshProject();
  const seededLayer = await fixture.layerByName('Discovery Logic');
  ana = await makeOperation('ana', { projectId: fixture.project.id, layer: seededLayer });
  ben = await makeOperation('ben');
  cara = await makeOperation('cara');
});

describe('a validated finding becomes the whole Brain’s', () => {
  it('is promoted by the durable tick, which is the caller production has', async () => {
    /*
     * The one thing a suite calling `promoteEligibleClaims` directly cannot
     * see. Every other test here would pass against a promotion pass nothing
     * ever ran — which is the defect this repository has recorded five times,
     * and the reason the step is asserted through the loop rather than beside
     * it.
     */
    await anaEstablishesTheFact();
    const first = await tick('shared-knowledge');
    expect(first.ran).toBe(true);
    expect(first.sharedPromoted.length).toBe(2);
    expect((await listFindings()).length).toBe(2);

    // And the next pass promotes nothing, because it is idempotent by the
    // claim rather than by a flag some tick could set and then die.
    const second = await tick('shared-knowledge');
    expect(second.sharedPromoted).toEqual([]);
    expect((await listFindings()).length).toBe(2);
  });

  it('promotes a gated claim, and records the rule that admitted it', async () => {
    const produced = await anaEstablishesTheFact();
    const claims = await listClaims(produced.orchestrationId);
    expect(claims.filter((claim) => claim.accepted).length).toBe(2);

    const promoted = await promoteEligibleClaims();
    expect(promoted.length).toBe(2);

    const pool = await listFindings();
    expect(pool.length).toBe(2);
    for (const finding of pool) {
      expect(finding.state).toBe('ACTIVE');
      expect(finding.ruleVersion).toBe(SHARED_PROMOTION_RULE);
      expect(finding.originProjectId).toBe(ana.projectId);
      expect(finding.claim).toContain('electronic recording cover sheet');
    }

    // Idempotent by the claim, not by a flag: running it again promotes nothing
    // new and leaves the pool exactly as it was.
    expect(await promoteEligibleClaims()).toEqual([]);
    expect((await listFindings()).length).toBe(2);
  });

  it('lets another person’s project retrieve and reuse it', async () => {
    await anaEstablishesTheFact();
    await promoteEligibleClaims();

    const reusable = await sharedClaimsForProject(ben.projectId);
    expect(reusable.length).toBe(2);
    for (const claim of reusable) {
      // The asking project, because that is what the field means to every
      // consumer of an ExistingClaim. The origin lives on the finding row.
      expect(claim.projectId).toBe(ben.projectId);
      expect(claim.sourceUrl).not.toBeNull();
      expect(claim.claimType).toBe('SOURCED_FACT');
      expect(claim.verificationState).toBe('VERIFIED');
      expect(claim.superseded).toBe(false);
    }

    // Ana's own project does not get its own findings back through this path:
    // they already reach it through its archive, and counting a claim twice
    // would make one publisher look like two.
    expect(await sharedClaimsForProject(ana.projectId)).toEqual([]);
  });

  it('suppresses the duplicate packet at both entrances to the classifier', async () => {
    // Before anything is shared, Ben's question is a real gap.
    const before = await coverageFor(ben);
    expect(before.fullyAnswered).toBe(false);
    expect(before.gaps.map((gap) => gap.status)).toEqual(['MISSING']);

    await anaEstablishesTheFact();
    await promoteEligibleClaims();

    // Entrance one: Russell's pre-mission archive check.
    const after = await coverageFor(ben);
    expect(after.fullyAnswered).toBe(true);
    expect(after.gaps).toEqual([]);
    expect(after.answered[0]!.status).toBe('SATISFIED');
    expect(after.claimsConsidered).toBe(2);

    // Entrance two: the packet reconciliation a worker's proposed fragments go
    // through. A guard on one entrance is not a guard.
    const run = await createRun({
      projectId: ben.projectId,
      layerId: ben.layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: SUBJECT,
    });
    const orchestration = await createOrchestration({
      projectId: ben.projectId,
      layerId: ben.layer.id,
      runId: run.id,
      title: SUBJECT,
      assignment: SUBJECT,
      provider: 'WORKER',
      autoApprove: false,
    });
    const contract = await createBoundaryContract({
      orchestrationId: orchestration.id,
      projectId: ben.projectId,
      layerId: ben.layer.id,
      primaryQuestion: SUBJECT,
    } as never);
    const requirements = await createRequirements([
      {
        orchestrationId: orchestration.id,
        projectId: ben.projectId,
        layerId: ben.layer.id,
        requirementKey: 'erecording',
        ordinal: 0,
        statement: SUBJECT,
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
    ] as never);
    const result = await reconcile({
      orchestrationId: orchestration.id,
      projectId: ben.projectId,
      requirements,
      contract,
    });
    expect(result.sharedClaims.length).toBe(2);
    // Ben's own archive holds nothing about this; the answer came from the pool.
    expect(result.claims.length).toBe(0);
    expect(result.researchable).toEqual([]);
    expect(result.satisfied.map((entry) => entry.requirement.requirementKey)).toEqual([
      'erecording',
    ]);
  });
});

describe('what never crosses', () => {
  it('leaves unfinished research, rejected claims and private working state behind', async () => {
    const produced = await anaEstablishesTheFact();

    // Unfinished research: a second fragment whose evidence did not satisfy it.
    const unfinished = await workerResearches({
      operation: ana,
      question: 'What does the state charge to record a deed electronically?',
      fragmentKey: 'fragment-ana-unfinished',
      sufficiency: 'INSUFFICIENT',
      claims: [
        {
          claim: 'One county publishes a fee schedule for electronic recording.',
          sourceUrl: 'https://records.example.org/oakland/fees',
        },
      ],
    });
    const stillOpen = (await currentFragments(unfinished.orchestrationId))[0]!;
    expect(stillOpen.status).not.toBe('ACCEPTED');

    // Private working state, in the three tables that hold it.
    const conversation = await createConversation({
      ownerUserId: ana.userId,
      projectId: ana.projectId,
      title: 'Ana’s private thread',
    });
    await addMessage({
      conversationId: conversation.id,
      role: 'USER',
      content: 'PRIVATE-NOTE-ANA: do not undercut the Rochester quote.',
      authorUserId: ana.userId,
    });
    const idea = await createCandidate({
      projectId: ana.projectId,
      conversationId: conversation.id,
      title: 'PRIVATE-IDEA-ANA',
      statement: 'PRIVATE-IDEA-ANA: the Rochester lead is worth chasing first.',
      visibility: 'PRIVATE',
    });

    // Only the finished, gated, sourced claims were promoted. Ana's fragment
    // carried three: two the gate accepted and one the source did not support.
    const anaClaims = await listClaims(produced.orchestrationId);
    expect(anaClaims.length).toBe(3);
    const rejected = anaClaims.find((claim) => !claim.accepted)!;
    expect(rejected.rejectionReason).not.toBeNull();
    // Rejected and *still sourced*: this is the case that separates "the
    // fragment was accepted" from "this claim was".
    expect(rejected.sourced).toBe(true);
    expect(rejected.validationState).toBe('SOURCED');

    /*
     * And a calculation, which the gate may well accept inside its own
     * fragment: it rests on inputs that are themselves accepted claims *there*,
     * and those inputs do not travel with it. Written the way
     * `recordFragmentClaims` writes one, which is the only thing that sets this
     * column in production.
     */
    const accepted = anaClaims.filter((claim) => claim.accepted);
    const [calculation] = await insertClaims([
      {
        orchestrationId: produced.orchestrationId,
        fragmentId: accepted[0]!.fragmentId,
        passId: null,
        passKey: 'TARGETED',
        claim: 'Two of the three counties examined require the cover sheet.',
        sourceUrl: 'https://records.example.org/oakland/e-recording',
        sourceTitle: 'A published page',
        sourcePublisher: 'records.example.org',
        sourceDate: '2026-09-10',
        evidenceExcerpt: 'derived from the two claims above',
        evidenceLocator: 'the page body',
        evidenceLane: 'official_source',
        retrievedAt: '2026-09-12',
        confidence: 0.9,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        derived: true,
        derivedFrom: accepted.map((claim) => claim.id),
        accepted: true,
        contentHash: 'derived-fixture',
      },
    ]);

    await promoteEligibleClaims();

    const pool = await listFindings();
    expect(pool.length).toBe(2);
    expect(pool.map((finding) => finding.claimId)).not.toContain(rejected.id);
    expect(pool.map((finding) => finding.claimId)).not.toContain(calculation!.id);
    for (const finding of pool) {
      expect(finding.claim).toContain('electronic recording cover sheet');
    }

    // And nothing private is reachable through what Ben can see.
    const benSees = JSON.stringify([
      await sharedClaimsForProject(ben.projectId),
      await sharedPoolForReader(personFor(ben)),
    ]);
    expect(benSees).not.toContain('PRIVATE-NOTE-ANA');
    expect(benSees).not.toContain('PRIVATE-IDEA-ANA');
    expect(benSees).not.toContain(conversation.id);
    expect(benSees).not.toContain(idea.id);
    expect(benSees).not.toContain(unfinished.orchestrationId);
    expect(benSees).not.toContain(ana.projectId);
    expect(benSees).not.toContain(ana.workerId);
    // The fee claim belonged to a fragment that never cleared its bar.
    expect(benSees).not.toContain('fee schedule');
  });

  it('names the origin to a reader who may see it, and withholds it from one who may not', async () => {
    await anaEstablishesTheFact();
    await promoteEligibleClaims();
    const [finding] = await eligibleFindings({ excludeProjectId: ben.projectId });
    expect(finding).toBeTruthy();
    const now = new Date().toISOString();

    const toAna = describeForReader(finding!, personFor(ana), now);
    expect(toAna.provenance.originVisible).toBe(true);
    expect(toAna.provenance.originProjectId).toBe(ana.projectId);
    // Brain's own record of who executed the pass, never anything the worker
    // said about itself.
    expect(toAna.provenance.originWorkerId).toBe(ana.workerId);
    expect(toAna.provenance.originOrchestrationId).not.toBeNull();
    expect(toAna.provenance.claimId).toBe(finding!.claimId);

    const toBen = describeForReader(finding!, personFor(ben), now);
    expect(toBen.provenance.originVisible).toBe(false);
    expect(toBen.provenance.originProjectId).toBeNull();
    expect(toBen.provenance.originWorkerId).toBeNull();
    expect(toBen.provenance.originOrchestrationId).toBeNull();
    // Everything that makes it checkable still crosses, which is the point: a
    // finding is not a project-scoped resource and is not hidden as one.
    expect(toBen.statement).toBe(toAna.statement);
    expect(toBen.source.url).toBe(toAna.source.url);
    expect(toBen.source.publisher).toBe(toAna.source.publisher);
    expect(toBen.source.excerpt).toBe(toAna.source.excerpt);
    expect(toBen.provenance.claimId).toBe(finding!.claimId);
  });
});

describe('a finding that should no longer be reused', () => {
  it('is excluded once revoked, and once its declared horizon has passed', async () => {
    await anaEstablishesTheFact();
    await promoteEligibleClaims();
    const findings = await listFindings();
    expect(findings.length).toBe(2);
    expect(await coverageFor(ben)).toMatchObject({ fullyAnswered: true });

    const revoked = await revokeFinding({
      id: findings[0]!.findingId,
      userId: ana.userId,
      reason: 'The statute was amended and this no longer describes it.',
    });
    expect(revoked?.state).toBe('REVOKED');
    expect(revoked?.revokedReason).toContain('amended');

    const expired = await setFindingHorizon({
      id: findings[1]!.findingId,
      validUntil: '2020-01-01T00:00:00.000Z',
    });
    expect(expired?.validUntil).toBe('2020-01-01T00:00:00.000Z');

    // Neither reaches a consumer any more.
    expect(await sharedClaimsForProject(ben.projectId)).toEqual([]);
    const after = await coverageFor(ben);
    expect(after.fullyAnswered).toBe(false);
    expect(after.gaps.map((gap) => gap.status)).toEqual(['MISSING']);

    // And nothing was destroyed: both rows keep their id, their origin and the
    // reason they stopped being used, which is what a person asking "why is
    // this not being reused" needs.
    const pool = await sharedPoolForReader(personFor(ana));
    expect(pool.length).toBe(2);
    expect(pool.every((entry) => entry.withheldReason !== null)).toBe(true);
    expect(pool.some((entry) => entry.withheldReason!.includes('amended'))).toBe(true);
    expect(pool.some((entry) => entry.withheldReason!.includes('2020-01-01'))).toBe(true);
    expect((await getFinding(findings[0]!.findingId))!.originProjectId).toBe(ana.projectId);

    // The claims underneath are untouched. A finding being unsuitable for reuse
    // is not the same fact as the evidence being wrong.
    const claims = await listClaims((await listFindings())[0]!.originOrchestrationId);
    expect(claims.filter((claim) => claim.accepted).length).toBe(2);
  });

  it('excludes a claim a later contradiction contested, with nothing written here', async () => {
    const produced = await anaEstablishesTheFact();
    await promoteEligibleClaims();
    expect((await eligibleFindings({ excludeProjectId: ben.projectId })).length).toBe(2);

    /*
     * The column the gate's fifth condition is about, written by the function
     * that writes it in production — `gateFragment` calls this for every
     * verification carrying a contradiction, and so does the contradiction
     * tool. Going through the tool would need a second held lease, which is
     * the queue's business rather than this boundary's.
     */
    await markContradiction(
      produced.claimIds[0]!,
      'CONTESTED',
      'A 2026 amendment does not mention a cover sheet.',
    );

    // The promotion rows are exactly as they were; eligibility is derived.
    expect((await listFindings()).length).toBe(2);
    expect((await listFindings()).every((row) => row.state === 'ACTIVE')).toBe(true);
    const eligible = await eligibleFindings({ excludeProjectId: ben.projectId });
    expect(eligible.length).toBe(1);
    expect(eligible[0]!.claimId).not.toBe(produced.claimIds[0]);
  });
});

describe('two operations over one pool', () => {
  it('lets both reuse the same finding without touching each other’s work', async () => {
    await anaEstablishesTheFact();
    await promoteEligibleClaims();

    const benBefore = await listClaims('none');
    expect(benBefore).toEqual([]);

    const forBen = await sharedClaimsForProject(ben.projectId);
    const forCara = await sharedClaimsForProject(cara.projectId);
    expect(forBen.length).toBe(2);
    expect(forCara.length).toBe(2);
    // The same finding, addressed the same way, projected into two scopes.
    expect(forBen.map((claim) => claim.id).sort()).toEqual(
      forCara.map((claim) => claim.id).sort(),
    );
    expect(forBen.every((claim) => claim.projectId === ben.projectId)).toBe(true);
    expect(forCara.every((claim) => claim.projectId === cara.projectId)).toBe(true);

    expect((await coverageFor(ben)).fullyAnswered).toBe(true);
    expect((await coverageFor(cara)).fullyAnswered).toBe(true);

    // Nothing was claimed, leased, copied or mutated: the pool is still two
    // rows, Ana's claims are still Ana's, and neither consumer wrote anything.
    expect((await listFindings()).length).toBe(2);
    const pool = await listFindings();
    expect(new Set(pool.map((row) => row.originProjectId))).toEqual(new Set([ana.projectId]));
  });

  it('is safe when two workers research separately and promotion runs twice at once', async () => {
    // Two workers, two projects, two questions, executed one after the other
    // through the real queue — each takes only its own project's item, which
    // `cashMultiWorker` pins as a race and is not re-proved here.
    const [first, second] = [
      await anaEstablishesTheFact(),
      await workerResearches({
        operation: cara,
        question: `Do ${SUBJECT.toLowerCase()} in the neighbouring county?`,
        claims: [
          {
            claim: `${SUBJECT} in the neighbouring county as well.`,
            sourceUrl: 'https://legislature.example.gov/mcl/565-202',
          },
          {
            claim: `${SUBJECT}, the neighbouring register of deeds confirms.`,
            sourceUrl: 'https://records.example.org/macomb/e-recording',
          },
        ],
      }),
    ];

    // Two promotion passes overlapping. The unique index on `claim_id` is the
    // arbiter; a loser is an ordinary outcome, not an error.
    const [a, b] = await Promise.all([promoteEligibleClaims(), promoteEligibleClaims()]);
    const promoted = [...a, ...b];
    const pool = await listFindings();

    expect(pool.length).toBe(4);
    expect(promoted.length).toBe(4);
    expect(new Set(pool.map((row) => row.claimId)).size).toBe(4);
    expect(new Set(pool.map((row) => row.findingId)).size).toBe(4);
    expect(new Set(pool.map((row) => row.originProjectId))).toEqual(
      new Set([ana.projectId, cara.projectId]),
    );
    // Every promoted claim came from one of the two submissions, and the two
    // claims their gates rejected did not come with them.
    const submitted = new Set([...first.claimIds, ...second.claimIds]);
    expect(submitted.size).toBe(5);
    expect(pool.every((row) => submitted.has(row.claimId))).toBe(true);
    expect(pool.some((row) => row.claim.includes('waives the fee'))).toBe(false);

    // Ben, who researched nothing, gets everything either of them established.
    expect((await sharedClaimsForProject(ben.projectId)).length).toBe(4);
    // Each researcher sees the other's work and not its own restated.
    const forAna = await sharedClaimsForProject(ana.projectId);
    expect(forAna.length).toBe(2);
    expect(forAna.every((claim) => claim.claim.includes('neighbouring'))).toBe(true);
  });
});

/* --------------------------------------------------------------------------
 * The routes, mounted in process behind a real request context.
 *
 * The guards on these are the whole of what stops the pool becoming a way into
 * somebody else's project, and they are the kind that a unit test of the policy
 * cannot see: the level comes from `requirementFor(method, path)`, so a route
 * whose path does not match its own override silently downgrades to the method
 * default. That is a real failure mode and it is invisible from the handler.
 * ------------------------------------------------------------------------ */

async function withRussellRoutes<T>(
  principal: Principal | null,
  fn: (
    call: (method: string, route: string, body?: unknown) => Promise<{ status: number; body: any }>,
  ) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      // The path the policy matches on is the one the request actually has.
      principal,
      requestId: newRequestId(),
      method: req.method,
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    } as never);
    next();
  });
  app.use('/api/russell', russellRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({
      error: String(error?.message ?? error),
    });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(async (method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/russell${route}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* left as text */
      }
      return { status: response.status, body: parsed as any };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('the pool over HTTP', () => {
  it('refuses a machine by type, at every one of its doors', async () => {
    await anaEstablishesTheFact();
    await promoteEligibleClaims();
    const [finding] = await listFindings();

    await withRussellRoutes(principalFor(ana), async (call) => {
      for (const [method, route] of [
        ['GET', '/shared-findings'],
        ['POST', `/shared-findings/${finding!.findingId}/revoke`],
        ['POST', `/shared-findings/${finding!.findingId}/horizon`],
      ] as const) {
        const result = await call(method, route, method === 'POST' ? { reason: 'no' } : undefined);
        expect(result.status, `${method} ${route}`).toBe(404);
        // Invariant 23 at the door a machine is most likely to knock on.
        expect(result.body.error).toBe('No such route.');
      }
    });

    // And nothing it was refused actually happened.
    expect((await getFinding(finding!.findingId))!.state).toBe('ACTIVE');
  });

  it('withdraws a finding for the project that produced it, and for nobody else', async () => {
    await anaEstablishesTheFact();
    await promoteEligibleClaims();
    const [finding] = await listFindings();
    const invented = 'shf_0123456789abcdef0123';

    // Ben administers his own project and nothing of Ana's. A real finding id
    // and an invented one must be byte-identical to him, body included.
    await withRussellRoutes(personFor(ben), async (call) => {
      const real = await call('POST', `/shared-findings/${finding!.findingId}/revoke`, {
        reason: 'I would rather this were not used.',
      });
      const missing = await call('POST', `/shared-findings/${invented}/revoke`, {
        reason: 'I would rather this were not used.',
      });
      expect(real.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(JSON.stringify(real.body)).toBe(JSON.stringify(missing.body));

      // He can still read the pool, and still cannot see whose it is.
      const pool = await call('GET', '/shared-findings');
      expect(pool.status).toBe(200);
      expect(pool.body.findings.length).toBe(2);
      expect(pool.body.reusable).toBe(2);
      expect(pool.body.findings[0].provenance.originVisible).toBe(false);
      expect(JSON.stringify(pool.body)).not.toContain(ana.projectId);
    });
    expect((await getFinding(finding!.findingId))!.state).toBe('ACTIVE');

    /*
     * And somebody who *is* on Ana's project but is not an administrator of it
     * is refused in the same words. Withdrawing a finding is a change to what a
     * project owns, so it carries the level every other one does — and the
     * level comes from `requirementFor(method, path)`, which is exactly the
     * thing a handler cannot see it has lost.
     */
    await withRussellRoutes(personFor(ana, { role: 'MEMBER' }), async (call) => {
      const refused = await call('POST', `/shared-findings/${finding!.findingId}/revoke`, {
        reason: 'I am on this project but do not run it.',
      });
      const missing = await call('POST', `/shared-findings/${invented}/revoke`, {
        reason: 'I am on this project but do not run it.',
      });
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).toBe(JSON.stringify(missing.body));
    });
    expect((await getFinding(finding!.findingId))!.state).toBe('ACTIVE');

    // Ana administers the project that produced it.
    await withRussellRoutes(personFor(ana), async (call) => {
      const revoked = await call('POST', `/shared-findings/${finding!.findingId}/revoke`, {
        reason: 'The statute was amended.',
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.finding.state).toBe('REVOKED');

      // Guarded on the state it is leaving, so the second press is refused
      // rather than writing a second revocation saying the same thing.
      const again = await call('POST', `/shared-findings/${finding!.findingId}/revoke`, {
        reason: 'The statute was amended.',
      });
      expect(again.status).toBe(409);
    });

    expect(await sharedClaimsForProject(ben.projectId)).toHaveLength(1);
  });
});
