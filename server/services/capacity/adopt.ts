/**
 * Saying that a surface this Brain already fires belongs to somebody.
 *
 * ---------------------------------------------------------------------------
 * The condition this answers
 * ---------------------------------------------------------------------------
 *
 * Production runs eighteen Routines across six accounts, and the four that do
 * most of the research — `Brain Research A`, `1-B`, `1-C`, `1-D` — were
 * registered on a terminal with `fleet register-routine` long before
 * `capacity_connections` existed. They are bound to a real worker, hold live
 * OAuth tokens, and have fired 350 times between them.
 *
 * Nothing linked any of that to a person. `connectionView` resolves a member's
 * worker by a name it derives from their display name, finds none, reads no
 * tokens and reports `NOT_STARTED` — so the owner of this Brain was shown *your
 * Claude account is not connected*, with a call to action, beside a Fleet page
 * listing twelve eligible surfaces. Two true readings of two different
 * questions, and the screen claimed the wrong one.
 *
 * ---------------------------------------------------------------------------
 * Why this is a person's decision and not a derivation
 * ---------------------------------------------------------------------------
 *
 * Because no row proves it. `services/identity/ownership.ts` already works this
 * out and says so in its opening paragraph: the approver on an
 * `oauth_authorization_codes` row is the human who *approved a grant*, which
 * §22 is emphatic is not the same as whose capacity it is — an administrator
 * can approve a connector for somebody else, which is what the consent screen
 * is for. So the only evidence that a pre-existing surface is a given person's
 * is that person saying so, and this is that saying, recorded.
 *
 * It is `declareHeld`'s shape one kernel along: a fact research cannot
 * establish, written by an authenticated person, attributed, and reversible.
 *
 * ---------------------------------------------------------------------------
 * What it may not do
 * ---------------------------------------------------------------------------
 *
 * It creates **no** account, Routine, worker, credential or token, and it can
 * neither register a surface nor mint one. Every guard below refuses rather
 * than repairs, and a refusal names what to do instead:
 *
 *   * a Routine that is retired, or bound to no worker, proves nothing about
 *     anybody — a binding is what this adopts, and there is none;
 *   * a Routine another live connection already names is **somebody else's**,
 *     and quietly moving it would be this surface's original defect wearing an
 *     audit row;
 *   * a connection that already names a Routine is not adopted over. Giving one
 *     back is `revokeOwnConnection`, which is the member's own decision and
 *     keeps its history.
 *
 * And nothing about authorization moves. `services/identity/policy.ts` still
 * decides what that worker may do, `fleet_routines` still decides what Brain
 * fires, and the independence floor still reads recorded lineage. What changes
 * is which surface a *screen* is describing.
 */
import {
  connectionForUser,
  ensureConnection,
  listConnections,
  moveConnection,
  setAdoptedSurface,
} from '../../repos/capacityConnections.ts';
import { getAccount, getRoutineByRef } from '../../repos/fleet.ts';
import { getUser, recordIdentityEvent } from '../../repos/identity.ts';
import { namesFor } from './connection.ts';
import type { CapacityConnection } from '../../domain/types.ts';

export type AdoptOutcome =
  | { ok: true; connection: CapacityConnection; alreadyAdopted: boolean }
  | { ok: false; reason: string };

/**
 * How the call reached Brain.
 *
 * §23's column pair, at a new transition: attribution is not authentication.
 * `BROWSER` is somebody signed in on a surface that authenticated them;
 * `SHELL` is a terminal, where reaching the shell is the authentication and
 * `--admin` names whose authority it carries. It defaults to the weaker,
 * unverifiable value, because Brain cannot check a channel and must never
 * assume the stronger one.
 */
export type AuthorityChannel = 'BROWSER' | 'SHELL';

