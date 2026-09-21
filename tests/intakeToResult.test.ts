/**
 * One conversation, walked from the outside all the way to a reviewable
 * artifact, and back out through the same door it came in.
 *
 * ---------------------------------------------------------------------------
 * Why this is a walk rather than a suite
 * ---------------------------------------------------------------------------
 *
 * §24 records what walking the journey found that isolated tests could not:
 * five transitions that existed, were tested, and could be reached by nothing.
 * §30 says the same thing one section along, and §33 found four more. Every one
 * of them was invisible to a test that arranged its own starting state, because
 * a test that arranges its own starting state cannot tell a mechanism from a
 * function nothing calls.
 *
 * So this starts where a person actually starts — a transcript arriving from
 * somewhere else — and never writes a row the product would not have written.
 *
 * ---------------------------------------------------------------------------
 * What is simulated, said precisely rather than nearly
 * ---------------------------------------------------------------------------
 *
 * **The worker's answer**, and nothing else. The deployed Brain has no provider
 * and may not buy one, so a Russell turn is a bin a fleet worker answers; here
 * that answer is a scripted proposal handed to `applyTurn`, which puts it
 * through `validateProposal`'s closed action set, the capture gate, and
 * `softwareTarget`'s refusal to guess a project — exactly as a real one would.
 *
 * **And the campaign's execution.** Driving real Claude workers takes minutes
 * and is proved elsewhere: `factoryUnblock` and a recorded production run cover
 * that plane. What this asserts about the campaign is the part a person sees —
 * that authorizing produced one, that it is the one the register points at, and
 * that its pull request comes back out through the bridge.
 *
 * Everything between is the real tick, the real gate, the real authorization
 * and the real repositories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import type { Principal } from '../server/domain/types.ts';
import { syncConversation } from '../server/services/bridge/sync.ts';
import { statusFor } from '../server/services/bridge/status.ts';
import { applyTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { putBinUnitResult } from '../server/repos/bins.ts';
import { listSoftwareRequestsForConversation } from '../server/repos/russellSoftware.ts';
import { authorizeSoftwareRequest, repositoryChoicesFor } from '../server/services/russell/software.ts';
import { onboardRepository } from '../server/services/factory/onboard.ts';
import { getUser } from '../server/repos/identity.ts';
import { getCampaign, getChangeRequest, listAmendments, patchCampaign } from '../server/repos/factory.ts';
import { createWorkstream, linkWorkstream, listLinks } from '../server/repos/register.ts';
import { assembleRegister } from '../server/services/register/view.ts';

let fixture: TestProject;
let userId = '';
let realFetch: typeof globalThis.fetch;

/**
 * The forge, answered locally.
 *
 * Brain holds no credential for any repository and reads the forge over HTTP
 * (§27), so a walk that talked to github.com would be asserting somebody else's
 * uptime. The three answers `deriveFromForge` actually needs are scripted here
 * — the repository, its default branch, and the commit that branch points at —
 * and every other request is refused rather than invented, so a call this walk
 * did not anticipate fails loudly instead of quietly succeeding.
 */
const PINNED_SHA = 'b'.repeat(40);

function forge(url: string): Response | null {
  if (!url.startsWith('https://api.github.com/')) return null;
  const path = url.slice('https://api.github.com'.length);
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
    return json({ default_branch: 'main', full_name: 'Peyday007/brain-worker-bootstrap' });
  }
  if (/\/git\/ref\/heads\//.test(path) || /\/commits\/main/.test(path)) {
    return json({ object: { sha: PINNED_SHA, type: 'commit' }, sha: PINNED_SHA });
  }
  if (/\/contents\//.test(path)) {
    // No package.json to read, so the contract derives no verification command
    // from the repository. That is an honest absence rather than a stub.
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }
  if (/\/pulls/.test(path)) return json([]);
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
}

