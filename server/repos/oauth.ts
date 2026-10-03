/**
 * OAuth clients, authorization codes and tokens.
 *
 * The same rule that shapes `identity.ts` shapes this file: **a secret enters,
 * and a digest is stored.** Nothing here returns a secret it did not just
 * generate, and no column can be turned back into one.
 *
 * The rule specific to this module is narrower and more important:
 *
 *   **A token resolves to a worker. It never resolves to a person.**
 *
 * The human who completes the consent screen is the resource owner authorizing
 * the grant. They are recorded on the authorization code for the audit and are
 * deliberately absent from the token, so there is no path by which an approver
 * could become the identity a tool call runs as.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { constantTimeEquals, digestSecret } from '../services/identity/secrets.ts';
import type {
  OAuthAuthorizationCode,
  OAuthAuthorizationCodeRow,
  OAuthClient,
  OAuthClientRow,
  OAuthToken,
  OAuthTokenKind,
  OAuthTokenRow,
} from '../domain/types.ts';

/* ------------------------------------------------------------------------- */
/* Lifetimes                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Sixty seconds. RFC 6749 says a code SHOULD live no longer than ten minutes;
 * a redirect that takes a minute has already failed for other reasons, and a
 * shorter window is a smaller target for an intercepted redirect.
 */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

/**
 * An hour for an access token, thirty days for a refresh token.
 *
 * The access token is short because membership and scopes are read from live
 * rows on every request anyway — the token's own lifetime is a backstop, not
 * the access-control mechanism. Revocation still lands on the next call.
 */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* ------------------------------------------------------------------------- */

