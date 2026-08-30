/**
 * The research packet, end to end, written as the ways it could lie.
 *
 * Step 9 gave a worker the ability to put research into the Brain. Every test
 * here is about a way that could go wrong quietly — a claim accepted without a
 * source, a fragment passing with its lanes uncovered, a report citing evidence
 * that was rejected, a second submission doubling a ledger, a plan starting
 * before anybody approved it.
 *
 * They run at the tool boundary rather than over HTTP, because what is under
 * test is the authorization, the gate and the idempotency rather than the
 * transport — `mcp.test.ts` and `oauth.test.ts` cover that. And they run
 * against whichever backend the suite is pointed at, because "the gate refuses
 * this" is a claim about a database.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { findTool } from '../server/mcp/tools.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  acceptedClaims,
  createFragments,
  createOrchestration,
  currentFragments,
  getFragment,
  getOrchestration,
  listClaims,
  listClaimsForFragment,
} from '../server/repos/research.ts';
import {
  claimWork,
  completeWork,
  enqueueWork,
  getWorkItem,
  listWorkItems,
  releaseWork,
} from '../server/repos/workQueue.ts';
import { getProjectBySlug } from '../server/repos/projects.ts';
import { getDocument } from '../server/repos/documents.ts';
import { listAuditsByProject } from '../server/repos/audits.ts';
import { parseAdversarialPass } from '../server/services/audit/schema.ts';
import { readObject } from '../server/services/storage.ts';
import {
  createFixturePacket,
  FIXTURE_BANNER,
  FIXTURE_PROJECT_SLUG,
  runFixturePacket,
} from '../server/services/research/fixtures.ts';
import { advancePacket, approvePlan, resumePulledPackets } from '../server/services/research/packetRunner.ts';
import { createRequirements, listCoverage, upsertCoverage } from '../server/repos/reconciliation.ts';
import { recoverInterruptedResearch } from '../server/services/research/queue.ts';
import { updateFragment, updateOrchestration } from '../server/repos/research.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  Project,
  ResearchFragment,
  ResearchOrchestration,
  WorkerScope,
} from '../server/domain/types.ts';

/** Everything a research worker holds, so a missing scope is a deliberate test. */
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
let run = '';

async function principalFor(scopes: WorkerScope[]): Promise<Principal> {
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
  scopes: WorkerScope[] = FULL,
): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: await principalFor(scopes),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

/** Call a tool and return the refusal rather than throwing it. */
async function refusal(
  name: string,
  args: Record<string, unknown>,
  scopes: WorkerScope[] = FULL,
): Promise<{ category: string; message: string }> {
  try {
    await call(name, args, scopes);
  } catch (error) {
    const err = error as { category?: string; message?: string };
    return { category: err.category ?? 'THREW', message: err.message ?? String(error) };
  }
  throw new Error(`${name} was expected to refuse and did not.`);
}

async function makeOrchestration(): Promise<ResearchOrchestration> {
  const created = await createRun({
    projectId: project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'Whether a success fee for arranging a business sale needs a broker licence.',
  });
  run = created.id;
  return await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: created.id,
    title: 'Licensure of success-fee intermediation',
    assignment: 'Which US states require a licence, and what provision settles it.',
    provider: 'WORKER',
    autoApprove: false,
  });
}

async function makeFragment(
  orchestration: ResearchOrchestration,
  over: Partial<Parameters<typeof createFragments>[0][number]> = {},
): Promise<ResearchFragment> {
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: project.id,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'licence-california',
      question: 'Does California require a licence for a success fee on a business sale?',
      geography: 'California, United States',
      timeframe: 'in force as at 2026',
      population: null,
      definitions: 'Business sale meaning a transfer of a going concern with no real property.',
      requiredEvidence: ['statute'],
      acceptableSourceTypes: ['statute', 'regulator guidance'],
      excludedSourceTypes: ['law firm blog'],
      completionCriteria: ['One statute section that answers yes or no.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
      ...over,
    },
  ]);
  return fragment!;
}

/** Queue a research item for a fragment and claim it, as a worker would. */
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
  claim: 'California Business and Professions Code section 10131 defines a real estate broker.',
  claim_type: 'SOURCED_FACT',
  source_url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=10131',
  source_title: 'Business and Professions Code section 10131',
  source_publisher: 'California Legislative Information',
  source_date: '2026-01-01',
  evidence_excerpt: 'A real estate broker within the meaning of this part is a person who…',
  evidence_locator: 'section 10131(a)',
  evidence_lane: 'statute',
  retrieved_at: '2026-08-28',
  confidence: 0.95,
  primary_source: true,
};

const MATCHES = { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' };

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
// What a worker may see
// ---------------------------------------------------------------------------

describe('reading an assignment', () => {
  it('hands over the fragment declaration the gate will judge it against', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const value = await call('brain_get_assignment', { work_item_id: claimed.workItemId });
    const assignment = value['assignment'] as Record<string, unknown>;
    const declared = assignment['fragment'] as Record<string, unknown>;

    // Verbatim, because these are the fields applyGate reads. A summary here
    // would mean the worker researched against something other than the bar.
    expect(declared['question']).toBe(fragment.question);
    expect(declared['geography']).toBe('California, United States');
    expect(declared['requiredEvidence']).toEqual(['statute']);
    expect(declared['excludedSourceTypes']).toEqual(['law firm blog']);
    expect(declared['minIndependentSources']).toBe(1);
    expect(declared['completionCriteria']).toEqual(['One statute section that answers yes or no.']);
  });

  it('carries no prompt — an assignment is not a script', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const value = await call('brain_get_assignment', { work_item_id: claimed.workItemId });
    const serialized = JSON.stringify(value).toLowerCase();
    expect(serialized).not.toContain('you are');
    expect(serialized).not.toContain('respond with');
    expect(Object.keys(value['assignment'] as object)).not.toContain('prompt');
  });

  /**
   * The deadlock, and the reason no test caught it.
   *
   * `brain_submit_verification` takes a verdict per claim id and refuses a
   * partial answer. Nothing handed a worker those ids: the assignment carried
   * the fragment's declarations and its *dependencies'* claims, never its own.
   * So a verification could be completed only by a session that had submitted
   * the claims and still had the ids in front of it — and every redelivery,
   * reissue and second session was uncompletable.
   *
   * Every other test in this file reads ids with `listClaimsForFragment`, which
   * is the database, which a worker does not have. The hosted harness holds
   * them in a local variable. Both prove the tool works and neither crosses the
   * boundary the real path always crosses, which is why this survived a live
   * packet stopping on it twice.
   *
   * These three go through `brain_get_assignment` and nothing else.
   */
  it('hands a verification the claims it must judge, with their ids', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const value = await call('brain_get_assignment', { work_item_id: verify.workItemId });
    const assignment = value['assignment'] as Record<string, unknown>;
    const toVerify = assignment['claimsToVerify'] as Record<string, unknown>[];

    expect(toVerify).toHaveLength(1);
    expect(toVerify[0]!['claimId']).toBe((await listClaimsForFragment(fragment.id))[0]!.id);
    // The scope fields travel too: two of the seven gate conditions are
    // judgements about scope, and they cannot be made from the claim text.
    expect(toVerify[0]!['claim']).toBe(SOURCED.claim);
    expect(toVerify[0]!['sourceUrl']).toBe(SOURCED.source_url);
  });

  it('lets a session verify claims it did not submit', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });

    // From here on, pretend the submitting session is gone. The only source of
    // claim ids is the assignment — no listClaimsForFragment, no response body
    // kept from the submission.
    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const assignment = (await call('brain_get_assignment', { work_item_id: verify.workItemId }))[
      'assignment'
    ] as Record<string, unknown>;
    const ids = (assignment['claimsToVerify'] as { claimId: string }[]).map((c) => c.claimId);

    const value = await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: ids.map((claimId) => ({
        claim_id: claimId,
        supports_claim: true,
        ...MATCHES,
        note: 'Read the section.',
      })),
      sufficiency: 'SUFFICIENT',
    });

    expect(value['integrity']).toBe('PASS');
    expect(value['acceptedClaims']).toBe(1);
    expect((await getFragment(fragment.id))?.status).toBe('ACCEPTED');
  });

  it('does not hand a research item the fragment its own working back', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const assignment = (await call('brain_get_assignment', { work_item_id: research.workItemId }))[
      'assignment'
    ] as Record<string, unknown>;
    // Only the item whose purpose is to judge them gets them. A researcher
    // handed the claims it is about to make is being shown an answer.
    expect(assignment['claimsToVerify']).toBeNull();
  });

  it('names the claims a verification left unanswered', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', {
      ...proof(research),
      claims: [SOURCED, { ...SOURCED, claim: 'A second, separate thing.' }],
    });
    const stored = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const refused = await refusal('brain_submit_verification', {
      ...proof(verify),
      verdicts: [
        { claim_id: stored[0]!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' },
      ],
      sufficiency: 'SUFFICIENT',
    });

    // Being told the answer is short without being told of what is half of what
    // made this uncompletable. The caller holds the item for this fragment and
    // can read every id from the assignment, so naming them discloses nothing.
    expect(refused.message).toContain(stored[1]!.id);
    expect(refused.message).not.toContain(stored[0]!.id);
  });

  it('refuses a worker without research:read, saying nothing about what exists', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const without = FULL.filter((scope) => scope !== 'research:read');
    const refused = await refusal(
      'brain_get_assignment',
      { work_item_id: claimed.workItemId },
      without,
    );
    expect(refused.category).toBe('NOT_FOUND');
    // Indistinguishable from a work item that is not there — invariant 23.
    const absent = await refusal('brain_get_assignment', { work_item_id: 'wki_nothing' });
    expect(refused.message).toBe(absent.message);
  });
});

