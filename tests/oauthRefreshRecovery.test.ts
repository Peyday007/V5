/**
 * Refresh-token rotation, at the repository: atomic, and survivable when the
 * response is lost — without becoming a way to replay a token.
 *
 * The HTTP half is in `tests/oauth.test.ts` (the 2026-09-27 incident, the
 * replay after use, and two refreshes racing). This half holds the parts only
 * the repository can be made to do on demand: a rotation whose write fails, a
 * clock past the retry window, and an explicit revocation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  LOST_RESPONSE_RETRY_MS,
  issueToken,
  revokeTokensForWorker,
  rotateRefreshToken,
} from '../server/repos/oauth.ts';
import { newId } from '../server/repos/util.ts';

interface Chain {
  workerId: string;
  refreshId: string;
}

async function chain(): Promise<Chain> {
  const workerId = newId('wkr');
  const refresh = await issueToken({
    kind: 'REFRESH',
    tokenPrefix: newId('p'),
    tokenDigest: newId('d'),
    clientId: 'brnc_test',
    workerId,
    scope: 'project:read',
    resource: null,
    ttlMs: 30 * 24 * 3_600_000,
  });
  return { workerId, refreshId: refresh.id };
}

/** Mint a pair from a parent, the way the token route does. */
function minter(workerId: string): (parent: string) => Promise<string> {
  return async (parent) => {
    const refresh = await issueToken({
      kind: 'REFRESH',
      tokenPrefix: newId('p'),
      tokenDigest: newId('d'),
      clientId: 'brnc_test',
      workerId,
      scope: 'project:read',
      resource: null,
      ttlMs: 30 * 24 * 3_600_000,
      parentTokenId: parent,
    });
    await issueToken({
      kind: 'ACCESS',
      tokenPrefix: newId('p'),
      tokenDigest: newId('d'),
      clientId: 'brnc_test',
      workerId,
      scope: 'project:read',
      resource: null,
      ttlMs: 3_600_000,
      parentTokenId: refresh.id,
    });
    return refresh.id;
  };
}

async function row(id: string): Promise<{ revoked_at: string | null }> {
  const found = await getDb().get<{ revoked_at: string | null }>('SELECT revoked_at FROM oauth_tokens WHERE id = ?', [
    id,
  ]);
  return found!;
}

async function tokensOf(workerId: string): Promise<number> {
  const found = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_tokens WHERE worker_id = ?', [
    workerId,
  ]);
  return Number(found!.n);
}

describe('refresh rotation', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('changes nothing when minting the replacement fails', async () => {
    const { workerId, refreshId } = await chain();
    await expect(
      rotateRefreshToken({
        tokenId: refreshId,
        mint: async (parent) => {
          await minter(workerId)(parent);
          throw new Error('the database went away mid-rotation');
        },
      }),
    ).rejects.toThrow('mid-rotation');
    // The presented token is still live and nothing half-written survived.
    expect((await row(refreshId)).revoked_at).toBeNull();
    expect(await tokensOf(workerId)).toBe(1);
    // So the client's next ordinary refresh still works.
    const next = await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    expect(next.ok).toBe(true);
  });

  it('refuses the retry once the window has passed', async () => {
    const { workerId, refreshId } = await chain();
    const first = await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    expect(first.ok && !first.recovered).toBe(true);
    const late = await rotateRefreshToken({
      tokenId: refreshId,
      now: Date.now() + LOST_RESPONSE_RETRY_MS + 1_000,
      mint: minter(workerId),
    });
    expect(late).toEqual({ ok: false, reason: 'OUTSIDE_RETRY_WINDOW' });
  });

  it('refuses the retry when the successor has been used', async () => {
    const { workerId, refreshId } = await chain();
    const first = await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    if (!first.ok) throw new Error('rotation refused');
    await getDb().run(
      `UPDATE oauth_tokens SET last_used_at = ? WHERE parent_token_id = ? AND kind = 'ACCESS'`,
      [new Date().toISOString(), first.minted],
    );
    const replay = await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    expect(replay).toEqual({ ok: false, reason: 'REUSED' });
    expect((await row(first.minted)).revoked_at).toBeNull();
  });

  it('never revives a token that was explicitly revoked', async () => {
    const { workerId, refreshId } = await chain();
    const first = await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    expect(first.ok).toBe(true);
    await revokeTokensForWorker(workerId);
    const replay = await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    expect(replay.ok).toBe(false);

    // A token revoked with no rotation at all has nothing to recover.
    const other = await chain();
    await getDb().run('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), other.refreshId]);
    expect(await rotateRefreshToken({ tokenId: other.refreshId, mint: minter(other.workerId) })).toEqual({
      ok: false,
      reason: 'NOT_LIVE',
    });
  });

  it('recovers once, and leaves one live successor when two retries race', async () => {
    const { workerId, refreshId } = await chain();
    await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) });
    const results = await Promise.all([
      rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) }),
      rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) }),
    ]);
    expect(results.filter((one) => one.ok)).toHaveLength(1);
    const live = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM oauth_tokens WHERE parent_token_id = ? AND kind = 'REFRESH' AND revoked_at IS NULL`,
      [refreshId],
    );
    expect(Number(live!.n)).toBe(1);
    expect(await rotateRefreshToken({ tokenId: refreshId, mint: minter(workerId) })).toEqual({
      ok: false,
      reason: 'RECOVERY_SPENT',
    });
  });
});
