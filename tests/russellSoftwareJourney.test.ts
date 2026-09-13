/**
 * Saying what you want changed, and Brain doing it — the journey, and the two
 * boundaries it must not cross.
 *
 * Four things are proved here and each one was a real gap rather than a
 * refinement.
 *
 * 1. **A conversation could not create software work at all.** `PROPOSAL_ACTIONS`
 *    held eight actions and none of them reached the factory, so a person
 *    describing a change to a site got a conversation back and had to know that
 *    a different page existed. The entrance exists now, and the tests that
 *    matter are the ones about what it *cannot* do: a model cannot submit, cannot
 *    choose a repository, and cannot cause anything to be spent.
 *
 * 2. **Discussing a change is not asking for one.** Drawn twice — once
 *    deterministically on the person's own words, once structurally by the fact
 *    that a capture's whole effect is an unauthorized row. Both are exercised,
 *    and the deliberation cases are the ones worth reading: they are where a
 *    permissive gate would put an authorization card in front of somebody who was
 *    thinking out loud.
 *
 * 3. **An optional `mutationScope` defaulting to `['**']` was never a boundary.**
 *    A submission that said nothing got the whole repository, and narrowing
 *    afterwards cannot reach back past an initial scope that was too broad. The
 *    boundary is now declared at onboarding with no default and enforced at
 *    submission — *before* a worker is ever asked to run anything, which is the
 *    difference between refusing a campaign and refusing the bin it already
 *    created.
 *
 * 4. **Both arrangements work, and neither is a prerequisite for the other.**
 *    Separate repositories and two projects sharing one repository with a
 *    directory each are both exercised, on **fixture** repositories the envelope
 *    refuses — because a test's convenience is never a reason to widen a
 *    production authorization, and nothing here needs a grant that the fixture
 *    boundary rows and manifests do not already supply.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  getProjectRepository,
  listProjectRepositories,
  setProjectRepository,
} from '../server/repos/factory.ts';
import {
  MAX_SCOPE_DIRECTORIES,
  ScopeError,
  directoriesOf,
  normaliseDirectory,
  resolveProjectScope,
  scopeFromDeclaration,
  withinBoundary,
} from '../server/services/factory/projectScope.ts';
import { listRepositoryGrants } from '../server/services/factory/repositoryEnvelope.ts';
import { onboardRepository, repositoryOnboarding } from '../server/services/factory/onboard.ts';
import { ContractError, submitObjective } from '../server/services/factory/contract.ts';
import {
  asksForExecution,
  authorizeSoftwareRequest,
  captureSoftwareChange,
  declineSoftware,
  repositoryChoicesFor,
  softwareForConversation,
  softwareNeedingPerson,
} from '../server/services/russell/software.ts';
import {
  getSoftwareRequest,
  listSoftwareRequests,
} from '../server/repos/russellSoftware.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { EXECUTABLE_ACTIONS, PROPOSAL_ACTIONS, validateProposal } from '../server/services/russell/proposal.ts';
import { briefing } from '../server/services/russell/projections.ts';
import type { Principal, User } from '../server/domain/types.ts';

/** The one authorized grant. Used only where a real submission has to happen. */
const MOUNT = () => listRepositoryGrants().find((g) => g.id === 'brain-worker-bootstrap')!;

/**
 * A repository the envelope refuses, on purpose.
 *
 * The routing and boundary properties need no grant: a `worker_routing` row, a
 * `factory_project_repositories` row and a manifest are the whole mechanism, and
 * all three can name a repository the factory may never be pointed at. Proving
 * them against a real one would make a test's convenience into a production
 * authorization, which is the mistake `repositoryEnvelope.ts` records.
 */
const SHARED_FIXTURE = 'fixture-owner/shared-sites';

let fixture: TestProject;
let actor: User;
let person: Principal;
let realFetch: typeof globalThis.fetch;

/** A forge that answers for the one repository a real submission uses. */
function stubForge(): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/git\/ref\/heads\//.test(url)) {
      return json({ ref: 'refs/heads/main', object: { sha: 'c'.repeat(40) } });
    }
    if (/\/contents\//.test(url)) {
      return json({
        content: Buffer.from(JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8').toString('base64'),
        encoding: 'base64',
      });
    }
    if (url.includes('/pulls?')) return json([]);
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ default_branch: 'main' });
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
    displayName: 'An owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  person = { type: 'PERSON', id: actor.id, isBrainAdmin: true, scopes: [] } as unknown as Principal;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  await teardown();
});

