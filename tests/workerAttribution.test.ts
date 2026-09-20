/**
 * Who a session belongs to, and whether Brain can prove it.
 *
 * The defect this file is written from: a Routine on one Claude account checked
 * in and Brain answered `airynworker2`. Two separate things were wrong with that
 * sentence and only one of them was a bug in the attribution chain.
 *
 *   - The chain itself was right. A principal is decided by
 *     credential -> `oauth_tokens.worker_id` -> `workers.id`, and no step of it
 *     consults a name. Most of this file pins that: an unknown credential fails
 *     closed, two credentials resolve to their own workers, and no amount of
 *     renaming a row changes who a token is.
 *   - What Brain *printed* was a human handle, so every reader took it for a
 *     claim about whose account had run the session. That is fixed by the
 *     neutral label, and the tests here assert the label is what surfaces and
 *     that the legacy handle decides nothing.
 *
 * And one thing code cannot fix at all, which is therefore asserted as a
 * *reading* rather than a guard: one worker behind two OAuth clients is two
 * connectors wearing one identity, and their sessions are indistinguishable
 * afterwards however correct the code is. `analyseAttribution` has to call that
 * AMBIGUOUS, because reporting it as proven is the one answer a surface proof
 * may never give.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import {
  createWorker,
  getWorker,
  getWorkerByName,
  issueWorkerCredential,
  listWorkers,
} from '../server/repos/identity.ts';
import { authenticateRequest } from '../server/services/identity/authenticate.ts';
import {
  analyseAttribution,
  AMBIGUATES,
  type AttributionFinding,
  type AttributionSnapshot,
} from '../server/services/identity/attribution.ts';
import type { FleetAccount, FleetRoutine, OAuthClient, OAuthToken, Worker } from '../server/domain/types.ts';

/* ------------------------------------------------------------------------- */
/* The live half: a credential decides the principal, and nothing else does    */
/* ------------------------------------------------------------------------- */

