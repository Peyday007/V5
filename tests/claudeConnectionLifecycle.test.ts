/**
 * The whole life of a Claude connection, including the half that goes wrong.
 *
 * ---------------------------------------------------------------------------
 * What was missing, and how it was invisible
 * ---------------------------------------------------------------------------
 *
 * The setup journey worked and stopped at the point where it worked. Three
 * things it had no row for turned out to be the three a person actually needs
 * once something goes wrong, and every one of them read as healthy:
 *
 *   * **nobody could start on their own.** The one-time connector link is a
 *     Brain administrator's to issue, correctly — it mints a worker identity
 *     and grants it a membership — but a member had no way to *ask* for one and
 *     the steps never said one was needed. So an ordinary member read "add a
 *     custom connector in Claude", did it, and was refused at a consent screen
 *     that looks for an administrator first and an invitation second;
 *   * **nothing could be given back.** No revoke and no reconnect, so somebody
 *     who lost their Claude account had to find a person with a terminal;
 *   * **a surface answering as another worker had no name.** The refusal
 *     existed at submission, and a Routine repointed *afterwards* left the
 *     connection reading CONFIGURED while Brain fired a surface its own record
 *     no longer named.
 *
 * These are asserted as rows and as derivations rather than through a screen,
 * because the screen is the one place they were already invisible.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser, getWorkerByName, setWorkerStatus } from '../server/repos/identity.ts';
import { createAccount, createRoutine, getRoutine, setRoutineState } from '../server/repos/fleet.ts';
import { issueToken, listTokensForWorker, registerClient, touchToken } from '../server/repos/oauth.ts';
import { connectionForUser } from '../server/repos/capacityConnections.ts';
import { getDb } from '../server/db/database.ts';
import {
  connectionView,
  issueConnectorInvitation,
  namesFor,
  reconnectOwnConnection,
  requestConnectorInvitation,
  revokeOwnConnection,
  submitTrigger,
  verifyConnection,
} from '../server/services/capacity/connection.ts';
import {
  contributedCapacity,
  contributedForRepository,
} from '../server/services/capacity/contribution.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import type { ConnectionView } from '../server/services/capacity/connection.ts';
import type { Project, User } from '../server/domain/types.ts';

const ORIGIN = 'https://brain.test.invalid';
const TRIGGER = 'trig_01ABCDEFGHIJKLMNOPQR';

let project: Project;
let owner: User;
let member: User;

beforeEach(async () => {
  ({ project } = await freshProject());
  owner = await createUser({
    email: 'owner@example.invalid',
    displayName: 'Owner',
    password: 'a-password-that-is-long-enough',
    isBrainAdmin: true,
  });
  member = await createUser({
    email: 'airyn@example.invalid',
    displayName: 'Airyn',
    password: 'a-password-that-is-long-enough',
    isBrainAdmin: false,
  });
  // A shared frontier, because that is the project a research worker is made a
  // member of. Issuing a link without one is refused, by design.
  await activate({
    projectId: project.id,
    ownerUserId: owner.id,
    actorUserId: owner.id,
    objective: 'The canonical mandate.',
  });
});

/**
 * A connector of this member's that has authorized this Brain and used it.
 *
 * Built from the real OAuth rows rather than from a flag, because *live* and
 * *ever used* are exactly the two facts the connection reads, and a fixture
 * that set a boolean would be testing the fixture.
 */
async function authorize(user: User, options: { ttlMs?: number } = {}): Promise<string> {
  const client = await registerClient({
    clientName: 'Claude',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    secretDigest: null,
    tokenAuthMethod: 'none',
  });
  const worker = (await getWorkerByName(namesFor(user).workerName))!;
  const token = await issueToken({
    kind: 'ACCESS',
    tokenPrefix: `pfx${Date.now()}`,
    tokenDigest: `digest-${Date.now()}-${Math.random()}`,
    clientId: client.clientId,
    workerId: worker.id,
    scope: 'project:read work:claim',
    resource: null,
    ttlMs: options.ttlMs ?? 3_600_000,
  });
  await touchToken(token.id);
  return token.id;
}

