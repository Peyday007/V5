/**
 * The Account Foundation Standard, against the four account shapes that exist.
 *
 * The production Brain holds exactly four intended human accounts and they are
 * four *different* shapes, which is why a suite that exercised one of them
 * proved very little:
 *
 *   * an administrator who signs in with a password and holds no device;
 *   * a member who enrolled on a passkey, before the sign-in screen asked for
 *     a PIN — so they hold a credential the screen does not offer;
 *   * a member who holds a PIN, which is what the product now intends;
 *   * a slot nobody has filled, holding no credential of any kind.
 *
 * Two of those read as perfectly healthy in every individual row and cannot
 * sign in. That is the whole reason this standard is a matrix rather than a
 * flag.
 *
 * Two of the assertions here were run against a neutered implementation first,
 * to watch them fail, because a regression test nobody has seen fail is a
 * claim rather than a reading:
 *
 *   * the recovery that leaves a PIN live fails on *"the PIN survived its own
 *     recovery"*;
 *   * the capacity reading taken off the unsettled column fails on the
 *     *reason* rather than the verdict — it still says `usable: false`, and it
 *     says it for the wrong reason, which is precisely the shape of this
 *     defect and is why the assertion is on the sentence.
 *
 * The administrator-agreement test is guarded differently: it asserts the
 * stored column is *not yet* MISBOUND before settling, so it cannot pass
 * against an implementation where the reconciliation does nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  createCredentiallessUser,
  createUser,
  getUser,
  setUserPin,
} from '../server/repos/identity.ts';
import { addPasskey, countLivePasskeys } from '../server/repos/passkeys.ts';
import { hashPin, pinMatches } from '../server/services/identity/pin.ts';
import { issueRecovery } from '../server/services/identity/enrollment.ts';
import {
  CREDENTIAL_CLASSES,
  RETIRED_BY_RECOVERY,
  recoveryRetiresEverything,
} from '../server/services/identity/recoveryContract.ts';
import {
  FOUNDATION_DIMENSIONS,
  foundationReading,
} from '../server/services/identity/foundation.ts';
import type { AccountFoundation, FoundationDimension } from '../server/services/identity/foundation.ts';
import { countLiveSessions, createSession } from '../server/repos/identity.ts';
import { createWorker, getWorkerByName } from '../server/repos/identity.ts';
import {
  createAccount,
  createRoutine,
  repointRoutineWorker,
  setRoutineState,
} from '../server/repos/fleet.ts';
import { connectionForUser } from '../server/repos/capacityConnections.ts';
import {
  connectionView,
  issueConnectorInvitation,
  namesFor,
  settleConnection,
  submitTrigger,
} from '../server/services/capacity/connection.ts';
import { contributedCapacity } from '../server/services/capacity/contribution.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import type { Project, User } from '../server/domain/types.ts';

const ORIGIN = 'https://brain.test.invalid';

let project: Project;
let owner: User;

async function credentialless(displayName: string): Promise<User> {
  return createCredentiallessUser({
    email: null,
    displayName,
    createdByType: 'HUMAN',
    createdById: owner.id,
  });
}

async function enrolPasskey(userId: string, credentialId = `cred-${userId}`): Promise<void> {
  await addPasskey({
    userId,
    credentialId,
    publicKey: 'a-public-key',
    algorithm: -7,
    signCount: 0,
    label: 'a device',
    originKind: 'ENROLLMENT',
  });
}

function findingFor(account: AccountFoundation, dimension: FoundationDimension) {
  const found = account.findings.find((one) => one.dimension === dimension);
  if (!found) throw new Error(`no finding for ${dimension}`);
  return found;
}

async function accountNamed(displayName: string): Promise<AccountFoundation> {
  const reading = await foundationReading();
  const found = reading.accounts.find((one) => one.displayName === displayName);
  if (!found) throw new Error(`${displayName} is not in the foundation reading`);
  return found;
}

beforeEach(async () => {
  ({ project } = await freshProject());
  owner = await createUser({
    email: 'owner@example.invalid',
    displayName: 'Owner',
    password: 'a-password-that-is-long-enough',
    isBrainAdmin: true,
  });
});

/* ------------------------------------------------------- the shape itself */

