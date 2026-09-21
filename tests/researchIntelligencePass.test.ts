/**
 * One campaign, walked the whole way, through the entrances a person and a
 * worker actually use.
 *
 * §24 records why this file has to exist rather than being covered by the suite
 * beside it: walking the journey once found five transitions that existed, were
 * tested, and could be reached by nothing — because a test that arranges its own
 * starting state cannot tell a mechanism from a function nobody calls. The same
 * is true here and more so, because the whole faculty is *reactions to things
 * that happen*, and a reaction nothing triggers is not a reaction.
 *
 * So the only thing simulated is the outside world. The packet is started
 * through `startPacket`, exactly as Russell's launch does. Every submission goes
 * through the MCP tools under a lease, so the scope check, the ownership proof,
 * Step 6's idempotency and the seven-condition gate all run. The runner is the
 * real runner and is never called by hand to make a step happen — where the text
 * below says Brain did something, the assertion is that it had already done it.
 *
 * **Two things this is not**, said rather than assumed. It is not a live Cowork
 * session: no Routine is fired, no provider is called, no token is minted and
 * nothing external is read. And it is the tool *layer* rather than the MCP
 * *transport* — `tests/mcp.test.ts` and `tests/oauth.test.ts` cover the bearer,
 * the origin rule and the eras. What stays fixture is the sentences a worker
 * found and the two judgements only a reader of a source can make.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase } from './helpers.ts';
import { findTool } from '../server/mcp/tools.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine } from '../server/repos/fleet.ts';
import { auditAdmission, lineageForWorker } from '../server/services/research/auditAdmission.ts';
import { claimWork, getWorkItem, listWorkItems } from '../server/repos/workQueue.ts';
import {
  getFragment,
  getOrchestration,
  listClaims,
  listClaimsForFragment,
  listFragments,
  updateFragment,
} from '../server/repos/research.ts';
import { listRequirements } from '../server/repos/reconciliation.ts';
import { advancePacket, approvePlan } from '../server/services/research/packetRunner.ts';
import { startPacket } from '../server/services/research/startPacket.ts';
import { authorizeUnresolvedGaps } from '../server/services/research/gapPolicy.ts';
import { createUser } from '../server/repos/identity.ts';
import { listAuditsByProject } from '../server/repos/audits.ts';
import { researchIntelligenceView } from '../server/services/research/intelligence/view.ts';
import { reconcileRetrospectives } from '../server/services/research/intelligence/retrospective.ts';
import {
  currentProblemModel,
  getUncertainty,
  listPlanRevisions,
  listUncertainties,
  listUncertaintyLinks,
} from '../server/repos/researchIntelligence.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  Project,
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
let adminId = '';
let asIdentity: { workerId: string; credentialId: string } | null = null;

async function principalFor(): Promise<Principal> {
  const identity = asIdentity ?? { workerId, credentialId: 'cred_test' };
  return {
    type: 'WORKER',
    id: identity.workerId,
    handle: 'test-worker',
    displayName: 'Test Worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: identity.credentialId,
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_test',
        projectId: project.id,
        principalType: 'WORKER',
        principalId: identity.workerId,
        role: 'MEMBER',
        scopes: FULL,
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

/** Claim whatever the runner queued, under the production admission rule. */
async function claimNext(type: string): Promise<ClaimedWork> {
  const identity = asIdentity ?? { workerId, credentialId: 'cred_test' };
  const [claimed] = await claimWork({
    admit: auditAdmission(
      await lineageForWorker({
        workerId: identity.workerId,
        credentialId: identity.credentialId,
      }),
    ),
    workerId: identity.workerId,
    credentialId: identity.credentialId,
    scopes: [{ projectId: project.id, scopes: FULL }],
    workTypes: [type],
  });
  if (!claimed) throw new Error(`nothing claimable of type ${type}`);
  return claimed;
}

/**
 * Claim every fragment item that is currently queued, and index them by key.
 *
 * A wave rather than one at a time, because that is what a fleet does: three
 * independent questions go out together, and a test that took them one by one
 * would never notice if the runner had serialised them.
 */
