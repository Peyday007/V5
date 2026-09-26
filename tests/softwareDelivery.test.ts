/**
 * A change asked for in a conversation, followed back to that conversation.
 *
 * Three defects this pins, each one a place the journey stopped:
 *
 * 1. **Authorize in Russell could never start a campaign.** The card sent no
 *    acceptance conditions and the factory — correctly — refuses to approve a
 *    contract with none. So the entrance produced a card whose one button always
 *    failed. The request now carries conditions from the moment it is written.
 * 2. **Nothing came back after the pull request.** No merge was observed, no
 *    deployment, no behaviour; the conversation said "complete" about work a
 *    person still had to release by hand and then find out about elsewhere.
 * 3. **Nothing was said in the conversation at all** — every update was a
 *    projection somebody had to be looking at. Milestones now write a message,
 *    exactly once, and a crashed tick's unsaid message is finished later.
 *
 * The forge, the process's revision and its own origin are injected, because
 * those are the outside world; the rows, the campaign, the contract, the
 * authorization and the conversation are real. This is a fixture proof of the
 * mechanism and says nothing about a live forge or a live deploy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { getCampaign, patchCampaign } from '../server/repos/factory.ts';
import { getChangeRequest } from '../server/repos/factory.ts';
import { onboardRepository } from '../server/services/factory/onboard.ts';
import {
  authorizeSoftwareRequest,
  captureSoftwareChange,
  conditionsFor,
  softwareForConversation,
} from '../server/services/russell/software.ts';
import {
  finishOrphanedMessages,
  followSoftwareRequest,
  refuseSoftwareRelease,
  runLiveCheck,
  type DeliveryDeps,
} from '../server/services/russell/softwareDelivery.ts';
import {
  getSoftwareRequest,
  listDeliveryMilestones,
  listFollowedSoftwareRequests,
  recordDeliveryMilestone,
} from '../server/repos/russellSoftware.ts';
import { validateProposal } from '../server/services/russell/proposal.ts';
import type { Principal, User } from '../server/domain/types.ts';
import type { ForgeChecks, ForgeComparison, ForgePullRequest, ForgeReply } from '../server/services/factory/forge.ts';

let fixture: TestProject;
let actor: User;
let realFetch: typeof globalThis.fetch;

function stubForge(): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/git\/ref\/heads\//.test(url)) return json({ ref: 'refs/heads/production', object: { sha: 'c'.repeat(40) } });
    if (/\/contents\//.test(url)) {
      return json({
        content: Buffer.from(JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8').toString('base64'),
        encoding: 'base64',
      });
    }
    if (url.includes('/pulls?')) return json([]);
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ default_branch: 'production' });
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  fixture = await freshProject();
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  stubForge();
  actor = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  await teardown();
});

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const LATER = 'd'.repeat(40);

function ok<T>(body: T): ForgeReply<T> {
  return { ok: true, status: 200, body, reason: null, authenticated: false };
}

/** The outside world, scripted: a pull request, the forge's compare, checks, a revision, a page. */
function world(over: {
  pr?: Partial<ForgePullRequest>;
  revision?: string | null;
  relation?: string;
  checks?: Partial<ForgeChecks>;
  page?: string;
  calls?: string[];
  /** Minutes from now the forge is asked at; each reading of the clock is later. */
  at?: number;
} = {}): DeliveryDeps {
  const calls = over.calls ?? [];
  return {
    async readPullRequest(_repo, number) {
      calls.push(`pull:${number}`);
      return ok({
        number,
        state: 'open',
        headSha: HEAD,
        headRef: 'factory/campaign/x',
        baseRef: 'production',
        merged: false,
        url: `https://github.com/Peyday007/V5/pull/${number}`,
        title: 'The change',
        updatedAt: '2026-09-23T00:00:00Z',
        mergeCommitSha: null,
        ...over.pr,
      });
    },
    async compareCommits(_repo, base, head): Promise<ForgeReply<ForgeComparison>> {
      calls.push(`compare:${base.slice(0, 4)}..${head.slice(0, 4)}`);
      return ok({
        baseSha: base,
        headSha: head,
        aheadBy: 1,
        files: ['client/src/russell/Conversation.tsx'],
        fileStats: [{ path: 'client/src/russell/Conversation.tsx', status: 'modified', additions: 3, deletions: 1 }],
        truncated: false,
        status: over.relation ?? 'ahead',
      });
    },
    async readChecks(_repo, sha) {
      calls.push(`checks:${sha.slice(0, 4)}`);
      return ok({
        sha,
        checks: [{ name: 'Postgres suite', status: 'completed', conclusion: 'success' }],
        none: false,
        pending: false,
        failed: [],
        ...over.checks,
      });
    },
    revision: () => (over.revision === undefined ? null : over.revision),
    async fetchSelf(path) {
      calls.push(`self:${path}`);
      if (path === '/') {
        return { status: 200, contentType: 'text/html', body: '<script src="/assets/index-abc.js"></script>' };
      }
      return { status: 200, contentType: 'text/javascript', body: over.page ?? 'nothing here' };
    },
    now: () => new Date(Date.now() + (over.at ?? 0) * 60_000),
  };
}

