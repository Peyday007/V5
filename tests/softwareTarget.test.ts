/**
 * Which project a change is filed against, and the one case Brain must not
 * decide for itself.
 *
 * A software request is filed against the conversation's project, and that
 * project decides which repository and which directories the work may touch. So
 * filing one against the wrong project authorizes a change to the wrong code —
 * and it looks healthy the whole way down: a card with a real scope sentence, a
 * person authorizing it, a campaign running, and a worker doing exactly what the
 * contract said somewhere nobody meant.
 *
 * §25 records the same defect one altitude away, where the compiler read a
 * jurisdiction out of prose and produced *"…official Michigan public records …
 * in Westbrook, OH"*. **The wrong answer confidently derived is worse than no
 * answer**, and nothing downstream can catch it, because the scope is the thing
 * that is wrong.
 *
 * What is asserted here is mostly what does *not* happen: a name in a sentence
 * can refuse a capture and can never redirect one, an unreadable project is not
 * a disagreement, and an unrelated word that happens to be a project name in
 * some other account is nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { resolveSoftwareTarget } from '../server/services/russell/softwareTarget.ts';
import { captureSoftwareChange } from '../server/services/russell/software.ts';
import { listSoftwareRequests } from '../server/repos/russellSoftware.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import type { Principal, Project, ProjectMembership, User } from '../server/domain/types.ts';

/**
 * A complete principal, built rather than cast.
 *
 * The first version of this file cast a three-field object with
 * `as unknown as Principal`, and `type: 'PERSON'` — which is not one of the two
 * principal types — sailed straight through. `decideProjectAccess` then fell to
 * neither branch and every project read as unreadable, so the ambiguity check
 * silently never fired and two tests failed for a reason that had nothing to do
 * with the code under test. A cast that has to lie about a shape is a cast that
 * will hide the next thing too.
 */
function human(user: User, memberships: ProjectMembership[] = []): Principal {
  return {
    type: 'HUMAN',
    id: user.id,
    handle: user.email,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: false,
    credentialId: `ses_${user.id}`,
    authMethod: 'SESSION_COOKIE',
    memberships,
    requestId: `req_${user.id}`,
  };
}

let fixture: TestProject;
let actor: User;
let admin: Principal;
let v4: Project;

beforeEach(async () => {
  fixture = await freshProject();
  actor = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'An owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  admin = human(actor);
  v4 = await createProject({ name: 'V4', slug: `v4-${Date.now()}` });
});

afterEach(async () => {
  await teardown();
});

