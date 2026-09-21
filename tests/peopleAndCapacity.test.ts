/**
 * Who counts as a person, what counts as capacity, and how a connection resumes.
 *
 * Three production defects, each of which read as healthy in every row and was
 * only visible from the screen:
 *
 *   * the two identities `scripts/verify-hosted.ts` creates on every deploy were
 *     rendered as two of the four people the sprint was waiting for;
 *   * the Cash page reported `1 / 4 HEALTHY` while `fleet show` — reading the
 *     dispatcher's own snapshot at the same instant — reported four eligible
 *     Routines, because one counted **accounts** and the other fires
 *     **Routines**;
 *   * an enrolled member had no self-contained way to connect their Claude
 *     account at all.
 *
 * The first two are proved here by constructing the exact production shape:
 * four research Routines under **one** account, beside a verification account
 * whose secret is the sentinel that is never deployed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  createCredentiallessUser,
  createUser,
  createWorker,
  getWorkerByName,
  grantMembership,
  setUserPin,
} from '../server/repos/identity.ts';
import { hashPin } from '../server/services/identity/pin.ts';
import {
  claimRoutineFireSlot,
  createAccount,
  createRoutine,
  getRoutine,
  listRoutines,
  setRoutineState,
} from '../server/repos/fleet.ts';
import { peopleReading } from '../server/services/identity/people.ts';
import { createMemberSlot } from '../server/services/identity/enrollment.ts';
import { addPasskey } from '../server/repos/passkeys.ts';
import { capacityReading, withoutDiagnostics } from '../server/services/fleet/capacity.ts';
import { cashReadiness } from '../server/services/cash/readiness.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import {
  connectionView,
  issueConnectorInvitation,
  namesFor,
  sendProbe,
  submitTrigger,
} from '../server/services/capacity/connection.ts';
import { connectionForUser } from '../server/repos/capacityConnections.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listBins } from '../server/repos/bins.ts';
import type { Project, User } from '../server/domain/types.ts';

const ORIGIN = 'https://brain.test.invalid';

let project: Project;
let owner: User;

async function person(displayName: string, email: string): Promise<User> {
  return createUser({
    email,
    displayName,
    password: 'a-password-that-is-long-enough',
    isBrainAdmin: false,
  });
}

/** The shape an enrolled member actually has: no address and no password. */
async function credentialless(displayName: string): Promise<User> {
  return createCredentiallessUser({
    email: null,
    displayName,
    createdByType: 'HUMAN',
    createdById: owner.id,
  });
}

