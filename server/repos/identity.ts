/**
 * Identity, credentials, membership and the identity audit.
 *
 * The one rule that shapes every function here: **a secret enters, and a
 * verifier is stored.** No column this module writes can be turned back into a
 * credential, and no function returns one it did not just generate. The plaintext
 * of a worker credential exists exactly twice in its life — in the response that
 * issues it, and in whatever the operator pastes it into.
 *
 * The second rule is that "live" is a computed answer, never a stored flag. A
 * credential is usable if it is not revoked, not expired, and its worker is not
 * disabled; a session is usable if it is not revoked, not expired, and its user
 * is not disabled. Storing `active` would mean a disabled worker's credentials
 * kept working until something remembered to sweep them.
 */
import { getDb } from '../db/database.ts';
import type {
  ActorType,
  DenialReason,
  IdentityEvent,
  IdentityEventRow,
  IdentityResult,
  PrincipalType,
  ProjectMembership,
  ProjectMembershipRow,
  ProjectRole,
  User,
  UserRow,
  UserSessionRow,
  Worker,
  WorkerCredentialRow,
  WorkerCredentialSummary,
  WorkerRow,
  WorkerScope,
  WorkerStatus,
} from '../domain/types.ts';
import { WORKER_SCOPES } from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
// Safe in this direction only: repos/oauth.ts imports nothing from here, so
// there is no cycle. Archiving revokes tokens through the same function the
// console's Disable uses rather than repeating the statement.
import { revokeTokensForWorker } from './oauth.ts';
import {
  digestSecret,
  generateWorkerCredential,
  hashPassword,
} from '../services/identity/secrets.ts';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isBrainAdmin: row.is_brain_admin === 1,
    mustChangePassword: row.must_change_password === 1,
    disabled: row.disabled_at !== null,
    disabledAt: row.disabled_at,
    passwordUpdatedAt: row.password_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    workerType: row.worker_type,
    description: row.description,
    status: row.status as WorkerStatus,
    // ARCHIVED is not ACTIVE, so every existing refusal path already covers it
    // without knowing the state exists. That is the point of deriving this from
    // the status rather than testing for DISABLED by name.
    disabled: row.status !== 'ACTIVE' || row.disabled_at !== null,
    disabledAt: row.disabled_at,
    archived: row.status === 'ARCHIVED',
    archivedAt: row.archived_at,
    createdByType: row.created_by_type as ActorType,
    createdById: row.created_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Null expiry means no expiry; anything in the past is expired. */
function isExpired(expiresAt: string | null, at: string): boolean {
  return expiresAt !== null && expiresAt <= at;
}

function mapCredential(row: WorkerCredentialRow, at = nowIso()): WorkerCredentialSummary {
  return {
    id: row.id,
    workerId: row.worker_id,
    prefix: row.prefix,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at,
    issuedByType: row.issued_by_type as ActorType,
    issuedById: row.issued_by_id,
    rotatedFrom: row.rotated_from,
    active: row.revoked_at === null && !isExpired(row.expires_at, at),
  };
}

/** Unknown scope strings are dropped rather than trusted onward. */
function readScopes(text: string): WorkerScope[] {
  const raw = parseJson<unknown[]>(text, []);
  const allowed = new Set<string>(WORKER_SCOPES);
  const out: WorkerScope[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry === 'string' && allowed.has(entry) && !out.includes(entry as WorkerScope)) {
      out.push(entry as WorkerScope);
    }
  }
  return out;
}

function mapMembership(row: ProjectMembershipRow): ProjectMembership {
  return {
    id: row.id,
    projectId: row.project_id,
    principalType: row.principal_type as PrincipalType,
    principalId: row.principal_id,
    role: (row.role as ProjectRole | null) ?? null,
    scopes: readScopes(row.scopes),
    grantedByType: row.granted_by_type as ActorType,
    grantedById: row.granted_by_id,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    active: row.revoked_at === null,
  };
}

function mapIdentityEvent(row: IdentityEventRow): IdentityEvent {
  return {
    id: row.id,
    createdAt: row.created_at,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    credentialId: row.credential_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    projectId: row.project_id,
    result: row.result as IdentityResult,
    reason: (row.reason as DenialReason | null) ?? null,
    requestId: row.request_id,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    userAgent: row.user_agent,
    remoteAddr: row.remote_addr,
  };
}

