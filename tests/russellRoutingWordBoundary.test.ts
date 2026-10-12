/**
 * A project or layer name counts only as a whole name. A name inside another
 * word ("Brain" in "brainstorm", "Cash" in "cashflow", "V4" in "V45") is not
 * the project being named.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { routeMessage } from '../server/services/russell/routing.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let userId = '';
let ids: Record<string, string> = {};

function membership(projectId: string): ProjectMembership {
  return {
    id: `mem_${projectId}`,
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    active: true,
  } as ProjectMembership;
}

function asker(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'test@example.test',
    displayName: 'Test person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: Object.values(ids).map(membership),
    requestId: 'req_test',
  } as Principal;
}

beforeEach(async () => {
  const fixture = await freshProject();
  const user = await createUser({
    email: `wb-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  ids = { dd: fixture.project.id };
  for (const name of ['Brain', 'Cash', 'V4', 'Hidden Venture']) {
    ids[name] = (await createProject({ name, slug: name.toLowerCase().replace(/\s+/g, '-') })).id;
  }
});

async function scoreOf(message: string, name: string) {
  const decision = await routeMessage({ principal: asker(), message });
  return decision.options.find((o) => o.projectId === ids[name]);
}

describe('a name inside another word does not score', () => {
  it.each([
    ["let's brainstorm pricing", 'Brain'],
    ['the cashflow looks thin', 'Cash'],
    ['we shipped V45 yesterday', 'V4'],
  ])('%s does not name %s', async (message, name) => {
    const option = await scoreOf(message, name);
    expect(option?.reason ?? '').not.toMatch(new RegExp(`names ${name}`));
  });

  it('does not let "brainstorm" attach a conversation to Brain', async () => {
    const decision = await routeMessage({
      principal: asker(),
      message: "let's brainstorm pricing for Deal Dispatch",
    });
    expect(decision.projectId).toBe(ids.dd);
  });
});

describe('whole names still score', () => {
  it.each([
    ['I want to improve Brain today', 'Brain'],
    ['cash, mostly.', 'Cash'],
    ['is V4 broken?', 'V4'],
    ['open up Hidden Venture and look', 'Hidden Venture'],
  ])('%s names %s', async (message, name) => {
    const option = await scoreOf(message, name);
    expect(option?.reason).toMatch(new RegExp(`names ${name}`));
  });
});