// ---------------------------------------------------------------------------
// Claims, and the gate
// ---------------------------------------------------------------------------

describe('submitting claims', () => {
  it('stores every claim unaccepted, whatever the worker thinks of it', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const value = await call('brain_submit_claims', {
      ...proof(claimed),
      claims: [SOURCED],
    });

    expect(value['recorded']).toBe(1);
    expect(value['accepted']).toBe(0);
    const stored = await listClaimsForFragment(fragment.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.accepted).toBe(false);
  });

  it('keeps an unsourced claim, marked, rather than dropping it', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const value = await call('brain_submit_claims', {
      ...proof(claimed),
      claims: [SOURCED, { claim: 'Most states probably require one.', confidence: 0.4 }],
    });

    // Both stored. Dropping the unsourced one would make the ledger look better
    // than the research was, and the count of what could not be sourced is one
    // of the more useful things it says.
    expect(value['recorded']).toBe(2);
    expect(value['unsourced']).toBe(1);
    const stored = await listClaimsForFragment(fragment.id);
    const unsourced = stored.find((claim) => !claim.sourced);
    expect(unsourced?.validationState).toBe('NO_URL');
  });

  it('refuses a worker without claims:write', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const refused = await refusal(
      'brain_submit_claims',
      { ...proof(claimed), claims: [SOURCED] },
      FULL.filter((scope) => scope !== 'claims:write'),
    );
    expect(refused.category).toBe('NOT_FOUND');
    expect(await listClaimsForFragment(fragment.id)).toHaveLength(0);
  });

  it('records one ledger however many times the item is redelivered', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    await call('brain_submit_claims', { ...proof(claimed), claims: [SOURCED] });
    const again = await call('brain_submit_claims', {
      ...proof(claimed),
      // Deliberately different claims: a second attempt that researched harder
      // must still not double the ledger. The key is the work item and the
      // operation, never the contents.
      claims: [SOURCED, { ...SOURCED, claim: 'A second thing entirely.' }],
    });

    expect(again['state']).toBe('ALREADY_RECORDED');
    expect(await listClaimsForFragment(fragment.id)).toHaveLength(1);
  });
});

describe('a research gap that is genuinely exhausted', () => {
  /**
   * Option A, authorized for this packet: when a fragment has spent its repair
   * budget and no evidence path remains, record the gap and file what the
   * evidence supports, rather than holding the packet open forever.
   *
   * What must not happen is a Brain that can declare its way to "complete".
   * So this is narrow: it fires only when nothing is live or claimable, only
   * for a fragment that is BLOCKED *and* out of attempts, and it changes no
   * gate — the claims, verdicts and rejection reasons stay exactly as they are.
   * It narrows what the packet claims to answer; it does not change what it
   * found.
   */
  async function exhaustedPacket(): Promise<{
    orchestration: ResearchOrchestration;
    dead: ResearchFragment;
    dependent: ResearchFragment;
    requirementIds: string[];
  }> {
    const orchestration = await makeOrchestration();
    const [rDead, rDep] = await createRequirements([
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        requirementKey: 'trigger',
        ordinal: 0,
        statement: 'Whether Texas requires a licence.',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        requirementKey: 'penalty',
        ordinal: 1,
        statement: 'The penalty for acting without that licence.',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
    ]);
    const dead = await makeFragment(orchestration, {
      fragmentKey: 'trigger',
      fragmentIndex: 0,
      status: 'BLOCKED',
      attempt: 3,
      maxRepairs: 2,
      requirementIds: [rDead!.id],
    });
    await updateFragment(dead.id, {
      blockedReason: 'The statute site refuses automated retrieval.',
    });
    const dependent = await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      status: 'QUEUED',
      dependsOn: ['trigger'],
      requirementIds: [rDep!.id],
    });
    // Coverage rows, as the planning pass writes them.
    for (const requirement of [rDead!, rDep!]) {
      await upsertCoverage({
        orchestrationId: orchestration.id,
        requirementId: requirement.id,
        status: 'MISSING',
        confidence: 0.2,
        reasons: ['Nothing in the archive answers it.'],
        claimIds: [],
        documentIds: [],
        needsResearch: true,
      });
    }
    return { orchestration, dead, dependent, requirementIds: [rDead!.id, rDep!.id] };
  }

  it('records the gap, cancels what depended on it, and stops blocking synthesis', async () => {
    const { orchestration, dead, dependent } = await exhaustedPacket();

    await advancePacket(orchestration.id);

    // The exhausted fragment is untouched: its evidence and its reason are the
    // history, and Option A preserves them.
    const deadAfter = await getFragment(dead.id);
    expect(deadAfter?.status).toBe('BLOCKED');
    expect(deadAfter?.blockedReason).toContain('refuses automated retrieval');

    // The dependent is cancelled, naming what never arrived.
    const depAfter = await getFragment(dependent.id);
    expect(depAfter?.status).toBe('CANCELLED');
    expect(depAfter?.blockedReason).toContain('trigger');

    // Both requirements are recorded as explicitly not required, with why.
    const coverage = await listCoverage(orchestration.id);
    expect(coverage).toHaveLength(2);
    for (const entry of coverage) {
      expect(entry.status).toBe('NOT_REQUIRED');
      expect((entry.userOverride ?? '').length).toBeGreaterThan(0);
    }
  });

  it('does not fire while the fragment still has a repair attempt left', async () => {
    const orchestration = await makeOrchestration();
    const [requirement] = await createRequirements([
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        requirementKey: 'trigger',
        ordinal: 0,
        statement: 'Whether Texas requires a licence.',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
    ]);
    await makeFragment(orchestration, {
      fragmentKey: 'trigger',
      fragmentIndex: 0,
      status: 'BLOCKED',
      // One attempt used of two allowed. Research is still the answer here.
      attempt: 1,
      maxRepairs: 2,
      requirementIds: [requirement!.id],
    });
    await upsertCoverage({
      orchestrationId: orchestration.id,
      requirementId: requirement!.id,
      status: 'MISSING',
      confidence: 0.2,
      reasons: ['Nothing in the archive answers it.'],
      claimIds: [],
      documentIds: [],
      needsResearch: true,
    });

    await advancePacket(orchestration.id);

    const [entry] = await listCoverage(orchestration.id);
    expect(entry?.status).toBe('MISSING');
  });

  it('does not fire while any work is still live', async () => {
    const { orchestration } = await exhaustedPacket();
    // Something claimable elsewhere in the packet: research may yet change the
    // picture, so nothing is written off.
    await enqueueWork({
      projectId: project.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'still going' },
      requiredScopes: [],
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
    });

    await advancePacket(orchestration.id);

    const coverage = await listCoverage(orchestration.id);
    expect(coverage.every((entry) => entry.status === 'MISSING')).toBe(true);
  });
});

