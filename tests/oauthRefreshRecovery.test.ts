/**
 * Refresh-token rotation, at the repository: idempotent, atomic, and survivable
 * when the response is lost — without becoming a way to replay a token.
 *
 * The property under test is one sentence: **presenting a refresh token again
 * yields the same successor until the client is proven to have moved on.** Each
 * case below is a production shape, and the matrix is the lineage rule rather
 * than a list of clocks — four earlier fixes each moved a clock and left the
 * same hole behind (a second answer to one request was a second credential).
 *
 * The HTTP half is in `tests/oauth.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  CONCURRENT_REFRESH_LEEWAY_MS,
  findLiveToken,
  findPresentedToken,
  issueGrant,
  issueToken,
  revokeTokensForWorker,
  rotateRefreshToken,
  touchToken,
  type MintedPair,
} from '../server/repos/oauth.ts';
import { generateOAuthToken, parseOAuthToken } from '../server/services/identity/secrets.ts';
import { newId } from '../server/repos/util.ts';

const HOUR = 3_600_000;

interface Held {
  workerId: string;
  refresh: string;
  access: string;
}

async function grant(): Promise<Held> {
  const workerId = newId('wkr');
  const minted = await issueGrant({ clientId: 'brnc_test', workerId, scope: 'project:read', resource: null });
  return { workerId, refresh: minted.refresh, access: minted.access };
}

/** Present a refresh token the way the token route does. */
async function present(token: string, now?: number) {
  const parsed = parseOAuthToken(token)!;
  const found = await findPresentedToken(parsed.prefix, parsed.secret, 'REFRESH');
  if (!found) return { ok: false as const, reason: 'NOT_LIVE' as const };
  return rotateRefreshToken({ tokenId: found.id, presentedSecret: parsed.secret, ...(now ? { now } : {}) });
}

/** Use an access token the way the bearer path does. */
async function use(access: string): Promise<boolean> {
  const parsed = parseOAuthToken(access)!;
  const live = await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS');
  if (!live) return false;
  await touchToken(live.id);
  return true;
}

function minted(result: Awaited<ReturnType<typeof present>>): MintedPair {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.minted;
}