/** A live device on an existing account, which is what makes a row `DEVICE`. */
async function enrolPasskey(userId: string): Promise<void> {
  await addPasskey({
    userId,
    credentialId: `cred-${userId}`,
    publicKey: 'a-public-key',
    algorithm: -7,
    signCount: 0,
    label: 'a device',
    originKind: 'ENROLLMENT',
  });
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

/* ------------------------------------------------------------------ people */

describe('a person is declared, never recognised by their name', () => {
  it('leaves the verification identities out of the real-member count', async () => {
    await person('Airyn', 'airyn@example.invalid');
    await person('Caleb', 'caleb@example.invalid');

    /*
     * Exactly what `verify-hosted.ts` creates, including the addresses. The
     * point is that the filter is `kind` rather than the display name: these
     * two would have been matched by a name filter *and* would be matched by
     * one, so the test that matters is the third row below.
     */
    await createUser({
      email: 'verification-member@brain.invalid',
      displayName: 'Hosted verification',
      password: 'a-password-that-is-long-enough',
      kind: 'SYSTEM',
    });
    await createUser({
      email: 'verification-owner@brain.invalid',
      displayName: 'Hosted verification owner',
      password: 'a-password-that-is-long-enough',
      kind: 'SYSTEM',
    });

    const reading = await peopleReading(owner.id);
    const names = reading.people.map((one) => one.displayName).sort();
    expect(names).toEqual(['Airyn', 'Caleb', 'Owner']);
    expect(reading.excluded.systemIdentities).toBe(2);
  });

  /**
   * The half a name filter cannot do.
   *
   * A real person whose display name happens to start with the fixture's
   * prefix, and a system identity whose name says nothing at all. A prefix
   * filter gets both of these wrong, in both directions, and the row says so.
   */
  it('is not fooled by what anybody is called', async () => {
    await person('Hosted verification of nothing', 'real@example.invalid');
    await createUser({
      email: 'machine@brain.invalid',
      displayName: 'Quietly a fixture',
      password: 'a-password-that-is-long-enough',
      kind: 'SYSTEM',
    });

    const reading = await peopleReading(null);
    const names = reading.people.map((one) => one.displayName).sort();
    expect(names).toEqual(['Hosted verification of nothing', 'Owner']);
    expect(reading.excluded.systemIdentities).toBe(1);
  });

  it('says who you are, without saying anything private about anybody', async () => {
    await person('Airyn', 'airyn@example.invalid');
    const reading = await peopleReading(owner.id);
    expect(reading.people.find((one) => one.displayName === 'Owner')?.isYou).toBe(true);
    expect(reading.people.find((one) => one.displayName === 'Airyn')?.isYou).toBe(false);
    // A name, a state, whether it is you, and whether they administer the
    // Brain. Nothing else is on the row at all.
    expect(JSON.stringify(reading.people)).not.toMatch(/@/);
  });

  /**
   * A slot nobody has filled, which is the only thing that is not READY.
   *
   * `createMemberSlot` is the row an invitation creates: no password, no
   * device, nothing to sign in with. Everything else in this suite is created
   * with a password, which is a real way in and is now counted as one.
   */
  it('counts a slot with no credential at all as not joined', async () => {
    // `createMemberSlot` issues the link as well as the row, so the honest
    // state is `INVITED` — asked and not finished. What matters here is that
    // it is not `READY` and that nothing about it is a credential.
    await createMemberSlot({ displayName: 'Vince', issuedByUserId: owner.id });
    const reading = await peopleReading(null);
    const vince = reading.people.find((one) => one.displayName === 'Vince');
    expect(vince?.state).toBe('INVITED');
    expect(vince?.signsInWith).toBe('NONE');
    expect(reading.joined).toBe(1); // the owner's password account, and not Vince
  });

  /**
   * The defect the live Brain demonstrated.
   *
   * `bootstrap.ts` writes the first administrator with a password and no
   * device, and this reading counted live passkeys only — so the one account
   * that can administer the Brain read `NOT_INVITED`, beside two people who
   * had enrolled. That is the member count wrong in the under-stating
   * direction, and the remedy is to derive `READY` from whether a credential
   * is live rather than from whether it is a device.
   */
  it('counts a password account as able to sign in, and says which credential', async () => {
    const reading = await peopleReading(owner.id);
    const row = reading.people.find((one) => one.displayName === 'Owner');
    expect(row?.state).toBe('READY');
    expect(row?.signsInWith).toBe('PASSWORD');
    expect(reading.joined).toBe(1);
  });

  /**
   * The same defect one credential along, and in the expensive direction.
   *
   * The ordinary human credential is a PIN now, and this reading enumerated
   * the ones it knew about — so a member who had just enrolled with a PIN read
   * `NOT_INVITED`, *a slot nobody has filled*. A reading that mis-describes an
   * account because a credential was added and not added here is the whole
   * reason `SignsInWith` is exhaustive.
   */
  it('counts a PIN account as joined, and names the credential the screen asks for', async () => {
    const member = await credentialless('Nadia');
    await setUserPin(member.id, await hashPin('418205'), { keepSessionId: null });
    const reading = await peopleReading(null);
    const row = reading.people.find((one) => one.displayName === 'Nadia');
    expect(row?.state).toBe('READY');
    expect(row?.signsInWith).toBe('PIN');
    // Never the digits, on the row or anywhere near it.
    expect(JSON.stringify(reading)).not.toMatch(/418205/);
  });

  /**
   * And the same reading, wrong in the direction that costs the most.
   *
   * Airyn and Caleb hold a passkey and nothing else, and the sign-in screen no
   * longer offers a device — so they cannot get in. Reported as `READY` that
   * is an administrator being told a locked-out person needs nothing, which is
   * worse than under-counting: nobody goes looking. `NOT_INVITED` would have
   * been wrong too, because they finished.
   */
  it('does not call somebody joined when the screen offers nothing they hold', async () => {
    const airyn = await credentialless('Airyn');
    await enrolPasskey(airyn.id);
    const reading = await peopleReading(null);
    const row = reading.people.find((one) => one.displayName === 'Airyn');
    expect(row?.state).toBe('NEEDS_A_NEW_LINK');
    expect(row?.signsInWith).toBe('DEVICE');
    expect(reading.joined).toBe(1); // the owner's password account, and not Airyn
  });

  /**
   * A PIN is what the product offers, so it is what the row says.
   *
   * The owner ends up holding a password *and* a PIN — the password reaches
   * `/recovery` and nothing else — and an account holding several credentials
   * has to be described by the one somebody would actually use.
   */
  it('names the PIN ahead of the password the recovery door still takes', async () => {
    await setUserPin(owner.id, await hashPin('730164'), { keepSessionId: null });
    const reading = await peopleReading(owner.id);
    const row = reading.people.find((one) => one.displayName === 'Owner');
    expect(row?.state).toBe('READY');
    expect(row?.signsInWith).toBe('PIN');
  });

  /**
   * And a name Brain *mints* from a display name must not carry one either.
   *
   * `namesFor` derives a connector name, a Routine name and a **deployment
   * secret's name** from it — and the third is visible to whoever sets it and
   * ends up in the app's own configuration. `bootstrap.ts` names the first
   * administrator after their address, so this was live: the secret would have
   * been `BRAIN_ROUTINE_TOKEN_ROSSERPEYTON_GMAIL_COM_…`.
   */
  it('never mints a connector, Routine or secret name out of an address', async () => {
    const owner = await createUser({
      email: 'rosser@example.invalid',
      displayName: 'rosser@example.invalid',
      password: 'a-password-that-is-long-enough',
      isBrainAdmin: true,
    });
    const names = namesFor(owner);
    expect(JSON.stringify(names)).not.toMatch(/@/);
    expect(names.secretName).not.toMatch(/EXAMPLE/);
    expect(names.connectorName).toContain('rosser');
  });

  /**
   * The owner's inbox was the label every member read.
   *
   * `bootstrap.ts` names the first administrator after the address it is
   * created with, so the name on this page *was* a contact detail — against
   * this module's own stated contract. The domain is dropped, which leaves the
   * row recognisable and leaves nothing anybody can write to.
   */
  it('never lets an address cross as a display name', async () => {
    await createUser({
      email: 'rosser@example.invalid',
      displayName: 'rosser@example.invalid',
      password: 'a-password-that-is-long-enough',
      isBrainAdmin: true,
    });
    const reading = await peopleReading(null);
    expect(reading.people.map((one) => one.displayName)).toContain('rosser');
    expect(JSON.stringify(reading.people)).not.toMatch(/@/);
  });
});

/* ---------------------------------------------------------------- capacity */

/**
 * The production shape, reproduced: four research Routines under one account.
 *
 * That topology is the whole reason the old reading was wrong by a factor of
 * four, so the test builds it rather than a convenient one.
 */
async function productionFleet(): Promise<{ accountId: string; workerId: string }> {
  const worker = await createWorker({
    name: 'shared-research-worker',
    displayName: 'Research',
    workerType: 'MCP',
    createdByType: 'SYSTEM',
    createdById: 'peopleAndCapacity.test',
  });
  await grantMembership({
    projectId: project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: ['project:read', 'queue:claim', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'peopleAndCapacity.test',
  });
  const account = await createAccount({ name: 'Brain Research A', declaredPlanPower: 'Max' });
  for (const name of ['Brain Research A', 'Brain Research 1-B', 'Brain Research 1-C', 'Brain Research 1-D']) {
    process.env[`SECRET_${name.replace(/\W/g, '_')}`] = 'a-bearer-that-is-present';
    await createRoutine({
      accountId: account.id,
      routineRef: `trig_${name.replace(/\W/g, '')}`,
      name,
      tokenSecretName: `SECRET_${name.replace(/\W/g, '_')}`,
      workerId: worker.id,
    });
  }

  // The verification fixtures, exactly as `verify-hosted.ts` registers them:
  // an account declared VERIFICATION whose secret is the sentinel that is
  // never deployed.
  const fixture = await createAccount({ name: 'verify-hosted-account-a', kind: 'VERIFICATION' });
  await createRoutine({
    accountId: fixture.id,
    routineRef: 'trig_verify_hosted_a',
    name: 'trig_verify_hosted_a',
    tokenSecretName: 'VERIFY_HOSTED_NEVER_SET',
  });

  return { accountId: account.id, workerId: worker.id };
}

describe('capacity is counted the way the dispatcher counts it', () => {
  it('agrees with the dispatcher about which surfaces are eligible', async () => {
    await productionFleet();
    const reading = await capacityReading();
    const snapshot = await fleetSnapshot();

    /*
     * The one authoritative definition. `fleetSnapshot().candidates` is what
     * `services/dispatch/loop.ts` routes over, so the page and the loop cannot
     * disagree about which surfaces exist — which is exactly what `1 / 4
     * HEALTHY` beside "4 eligible now" was.
     */
    expect(reading.eligibleNow).toBe(snapshot.candidates.length);
    expect(reading.eligibleNow).toBe(4);
  });

  it('counts Routines rather than accounts, which is what is actually fired', async () => {
    await productionFleet();
    const reading = await capacityReading();
    // Four surfaces under one account. The old reading called this one.
    expect(reading.surfaces.length).toBe(4);
    expect(new Set(reading.surfaces.map((one) => one.accountId)).size).toBe(1);
  });

  it('leaves the verification fixtures out entirely', async () => {
    await productionFleet();
    const reading = await capacityReading();
    expect(reading.surfaces.some((one) => one.accountName.startsWith('verify-hosted'))).toBe(false);
    // And it is the declared kind that does it, not the name: asking for them
    // brings them back.
    const withFixtures = await capacityReading({ includeVerification: true });
    expect(withFixtures.surfaces.length + withFixtures.unavailable).toBeGreaterThan(
      reading.surfaces.length,
    );
  });

  it('never reports a surface as healthy on configuration alone', async () => {
    await productionFleet();
    const reading = await capacityReading();
    // Four eligible, none proven: nothing Brain fired has arrived and finished
    // anything here. §23's rule that a perfect configured block over an empty
    // observed one is a refusal rather than a pass.
    expect(reading.proven).toBe(0);
    expect(reading.surfaces.every((one) => one.health === 'CONFIGURING')).toBe(true);
  });

  it('reports a registered surface with no deployed secret as waiting, not missing', async () => {
    const { workerId } = await productionFleet();
    const account = await createAccount({ name: 'a-new-members-account' });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_notdeployedyet',
      name: 'Brain Research — Airyn',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN_AIRYN_NOT_SET',
      workerId,
    });
    const reading = await capacityReading();
    const waiting = reading.surfaces.find((one) => one.name === 'Brain Research — Airyn');
    /*
     * The dispatcher drops it from `candidates` on purpose — spending a fire to
     * discover a missing secret is what §23 says not to do — so reading only
     * the candidate list would make a surface waiting on its administrator
     * *vanish* rather than read as waiting. That is the one thing this page
     * must not do.
     */
    expect(waiting?.health).toBe('WAITING');
    expect(waiting?.because).toMatch(/administrator/i);
  });

  it('separates retired surfaces from live ones without deleting them', async () => {
    await productionFleet();
    const routine = (await listRoutines()).find((one) => one.name === 'Brain Research 1-D')!;
    await setRoutineState({
      routineId: routine.id,
      from: 'ENABLED',
      to: 'RETIRED',
      reason: 'proof complete, surface out of active dispatch',
    });
    const reading = await capacityReading();
    expect(reading.surfaces.some((one) => one.name === 'Brain Research 1-D')).toBe(false);
    const historical = reading.historical.find((one) => one.name === 'Brain Research 1-D');
    expect(historical).toBeTruthy();
    expect(historical?.because).toMatch(/proof complete/);
  });

  it('names the target as a target rather than as a denominator', async () => {
    await productionFleet();
    const reading = await capacityReading();
    // Nobody has configured one here, and the honest answer is null rather than
    // a constant that makes four eligible surfaces read as one quarter of
    // something.
    expect(reading.target).toBeNull();
  });

  it('keeps every operator-depth field out of a member-facing reading', async () => {
    await productionFleet();
    const stripped = withoutDiagnostics(await capacityReading());
    const text = JSON.stringify(stripped);
    expect(stripped.surfaces.every((one) => one.detail === undefined)).toBe(true);
    // No trigger refs, no secret names, no worker ids.
    expect(text).not.toMatch(/trig_/);
    expect(text).not.toMatch(/SECRET_/);
    expect(text).not.toMatch(/wkr_/);
  });

  it('is the same reading Cash Mode would have shown', async () => {
    await productionFleet();
    const readiness = await cashReadiness();
    const direct = await capacityReading();
    expect(readiness.capacity.eligibleNow).toBe(direct.eligibleNow);
    expect(readiness.members.total).toBe((await peopleReading(null)).people.length);
  });
});