/** One place, so a login and an administrative create cannot normalise differently. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lowercase, and no characters that would make a handle ambiguous in a log. */
export function normalizeWorkerName(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  isBrainAdmin?: boolean;
  mustChangePassword?: boolean;
  createdByType?: ActorType;
  createdById?: string | null;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const id = newId('usr');
  const at = nowIso();
  const email = normalizeEmail(input.email);
  const verifier = await hashPassword(input.password);
  await getDb().run(
    `INSERT INTO users (id, email, display_name, password_algorithm, password_verifier,
                        password_updated_at, must_change_password, is_brain_admin, disabled_at,
                        created_by_type, created_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      id,
      email,
      input.displayName.trim(),
      'scrypt',
      verifier,
      at,
      input.mustChangePassword ? 1 : 0,
      input.isBrainAdmin ? 1 : 0,
      input.createdByType ?? 'SYSTEM',
      input.createdById ?? null,
      at,
      at,
    ],
  );
  const created = await getUser(id);
  if (!created) throw new Error('The user row disappeared immediately after being written.');
  return created;
}

export async function getUser(id: string): Promise<User | null> {
  const row = await getDb().get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  return row ? mapUser(row) : null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const row = await getDb().get<UserRow>('SELECT * FROM users WHERE email = ?', [
    normalizeEmail(email),
  ]);
  return row ? mapUser(row) : null;
}

/**
 * The verifier, for the one caller that is allowed to see it.
 *
 * Deliberately a separate function with a name that says what it hands back, so
 * that nothing reaches a verifier by accident while looking for a user.
 */
export async function getPasswordVerifierByEmail(
  email: string,
): Promise<{ user: User; verifier: string } | null> {
  const row = await getDb().get<UserRow>('SELECT * FROM users WHERE email = ?', [
    normalizeEmail(email),
  ]);
  return row ? { user: mapUser(row), verifier: row.password_verifier } : null;
}

export async function listUsers(): Promise<User[]> {
  return (await getDb().all<UserRow>('SELECT * FROM users ORDER BY email')).map(mapUser);
}

export async function countUsers(): Promise<number> {
  const row = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  return Number(row?.n ?? 0);
}

/**
 * How many people could still administer this Brain if one more were disabled.
 *
 * The administrative layer refuses the operation that would take this to zero.
 * Counting rather than trusting a flag is the point: a Brain with no enabled
 * administrator cannot grant anyone the right to fix that, and the only remedy
 * left is direct database access — which this whole step exists to avoid needing.
 */
export async function countEnabledBrainAdmins(excludeUserId?: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users
      WHERE is_brain_admin = 1 AND disabled_at IS NULL AND id <> ?`,
    [excludeUserId ?? ''],
  );
  return Number(row?.n ?? 0);
}

export async function setUserDisabled(id: string, disabled: boolean): Promise<User | null> {
  const at = nowIso();
  await getDb().run('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?', [
    disabled ? at : null,
    at,
    id,
  ]);
  // Disabling ends every session that person holds, immediately. Leaving them
  // to expire would mean "disabled" described the next login and not this one.
  if (disabled) await revokeSessionsForUser(id);
  return await getUser(id);
}

export async function setBrainAdmin(id: string, isAdmin: boolean): Promise<User | null> {
  const at = nowIso();
  await getDb().run('UPDATE users SET is_brain_admin = ?, updated_at = ? WHERE id = ?', [
    isAdmin ? 1 : 0,
    at,
    id,
  ]);
  return await getUser(id);
}

export interface SetPasswordOptions {
  mustChangePassword?: boolean;
  /** Sessions other than this one are ended; the person changing it stays in. */
  keepSessionId?: string | null;
}