async function newConversation(projectId: string | null): Promise<string> {
  const conversation = await createConversation({
    ownerUserId: actor.id,
    title: 'A thread',
    visibility: 'SHARED',
    projectId,
  });
  return conversation.id;
}

/* ========================================================================== */

describe('discussing a change is not asking for one', () => {
  it('reads a direct instruction as a request', () => {
    for (const message of [
      'Please change the checkout page so the total updates without a reload.',
      'Can you fix the header so it stops overlapping the nav on a phone?',
      'Add a contact form to the quote page, please.',
      'Remove the old pricing table from the landing page.',
    ]) {
      expect(asksForExecution(message).asks, message).toBe(true);
    }
  });

  it('reads thinking out loud as thinking out loud', () => {
    /*
     * These all contain an execution verb, which is exactly why they are the
     * cases worth pinning: a gate that only looked for the verb would put an
     * authorization card in front of every one of them.
     */
    for (const message of [
      'I wonder whether we should rewrite the checkout page at some point.',
      'Thinking about whether to add a contact form eventually.',
      'Would it be worth changing how the quote form validates?',
      'What would it take to migrate the site off that framework?',
      'One day we should update the pricing copy.',
    ]) {
      expect(asksForExecution(message).asks, message).toBe(false);
    }
  });

  it('reads a past-tense report as neither', () => {
    expect(asksForExecution('I already fixed the header last week, by the way.').asks).toBe(false);
    expect(asksForExecution('We changed the pricing copy yesterday.').asks).toBe(false);
  });

  it('declines a fragment too short to be a change request', () => {
    expect(asksForExecution('fix it').asks).toBe(false);
  });

  it('captures nothing when the gate refuses, however confident the proposal', async () => {
    const conversationId = await newConversation(fixture.project.id);
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'I wonder whether we should rewrite the checkout page.',
      title: 'Rewrite checkout',
      objective: 'Rewrite the checkout page so it is easier to maintain.',
      expectedOutcome: 'The page is simpler.',
    });
    expect(outcome.request).toBeNull();
    expect(await listSoftwareRequests({ projectId: fixture.project.id })).toHaveLength(0);
  });

  it('captures nothing when the source message cannot be resolved', async () => {
    const conversationId = await newConversation(fixture.project.id);
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: null,
      title: 'Anything',
      objective: 'Change something in the repository so that it is different.',
      expectedOutcome: 'It is different.',
    });
    expect(outcome.reason).toBe('NO_SOURCE_MESSAGE');
    expect(outcome.request).toBeNull();
  });
});