/* ------------------------------------------------------------- connection */

async function connectable(displayName: string, email: string): Promise<User> {
  const user = await person(displayName, email);
  await activate({
    projectId: project.id,
    ownerUserId: owner.id,
    actorUserId: owner.id,
    objective: 'The canonical mandate.',
  });
  return user;
}

describe('connecting a Claude account is durable and resumable', () => {
  it('assigns three names on the first read and never changes them', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    const first = await connectionView({ user, origin: ORIGIN });
    const second = await connectionView({ user, origin: ORIGIN });
    expect(first.connection.id).toBe(second.connection.id);
    expect(first.connection.connectorName).toBe(second.connection.connectorName);
    expect(first.connection.secretName).toBe(second.connection.secretName);
    // Reading it creates the row that names them and nothing else: no account,
    // no Routine, no worker, no credential and no fire.
    expect((await listRoutines()).length).toBe(0);
  });

  it('gives two people with the same display name two different names', async () => {
    const a = await person('Alex', 'alex1@example.invalid');
    const b = await person('Alex', 'alex2@example.invalid');
    expect(namesFor(a).secretName).not.toBe(namesFor(b).secretName);
    expect(namesFor(a).workerName).not.toBe(namesFor(b).workerName);
  });

  it('refuses anything that is not a trigger id, and never stores a credential', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    for (const bad of ['', 'not-a-trigger', 'sk-ant-api03-a-real-looking-credential', 'trig_']) {
      const outcome = await submitTrigger({ user, actor: user, triggerRef: bad, origin: ORIGIN });
      expect(outcome.ok).toBe(false);
    }
    expect((await connectionForUser(user.id))?.triggerRef ?? null).toBeNull();
  });

  it('registers exactly one surface however many times the same trigger arrives', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });

    const first = await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01AAAAAAAAAAAAAAAAAAAAAA',
      origin: ORIGIN,
    });
    expect(first.ok).toBe(true);

    const again = await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01AAAAAAAAAAAAAAAAAAAAAA',
      origin: ORIGIN,
    });
    /*
     * Idempotency means the effect is present after either call, not that the
     * second call does nothing. So the second submission succeeds and reports
     * the state the first produced.
     */
    expect(again.ok).toBe(true);
    expect((await listRoutines()).length).toBe(1);
    expect(again.ok && again.view.state).toBe('WAITING_FOR_ADMIN');
  });

  it('survives a refresh at whatever step it reached', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01BBBBBBBBBBBBBBBBBBBBBB',
      origin: ORIGIN,
    });

    // A fresh read is the refresh: nothing is held in memory between them.
    const resumed = await connectionView({ user, origin: ORIGIN });
    expect(resumed.state).toBe('WAITING_FOR_ADMIN');
    expect(resumed.connection.triggerRef).toBe('trig_01BBBBBBBBBBBBBBBBBBBBBB');
    expect(resumed.nextAction).toBeNull();
    expect(resumed.headline).toMatch(/waiting for an administrator/i);
  });

  it('refuses to fire a surface whose credential is not deployed', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01CCCCCCCCCCCCCCCCCCCCCC',
      origin: ORIGIN,
    });
    const outcome = await sendProbe({ user, actor: user, origin: ORIGIN });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/administrator sets/i);
    expect((await listBins({ states: ['READY'], limit: 50 })).length).toBe(0);
  });

  /**
   * The administrator's one action, and what it must *not* cost anybody.
   *
   * Setting the deployment variable is the whole of it. Neither person repeats
   * a step: the connection resumes from its own rows, and the trigger, the
   * account, the Routine and the worker are the ones already there.
   */
  it('resumes from rows once the administrator sets the variable', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01DDDDDDDDDDDDDDDDDDDDDD',
      origin: ORIGIN,
    });
    const waiting = await connectionForUser(user.id);
    expect(waiting?.state).toBe('WAITING_FOR_ADMIN');

    process.env[waiting!.secretName] = 'the-bearer-an-administrator-set';
    try {
      const resumed = await connectionView({ user, origin: ORIGIN });
      expect(resumed.state).toBe('CONFIGURED');
      expect(resumed.secretPresent).toBe(true);
      // Nothing was created a second time.
      expect((await listRoutines()).length).toBe(1);
      expect(resumed.connection.triggerRef).toBe('trig_01DDDDDDDDDDDDDDDDDDDDDD');
    } finally {
      delete process.env[waiting!.secretName];
    }
  });

  it('requires a probe before anything can be called healthy', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01EEEEEEEEEEEEEEEEEEEEEE',
      origin: ORIGIN,
    });
    const connection = await connectionForUser(user.id);
    process.env[connection!.secretName] = 'the-bearer-an-administrator-set';
    try {
      // Registered, bound, credential deployed. Every row a person could point
      // at says it is set up — and it is CONFIGURED rather than HEALTHY,
      // because nothing Brain fired has come back.
      const configured = await connectionView({ user, origin: ORIGIN });
      expect(configured.state).toBe('CONFIGURED');
      expect(configured.proven).toBeNull();

      const probe = await sendProbe({ user, actor: user, origin: ORIGIN });
      expect(probe.ok).toBe(true);
      expect(probe.ok && probe.view.state).toBe('PROBE_SENT');
      // Still not healthy. A bin waiting to be answered is a question, not a
      // reading.
      expect(probe.ok && probe.view.proven).toBeNull();

      // And pressing it again makes one bin, not two.
      const again = await sendProbe({ user, actor: user, origin: ORIGIN });
      expect(again.ok).toBe(true);
      const bins = await listBins({ states: ['READY'], limit: 50 });
      expect(bins.filter((bin) => bin.kind === 'DETERMINISTIC_CHECK').length).toBe(1);
    } finally {
      delete process.env[connection!.secretName];
    }
  });

  it('mints one worker identity for a member and rotates rather than accumulates', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    const first = await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    expect(first.ok).toBe(true);
    expect(first.ok && first.view.invitationUrl).toMatch(/\/oauth\/invite\//);

    const worker = await getWorkerByName(namesFor(user).workerName);
    expect(worker).toBeTruthy();

    const second = await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    expect(second.ok).toBe(true);
    // The same identity. Onboarding twice is a repair and a rotation rather
    // than an accumulation — `connectSite`'s property, at a new door.
    expect((await getWorkerByName(namesFor(user).workerName))?.id).toBe(worker?.id);
  });

  it('stores no credential of any shape on the connection', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01FFFFFFFFFFFFFFFFFFFFFF',
      origin: ORIGIN,
    });
    const row = await connectionForUser(user.id);
    // Every field on the row, as text. A trigger id and three names Brain
    // assigned; nothing that could be a bearer.
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/sk-ant/);
    expect(text).not.toMatch(/Bearer/i);
    expect(Object.keys(row!)).not.toContain('token');
    // And the registered Routine keeps only the *name* of the variable.
    const routine = await getRoutine(row!.routineId!);
    expect(routine?.tokenSecretName).toBe(row!.secretName);
  });

  /**
   * A different trigger is refused before anything is written.
   *
   * The first version wrote first and refused on a lost compare-and-swap, and
   * the swap was on the *state* rather than on the trigger — so a submission
   * naming a different id matched, succeeded, and replaced a recorded one while
   * the refusal could never fire. Once a Routine is registered that leaves the
   * connection and `fleet_routines.routine_ref` disagreeing, which is Brain
   * firing one surface while its own record names another.
   */
  it('refuses to replace a trigger it has already recorded', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01HHHHHHHHHHHHHHHHHHHHHH',
      origin: ORIGIN,
    });

    const replaced = await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01IIIIIIIIIIIIIIIIIIIIII',
      origin: ORIGIN,
    });
    expect(replaced.ok).toBe(false);
    expect(!replaced.ok && replaced.reason).toMatch(/already names a different trigger/i);

    // The row and the Routine still agree, which is the thing that matters.
    const row = await connectionForUser(user.id);
    expect(row?.triggerRef).toBe('trig_01HHHHHHHHHHHHHHHHHHHHHH');
    const routine = await getRoutine(row!.routineId!);
    expect(routine?.routineRef).toBe('trig_01HHHHHHHHHHHHHHHHHHHHHH');
  });

  /**
   * Claim, then act — the concurrent case, which an early return cannot cover.
   *
   * Two presses that both read a connection with no live probe. A version that
   * created the bin before the compare-and-swap would build two and then find
   * one of them had lost, which is two activations against one surface for one
   * question.
   */
  it('makes one probe bin when two presses race', async () => {
    const user = await connectable('Airyn', 'airyn@example.invalid');
    await issueConnectorInvitation({ user, actor: owner, origin: ORIGIN });
    await submitTrigger({
      user,
      actor: user,
      triggerRef: 'trig_01JJJJJJJJJJJJJJJJJJJJJJ',
      origin: ORIGIN,
    });
    const connection = await connectionForUser(user.id);
    process.env[connection!.secretName] = 'the-bearer-an-administrator-set';
    try {
      await connectionView({ user, origin: ORIGIN });
      const [a, b] = await Promise.all([
        sendProbe({ user, actor: user, origin: ORIGIN }),
        sendProbe({ user, actor: user, origin: ORIGIN }),
      ]);
      expect(a.ok && b.ok).toBe(true);

      /*
       * One bin that could ever be fired, and it is the one the connection
       * names. The loser's is retired rather than deleted — §5 — so it is still
       * in the table with its reason, and the assertion is about what is
       * *dispatchable* rather than about a row count. A count would have been
       * satisfied by deleting the evidence.
       */
      const probes = (await listBins({ limit: 100 })).filter(
        (bin) => bin.kind === 'DETERMINISTIC_CHECK',
      );
      const live = probes.filter((bin) => bin.state !== 'CANCELLED');
      expect(live.length).toBe(1);

      const after = await connectionForUser(user.id);
      expect(after?.probeBinId).toBe(live[0]!.id);

      // The loser's bin was never READY, so there was no instant at which two
      // probes for one surface could both have been dispatched.
      for (const retired of probes.filter((bin) => bin.state === 'CANCELLED')) {
        expect(retired.readyAt).toBeNull();
        expect(retired.terminalReason).toMatch(/concurrent request/i);
      }
    } finally {
      delete process.env[connection!.secretName];
    }
  });

  it('refuses a trigger another surface already holds', async () => {
    const airyn = await connectable('Airyn', 'airyn@example.invalid');
    const caleb = await person('Caleb', 'caleb@example.invalid');
    await issueConnectorInvitation({ user: airyn, actor: owner, origin: ORIGIN });
    await issueConnectorInvitation({ user: caleb, actor: owner, origin: ORIGIN });

    await submitTrigger({
      user: airyn,
      actor: airyn,
      triggerRef: 'trig_01GGGGGGGGGGGGGGGGGGGGGG',
      origin: ORIGIN,
    });
    const stolen = await submitTrigger({
      user: caleb,
      actor: caleb,
      triggerRef: 'trig_01GGGGGGGGGGGGGGGGGGGGGG',
      origin: ORIGIN,
    });
    expect(stolen.ok).toBe(false);
    expect(!stolen.ok && stolen.reason).toMatch(/already registered/i);
    expect((await listRoutines()).length).toBe(1);
  });
});