describe('a packet stopped for a person', () => {
  /**
   * `NEEDS_HUMAN` was in the same list as COMPLETE, FAILED and CANCELLED, and
   * `advancePacket` returned on sight of any of them. Three of those four mean
   * the packet is over; the fourth means a decision is outstanding, which is a
   * different thing entirely.
   *
   * The difference did not exist while a fault killed the packet. It became
   * load-bearing the moment one fragment could fail without taking the packet
   * with it: from then on a packet could be NEEDS_HUMAN and still hold
   * approved, never-attempted fragments, and the early return refused to mint
   * any of them. `listPendingOrchestrations` excluded the same status, so boot
   * recovery skipped it too — the state was absorbing, and only an operator
   * pressing a recovery control got out.
   *
   * Five independent approved fragments sat unminted behind exactly this.
   */
  it('still mints independent approved fragments, exactly once each', async () => {
    const orchestration = await makeOrchestration();
    const blocked = await makeFragment(orchestration, {
      fragmentKey: 'exhausted',
      fragmentIndex: 0,
      status: 'BLOCKED',
    });
    const independent = await Promise.all([
      makeFragment(orchestration, { fragmentKey: 'alpha', fragmentIndex: 1, status: 'QUEUED' }),
      makeFragment(orchestration, { fragmentKey: 'beta', fragmentIndex: 2, status: 'QUEUED' }),
      makeFragment(orchestration, { fragmentKey: 'gamma', fragmentIndex: 3, status: 'QUEUED' }),
    ]);

    // The packet has already been stopped for a person over the blocked one.
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: 'A fragment exhausted its evidence paths.',
    });

    const result = await advancePacket(orchestration.id);

    expect(result.enqueued).toHaveLength(3);
    expect(result.enqueued.map((entry) => entry.fragmentKey).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    // Running again, because the packet is live and the work exists.
    expect((await getOrchestration(orchestration.id))?.status).toBe('RESEARCHING');
    expect((await getOrchestration(orchestration.id))?.failureReason).toBeNull();
    // The blocked fragment is untouched — the decision still lives on it.
    expect((await getFragment(blocked.id))?.status).toBe('BLOCKED');

    // Exactly one item each, and every one claimable.
    const items = (await listWorkItems(project.id, { limit: 100 })).filter(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_FRAGMENT',
    );
    expect(items).toHaveLength(3);
    for (const fragment of independent) {
      const mine = items.filter((item) => item.fragmentId === fragment.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.state).toBe('QUEUED');
    }
  });

  it('does not mint a second time when called again', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { fragmentKey: 'exhausted', fragmentIndex: 0, status: 'BLOCKED' });
    await makeFragment(orchestration, { fragmentKey: 'alpha', fragmentIndex: 1, status: 'QUEUED' });
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: 'A fragment exhausted its evidence paths.',
    });

    await advancePacket(orchestration.id);
    const second = await advancePacket(orchestration.id);

    // Idempotent by construction: alreadyCreated and stillRunning are
    // unchanged, so lifting the early return cannot duplicate work.
    expect(second.enqueued).toHaveLength(0);
    const items = (await listWorkItems(project.id, { limit: 100 })).filter(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_FRAGMENT',
    );
    expect(items).toHaveLength(1);
  });

  it('leaves a genuinely finished packet alone', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { fragmentKey: 'alpha', fragmentIndex: 0, status: 'QUEUED' });
    for (const status of ['COMPLETE', 'CANCELLED', 'FAILED'] as const) {
      await updateOrchestration(orchestration.id, { status });
      const result = await advancePacket(orchestration.id);
      expect(result.enqueued).toHaveLength(0);
      expect(result.waitingOn).toContain(status);
    }
  });

  it('keeps the reason a person is being asked for across a boot sweep', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { fragmentKey: 'exhausted', fragmentIndex: 0, status: 'BLOCKED' });
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: 'A fragment exhausted its evidence paths.',
    });
    // Something for resumePulledPackets to recognise as worker-driven.
    await enqueueWork({
      projectId: project.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'marker' },
      requiredScopes: [],
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
    });

    await resumePulledPackets();

    // Nothing could move, so the question stands. What must not happen is the
    // reason being blanked on sight, which is what clearing unconditionally in
    // the boot sweep would do — a person would be asked to decide something the
    // screen no longer states.
    //
    // Being *re-derived* is fine and better: the advance re-evaluated the
    // packet and wrote a reason that is current, rather than preserving one
    // written earlier. The invariant is that the packet still stops for a
    // person and still says why, not that the sentence is unchanged.
    const after = await getOrchestration(orchestration.id);
    expect(after?.status).toBe('NEEDS_HUMAN');
    expect((after?.failureReason ?? '').length).toBeGreaterThan(0);
  });
});

describe('one fragment faulting', () => {
  /**
   * The defect two worker sessions in a row reported, and the reason neither
   * was ever offered a verification job.
   *
   * `faultedOut` set the whole orchestration to NEEDS_HUMAN and returned,
   * aborting the rest of the advance — and `advancePacket` short-circuits on
   * NEEDS_HUMAN, so every later call did nothing at all. On the live packet one
   * fragment's verification had died. Four others were sitting VALIDATING with
   * real research on them and could never be handed a verification, because the
   * loop that mints them returned at the dead one before reaching any of them.
   *
   * From a worker's side that looks like a queue that only ever offers work
   * which is already done.
   */
  it('does not stop the packet, and the healthy fragments still get verified', async () => {
    const orchestration = await makeOrchestration();
    const dead = await makeFragment(orchestration, { fragmentKey: 'dead', fragmentIndex: 0 });
    const healthy = await makeFragment(orchestration, { fragmentKey: 'healthy', fragmentIndex: 1 });

    // Both researched. Both VALIDATING.
    for (const fragment of [dead, healthy]) {
      const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
      await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
      await call('brain_complete_work', { ...proof(research), summary: 'claims in' });
    }

    // The dead one's verification finishes without recording — written straight
    // through the repository, as a database from before the boundary refused it
    // would hold.
    const items = await listWorkItems(project.id, { limit: 100 });
    const deadVerify = items.find(
      (item) => item.workType === 'RESEARCH_VERIFY' && item.fragmentId === dead.id,
    );
    expect(deadVerify).toBeDefined();
    const [claimed] = await claimWork({
      workerId,
      scopes: [{ projectId: project.id, scopes: FULL }],
      workTypes: ['RESEARCH_VERIFY'],
    });
    const held = claimed!.workItemId === deadVerify!.id ? claimed! : null;
    if (!held) throw new Error('expected to claim the dead verification first');
    await completeWork(
      {
        workItemId: held.workItemId,
        leaseId: held.leaseId,
        leaseGeneration: held.leaseGeneration,
        workerId,
      },
      { summary: 'out of budget' },
    );

    await advancePacket(orchestration.id);

    expect((await getFragment(dead.id))?.status).toBe('BLOCKED');
    // And the healthy fragment has a verification waiting for a worker, which
    // is the whole point.
    const after = await listWorkItems(project.id, { limit: 100 });
    const healthyVerify = after.filter(
      (item) =>
        item.workType === 'RESEARCH_VERIFY' &&
        item.fragmentId === healthy.id &&
        (item.state === 'QUEUED' || item.state === 'LEASED'),
    );
    expect(healthyVerify).toHaveLength(1);
    expect((await getOrchestration(orchestration.id))?.status).not.toBe('NEEDS_HUMAN');
  });
});

describe('work its fragment has outgrown', () => {
  /**
   * The cause behind the duplicate a worker was handed on the live packet, and
   * it needed no second work item at all.
   *
   * A worker submits a fragment's claims — the fragment moves to VALIDATING —
   * and then releases the item instead of completing it, which is exactly what
   * the contract tells it to do when its allowance runs out. The item goes back
   * to QUEUED and stays claimable: a research assignment for a fragment that
   * has already been researched. Nothing was stale about it when it was made
   * and nothing removed it afterwards, so the queue kept offering it.
   */
  it('cancels a queued research item whose fragment has already submitted', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    expect((await getFragment(fragment.id))?.status).toBe('VALIDATING');

    // Out of allowance: hand it back rather than complete it.
    await releaseWork(
      {
        workItemId: research.workItemId,
        leaseId: research.leaseId,
        leaseGeneration: research.leaseGeneration,
        workerId,
      },
      'out of allowance',
    );
    expect((await getWorkItem(research.workItemId))?.state).toBe('QUEUED');

    await advancePacket(orchestration.id);

    const item = await getWorkItem(research.workItemId);
    expect(item?.state).toBe('CANCELLED');
    // And so nothing claimable is left that would re-research it.
    const [claimed] = await claimWork({
      workerId,
      scopes: [{ projectId: project.id, scopes: FULL }],
      workTypes: ['RESEARCH_FRAGMENT'],
    });
    expect(claimed).toBeUndefined();
  });

  it('leaves an item a worker is holding alone', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    // Claims in, fragment VALIDATING, and the worker still holds the lease —
    // which is the ordinary case, because it submitted a moment ago and is
    // about to complete. Cancelling here would fail that completion.
    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });

    await advancePacket(orchestration.id);

    expect((await getWorkItem(research.workItemId))?.state).toBe('LEASED');
    const value = await call('brain_complete_work', { ...proof(research), summary: 'claims in' });
    expect(value['state']).not.toBe('CONFLICT');
  });
});

