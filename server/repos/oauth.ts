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
  await getDb().run(
    `INSERT INTO oauth_clients (id, client_id, secret_digest, client_name, redirect_uris,
                                token_auth_method, created_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      clientId,
      input.secretDigest,
      input.clientName.slice(0, 200),
      JSON.stringify(input.redirectUris),
      input.tokenAuthMethod,
      nowIso(),
    ],
  );
  const row = await getDb().get<OAuthClientRow>('SELECT * FROM oauth_clients WHERE id = ?', [id]);
  if (!row) throw new Error('The OAuth client disappeared immediately after being written.');
  return mapClient(row);
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