async function askedAndAuthorized(input: { grantId: string; liveCheck?: { path: string; contains: string } }) {
  await onboardRepository({
    projectId: fixture.project.id,
    grantId: input.grantId,
    scope: { kind: 'WHOLE_REPOSITORY' },
    actor,
    origin: 'https://brain.example',
  });
  const conversation = await createConversation({
    ownerUserId: actor.id,
    title: 'Brain',
    visibility: 'SHARED',
    projectId: fixture.project.id,
  });
  const captured = await captureSoftwareChange({
    projectId: fixture.project.id,
    conversationId: conversation.id,
    messageId: null,
    askedText: 'Please change the conversation card so it names the project.',
    title: 'Name the project on the card',
    objective: 'Change the conversation card so it names the project the change is for.',
    expectedOutcome: 'The card says which project a change belongs to.',
    liveCheck: input.liveCheck ?? null,
  });
  if (!captured.request) throw new Error(`nothing captured: ${captured.reason}`);
  // The card sends the proposal it shows — nothing typed, only the click.
  const authorized = await authorizeSoftwareRequest({
    requestId: captured.request.id,
    grantId: input.grantId,
    userId: actor.id,
    acceptanceConditions: captured.request.acceptanceConditions,
  });
  if (!authorized.ok) throw new Error(`not authorized: ${authorized.reason}`);
  return { conversationId: conversation.id, requestId: captured.request.id, campaignId: authorized.campaignId };
}

async function systemMessages(conversationId: string): Promise<string[]> {
  return (await listTurns(conversationId, 200)).filter((t) => t.role === 'SYSTEM').map((t) => t.content ?? '');
}

async function reread(requestId: string) {
  const request = await getSoftwareRequest(requestId);
  if (!request) throw new Error('request vanished');
  return request;
}

describe('what "done" means travels with the request', () => {
  it('derives a condition from the expected outcome when the worker proposed none', () => {
    const derived = conditionsFor([], 'The card names the project.');
    expect(derived).toHaveLength(1);
    expect(derived[0]?.statement).toBe('The card names the project.');
    expect(derived[0]?.verification.length).toBeGreaterThan(4);
  });

  it('keeps what the worker proposed, and validates it before a card exists', () => {
    const person = { type: 'PERSON', id: 'u', isBrainAdmin: true, scopes: [] } as unknown as Principal;
    const accepted = validateProposal({
      raw: {
        action: 'REQUEST_SOFTWARE_CHANGE',
        answer: 'Written down for you to authorize.',
        software: {
          title: 'Name the project',
          objective: 'Change the card so that it names the project.',
          expectedOutcome: 'The card names the project.',
          acceptanceConditions: [{ statement: 'The card shows the project name.', verification: 'Open a thread.' }],
          liveCheck: { path: '/', contains: 'Changes to' },
        },
      },
      principal: person,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.proposal.software?.acceptanceConditions).toHaveLength(1);
      expect(accepted.proposal.software?.liveCheck).toEqual({ path: '/', contains: 'Changes to' });
    }
  });

  it.each([
    ['a host', 'https://evil.example/'],
    ['a protocol-relative host', '//evil.example/x'],
    ['a climb', '/assets/../../etc/passwd'],
  ])('refuses the whole proposal when the live check names %s', (_what, path) => {
    const person = { type: 'PERSON', id: 'u', isBrainAdmin: true, scopes: [] } as unknown as Principal;
    const refused = validateProposal({
      raw: {
        action: 'REQUEST_SOFTWARE_CHANGE',
        answer: 'x',
        software: {
          title: 'Name the project',
          objective: 'Change the card so that it names the project.',
          expectedOutcome: 'The card names the project.',
          liveCheck: { path, contains: 'text' },
        },
      },
      principal: person,
    });
    expect(refused.ok).toBe(false);
  });

  it('authorizes and starts a campaign with nothing typed but the click, and the contract holds what the card showed', async () => {
    const { requestId, campaignId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    const request = await reread(requestId);
    expect(request.state).toBe('AUTHORIZED');
    expect(request.acceptanceConditions).toHaveLength(1);
    const campaign = await getCampaign(campaignId);
    expect(campaign?.state).not.toBe('CANCELLED');
    // The contract holds exactly what the card showed and the person sent.
    const contract = await getChangeRequest(request.changeRequestId!);
    expect(contract?.acceptanceConditions.map((c) => c.statement)).toEqual(
      request.acceptanceConditions.map((c) => c.statement),
    );
  });

  it('still refuses to invent conditions when none are sent', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: 'brain-worker-bootstrap',
      scope: { kind: 'WHOLE_REPOSITORY' },
      actor,
      origin: 'https://brain.example',
    });
    const conversation = await createConversation({
      ownerUserId: actor.id,
      title: 'Brain',
      visibility: 'SHARED',
      projectId: fixture.project.id,
    });
    const captured = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: conversation.id,
      messageId: null,
      askedText: 'Please change the conversation card so it names the project.',
      title: 'Name the project on the card',
      objective: 'Change the conversation card so it names the project the change is for.',
      expectedOutcome: 'The card says which project a change belongs to.',
    });
    const refused = await authorizeSoftwareRequest({
      requestId: captured.request!.id,
      grantId: 'brain-worker-bootstrap',
      userId: actor.id,
    });
    expect(refused.ok).toBe(false);
  });
});