describe('a fragment that has already been researched', () => {
  /**
   * Step 6 keys this effect from the work item, so the same item re-submitting
   * replays. A *second* item for the same fragment is a different scope and had
   * no protection at all — it would append a second ledger to a fragment the
   * gate had already been asked about.
   *
   * A worker on the live packet was handed exactly that: a research item for a
   * fragment already VALIDATING with twelve claims on it. Nothing refused it.
   * The worker noticed and released, which is the right instinct and is not a
   * control.
   */
  it('refuses a second submission from a different work item', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const first = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(first), claims: [SOURCED] });
    expect((await getFragment(fragment.id))?.status).toBe('VALIDATING');

    // A second item for the same fragment, however it came to exist.
    const second = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    const refused = await refusal('brain_submit_claims', {
      ...proof(second),
      claims: [{ ...SOURCED, claim: 'A second ledger for one fragment.' }],
    });

    expect(refused.category).toBe('CONFLICT');
    expect(refused.message).toContain('VALIDATING');
    // The ledger is untouched: one claim, from the item that was asked.
    expect(await listClaimsForFragment(fragment.id)).toHaveLength(1);
  });

  it('still replays a redelivery of the same item, which is not a second ledger', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });

    // The same item, asked again — the crash-window case Step 6 exists for.
    // It must not be caught by the refusal above, which is about a different
    // item, and it must not record anything twice.
    const again = await call('brain_submit_claims', {
      ...proof(research),
      claims: [SOURCED],
    });
    expect(again['state']).toBe('ALREADY_RECORDED');
    expect(await listClaimsForFragment(fragment.id)).toHaveLength(1);
  });
});

describe('the gate', () => {
  it('accepts a claim its source supports, in scope', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const value = await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });

    expect(value['integrity']).toBe('PASS');
    expect(value['acceptedClaims']).toBe(1);
    expect((await getFragment(fragment.id))?.status).toBe('ACCEPTED');
    expect((await listClaimsForFragment(fragment.id))[0]!.accepted).toBe(true);
    expect(await acceptedClaims(orchestration.id)).toHaveLength(1);
  });

  it('never accepts a claim the source does not support, whatever the worker said', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const value = await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [
        { claim_id: stored!.id, supports_claim: false, ...MATCHES, note: 'The section is about something else.' },
      ],
      // The worker calls it sufficient. The gate does not have to agree, and
      // the whole design rests on it not having to.
      sufficiency: 'SUFFICIENT',
    });

    expect(value['acceptedClaims']).toBe(0);
    expect(value['integrity']).toBe('FAIL');
    expect((await getFragment(fragment.id))?.status).toBe('BLOCKED');
    // The reported count and the stored flag are different facts, and the
    // stored one is what the synthesis reads. Asserting only the number let a
    // deliberately broken gate pass this test once.
    expect((await listClaimsForFragment(fragment.id))[0]!.accepted).toBe(false);
    expect(await acceptedClaims(orchestration.id)).toHaveLength(0);
  });

  it('rejects a claim whose scope does not match the fragment it answers', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const value = await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [
        {
          claim_id: stored!.id,
          supports_claim: true,
          ...MATCHES,
          geography: 'MISMATCH',
          note: 'This is the Nevada provision.',
        },
      ],
      sufficiency: 'SUFFICIENT',
    });

    expect(value['acceptedClaims']).toBe(0);
    expect(value['failedConditions']).toContain('SCOPE_MATCH');
    expect((await listClaimsForFragment(fragment.id))[0]!.accepted).toBe(false);
    expect(await acceptedClaims(orchestration.id)).toHaveLength(0);
  });

  it('refuses a verification that leaves some of the fragment\'s claims unanswered', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', {
      ...proof(research),
      claims: [SOURCED, { ...SOURCED, claim: 'And a second one.' }],
    });
    const stored = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const refused = await refusal('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored[0]!.id, supports_claim: true, ...MATCHES, note: 'ok' }],
      sufficiency: 'SUFFICIENT',
    });

    // Choosing which of your own claims get examined is not a choice a worker
    // should have.
    expect(refused.category).toBe('INVALID_INPUT');
    expect(refused.message).toContain('no verdict');
    expect((await getFragment(fragment.id))?.status).toBe('VALIDATING');
  });

  it('refuses a verdict about a claim that is not on this fragment', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const refused = await refusal('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: 'clm_elsewhere', supports_claim: true, ...MATCHES, note: 'ok' }],
      sufficiency: 'SUFFICIENT',
    });
    expect(refused.category).toBe('INVALID_INPUT');
  });

  it('keeps a rejection reason so a claim cannot return through a later attempt', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: false, ...MATCHES, note: 'Does not say that.' }],
      sufficiency: 'INSUFFICIENT',
    });

    const after = (await listClaimsForFragment(fragment.id))[0]!;
    expect(after.accepted).toBe(false);
    expect(after.rejectionReason).toBeTruthy();
    // And it is not in the packet's accepted evidence, which is what the
    // synthesis reads.
    expect(await acceptedClaims(orchestration.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

describe('the synthesis', () => {
  it('refuses a report citing a claim that was never accepted', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'ok' }],
      sufficiency: 'SUFFICIENT',
    });

    const synth = await claimFor(orchestration, 'RESEARCH_SYNTHESIZE', null);
    const refused = await refusal('brain_submit_synthesis', {
      ...proof(synth),
      report: 'California requires a licence [clm_invented].',
      cited_claim_ids: [stored!.id, 'clm_invented'],
    });

    // The whole report, not just that sentence. A packet whose citations are
    // approximately right is worse than none, because the reader cannot tell
    // which sentences are the approximate ones.
    expect(refused.category).toBe('INVALID_INPUT');
    expect((await getOrchestration(orchestration.id))?.documentId).toBeNull();
  });

  it('refuses to file anything when no claim cleared the gate', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: false, ...MATCHES, note: 'no' }],
      sufficiency: 'INSUFFICIENT',
    });

    const synth = await claimFor(orchestration, 'RESEARCH_SYNTHESIZE', null);
    const refused = await refusal('brain_submit_synthesis', {
      ...proof(synth),
      report: 'Here is what we found.',
      cited_claim_ids: [stored!.id],
    });
    expect(refused.category).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