function parseUris(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export function mapClient(row: OAuthClientRow): OAuthClient {
  return {
    id: row.id,
    clientId: row.client_id,
    // Whether a secret exists, never the secret.
    confidential: row.secret_digest !== null,
    clientName: row.client_name,
    redirectUris: parseUris(row.redirect_uris),
    tokenAuthMethod: row.token_auth_method,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

export function mapCode(row: OAuthAuthorizationCodeRow): OAuthAuthorizationCode {
  return {
    id: row.id,
    clientId: row.client_id,
    workerId: row.worker_id,
    approvedByUserId: row.approved_by_user_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    resource: row.resource,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
  };
}

export function mapToken(row: OAuthTokenRow): OAuthToken {
  return {
    id: row.id,
    kind: row.kind,
    clientId: row.client_id,
    workerId: row.worker_id,
    scope: row.scope,
    resource: row.resource,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    parentTokenId: row.parent_token_id,
  };
}

/* ------------------------------------------------------------------------- */
/* Clients                                                                    */
/* ------------------------------------------------------------------------- */

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
  /** Null for a public client relying on PKCE alone, which is the ordinary case. */
  secretDigest: string | null;
  tokenAuthMethod: string;
}

export async function registerClient(input: RegisterClientInput): Promise<OAuthClient> {
  const id = newId('oac');
  // The client id is public but must not be guessable: a guessable one lets an
  // attacker start an authorization request that looks like a known client.
  const clientId = `brnc_${newId('').replace(/[^a-z0-9]/gi, '')}${Date.now().toString(36)}`;
  const createdAt = nowIso();
  const clientName = input.clientName.slice(0, 200);
  await getDb().run(
    `INSERT INTO oauth_clients (id, client_id, secret_digest, client_name, redirect_uris,
                                token_auth_method, created_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      clientId,
      input.secretDigest,
      clientName,
      JSON.stringify(input.redirectUris),
      input.tokenAuthMethod,
      createdAt,
    ],
  );
  /*
   * Built from the values just written rather than read back. Registration is
   * the one OAuth step a client times out on before consent ever appears, and
   * on 2026-10-02 a read-back plus an audit write in front of the answer cost
   * more than four seconds during a Supabase latency incident: the row was
   * committed, Claude had already given up ("Couldn't register with … sign-in
   * service"), and the client was never used. One round trip, not three.
   */
  return mapClient({
    id,
    client_id: clientId,
    secret_digest: input.secretDigest,
    client_name: clientName,
    redirect_uris: JSON.stringify(input.redirectUris),
    token_auth_method: input.tokenAuthMethod,
    created_at: createdAt,
    disabled_at: null,
  });
}

export async function getClientByClientId(clientId: string): Promise<OAuthClient | null> {
  const row = await getDb().get<OAuthClientRow>(
    'SELECT * FROM oauth_clients WHERE client_id = ?',
    [clientId],
  );
  return row ? mapClient(row) : null;
}

/**
 * Does this client authenticate with the secret it presented?
 *
 * A public client (no stored digest) authenticates with PKCE alone and this
 * returns true only when no secret was presented — a client that suddenly
 * starts sending one is not the client that registered.
 */
export async function clientSecretMatches(clientId: string, presented: string | null): Promise<boolean> {
  const row = await getDb().get<OAuthClientRow>(
    'SELECT * FROM oauth_clients WHERE client_id = ?',
    [clientId],
  );
  if (!row) return false;
  if (row.disabled_at !== null) return false;
  if (row.secret_digest === null) return presented === null || presented === '';
  if (!presented) return false;
  return constantTimeEquals(digestSecret(presented), row.secret_digest);
}

/* ------------------------------------------------------------------------- */
/* Authorization codes                                                        */
/* ------------------------------------------------------------------------- */

export interface IssueCodeInput {
  codeDigest: string;
  clientId: string;
  workerId: string;
  approvedByUserId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  scope: string;
}

export async function issueAuthorizationCode(input: IssueCodeInput): Promise<OAuthAuthorizationCode> {
  const id = newId('oad');
  const now = Date.now();
  await getDb().run(
    `INSERT INTO oauth_authorization_codes
       (id, code_digest, client_id, worker_id, approved_by_user_id, redirect_uri,
        code_challenge, code_challenge_method, resource, scope, created_at, expires_at, redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      input.codeDigest,
      input.clientId,
      input.workerId,
      input.approvedByUserId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.resource,
      input.scope,
      new Date(now).toISOString(),
      new Date(now + AUTHORIZATION_CODE_TTL_MS).toISOString(),
    ],
  );
  const row = await getDb().get<OAuthAuthorizationCodeRow>(
    'SELECT * FROM oauth_authorization_codes WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('The authorization code disappeared immediately after being written.');
  return mapCode(row);
}

/**
 * Redeem a code, exactly once.
 *
 * The guard is in the `UPDATE`, not in a preceding `SELECT`. Two token requests
 * arriving with the same intercepted code both read an unredeemed row if this
 * were read-then-write; as a single guarded write, exactly one of them changes a
 * row and the other is refused. That is the same compare-and-swap shape the
 * queue uses, for the same reason.
 */
export async function redeemAuthorizationCode(
  codeDigest: string,
): Promise<OAuthAuthorizationCode | null> {
  const now = nowIso();
  const result = await getDb().run(
    `UPDATE oauth_authorization_codes
        SET redeemed_at = ?
      WHERE code_digest = ? AND redeemed_at IS NULL AND expires_at > ?`,
    [now, codeDigest, now],
  );
  if (result.changes !== 1) return null;
  const row = await getDb().get<OAuthAuthorizationCodeRow>(
    'SELECT * FROM oauth_authorization_codes WHERE code_digest = ?',
    [codeDigest],
  );
  return row ? mapCode(row) : null;
}

/** For the audit: was this code already used? Never used to decide access. */
export async function findAuthorizationCode(
  codeDigest: string,
): Promise<OAuthAuthorizationCode | null> {
  const row = await getDb().get<OAuthAuthorizationCodeRow>(
    'SELECT * FROM oauth_authorization_codes WHERE code_digest = ?',
    [codeDigest],
  );
  return row ? mapCode(row) : null;
}

/* ------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* ------------------------------------------------------------------------- */

export interface IssueTokenInput {
  kind: OAuthTokenKind;
  tokenPrefix: string;
  tokenDigest: string;
  clientId: string;
  workerId: string;
  scope: string;
  resource: string | null;
  ttlMs: number;
  parentTokenId?: string | null;
}

export async function issueToken(input: IssueTokenInput): Promise<OAuthToken> {
  const id = newId('oat');
  const now = Date.now();
  await getDb().run(
    `INSERT INTO oauth_tokens
       (id, token_digest, token_prefix, kind, client_id, worker_id, scope, resource,
        created_at, expires_at, last_used_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id,
      input.tokenDigest,
      input.tokenPrefix,
      input.kind,
      input.clientId,
      input.workerId,
      input.scope,
      input.resource,
      new Date(now).toISOString(),
      new Date(now + input.ttlMs).toISOString(),
      input.parentTokenId ?? null,
    ],
  );
  const row = await getDb().get<OAuthTokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [id]);
  if (!row) throw new Error('The OAuth token disappeared immediately after being written.');
  return mapToken(row);
}

/**
 * Resolve a presented token, by prefix and then in constant time.
 *
 * Returns null for unknown, revoked, expired — one answer for all of them,
 * because the caller turns this into a single refusal and the differences
 * between them are exactly what somebody probing would like to learn.
 */
export async function findLiveToken(
  prefix: string,
  secret: string,
  kind: OAuthTokenKind,
): Promise<OAuthToken | null> {
  const row = await getDb().get<OAuthTokenRow>(
    'SELECT * FROM oauth_tokens WHERE token_prefix = ? AND kind = ?',
    [prefix, kind],
  );
  if (!row) return null;
  if (!constantTimeEquals(digestSecret(secret), row.token_digest)) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= nowIso()) return null;
  return mapToken(row);
}

/**
 * The token a presented secret names, revoked or not, or null.
 *
 * `findLiveToken` is what decides whether a bearer may act, and it must keep
 * collapsing unknown, revoked and expired into one refusal. This exists for the
 * one caller that has to tell a rotated refresh token from a revoked one —
 * `rotateRefreshToken` — and it still needs the secret, so it discloses
 * nothing the caller did not present. Expired is still null.
 */
export async function findPresentedToken(
  prefix: string,
  secret: string,
  kind: OAuthTokenKind,
): Promise<OAuthToken | null> {
  const row = await getDb().get<OAuthTokenRow>(
    'SELECT * FROM oauth_tokens WHERE token_prefix = ? AND kind = ?',
    [prefix, kind],
  );
  if (!row) return null;
  if (!constantTimeEquals(digestSecret(secret), row.token_digest)) return null;
  if (row.expires_at <= nowIso()) return null;
  return mapToken(row);
}

/**
 * How long after a rotation its presented refresh token may be retried.
 *
 * Production, 2026-09-27 07:27Z: a refresh took about thirty seconds to commit,
 * the client never received the response, and it retried with the token the
 * rotation had just revoked — so a connector that had refreshed hourly for
 * three days was dead until a person reconnected it.
 *
 * Five minutes was the first bound, on the assumption that a retry of a lost
 * response arrives within seconds. Production, 2026-09-30, measured otherwise:
 * the `/mcp/factory` connector's rotation at 14:32:18 took about 84 s to commit
 * on a degraded database, the client gave up, and the retry came from the *next
 * session the Routine started* — at 15:40:41, 68 minutes later — and was refused
 * OUTSIDE_RETRY_WINDOW. The successor and its access token had never been used.
 * Claude then marked the connector as needing interactive authorization, which
 * a Routine cannot do. A Routine client retries when it next runs, so the bound
 * has to cover the gap between runs, not the gap between packets.
 *
 * What keeps this safe is unchanged and is not the clock: recovery requires that
 * the single successor and every access token minted from it were never used, and
 * it is spent the first time it is honoured. The window only bounds how long a
 * stolen pre-rotation token stays worth anything when the legitimate client has
 * also gone quiet. Twenty-four hours covers a Routine that fires daily and is
 * still a small fraction of the thirty-day refresh lifetime.
 */
export const LOST_RESPONSE_RETRY_MS = 24 * 60 * 60_000;

export type RefreshRotation<T> =
  | { ok: true; recovered: boolean; minted: T }
  | { ok: false; reason: 'NOT_LIVE' | 'REUSED' | 'RECOVERY_SPENT' | 'OUTSIDE_RETRY_WINDOW' };

/**
 * Rotate a refresh token — atomically, and survivably when the answer is lost.
 *
 * One transaction: the presented token and its access tokens are revoked by a
 * guarded write, and `mint` issues the replacement pair (its refresh token
 * carrying the presented one as its parent). A failure anywhere rolls all of
 * it back, so a rotation never leaves the client's token revoked with nothing
 * issued in its place.
 *
 * A presented token that is already revoked is refused, with one exception
 * that exists for the lost-response case and nothing else. It is honoured, once,
 * when every one of these holds: the token was revoked no more than
 * `LOST_RESPONSE_RETRY_MS` ago; exactly one refresh token has been minted from
 * it, so the revocation was a rotation and this is its first repeat; that
 * successor is still live, so nothing explicitly revoked it; and neither it nor
 * any access token minted from it has ever been used, so the client never
 * received it. The unused successor is then revoked and a new pair issued in
 * its place. Anything else — a replay after the replacement was used, a second
 * replay, an explicit revocation, a replay after the window — is refused, which
 * is the replay detection this keeps.
 */
export async function rotateRefreshToken<T>(input: {
  tokenId: string;
  now?: number;
  mint: (parentTokenId: string) => Promise<T>;
}): Promise<RefreshRotation<T>> {
  const db = getDb();
  return db.transaction(async () => {
    const now = input.now ?? Date.now();
    const at = new Date(now).toISOString();
    const rotated = await db.run(
      `UPDATE oauth_tokens SET revoked_at = ?
        WHERE id = ? AND kind = 'REFRESH' AND revoked_at IS NULL AND expires_at > ?`,
      [at, input.tokenId, at],
    );
    if (rotated.changes === 1) {
      await revokeAccessMintedFrom(input.tokenId, at);
      return { ok: true as const, recovered: false, minted: await input.mint(input.tokenId) };
    }

    const presented = await db.get<OAuthTokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [input.tokenId]);
    if (!presented || presented.kind !== 'REFRESH' || presented.revoked_at === null || presented.expires_at <= at) {
      return { ok: false as const, reason: 'NOT_LIVE' as const };
    }
    const successors = await db.all<OAuthTokenRow>(
      `SELECT * FROM oauth_tokens WHERE parent_token_id = ? AND kind = 'REFRESH' ORDER BY created_at`,
      [input.tokenId],
    );
    if (successors.length === 0) return { ok: false as const, reason: 'NOT_LIVE' as const };
    if (now - Date.parse(presented.revoked_at) > LOST_RESPONSE_RETRY_MS) {
      return { ok: false as const, reason: 'OUTSIDE_RETRY_WINDOW' as const };
    }
    if (successors.length > 1) return { ok: false as const, reason: 'RECOVERY_SPENT' as const };
    const successor = successors[0]!;
    if (successor.revoked_at !== null || successor.last_used_at !== null) {
      return { ok: false as const, reason: 'REUSED' as const };
    }
    const used = await db.get<{ id: string }>(
      `SELECT id FROM oauth_tokens WHERE parent_token_id = ? AND kind = 'ACCESS' AND last_used_at IS NOT NULL LIMIT 1`,
      [successor.id],
    );
    if (used) return { ok: false as const, reason: 'REUSED' as const };

    const retired = await db.run(
      'UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND last_used_at IS NULL',
      [at, successor.id],
    );
    if (retired.changes !== 1) return { ok: false as const, reason: 'REUSED' as const };
    await revokeAccessMintedFrom(successor.id, at);
    return { ok: true as const, recovered: true, minted: await input.mint(input.tokenId) };
  });
}

async function revokeAccessMintedFrom(refreshId: string, at: string): Promise<void> {
  await getDb().run(
    `UPDATE oauth_tokens SET revoked_at = ? WHERE parent_token_id = ? AND kind = 'ACCESS' AND revoked_at IS NULL`,
    [at, refreshId],
  );
}

/**
 * One token by its row id, whatever state it is in.
 *
 * Deliberately *not* `findLiveToken`'s sibling: that one answers "may this
 * bearer act", collapses unknown, revoked and expired into one refusal, and
 * needs the secret to do it. This one answers "what is the shape of the grant
 * an id names" and is only ever called with an id Brain already resolved from
 * an authenticated request — so it discloses nothing a caller did not present.
 *
 * It carries no secret and no digest, because `mapToken` projects neither.
 */
export async function getToken(id: string): Promise<OAuthToken | null> {
  const row = await getDb().get<OAuthTokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [id]);
  return row ? mapToken(row) : null;
}

export async function touchToken(id: string): Promise<void> {
  await getDb().run('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
}

export async function revokeToken(id: string): Promise<void> {
  await getDb().run('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    nowIso(),
    id,
  ]);
}

/**
 * Revoke everything a worker holds.
 *
 * Called when a worker is disabled or its access is withdrawn, so that
 * disabling a worker ends its live OAuth sessions rather than leaving them
 * running until they expire. The authentication path checks the worker's own
 * status on every request as well — this is the second of two locks, and a race
 * between them must fail closed.
 */
export async function revokeTokensForWorker(workerId: string): Promise<number> {
  const result = await getDb().run(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE worker_id = ? AND revoked_at IS NULL',
    [nowIso(), workerId],
  );
  return result.changes;
}

/** Revoke a refresh token and everything minted from it. */
export async function revokeTokenChain(tokenId: string): Promise<void> {
  const now = nowIso();
  await getDb().run(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE (id = ? OR parent_token_id = ?) AND revoked_at IS NULL',
    [now, tokenId, tokenId],
  );
}

export async function listTokensForWorker(workerId: string): Promise<OAuthToken[]> {
  const rows = await getDb().all<OAuthTokenRow>(
    'SELECT * FROM oauth_tokens WHERE worker_id = ? ORDER BY created_at DESC',
    [workerId],
  );
  return rows.map(mapToken);
}

/**
 * Every authorization code ever issued for one worker, newest first.
 *
 * This is the only table in the OAuth chain that records *who approved* a
 * grant, and §22 is emphatic that the approver is on the code for the audit and
 * deliberately absent from the token. So it is also the only place that can
 * answer "whose decision put this identity behind that connector" — which is
 * exactly the question an attribution trace has to ask and must never guess at.
 *
 * Returns no digest and no challenge value: a report about credentials must not
 * become a way to read them.
 */
export async function listAuthorizationCodesForWorker(
  workerId: string,
): Promise<OAuthAuthorizationCode[]> {
  const rows = await getDb().all<OAuthAuthorizationCodeRow>(
    'SELECT * FROM oauth_authorization_codes WHERE worker_id = ? ORDER BY created_at DESC',
    [workerId],
  );
  return rows.map(mapCode);
}

/** Every registered client, newest first. Secrets are never returned; see `mapClient`. */
export async function listClients(): Promise<OAuthClient[]> {
  const rows = await getDb().all<OAuthClientRow>(
    'SELECT * FROM oauth_clients ORDER BY created_at DESC',
  );
  return rows.map(mapClient);
}