export async function setUserPassword(
  id: string,
  password: string,
  options: SetPasswordOptions = {},
): Promise<User | null> {
  const at = nowIso();
  const verifier = await hashPassword(password);
  await getDb().run(
    `UPDATE users
        SET password_algorithm = ?, password_verifier = ?, password_updated_at = ?,
            must_change_password = ?, updated_at = ?
      WHERE id = ?`,
    ['scrypt', verifier, at, options.mustChangePassword ? 1 : 0, at, id],
  );
  // A password change is what somebody does when they believe a session may be
  // in the wrong hands. Leaving the other sessions alive would defeat it.
  await revokeSessionsForUser(id, options.keepSessionId ?? null);
  return await getUser(id);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreateSessionResult {
  sessionId: string;
  /** The cookie value. Returned once; never stored, never recoverable. */
  secret: string;
  expiresAt: string;
}

export interface CreateSessionInput {
  userId: string;
  secret: string;
  ttlMs: number;
  userAgent?: string | null;
  ip?: string | null;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const id = newId('ses');
  const at = nowIso();
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  await getDb().run(
    `INSERT INTO user_sessions (id, user_id, token_verifier, issued_at, expires_at,
                                revoked_at, last_seen_at, user_agent, created_ip)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      id,
      input.userId,
      digestSecret(input.secret),
      at,
      expiresAt,
      at,
      (input.userAgent ?? '').slice(0, 200) || null,
      input.ip ?? null,
    ],
  );
  return { sessionId: id, secret: input.secret, expiresAt };
}

export interface LiveSession {
  id: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Find a session by the secret the cookie carried.
 *
 * Looked up by digest rather than scanned and compared, because a scan would be
 * linear in the number of live sessions and would put a timing signal on the
 * number of them. Expiry and revocation are checked here rather than by the
 * caller so that no call site can forget one of the two.
 */
export async function findLiveSession(secret: string): Promise<LiveSession | null> {
  const row = await getDb().get<UserSessionRow>(
    'SELECT * FROM user_sessions WHERE token_verifier = ?',
    [digestSecret(secret)],
  );
  if (!row) return null;
  const at = nowIso();
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= at) return null;
  return { id: row.id, userId: row.user_id, issuedAt: row.issued_at, expiresAt: row.expires_at };
}

/**
 * Best-effort, and deliberately not awaited by the authentication path.
 *
 * A write failing here must never turn a valid request into a refused one:
 * "when was this last used" is an operator convenience, not a security control.
 */
export async function touchSession(id: string): Promise<void> {
  try {
    await getDb().run('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), id]);
  } catch {
    /* not worth failing a request over */
  }
}

export async function revokeSession(id: string): Promise<void> {
  await getDb().run(
    'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    [nowIso(), id],
  );
}

export async function revokeSessionsForUser(
  userId: string,
  exceptSessionId: string | null = null,
): Promise<number> {
  const result = await getDb().run(
    `UPDATE user_sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
    [nowIso(), userId, exceptSessionId ?? ''],
  );
  return result.changes;
}

export async function countLiveSessions(userId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    [userId, nowIso()],
  );
  return Number(row?.n ?? 0);
}