describe('the packet runner', () => {
  it('asks for a plan first, and only once', async () => {
    const orchestration = await makeOrchestration();

    const first = await advancePacket(orchestration.id);
    expect(first.enqueued.map((entry) => entry.workType)).toEqual(['RESEARCH_PLAN']);

    // Called again — a second completion, a boot sweep — and it creates
    // nothing, because it checks the queue rather than remembering.
    const second = await advancePacket(orchestration.id);
    expect(second.enqueued).toHaveLength(0);
    expect(second.waitingOn).toBe('the plan');
  });

  it('will not start researching a plan nobody approved', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { status: 'PLANNED' });

    const result = await advancePacket(orchestration.id);
    expect(result.enqueued).toHaveLength(0);
    expect(result.waitingOn).toContain('approve');

    // Nothing queued means nothing spent. That is the whole gate.
    const items = await listWorkItems(project.id, { states: ['QUEUED'] });
    expect(items.filter((item) => item.workType === 'RESEARCH_FRAGMENT')).toHaveLength(0);
  });

  it('queues one job per fragment once a person approves', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { status: 'PLANNED' });

    const approved = await approvePlan({
      orchestrationId: orchestration.id,
      approvedByUserId: 'usr_someone',
    });
    expect(approved.enqueued.map((entry) => entry.workType)).toEqual(['RESEARCH_FRAGMENT']);
    expect((await currentFragments(orchestration.id))[0]?.status).toBe('QUEUED');
  });

  it('holds a fragment back until the fragment it depends on is accepted', async () => {
    const orchestration = await makeOrchestration();
    await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        fragmentIndex: 0,
        fragmentKey: 'definitions',
        question: 'What counts as a business sale here?',
        requiredEvidence: ['statute'],
        acceptableSourceTypes: [],
        excludedSourceTypes: [],
        completionCriteria: ['A definition'],
        dependsOn: [],
        minIndependentSources: 1,
        status: 'QUEUED',
      },
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        fragmentIndex: 1,
        fragmentKey: 'licence-california',
        question: 'Does California require a licence?',
        requiredEvidence: ['statute'],
        acceptableSourceTypes: [],
        excludedSourceTypes: [],
        completionCriteria: ['A section'],
        dependsOn: ['definitions'],
        minIndependentSources: 1,
        status: 'QUEUED',
      },
    ]);

    const result = await advancePacket(orchestration.id);
    // The boundary fragment only. Researching the second one first would mean
    // answering it against a definition nobody had established.
    expect(result.enqueued.map((entry) => entry.fragmentKey)).toEqual(['definitions']);
  });

  it('resumes from rows after a restart, not from anything remembered', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    // The state a crash between a completion and the enqueue that should have
    // followed it leaves behind: claims are in, nothing is queued.
    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED', lease_id = NULL,
      worker_id = NULL, lease_expires_at = NULL WHERE id = ?`, [research.workItemId]);

    const resumed = await resumePulledPackets();
    expect(resumed).toBe(1);

    const queued = await listWorkItems(project.id, { states: ['QUEUED'] });
    expect(queued.map((item) => item.workType)).toContain('RESEARCH_VERIFY');
  });

  it('never creates a second item for work that already has one', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    // A worker that claimed the research item and completed it without ever
    // calling brain_submit_claims. The fragment never left QUEUED.
    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await getDb().run(
      `UPDATE work_items SET state = 'SUCCEEDED', lease_id = NULL, worker_id = NULL,
        lease_expires_at = NULL WHERE id = ?`,
      [research.workItemId],
    );

    const result = await advancePacket(orchestration.id);

    // The loop is the lesser problem. A second work item has a different id,
    // and Step 6 keys a research effect from the work item — so two items for
    // one fragment are two idempotency scopes, and the second could record a
    // second claim ledger. One item per target, for the life of the packet.
    const research_items = (await listWorkItems(project.id, {})).filter(
      (item) => item.workType === 'RESEARCH_FRAGMENT' && item.fragmentId === fragment.id,
    );
    expect(research_items).toHaveLength(1);
    expect(result.enqueued).toHaveLength(0);
    // The fragment is blocked; the packet is not. A fault belongs to the
    // fragment it happened to — stopping the packet froze every healthy
    // fragment beside it, because advancePacket short-circuits on NEEDS_HUMAN.
    expect((await getFragment(fragment.id))?.status).toBe('BLOCKED');
    expect(result.status).not.toBe('NEEDS_HUMAN');
  });

  it('stops rather than re-planning when a plan job produced no fragments', async () => {
    const orchestration = await makeOrchestration();
    await advancePacket(orchestration.id);

    const [planItem] = await listWorkItems(project.id, {});
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED' WHERE id = ?`, [planItem!.id]);

    const result = await advancePacket(orchestration.id);
    expect(result.enqueued).toHaveLength(0);
    expect(result.status).toBe('NEEDS_HUMAN');
  });

  it('stops for a person when no fragment cleared its gate', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: false, ...MATCHES, note: 'no' }],
      sufficiency: 'INSUFFICIENT',
    });

    const result = await advancePacket(orchestration.id);
    // Not a retry. A packet where nothing cleared the gate is a result somebody
    // needs to see, and repair is planned rather than automatic.
    expect(result.status).toBe('NEEDS_HUMAN');
    expect(result.enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Blockers and checkpoints
// ---------------------------------------------------------------------------

describe('reporting a blocker', () => {
  it('records where the worker looked, because a claimed absence needs that', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    await call('brain_report_blocker', {
      ...proof(claimed),
      reason: 'No statute addresses this transaction shape.',
      searched: ['Business and Professions Code', 'DRE guidance letters'],
      suggested_narrowing: 'Ask instead about transactions that include a lease.',
    });

    const after = await getFragment(fragment.id);
    expect(after?.status).toBe('BLOCKED');
    expect(after?.blockedReason).toContain('Business and Professions Code');
    expect(after?.blockedReason).toContain('Suggested narrowing');
  });

  it('refuses a worker without blockers:report', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const refused = await refusal(
      'brain_report_blocker',
      { ...proof(claimed), reason: 'cannot' },
      FULL.filter((scope) => scope !== 'blockers:report'),
    );
    expect(refused.category).toBe('NOT_FOUND');
    expect((await getFragment(fragment.id))?.status).toBe('QUEUED');
  });
});