/** The whole journey up to a registered surface bound to this member's worker. */
async function registerSurface(user: User): Promise<{ routineId: string }> {
  await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
  await authorize(user);
  const worker = (await getWorkerByName(namesFor(user).workerName))!;
  const outcome = await submitTrigger({ user, actor: user, triggerRef: TRIGGER, origin: ORIGIN });
  expect(outcome.ok).toBe(true);
  const connection = (await connectionForUser(user.id))!;
  const routine = (await getRoutine(connection.routineId!))!;
  expect(routine.workerId).toBe(worker.id);
  return { routineId: routine.id };
}

function check(view: ConnectionView, key: string): { state: string; remedy: string | null } {
  const found = view.checks.find((one) => one.key === key);
  expect(found, `no ${key} check`).toBeTruthy();
  return { state: found!.state, remedy: found!.remedy };
}

function control(
  view: ConnectionView,
  key: string,
): { enabled: boolean; disabledReason: string | null } {
  const found = view.controls.find((one) => one.key === key);
  expect(found, `no ${key} control`).toBeTruthy();
  return { enabled: found!.enabled, disabledReason: found!.disabledReason };
}

/* -------------------------------------------------------------------------- */

describe('a member can start on their own', () => {
  it('asks for a connector link, and the ask is idempotent', async () => {
    const first = await requestConnectorInvitation({ user: member, origin: ORIGIN });
    expect(first.ok).toBe(true);
    expect(first.ok && first.view.state).toBe('INVITATION_REQUESTED');

    const row = (await connectionForUser(member.id))!;
    expect(row.invitationRequestedAt).not.toBeNull();

    // Asking twice asks once: the stamp is the value being claimed, so an
    // administrator's queue does not move because somebody pressed again.
    const again = await requestConnectorInvitation({ user: member, origin: ORIGIN });
    expect(again.ok).toBe(true);
    expect((await connectionForUser(member.id))!.invitationRequestedAt).toBe(
      row.invitationRequestedAt,
    );
  });

  it('creates no identity, no membership and no surface by asking', async () => {
    await requestConnectorInvitation({ user: member, origin: ORIGIN });
    expect(await getWorkerByName(namesFor(member).workerName)).toBeNull();
    const row = (await connectionForUser(member.id))!;
    expect(row.routineId).toBeNull();
    expect(row.accountId).toBeNull();
  });

  it('turns the first step from "do this" into "done" once a link is issued', async () => {
    await requestConnectorInvitation({ user: member, origin: ORIGIN });
    const before = await connectionView({ user: member, origin: ORIGIN });
    expect(before.steps[0]!.key).toBe('INVITATION');
    expect(before.steps[0]!.state).toBe('ADMINISTRATOR');

    const issued = await issueConnectorInvitation({ user: member, actor: owner, origin: ORIGIN });
    expect(issued.ok).toBe(true);
    expect(issued.ok && issued.view.invitationUrl).toMatch(/\/oauth\/invite\//);

    const after = await connectionView({ user: member, origin: ORIGIN });
    expect(after.steps[0]!.state).toBe('DONE');
    expect(after.connection.invitationIssuedAt).not.toBeNull();
  });

  it('shows the link exactly once', async () => {
    await issueConnectorInvitation({ user: member, actor: owner, origin: ORIGIN });
    const later = await connectionView({ user: member, origin: ORIGIN });
    expect(later.invitationUrl).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

describe('verification reads rows rather than taking anybody’s word', () => {
  it('answers every check with what it actually found', async () => {
    const empty = await verifyConnection({ user: member, origin: ORIGIN });
    expect(empty.ok).toBe(true);
    const nothing = empty.ok ? empty.view : null;
    expect(check(nothing!, 'IDENTITY').state).toBe('PENDING');
    expect(check(nothing!, 'AUTHORIZATION').state).toBe('PENDING');
    expect(check(nothing!, 'PROVEN').state).toBe('PENDING');

    await registerSurface(member);
    const ready = await verifyConnection({ user: member, origin: ORIGIN });
    const view = ready.ok ? ready.view : null;
    expect(check(view!, 'IDENTITY').state).toBe('PASS');
    expect(check(view!, 'MEMBERSHIP').state).toBe('PASS');
    expect(check(view!, 'AUTHORIZATION').state).toBe('PASS');
    expect(check(view!, 'TRIGGER').state).toBe('PASS');
    expect(check(view!, 'BINDING').state).toBe('PASS');
    // The deployment variable is genuinely absent in a test process, and the
    // check says so with the remedy rather than with a shrug.
    expect(check(view!, 'CREDENTIAL').state).toBe('FAIL');
    expect(check(view!, 'CREDENTIAL').remedy).toMatch(/deployment/i);
    // Registered with a credential would still be CONFIGURED. Proof is the
    // four-row chain and nothing else.
    expect(check(view!, 'PROVEN').state).toBe('PENDING');
  });

  it('names the identity without saying anything about the Claude account', async () => {
    await registerSurface(member);
    const view = await connectionView({ user: member, origin: ORIGIN });
    expect(view.identity.workerName).toBe(namesFor(member).workerName);
    expect(view.identity.membership?.projectId).toBeTruthy();
    expect(view.identity.routineName).toBe(view.connection.routineName);
    // The closest thing to a Claude display name that honestly exists: the
    // name the *connector* registered itself with.
    expect(view.identity.connectorClientName).toBe('Claude');
    /*
     * Asserted against the **identity block** rather than the whole payload,
     * and deliberately so: the instructions say the words *password*, *cookie*
     * and *session*, because telling somebody what Brain does not take is the
     * point of that sentence. What must hold is that no field describing this
     * connection carries one.
     */
    const identity = JSON.stringify(view.identity);
    expect(identity).not.toMatch(/password/i);
    expect(identity).not.toMatch(/cookie/i);
    expect(identity).not.toMatch(/digest/i);
    expect(identity).not.toMatch(/token/i);
  });

  it('carries the deployment variable’s name and never a value', async () => {
    const { routineId } = await registerSurface(member);
    const routine = (await getRoutine(routineId))!;
    const serialized = JSON.stringify(await connectionView({ user: member, origin: ORIGIN }));
    // The *name* is on the page by design: it is what an administrator is told
    // to set. The value never reaches Brain at all, and the digest taken at
    // registration must not leave the database.
    expect(serialized).toContain(routine.tokenSecretName);
    expect(serialized).not.toMatch(/tokenDigest/);
    if (routine.tokenDigest) expect(serialized).not.toContain(routine.tokenDigest);
  });
});

/* -------------------------------------------------------------------------- */

describe('a surface bound to somebody else is named rather than counted', () => {
  it('reads MISBOUND when the registered Routine answers as another worker', async () => {
    const { routineId } = await registerSurface(member);

    /*
     * The production shape: an operator repoints the surface afterwards, so
     * the connection's own record and the Routine Brain actually fires stop
     * agreeing. Written directly because `repointRoutineWorker` is the
     * operator's path and what is under test is the *derivation* that notices.
     */
    const second = await createUser({
      email: 'caleb@example.invalid',
      displayName: 'Caleb',
      password: 'a-password-that-is-long-enough',
    });
    await issueConnectorInvitation({ user: second, actor: owner, origin: ORIGIN });
    const otherWorker = (await getWorkerByName(namesFor(second).workerName))!;
    await getDb().run('UPDATE fleet_routines SET worker_id = ? WHERE id = ?', [
      otherWorker.id,
      routineId,
    ]);

    const view = await connectionView({ user: member, origin: ORIGIN });
    expect(view.state).toBe('MISBOUND');
    expect(check(view, 'BINDING').state).toBe('FAIL');
    // The remedy is an operator's, and it says so: the surface may belong to
    // another member, and disabling it from this page would be this member
    // reaching past their own.
    expect(check(view, 'BINDING').remedy).toMatch(/administrator/i);
    // Reported, never acted on.
    expect((await getRoutine(routineId))!.state).toBe('ENABLED');
    // And nothing may be fired at it from here.
    expect(control(view, 'SEND_PROBE').enabled).toBe(false);
  });

  it('is not usable capacity while it is misbound', async () => {
    const { routineId } = await registerSurface(member);
    await getDb().run('UPDATE fleet_routines SET routine_ref = ? WHERE id = ?', [
      'trig_01ZZZZZZZZZZZZZZZZZZ',
      routineId,
    ]);
    await connectionView({ user: member, origin: ORIGIN });

    const capacity = await contributedCapacity();
    const mine = capacity.surfaces.find((one) => one.userId === member.id)!;
    expect(mine.usable).toBe(false);
    expect(mine.because).toMatch(/not the one this connection names/i);
    expect(capacity.usable).toBe(0);
  });
});

describe('contributed capacity is what the dispatcher would fire', () => {
  it('stops counting a proven surface the moment its worker is disabled', async () => {
    const { routineId } = await registerSurface(member);
    const routine = (await getRoutine(routineId))!;
    process.env[routine.tokenSecretName] = 'present-for-test';
    try {
      await getDb().run(
        `UPDATE capacity_connections SET state = 'HEALTHY', healthy_at = ? WHERE user_id = ?`,
        [new Date().toISOString(), member.id],
      );
      const before = (await contributedCapacity()).surfaces.find((one) => one.userId === member.id)!;
      expect(before.because).toBeNull();
      expect(before.usable).toBe(true);

      // Disabling keeps the memberships and the Routine keeps reading ENABLED;
      // the router refuses it all the same (§23).
      await setWorkerStatus(routine.workerId!, 'DISABLED');
      const after = (await contributedCapacity()).surfaces.find((one) => one.userId === member.id)!;
      expect(after.usable).toBe(false);
      expect(after.because).toMatch(/dispatcher would not fire this surface: bound worker is disabled or archived/);
    } finally {
      delete process.env[routine.tokenSecretName];
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('an authorization that has lapsed is reported as lapsed', () => {
  it('separates "never started" from "stopped working"', async () => {
    await issueConnectorInvitation({ user: member, actor: owner, origin: ORIGIN });
    const never = await connectionView({ user: member, origin: ORIGIN });
    expect(never.authorizationExpired).toBe(false);
    expect(check(never, 'AUTHORIZATION').state).toBe('PENDING');

    // A token that was used and has since expired. Nothing else changes.
    await authorize(member, { ttlMs: -1_000 });
    const lapsed = await connectionView({ user: member, origin: ORIGIN });
    expect(lapsed.authorizationExpired).toBe(true);
    expect(lapsed.connectorAuthenticated).toBe(false);
    expect(check(lapsed, 'AUTHORIZATION').state).toBe('FAIL');
    expect(lapsed.headline).toMatch(/holds nothing live now/i);
  });

  it('keeps proof and reports the lapse beside it rather than instead of it', async () => {
    await registerSurface(member);
    // The four-row chain having closed is history. Written directly, because
    // what is under test is that a later lapse does not erase it.
    await getDb().run(
      `UPDATE capacity_connections SET state = 'HEALTHY', healthy_at = ? WHERE user_id = ?`,
      ['2026-09-18T00:00:00.000Z', member.id],
    );
    await getDb().run('UPDATE oauth_tokens SET expires_at = ?', ['2020-01-01T00:00:00.000Z']);

    const view = await connectionView({ user: member, origin: ORIGIN });
    expect(view.state).toBe('HEALTHY');
    expect(view.authorizationExpired).toBe(true);
    expect(view.identity.lastVerifiedAt).toBe('2026-09-18T00:00:00.000Z');
    // The remedy names the control that is enabled here. `RECONNECT` is only
    // enabled on a connection somebody took back, which this one is not.
    expect(view.nextAction).toMatch(/approve the connector again/i);
    expect(control(view, 'RECONNECT').enabled).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('taking a connection back, and getting it back', () => {
  it('revokes the tokens, stops the surface, and destroys nothing', async () => {
    const { routineId } = await registerSurface(member);
    const worker = (await getWorkerByName(namesFor(member).workerName))!;

    const outcome = await revokeOwnConnection({
      user: member,
      actor: member,
      reason: 'I am moving it to a different Claude account.',
      origin: ORIGIN,
    });
    expect(outcome.ok).toBe(true);

    const row = (await connectionForUser(member.id))!;
    expect(row.state).toBe('REVOKED');
    expect(row.revokedReason).toMatch(/different Claude account/);
    expect(row.revokedByUserId).toBe(member.id);

    // Nothing Brain fires can authenticate as this worker any more.
    const tokens = await listTokensForWorker(worker.id);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((one) => one.revokedAt !== null)).toBe(true);

    // And the dispatcher stops firing it. UNAVAILABLE rather than QUARANTINED,
    // because a person decided this rather than health deciding it.
    expect((await getRoutine(routineId))!.state).toBe('UNAVAILABLE');

    // Destroyed: nothing. The trigger, the account and the Routine are what
    // make reconnecting one approval rather than a second setup.
    expect(row.triggerRef).toBe(TRIGGER);
    expect(row.routineId).toBe(routineId);
    expect(row.accountId).not.toBeNull();
  });

  it('is idempotent, and reconnecting puts the same surface back', async () => {
    const { routineId } = await registerSurface(member);
    await revokeOwnConnection({ user: member, actor: member, reason: 'once', origin: ORIGIN });
    const twice = await revokeOwnConnection({
      user: member,
      actor: member,
      reason: 'twice',
      origin: ORIGIN,
    });
    expect(twice.ok).toBe(true);
    // The first reason stands: a second revoke is not a second event.
    expect((await connectionForUser(member.id))!.revokedReason).toBe('once');

    const back = await reconnectOwnConnection({ user: member, actor: member, origin: ORIGIN });
    expect(back.ok).toBe(true);
    const row = (await connectionForUser(member.id))!;
    /*
     * Back at the start, because the tokens really were revoked and the
     * connector really does have to be approved again.
     *
     * This is the assertion that found a defect. The first version of
     * `reconcile` saw a registered Routine with no deployment credential and
     * derived `WAITING_FOR_ADMIN` on the very next read — telling a member
     * whose connector could not authenticate that Brain was waiting on
     * somebody else, when the one outstanding thing was theirs.
     */
    expect(row.state).toBe('NOT_STARTED');
    /*
     * And the sentence beside it names a control that is actually enabled.
     * It used to say *reconnect*, which is the one control this state disables
     * — §29's status contradicting the control beside it, found by asserting
     * the words rather than only the state.
     */
    expect(back.ok && back.view.nextAction).toMatch(/approve the connector again/i);
    expect(row.revokedAt).toBeNull();
    // The reason stays as history. It does not stop having happened.
    expect(row.revokedReason).toBe('once');
    expect(row.routineId).toBe(routineId);
    expect((await getRoutine(routineId))!.state).toBe('ENABLED');

    /*
     * And both invitation stamps go, because revoking revoked the link they
     * record. Leaving them would show the first step as *done* while the person
     * holds nothing they can open — the step that cannot be taken, which is the
     * exact defect this journey was rewritten to remove — and would leave the
     * control that asks for a new one disabled.
     */
    expect(row.invitationIssuedAt).toBeNull();
    expect(row.invitationRequestedAt).toBeNull();
    const view = await connectionView({ user: member, origin: ORIGIN });
    expect(view.steps[0]!.state).toBe('NOW');
    expect(control(view, 'REQUEST_INVITATION').enabled).toBe(true);
  });

  it('will not re-enable a surface an operator took out for their own reason', async () => {
    const { routineId } = await registerSurface(member);
    await setRoutineState({
      routineId,
      from: 'ENABLED',
      to: 'UNAVAILABLE',
      reason: 'drained for a provider migration',
    });
    await revokeOwnConnection({ user: member, actor: member, reason: 'mine', origin: ORIGIN });
    await reconnectOwnConnection({ user: member, actor: member, origin: ORIGIN });

    // A member reconnecting must not undo an operator's decision from a page
    // that never mentions it.
    const routine = (await getRoutine(routineId))!;
    expect(routine.state).toBe('UNAVAILABLE');
    expect(routine.stateReason).toBe('drained for a provider migration');
  });

  it('refuses a reconnect on a connection nobody took back', async () => {
    await registerSurface(member);
    const outcome = await reconnectOwnConnection({ user: member, actor: member, origin: ORIGIN });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/has not been taken back/i);
  });

  it('offers the controls it can use and explains the ones it cannot', async () => {
    await registerSurface(member);
    await revokeOwnConnection({ user: member, actor: member, reason: 'mine', origin: ORIGIN });
    const view = await connectionView({ user: member, origin: ORIGIN });

    expect(control(view, 'RECONNECT').enabled).toBe(true);
    expect(control(view, 'REVOKE').enabled).toBe(false);
    expect(control(view, 'REVOKE').disabledReason).toBeTruthy();
    expect(control(view, 'SEND_PROBE').enabled).toBe(false);
    expect(control(view, 'SEND_PROBE').disabledReason).toMatch(/taken back/i);
    // Checking is always available, in every state, to everybody: a
    // verification somebody can be refused is one they stop trusting.
    expect(control(view, 'VERIFY').enabled).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe('only a verified connection is usable capacity', () => {
  it('names the refusal rather than reporting a bare count', async () => {
    await registerSurface(member);
    const capacity = await contributedCapacity();
    const mine = capacity.surfaces.find((one) => one.userId === member.id)!;
    expect(mine.usable).toBe(false);
    // The deployment variable, in a test process, is genuinely absent.
    expect(mine.because).toMatch(/not set in this deployment/i);
    expect(capacity.usable).toBe(0);
    expect(capacity.total).toBe(1);
  });

  it('refuses a revoked connection by name', async () => {
    await registerSurface(member);
    await revokeOwnConnection({ user: member, actor: member, reason: 'mine', origin: ORIGIN });
    const capacity = await contributedCapacity();
    expect(capacity.surfaces[0]!.usable).toBe(false);
    expect(capacity.surfaces[0]!.because).toMatch(/taken back/i);
  });

  it('never offers a member’s worker for repository work without a routing row', async () => {
    await registerSurface(member);
    const capacity = await contributedCapacity();
    // No `worker_routing` row exists for a research connection, and §27 is
    // explicit that no worker without one may ever be handed repository work.
    expect(capacity.surfaces[0]!.routing).toBeNull();
    expect(contributedForRepository(capacity, 'peyday007/v5')).toEqual([]);
    // And a repository nobody named resolves to nothing rather than everything.
    expect(contributedForRepository(capacity, null)).toEqual([]);
  });

  it('leaves out a capacity account that is nobody’s connection', async () => {
    // A Routine that exists and belongs to no member's connection is fleet
    // capacity and is not *contributed* capacity. Counting it here would make
    // this reading disagree with the one beside it, which is the defect the
    // fleet numbers already had once.
    const account = await createAccount({
      name: 'an-operator-account',
      kind: 'CAPACITY',
      planLabel: 'operator',
      declaredPlanPower: 'unknown',
    });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_01OPERATORROUTINEXXX',
      name: 'An operator surface',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN_OPERATOR',
      workerId: null,
    });
    const capacity = await contributedCapacity();
    expect(capacity.total).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('asking never moves anybody backwards', () => {
  it('records the ask and leaves a registered journey where it is', async () => {
    // An administrator issued a link without being asked for one, which is the
    // ordinary case: the ask stamp is still unclaimed afterwards, so the
    // control is offered to somebody who is already most of the way through.
    await registerSurface(member);
    const before = await connectionView({ user: member, origin: ORIGIN });
    expect(before.state).toBe('WAITING_FOR_ADMIN');
    expect(control(before, 'REQUEST_INVITATION').enabled).toBe(true);

    const asked = await requestConnectorInvitation({ user: member, origin: ORIGIN });
    expect(asked.ok).toBe(true);
    // The stamp is recorded, the journey is not rewound. A state that visibly
    // regresses and then corrects itself on the next read is a screen somebody
    // stops believing.
    expect((await connectionForUser(member.id))!.invitationRequestedAt).not.toBeNull();
    expect(asked.ok && asked.view.state).toBe('WAITING_FOR_ADMIN');
  });
});