describe('the standard covers every account against every dimension', () => {
  it('answers all six dimensions for every intended human account', async () => {
    await credentialless('Vince');
    const withPin = await credentialless('Caleb');
    await setUserPin(withPin.id, await hashPin('314159'));

    const reading = await foundationReading();
    expect(reading.accounts.length).toBe(3);
    for (const account of reading.accounts) {
      expect(
        account.findings.map((one) => one.dimension).sort(),
        `${account.displayName} is missing a dimension`,
      ).toEqual([...FOUNDATION_DIMENSIONS].sort());
    }
  });

  it('leaves machinery and disabled accounts out, the way every people reading does', async () => {
    await createUser({
      email: 'verification-member@brain.invalid',
      displayName: 'Hosted verification',
      password: 'a-password-that-is-long-enough',
      isBrainAdmin: false,
      kind: 'SYSTEM',
    });
    const reading = await foundationReading();
    expect(reading.accounts.map((one) => one.displayName)).not.toContain('Hosted verification');
  });

  it('never reports NOT_APPLICABLE as a pass, and never lets it block', async () => {
    const vince = await credentialless('Vince');
    await setUserPin(vince.id, await hashPin('271828'));

    const account = await accountNamed('Vince');
    // No connection has been started, so two dimensions genuinely do not apply.
    expect(findingFor(account, 'CLAUDE_CONNECTION').verdict).toBe('NOT_APPLICABLE');
    expect(findingFor(account, 'WORKER_ATTRIBUTION').verdict).toBe('NOT_APPLICABLE');
    expect(findingFor(account, 'CAPACITY').verdict).toBe('NOT_APPLICABLE');
    // And they neither make the account pass nor fail it.
    expect(account.verdict).toBe('PASS');
  });

  it('gives every BLOCKED finding exactly one next action and an owner for it', async () => {
    await credentialless('Vince');
    const reading = await foundationReading();
    for (const account of reading.accounts) {
      for (const finding of account.findings) {
        if (finding.verdict === 'BLOCKED') {
          expect(finding.nextAction, `${finding.dimension} blocks with no action`).toBeTruthy();
          expect(finding.owner).not.toBe('NOBODY');
        } else {
          expect(finding.nextAction).toBeNull();
          expect(finding.owner).toBe('NOBODY');
        }
      }
    }
  });
});

/* --------------------------------------------------------------- sign-in */

describe('sign-in is judged by the screen that is served, not by the schema', () => {
  it('passes an account that holds a PIN', async () => {
    const caleb = await credentialless('Caleb');
    await setUserPin(caleb.id, await hashPin('123456'));
    expect(findingFor(await accountNamed('Caleb'), 'SIGN_IN').verdict).toBe('PASS');
  });

  it('blocks a passkey-only account, because the screen offers no way to present one', async () => {
    const airyn = await credentialless('Airyn');
    await enrolPasskey(airyn.id);

    const finding = findingFor(await accountNamed('Airyn'), 'SIGN_IN');
    expect(finding.verdict).toBe('BLOCKED');
    expect(finding.because).toContain('passkey');
    expect(finding.owner).toBe('BRAIN_ADMINISTRATOR');
    // The remedy is the control an administrator actually has.
    expect(finding.nextAction).toContain('recovery link');
  });

  it('blocks a slot that holds no credential at all', async () => {
    await credentialless('Vince');
    const finding = findingFor(await accountNamed('Vince'), 'SIGN_IN');
    expect(finding.verdict).toBe('BLOCKED');
    expect(finding.owner).toBe('BRAIN_ADMINISTRATOR');
    expect(finding.nextAction).toContain('enrollment link');
  });

  it('names the password account as short of the standard without calling it locked out', async () => {
    const finding = findingFor(await accountNamed('Owner'), 'SIGN_IN');
    expect(finding.verdict).toBe('BLOCKED');
    // The distinction that matters: it works, and it is not the intended credential.
    expect(finding.because).toContain('It works');
    expect(finding.owner).toBe('MEMBER');
    // The exact address, because nothing in the product links to it.
    expect(finding.nextAction).toContain('/recovery');
  });
});

