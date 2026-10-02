/**
 * Dynamic client registration costs one statement before it can be answered.
 *
 * Production, 2026-10-02: the owner's "cloud brain" connector failed to
 * reconnect with "Couldn't register with cloud brain's sign-in service" while
 * Supabase was answering slowly. Brain *did* register the client — the row is
 * `brnc_f09f7608…` at 21:42:23.6Z — but the audit row for it is stamped
 * 21:42:27.9Z, so the INSERT and the read-back alone took more than four
 * seconds, with the audit write still to come before the reply. Claude gave
 * up, never reached consent, and the client was never used.
 *
 * The read-back answered nothing the caller did not already hold, and the audit
 * does not have to stand between a client and its reply. The assertion is about
 * statements rather than the clock, so it holds on any machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { getClientByClientId, registerClient } from '../server/repos/oauth.ts';

beforeEach(async () => {
  await freshProject();
});

afterEach(async () => {
  await teardown();
});

describe('client registration', () => {
  it('writes the client in one statement and answers with what was stored', async () => {
    const db = getDb() as unknown as Record<'all' | 'get' | 'run', (...args: unknown[]) => unknown>;
    const originals = { all: db.all, get: db.get, run: db.run };
    let count = 0;
    for (const method of ['all', 'get', 'run'] as const) {
      const original = originals[method];
      db[method] = (...args: unknown[]) => {
        count += 1;
        return original.apply(db, args);
      };
    }
    let client;
    try {
      client = await registerClient({
        clientName: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
        secretDigest: 'digest',
        tokenAuthMethod: 'client_secret_post',
      });
    } finally {
      Object.assign(db, originals);
    }
    expect(count).toBe(1);

    // What it answered is exactly the row a later request will read.
    const stored = await getClientByClientId(client.clientId);
    expect(stored).toEqual(client);
  });
});