describe('checkpoints through the tool', () => {
  it('are visible to whoever holds the item next', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    await call('brain_checkpoint_work', {
      ...proof(claimed),
      note: 'Section 10131 read; 10131.6 still to check.',
    });

    const value = await call('brain_get_assignment', { work_item_id: claimed.workItemId });
    const assignment = value['assignment'] as Record<string, unknown>;
    const notes = assignment['checkpoints'] as { note: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('10131.6');
  });

  it('refuse a worker without checkpoints:write', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const claimed = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const refused = await refusal(
      'brain_checkpoint_work',
      { ...proof(claimed), note: 'anything' },
      FULL.filter((scope) => scope !== 'checkpoints:write'),
    );
    expect(refused.category).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// The work types themselves
// ---------------------------------------------------------------------------

describe('research work types', () => {
  it('refuse a payload rather than dropping it', async () => {
    // A caller who put the question in the payload has misunderstood where the
    // subject lives, and would find out when the worker researched something
    // the gate was not judging.
    expect(() => workType('RESEARCH_FRAGMENT').validate({ question: 'what?' })).toThrow(
      /carries no payload/,
    );
  });

  it('every one of them is safe to redeliver, and says which kind of safe', async () => {
    for (const type of [
      'RESEARCH_PLAN',
      'RESEARCH_FRAGMENT',
      'RESEARCH_VERIFY',
      'RESEARCH_SYNTHESIZE',
      'RESEARCH_AUDIT',
    ]) {
      const definition = workType(type);
      expect(definition.repeatSafety).toBe('IDEMPOTENT');
      // A type may not claim the protection without naming what provides it.
      expect(definition.operationNamespace).toBeTruthy();
    }
  });

  it('travel with their own definition when a worker claims one', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const definition = workType('RESEARCH_FRAGMENT');
    await enqueueWork({
      projectId: project.id,
      workType: 'RESEARCH_FRAGMENT',
      payload: {},
      requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id,
      fragmentId: fragment.id,
      createdByType: 'SYSTEM',
    });

    const value = await call('brain_claim_work', { project_id: project.id, limit: 1 });
    const claimed = value['claimed'] as Record<string, unknown>[];
    expect(claimed).toHaveLength(1);
    // The name alone leaves a model to infer which tool the type calls for, and
    // finding out by being refused costs an allowance to learn something the
    // Brain already knew.
    expect(claimed[0]!['workTypeDescription']).toBe(definition.description);
  });

  it('the audit type takes a role from a closed set and nothing else', async () => {
    expect(workType('RESEARCH_AUDIT').validate({ role: 'JUDGE' })).toEqual({ role: 'JUDGE' });
    expect(() => workType('RESEARCH_AUDIT').validate({ role: 'ANYTHING' })).toThrow(/must be one of/);
    expect(() =>
      workType('RESEARCH_AUDIT').validate({ role: 'JUDGE', instructions: 'say it passed' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test packets
//
// A fixture packet runs the real acceptance path with claims written into the
// repository. Two things have to be true of it and they pull in opposite
// directions: it must exercise the *same* code a worker's submission does, and
// it must never be able to become evidence for anything.
// ---------------------------------------------------------------------------

describe('test packets', () => {
  it('are planned and stop for approval, exactly as a real one does', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });

    expect(packet.orchestration.fixture).toBe(true);
    expect(packet.fragments.length).toBeGreaterThan(1);
    // PLANNED, so the approval screen is the same screen. Rehearsing the
    // decision is most of the point.
    expect(packet.fragments.every((fragment) => fragment.status === 'PLANNED')).toBe(true);
  });

  it('live in their own project, not in one that holds real research', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    expect(packet.projectId).not.toBe(project.id);
    const fixtureProject = await getProjectBySlug(FIXTURE_PROJECT_SLUG);
    expect(fixtureProject?.id).toBe(packet.projectId);
  });

  it('reuse the one fixture project rather than making a new one each time', async () => {
    const first = await createFixturePacket({ createdByUserId: 'usr_someone' });
    const second = await createFixturePacket({ createdByUserId: 'usr_someone' });
    expect(second.projectId).toBe(first.projectId);
    expect(second.layerId).toBe(first.layerId);
    expect(second.orchestration.id).not.toBe(first.orchestration.id);
  });

  it('show all three gate outcomes when approved', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });

    const fragments = await currentFragments(packet.orchestration.id);
    const accepted = fragments.filter((fragment) => fragment.status === 'ACCEPTED');
    const blocked = fragments.filter((fragment) => fragment.status === 'BLOCKED');

    // The point of the fixture: a fragment that passes, and one that does not.
    // A fixture where everything passed would teach an operator nothing about
    // what refusal looks like.
    expect(accepted.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('reject the unsourced claim and keep it, rather than dropping it', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });

    const fragments = await currentFragments(packet.orchestration.id);
    const target = fragments.find((fragment) => fragment.fragmentKey === 'client-registration')!;
    const claims = await listClaimsForFragment(target.id);

    const unsourced = claims.find((row) => !row.sourced);
    expect(unsourced).toBeDefined();
    expect(unsourced!.accepted).toBe(false);
    expect(unsourced!.validationState).toBe('NO_URL');
    // And it is still there. A ledger that hid it would look better than the
    // research was.
    expect(claims.length).toBeGreaterThan(1);
  });

  it('file a document whose first line says what it is', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });

    const after = await getOrchestration(packet.orchestration.id);
    expect(after?.documentId).toBeTruthy();
    // Before anything that could be read as a finding.
    expect(after?.reportText?.startsWith(FIXTURE_BANNER)).toBe(true);
  });

  it('stop before the audit, and say why on the row', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });

    const after = await getOrchestration(packet.orchestration.id);
    // Never COMPLETE, and never carrying a verdict. A fixture that recorded an
    // audit would be a verdict nobody reached, which is the one thing this must
    // not do.
    expect(after?.status).toBe('NEEDS_HUMAN');
    expect(after?.auditId).toBeNull();
    expect(after?.verdict).toBeNull();
    expect(after?.failureReason).toContain('audit');
  });

  it('report what they did, because "nothing was queued" reads as a failure', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    const result = await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });

    // A fixture queues nothing *because the work is already done*, and saying
    // only that would describe the success exactly as it describes a failure.
    expect(result.enqueued).toHaveLength(0);
    expect(result.ran).toBeDefined();
    expect(result.ran!.acceptedFragments).toBeGreaterThan(0);
    expect(result.ran!.blockedFragments).toBeGreaterThan(0);
    expect(result.ran!.rejectedClaims).toBeGreaterThan(0);
    expect(result.ran!.canonicalName).toBeTruthy();
  });

  it('say nothing was waiting when a plan has already been approved', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });

    // The second press. Distinguishable from the first, which is the whole
    // point — the operator saw this message and could not tell which it was.
    const again = await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });
    expect(again.ran).toBeUndefined();
    expect(again.waitingOn).toBe('nothing is awaiting approval');
  });

  it('file a document whose markdown actually renders', async () => {
    const packet = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({
      orchestrationId: packet.orchestration.id,
      approvedByUserId: 'usr_someone',
    });
    const after = await getOrchestration(packet.orchestration.id);
    const document = await getDocument(after!.documentId!);
    const body = (await readObject(document!.storageKey!)).toString('utf8');

    // Every heading needs a blank line before it or markdown renders it as part
    // of whatever is above. The builder used to strip every empty string in the
    // document to remove two conditional entries, which took the deliberate
    // spacers with them — invisible until somebody read a filed packet.
    for (const heading of ['## Evidence ledger', '## What this packet does not settle']) {
      expect(body).toContain(`\n\n${heading}\n\n`);
    }
    // And exactly one of each heading. Two sections of the same name is what
    // you get when two places both think they own it.
    expect(body.split('## What this packet does not settle').length - 1).toBe(1);

    // The ledger resolves: every cited id appears with a URL under it.
    expect(body).toContain('https://www.rfc-editor.org/rfc/rfc9728.html');
    expect(body).toContain('  - Passage: "');
  });

  it('can be run more than once, each filing its own version', async () => {
    // Not hypothetical: the first fixture packet an operator ran filed a
    // document with a formatting defect, and the only way to get a clean one is
    // to run a second. A document is never overwritten, so the second has to
    // land as its own version rather than colliding with the first.
    const first = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({ orchestrationId: first.orchestration.id, approvedByUserId: 'usr_someone' });
    const firstDoc = await getDocument((await getOrchestration(first.orchestration.id))!.documentId!);

    const second = await createFixturePacket({ createdByUserId: 'usr_someone' });
    await approvePlan({ orchestrationId: second.orchestration.id, approvedByUserId: 'usr_someone' });
    const secondDoc = await getDocument((await getOrchestration(second.orchestration.id))!.documentId!);

    expect(secondDoc).toBeTruthy();
    expect(secondDoc!.id).not.toBe(firstDoc!.id);
    expect(secondDoc!.canonicalName).not.toBe(firstDoc!.canonicalName);
    // The first one is still there. Superseded documents keep their rows and
    // their files; they are the layer's provenance.
    expect(await getDocument(firstDoc!.id)).toBeTruthy();
  });

  it('is not treated as a dead in-process run when the server restarts', async () => {
    // The bug this pins cost nothing only because it was found before the
    // first real packet was approved. Boot recovery assumed every pending
    // orchestration was a push-model run whose process had died, so on every
    // deploy it marked worker-driven packets INTERRUPTED, abandoned their
    // passes, and — worst — moved fragments a worker still held a lease on
    // back to QUEUED. A requeued fragment gets a second work item, which is a
    // second Step 6 idempotency scope, which is a second claim ledger for one
    // fragment.
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration, { status: 'RUNNING' });
    await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);

    const recovered = await recoverInterruptedResearch();

    expect(recovered).toBe(0);
    expect((await getOrchestration(orchestration.id))?.status).not.toBe('INTERRUPTED');
    // The one that matters: a fragment a worker is holding stays held.
    expect((await getFragment(fragment.id))?.status).toBe('RUNNING');
  });

  it('still closes a push-model run whose process did die', async () => {
    // The other half. Guarding on the provider must not turn the recovery off
    // for the runs it was written for.
    const run = await createRun({
      projectId: project.id,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'RUNNING',
      provider: 'mock',
    });
    const pushed = await createOrchestration({
      projectId: project.id,
      layerId: layer.id,
      runId: run.id,
      title: 'An in-process run',
      assignment: 'Started by a process that is no longer here.',
      provider: 'mock',
    });
    await updateOrchestration(pushed.id, { status: 'RESEARCHING' });

    expect(await recoverInterruptedResearch()).toBe(1);
    expect((await getOrchestration(pushed.id))?.status).toBe('INTERRUPTED');
  });

  it('clears a failure the packet has already moved past', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { status: 'PLANNED' });
    await claimFor(orchestration, 'RESEARCH_PLAN', null);
    await updateOrchestration(orchestration.id, {
      status: 'PLANNING',
      failureReason: 'Interrupted while planning. 0 pass(es) were in flight.',
    });

    await resumePulledPackets();

    // A live status and a failure reason cannot both be true, and the console
    // showed the stale one for a plan that was sitting there intact.
    expect((await getOrchestration(orchestration.id))?.failureReason).toBeNull();
  });

  it('refuses to complete a verification that recorded nothing', async () => {
    // What actually killed the first real packet. A worker's budget ran out
    // mid-verification and it completed the lease instead of releasing it. The
    // runner then saw a finished verification that moved nothing, correctly
    // stopped for a person, and the only documented remedy — re-plan — throws
    // away the accepted research already inside the packet.
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    await call('brain_complete_work', { ...proof(research), summary: 'claims in' });

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    const refused = await refusal('brain_complete_work', { ...proof(verify), summary: 'out of budget' });

    expect(refused.category).toBe('CONFLICT');
    // The remedy is in the message, because the worker can act on it.
    expect(refused.message).toContain('brain_release_work');
    expect((await getWorkItem(verify.workItemId))?.state).toBe('LEASED');
  });

  it('lets the same item be completed once it has recorded something', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    await call('brain_complete_work', { ...proof(research), summary: 'claims in' });

    const verify = await claimFor(orchestration, 'RESEARCH_VERIFY', fragment);
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'gated' });

    expect((await getWorkItem(verify.workItemId))?.state).toBe('SUCCEEDED');
  });

  it('refuse to run the fixture claims against a packet that is not a fixture', async () => {
    // The guard that matters most in the file. This path supplies its own
    // claims, so pointing it at real research would write fixture content into
    // somebody's work.
    const real = await makeOrchestration();
    await expect(runFixturePacket(real.id)).rejects.toThrow(/not a fixture/);
    expect(await listClaims(real.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The audit, which nothing here had ever driven
// ---------------------------------------------------------------------------

/**
 * The last three passes of a worker-driven packet.
 *
 * Everything above stops at the filed report. The three audit roles were built,
 * registered, serialised through the same judge validator the in-process path
 * uses — and never once run from end to end, which meant "the judge decides"
 * was a claim about code nobody had executed in this order.
 *
 * The roles are deliberately not symmetric. Primary and adversarial record what
 * they found and move nothing; only the judge's validated structured output may
 * reach `recordAudit`. So the tests that matter are the ones where the judge
 * says something it is not allowed to say.
 */
describe('the audit passes', () => {
  /**
   * Take a packet all the way to a filed document, ready to be audited.
   *
   * Each stage is *completed* rather than abandoned, because completion is what
   * makes the runner enqueue the next one. Enqueueing the audit items by hand
   * would test the tools and skip the thing most likely to be wrong — whether
   * the state machine gets there on its own.
   */
  async function filedPacket(): Promise<ResearchOrchestration> {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    await call('brain_complete_work', { ...proof(research), summary: 'claims in' });

    const verify = await claimNext('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'verified' });

    const synth = await claimNext('RESEARCH_SYNTHESIZE');
    await call('brain_submit_synthesis', {
      ...proof(synth),
      report: `California defines a real estate broker at section 10131 [${stored!.id}].`,
      cited_claim_ids: [stored!.id],
    });
    await call('brain_complete_work', { ...proof(synth), summary: 'filed' });

    return (await getOrchestration(orchestration.id))!;
  }

  /** Claim whatever the runner queued next, rather than queueing it ourselves. */
  async function claimNext(type: string): Promise<ClaimedWork> {
    const [claimed] = await claimWork({
      workerId,
      scopes: [{ projectId: project.id, scopes: FULL }],
      workTypes: [type],
    });
    if (!claimed) throw new Error(`the runner queued no ${type}`);
    return claimed;
  }

  const PRIMARY = {
    assignment_satisfied: 'PARTIAL',
    requirement_findings: ['One state of five is answered.'],
    structural_findings: [],
    boundary_findings: [],
    consistency_findings: [],
    candidate_gaps: [
      {
        classification: 'TARGETED_RESEARCH_GAP',
        title: 'The other four states',
        detail: 'Texas, Florida, New York and Illinois are unanswered.',
        research_question: 'Does each of TX, FL, NY and IL require a licence for a success fee?',
      },
    ],
    notes: 'The one answered state is answered from its own statute.',
  };

  const ADVERSARIAL = {
    attacks: [
      {
        attack: 'One statute section is being read as settling a question about compensation.',
        assessment: 'VALID',
        reasoning: 'The definition of a broker is not by itself the compensation rule.',
      },
    ],
    strongest_reason_not_to_advance: 'Four of the five states in the assignment have no evidence at all.',
  };

  function judge(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      verdict: 'MORE_RESEARCH',
      summary: 'One state answered, four open.',
      next_action: 'Research the remaining four states.',
      gap_classifications: [
        {
          classification: 'TARGETED_RESEARCH_GAP',
          title: 'The other four states',
          detail: 'No evidence was gathered for them.',
          research_question: 'Does each of TX, FL, NY and IL require a licence?',
        },
      ],
      foundational_gap_count: 0,
      targeted_research_runs_required: 1,
      synthesis_ready: false,
      freeze_ready: false,
      confidence: 0.6,
      ...over,
    };
  }

  it('records the primary and adversarial passes without moving anything', async () => {
    const orchestration = await filedPacket();

    const primary = await claimNext('RESEARCH_AUDIT');
    const first = await call('brain_submit_audit', { ...proof(primary), primary: PRIMARY });
    expect(first['role']).toBe('PRIMARY');
    await call('brain_complete_work', { ...proof(primary), summary: 'primary in' });

    const adversarial = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(adversarial), adversarial: ADVERSARIAL });
    await call('brain_complete_work', { ...proof(adversarial), summary: 'adversarial in' });

    // Two of the three roles have run and nothing has been decided. That is
    // the whole point of the separation: an opinion is not a verdict.
    const after = await getOrchestration(orchestration.id);
    expect(after?.status).not.toBe('COMPLETE');
    expect(await listAuditsByProject(orchestration.projectId)).toHaveLength(0);
  });

  it('refuses a role\'s findings submitted against another role\'s item', async () => {
    const orchestration = await filedPacket();
    const primary = await claimNext('RESEARCH_AUDIT');

    // The adversarial body against the primary item. The work item says which
    // role this is; the payload does not get to say otherwise.
    const refused = await refusal('brain_submit_audit', {
      ...proof(primary),
      adversarial: ADVERSARIAL,
    });
    expect(refused.category).toBe('INVALID_INPUT');
  });

  it('records the judge\'s verdict, and only the judge\'s', async () => {
    const orchestration = await filedPacket();

    const primary = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(primary), primary: PRIMARY });
    await call('brain_complete_work', { ...proof(primary), summary: 'primary in' });
    const adversarial = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(adversarial), adversarial: ADVERSARIAL });
    await call('brain_complete_work', { ...proof(adversarial), summary: 'adversarial in' });

    const judgeItem = await claimNext('RESEARCH_AUDIT');
    const value = await call('brain_submit_audit', { ...proof(judgeItem), judge: judge() });

    expect(value['role']).toBe('JUDGE');
    expect(value['verdict']).toBe('MORE_RESEARCH');

    const audits = await listAuditsByProject(orchestration.projectId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.verdict).toBe('MORE_RESEARCH');
    // The structured record, not prose. Invariant 11.
    expect(audits[0]!.gaps.length).toBeGreaterThan(0);
  });

  it('refuses an advancing verdict while a foundational gap is open', async () => {
    const orchestration = await filedPacket();
    const primary = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(primary), primary: PRIMARY });
    await call('brain_complete_work', { ...proof(primary), summary: 'primary in' });
    const adversarial = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(adversarial), adversarial: ADVERSARIAL });
    await call('brain_complete_work', { ...proof(adversarial), summary: 'adversarial in' });

    const judgeItem = await claimNext('RESEARCH_AUDIT');
    const refused = await refusal('brain_submit_audit', {
      ...proof(judgeItem),
      judge: judge({
        verdict: 'READY_FOR_SYNTHESIS',
        gap_classifications: [
          {
            classification: 'FOUNDATIONAL_GAP',
            title: 'Nothing establishes what compensation triggers the rule',
            detail: 'The packet never reaches the compensation question.',
          },
        ],
        foundational_gap_count: 1,
        synthesis_ready: true,
      }),
    });

    // The one thing a judge must never be able to do: advance a layer over a
    // gap it has itself called foundational.
    expect(refused.category).toBe('INVALID_INPUT');
    expect(await listAuditsByProject(orchestration.projectId)).toHaveLength(0);
  });

  it('refuses a judgement whose counts disagree with the gaps it classified', async () => {
    const orchestration = await filedPacket();
    const primary = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(primary), primary: PRIMARY });
    await call('brain_complete_work', { ...proof(primary), summary: 'primary in' });
    const adversarial = await claimNext('RESEARCH_AUDIT');
    await call('brain_submit_audit', { ...proof(adversarial), adversarial: ADVERSARIAL });
    await call('brain_complete_work', { ...proof(adversarial), summary: 'adversarial in' });

    const judgeItem = await claimNext('RESEARCH_AUDIT');
    const refused = await refusal('brain_submit_audit', {
      ...proof(judgeItem),
      // Says zero foundational gaps while classifying one. The counts are
      // recomputed rather than believed.
      judge: judge({
        gap_classifications: [
          {
            classification: 'FOUNDATIONAL_GAP',
            title: 'A gap it called foundational',
            detail: 'And then did not count.',
          },
        ],
        foundational_gap_count: 0,
      }),
    });
    expect(refused.category).toBe('INVALID_INPUT');
    expect(await listAuditsByProject(orchestration.projectId)).toHaveLength(0);
  });

  it('declares an adversarial schema its own validator accepts', async () => {
    // The narrow guard for a defect that was invisible for exactly as long as
    // nobody drove this path: the tool advertised `material: boolean` while
    // `parseAdversarialPass` required `assessment`, so a worker following the
    // published schema was refused every time — and the refusal named a field
    // the schema never mentioned. The adversarial pass is the middle of three,
    // so no worker-driven packet could ever reach a judge.
    //
    // The end-to-end tests above would catch this again, but only while their
    // fixtures happen to be built from the schema. This asserts the contract
    // itself.
    const tool = findTool('brain_submit_audit');
    const schema = tool!.inputSchema as unknown as {
      properties: {
        adversarial: { properties: { attacks: { items: { required: string[] } } } };
      };
    };
    const required = schema.properties.adversarial.properties.attacks.items.required;
    expect(required).toContain('assessment');
    expect(required).not.toContain('material');

    // And it is the same enum the validator matches exactly, not a lookalike.
    const parsed = parseAdversarialPass(
      JSON.stringify({
        attacks: [{ attack: 'a', assessment: 'NOT_MATERIAL', reasoning: 'b' }],
        strongest_reason_not_to_advance: 'c',
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('runs the three roles strictly in order, one at a time', async () => {
    const orchestration = await filedPacket();

    // The runner enqueues PRIMARY and nothing else, and will not enqueue the
    // next role until this one has produced a completed pass. Three opinions
    // in parallel is a different and much weaker thing than one argument.
    const queued = await listWorkItems(project.id, { limit: 100 });
    const audits = queued.filter(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_AUDIT',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload['role']).toBe('PRIMARY');
  });
});

// ---------------------------------------------------------------------------
// Handing work back
// ---------------------------------------------------------------------------

describe('releasing an item', () => {
  /**
   * The worker contract says releasing costs the packet nothing, and until now
   * that was false on the last attempt: `releaseWork` failed the item with
   * ATTEMPTS_EXHAUSTED when the budget was spent.
   *
   * It killed the first real packet's Texas verification. The worker ran out of
   * allowance on the item's second claim, checkpointed, released — the exact
   * sequence the contract prescribes — and the queue terminated the item on the
   * way out, leaving nine claims ungated and ten fragments queued behind them.
   *
   * `maxAttempts: 1` so the first claim already spends the budget. That is the
   * situation the old code failed the item in, and it is not exotic: research
   * items are registered with two.
   */
  async function claimOnly(maxAttempts: number): Promise<ClaimedWork> {
    await enqueueWork({
      projectId: project.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'release accounting' },
      requiredScopes: [],
      maxAttempts,
      createdByType: 'SYSTEM',
    });
    const [claimed] = await claimWork({
      workerId,
      scopes: [{ projectId: project.id, scopes: FULL }],
      workTypes: ['SYNTHETIC_ECHO'],
    });
    if (!claimed) throw new Error('nothing claimable');
    return claimed;
  }

  function ownership(claimed: ClaimedWork) {
    return {
      workItemId: claimed.workItemId,
      leaseId: claimed.leaseId,
      leaseGeneration: claimed.leaseGeneration,
      workerId,
    };
  }

  it('hands the attempt back rather than using the item up', async () => {
    const claimed = await claimOnly(1);
    expect((await getWorkItem(claimed.workItemId))?.attemptCount).toBe(1);

    const released = await releaseWork(ownership(claimed), 'out of allowance');
    expect(released.ok).toBe(true);

    const after = await getWorkItem(claimed.workItemId);
    expect(after?.state).toBe('QUEUED');
    expect(after?.attemptCount).toBe(0);
  });

  it('never terminates the item, however many times it is handed back', async () => {
    const first = await claimOnly(1);
    const id = first.workItemId;

    let held: ClaimedWork = first;
    for (let round = 0; round < 3; round += 1) {
      const released = await releaseWork(ownership(held), `round ${round}`);
      expect(released.ok).toBe(true);

      const item = await getWorkItem(id);
      // Never FAILED, never ATTEMPTS_EXHAUSTED. An expiry and a failure still
      // count against the budget; a clean hand-back is not an attempt.
      expect(item?.state).toBe('QUEUED');
      expect(item?.failureCategory).toBeNull();

      const [again] = await claimWork({
        workerId,
        scopes: [{ projectId: project.id, scopes: FULL }],
        workTypes: ['SYNTHETIC_ECHO'],
      });
      expect(again?.workItemId).toBe(id);
      held = again!;
    }
  });
});

// ---------------------------------------------------------------------------
// A packet that cannot move
// ---------------------------------------------------------------------------

describe('a fragment waiting on one that failed', () => {
  /**
   * `readyToResearch` waits for a dependency to be accepted and says plainly
   * that a BLOCKED one never will. What happened next was nothing: the waiting
   * fragment is not terminal, so the runner counted it as "still in progress"
   * and returned that forever. The packet could reach neither synthesis nor a
   * person, and reported progress it was not making.
   */
  it('stops the packet rather than reporting progress forever', async () => {
    const orchestration = await makeOrchestration();
    const trigger = await makeFragment(orchestration, {
      fragmentKey: 'trigger',
      fragmentIndex: 0,
      status: 'BLOCKED',
    });
    const dependent = await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      dependsOn: ['trigger'],
      status: 'QUEUED',
    });

    const result = await advancePacket(orchestration.id);

    expect(result.status).toBe('NEEDS_HUMAN');
    expect(result.enqueued).toHaveLength(0);
    const stopped = await getOrchestration(orchestration.id);
    // Named, so the operator knows which dependency to repair rather than
    // being told the packet is stuck.
    expect(stopped?.failureReason).toContain('penalty');
    expect(stopped?.failureReason).toContain('trigger');
    expect(trigger.status).toBe('BLOCKED');
    expect((await getFragment(dependent.id))?.status).toBe('QUEUED');
  });

  it('is transitive — a fragment two hops behind a failure is stuck too', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { fragmentKey: 'boundary', fragmentIndex: 0, status: 'BLOCKED' });
    await makeFragment(orchestration, {
      fragmentKey: 'trigger',
      fragmentIndex: 1,
      dependsOn: ['boundary'],
      status: 'QUEUED',
    });
    await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 2,
      dependsOn: ['trigger'],
      status: 'QUEUED',
    });

    const result = await advancePacket(orchestration.id);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect((await getOrchestration(orchestration.id))?.failureReason).toContain('penalty');
  });

  it('keeps waiting while anything else can still move', async () => {
    const orchestration = await makeOrchestration();
    await makeFragment(orchestration, { fragmentKey: 'trigger', fragmentIndex: 0, status: 'BLOCKED' });
    await makeFragment(orchestration, {
      fragmentKey: 'penalty',
      fragmentIndex: 1,
      dependsOn: ['trigger'],
      status: 'QUEUED',
    });
    // Independent of the failure, and researchable. One stuck fragment is not
    // a stuck packet.
    await makeFragment(orchestration, {
      fragmentKey: 'standalone',
      fragmentIndex: 2,
      dependsOn: [],
      status: 'QUEUED',
    });

    const result = await advancePacket(orchestration.id);
    expect(result.status).not.toBe('NEEDS_HUMAN');
    expect(result.enqueued.map((entry) => entry.fragmentKey)).toContain('standalone');
  });
});