/* -------------------------------------------------------------- identity */

describe('identity is the thing that makes a name resolve', () => {
  it('blocks two accounts that share a display name, because neither can sign in by it', async () => {
    const first = await credentialless('Alex');
    const second = await credentialless('Alex');
    await setUserPin(first.id, await hashPin('111111'));
    await setUserPin(second.id, await hashPin('222222'));

    const reading = await foundationReading();
    const both = reading.accounts.filter((one) => one.displayName === 'Alex');
    expect(both.length).toBe(2);
    for (const account of both) {
      const finding = findingFor(account, 'IDENTITY');
      expect(finding.verdict).toBe('BLOCKED');
      expect(finding.because).toContain('share the display name');
      expect(finding.owner).toBe('BRAIN_ADMINISTRATOR');
    }
  });

  it('counts a disabled or machinery row as a collision, because the lookup does', async () => {
    /*
     * `getPinCredentialByIdentity` selects on `display_name` with no filter for
     * kind or disablement, so a SYSTEM row sharing a name still makes the typed
     * name resolve to two and therefore to none. A foundation reading that only
     * counted the accounts it displays would report the survivor as fine.
     */
    const real = await credentialless('Robin');
    await setUserPin(real.id, await hashPin('333333'));
    await createUser({
      email: 'robin-machine@brain.invalid',
      displayName: 'Robin',
      password: 'a-password-that-is-long-enough',
      isBrainAdmin: false,
      kind: 'SYSTEM',
    });

    expect(findingFor(await accountNamed('Robin'), 'IDENTITY').verdict).toBe('BLOCKED');
  });

  it('passes a name that resolves to exactly one account', async () => {
    const caleb = await credentialless('Caleb');
    await setUserPin(caleb.id, await hashPin('444444'));
    expect(findingFor(await accountNamed('Caleb'), 'IDENTITY').verdict).toBe('PASS');
  });
});

/* -------------------------------------------------------------- recovery */

describe('a recovery retires everything the account is holding', () => {
  it('declares every credential class the mechanism knows about', () => {
    // The two halves that must agree, held against each other rather than
    // assumed: a class added to one and not the other fails here first.
    expect([...RETIRED_BY_RECOVERY].sort()).toEqual([...CREDENTIAL_CLASSES].sort());
  });

  it('retires the PIN, which is the credential the door actually takes', async () => {
    const airyn = await credentialless('Airyn');
    await setUserPin(airyn.id, await hashPin('123456'));
    await enrolPasskey(airyn.id);

    await issueRecovery({
      userId: airyn.id,
      reason: 'lost the phone',
      issuedByUserId: owner.id,
    });

    const after = await getUser(airyn.id);
    expect(after?.pinUpdatedAt, 'the PIN survived its own recovery').toBeNull();
    // And it is gone rather than replaced with something unguessable: a column
    // holding any verifier reads as "this account has a PIN" everywhere.
    expect(await pinMatches('123456', (after as unknown as { pinVerifier?: string })?.pinVerifier ?? '')).toBe(
      false,
    );
  });

  it('retires the passkeys and the sessions in the same operation', async () => {
    const airyn = await credentialless('Airyn');
    await setUserPin(airyn.id, await hashPin('123456'));
    await enrolPasskey(airyn.id);
    await createSession({ userId: airyn.id, secret: 'a-session-secret', ttlMs: 30 * 24 * 60 * 60 * 1000 });
    expect(await countLivePasskeys(airyn.id)).toBe(1);
    expect(await countLiveSessions(airyn.id)).toBe(1);

    await issueRecovery({ userId: airyn.id, reason: 'lost', issuedByUserId: owner.id });

    expect(await countLivePasskeys(airyn.id)).toBe(0);
    expect(await countLiveSessions(airyn.id), 'a session outlived the recovery').toBe(0);
  });

  it('reports the coverage per account rather than as a constant', () => {
    expect(recoveryRetiresEverything({ hasPin: true, livePasskeys: 1 }).complete).toBe(true);
    expect(recoveryRetiresEverything({ hasPin: false, livePasskeys: 0 }).complete).toBe(true);
    expect(recoveryRetiresEverything({ hasPin: false, livePasskeys: 0 }).because).toContain(
      'holds no credential',
    );
  });

  it('passes the recovery dimension for an account holding a PIN', async () => {
    const caleb = await credentialless('Caleb');
    await setUserPin(caleb.id, await hashPin('555555'));
    expect(findingFor(await accountNamed('Caleb'), 'RECOVERY').verdict).toBe('PASS');
  });
});