async function liveRefreshCount(workerId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM oauth_tokens WHERE worker_id = ? AND kind = 'REFRESH' AND revoked_at IS NULL`,
    [workerId],
  );
  return Number(row!.n);
}

describe('refresh rotation', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('A. normal refresh: the successor works, and the old token is a replay once it is used', async () => {
    const held = await grant();
    const next = minted(await present(held.refresh));
    expect(await use(next.access)).toBe(true);
    // Used beyond the race leeway: the client has moved on.
    await getDb().run('UPDATE oauth_tokens SET first_used_at = ? WHERE grant_id = ? AND first_used_at IS NOT NULL', [
      new Date(Date.now() - CONCURRENT_REFRESH_LEEWAY_MS - 1000).toISOString(),
      next.grantId,
    ]);
    expect(await present(held.refresh)).toEqual({ ok: false, reason: 'REUSED' });
    // And the successor itself still rotates normally.
    const third = minted(await present(next.refresh));
    expect(third.refresh).not.toBe(next.refresh);
  });

  it('B. a lost reply is re-delivered — the SAME successor — after seconds, 68 minutes and 31 hours', async () => {
    for (const delay of [5_000, 68 * 60_000, 31 * HOUR]) {
      const held = await grant();
      const lost = minted(await present(held.refresh));
      const retried = minted(await present(held.refresh, Date.now() + delay));
      expect(retried.refresh).toBe(lost.refresh);
      expect(retried.refreshTokenId).toBe(lost.refreshTokenId);
      expect(await liveRefreshCount(held.workerId)).toBe(1);
      expect(await use(retried.access)).toBe(true);
    }
  });

  it('B. a reply lost again and again converges on one credential rather than accumulating them', async () => {
    const held = await grant();
    const answers = [];
    for (let i = 0; i < 6; i += 1) answers.push(minted(await present(held.refresh)));
    expect(new Set(answers.map((a) => a.refresh)).size).toBe(1);
    expect(await liveRefreshCount(held.workerId)).toBe(1);
  });

  it('B. a retry after the token itself expired is NOT_LIVE — the one bound left is the credential’s own life', async () => {
    const held = await grant();
    await present(held.refresh);
    expect(await present(held.refresh, Date.now() + 400 * 24 * HOUR)).toEqual({ ok: false, reason: 'NOT_LIVE' });
  });

  it('C. two racing refreshes get one logical successor, and either session can carry on with it', async () => {
    const held = await grant();
    const [one, two] = await Promise.all([present(held.refresh), present(held.refresh)]);
    const a = minted(one);
    const b = minted(two);
    expect(a.refresh).toBe(b.refresh);
    expect(await liveRefreshCount(held.workerId)).toBe(1);
    // Session one uses its answer; session two's request lands a minute later.
    expect(await use(a.access)).toBe(true);
    const late = minted(await present(held.refresh, Date.now() + 60_000));
    expect(late.refresh).toBe(a.refresh);
    expect(await use(b.access)).toBe(true);
  });

  it('E. a restart between rotation and retry changes nothing: everything is in rows', async () => {
    const held = await grant();
    const before = minted(await present(held.refresh));
    // A new process: the key is re-derived from outside the database, not from memory.
    const { rotationKey } = await import('../server/repos/oauth.ts');
    await rotationKey();
    const after = minted(await present(held.refresh, Date.now() + 2 * HOUR));
    expect(after.refresh).toBe(before.refresh);
  });

  it('E. a failure after the revoke and before the reply rolls the rotation back whole', async () => {
    const held = await grant();
    const parsed = parseOAuthToken(held.refresh)!;
    const found = (await findPresentedToken(parsed.prefix, parsed.secret, 'REFRESH'))!;
    for (const stage of ['REVOKED', 'MINTED'] as const) {
      await expect(
        rotateRefreshToken({
          tokenId: found.id,
          presentedSecret: parsed.secret,
          inject: async (at) => {
            if (at === stage) throw new Error(`process died at ${stage}`);
          },
        }),
      ).rejects.toThrow(stage);
      const row = await getDb().get<{ revoked_at: string | null }>('SELECT revoked_at FROM oauth_tokens WHERE id = ?', [
        found.id,
      ]);
      expect(row!.revoked_at).toBeNull();
    }
    // And the client's next ordinary refresh works.
    expect((await present(held.refresh)).ok).toBe(true);
  });

  it('F. a replay after the successor was itself presented is refused, however soon', async () => {
    const held = await grant();
    const next = minted(await present(held.refresh));
    minted(await present(next.refresh));
    expect(await present(held.refresh)).toEqual({ ok: false, reason: 'REUSED' });
    // The replay created no credential.
    expect(await liveRefreshCount(held.workerId)).toBe(1);
  });

  it('G. an explicit revocation stays revoked, whatever was or was not used', async () => {
    const held = await grant();
    await present(held.refresh);
    await revokeTokensForWorker(held.workerId);
    expect(await present(held.refresh)).toEqual({ ok: false, reason: 'REVOKED' });
    expect(await liveRefreshCount(held.workerId)).toBe(0);
    const untouched = await grant();
    await revokeTokensForWorker(untouched.workerId);
    expect(await present(untouched.refresh)).toEqual({ ok: false, reason: 'REVOKED' });
  });

  /*
   * A chain rotated before successors were derived has a random successor that
   * nobody can send again. The first retry supersedes it and the derived one
   * takes its place; from then on the chain is idempotent like any other. And
   * the orphan the old recovery used to leave — a retired sibling the client
   * may still hold — is recoverable too, because its lineage has nothing newer
   * in use.
   */
  it('migrates an old random successor into the derived chain, and recovers its orphan', async () => {
    const held = await grant();
    const parsed = parseOAuthToken(held.refresh)!;
    const root = (await findPresentedToken(parsed.prefix, parsed.secret, 'REFRESH'))!;
    // The old shape: rotated, with a random successor carrying the same grant.
    await getDb().run("UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'ROTATED' WHERE id = ?", [
      new Date().toISOString(),
      root.id,
    ]);
    const legacy = generateOAuthToken();
    await issueToken({
      kind: 'REFRESH',
      tokenPrefix: legacy.prefix,
      tokenDigest: legacy.digest,
      clientId: 'brnc_test',
      workerId: held.workerId,
      scope: 'project:read',
      resource: null,
      ttlMs: 30 * 24 * HOUR,
      parentTokenId: root.id,
      grantId: root.grantId,
      now: Date.now() + 10,
    });
    const recovered = await present(held.refresh, Date.now() + 20);
    expect(recovered.ok && recovered.outcome).toBe('RECOVERED');
    expect(await liveRefreshCount(held.workerId)).toBe(1);
    const again = minted(await present(held.refresh, Date.now() + 30));
    expect(again.refresh).toBe(minted(recovered).refresh);
    // The client might still hold the legacy one: nothing newer is in use.
    const orphan = await present(legacy.plaintext, Date.now() + 40);
    expect(orphan.ok).toBe(true);
    expect(await liveRefreshCount(held.workerId)).toBe(1);
  });

  it('two racing recoveries of a legacy chain converge on one derived successor', async () => {
    const held = await grant();
    const parsed = parseOAuthToken(held.refresh)!;
    const root = (await findPresentedToken(parsed.prefix, parsed.secret, 'REFRESH'))!;
    await getDb().run("UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'ROTATED' WHERE id = ?", [
      new Date().toISOString(),
      root.id,
    ]);
    const legacy = generateOAuthToken();
    await issueToken({
      kind: 'REFRESH',
      tokenPrefix: legacy.prefix,
      tokenDigest: legacy.digest,
      clientId: 'brnc_test',
      workerId: held.workerId,
      scope: 'project:read',
      resource: null,
      ttlMs: 30 * 24 * HOUR,
      parentTokenId: root.id,
      grantId: root.grantId,
      now: Date.now() + 10,
    });
    const at = Date.now() + 20;
    const [one, two] = await Promise.all([present(held.refresh, at), present(held.refresh, at)]);
    expect(minted(one).refresh).toBe(minted(two).refresh);
    expect(await liveRefreshCount(held.workerId)).toBe(1);
  });

  it('a race whose answer has been in use for longer than the leeway is a replay', async () => {
    const held = await grant();
    const next = minted(await present(held.refresh));
    expect(await use(next.access)).toBe(true);
    expect(minted(await present(held.refresh, Date.now() + CONCURRENT_REFRESH_LEEWAY_MS - 30_000)).refresh).toBe(
      next.refresh,
    );
    expect(await present(held.refresh, Date.now() + CONCURRENT_REFRESH_LEEWAY_MS + 30_000)).toEqual({
      ok: false,
      reason: 'REUSED',
    });
  });

  it('rotation leaves the presented token’s access token alive, so a sibling session is not cut off', async () => {
    const held = await grant();
    minted(await present(held.refresh));
    expect(await use(held.access)).toBe(true);
  });
});