describe('a model may propose a change and may never execute one', () => {
  it('offers the action to a worker, because an advertised action must be real', () => {
    expect(PROPOSAL_ACTIONS).toContain('REQUEST_SOFTWARE_CHANGE');
    expect(EXECUTABLE_ACTIONS as readonly string[]).toContain('REQUEST_SOFTWARE_CHANGE');
  });

  it('refuses the whole proposal when it names a repository', () => {
    /*
     * The one thing a model must not choose. Which repository a project may
     * change is an authorization in rows a person wrote, and an unknown field
     * fails the whole proposal rather than being dropped — so a worker that
     * believed it had picked one never gets half of what it asked for.
     */
    const result = validateProposal({
      raw: {
        action: 'REQUEST_SOFTWARE_CHANGE',
        answer: 'I have written that down for you.',
        repository: 'https://github.com/somebody/else',
        software: {
          title: 'A change',
          objective: 'Change the thing so that it does the other thing.',
          expectedOutcome: 'It does the other thing.',
        },
      },
      principal: person,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_FIELD');
  });

  it('refuses a proposal whose objective could never be submitted', () => {
    const result = validateProposal({
      raw: {
        action: 'REQUEST_SOFTWARE_CHANGE',
        answer: 'Noted.',
        software: { title: 'x', objective: 'too short', expectedOutcome: 'and so is this' },
      },
      principal: person,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIRED_PART');
  });

  it('accepts a well-formed one and carries no repository with it', () => {
    const result = validateProposal({
      raw: {
        action: 'REQUEST_SOFTWARE_CHANGE',
        answer: 'Written down for you to authorize.',
        software: {
          title: 'Live total on checkout',
          objective: 'Change the checkout page so the total updates without a reload.',
          expectedOutcome: 'Changing quantity updates the total in place.',
        },
      },
      principal: person,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.software?.title).toBe('Live total on checkout');
      expect(Object.keys(result.proposal)).not.toContain('repository');
    }
  });

  it('captures a request that spends nothing and has no repository', async () => {
    const conversationId = await newConversation(fixture.project.id);
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'Please change the checkout page so the total updates without a reload.',
      title: 'Live total on checkout',
      objective: 'Change the checkout page so the total updates without a reload.',
      expectedOutcome: 'Changing quantity updates the total in place.',
    });
    expect(outcome.request).not.toBeNull();
    expect(outcome.request?.state).toBe('PROPOSED');
    expect(outcome.request?.grantId).toBeNull();
    expect(outcome.request?.campaignId).toBeNull();
    expect(outcome.request?.changeRequestId).toBeNull();
  });

  it('is one row however many times the same change is asked for', async () => {
    const first = await newConversation(fixture.project.id);
    const second = await newConversation(fixture.project.id);
    const ask = {
      projectId: fixture.project.id,
      messageId: null,
      askedText: 'Please change the checkout page so the total updates without a reload.',
      title: 'Live total on checkout',
      objective: 'Change the checkout page so the total updates without a reload.',
      expectedOutcome: 'Changing quantity updates the total in place.',
    };
    const a = await captureSoftwareChange({ ...ask, conversationId: first });
    const b = await captureSoftwareChange({ ...ask, conversationId: second });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.request?.id).toBe(a.request?.id);
    expect(await listSoftwareRequests({ projectId: fixture.project.id })).toHaveLength(1);
  });
});

/* ========================================================================== */

describe('the boundary is declared, never defaulted', () => {
  it('turns directories into globs and refuses a pattern', () => {
    expect(scopeFromDeclaration({ kind: 'DIRECTORIES', directories: ['sites/v4'] })).toEqual([
      'sites/v4/**',
    ]);
    expect(scopeFromDeclaration({ kind: 'WHOLE_REPOSITORY' })).toEqual(['**']);
    expect(() => normaliseDirectory('sites/*')).toThrow(ScopeError);
    expect(() => normaliseDirectory('../etc')).toThrow(ScopeError);
    expect(() => normaliseDirectory('   ')).toThrow(ScopeError);
  });

  it('refuses an empty directory list rather than treating it as everything', () => {
    /*
     * The failure this whole design is about, in one assertion: saying nothing
     * must not mean the widest possible answer.
     */
    expect(() => scopeFromDeclaration({ kind: 'DIRECTORIES', directories: [] })).toThrow(ScopeError);
  });

  it('refuses more directories than anybody would read', () => {
    const many = Array.from({ length: MAX_SCOPE_DIRECTORIES + 1 }, (_, i) => `dir${i}`);
    expect(() => scopeFromDeclaration({ kind: 'DIRECTORIES', directories: many })).toThrow(ScopeError);
  });

  it('contains what is under it and nothing else', () => {
    const boundary = ['sites/v4/**'];
    expect(withinBoundary(['sites/v4/**'], boundary).ok).toBe(true);
    expect(withinBoundary(['sites/v4/pages/**'], boundary).ok).toBe(true);
    expect(withinBoundary(['sites/v2/**'], boundary).ok).toBe(false);
    // `**` is not under anything, so it is refused by construction rather than
    // by a special case.
    expect(withinBoundary(['**'], boundary).ok).toBe(false);
    expect(withinBoundary(['**'], ['**']).ok).toBe(true);
  });

  it('onboarding refuses without an answer, and records the one it is given', async () => {
    const refused = await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: [] },
      actor,
      origin: 'https://brain.example',
    });
    expect(refused.ok).toBe(false);

    const done = await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    expect(done.ok).toBe(true);
    const row = await getProjectRepository(fixture.project.id, MOUNT().id);
    expect(row?.scopeKind).toBe('DIRECTORIES');
    expect(row?.pathScope).toEqual(['docs/**']);
  });

  it('reports the boundary on the card, and is not READY without one', async () => {
    const before = (await repositoryOnboarding(fixture.project.id)).find(
      (r) => r.grantId === MOUNT().id,
    );
    expect(before?.boundary).toBeNull();
    expect(before?.readiness).toBe('NOT_ONBOARDED');

    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const after = (await repositoryOnboarding(fixture.project.id)).find(
      (r) => r.grantId === MOUNT().id,
    );
    expect(after?.boundary?.directories).toEqual(['docs']);
    expect(after?.boundary?.sentence).toContain('docs/');
  });

  it('rewrites rather than accumulates when a person answers again', async () => {
    for (const directories of [['docs'], ['docs', 'scripts']]) {
      await onboardRepository({
        projectId: fixture.project.id,
        grantId: MOUNT().id,
        scope: { kind: 'DIRECTORIES', directories },
        actor,
        origin: 'https://brain.example',
      });
    }
    const rows = await listProjectRepositories(fixture.project.id);
    expect(rows).toHaveLength(1);
    expect(directoriesOf(rows[0]!.pathScope)).toEqual(['docs', 'scripts']);
  });
});

