/**
 * `like()` backslash-escapes `\`, `%` and `_`, and SQLite has no default escape
 * character, so without `ESCAPE '\'` on every LIKE a search for `county_fees` or
 * `10%` found nothing on SQLite even when the text was present.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { search } from '../server/services/russell/search.ts';
import type { Principal } from '../server/domain/types.ts';

let userId: string;
let projectId: string;
let person: Principal;

beforeEach(async () => {
  const fresh = await freshProject();
  projectId = fresh.project.id;
  const user = await createUser({
    email: `esc-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    displayName: 'Escape tester',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  person = {
    type: 'HUMAN',
    id: userId,
    handle: `${userId}@test.local`,
    displayName: 'Escape tester',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `ses-${userId}`,
    authMethod: 'SESSION_COOKIE',
    memberships: [{ projectId, role: 'OWNER', scopes: [], active: true }] as unknown as Principal['memberships'],
    requestId: 'test-request',
  };
});

async function titlesFor(query: string): Promise<string[]> {
  const result = await search({ principal: person, query });
  return result.hits.map((hit) => hit.title);
}

describe('search treats LIKE metacharacters as literal text', () => {
  it('finds an underscore, and does not treat it as a wildcard', async () => {
    await createConversation({ ownerUserId: userId, title: 'county_fees schedule', projectId });
    await createConversation({ ownerUserId: userId, title: 'countyXfees schedule', projectId });
    const titles = await titlesFor('county_fees');
    expect(titles).toContain('county_fees schedule');
    expect(titles).not.toContain('countyXfees schedule');
  });

  it('finds a per-cent sign', async () => {
    await createConversation({ ownerUserId: userId, title: 'Fee rose 10% in 2025', projectId });
    await createConversation({ ownerUserId: userId, title: 'Fee rose 1050 in 2025', projectId });
    const titles = await titlesFor('10%');
    expect(titles).toContain('Fee rose 10% in 2025');
    expect(titles).not.toContain('Fee rose 1050 in 2025');
  });

  it('finds a backslash', async () => {
    await createConversation({ ownerUserId: userId, title: 'path a\\b notes', projectId });
    expect(await titlesFor('a\\b')).toContain('path a\\b notes');
  });
});