describe('a credential decides who you are', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  /**
   * The smallest thing `authenticateRequest` actually reads: a query bag and a
   * header lookup. Deliberately not a mock of the outcome — the whole point of
   * these four tests is that the *real* resolution runs.
   */
  const request = (secret: string) =>
    ({
      query: {},
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? `Bearer ${secret}` : undefined,
    }) as unknown as Parameters<typeof authenticateRequest>[0];

  it('resolves two independent credentials to their own workers', async () => {
    const one = await createWorker({ name: 'surface-one', createdByType: 'SYSTEM', createdById: 'test' });
    const two = await createWorker({ name: 'surface-two', createdByType: 'SYSTEM', createdById: 'test' });
    const oneSecret = await issueWorkerCredential({ workerId: one.id, issuedByType: 'SYSTEM', issuedById: 'test' });
    const twoSecret = await issueWorkerCredential({ workerId: two.id, issuedByType: 'SYSTEM', issuedById: 'test' });

    const first = await authenticateRequest(request(oneSecret.plaintext));
    const second = await authenticateRequest(request(twoSecret.plaintext));
    expect(first.ok && first.principal.id).toBe(one.id);
    expect(second.ok && second.principal.id).toBe(two.id);
    // And neither can be made to answer as the other by asking twice.
    const again = await authenticateRequest(request(oneSecret.plaintext));
    expect(again.ok && again.principal.id).toBe(one.id);
  });

  it('answers with the neutral label, never the handle somebody typed', async () => {
    const worker = await createWorker({
      name: 'airynworker9',
      displayName: 'Airyn’s worker',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const credential = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'SYSTEM',
      issuedById: 'test',
    });
    const auth = await authenticateRequest(request(credential.plaintext));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.principal.handle).toMatch(/^worker-\d\d$/);
    expect(auth.principal.handle).not.toBe('airynworker9');
    expect(auth.principal.displayName).not.toContain('Airyn');
    // The legacy handle is still there and still finds the row. It is a lookup
    // key; it is not what the caller is told it is.
    expect((await getWorkerByName('airynworker9'))?.id).toBe(worker.id);
  });

  it('gives every worker a distinct, stable label', async () => {
    const made = [];
    for (const name of ['alpha', 'bravo', 'charlie']) {
      made.push(await createWorker({ name, createdByType: 'SYSTEM', createdById: 'test' }));
    }
    const labels = made.map((worker) => worker.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).toMatch(/^worker-\d\d$/);
    // Stable: re-reading a worker returns the same label it was created with.
    for (const worker of made) expect((await getWorker(worker.id))?.label).toBe(worker.label);
    // And every pre-existing row got one from the migration rather than a null.
    for (const worker of await listWorkers({ includeArchived: true })) {
      expect(worker.label).toMatch(/^worker-\d\d$/);
    }
  });

  it('fails closed on an unknown credential rather than falling back to a worker', async () => {
    const worker = await createWorker({ name: 'real-one', createdByType: 'SYSTEM', createdById: 'test' });
    await issueWorkerCredential({ workerId: worker.id, issuedByType: 'SYSTEM', issuedById: 'test' });
    for (const bogus of ['brnw_notarealprefix.notarealsecret', 'brnw_.', 'nonsense']) {
      const auth = await authenticateRequest(request(bogus));
      expect(auth.ok).toBe(false);
    }
  });

  it('refuses a credential whose worker was disabled, rather than resolving it anyway', async () => {
    const worker = await createWorker({ name: 'retired-one', createdByType: 'SYSTEM', createdById: 'test' });
    const credential = await issueWorkerCredential({
      workerId: worker.id,
      issuedByType: 'SYSTEM',
      issuedById: 'test',
    });
    const { setWorkerStatus } = await import('../server/repos/identity.ts');
    await setWorkerStatus(worker.id, 'DISABLED');
    const auth = await authenticateRequest(request(credential.plaintext));
    expect(auth.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* The pure half: what the rows say about whether a surface is attributable    */
/* ------------------------------------------------------------------------- */

const ACCOUNT = (id: string, name: string): FleetAccount =>
  ({
    id,
    name,
    declaredPlanPower: null,
    plan: null,
    state: 'ENABLED',
    stateReason: null,
    consecutiveFailures: 0,
    retryAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as FleetAccount;

const ROUTINE = (over: Partial<FleetRoutine> & { id: string; accountId: string }): FleetRoutine =>
  ({
    routineRef: `trig_${over.id}`,
    name: over.id,
    routineVersion: null,
    baseUrl: null,
    tokenSecretName: `SECRET_${over.id.toUpperCase()}`,
    tokenDigest: `digest-${over.id}`,
    workerId: null,
    capabilities: [],
    state: 'ENABLED',
    stateReason: null,
    fireGeneration: 0,
    consecutiveFailures: 0,
    consecutiveNoShows: 0,
    totalFires: 0,
    totalRefusals: 0,
    lastFiredAt: null,
    lastCheckInAt: null,
    retryAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as FleetRoutine;

const WORKER = (id: string, label: string, name: string): Worker =>
  ({
    id,
    label,
    name,
    displayName: name,
    ownerUserId: null,
    ownerEvidence: null,
    workerType: 'GENERIC',
    description: null,
    status: 'ACTIVE',
    disabled: false,
    disabledAt: null,
    archived: false,
    archivedAt: null,
    createdByType: 'SYSTEM',
    createdById: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Worker;

const TOKEN = (workerId: string, clientId: string): OAuthToken =>
  ({
    id: `oat_${workerId}_${clientId}`,
    kind: 'ACCESS',
    clientId,
    workerId,
    scope: '',
    resource: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    parentTokenId: null,
  }) as unknown as OAuthToken;

const CLIENT = (clientId: string, name: string): OAuthClient =>
  ({
    id: clientId,
    clientId,
    confidential: false,
    clientName: name,
    redirectUris: [],
    tokenAuthMethod: 'none',
    createdAt: '2026-01-01T00:00:00.000Z',
    disabledAt: null,
  }) as unknown as OAuthClient;

function snapshot(over: Partial<AttributionSnapshot>): AttributionSnapshot {
  return { accounts: [], routines: [], workers: [], tokens: [], codes: [], clients: [], ...over };
}

function findingsFor(report: ReturnType<typeof analyseAttribution>, routineId: string): AttributionFinding[] {
  return report.surfaces.find((one) => one.routineId === routineId)?.findings ?? [];
}

describe('what the rows say about attribution', () => {
  it('calls a one-worker one-connector surface PROVEN', () => {
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' })],
        workers: [WORKER('w1', 'worker-01', 'anything-at-all')],
        tokens: [TOKEN('w1', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      }),
    );
    expect(report.proven).toBe(1);
    expect(report.ambiguous).toBe(0);
    expect(findingsFor(report, 'r1')).toEqual([]);
  });

  it('is AMBIGUOUS when one worker sits behind two connectors', () => {
    // The production shape. Two Claude accounts both approved the same worker,
    // so the credential says which *connector* called and can never say which
    // account. No code change fixes this; it is a fact about the rows.
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' })],
        workers: [WORKER('w1', 'worker-01', 'shared')],
        tokens: [TOKEN('w1', 'client-a'), TOKEN('w1', 'client-b')],
        clients: [CLIENT('client-a', 'Brain'), CLIENT('client-b', 'Brain')],
      }),
    );
    expect(findingsFor(report, 'r1')).toContain('MULTIPLE_CLIENTS_ONE_WORKER');
    expect(report.surfaces[0]?.status).toBe('AMBIGUOUS');
    expect(report.proven).toBe(0);
  });

  it('separates a pool from a cross-account share', () => {
    // Several Routines of ONE account on one worker is the ordinary pooled
    // shape and stays PROVEN; the same worker under TWO accounts is not.
    const pooled = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [
          ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' }),
          ROUTINE({ id: 'r2', accountId: 'acc1', workerId: 'w1' }),
        ],
        workers: [WORKER('w1', 'worker-01', 'pool')],
        tokens: [TOKEN('w1', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      }),
    );
    expect(findingsFor(pooled, 'r1')).toEqual(['WORKER_SHARED_ACROSS_ROUTINES']);
    expect(pooled.proven).toBe(2);

    const crossed = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one'), ACCOUNT('acc2', 'two')],
        routines: [
          ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' }),
          ROUTINE({ id: 'r2', accountId: 'acc2', workerId: 'w1' }),
        ],
        workers: [WORKER('w1', 'worker-01', 'crossed')],
        tokens: [TOKEN('w1', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      }),
    );
    expect(findingsFor(crossed, 'r1')).toContain('WORKER_SHARED_ACROSS_ACCOUNTS');
    expect(crossed.ambiguous).toBe(2);
  });

  it('detects two rows that are really one surface', () => {
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [
          ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1', tokenSecretName: 'SHARED', tokenDigest: 'same' }),
          ROUTINE({ id: 'r2', accountId: 'acc1', workerId: 'w1', tokenSecretName: 'SHARED', tokenDigest: 'same' }),
        ],
        workers: [WORKER('w1', 'worker-01', 'x')],
        tokens: [TOKEN('w1', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      }),
    );
    expect(findingsFor(report, 'r1')).toContain('SECRET_SHARED_ACROSS_ROUTINES');
    expect(findingsFor(report, 'r1')).toContain('BEARER_SHARED_ACROSS_ROUTINES');
    expect(report.surfaces[0]?.status).toBe('AMBIGUOUS');
  });

  it('never calls an unbound or never-authenticated surface proven', () => {
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [
          ROUTINE({ id: 'r1', accountId: 'acc1', workerId: null }),
          ROUTINE({ id: 'r2', accountId: 'acc1', workerId: 'w1' }),
        ],
        workers: [WORKER('w1', 'worker-01', 'x')],
      }),
    );
    expect(report.surfaces.find((one) => one.routineId === 'r1')?.status).toBe('UNBOUND');
    expect(report.surfaces.find((one) => one.routineId === 'r2')?.status).toBe('UNVERIFIED');
    expect(report.proven).toBe(0);
  });

  it('reports a stale binding without letting it look like a live one', () => {
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1', state: 'RETIRED' })],
        workers: [WORKER('w1', 'worker-01', 'x')],
        tokens: [TOKEN('w1', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      }),
    );
    expect(findingsFor(report, 'r1')).toContain('RETIRED_ROUTINE_STILL_BOUND');
    // Reported, and not treated as a reason to distrust the credential: a
    // retired Routine is out of dispatch, which is a different fact.
    expect(report.surfaces[0]?.status).toBe('PROVEN');
  });

  it('finds a worker holding a credential that serves no Routine', () => {
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' })],
        workers: [WORKER('w1', 'worker-01', 'x'), WORKER('w2', 'worker-02', 'y')],
        tokens: [TOKEN('w1', 'client-a'), TOKEN('w2', 'client-b')],
        clients: [CLIENT('client-a', 'Brain'), CLIENT('client-b', 'Brain')],
      }),
    );
    expect(report.orphanWorkerIds).toEqual(['w2']);
  });

  it('finds one connector minting for more than one worker', () => {
    const report = analyseAttribution(
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' })],
        workers: [WORKER('w1', 'worker-01', 'x'), WORKER('w2', 'worker-02', 'y')],
        tokens: [TOKEN('w1', 'client-a'), TOKEN('w2', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      }),
    );
    expect(report.clientsSpanningWorkers).toEqual([
      { clientId: 'client-a', workerIds: ['w1', 'w2'] },
    ]);
  });

  it('decides nothing from a name, however human it looks', () => {
    // The same rows twice; only the legacy handles differ. Every verdict, every
    // finding and every count has to be identical, because a name is not an
    // input to any of this.
    const rows = (name: string) =>
      snapshot({
        accounts: [ACCOUNT('acc1', 'one')],
        routines: [ROUTINE({ id: 'r1', accountId: 'acc1', workerId: 'w1' })],
        workers: [WORKER('w1', 'worker-01', name)],
        tokens: [TOKEN('w1', 'client-a')],
        clients: [CLIENT('client-a', 'Brain')],
      });
    const human = analyseAttribution(rows('airynworker2'));
    const neutral = analyseAttribution(rows('surface-alpha'));
    expect({ ...human, surfaces: human.surfaces.map((s) => ({ ...s, workerLegacyName: null })) }).toEqual({
      ...neutral,
      surfaces: neutral.surfaces.map((s) => ({ ...s, workerLegacyName: null })),
    });
  });

  it('keeps the ambiguity table total over the finding union', () => {
    // A finding added later must be classified, or this fails rather than
    // silently defaulting to "harmless" — the shape §27 settled on after two
    // Sets that had to be total between them were not.
    const findings: AttributionFinding[] = [
      'NO_WORKER_BOUND',
      'WORKER_DISABLED_OR_ARCHIVED',
      'WORKER_SHARED_ACROSS_ROUTINES',
      'WORKER_SHARED_ACROSS_ACCOUNTS',
      'MULTIPLE_CLIENTS_ONE_WORKER',
      'MULTIPLE_APPROVERS_ONE_WORKER',
      'NO_CREDENTIAL_EVER_MINTED',
      'SECRET_SHARED_ACROSS_ROUTINES',
      'TRIGGER_SHARED_ACROSS_ROUTINES',
      'BEARER_SHARED_ACROSS_ROUTINES',
      'RETIRED_ROUTINE_STILL_BOUND',
    ];
    expect(Object.keys(AMBIGUATES).sort()).toEqual([...findings].sort());
  });
});