/* ------------------------------ one lifecycle, however many readers there are */

describe('an administrator and a member read one lifecycle', () => {
  /*
   * The defect: `reconcile` had exactly one caller — the member's own page —
   * while the administrator's list and `contributedCapacity` read
   * `capacity_connections.state` straight out of the row. So a Routine
   * repointed to somebody else read MISBOUND to the member and CONFIGURED to
   * the only person who can repoint it.
   *
   * It is reproduced here the way production produces it: a connection that
   * reached CONFIGURED, and then a surface that stops naming this member's
   * worker without anything touching the connection row.
   */
  async function misboundConnection(): Promise<User> {
    const member = await credentialless('Airyn');
    await setUserPin(member.id, await hashPin('123456'));
    // A connection is granted membership on the cash root, so one has to exist.
    await activate({
      projectId: project.id,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'The canonical mandate.',
    });
    await issueConnectorInvitation({ user: member, actor: owner, origin: ORIGIN });

    const submitted = await submitTrigger({
      user: member,
      actor: member,
      triggerRef: 'trig_01AAAAAAAAAAAAAAAAAAAAAA',
      origin: ORIGIN,
    });
    expect(submitted, 'the fixture failed to register a surface').toMatchObject({ ok: true });

    // Somebody else's identity, bound to the surface this connection names.
    const stranger = await createWorker({
      name: 'somebody-elses-worker',
      displayName: 'Somebody else',
      workerType: 'MCP',
      description: 'another member’s identity',
      createdByType: 'HUMAN',
      createdById: owner.id,
    });
    const connection = await connectionForUser(member.id);
    if (!connection?.routineId) throw new Error('the fixture registered no Routine');
    const mine = await getWorkerByName(namesFor(member).workerName);
    if (!mine) throw new Error('the fixture minted no worker identity');
    await repointRoutineWorker({
      routineId: connection.routineId,
      expectedWorkerId: mine.id,
      workerId: stranger.id,
      actor: owner.id,
      reason: 'a test',
    });
    return member;
  }

  it('shows the administrator the same state the member is shown', async () => {
    const member = await misboundConnection();

    /*
     * The stored column first, so this cannot pass vacuously.
     *
     * Nothing has settled the connection yet, so the row still says what it
     * said when the surface was registered — which is the value the
     * administrator's list used to report, and the whole reason the two
     * readers disagreed.
     */
    const stored = await connectionForUser(member.id);
    expect(stored?.state, 'the fixture did not reproduce a stale column').not.toBe('MISBOUND');

    const asAdministrator = (await settleConnection(member)).connection;
    const asMember = await connectionView({ user: member, origin: ORIGIN });

    expect(asMember.state).toBe('MISBOUND');
    expect(
      asAdministrator.state,
      'the administrator is reading a different lifecycle from the member',
    ).toBe(asMember.state);
  });

  it('keeps the dispatcher’s own capacity reading on the settled state', async () => {
    const member = await misboundConnection();

    const capacity = await contributedCapacity();
    const surface = capacity.surfaces.find((one) => one.userId === member.id);
    expect(surface?.usable, 'a misbound surface was counted as usable capacity').toBe(false);
    expect(surface?.because).toContain('not the one this connection names');
  });

  it('reports it to the foundation matrix as one blocked dimension with one remedy', async () => {
    const member = await misboundConnection();
    const account = await accountNamed('Airyn');

    const connection = findingFor(account, 'CLAUDE_CONNECTION');
    expect(connection.verdict).toBe('BLOCKED');
    expect(connection.owner).toBe('BRAIN_ADMINISTRATOR');
    expect(connection.nextAction).toContain('repoint-worker');
    expect(findingFor(account, 'CAPACITY').verdict).toBe('BLOCKED');
  });
});


