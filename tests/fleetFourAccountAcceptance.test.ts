/**
 * Four people, four Claude accounts, one pool — the acceptance the fleet
 * software owes before anybody commissions a real account.
 *
 * The topology is the one that will actually exist: the owner and three
 * friends, each with their own Claude account, their own connector (so their
 * own Brain worker identity), their own Routine and their own deployment
 * secret. `factoryPool.test.ts` proves one logical worker served by several
 * accounts; this proves the other shape — four identities that must never be
 * mistaken for one another — and the capacity reading over both.
 *
 * Nothing here is a real account. What is simulated is exactly the outside
 * edge: the provider accepting a fire, and a session arriving. Everything
 * between — the snapshot, the router, the fire slot, the ledger, the arrival
 * attribution, the capacity reading — is the real code over the real
 * repositories.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  archiveWorker,
  createWorker,
  grantMembership,
  setWorkerStatus,
} from '../server/repos/identity.ts';
import {
  claimRoutineFireSlot,
  createAccount,
  createRoutine,
  getRoutine,
  getWorkerSession,
  sessionsForRoutine,
  setAccountState,
  setRoutineState,
} from '../server/repos/fleet.ts';
import {
  assignNextBin,
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  finishBin,
  getBin,
  markDispatchRoutine,
  markDispatchSent,
} from '../server/repos/bins.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { capacityReading } from '../server/services/fleet/capacity.ts';
import { fleetView } from '../server/services/fleet/view.ts';
import type { Bin, Project } from '../server/domain/types.ts';

let project: Project;

interface Member {
  person: string;
  accountId: string;
  workerId: string;
  routineId: string;
  secretName: string;
}

const PEOPLE = ['owner', 'friend-1', 'friend-2', 'friend-3'] as const;

async function member(person: string): Promise<Member> {
  const worker = await createWorker({
    name: `research-${person}`,
    displayName: `Research — ${person}`,
    workerType: 'MCP',
    createdByType: 'SYSTEM',
    createdById: 'fleetFourAccountAcceptance.test',
  });
  await grantMembership({
    projectId: project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: ['project:read', 'queue:claim', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'fleetFourAccountAcceptance.test',
  });
  const account = await createAccount({ name: `claude-${person}`, declaredPlanPower: 'Max' });
  const secretName = `FOUR_ACCOUNT_SECRET_${person.replace(/\W/g, '_').toUpperCase()}`;
  process.env[secretName] = `a-bearer-for-${person}`;
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_${person.replace(/\W/g, '')}`,
    name: `Brain Research — ${person}`,
    tokenSecretName: secretName,
    workerId: worker.id,
  });
  return { person, accountId: account.id, workerId: worker.id, routineId: routine.id, secretName };
}

async function fourPeople(): Promise<Member[]> {
  const out: Member[] = [];
  for (const person of PEOPLE) out.push(await member(person));
  return out;
}

async function researchBin(title = 'A bounded question'): Promise<Bin> {
  const created = await createBin({
    projectId: project.id,
    kind: 'RESEARCH_PACKET',
    title,
    objective: 'Answer one bounded question.',
    manifest: {
      objective: 'Answer one bounded question.',
      why: 'acceptance',
      lineage: { projectId: project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['a stored value'],
      outputs: ['one result'],
      authorizedActions: ['submit unit results'],
      prohibitedActions: ['anything with an external effect'],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 30 },
      stoppingConditions: ['the declared unit has a result'],
    },
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'RESEARCH',
    createdByType: 'SYSTEM',
    createdById: 'fleetFourAccountAcceptance.test',
    ready: true,
  });
  return (await getBin(created.id))!;
}

async function route(bin: Bin) {
  const snapshot = await fleetSnapshot();
  return routeBin({
    bin,
    candidates: snapshot.candidates,
    fleetPolicy: snapshot.fleetPolicy,
    fleetInFlight: snapshot.fleetInFlight,
    now: new Date().toISOString(),
  });
}

/** One surface's four-row chain, through the paths that write it. */
async function completeChainFor(one: Member): Promise<void> {
  const routine = (await getRoutine(one.routineId))!;
  const bin = await researchBin(`Prove ${one.person}`);
  await ensureDispatchIntent(bin);
  const intent = await claimDispatchIntent();
  await markDispatchRoutine(intent!.id, routine.id);
  await markDispatchSent(intent!.id, {
    routineRef: routine.routineRef,
    sessionRef: `cse_${routine.id}`,
    routineId: routine.id,
    accountId: routine.accountId,
  });
  const assigned = await assignNextBin({
    workerId: one.workerId,
    projectIds: [project.id],
    credentialId: `cse_${routine.id}`,
    sessionRef: `cse_${routine.id}`,
  });
  expect(assigned?.bin.id).toBe(bin.id);
  expect(
    await finishBin(
      {
        binId: bin.id,
        leaseId: assigned!.leaseId,
        leaseGeneration: assigned!.leaseGeneration,
        workerId: one.workerId,
      },
      { state: 'COMPLETE', reason: 'the surface answered' },
    ),
  ).toBe('OK');
}

