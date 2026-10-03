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
import crypto from 'node:crypto';
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import {
  constantTimeEquals,
  deriveOAuthSuccessor,
  digestSecret,
  generateOAuthToken,
  type GeneratedOAuthToken,
} from '../services/identity/secrets.ts';
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
    attachConnectorId: row.attach_connector_id ?? null,
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
    grantId: row.grant_id ?? null,
    revokedReason: row.revoked_reason ?? null,
    firstUsedAt: row.first_used_at ?? null,
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

/**
 * The client a token request authenticates as, or null — one read.
 *
 * `getClientByClientId` followed by `clientSecretMatches` read the same row
 * twice on the token endpoint's critical path. This is both answers at once.
 */
export async function authenticateClient(
  clientId: string,
  presented: string | null,
): Promise<OAuthClient | null> {
  const row = await getDb().get<OAuthClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId]);
  if (!row || row.disabled_at !== null) return null;
  if (row.secret_digest === null) return presented === null || presented === '' ? mapClient(row) : null;
  if (!presented) return null;
  return constantTimeEquals(digestSecret(presented), row.secret_digest) ? mapClient(row) : null;
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
  attachConnectorId?: string | null;
}

export async function issueAuthorizationCode(input: IssueCodeInput): Promise<OAuthAuthorizationCode> {
  const id = newId('oad');
  const now = Date.now();
  await getDb().run(
    `INSERT INTO oauth_authorization_codes
       (id, code_digest, client_id, worker_id, approved_by_user_id, redirect_uri,
        code_challenge, code_challenge_method, resource, scope, created_at, expires_at, redeemed_at,
        attach_connector_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
      input.attachConnectorId ?? null,
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
  /** The authorization this token descends from; a fresh grant's refresh token is its own. */
  grantId?: string | null;
  /** Supplied when the caller needs the id before the row exists (a grant naming itself). */
  id?: string;
  now?: number;
}

/**
 * Write one token and answer from the values written.
 *
 * No read-back. Issuance sits on the token endpoint's critical path, the one a
 * client times out on, and every extra round trip is one more chance for a slow
 * database to turn a committed credential into a reply nobody received.
 */
export async function issueToken(input: IssueTokenInput): Promise<OAuthToken> {
  const id = input.id ?? newId('oat');
  const now = input.now ?? Date.now();
  const row: OAuthTokenRow = {
    id,
    token_digest: input.tokenDigest,
    token_prefix: input.tokenPrefix,
    kind: input.kind,
    client_id: input.clientId,
    worker_id: input.workerId,
    scope: input.scope,
    resource: input.resource,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + input.ttlMs).toISOString(),
    last_used_at: null,
    revoked_at: null,
    parent_token_id: input.parentTokenId ?? null,
    grant_id: input.grantId ?? (input.kind === 'REFRESH' && !input.parentTokenId ? id : null),
    revoked_reason: null,
    first_used_at: null,
  };
  await getDb().run(
    `INSERT INTO oauth_tokens
       (id, token_digest, token_prefix, kind, client_id, worker_id, scope, resource,
        created_at, expires_at, last_used_at, revoked_at, parent_token_id, grant_id,
        revoked_reason, first_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
    [
      row.id,
      row.token_digest,
      row.token_prefix,
      row.kind,
      row.client_id,
      row.worker_id,
      row.scope,
      row.resource,
      row.created_at,
      row.expires_at,
      row.parent_token_id,
      row.grant_id,
    ],
  );
  return mapToken(row);
}

/** The values a client is handed: never stored, only their digests are. */
export interface MintedPair {
  access: string;
  refresh: string;
  scope: string;
  refreshTokenId: string;
  grantId: string;
}

/**
 * A fresh grant: the refresh token that roots it and an access token minted from
 * it. Used for the authorization-code exchange, where nothing came before.
 */
export async function issueGrant(input: {
  clientId: string;
  workerId: string;
  scope: string;
  resource: string | null;
  now?: number;
}): Promise<MintedPair> {
  const refreshId = newId('oat');
  return mintPair({
    ...input,
    refresh: generateOAuthToken(),
    refreshId,
    parentTokenId: null,
    grantId: refreshId,
  });
}

async function mintPair(input: {
  clientId: string;
  workerId: string;
  scope: string;
  resource: string | null;
  refresh: GeneratedOAuthToken;
  refreshId?: string;
  parentTokenId: string | null;
  grantId: string;
  now?: number;
}): Promise<MintedPair> {
  const refreshRow = await issueToken({
    id: input.refreshId,
    kind: 'REFRESH',
    tokenPrefix: input.refresh.prefix,
    tokenDigest: input.refresh.digest,
    clientId: input.clientId,
    workerId: input.workerId,
    scope: input.scope,
    resource: input.resource,
    ttlMs: REFRESH_TOKEN_TTL_MS,
    parentTokenId: input.parentTokenId,
    grantId: input.grantId,
    now: input.now,
  });
  const access = await mintAccess({
    refreshId: refreshRow.id,
    grantId: input.grantId,
    clientId: input.clientId,
    workerId: input.workerId,
    scope: input.scope,
    resource: input.resource,
    now: input.now,
  });
  return {
    access,
    refresh: input.refresh.plaintext,
    scope: input.scope,
    refreshTokenId: refreshRow.id,
    grantId: input.grantId,
  };
}

async function mintAccess(input: {
  refreshId: string;
  grantId: string;
  clientId: string;
  workerId: string;
  scope: string;
  resource: string | null;
  now?: number;
}): Promise<string> {
  const access = generateOAuthToken();
  await issueToken({
    kind: 'ACCESS',
    tokenPrefix: access.prefix,
    tokenDigest: access.digest,
    clientId: input.clientId,
    workerId: input.workerId,
    scope: input.scope,
    resource: input.resource,
    ttlMs: ACCESS_TOKEN_TTL_MS,
    parentTokenId: input.refreshId,
    grantId: input.grantId,
    now: input.now,
  });
  return access.plaintext;
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

/* ------------------------------------------------------------------------- */
/* Rotation                                                                   */
/* ------------------------------------------------------------------------- */

/*
 * A refresh is a state, not a clock.
 *
 * Four production incidents (2026-09-27, 09-30, 10-01, 10-03) were each fixed by
 * moving a clock: five minutes, twenty-four hours, the token's own life, then
 * "any number of lost replies". Each was a guess about when a client retries,
 * and each left the same shape behind — a rotation creates a *new random*
 * successor, so a second answer to one request is a second credential, and the
 * client may keep the one Brain then retires.
 *
 * The successor is derived now (`deriveOAuthSuccessor`): presenting the same
 * refresh token again yields the same successor, so a lost reply, a retry an
 * hour later, a restart in between and two sessions racing all converge on one
 * logical credential. What decides whether the presenter still deserves it is
 * the grant's own lineage, read in one statement:
 *
 *   - anything newer in the grant was explicitly revoked      -> REVOKED
 *   - a newer refresh token was itself presented (rotated)    -> REUSED
 *   - a newer token has been in use for longer than a race    -> REUSED
 *   - otherwise the presenter is the client that never got,
 *     or got and shares, the answer                           -> re-delivered
 *
 * "Newer was presented" and "newer has been in use" are the two proofs that the
 * client moved on; nothing else is. The one clock left is
 * CONCURRENT_REFRESH_LEEWAY_MS, and it applies only to the second proof: two
 * sessions of one Routine refreshing on the same expiry can each start using
 * the answer before the other's request commits, and the slowest rotation
 * production has measured took ~117 s to commit. Five minutes is that, with
 * room. A successor that has been in use for longer than that, and is then
 * shadowed by its predecessor, is a replay.
 */
export const CONCURRENT_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export type RefreshOutcome = 'ROTATED' | 'REDELIVERED' | 'RECOVERED';
export type RefreshRefusal = 'NOT_LIVE' | 'REUSED' | 'REVOKED';

export type RefreshRotation =
  | { ok: true; outcome: RefreshOutcome; minted: MintedPair }
  | { ok: false; reason: RefreshRefusal };

const rotationKeys = new WeakMap<object, Promise<Buffer>>();

/**
 * The key successors are derived under — never a row in the database.
 *
 * A successor is `HMAC(key, id | secret)` and every id is in `oauth_tokens`, so
 * a key stored beside them hands anybody who can read the database and holds
 * one old refresh token (a backup, a log, a long-rotated credential) every later
 * token in that chain, offline and undetected. Invariant 22. So the key comes
 * from outside the database, in this order:
 *
 *   1. `BRAIN_OAUTH_ROTATION_KEY`, when the deployment sets one;
 *   2. otherwise derived from `SUPABASE_SERVICE_ROLE_KEY`, a deployment secret
 *      cloud mode already holds and that no database row, dump or backup carries;
 *   3. otherwise (a local Brain with neither) a key file under the data root,
 *      which a copy of `brain.db` does not include.
 *
 * Any key an earlier version stored in `oauth_rotation_keys` is deleted rather
 * than read. Changing the key costs nothing but determinism for in-flight
 * chains: a successor derived under the old key no longer matches, and the
 * rotation supersedes it, which is the recovery path anyway.
 */
export function rotationKey(): Promise<Buffer> {
  const db = getDb();
  const cached = rotationKeys.get(db);
  if (cached) return cached;
  const loading = (async (): Promise<Buffer> => {
    const key = await rotationKeyOutsideDatabase();
    await db.run('DELETE FROM oauth_rotation_keys');
    return key;
  })();
  rotationKeys.set(db, loading);
  loading.catch(() => rotationKeys.delete(db));
  return loading;
}

async function rotationKeyOutsideDatabase(): Promise<Buffer> {
  const fromEnv = process.env['BRAIN_OAUTH_ROTATION_KEY'];
  if (fromEnv && fromEnv.length >= 16) {
    return crypto.createHash('sha256').update(fromEnv, 'utf8').digest();
  }
  if (fromEnv) {
    // Said out loud rather than silently ignored: instances that disagree about
    // the key would each supersede the other's successors.
    console.warn('[oauth] BRAIN_OAUTH_ROTATION_KEY is shorter than 16 characters and is ignored.');
  }
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (serviceKey && serviceKey.length >= 16) {
    return crypto.createHmac('sha256', serviceKey).update('brain-oauth-rotation-key-v1', 'utf8').digest();
  }
  const { RUNTIME_ROOT } = await import('../env.ts');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(RUNTIME_ROOT, 'oauth-rotation.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch {
    // Absent: made below.
  }
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch {
    // Another process wrote it first; read theirs.
  }
  const hex = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('The OAuth rotation key file is unreadable.');
  return Buffer.from(hex, 'hex');
}

/**
 * Rotate a refresh token, idempotently and atomically.
 *
 * One transaction. A live token is revoked as ROTATED by a guarded write and its
 * derived successor written with a fresh access token. A token already rotated
 * is judged by its grant's lineage (above) and, when the presenter is still the
 * client, answered with the *same* successor and a fresh access token — no new
 * refresh credential, so there is never a second live answer to choose between.
 * A chain rotated before successors were derived (or under another key) has a
 * random successor nobody can re-send: that one is superseded and the derived
 * successor issued in its place, once, on the same lineage conditions.
 */
export async function rotateRefreshToken(input: {
  tokenId: string;
  presentedSecret: string;
  now?: number;
  /** Failure injection for tests: called inside the transaction at each stage. */
  inject?: (stage: 'REVOKED' | 'MINTED') => Promise<void>;
}): Promise<RefreshRotation> {
  try {
    return await rotateWithin(input);
  } catch (error) {
    if (error instanceof RecoveryRaced) return { ok: false, reason: 'REUSED' };
    throw error;
  }
}

/** A concurrent rotation moved a legacy successor between the read and the supersede. */
class RecoveryRaced extends Error {
  constructor() {
    super('A concurrent rotation moved the chain during recovery.');
  }
}

async function rotateWithin(input: {
  tokenId: string;
  presentedSecret: string;
  now?: number;
  inject?: (stage: 'REVOKED' | 'MINTED') => Promise<void>;
}): Promise<RefreshRotation> {
  const key = await rotationKey();
  const db = getDb();
  return db.transaction(async (): Promise<RefreshRotation> => {
    const now = input.now ?? Date.now();
    const at = new Date(now).toISOString();
    let presented = await db.get<OAuthTokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [input.tokenId]);
    if (!presented || presented.kind !== 'REFRESH' || presented.expires_at <= at) {
      return { ok: false, reason: 'NOT_LIVE' };
    }
    const successor = deriveOAuthSuccessor(key, presented.id, input.presentedSecret);
    const grantId = presented.grant_id ?? presented.id;
    const base = {
      clientId: presented.client_id,
      workerId: presented.worker_id,
      scope: presented.scope,
      resource: presented.resource,
      grantId,
      now,
    };

    if (presented.revoked_at === null) {
      const rotated = await db.run(
        `UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'ROTATED'
          WHERE id = ? AND kind = 'REFRESH' AND revoked_at IS NULL AND expires_at > ?`,
        [at, presented.id, at],
      );
      if (rotated.changes === 1) {
        await input.inject?.('REVOKED');
        const minted = await mintPair({ ...base, refresh: successor, parentTokenId: presented.id });
        await input.inject?.('MINTED');
        return { ok: true, outcome: 'ROTATED', minted };
      }
      // A concurrent request rotated it between the read and the write.
      presented = await db.get<OAuthTokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [input.tokenId]);
      if (!presented || presented.revoked_at === null) return { ok: false, reason: 'NOT_LIVE' };
    }

    /*
     * Serialize on the presented row before reading its lineage. Two requests
     * presenting the same already-rotated token would otherwise both find no
     * derived successor and both try to insert it (READ COMMITTED on Postgres),
     * and the loser fails on the unique `token_digest`. The no-op UPDATE takes
     * the row lock; the loser blocks until the winner commits and then reads
     * the successor the winner wrote, which is the redelivery it should get.
     */
    await db.run('UPDATE oauth_tokens SET revoked_reason = revoked_reason WHERE id = ?', [presented.id]);
    presented = (await db.get<OAuthTokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [input.tokenId])) ?? presented;

    // Withdrawn is withdrawn. A null reason predates migration 100 and is read
    // as the stricter of the two, because guessing ROTATED would resurrect it.
    if (presented.revoked_reason !== 'ROTATED' && presented.revoked_reason !== 'SUPERSEDED') {
      return { ok: false, reason: 'REVOKED' };
    }

    /*
     * Everything in the grant from the presented token's instant on, minus the
     * presented token, its own access tokens and its ancestors. Ancestors only
     * appear here when they share the presented token's millisecond, which a
     * test can arrange and production effectively cannot — but "newer" must
     * mean later in the lineage, never "older and equal on the clock".
     */
    const ancestors = new Set<string>();
    for (let cursor = presented.parent_token_id; cursor && ancestors.size < 16; ) {
      ancestors.add(cursor);
      const up: { parent_token_id: string | null; created_at: string } | undefined = await db.get(
        'SELECT parent_token_id, created_at FROM oauth_tokens WHERE id = ?',
        [cursor],
      );
      if (!up || up.created_at < presented.created_at) break;
      cursor = up.parent_token_id;
    }
    const newer = (
      await db.all<OAuthTokenRow>(
        `SELECT * FROM oauth_tokens
          WHERE (grant_id = ? OR parent_token_id = ?) AND id <> ? AND created_at >= ?`,
        [grantId, presented.id, presented.id, presented.created_at],
      )
    ).filter(
      (t) =>
        !ancestors.has(t.id) &&
        !(t.kind === 'ACCESS' && (t.parent_token_id === presented!.id || ancestors.has(t.parent_token_id ?? ''))),
    );
    if (newer.some((t) => t.kind === 'REFRESH' && t.revoked_at !== null && t.revoked_reason !== 'ROTATED' && t.revoked_reason !== 'SUPERSEDED')) {
      return { ok: false, reason: 'REVOKED' };
    }
    if (newer.some((t) => t.kind === 'REFRESH' && t.revoked_reason === 'ROTATED')) {
      return { ok: false, reason: 'REUSED' };
    }
    const settledBefore = new Date(now - CONCURRENT_REFRESH_LEEWAY_MS).toISOString();
    if (newer.some((t) => (t.first_used_at ?? t.last_used_at) !== null && (t.first_used_at ?? t.last_used_at)! < settledBefore)) {
      return { ok: false, reason: 'REUSED' };
    }

    const derived = newer.find((t) => t.kind === 'REFRESH' && t.token_digest === successor.digest);
    if (derived) {
      if (derived.revoked_at !== null || derived.expires_at <= at) return { ok: false, reason: 'NOT_LIVE' };
      const access = await mintAccess({ ...base, refreshId: derived.id });
      return {
        ok: true,
        outcome: 'REDELIVERED',
        minted: { access, refresh: successor.plaintext, scope: presented.scope, refreshTokenId: derived.id, grantId },
      };
    }

    // A random successor from before derivation, or one derived under another
    // key: nobody can send it again, so it is superseded and the derived one
    // takes its place.
    for (const live of newer.filter((t) => t.kind === 'REFRESH' && t.revoked_at === null)) {
      // Guarded on the refresh row itself: if the client rotated it between our
      // read and this write, it is held and moving on, and minting here would
      // fork the chain — so this presentation is a replay.
      const superseded = await db.run(
        `UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'SUPERSEDED'
          WHERE id = ? AND revoked_at IS NULL`,
        [at, live.id],
      );
      // Thrown rather than returned, so anything this loop already superseded
      // rolls back with it instead of committing a revocation with no successor.
      if (superseded.changes !== 1) throw new RecoveryRaced();
      await db.run(
        `UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'SUPERSEDED'
          WHERE parent_token_id = ? AND kind = 'ACCESS' AND revoked_at IS NULL`,
        [at, live.id],
      );
    }
    const minted = await mintPair({ ...base, refresh: successor, parentTokenId: presented.id });
    return { ok: true, outcome: 'RECOVERED', minted };
  });
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