// ---------------------------------------------------------------------------
// What may be synthesized
// ---------------------------------------------------------------------------

describe('the packet check before synthesis', () => {
  /**
   * Invariant 20: no synthesis over a packet that does not cover the goal's
   * mandatory part.
   *
   * `assessPacket` has enforced that since Step 3 — from `orchestrator.ts`, and
   * from nowhere else. The worker path enqueued the synthesis job straight off
   * the accepted fragments, so a packet missing a mandatory requirement got
   * written up anyway. That is the third time a rule lived on one path and not
   * the other, after the archive coverage check and the dependency cycles.
   */
  it('refuses to queue a synthesis while a mandatory requirement has no evidence', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    await createRequirements([
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        requirementKey: 'unanswered',
        ordinal: 0,
        statement: 'Whether Texas requires a licence for the same transaction.',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
    ]);

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    await call('brain_complete_work', { ...proof(research), summary: 'claims in' });

    const verify = await claimNextOf('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'verified' });

    // The fragment cleared its gate and its claim was accepted. That is not the
    // same question as whether the packet answers the goal.
    expect((await getFragment(fragment.id))?.status).toBe('ACCEPTED');

    const items = await listWorkItems(project.id, { limit: 100 });
    const synthesis = items.filter(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_SYNTHESIZE',
    );
    expect(synthesis).toHaveLength(0);

    const stopped = await getOrchestration(orchestration.id);
    expect(stopped?.status).toBe('NEEDS_HUMAN');
    expect(stopped?.failureReason).toContain('Texas');
  });

  /**
   * The case the previous version of this test did not cover, and the deployed
   * harness did.
   *
   * It asserted that synthesis is queued when every mandatory requirement is
   * answered — against a fixture with no requirements at all, so it passed
   * vacuously while the real path was blocked. A requirement researched and
   * accepted still reads MISSING in the coverage table, because those rows
   * record what the archive settled at planning time and nothing rewrites them
   * afterwards. So the check refused a packet whose only fragment had cleared
   * its gate.
   */
  it('queues it when the requirement was answered by research rather than the archive', async () => {
    const orchestration = await makeOrchestration();
    const [requirement] = await createRequirements([
      {
        orchestrationId: orchestration.id,
        projectId: project.id,
        layerId: layer.id,
        requirementKey: 'answered-by-research',
        ordinal: 0,
        statement: 'Whether California requires a licence for the transaction.',
        necessity: 'MANDATORY',
        kind: 'RESEARCH',
      },
    ]);
    const fragment = await makeFragment(orchestration, {
      requirementIds: [requirement!.id],
    });

    const research = await claimFor(orchestration, 'RESEARCH_FRAGMENT', fragment);
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    const [stored] = await listClaimsForFragment(fragment.id);
    await call('brain_complete_work', { ...proof(research), summary: 'claims in' });

    const verify = await claimNextOf('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: stored!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'verified' });

    const items = await listWorkItems(project.id, { limit: 100 });
    expect(
      items.filter(
        (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_SYNTHESIZE',
      ),
    ).toHaveLength(1);
  });
});

/** Claim whatever the runner queued next, rather than queueing it ourselves. */
async function claimNextOf(type: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId,
    scopes: [{ projectId: project.id, scopes: FULL }],
    workTypes: [type],
  });
  if (!claimed) throw new Error(`nothing claimable of type ${type}`);
  return claimed;
}