describe('the project a change is about', () => {
  it('is the thread’s, when nothing in the message disagrees', async () => {
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: fixture.project.id,
      askedText: 'Fix the quote form so it stops dropping the message.',
    });
    expect(decision.kind).toBe('RESOLVED');
    if (decision.kind === 'RESOLVED') expect(decision.projectId).toBe(fixture.project.id);
  });

  it('asks which project when the thread has none', async () => {
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: null,
      askedText: 'Fix the quote form so it stops dropping the message.',
    });
    expect(decision.kind).toBe('NO_PROJECT');
    if (decision.kind === 'NO_PROJECT') {
      expect(decision.answer).toMatch(/which project/i);
      // It says why, rather than only refusing: the project is what decides the
      // repository, and a refusal with no reason reads as Russell declining.
      expect(decision.answer).toMatch(/repository/i);
    }
  });

  it('refuses to choose when the message names a different project', async () => {
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: fixture.project.id,
      askedText: 'Fix this problem on V4: the contact form drops the message.',
    });
    expect(decision.kind).toBe('AMBIGUOUS');
    if (decision.kind === 'AMBIGUOUS') {
      expect(decision.named.map((p) => p.name)).toEqual(['V4']);
      expect(decision.answer).toContain('V4');
      // Both names, so the person can answer without scrolling back.
      expect(decision.answer).toContain(fixture.project.name);
    }
  });

  it('is not ambiguous when the message names the thread’s own project too', async () => {
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: fixture.project.id,
      askedText: `In ${fixture.project.name}, not V4 — fix the quote form.`,
    });
    // Mentioning both is a person being explicit about the one they are in, and
    // treating that as a disagreement would punish the clearest phrasing there
    // is.
    expect(decision.kind).toBe('RESOLVED');
  });

  it('does not see a project this person may not read', async () => {
    const stranger = await createUser({
      email: `stranger-${Math.random().toString(36).slice(2)}@example.test`,
      displayName: 'A stranger',
      password: 'a-long-enough-password',
      isBrainAdmin: false,
      createdByType: 'SYSTEM',
      createdById: 't',
    });
    await grantMembership({
      principalType: 'HUMAN',
      principalId: stranger.id,
      projectId: fixture.project.id,
      role: 'MEMBER',
      scopes: [],
      grantedByType: 'HUMAN',
      grantedById: actor.id,
    });
    const decision = await resolveSoftwareTarget({
      principal: human(stranger, [
        {
          projectId: fixture.project.id,
          role: 'MEMBER',
          scopes: [],
        } as unknown as ProjectMembership,
      ]),
      attachedProjectId: fixture.project.id,
      askedText: 'Fix this problem on V4: the contact form drops the message.',
    });
    /*
     * Two reasons, and either alone would be enough. Matching a project this
     * person cannot open would tell them it exists, and it would block their
     * capture on the strength of something they cannot act on.
     */
    expect(decision.kind).toBe('RESOLVED');
  });

  it('does not make the attached project the target just for being mentioned', async () => {
    /*
     * The production defect, at the unit that decides it. "Do not change Brain,
     * but fix the broken form in V4" mentioned the attached project, so the
     * attached project won — and it is the one the person had ruled out in the
     * same sentence. **Never produce a proposal for the project I said not to
     * change** is the rule; mentioning is not choosing.
     */
    const attached = await createProject({ name: 'Brain', slug: `brain-${Date.now()}` });
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: attached.id,
      askedText: 'Do not change Brain, but fix the broken form in V4.',
    });
    expect(decision.kind).toBe('RESOLVED');
    if (decision.kind === 'RESOLVED') expect(decision.projectId).toBe(v4.id);
  });

  it('asks when the exclusion leaves nothing named', async () => {
    const attached = await createProject({ name: 'Brain', slug: `brain2-${Date.now()}` });
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: attached.id,
      askedText: 'Do not change Brain, but please fix the broken form.',
    });
    expect(decision.kind).toBe('EXCLUDED');
    if (decision.kind === 'EXCLUDED') {
      expect(decision.answer).toContain('Brain');
      // The excluded project is not on the list of answers, because an answer
      // must not be able to reach the project the exclusion was about.
      expect(decision.choices.map((one) => one.id)).not.toContain(attached.id);
    }
  });

  it('asks when the exclusion leaves more than one destination', async () => {
    const attached = await createProject({ name: 'Brain', slug: `brain3-${Date.now()}` });
    const v2 = await createProject({ name: 'V2', slug: `v2-${Date.now()}` });
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: attached.id,
      askedText: 'Do not change Brain — fix the broken form in V4 and in V2.',
    });
    expect(decision.kind).toBe('EXCLUDED');
    if (decision.kind === 'EXCLUDED') {
      expect(decision.choices.map((one) => one.id).sort()).toEqual([v4.id, v2.id].sort());
    }
  });

  it('a destination alone still cannot replace the row', async () => {
    /*
     * The half of the old rule that must survive: with the thread's project
     * standing, naming another one is a *disagreement*, refused rather than
     * resolved. A sentence may rule the row out; it may never replace it.
     */
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: fixture.project.id,
      askedText: 'Fix the broken form in V4.',
    });
    expect(decision.kind).toBe('AMBIGUOUS');
    if (decision.kind === 'AMBIGUOUS') {
      // Both are answers to the question, including the one the thread is on.
      expect(decision.choices.map((one) => one.id).sort()).toEqual(
        [fixture.project.id, v4.id].sort(),
      );
    }
  });

  it('does not match a name inside a longer word', async () => {
    await createProject({ name: 'API', slug: `api-${Date.now()}` });
    const decision = await resolveSoftwareTarget({
      principal: admin,
      attachedProjectId: fixture.project.id,
      askedText: 'Fix the rapid form validation so it stops dropping the message.',
    });
    // "rAPId" contains API. A substring match would make most sentences
    // ambiguous, which is a clarification nobody can answer.
    expect(decision.kind).toBe('RESOLVED');
  });
});

describe('capture refuses rather than filing it somewhere', () => {
  async function thread(): Promise<string> {
    const conversation = await createConversation({
      ownerUserId: actor.id,
      title: 'A thread',
      visibility: 'SHARED',
      projectId: fixture.project.id,
    });
    return conversation.id;
  }

  it('writes nothing when the message names another project', async () => {
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: await thread(),
      messageId: null,
      askedText: 'Fix this problem on V4: the contact form drops the message.',
      title: 'Contact form drops the message',
      objective: 'Fix the contact form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
      principal: admin,
    });
    expect(outcome.request).toBeNull();
    expect(outcome.reason).toBe('AMBIGUOUS');
    expect(outcome.clarify?.answer).toContain('V4');
    // And nothing was filed against the thread's project, which is the whole
    // point: the alternative was a card that looked right.
    expect(await listSoftwareRequests({ projectId: fixture.project.id })).toHaveLength(0);
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
  });

  it('files it when the same message names nothing else', async () => {
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: await thread(),
      messageId: null,
      askedText: 'Fix the contact form: it drops the message.',
      title: 'Contact form drops the message',
      objective: 'Fix the contact form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
      principal: admin,
    });
    expect(outcome.request?.state).toBe('PROPOSED');
    expect(await listSoftwareRequests({ projectId: fixture.project.id })).toHaveLength(1);
  });

  it('never files it against the project the message named', async () => {
    /*
     * The property that keeps this a *refusal* rather than a redirect. A
     * sentence cannot move a request to another project however unambiguous it
     * reads: the conversation's attachment is a row with its own provenance,
     * and a sentence is not.
     */
    await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: await thread(),
      messageId: null,
      askedText: 'Fix this problem on V4: the contact form drops the message.',
      title: 'Contact form drops the message',
      objective: 'Fix the contact form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
      principal: admin,
    });
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
  });

  it('still captures when no principal is supplied, because this only ever adds a refusal', async () => {
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: await thread(),
      messageId: null,
      askedText: 'Fix this problem on V4: the contact form drops the message.',
      title: 'Contact form drops the message',
      objective: 'Fix the contact form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
    });
    // The authorization is the conversation's attachment either way; losing this
    // check loses a clarification rather than a control, and failing closed
    // would mean a caller without a principal could capture nothing at all.
    expect(outcome.request?.state).toBe('PROPOSED');
  });
});