/**
 * A bearer was presented. The first use is kept beside the last, because whether
 * a successor has been *in use* — rather than merely touched once just now — is
 * what separates a replay from a race (`CONCURRENT_REFRESH_LEEWAY_MS`).
 */
export async function touchToken(id: string): Promise<void> {
  const at = nowIso();
  await getDb().run(
    'UPDATE oauth_tokens SET last_used_at = ?, first_used_at = COALESCE(first_used_at, ?) WHERE id = ?',
    [at, at, id],
  );
}

export async function revokeToken(id: string): Promise<void> {
  await getDb().run(
    "UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'EXPLICIT' WHERE id = ? AND revoked_at IS NULL",
    [nowIso(), id],
  );
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
    "UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'EXPLICIT' WHERE worker_id = ? AND revoked_at IS NULL",
    [nowIso(), workerId],
  );
  return result.changes;
}

/**
 * Revoke everything one connector's clients hold — and nothing a sibling
 * account behind the same worker holds. A shared worker is several connectors.
 */
export async function revokeTokensForClients(clientIds: string[]): Promise<number> {
  if (clientIds.length === 0) return 0;
  const result = await getDb().run(
    `UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'EXPLICIT'
      WHERE client_id IN (${clientIds.map(() => '?').join(', ')}) AND revoked_at IS NULL`,
    [nowIso(), ...clientIds],
  );
  return result.changes;
}

/** Revoke a refresh token and everything minted from it. */
export async function revokeTokenChain(tokenId: string): Promise<void> {
  const now = nowIso();
  await getDb().run(
    "UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'EXPLICIT' WHERE (id = ? OR parent_token_id = ?) AND revoked_at IS NULL",
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