export async function adoptSurface(input: {
  /** Whose connection this becomes. */
  userId: string;
  /** The `trig_…` reference of the Routine being claimed. */
  routineRef: string;
  /** The authenticated person whose authority this carries. */
  actorUserId: string;
  channel?: AuthorityChannel;
}): Promise<AdoptOutcome> {
  const user = await getUser(input.userId);
  if (!user) return { ok: false, reason: 'No such person.' };

  const routine = await getRoutineByRef(input.routineRef.trim());
  if (!routine) {
    return {
      ok: false,
      reason:
        `No registered Routine has the reference ${input.routineRef.trim()}. ` +
        'Register it with `fleet register-routine` first, or check the reference on the Fleet page.',
    };
  }
  if (routine.state === 'RETIRED') {
    return {
      ok: false,
      reason:
        `${routine.name} is retired, so nothing is fired at it. Adopting a surface Brain does ` +
        'not use would record a connection that cannot be proved.',
    };
  }
  if (!routine.workerId) {
    return {
      ok: false,
      reason:
        `${routine.name} is not bound to a worker, so there is no identity to adopt. ` +
        '`fleet bind-worker` is what records one, and it is an operator’s decision.',
    };
  }

  const existing = await connectionForUser(input.userId);
  if (existing && existing.routineId && existing.routineId !== routine.id) {
    return {
      ok: false,
      reason:
        'This person already has a surface recorded. Giving one back is theirs to do — the ' +
        'Revoke control on their own page — and it keeps its history rather than being ' +
        'overwritten here.',
    };
  }
  if (existing && existing.routineId === routine.id) {
    return { ok: true, connection: existing, alreadyAdopted: true };
  }

  /*
   * A surface belongs to one person.
   *
   * Read across every connection rather than trusting the caller, and a
   * revoked one does not count: giving a connection back is what makes its
   * surface available to be recorded against somebody else.
   */
  const claimed = (await listConnections()).find(
    (one) => one.routineId === routine.id && one.revokedAt === null,
  );
  if (claimed) {
    return {
      ok: false,
      reason:
        `${routine.name} is already recorded as somebody else’s connection. A surface belongs ` +
        'to one person, and moving it would be the defect this is repairing, with an audit row on it.',
    };
  }

  const names = namesFor(user);
  const connection =
    existing ??
    (await ensureConnection({
      userId: input.userId,
      connectorName: names.connectorName,
      routineName: names.routineName,
      secretName: names.secretName,
    }));

  /*
   * The Routine's own names, not the derived ones.
   *
   * An adopted surface already has a name, a trigger reference and a
   * deployment secret that an administrator set, and rewriting any of them to
   * what `namesFor` would have produced would point the screen at a variable
   * nothing reads. The derived names stay on the row for a connection that was
   * never adopted; this replaces them where the real ones exist.
   */
  const account = await getAccount(routine.accountId);
  const written = await setAdoptedSurface({
    connectionId: connection.id,
    accountId: routine.accountId,
    routineId: routine.id,
    workerId: routine.workerId,
    routineName: routine.name,
    secretName: routine.tokenSecretName,
    triggerRef: routine.routineRef,
  });
  if (!written) {
    // Somebody else's call got there first. An ordinary outcome: read the row
    // back and report what it says rather than racing it.
    const now = await connectionForUser(input.userId);
    return now && now.routineId === routine.id
      ? { ok: true, connection: now, alreadyAdopted: true }
      : { ok: false, reason: 'That connection changed while this was being recorded. Read it again.' };
  }

  /*
   * `CONFIGURED`, and never `HEALTHY`.
   *
   * §32 and §23 both: registered-with-a-credential is configured, and healthy
   * is the four-row chain — Brain fired it, a session arrived and was
   * attributed to the bound worker from that same dispatch row, it was handed
   * a bin, and the bin reached COMPLETE. `reconcile` reads that chain on the
   * next view and promotes the row by itself. Writing HEALTHY here would be a
   * claim rather than a reading, from a person's say-so.
   */
  const fresh = await connectionForUser(input.userId);
  if (fresh && fresh.state !== 'CONFIGURED' && fresh.state !== 'HEALTHY') {
    await moveConnection({ connectionId: fresh.id, from: fresh.state, to: 'CONFIGURED' });
  }

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: input.actorUserId,
    action: 'ADOPT_CAPACITY_SURFACE',
    targetType: 'WORKER',
    targetId: routine.workerId,
    result: 'SUCCESS',
    metadata: {
      connectionId: connection.id,
      forUserId: input.userId,
      routineId: routine.id,
      routineRef: routine.routineRef,
      accountName: account?.name ?? null,
      // How the call got in, never assumed to be the stronger one.
      authorityChannel: input.channel ?? 'SHELL',
    },
  });

  const after = (await connectionForUser(input.userId)) ?? connection;
  return { ok: true, connection: after, alreadyAdopted: false };
}