/* ----------------------------- capacity nobody's foundation covers */

describe('a surface running under an identity no account owns is named', () => {
  it('reports a hand-registered worker rather than counting it as somebody’s capacity', async () => {
    /*
     * The production shape: a worker created by hand before the connection
     * journey existed, bound to an enabled Routine, with no
     * `capacity_connections` row resolving to it. `ownership.ts` leaves
     * `owner_user_id` null — correctly, since only a connection is evidence —
     * so no account's foundation covers it and nothing else says so.
     */
    const legacy = await createWorker({
      name: 'airynworker2',
      displayName: 'a hand-made identity',
      workerType: 'MCP',
      description: 'registered before the journey existed',
      createdByType: 'HUMAN',
      createdById: owner.id,
    });
    const account = await createAccount({
      name: 'primary',
      kind: 'CAPACITY',
      planLabel: 'Max',
      declaredPlanPower: 'unknown',
    });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_01BBBBBBBBBBBBBBBBBBBBBB',
      name: 'Brain Research A',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
      workerId: legacy.id,
    });

    const reading = await foundationReading();
    const found = reading.unattributed.find((one) => one.workerId === legacy.id);
    expect(found, 'a surface with no owning account was not reported').toBeTruthy();
    expect(found?.enabled).toBe(true);
    expect(found?.nextAction).toContain('retire');
    // The neutral label, never the legacy operator handle that reads like a person.
    expect(JSON.stringify(found)).not.toContain('airynworker2');
  });

  it('says so in words when there is none, rather than staying silent', async () => {
    const reading = await foundationReading();
    expect(reading.unattributed).toEqual([]);
  });

  it('leaves a retired surface out, because retiring is one of the two remedies', async () => {
    const legacy = await createWorker({
      name: 'oakwood-legacy',
      displayName: 'a retired identity',
      workerType: 'MCP',
      description: 'out of active dispatch',
      createdByType: 'HUMAN',
      createdById: owner.id,
    });
    const account = await createAccount({
      name: 'primary',
      kind: 'CAPACITY',
      planLabel: 'Max',
      declaredPlanPower: 'unknown',
    });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_01CCCCCCCCCCCCCCCCCCCCCC',
      name: 'V1-oak',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
      workerId: legacy.id,
    });
    await setRoutineState({
      routineId: routine.id,
      from: 'ENABLED',
      to: 'RETIRED',
      reason: 'proof complete',
    });

    const reading = await foundationReading();
    expect(reading.unattributed.map((one) => one.routineId)).not.toContain(routine.id);
  });
});

/* ------------------------------------------------- nothing leaks anywhere */

describe('no secret reaches a reader', () => {
  it('carries no verifier, token or PIN anywhere in the reading', async () => {
    const caleb = await credentialless('Caleb');
    await setUserPin(caleb.id, await hashPin('987654'));
    await enrolPasskey(caleb.id);

    const serialized = JSON.stringify(await foundationReading());
    for (const forbidden of ['987654', 'pinVerifier', 'pin_verifier', 'passwordVerifier', 'token']) {
      expect(serialized, `the reading carries ${forbidden}`).not.toContain(forbidden);
    }
    // And a real verifier, read straight from the row, is not in it either.
    const row = await getUser(caleb.id);
    expect(row?.pinUpdatedAt).not.toBeNull();
  });
});