function person(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: true,
    mustChangePassword: false,
    credentialId: 'bcr_chatgpt',
    // The credential a conversation client presents. Everything downstream sees
    // an ordinary person, which is the whole design.
    authMethod: 'BRIDGE_BEARER',
    memberships: [
      {
        id: 'mem',
        projectId: fixture.project.id,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'ADMIN',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      },
    ],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  fixture = await freshProject();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
    const answered = forge(String(input));
    if (answered) return answered;
    return await realFetch(input as RequestInfo, init as RequestInit);
  }) as typeof globalThis.fetch;
  const user = await createUser({
    email: `journey-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await teardown();
});

/**
 * The bin a Russell turn opened, answered the way a fleet worker answers it.
 *
 * The proposal goes through `applyTurn`, so `validateProposal`, the capture
 * gate and `softwareTarget` all run. Nothing here reaches around them.
 */
async function answerTurnWith(binId: string, proposal: Record<string, unknown>): Promise<void> {
  await putBinUnitResult({
    binId,
    unitKey: TURN_UNIT_KEY,
    value: JSON.stringify(proposal),
    contentHash: `h${Math.random().toString(36).slice(2, 10)}`,
    leaseId: null,
    leaseGeneration: null,
    submittedBy: 'wkr_test',
  });
  await applyTurn(binId);
}

describe('a conversation held somewhere else, all the way to a reviewable artifact', () => {
  it('arrives, is understood, becomes a change a person authorizes, and comes back out', async () => {
    /* ------------------------------------------------------------------ */
    /* 1. It arrives.                                                      */
    /* ------------------------------------------------------------------ */
    const synced = await syncConversation({
      principal: person(),
      source: 'CHATGPT',
      externalId: 'chatgpt-thread-7',
      title: 'The Deal Dispatch export',
      messages: [
        {
          ordinal: 0,
          role: 'USER',
          content:
            'The Deal Dispatch export drops the last row every time. Please fix the export so it writes every row.',
        },
        { ordinal: 1, role: 'ASSISTANT', content: 'That is usually an off-by-one in the loop bound.' },
      ],
      interpret: true,
    });

    // Stored exactly, ordered, and with nothing missing.
    expect(synced.receipt.accepted).toBe(2);
    expect(synced.receipt.missing).toEqual([]);
    // Brain resolved which project this is about from its own records.
    expect(synced.receipt.routing.projectId).toBe(fixture.project.id);
    expect(synced.receipt.routing.outcome).toBe('TURN_OPENED');
    const binId = synced.receipt.routing.binId;
    expect(binId).toBeTruthy();

    /* ------------------------------------------------------------------ */
    /* 2. A worker reads the thread and proposes. Brain decides.           */
    /* ------------------------------------------------------------------ */
    await answerTurnWith(binId!, {
      action: 'REQUEST_SOFTWARE_CHANGE',
      answer: 'I have written that down for you to authorize.',
      software: {
        title: 'Export writes every row',
        objective: 'Change the Deal Dispatch export so the last row is written rather than dropped.',
        expectedOutcome: 'An export of n records contains n rows.',
      },
    });

    const requests = await listSoftwareRequestsForConversation(
      synced.conversation.russellConversationId,
    );
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    // A capture spends nothing and chooses no repository: which repository a
    // project may change is an authorization in rows a person wrote.
    expect(request.state).toBe('PROPOSED');
    expect(request.repositoryId).toBeNull();
    expect(request.campaignId).toBeNull();

    /* ------------------------------------------------------------------ */
    /* 3. The return path already answers, before anything is authorized.  */
    /* ------------------------------------------------------------------ */
    const waiting = await statusFor(synced.conversation);
    expect(waiting.softwareRequests[0]?.state).toBe('PROPOSED');
    expect(waiting.needsYou.join(' ')).toContain('Authorize the software change');

    /* ------------------------------------------------------------------ */
    /* 4. A person onboards a repository and authorizes it.                */
    /* ------------------------------------------------------------------ */
    const actor = await getUser(userId);
    const onboarded = await onboardRepository({
      projectId: fixture.project.id,
      grantId: 'brain-worker-bootstrap',
      scope: { kind: 'DIRECTORIES', directories: ['src'] },
      actor: actor!,
      origin: 'the acceptance walk',
    });
    expect(onboarded.ok).toBe(true);

    const choices = await repositoryChoicesFor(fixture.project.id);
    expect(choices.length).toBeGreaterThan(0);

    /*
     * The person supplies what success is.
     *
     * A capture carries an objective and an expected outcome and deliberately
     * no acceptance conditions — a model proposing the conditions its own work
     * would be graded against is the factory grading its own exam, which
     * §27 forbids outright. So authorizing refuses without them, by name, and
     * the person answers. That refusal is asserted below rather than assumed.
     */
    const withoutConditions = await authorizeSoftwareRequest({
      requestId: request.id,
      grantId: choices[0]!.grantId,
      userId,
    });
    expect(withoutConditions.ok).toBe(false);
    if (!withoutConditions.ok) {
      expect(withoutConditions.reason).toContain('acceptance conditions');
    }

    const authorized = await authorizeSoftwareRequest({
      requestId: request.id,
      grantId: choices[0]!.grantId,
      userId,
      acceptanceConditions: [
        {
          statement: 'An export of n records contains n rows',
          verification: 'npm test',
          mandatory: true,
        },
      ],
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    const campaignId = authorized.campaignId;
    expect(campaignId).toBeTruthy();
    const campaign = await getCampaign(campaignId);
    expect(campaign).not.toBeNull();
    // One campaign per ask, decided by the database rather than by a check.
    const again = await authorizeSoftwareRequest({
      requestId: request.id,
      grantId: choices[0]!.grantId,
      userId,
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.campaignId).toBe(campaignId);

    /* ------------------------------------------------------------------ */
    /* 5. The register accounts for it, and the state follows the rows.    */
    /* ------------------------------------------------------------------ */
    const before = await assembleRegister({ projectIds: [fixture.project.id] });
    // Brain derived that nothing accounts for this campaign, and composed no
    // intent for it — that is a person's.
    expect(before.unfiled.some((one) => one.ref === campaignId)).toBe(true);

    const workstream = await createWorkstream({
      projectId: fixture.project.id,
      title: 'Export writes every row',
      intent: 'Customers stop chasing a missing line on every export.',
      purpose: 'REVENUE_ENABLING',
      createdByUserId: userId,
    });
    await linkWorkstream({
      workstreamId: workstream.id,
      kind: 'BRIDGE_CONVERSATION',
      ref: synced.conversation.id,
      relation: 'SOURCE',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });
    await linkWorkstream({
      workstreamId: workstream.id,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'PERSON',
      recordedByUserId: userId,
    });

    const filed = await assembleRegister({ projectIds: [fixture.project.id] });
    expect(filed.unfiled.some((one) => one.ref === campaignId)).toBe(false);
    const view = filed.workstreams.find((one) => one.id === workstream.id);
    expect(view?.state).toBe('IN_PROGRESS');
    expect(view?.stateEvidence).toContain('factory_campaigns.state');
    expect(view?.sources).toHaveLength(1);
    expect(filed.answers.pursuingMoney).toContain(workstream.id);

    /* ------------------------------------------------------------------ */
    /* 6. The campaign finishes and opens a pull request.                  */
    /* ------------------------------------------------------------------ */
    await patchCampaign(campaignId, {
      state: 'COMPLETE',
      prRef: '42',
      prUrl: 'https://github.com/Peyday007/brain-worker-bootstrap/pull/42',
    });
    await linkWorkstream({
      workstreamId: workstream.id,
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/brain-worker-bootstrap/pull/42',
      relation: 'EVIDENCE',
      detail: {
        state: 'open',
        attestedBy: `campaign:${campaignId}`,
        attestedAt: new Date().toISOString(),
      },
      recordedBy: 'BRAIN',
    });

    const done = await assembleRegister({ projectIds: [fixture.project.id] });
    const finished = done.workstreams.find((one) => one.id === workstream.id);
    expect(finished?.state).toBe('PR_READY');
    expect(finished?.ownerAction).toContain('merge');

    /* ------------------------------------------------------------------ */
    /* 7. And it is retrievable through the door it came in.               */
    /* ------------------------------------------------------------------ */
    const result = await statusFor(synced.conversation);
    expect(result.softwareRequests[0]?.campaignId).toBe(campaignId);
    expect(result.softwareRequests[0]?.campaignState).toBe('COMPLETE');
    // The pull request itself, reachable from the conversation that asked for
    // the change — which is the whole point of a return path.
    const pr = result.workstreams
      .flatMap((one) => one.readings)
      .find((one) => one.kind === 'PULL_REQUEST');
    expect(pr?.ref).toBe('https://github.com/Peyday007/brain-worker-bootstrap/pull/42');
    expect(pr?.attested?.by).toBe(`campaign:${campaignId}`);
    expect(result.needsYou.join(' ')).toContain('merge');

    // The transcript is still exactly what was said, with the link intact.
    const links = await listLinks(workstream.id);
    expect(links.filter((one) => one.kind === 'BRIDGE_CONVERSATION')).toHaveLength(1);
  });

  it('lets a person who authorized too early try again, with the conditions', async () => {
    /*
     * The defect the walk above found, on its own, because it is the one a
     * person actually hits and it is invisible from either end.
     *
     * `submitObjective` is idempotent by submission key and returns *the same*
     * change request however the derived fields would look now — correct, and
     * it meant that pressing Authorize once without acceptance conditions
     * created a contract with none, and every later attempt collided with that
     * row and was refused in the identical words. The screen named a remedy and
     * applying it did nothing.
     *
     * Asserted as a sequence rather than as a state, because the first call is
     * what creates the condition: a fixture that wrote the empty contract
     * itself would have proved the fixture.
     */
    const synced = await syncConversation({
      principal: person(),
      source: 'CHATGPT',
      externalId: 'chatgpt-thread-8',
      title: 'A second ask',
      messages: [
        {
          ordinal: 0,
          role: 'USER',
          content:
            'Please change the Deal Dispatch importer so a duplicate row is skipped rather than written twice.',
        },
      ],
      interpret: true,
    });
    await answerTurnWith(synced.receipt.routing.binId!, {
      action: 'REQUEST_SOFTWARE_CHANGE',
      answer: 'Written down for you to authorize.',
      software: {
        title: 'Importer skips duplicates',
        objective: 'Change the Deal Dispatch importer so a duplicate row is skipped rather than written twice.',
        expectedOutcome: 'Importing the same file twice leaves one row per record.',
      },
    });
    const request = (
      await listSoftwareRequestsForConversation(synced.conversation.russellConversationId)
    )[0]!;

    const actor = await getUser(userId);
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: 'brain-worker-bootstrap',
      scope: { kind: 'DIRECTORIES', directories: ['src'] },
      actor: actor!,
      origin: 'the acceptance walk',
    });
    const grantId = (await repositoryChoicesFor(fixture.project.id))[0]!.grantId;

    const tooEarly = await authorizeSoftwareRequest({ requestId: request.id, grantId, userId });
    expect(tooEarly.ok).toBe(false);

    const withConditions = await authorizeSoftwareRequest({
      requestId: request.id,
      grantId,
      userId,
      acceptanceConditions: [
        { statement: 'Importing the same file twice leaves one row per record', verification: 'npm test' },
      ],
    });
    expect(withConditions.ok).toBe(true);
    if (!withConditions.ok) return;

    /*
     * And the conditions are on the contract, recorded through the amendment
     * ledger rather than written into the column — so the change is
     * append-only, carries both values and names who made it.
     */
    const contract = await getChangeRequest(withConditions.changeRequestId);
    expect(contract?.acceptanceConditions).toHaveLength(1);
    const ledger = await listAmendments(withConditions.changeRequestId);
    const supplied = ledger.find((one) => one.field === 'acceptance_conditions');
    expect(supplied?.actorType).toBe('PERSON');
    expect(supplied?.actorId).toBe(userId);
  });
});