/* ========================================================================== */

describe('authorization is checked at submission, not only at assignment', () => {
  it('refuses a repository this project was never given', async () => {
    /*
     * The envelope authorizes the *factory* to be pointed at this repository,
     * and that is not the same fact as this project being allowed to change it.
     * Refused here — before a change request, a campaign, a plan or a bin
     * exists — rather than at the moment a worker asks for the work.
     */
    await expect(
      submitObjective({
        projectId: fixture.project.id,
        objective: 'Change the documentation so that it describes the boundary.',
        expectedOutcome: 'The documentation describes the boundary.',
        repositoryRemote: MOUNT().remote,
      }),
    ).rejects.toThrow(/has not been given that repository/i);
  });

  it('uses the boundary as the scope when a submission asks for nothing', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const result = await submitObjective({
      projectId: fixture.project.id,
      objective: 'Change the documentation so that it describes the boundary.',
      expectedOutcome: 'The documentation describes the boundary.',
      repositoryRemote: MOUNT().remote,
    });
    // Not `['**']`, which is what it used to be and is the whole correction.
    expect(result.changeRequest.mutationScope).toEqual(['docs/**']);
    expect(result.derived.mutationScope).toEqual(['docs/**']);
  });

  it('lets a submission narrow inside the boundary', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const result = await submitObjective({
      projectId: fixture.project.id,
      objective: 'Change the workers documentation so that it describes the boundary.',
      expectedOutcome: 'The workers documentation describes the boundary.',
      repositoryRemote: MOUNT().remote,
      mutationScope: ['docs/workers/**'],
    });
    expect(result.changeRequest.mutationScope).toEqual(['docs/workers/**']);
  });

  it('refuses a submission that reaches outside it, naming what was outside', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    let thrown: unknown = null;
    try {
      await submitObjective({
        projectId: fixture.project.id,
        objective: 'Change the server so that it does something different.',
        expectedOutcome: 'The server does something different.',
        repositoryRemote: MOUNT().remote,
        mutationScope: ['server/**'],
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as ContractError).message).toMatch(/server\/\*\*/);
    // And it says why narrowing later would not have fixed it.
    expect((thrown as ContractError).message).toMatch(/narrowing it later/i);
  });

  it('refuses `**` against a directory boundary', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    await expect(
      submitObjective({
        projectId: fixture.project.id,
        objective: 'Change anything at all in this repository, everywhere.',
        expectedOutcome: 'Something is different.',
        repositoryRemote: MOUNT().remote,
        mutationScope: ['**'],
      }),
    ).rejects.toThrow(ContractError);
  });
});

/* ========================================================================== */