/* ------------------------------------------------------------------------- */
/* Ownership: metadata, only where a row proves it                            */
/* ------------------------------------------------------------------------- */

describe('whose capacity a worker is', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  async function connection(email: string, workerId: string): Promise<void> {
    const { getDb } = await import('../server/db/database.ts');
    const { createUser } = await import('../server/repos/identity.ts');
    const { createAccount, createRoutine, bindRoutineWorker } = await import(
      '../server/repos/fleet.ts'
    );
    const user = await createUser({
      email,
      displayName: email,
      password: 'a-long-enough-password-for-the-verifier',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const account = await createAccount({ name: `acct-${email.split('@')[0]}` });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: `trig_${email.split('@')[0]}`,
      name: `Routine ${email}`,
      tokenSecretName: `SECRET_${email.split('@')[0]!.toUpperCase()}`,
      tokenDigest: null,
    });
    await bindRoutineWorker(routine.id, workerId);
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO capacity_connections
         (id, user_id, connector_name, routine_name, secret_name, trigger_ref,
          account_id, routine_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIGURED', ?, ?)`,
      [
        `cxn_${email.split('@')[0]}`,
        user.id,
        `Brain (${email})`,
        `Routine ${email}`,
        `SECRET_${email.split('@')[0]!.toUpperCase()}`,
        `trig_${email.split('@')[0]}`,
        account.id,
        routine.id,
        at,
        at,
      ],
    );
  }

  it('is established from the connection a person completed themselves', async () => {
    const worker = await createWorker({ name: 'owned-one', createdByType: 'SYSTEM', createdById: 'test' });
    await connection('one@example.invalid', worker.id);
    const { reconcileWorkerOwnership } = await import('../server/services/identity/ownership.ts');
    const report = await reconcileWorkerOwnership();
    expect(report.established).toHaveLength(1);
    const after = await getWorker(worker.id);
    expect(after?.ownerUserId).toBeTruthy();
    expect(after?.ownerEvidence).toBe('CAPACITY_CONNECTION');
  });

  it('leaves a shared worker unowned rather than picking one of its members', async () => {
    const worker = await createWorker({ name: 'shared-one', createdByType: 'SYSTEM', createdById: 'test' });
    await connection('alpha@example.invalid', worker.id);
    await connection('beta@example.invalid', worker.id);
    const { reconcileWorkerOwnership } = await import('../server/services/identity/ownership.ts');
    const report = await reconcileWorkerOwnership();
    expect(report.ambiguous).toContain(worker.id);
    expect((await getWorker(worker.id))?.ownerUserId).toBeNull();
  });

  it('never replaces an owner that was already recorded', async () => {
    const worker = await createWorker({ name: 'recorded-one', createdByType: 'SYSTEM', createdById: 'test' });
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(
      "UPDATE workers SET owner_user_id = 'usr_already', owner_evidence = 'SOMETHING_ELSE' WHERE id = ?",
      [worker.id],
    );
    await connection('gamma@example.invalid', worker.id);
    const { reconcileWorkerOwnership } = await import('../server/services/identity/ownership.ts');
    await reconcileWorkerOwnership();
    const after = await getWorker(worker.id);
    expect(after?.ownerUserId).toBe('usr_already');
    expect(after?.ownerEvidence).toBe('SOMETHING_ELSE');
  });

  it('does not read an approver as an owner', async () => {
    // A worker with tokens and codes but no connection has no established
    // owner. §22: the human on an authorization code approved a grant, which
    // an administrator can do for capacity that is not theirs.
    const worker = await createWorker({ name: 'approved-one', createdByType: 'SYSTEM', createdById: 'test' });
    const { reconcileWorkerOwnership } = await import('../server/services/identity/ownership.ts');
    await reconcileWorkerOwnership();
    expect((await getWorker(worker.id))?.ownerUserId).toBeNull();
  });
});