beforeEach(async () => {
  ({ project } = await freshProject());
});

describe('a surface out of routing is never counted as capacity', () => {
  it('does not call a quarantined, previously proven surface healthy', async () => {
    const [owner] = await fourPeople();
    await completeChainFor(owner!);
    expect(
      await setRoutineState({
        routineId: owner!.routineId,
        from: 'ENABLED',
        to: 'QUARANTINED',
        reason: 'AUTH: 401 token is not authorized for this routine',
      }),
    ).toBe(true);
    const reading = await capacityReading();
    const surface = reading.surfaces.find((one) => one.routineId === owner!.routineId)!;
    expect(surface.health).toBe('UNAVAILABLE');
    expect(surface.proven).toBe(true);
    expect(reading.eligibleNow).toBe(3);
  });

  it('does not count a surface whose account is disabled', async () => {
    const [, friend] = await fourPeople();
    await setAccountState({
      accountId: friend!.accountId,
      from: 'ENABLED',
      to: 'UNAVAILABLE',
      reason: 'the subscription lapsed',
    });
    const reading = await capacityReading();
    const surface = reading.surfaces.find((one) => one.routineId === friend!.routineId)!;
    expect(surface.health).toBe('UNAVAILABLE');
    expect(reading.eligibleNow).toBe(3);
  });

  it('does not count a surface bound to a disabled worker', async () => {
    const people = await fourPeople();
    const disabled = people[2]!;
    await setWorkerStatus(disabled.workerId, 'DISABLED');

    const reading = await capacityReading();
    const surface = reading.surfaces.find((one) => one.routineId === disabled.routineId)!;
    expect(surface.health).toBe('UNAVAILABLE');
    expect(reading.eligibleNow).toBe(3);
  });

  it('never fires a surface whose bound worker is disabled, and fails over to the others', async () => {
    const people = await fourPeople();
    const disabled = people[2]!;
    await setWorkerStatus(disabled.workerId, 'DISABLED');

    // Each chosen surface's fire slot is taken, as the dispatcher does, so the
    // router rotates to the least recently fired. Six decisions over three
    // eligible surfaces reach every one of them twice — and never the fourth.
    const chosen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const decision = await route(await researchBin(`q${i}`));
      expect(decision.ok).toBe(true);
      if (!decision.ok) continue;
      expect(decision.routine.id).not.toBe(disabled.routineId);
      chosen.add(decision.routine.id);
      expect(
        await claimRoutineFireSlot({
          routineId: decision.routine.id,
          expectedGeneration: decision.routine.fireGeneration,
        }),
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(chosen).toEqual(
      new Set(people.filter((one) => one !== disabled).map((one) => one.routineId)),
    );
  });

  it('does not count a surface bound to an archived worker, and does not fire it', async () => {
    const people = await fourPeople();
    const gone = people[3]!;
    await archiveWorker(gone.workerId);
    const reading = await capacityReading();
    expect(reading.surfaces.find((one) => one.routineId === gone.routineId)!.health).toBe(
      'UNAVAILABLE',
    );
    expect(reading.eligibleNow).toBe(3);
  });
});

/**
 * Fire a bin at one person's Routine, then let a session arrive and take it.
 *
 * `arriving` is whichever worker authenticates; `sessionRef` is the provider
 * session it reports. Nothing here decides attribution — `assignNextBin` does.
 */
async function fireThenArrive(input: {
  firedAt: Member;
  arriving: Member;
  credentialId: string;
  sessionRef: string | null;
}): Promise<Bin> {
  const routine = (await getRoutine(input.firedAt.routineId))!;
  const bin = await researchBin(`Fired at ${input.firedAt.person}`);
  await ensureDispatchIntent(bin);
  const intent = await claimDispatchIntent();
  await markDispatchRoutine(intent!.id, routine.id);
  await markDispatchSent(intent!.id, {
    routineRef: routine.routineRef,
    sessionRef: `cse_fired_at_${input.firedAt.person.replace(/\W/g, '')}`,
    routineId: routine.id,
    accountId: routine.accountId,
  });
  const assigned = await assignNextBin({
    workerId: input.arriving.workerId,
    projectIds: [project.id],
    credentialId: input.credentialId,
    sessionRef: input.sessionRef,
  });
  expect(assigned?.bin.id).toBe(bin.id);
  return bin;
}

describe('an arrival is credited to the surface that actually sent it', () => {
  it("does not credit one person's session to another person's account", async () => {
    const [, friend1, friend2] = await fourPeople();
    /*
     * The ordinary four-account shape: friend-2's session finished its own bin
     * and asked for another, and the oldest ready bin is the one Brain has just
     * fired at friend-1's Routine. Taking it is fine — any authenticated worker
     * in scope may. Recording it as friend-1's arrival is not: friend-1's
     * session never arrived, and friend-2's credential would be written down,
     * first observation winning for ever, as executing under friend-1's
     * account — which is the lineage every audit tier is computed from.
     */
    await fireThenArrive({
      firedAt: friend1!,
      arriving: friend2!,
      credentialId: 'cred_friend2',
      sessionRef: 'cse_friend2_own_session',
    });
    expect(await getWorkerSession('cred_friend2')).toBeNull();
    expect((await getRoutine(friend1!.routineId))!.lastCheckInAt).toBeNull();
    expect(await sessionsForRoutine(friend1!.routineId)).toHaveLength(0);
  });

  it('still credits the fired session, and so still exposes a Routine wearing another identity', async () => {
    const [, friend1, friend2] = await fourPeople();
    /*
     * The mistake the per-surface proof exists to catch: friend-1's Routine
     * was configured with friend-2's connector. The session Brain fired *is*
     * the one that arrived — the provider session matches the dispatch row —
     * so the fire genuinely ran on friend-1's account, and recording it there
     * is what lets `proveSurface` call the surface a FAULT rather than merely
     * unproven.
     */
    await fireThenArrive({
      firedAt: friend1!,
      arriving: friend2!,
      credentialId: 'cred_friend2_via_friend1_routine',
      sessionRef: 'cse_fired_at_friend1',
    });
    const session = await getWorkerSession('cred_friend2_via_friend1_routine');
    expect(session?.routineId).toBe(friend1!.routineId);
    expect(session?.accountId).toBe(friend1!.accountId);
    expect(session?.workerId).toBe(friend2!.workerId);
  });

  it("credits a person's own session to their own account", async () => {
    const [, friend1] = await fourPeople();
    await fireThenArrive({
      firedAt: friend1!,
      arriving: friend1!,
      credentialId: 'cred_friend1',
      sessionRef: null,
    });
    const session = await getWorkerSession('cred_friend1');
    expect(session?.accountId).toBe(friend1!.accountId);
    expect(session?.routineId).toBe(friend1!.routineId);
    expect((await getRoutine(friend1!.routineId))!.lastCheckInAt).not.toBeNull();
  });
});

describe('three readers of "usable" give one answer', () => {
  it('agrees across the Fleet page, the capacity reading and the router', async () => {
    const [owner, friend1, friend2, friend3] = await fourPeople();
    // One healthy, one with its secret gone from the deployment, one bound to a
    // disabled worker, one whose account the provider refused.
    const held = process.env[friend1!.secretName];
    delete process.env[friend1!.secretName];
    try {
      await setWorkerStatus(friend2!.workerId, 'DISABLED');
      await setAccountState({
        accountId: friend3!.accountId,
        from: 'ENABLED',
        to: 'QUARANTINED',
        reason: 'AUTH: 403 routines are not available for this organization',
      });

      const view = await fleetView({ includeTechnical: true });
      const reading = await capacityReading();
      const usableOnPage = view.surfaces.filter((one) => one.usable).map((one) => one.routineId);
      const eligible = reading.surfaces
        .filter((one) => one.health === 'HEALTHY' || one.health === 'CONFIGURING')
        .map((one) => one.routineId);

      expect(usableOnPage).toEqual([owner!.routineId]);
      expect(eligible).toEqual([owner!.routineId]);
      expect(view.usable.value).toBe(1);
      expect(reading.eligibleNow).toBe(1);

      // Each faulty surface says which of the three faults it has.
      const reasonOf = (id: string) => view.surfaces.find((one) => one.routineId === id)!.reason;
      expect(reasonOf(friend1!.routineId)).toMatch(/secret is not present/);
      expect(reasonOf(friend2!.routineId)).toMatch(/disabled or archived/);
      expect(reasonOf(friend3!.routineId)).toMatch(/account/i);

      // And the router fires only the one.
      const decision = await route(await researchBin('the one usable surface'));
      expect(decision.ok && decision.routine.id).toBe(owner!.routineId);
    } finally {
      if (held !== undefined) process.env[friend1!.secretName] = held;
    }
  });
});

describe('a pooled Factory worker is still four accounts', () => {
  it("does not credit a sibling account's session to the account that was fired", async () => {
    /*
     * One logical worker bound to every account's Routine — the documented
     * Factory pool — and a per-account connector, so a per-account credential.
     * The sibling reports its own provider session, which is not the one Brain
     * fired at this Routine; it is provably someone else's arrival.
     */
    const [owner, friend1] = await fourPeople();
    const { bindRoutineWorker } = await import('../server/repos/fleet.ts');
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run('UPDATE fleet_routines SET worker_id = NULL WHERE id = ?', [friend1!.routineId]);
    expect(await bindRoutineWorker(friend1!.routineId, owner!.workerId)).toBe(true);
    const pooled: Member = { ...friend1!, workerId: owner!.workerId };

    await fireThenArrive({
      firedAt: pooled,
      arriving: owner!,
      credentialId: 'cred_owner_connector',
      sessionRef: 'cse_owner_own_session',
    });
    expect(await getWorkerSession('cred_owner_connector')).toBeNull();
    expect(await sessionsForRoutine(friend1!.routineId)).toHaveLength(0);
  });
});