/* ------------------------------------------------------------ read purity */

describe('reading these pages changes nothing', () => {
  it('enqueues, claims, registers and fires nothing', async () => {
    await productionFleet();
    const user = await connectable('Airyn', 'airyn@example.invalid');
    const routinesBefore = (await listRoutines()).map((one) => `${one.id}:${one.totalFires}`);
    const binsBefore = (await listBins({ limit: 200 })).map((one) => `${one.id}:${one.state}`);

    await peopleReading(user.id);
    await capacityReading();
    await connectionView({ user, origin: ORIGIN });
    await cashReadiness();

    expect((await listRoutines()).map((one) => `${one.id}:${one.totalFires}`)).toEqual(
      routinesBefore,
    );
    expect((await listBins({ limit: 200 })).map((one) => `${one.id}:${one.state}`)).toEqual(
      binsBefore,
    );
  });

  it('leaves a fleet counter alone that only a real fire may advance', async () => {
    const { accountId } = await productionFleet();
    const routine = (await listRoutines()).find((one) => one.accountId === accountId)!;
    // One real fire, through the compare-and-swap that is the only thing in
    // this codebase allowed to advance the counter.
    expect(
      await claimRoutineFireSlot({
        routineId: routine.id,
        expectedGeneration: routine.fireGeneration,
      }),
    ).toBe(true);
    const after = (await getRoutine(routine.id))!.totalFires;
    expect(after).toBe(1);

    await capacityReading();
    await capacityReading();
    expect((await getRoutine(routine.id))!.totalFires).toBe(after);
  });
});