async function claimWave(): Promise<Map<string, ClaimedWork>> {
  const out = new Map<string, ClaimedWork>();
  for (let guard = 0; guard < 10; guard += 1) {
    const [claimed] = await claimWork({
      workerId,
      credentialId: 'cred_test',
      scopes: [{ projectId: project.id, scopes: FULL }],
      workTypes: ['RESEARCH_FRAGMENT'],
    });
    if (!claimed) break;
    const item = await getWorkItem(claimed.workItemId);
    const fragment = item?.fragmentId ? await getFragment(item.fragmentId) : null;
    if (fragment) out.set(fragment.fragmentKey, claimed);
  }
  return out;
}

/**
 * Drain every verification item that is waiting, as a worker would.
 *
 * Generic on purpose: it reads the fragment off the item and answers that
 * fragment's own claims. A test that answered a claim it had chosen in advance
 * would be asserting against its own bookkeeping rather than against the queue.
 */
async function verifyWaiting(): Promise<number> {
  let done = 0;
  for (let guard = 0; guard < 12; guard += 1) {
    const [claimed] = await claimWork({
      workerId,
      credentialId: 'cred_test',
      scopes: [{ projectId: project.id, scopes: FULL }],
      workTypes: ['RESEARCH_VERIFY'],
    });
    if (!claimed) break;
    const item = await getWorkItem(claimed.workItemId);
    const claims = await listClaimsForFragment(item!.fragmentId!);
    await call('brain_submit_verification', {
      ...proof(claimed),
      verdicts: claims.map((one) => ({
        claim_id: one.id,
        supports_claim: true,
        ...MATCHES,
        note: 'Reads directly.',
      })),
      // A fragment whose only source could not be opened has not established
      // its lane, and saying otherwise is the lie the retrieval state exists
      // to prevent.
      sufficiency: claims.some((one) => one.retrievalState === 'RETRIEVED')
        ? 'SUFFICIENT'
        : 'INSUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(claimed), summary: 'verified' });
    done += 1;
  }
  return done;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

async function as<T>(
  identity: { workerId: string; credentialId: string },
  body: () => Promise<T>,
): Promise<T> {
  const previous = asIdentity;
  asIdentity = identity;
  try {
    return await body();
  } finally {
    asIdentity = previous;
  }
}

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

function claim(over: Record<string, unknown>): Record<string, unknown> {
  return {
    claim_type: 'SOURCED_FACT',
    source_publisher: 'A publisher',
    source_date: '2026-03-01',
    evidence_locator: 'table 1',
    evidence_lane: 'primary',
    retrieved_at: '2026-08-28',
    confidence: 0.9,
    primary_source: true,
    ...over,
  };
}

/**
 * The plan, as Russell's compiler hands one over.
 *
 * Four questions with the three dependency kinds between them, because the
 * campaign has to exercise all three: the decisive one fails, what is HARD-built
 * on it must be retired, and what is only sequenced behind it must not be.
 */
const PLAN = [
  {
    fragmentKey: 'reachable-payer',
    question: 'Is there an identifiable buyer who already pays for overflow transcription?',
    geography: 'United States',
    timeframe: 'as at 2026',
    population: null,
    definitions: null,
    requiredEvidence: [{ id: 'primary', description: 'a primary source', necessity: 'REQUIRED' as const }],
    acceptableSourceTypes: ['official register', 'published price list'],
    excludedSourceTypes: ['blog'],
    completionCriteria: ['One named buyer, with a source.'],
    dependsOn: [],
    minIndependentSources: 1,
    whyItMatters: 'Nothing downstream is worth anything if nobody would pay.',
    expectedClaimTypes: ['SOURCED_FACT'],
    status: 'PLANNED' as const,
  },
  {
    fragmentKey: 'fulfilment-cost',
    question: 'What would it cost to serve that buyer?',
    geography: 'United States',
    timeframe: 'as at 2026',
    population: null,
    definitions: null,
    requiredEvidence: [{ id: 'primary', description: 'a primary source', necessity: 'REQUIRED' as const }],
    acceptableSourceTypes: ['published price list'],
    excludedSourceTypes: ['blog'],
    completionCriteria: ['A published rate.'],
    // Cannot even be phrased without knowing who the buyer is.
    dependsOn: [{ key: 'reachable-payer', kind: 'HARD' as const }],
    minIndependentSources: 1,
    whyItMatters: 'It decides whether the work is worth doing at the price.',
    status: 'PLANNED' as const,
  },
  {
    fragmentKey: 'market-size',
    question: 'How large is the published market for this work?',
    geography: 'United States',
    timeframe: 'as at 2026',
    population: null,
    definitions: null,
    requiredEvidence: [{ id: 'primary', description: 'a primary source', necessity: 'REQUIRED' as const }],
    acceptableSourceTypes: ['official register', 'published price list'],
    excludedSourceTypes: ['blog'],
    completionCriteria: ['One published figure.'],
    // Ordering only. It contributes whatever happens to the payer question.
    dependsOn: [{ key: 'reachable-payer', kind: 'SEQUENCING' as const }],
    minIndependentSources: 1,
    whyItMatters: 'Context for the answer either way.',
    status: 'PLANNED' as const,
  },
  {
    fragmentKey: 'access-rules',
    question: 'What does the register publish about access to the listings?',
    geography: 'United States',
    timeframe: 'as at 2026',
    population: null,
    definitions: null,
    requiredEvidence: [{ id: 'primary', description: 'a primary source', necessity: 'REQUIRED' as const }],
    acceptableSourceTypes: ['official register'],
    excludedSourceTypes: ['blog'],
    completionCriteria: ['The register\'s published access terms.'],
    dependsOn: [],
    minIndependentSources: 1,
    whyItMatters: 'Whether the evidence can be read at all.',
    status: 'PLANNED' as const,
  },
];

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
  const admin = await createUser({
    email: `admin-${Math.random().toString(36).slice(2, 8)}@brain.invalid`,
    displayName: 'Operator',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  adminId = admin.id;
});

/** Two accounts and three sessions — the shape the audit matrix needs. */
async function auditFleet(): Promise<{
  primary: { workerId: string; credentialId: string };
  adversarial: { workerId: string; credentialId: string };
  judge: { workerId: string; credentialId: string };
}> {
  const one = await createAccount({ name: `acct-one-${Math.random().toString(36).slice(2, 8)}` });
  const two = await createAccount({ name: `acct-two-${Math.random().toString(36).slice(2, 8)}` });
  const wa = await createWorker({ name: `w-a-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' });
  const wb = await createWorker({ name: `w-b-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' });
  const ra = await createRoutine({ accountId: one.id, routineRef: `trig-a-${one.id}`, name: 'V1', tokenSecretName: 'S1' });
  const rb = await createRoutine({ accountId: two.id, routineRef: `trig-b-${two.id}`, name: 'V2', tokenSecretName: 'S2' });
  await bindRoutineWorker(ra.id, wa.id);
  await bindRoutineWorker(rb.id, wb.id);
  for (const id of [wa.id, wb.id]) {
    await grantMembership({
      projectId: project.id,
      principalType: 'WORKER',
      principalId: id,
      role: 'MEMBER',
      scopes: FULL,
      grantedByType: 'SYSTEM',
      grantedById: 'seed',
    });
  }
  return {
    primary: { workerId: wa.id, credentialId: 'cred_a1' },
    adversarial: { workerId: wb.id, credentialId: 'cred_b1' },
    judge: { workerId: wa.id, credentialId: 'cred_a2' },
  };
}

const PRIMARY_PASS = {
  assignment_satisfied: 'PARTIAL',
  requirement_findings: ['The payer question could not be established.'],
  structural_findings: [],
  boundary_findings: [],
  consistency_findings: [],
  candidate_gaps: [
    {
      classification: 'TARGETED_RESEARCH_GAP',
      title: 'No reachable payer',
      detail: 'Nothing published names a buyer for this work.',
      research_question: 'Is there a buyer reachable on published terms?',
    },
  ],
  notes: 'What is here is sourced; what is missing is the decisive part.',
};

const ADVERSARIAL_PASS = {
  attacks: [
    {
      attack: 'The market figure is being read as evidence that somebody would buy.',
      assessment: 'VALID',
      reasoning: 'A market existing is not the same fact as a reachable buyer.',
    },
  ],
  strongest_reason_not_to_advance: 'The decisive question has no evidence at all.',
};

const JUDGE_PASS = {
  verdict: 'MORE_RESEARCH',
  summary: 'The context is sourced and the decisive question is open.',
  next_action: 'Establish whether any buyer is reachable on published terms.',
  gap_classifications: [
    {
      classification: 'TARGETED_RESEARCH_GAP',
      title: 'No reachable payer',
      detail: 'Nothing published names a buyer.',
      research_question: 'Is there a buyer reachable on published terms?',
    },
  ],
  foundational_gap_count: 0,
  targeted_research_runs_required: 1,
  synthesis_ready: false,
  freeze_ready: false,
  confidence: 0.5,
};

describe('a research campaign, from the objective to the lesson', () => {
  it('runs the whole lifecycle with nobody relaying anything between workers', async () => {
    // ---- 1. A packet is started the way Russell starts one. ---------------
    const started = await startPacket({
      projectId: project.id,
      layerId: layer.id,
      title: 'Whether overflow transcription is worth taking on',
      assignment:
        'Establish whether there is a buyer who already pays for overflow transcription, ' +
        'what serving them would cost, and what the register publishes about access.',
      approval: { mode: 'PER_PACKET' },
      startedBy: { kind: 'PERSON', id: adminId },
      plan: PLAN,
    });
    const orchestration = started.orchestration;

    // ---- 2. Brain wrote down what it believes it was asked. ---------------
    //
    // Nobody called `ensureProblemModel`: the runner did, on the advance
    // `startPacket` performs before it returns.
    const model = await currentProblemModel(orchestration.id);
    expect(model).not.toBeNull();
    expect(model!.version).toBe(1);
    // A reading derived from rows says so, rather than presenting a default as
    // somebody's decision.
    expect(['CONTRACT', 'ASSIGNMENT']).toContain(model!.derivedFrom);

    // ---- 3. The decisive unknowns were identified, with the graph. --------
    const seeded = await listUncertainties(orchestration.id);
    expect(seeded.map((one) => one.uncertaintyKey).sort()).toEqual([
      'access-rules',
      'fulfilment-cost',
      'market-size',
      'reachable-payer',
    ]);
    const payer = seeded.find((one) => one.uncertaintyKey === 'reachable-payer')!;
    // Read from the HARD dependency rather than from any prose about it.
    expect(payer.invalidating).toBe(true);
    expect(payer.consequence).toBe('CRITICAL');

    const links = await listUncertaintyLinks(orchestration.id);
    expect(links.find((link) => link.toKey === 'fulfilment-cost')?.kind).toBe('HARD_PREREQUISITE');
    // Sequencing is evidentiary: it blocks nothing and a failure costs it nothing.
    expect(links.find((link) => link.toKey === 'market-size')?.kind).toBe('EVIDENTIARY');

    // Nothing has been spent: the packet is at the approval gate.
    expect(started.advanced.waitingOn ?? '').toContain('approve');
    expect(await listWorkItems(project.id, { limit: 100 })).toHaveLength(0);

    // ---- 4. The agenda puts the decisive question first, and says why. ----
    const beforeApproval = await researchIntelligenceView(orchestration);
    expect(beforeApproval.next[0]?.key).toBe('reachable-payer');
    expect(beforeApproval.next[0]?.why).toContain('pointless');
    expect(beforeApproval.sufficiency.verdict).toBe('KEEP_RESEARCHING');

    // ---- 5. A person approves, and several fragments go at once. ----------
    await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: adminId });
    const queued = (await listWorkItems(project.id, { limit: 100 })).filter(
      (item) => item.workType === 'RESEARCH_FRAGMENT' && item.state === 'QUEUED',
    );
    // Three of the four: `fulfilment-cost` waits on its HARD prerequisite, and
    // the rest are genuinely independent, so nothing serialises them.
    expect(queued).toHaveLength(3);

    // ---- 6. A source nobody could open. ----------------------------------
    //
    // Required scenario 4. The claim is submitted with its retrieval state
    // rather than dropped, and the question stays open.
    const wave = await claimWave();
    // Three independent questions went out together; nothing serialised them.
    expect([...wave.keys()].sort()).toEqual(['access-rules', 'market-size', 'reachable-payer']);

    const access = wave.get('access-rules')!;
    await call('brain_submit_claims', {
      ...proof(access),
      claims: [
        claim({
          claim: 'The register publishes its access terms on a page behind a paywall.',
          source_url: 'https://example.gov/register/terms',
          source_title: 'Access terms',
          evidence_excerpt: 'Subscription required to view.',
          retrieval_state: 'PAYWALLED',
        }),
      ],
    });
    await call('brain_complete_work', { ...proof(access), summary: 'one source unreadable' });

    // ---- 7. A fragment that establishes something and falls short. --------
    //
    // Required scenario 3: the claim cleared the gate and the fragment did not
    // clear its own bar, and both facts survive.
    const market = wave.get('market-size')!;
    await call('brain_submit_claims', {
      ...proof(market),
      claims: [
        claim({
          claim: 'The published market for transcription services was $2.4bn in 2025.',
          source_url: 'https://example.gov/statistics/transcription-2025',
          source_title: 'Services statistics 2025',
          evidence_excerpt: 'Transcription services: $2.4bn.',
        }),
      ],
    });
    await call('brain_complete_work', { ...proof(market), summary: 'claims in' });

    // Both waiting verifications, answered by the worker that was handed them.
    expect(await verifyWaiting()).toBe(2);

    expect((await getUncertainty(orchestration.id, 'market-size'))?.disposition).toBe('RESOLVED');

    // ---- 8. A restart, in the middle. -------------------------------------
    //
    // Required scenario 13. Nothing is held in memory, so resuming and
    // continuing are the same operation — and the objective is not reinterpreted
    // from scratch.
    const beforeRestart = {
      uncertainties: (await listUncertainties(orchestration.id)).length,
      revisions: (await listPlanRevisions(orchestration.id)).length,
      modelVersion: (await currentProblemModel(orchestration.id))!.version,
      claims: (await listClaims(orchestration.id)).length,
    };
    await restartDatabase();
    await advancePacket(orchestration.id);
    expect((await listUncertainties(orchestration.id)).length).toBe(beforeRestart.uncertainties);
    expect((await currentProblemModel(orchestration.id))!.version).toBe(beforeRestart.modelVersion);
    expect((await listClaims(orchestration.id)).length).toBe(beforeRestart.claims);
    // Resolved stays resolved. A restart that re-derived a disposition would
    // make every decision in the campaign provisional.
    expect((await getUncertainty(orchestration.id, 'market-size'))?.disposition).toBe('RESOLVED');

    // ---- 9. The decisive question fails on its own evidence. --------------
    const payerItem = wave.get('reachable-payer')!;
    await call('brain_report_blocker', {
      ...proof(payerItem),
      reason:
        'No published source names a buyer for overflow work; every listing found is an agency ' +
        'advertising to end clients rather than buying capacity.',
      searched: ['the state register', 'two published price lists'],
    });
    /*
     * The blocker is the finding; the item then ends without a ledger, which is
     * what `brain_fail_work` is for. `brain_complete_work` refuses a research
     * item that recorded nothing, deliberately — completing it would end the
     * work without doing it.
     */
    await call('brain_fail_work', {
      ...proof(payerItem),
      category: 'DEPENDENCY_UNAVAILABLE',
      detail: 'No published source names a buyer.',
      retryable: false,
    });

    // Its repair ladder is what decides whether another attempt exists, and the
    // campaign is meant to reach the end of it rather than be told to.
    for (let guard = 0; guard < 8; guard += 1) {
      const fragments = await listFragments(orchestration.id);
      const live = fragments.filter(
        (one) => one.fragmentKey === 'reachable-payer' && one.status === 'QUEUED',
      );
      if (live.length === 0) break;
      const retryWave = await claimWave();
      const retry = retryWave.get('reachable-payer');
      // Hand back everything this step is not about. A worker that walked away
      // holding somebody else's item is the stranded lease §19 is written about,
      // and a test that did it would be testing that instead.
      for (const [key, held] of retryWave) {
        if (key === 'reachable-payer') continue;
        await call('brain_release_work', {
          work_item_id: held.workItemId,
          lease_id: held.leaseId,
          lease_generation: held.leaseGeneration,
          reason: 'Not the question this session took.',
        });
      }
      if (!retry) break;
      await call('brain_report_blocker', {
        ...proof(retry),
        reason: 'The alternative source ecosystem produced nothing either.',
        searched: ['trade directories'],
      });
      await call('brain_fail_work', {
        ...proof(retry),
        category: 'DEPENDENCY_UNAVAILABLE',
        detail: 'The alternative source ecosystem produced nothing either.',
        retryable: false,
      });
    }

    // ---- 10. The branch that only mattered if it held is retired. ---------
    //
    // Required scenario 1, and required scenario 5 beside it: the evidentiary
    // sibling is untouched.
    await advancePacket(orchestration.id);
    const fulfilment = await getUncertainty(orchestration.id, 'fulfilment-cost');
    expect(fulfilment?.disposition).toBe('RETIRED');
    expect(fulfilment?.dispositionReason).toContain('only bears on the decision if it could');
    expect((await getUncertainty(orchestration.id, 'market-size'))?.disposition).toBe('RESOLVED');

    // Recorded on the project's own history, not only in a research table.
    const revisions = await listPlanRevisions(orchestration.id);
    expect(revisions.map((one) => one.reason)).toContain('BRANCH_RETIRED');

    // ---- 11. A person authorizes filing short, and the packet says so. ----
    await authorizeUnresolvedGaps({
      orchestrationId: orchestration.id,
      authorizedBy: { id: adminId, email: 'operator@brain.invalid' },
    });
    await advancePacket(orchestration.id);

    // ---- 12. The campaign runs itself to a filed report. ------------------
    //
    // Nothing below queues anything: each item is claimed because the runner
    // had already created it.
    let guard = 0;
    while (guard < 25) {
      guard += 1;
      const current = await getOrchestration(orchestration.id);
      if (!current) break;
      const items = (await listWorkItems(project.id, { limit: 200 })).filter(
        (item) =>
          item.orchestrationId === orchestration.id &&
          item.state === 'QUEUED' &&
          item.workType !== 'RESEARCH_AUDIT',
      );
      if (items.length === 0) break;
      const item = items[0]!;
      if (item.workType === 'RESEARCH_FRAGMENT') {
        const claimed = await claimNext('RESEARCH_FRAGMENT');
        await call('brain_report_blocker', {
          ...proof(claimed),
          reason: 'The remaining lane produced nothing either.',
          searched: ['everything the strategy named'],
        });
        await call('brain_fail_work', {
          ...proof(claimed),
          category: 'DEPENDENCY_UNAVAILABLE',
          detail: 'The remaining lane produced nothing either.',
          retryable: false,
        });
        continue;
      }
      if (item.workType === 'RESEARCH_VERIFY') {
        const claimed = await claimNext('RESEARCH_VERIFY');
        const item = await getWorkItem(claimed.workItemId);
        const claims = await listClaimsForFragment(item!.fragmentId!);
        await call('brain_submit_verification', {
          ...proof(claimed),
          verdicts: claims.map((one) => ({
            claim_id: one.id,
            supports_claim: true,
            ...MATCHES,
            note: 'Reads directly.',
          })),
          sufficiency: claims.length > 0 ? 'SUFFICIENT' : 'INSUFFICIENT',
        });
        await call('brain_complete_work', { ...proof(claimed), summary: 'verified' });
        continue;
      }
      if (item.workType === 'RESEARCH_SYNTHESIZE') {
        const claimed = await claimNext('RESEARCH_SYNTHESIZE');
        const cited = (await listClaims(orchestration.id)).filter((one) => one.accepted);
        await call('brain_submit_synthesis', {
          ...proof(claimed),
          report:
            'The published market is $2.4bn [' +
            cited.map((one) => one.id).join('] [') +
            ']. No buyer reachable on published terms could be established.',
          cited_claim_ids: cited.map((one) => one.id),
        });
        await call('brain_complete_work', { ...proof(claimed), summary: 'filed' });
        continue;
      }
      break;
    }

    const filed = await getOrchestration(orchestration.id);
    expect(filed?.documentId).toBeTruthy();

    // ---- 13. Three independent audit roles, in order. ---------------------
    const fleet = await auditFleet();
    await as(fleet.primary, async () => {
      const item = await claimNext('RESEARCH_AUDIT');
      await call('brain_submit_audit', { ...proof(item), primary: PRIMARY_PASS });
      await call('brain_complete_work', { ...proof(item), summary: 'primary in' });
    });
    await as(fleet.adversarial, async () => {
      const item = await claimNext('RESEARCH_AUDIT');
      await call('brain_submit_audit', { ...proof(item), adversarial: ADVERSARIAL_PASS });
      await call('brain_complete_work', { ...proof(item), summary: 'adversarial in' });
    });
    await as(fleet.judge, async () => {
      const item = await claimNext('RESEARCH_AUDIT');
      await call('brain_submit_audit', { ...proof(item), judge: JUDGE_PASS });
      await call('brain_complete_work', { ...proof(item), summary: 'judged' });
    });
    expect(await listAuditsByProject(project.id)).toHaveLength(1);

    // ---- 14. A terminal packet, honest about what it did not settle. ------
    await advancePacket(orchestration.id);
    const done = await getOrchestration(orchestration.id);
    /*
     * The honest end, asserted exactly rather than as a list of things it might
     * be.
     *
     * The report was filed and all three roles argued over it; the judge then
     * said MORE_RESEARCH, and this run has no further search the repair ladder
     * has not already spent. That is `NEEDS_HUMAN` with a reason naming the
     * decision — not a failure, and emphatically not a packet that talked
     * itself into "complete". The gap authorization is present and is
     * deliberately not enough on its own: `outcomeFor` files short only when
     * nothing is repairable at all.
     */
    expect(done!.status).toBe('NEEDS_HUMAN');
    expect(done!.verdict).toBe('MORE_RESEARCH');
    expect(done!.failureReason).toContain('a decision rather than a wait');
    // And the packet is not empty-handed: a filed, audited report that says what
    // it could not settle.
    expect(done!.documentId).toBeTruthy();
    expect(done!.auditId).toBeTruthy();

    // ---- 15. The reading a person gets is honest and traceable. -----------
    //
    // Read fresh, the way the route does. The `orchestration` this test has
    // held since step 1 predates the gap authorization, and handing a stale row
    // to a projection is how a reading comes out describing a packet that no
    // longer exists.
    const view = await researchIntelligenceView((await getOrchestration(orchestration.id))!);
    expect(view.understanding?.outcomeSought).toBeTruthy();
    // Decisive coverage rather than a count of fragments, with the denominator
    // named. It is not a flattering number and it is the true one.
    expect(view.sufficiency.decisive.total).toBeGreaterThan(0);
    expect(view.retired.map((one) => one.key)).toContain('fulfilment-cost');
    expect(view.settled.map((one) => one.key)).toContain('market-size');
    // Every closed question says why it closed.
    for (const question of [...view.retired, ...view.settled]) {
      expect(question.reason ?? '').not.toBe('');
    }
    // Nothing invented: the market figure is an EVIDENCE belief, and the
    // decisive question never became one.
    const settledMarket = view.settled.find((one) => one.key === 'market-size');
    expect(settledMarket?.beliefBasis).toBe('EVIDENCE');

    // ---- 16. Reading it changed nothing. ---------------------------------
    const beforeReads = {
      items: (await listWorkItems(project.id, { limit: 200 })).length,
      fragments: (await listFragments(orchestration.id)).length,
      revisions: (await listPlanRevisions(orchestration.id)).length,
    };
    await researchIntelligenceView(orchestration);
    await researchIntelligenceView(orchestration);
    expect((await listWorkItems(project.id, { limit: 200 })).length).toBe(beforeReads.items);
    expect((await listFragments(orchestration.id)).length).toBe(beforeReads.fragments);
    expect((await listPlanRevisions(orchestration.id)).length).toBe(beforeReads.revisions);
  }, 120_000);

  it('turns a finished campaign into lessons on the tick, once', async () => {
    const started = await startPacket({
      projectId: project.id,
      layerId: layer.id,
      title: 'Whether the 1927 cut survives',
      assignment: 'Establish whether any archive holds a print of the 1927 cut.',
      approval: { mode: 'PER_PACKET' },
      startedBy: { kind: 'PERSON', id: adminId },
      plan: [
        {
          fragmentKey: 'print-survives',
          question: 'Does any archive hold a print of the 1927 cut?',
          geography: 'Worldwide',
          timeframe: 'as at 2026',
          population: null,
          definitions: null,
          requiredEvidence: [
            { id: 'primary', description: 'an archive catalogue', necessity: 'REQUIRED' as const },
          ],
          acceptableSourceTypes: ['archive catalogue'],
          excludedSourceTypes: ['blog'],
          completionCriteria: ['A catalogue entry, or a documented search of the places it would be.'],
          dependsOn: [],
          minIndependentSources: 1,
          whyItMatters: 'Nothing about restoration matters if no print exists.',
          status: 'PLANNED' as const,
        },
        {
          fragmentKey: 'restoration-feasibility',
          question: 'What would restoring a surviving print involve?',
          geography: 'Worldwide',
          timeframe: 'as at 2026',
          population: null,
          definitions: null,
          requiredEvidence: [
            { id: 'primary', description: 'a published restoration account', necessity: 'REQUIRED' as const },
          ],
          acceptableSourceTypes: ['published restoration account'],
          excludedSourceTypes: ['blog'],
          completionCriteria: ['A published account of a comparable restoration.'],
          dependsOn: [{ key: 'print-survives', kind: 'HARD' as const }],
          minIndependentSources: 1,
          whyItMatters: 'It decides whether the project is worth proposing.',
          status: 'PLANNED' as const,
        },
      ],
    });
    const orchestration = started.orchestration;
    await approvePlan({ orchestrationId: orchestration.id, approvedByUserId: adminId });

    // The decisive question fails before anything is spent on what rests on it —
    // which is the ordering the retrospective is meant to notice.
    const print = (await listFragments(orchestration.id)).find(
      (one) => one.fragmentKey === 'print-survives',
    )!;
    await updateFragment(print.id, {
      status: 'BLOCKED',
      maxRepairs: 0,
      blockedReason: 'A documented search of the four archives that would hold it found nothing.',
    });
    await advancePacket(orchestration.id);

    expect((await getUncertainty(orchestration.id, 'restoration-feasibility'))?.disposition).toBe(
      'RETIRED',
    );

    await getDb().run(
      `UPDATE research_orchestrations SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = ?
        WHERE id = ?`,
      [new Date().toISOString(), 'The decisive question could not be established.', orchestration.id],
    );

    const first = await reconcileRetrospectives(20);
    expect(first.find((entry) => entry.orchestrationId === orchestration.id)).toBeDefined();

    const view = await researchIntelligenceView((await getOrchestration(orchestration.id))!);
    // A lesson about ordering, at the level it actually holds at.
    expect(view.lessons.some((lesson) => lesson.abstraction !== 'CAMPAIGN')).toBe(true);
    expect(view.lessons.map((lesson) => lesson.lesson).join(' ')).toContain('prerequisite');

    // Idempotent by what it is about, so the tick does it once.
    const second = await reconcileRetrospectives(20);
    expect(second.find((entry) => entry.orchestrationId === orchestration.id)).toBeUndefined();
  }, 60_000);

  it('never lets one packet\'s questions reach another', async () => {
    const one = await startPacket({
      projectId: project.id,
      layerId: layer.id,
      title: 'Packet one',
      assignment: 'A question.',
      approval: { mode: 'PER_PACKET' },
      startedBy: { kind: 'PERSON', id: adminId },
      plan: [PLAN[0]!],
    });
    const two = await startPacket({
      projectId: project.id,
      layerId: layer.id,
      title: 'Packet two',
      assignment: 'A different question.',
      approval: { mode: 'PER_PACKET' },
      startedBy: { kind: 'PERSON', id: adminId },
      plan: [{ ...PLAN[0]!, fragmentKey: 'other-payer' }],
    });

    const keysOne = (await listUncertainties(one.orchestration.id)).map((x) => x.uncertaintyKey);
    const keysTwo = (await listUncertainties(two.orchestration.id)).map((x) => x.uncertaintyKey);
    expect(keysOne).toEqual(['reachable-payer']);
    expect(keysTwo).toEqual(['other-payer']);

    // And the requirements each packet wrote stay its own.
    expect((await listRequirements(one.orchestration.id)).length).toBe(1);
    expect((await listRequirements(two.orchestration.id)).length).toBe(1);
  }, 60_000);
});