/** Housekeeping. Expired rows are already refused; this just stops them accruing. */
export async function purgeExpiredSessions(before = nowIso()): Promise<number> {
  const result = await getDb().run('DELETE FROM user_sessions WHERE expires_at <= ?', [before]);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export interface CreateWorkerInput {
  name: string;
  displayName?: string;
  workerType?: string;
  description?: string | null;
  createdByType: ActorType;
  createdById: string;
}

export async function createWorker(input: CreateWorkerInput): Promise<Worker> {
  const id = newId('wkr');
  const at = nowIso();
  const name = normalizeWorkerName(input.name);
  await getDb().run(
    `INSERT INTO workers (id, name, display_name, worker_type, description, status,
                          disabled_at, created_by_type, created_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, ?, ?)`,
    [
      id,
      name,
      (input.displayName ?? input.name).trim(),
      input.workerType ?? 'GENERIC',
      input.description ?? null,
      input.createdByType,
      input.createdById,
      at,
      at,
    ],
  );
  const created = await getWorker(id);
  if (!created) throw new Error('The worker row disappeared immediately after being written.');
  return created;
}

export async function getWorker(id: string): Promise<Worker | null> {
  const row = await getDb().get<WorkerRow>('SELECT * FROM workers WHERE id = ?', [id]);
  return row ? mapWorker(row) : null;
}

export async function getWorkerByName(name: string): Promise<Worker | null> {
  const row = await getDb().get<WorkerRow>('SELECT * FROM workers WHERE name = ?', [
    normalizeWorkerName(name),
  ]);
  return row ? mapWorker(row) : null;
}

/**
 * Live workers, unless you ask for the retired ones too.
 *
 * Archived is excluded by default because every caller wants workers you can
 * still do something with — the console, the administration API and the consent
 * screen all list them to be chosen from. Making the default the safe one means
 * archiving a worker removes it from all three without touching any of them.
 */
export async function listWorkers(
  options: { includeArchived?: boolean } = {},
): Promise<Worker[]> {
  const rows = options.includeArchived
    ? await getDb().all<WorkerRow>('SELECT * FROM workers ORDER BY name')
    : await getDb().all<WorkerRow>(
        "SELECT * FROM workers WHERE status <> 'ARCHIVED' ORDER BY name",
      );
  return rows.map(mapWorker);
}

/**
 * Disabling a worker also revokes its credentials.
 *
 * Both, rather than either: status alone would leave live credentials in the
 * table for a thing nobody intends to run again, and revoking alone would let
 * a new credential be issued to a worker somebody had decided to stop.
 */
/**
 * Retire a worker for good.
 *
 * Removing has to mean removing, so this is not a status change with a nicer
 * name. It revokes the worker's credentials, revokes its OAuth tokens, revokes
 * every project membership it holds, and only then marks the row ARCHIVED —
 * in that order, so a crash part-way through leaves a worker with nothing
 * rather than a hidden worker that still holds live access.
 *
 * Deliberately not a DELETE, and deliberately not reversible.
 *
 * Not a delete because `identity_events` has no foreign keys, precisely so the
 * audit outlives what it describes. Removing the row would leave those entries
 * naming an id that resolves to nothing.
 *
 * Not reversible because un-archiving would resurrect an identity somebody
 * chose to retire, and because the name stays taken — an audit row from last
 * year reading `worker-02` should not be ambiguous about which worker-02 it
 * meant.
 */
export async function archiveWorker(id: string): Promise<Worker | null> {
  const worker = await getWorker(id);
  if (!worker) return null;
  if (worker.archived) return worker;

  const at = nowIso();
  await revokeCredentialsForWorker(id, 'WORKER_ARCHIVED');
  await revokeTokensForWorker(id);
  await getDb().run(
    `UPDATE project_memberships SET revoked_at = ?, updated_at = ?
      WHERE principal_type = 'WORKER' AND principal_id = ? AND revoked_at IS NULL`,
    [at, at, id],
  );
  await getDb().run(
    'UPDATE workers SET status = ?, disabled_at = ?, archived_at = ?, updated_at = ? WHERE id = ?',
    ['ARCHIVED', worker.disabledAt ?? at, at, at, id],
  );
  return await getWorker(id);
}

export async function setWorkerStatus(id: string, status: WorkerStatus): Promise<Worker | null> {
  // Archiving is terminal, and this is where that is enforced rather than
  // merely intended. Without it the administration API could set an archived
  // worker back to ACTIVE — resurrecting an identity somebody retired, with its
  // name and its audit history, through a route that knows nothing about
  // archiving. `archiveWorker` writes the ARCHIVED row itself and does not come
  // through here.
  const existing = await getWorker(id);
  if (existing?.archived) return existing;

  const at = nowIso();
  await getDb().run('UPDATE workers SET status = ?, disabled_at = ?, updated_at = ? WHERE id = ?', [
    status,
    status === 'DISABLED' ? at : null,
    at,
    id,
  ]);
  if (status === 'DISABLED') await revokeCredentialsForWorker(id, 'WORKER_DISABLED');
  return await getWorker(id);
}

// ---------------------------------------------------------------------------
// Worker credentials
// ---------------------------------------------------------------------------

export interface IssueCredentialInput {
  workerId: string;
  expiresAt?: string | null;
  issuedByType: ActorType;
  issuedById: string;
  rotatedFrom?: string | null;
}

export interface IssuedCredential {
  credential: WorkerCredentialSummary;
  /** The only time this value exists outside the worker that will hold it. */
  plaintext: string;
}

export async function issueWorkerCredential(
  input: IssueCredentialInput,
): Promise<IssuedCredential> {
  const generated = generateWorkerCredential();
  const id = newId('wcr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO worker_credentials (id, worker_id, prefix, verifier, issued_at, expires_at,
                                     revoked_at, revoked_reason, last_used_at,
                                     issued_by_type, issued_by_id, rotated_from)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    [
      id,
      input.workerId,
      generated.prefix,
      generated.verifier,
      at,
      input.expiresAt ?? null,
      input.issuedByType,
      input.issuedById,
      input.rotatedFrom ?? null,
    ],
  );
  const row = await getDb().get<WorkerCredentialRow>(
    'SELECT * FROM worker_credentials WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('The credential row disappeared immediately after being written.');
  return { credential: mapCredential(row, at), plaintext: generated.plaintext };
}

export interface CredentialForVerification {
  id: string;
  workerId: string;
  prefix: string;
  verifier: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export async function findCredentialByPrefix(
  prefix: string,
): Promise<CredentialForVerification | null> {
  const row = await getDb().get<WorkerCredentialRow>(
    'SELECT * FROM worker_credentials WHERE prefix = ?',
    [prefix],
  );
  return row
    ? {
        id: row.id,
        workerId: row.worker_id,
        prefix: row.prefix,
        verifier: row.verifier,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      }
    : null;
}

export async function markCredentialUsed(id: string): Promise<void> {
  try {
    await getDb().run('UPDATE worker_credentials SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
  } catch {
    /* see touchSession */
  }
}

export async function revokeCredential(
  id: string,
  reason: string,
): Promise<WorkerCredentialSummary | null> {
  await getDb().run(
    `UPDATE worker_credentials SET revoked_at = ?, revoked_reason = ?
      WHERE id = ? AND revoked_at IS NULL`,
    [nowIso(), reason, id],
  );
  const row = await getDb().get<WorkerCredentialRow>(
    'SELECT * FROM worker_credentials WHERE id = ?',
    [id],
  );
  return row ? mapCredential(row) : null;
}

export async function revokeCredentialsForWorker(
  workerId: string,
  reason: string,
  exceptCredentialId: string | null = null,
): Promise<number> {
  const result = await getDb().run(
    `UPDATE worker_credentials SET revoked_at = ?, revoked_reason = ?
      WHERE worker_id = ? AND revoked_at IS NULL AND id <> ?`,
    [nowIso(), reason, workerId, exceptCredentialId ?? ''],
  );
  return result.changes;
}

export async function listCredentials(workerId: string): Promise<WorkerCredentialSummary[]> {
  const at = nowIso();
  return (
    await getDb().all<WorkerCredentialRow>(
      'SELECT * FROM worker_credentials WHERE worker_id = ? ORDER BY issued_at DESC',
      [workerId],
    )
  ).map((row) => mapCredential(row, at));
}

export async function getCredential(id: string): Promise<WorkerCredentialSummary | null> {
  const row = await getDb().get<WorkerCredentialRow>(
    'SELECT * FROM worker_credentials WHERE id = ?',
    [id],
  );
  return row ? mapCredential(row) : null;
}

// ---------------------------------------------------------------------------
// Project membership
// ---------------------------------------------------------------------------

export interface GrantMembershipInput {
  projectId: string;
  principalType: PrincipalType;
  principalId: string;
  role?: ProjectRole | null;
  scopes?: WorkerScope[];
  grantedByType: ActorType;
  grantedById: string;
}

/**
 * Grant, or re-grant, one principal's access to one project.
 *
 * Upserted against the unique triple rather than checked-then-inserted, so two
 * administrators granting the same access at the same moment produce one
 * membership and one deterministic role instead of a race whose winner depends
 * on scheduling. Re-granting a revoked membership clears the revocation, which
 * is what "grant" means to the person doing it.
 */
export async function grantMembership(input: GrantMembershipInput): Promise<ProjectMembership> {
  const at = nowIso();
  const scopes = toJson(input.scopes ?? []);
  await getDb().run(
    `INSERT INTO project_memberships (id, project_id, principal_type, principal_id, role, scopes,
                                      granted_by_type, granted_by_id, granted_at, revoked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (project_id, principal_type, principal_id) DO UPDATE SET
       role = excluded.role,
       scopes = excluded.scopes,
       granted_by_type = excluded.granted_by_type,
       granted_by_id = excluded.granted_by_id,
       revoked_at = NULL,
       updated_at = excluded.updated_at`,
    [
      newId('mem'),
      input.projectId,
      input.principalType,
      input.principalId,
      input.role ?? null,
      scopes,
      input.grantedByType,
      input.grantedById,
      at,
      at,
    ],
  );
  const membership = await getMembership(input.projectId, input.principalType, input.principalId);
  if (!membership) throw new Error('The membership row disappeared immediately after being written.');
  return membership;
}

export async function getMembership(
  projectId: string,
  principalType: PrincipalType,
  principalId: string,
): Promise<ProjectMembership | null> {
  const row = await getDb().get<ProjectMembershipRow>(
    `SELECT * FROM project_memberships
      WHERE project_id = ? AND principal_type = ? AND principal_id = ?`,
    [projectId, principalType, principalId],
  );
  return row ? mapMembership(row) : null;
}

export async function revokeMembership(
  projectId: string,
  principalType: PrincipalType,
  principalId: string,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE project_memberships SET revoked_at = ?, updated_at = ?
      WHERE project_id = ? AND principal_type = ? AND principal_id = ? AND revoked_at IS NULL`,
    [nowIso(), nowIso(), projectId, principalType, principalId],
  );
  return result.changes > 0;
}

/** Live memberships only. A revoked one is not a weaker membership; it is none. */
export async function listMembershipsForPrincipal(
  principalType: PrincipalType,
  principalId: string,
): Promise<ProjectMembership[]> {
  return (
    await getDb().all<ProjectMembershipRow>(
      `SELECT * FROM project_memberships
        WHERE principal_type = ? AND principal_id = ? AND revoked_at IS NULL
        ORDER BY granted_at`,
      [principalType, principalId],
    )
  ).map(mapMembership);
}

export async function listMembershipsForProject(
  projectId: string,
  options: { includeRevoked?: boolean } = {},
): Promise<ProjectMembership[]> {
  const sql = options.includeRevoked
    ? `SELECT * FROM project_memberships WHERE project_id = ? ORDER BY granted_at`
    : `SELECT * FROM project_memberships WHERE project_id = ? AND revoked_at IS NULL ORDER BY granted_at`;
  return (await getDb().all<ProjectMembershipRow>(sql, [projectId])).map(mapMembership);
}

// ---------------------------------------------------------------------------
// The identity audit
// ---------------------------------------------------------------------------

export interface RecordIdentityEventInput {
  actorType: ActorType;
  actorId?: string | null;
  credentialId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  projectId?: string | null;
  result: IdentityResult;
  reason?: DenialReason | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
  userAgent?: string | null;
  remoteAddr?: string | null;
}

/**
 * Append-only, and never a secret store.
 *
 * `metadata` is written by callers, so the rule has to hold at the call sites
 * rather than here — but this is the place to state it: an identity event may
 * contain identifiers, prefixes and categories, and must never contain a
 * password, a session secret or a credential.
 */
export async function recordIdentityEvent(
  input: RecordIdentityEventInput,
): Promise<IdentityEvent> {
  const id = newId('iev');
  await getDb().run(
    `INSERT INTO identity_events (id, created_at, actor_type, actor_id, credential_id, action,
                                  target_type, target_id, project_id, result, reason, request_id,
                                  metadata, user_agent, remote_addr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nowIso(),
      input.actorType,
      input.actorId ?? null,
      input.credentialId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.projectId ?? null,
      input.result,
      input.reason ?? null,
      input.requestId ?? null,
      toJson(input.metadata ?? {}),
      (input.userAgent ?? '').slice(0, 200) || null,
      input.remoteAddr ?? null,
    ],
  );
  const row = await getDb().get<IdentityEventRow>('SELECT * FROM identity_events WHERE id = ?', [
    id,
  ]);
  if (!row) throw new Error('The identity event disappeared immediately after being written.');
  return mapIdentityEvent(row);
}

export interface IdentityEventFilter {
  actorId?: string;
  projectId?: string;
  action?: string;
  result?: IdentityResult;
  limit?: number;
}

export async function listIdentityEvents(
  filter: IdentityEventFilter = {},
): Promise<IdentityEvent[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.actorId) {
    where.push('actor_id = ?');
    params.push(filter.actorId);
  }
  if (filter.projectId) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.action) {
    where.push('action = ?');
    params.push(filter.action);
  }
  if (filter.result) {
    where.push('result = ?');
    params.push(filter.result);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  params.push(limit);
  return (
    await getDb().all<IdentityEventRow>(
      `SELECT * FROM identity_events
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
      params,
    )
  ).map(mapIdentityEvent);
}