describe('separate repositories and shared folders both work', () => {
  /**
   * Two projects, one fixture repository, one directory each.
   *
   * The only thing that separates them is the boundary row, which is the point:
   * a shared repository needs no second grant, no second worker and no second
   * surface, and the two projects still cannot reach each other's files.
   */
  it('keeps two projects in one repository inside their own directories', async () => {
    const second = await createProject({ name: 'V2 site', slug: `v2-${Date.now()}` });
    await setProjectRepository({
      projectId: fixture.project.id,
      grantId: 'fixture-shared',
      repositoryId: SHARED_FIXTURE,
      scopeKind: 'DIRECTORIES',
      pathScope: ['sites/v4/**'],
      reason: 'V4 lives here.',
      setBy: 'test',
    });
    await setProjectRepository({
      projectId: second.id,
      grantId: 'fixture-shared',
      repositoryId: SHARED_FIXTURE,
      scopeKind: 'DIRECTORIES',
      pathScope: ['sites/v2/**'],
      reason: 'V2 lives here.',
      setBy: 'test',
    });

    const v4 = await getProjectRepository(fixture.project.id, 'fixture-shared');
    const v2 = await getProjectRepository(second.id, 'fixture-shared');
    expect(v4?.pathScope).toEqual(['sites/v4/**']);
    expect(v2?.pathScope).toEqual(['sites/v2/**']);

    // Neither can reach the other's directory, and the check is the same
    // function `submitObjective` calls.
    expect(withinBoundary(['sites/v2/**'], v4!.pathScope).ok).toBe(false);
    expect(withinBoundary(['sites/v4/**'], v2!.pathScope).ok).toBe(false);
    expect(withinBoundary(['sites/v4/pages/**'], v4!.pathScope).ok).toBe(true);
  });

  it('refuses a shared-repository submission that reaches the other site', async () => {
    await setProjectRepository({
      projectId: fixture.project.id,
      grantId: 'fixture-shared',
      repositoryId: SHARED_FIXTURE,
      scopeKind: 'DIRECTORIES',
      pathScope: ['sites/v4/**'],
      reason: 'V4 lives here.',
      setBy: 'test',
    });
    /*
     * Resolved directly rather than through `submitObjective`, because the
     * fixture repository is deliberately outside the envelope — which is itself
     * the assertion below. The scope check is the same function either way.
     */
    await expect(
      resolveProjectScope({
        projectId: fixture.project.id,
        repository: `https://github.com/${SHARED_FIXTURE}`,
        requested: ['sites/v2/**'],
      }),
    ).rejects.toThrow(ScopeError);
  });

  it('still refuses the fixture repository at the envelope, boundary or not', async () => {
    await setProjectRepository({
      projectId: fixture.project.id,
      grantId: 'fixture-shared',
      repositoryId: SHARED_FIXTURE,
      scopeKind: 'WHOLE_REPOSITORY',
      pathScope: ['**'],
      reason: 'fixture',
      setBy: 'test',
    });
    /*
     * A boundary row is not an authorization to be pointed at a repository. The
     * envelope decides that, in code, and a row written by a test cannot widen
     * it — which is why these properties can be proved on a fixture at all.
     */
    await expect(
      resolveProjectScope({
        projectId: fixture.project.id,
        repository: `https://github.com/${SHARED_FIXTURE}`,
      }),
    ).rejects.toThrow(/not one this factory is authorized/i);
  });
});

/* ========================================================================== */