describe('a change followed back to its conversation', () => {
  it('says each stage once, however many ticks read it', async () => {
    const { conversationId, requestId, campaignId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    await patchCampaign(campaignId, { state: 'EXECUTING' });
    const deps = world();
    await followSoftwareRequest(await reread(requestId), deps);
    await followSoftwareRequest(await reread(requestId), deps);
    const said = await systemMessages(conversationId);
    expect(said.filter((m) => m.startsWith('Authorized.'))).toHaveLength(1);
    expect(said.filter((m) => m.startsWith('Implementing'))).toHaveLength(1);
  });

  it('names a blocker and its remedy, and says so again when work resumes', async () => {
    const { conversationId, requestId, campaignId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    await patchCampaign(campaignId, { state: 'EXECUTING' });
    await followSoftwareRequest(await reread(requestId), world());
    await patchCampaign(campaignId, {
      state: 'BLOCKED',
      blockerKind: 'NO_HEALTHY_EXECUTION_SURFACE',
      blockerDetail: 'no surface can push to this repository',
    });
    await followSoftwareRequest(await reread(requestId), world());
    await patchCampaign(campaignId, { state: 'EXECUTING', blockerKind: null, blockerDetail: null });
    await followSoftwareRequest(await reread(requestId), world());
    const said = await systemMessages(conversationId);
    expect(said.some((m) => m.startsWith('Blocked: no surface can push'))).toBe(true);
    expect(said.filter((m) => m.startsWith('Implementing'))).toHaveLength(2);
  });

  it('puts the release decision in the thread with exactly what would be released', async () => {
    const { conversationId, requestId, campaignId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    await patchCampaign(campaignId, {
      state: 'COMPLETE',
      prUrl: 'https://github.com/Peyday007/brain-worker-bootstrap/pull/7',
      prRef: '7',
      integrationSha: HEAD,
    });
    await followSoftwareRequest(await reread(requestId), world());
    const [view] = await softwareForConversation(conversationId);
    expect(view?.delivery?.phase).toBe('AWAITING_RELEASE');
    expect(view?.awaitingPerson).toBe(true);
    const release = view?.delivery?.release as Record<string, unknown>;
    expect(release['headIsIntegration']).toBe(true);
    expect(release['files']).toEqual([
      { path: 'client/src/russell/Conversation.tsx', status: 'modified', additions: 3, deletions: 1 },
    ]);
    expect((await systemMessages(conversationId)).some((m) => m.startsWith('Ready for your release decision'))).toBe(true);
  });

  it('records a refusal as a person, says so, and stops following', async () => {
    const { conversationId, requestId, campaignId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    const early = await refuseSoftwareRelease({ requestId, userId: actor.id, reason: 'too early' });
    expect(early.ok).toBe(false);
    await patchCampaign(campaignId, { state: 'COMPLETE', prUrl: 'https://github.com/x/y/pull/7', prRef: '7', integrationSha: HEAD });
    await followSoftwareRequest(await reread(requestId), world());
    const refused = await refuseSoftwareRelease({ requestId, userId: actor.id, reason: 'Not now.' });
    expect(refused.ok).toBe(true);
    expect((await refuseSoftwareRelease({ requestId, userId: actor.id, reason: 'again' })).ok).toBe(false);
    const milestones = await listDeliveryMilestones(requestId);
    const refusal = milestones.find((m) => m.kind === 'RELEASE_REFUSED');
    expect(refusal?.actorType).toBe('PERSON');
    expect(refusal?.actorId).toBe(actor.id);
    expect((await listFollowedSoftwareRequests(50)).map((r) => r.id)).not.toContain(requestId);
    expect((await systemMessages(conversationId)).some((m) => m.startsWith('You refused this release'))).toBe(true);
  });

  it('reports a merge elsewhere as a merge, and claims nothing about its deployment', async () => {
    const { conversationId, requestId, campaignId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    await patchCampaign(campaignId, { state: 'COMPLETE', prUrl: 'https://github.com/x/y/pull/7', prRef: '7', integrationSha: HEAD });
    await followSoftwareRequest(await reread(requestId), world());
    await followSoftwareRequest(
      await reread(requestId),
      world({ pr: { merged: true, state: 'closed', mergeCommitSha: MERGE }, at: 10 }),
    );
    const kinds = (await listDeliveryMilestones(requestId)).map((m) => m.kind);
    expect(kinds).toContain('MERGED');
    expect(kinds).toContain('DEPLOY_UNOBSERVABLE');
    expect(kinds).not.toContain('DEPLOYED');
    const [view] = await softwareForConversation(conversationId);
    expect(view?.delivery?.phase).toBe('DEPLOY_UNOBSERVABLE');
  });

  it('confirms a release of this Brain only when its own revision contains the merge, then checks it live', async () => {
    const { conversationId, requestId, campaignId } = await askedAndAuthorized({
      grantId: 'brain',
      liveCheck: { path: '/', contains: 'Changes to Brain' },
    });
    await patchCampaign(campaignId, { state: 'COMPLETE', prUrl: 'https://github.com/Peyday007/V5/pull/40', prRef: '40', integrationSha: HEAD });
    await followSoftwareRequest(await reread(requestId), world());
    const merged = { merged: true, state: 'closed', mergeCommitSha: MERGE };

    // The process that saw the merge was built before it: nothing is claimed.
    const calls: string[] = [];
    await followSoftwareRequest(await reread(requestId), world({ pr: merged, revision: 'e'.repeat(40), relation: 'behind', calls, at: 10 }));
    let kinds = (await listDeliveryMilestones(requestId)).map((m) => m.kind);
    expect(kinds).toContain('MERGED');
    expect(kinds).not.toContain('DEPLOYED');
    // …and the same process does not ask the forge again about the same revision.
    const again: string[] = [];
    await followSoftwareRequest(await reread(requestId), world({ pr: merged, revision: 'e'.repeat(40), relation: 'behind', calls: again, at: 20 }));
    expect(again.filter((c) => c.startsWith('compare'))).toHaveLength(0);
    expect(again.filter((c) => c.startsWith('pull'))).toHaveLength(0);

    // A new process, built after the merge, whose page carries the change.
    await followSoftwareRequest(
      await reread(requestId),
      world({ pr: merged, revision: LATER, relation: 'ahead', page: 'function x(){return "Changes to Brain"}', at: 30 }),
    );
    kinds = (await listDeliveryMilestones(requestId)).map((m) => m.kind);
    expect(kinds).toContain('DEPLOYED');
    expect(kinds).toContain('LIVE_VERIFIED');
    const [view] = await softwareForConversation(conversationId);
    expect(view?.delivery?.phase).toBe('LIVE_VERIFIED');
    expect(view?.line).toMatch(/verified working in production/);
    const said = await systemMessages(conversationId);
    expect(said.some((m) => m.startsWith('Released: production is serving dddddddddddd'))).toBe(true);
    expect(said.some((m) => m.startsWith('Verified live: / on production'))).toBe(true);
    expect((await listFollowedSoftwareRequests(50)).map((r) => r.id)).not.toContain(requestId);
  });

  it('says plainly when the live check does not pass', async () => {
    const result = await runLiveCheck('/', 'Changes to Brain', world({ page: 'Changes to your sites' }));
    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/not in the page or the 1 same-origin asset/);
  });

  it('finishes a message a crashed tick left unsaid, once', async () => {
    const { conversationId, requestId } = await askedAndAuthorized({ grantId: 'brain-worker-bootstrap' });
    // The crash window: the milestone is recorded, the message is not.
    await recordDeliveryMilestone({
      requestId,
      conversationId,
      milestoneKey: 'STAGE:EXECUTING:0:0',
      kind: 'STAGE',
      detail: { message: 'Implementing: a worker is writing the code.' },
    });
    // Not immediately — the caller that inserted it may still be writing it.
    expect(await finishOrphanedMessages(20, new Date())).toBe(0);
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await finishOrphanedMessages(20, later)).toBe(1);
    expect(await finishOrphanedMessages(20, later)).toBe(0);
    const said = await systemMessages(conversationId);
    expect(said.filter((m) => m.startsWith('Implementing'))).toHaveLength(1);
  });
});