describe('the person authorizes, and the campaign reports back', () => {
  async function askedFor(): Promise<{ conversationId: string; requestId: string }> {
    const conversationId = await newConversation(fixture.project.id);
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'Please change the documentation so it describes the boundary.',
      title: 'Document the boundary',
      objective: 'Change the documentation so that it describes the directory boundary.',
      expectedOutcome: 'The documentation describes the directory boundary.',
    });
    if (!outcome.request) throw new Error(`nothing captured: ${outcome.reason}`);
    return { conversationId, requestId: outcome.request.id };
  }

  it('offers only repositories this project was actually given', async () => {
    expect(await repositoryChoicesFor(fixture.project.id)).toEqual([]);
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const choices = await repositoryChoicesFor(fixture.project.id);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.scope).toEqual(['docs/**']);
    // The reach travels with the choice, so the card and the validator cannot
    // describe different scopes.
    expect(choices[0]?.scopeSentence).toContain('docs/');
  });

  it('refuses a repository the project was not given, in the same words as an unknown one', async () => {
    const { requestId } = await askedFor();
    const outcome = await authorizeSoftwareRequest({
      requestId,
      grantId: MOUNT().id,
      userId: actor.id,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/has been given/i);
    // Still proposed: a refusal must not consume the decision.
    expect((await getSoftwareRequest(requestId))?.state).toBe('PROPOSED');
  });

  it('submits, approves and starts one campaign, linked to the conversation', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const { conversationId, requestId } = await askedFor();

    const outcome = await authorizeSoftwareRequest({
      requestId,
      grantId: MOUNT().id,
      userId: actor.id,
      acceptanceConditions: [
        { statement: 'The boundary is described.', verification: 'Read the page.' },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scope).toEqual(['docs/**']);

    const stored = await getSoftwareRequest(requestId);
    expect(stored?.state).toBe('AUTHORIZED');
    expect(stored?.campaignId).toBe(outcome.campaignId);
    expect(stored?.conversationId).toBe(conversationId);
    expect(stored?.requestedScope).toEqual(['docs/**']);
  });

  it('makes one campaign when it is authorized twice', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const { requestId } = await askedFor();
    const conditions = [
      { statement: 'The boundary is described.', verification: 'Read the page.' },
    ];
    const first = await authorizeSoftwareRequest({
      requestId,
      grantId: MOUNT().id,
      userId: actor.id,
      acceptanceConditions: conditions,
    });
    const second = await authorizeSoftwareRequest({
      requestId,
      grantId: MOUNT().id,
      userId: actor.id,
      acceptanceConditions: conditions,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.campaignId).toBe(first.campaignId);
  });

  it('puts the request back when the submission is refused', async () => {
    /*
     * The claim happens before the effect, so a refusal on the far side must
     * release it. Otherwise the card vanishes and the decision cannot be
     * retaken — a state that says settled and is not.
     */
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const { requestId } = await askedFor();
    const outcome = await authorizeSoftwareRequest({
      requestId,
      grantId: MOUNT().id,
      userId: actor.id,
      mutationScope: ['server/**'],
    });
    expect(outcome.ok).toBe(false);
    expect((await getSoftwareRequest(requestId))?.state).toBe('PROPOSED');
  });

  it('refuses an authorization with no acceptance condition rather than freezing an undefined objective', async () => {
    await onboardRepository({
      projectId: fixture.project.id,
      grantId: MOUNT().id,
      scope: { kind: 'DIRECTORIES', directories: ['docs'] },
      actor,
      origin: 'https://brain.example',
    });
    const { requestId } = await askedFor();
    const outcome = await authorizeSoftwareRequest({
      requestId,
      grantId: MOUNT().id,
      userId: actor.id,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/acceptance conditions/i);
    expect((await getSoftwareRequest(requestId))?.state).toBe('PROPOSED');
  });

  it('reports the request back into its own conversation', async () => {
    const { conversationId, requestId } = await askedFor();
    const before = await softwareForConversation(conversationId);
    expect(before).toHaveLength(1);
    expect(before[0]?.awaitingPerson).toBe(true);
    expect(before[0]?.line).toMatch(/nothing has been spent/i);
    expect(before[0]?.request.id).toBe(requestId);
  });

  it('counts an unauthorized change as a decision in the briefing', async () => {
    const empty = await briefing({
      projectId: fixture.project.id,
      projectName: fixture.project.name,
    });
    const baseline = empty.openRequests;

    await askedFor();
    const after = await briefing({
      projectId: fixture.project.id,
      projectName: fixture.project.name,
    });
    expect(after.openRequests).toBe(baseline + 1);
    // And the sentence agrees with the count, which is the defect §29 records:
    // "You are not needed" above a control that has to be answered.
    expect(after.needsYou).toMatch(/you are needed/i);
    expect(await softwareNeedingPerson(fixture.project.id)).toHaveLength(1);
  });

  it('keeps a declined request with its reason and stops asking', async () => {
    const { requestId } = await askedFor();
    const outcome = await declineSoftware({
      requestId,
      reason: 'Not this quarter.',
      userId: actor.id,
    });
    expect(outcome.ok).toBe(true);
    const stored = await getSoftwareRequest(requestId);
    expect(stored?.state).toBe('DECLINED');
    expect(stored?.declineReason).toBe('Not this quarter.');
    expect(await softwareNeedingPerson(fixture.project.id)).toHaveLength(0);
    // Answering twice is refused rather than silently reopening it.
    expect((await declineSoftware({ requestId, reason: 'again', userId: actor.id })).ok).toBe(false);
  });
});
