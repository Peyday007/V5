/**
 * Whether Cash Mode may be started at all.
 *
 * Two counts, derived from rows, and both must be full. Nothing here starts
 * anything or grants anything — it is the reading the button is disabled
 * against, and a reading that said READY while a person could not actually get
 * in would be worse than no reading at all.
 *
 * **A member is READY when they can sign in**, which means holding at least one
 * live passkey. Not when a slot was created for them, and not when a link was
 * sent: both of those are things the administrator did, and neither is evidence
 * that the person on the other end has a device registered. An outstanding link
 * is reported as its own state so the administrator can see the difference
 * between "nobody has been invited" and "three people have been and one has not
 * finished".
 *
 * **A capacity account is HEALTHY when a surface under it has been proven**,
 * which is `surfaceProof`'s four rows — Brain fired it, a session arrived and
 * was attributed to the bound worker from that same dispatch row, it was
 * assigned a bin, and the bin completed. A registered Routine with a secret is
 * *configured*, not healthy, and §23's rule that a perfect configured block
 * over an empty observed one is a refusal rather than a pass is the whole
 * reason those are two different words here.
 *
 * **An account is not an execution surface, and reporting one number was a
 * label saying the wrong thing rather than a projection computing the wrong
 * answer.** The page read `1 / 4 HEALTHY` beside a fleet that reports four
 * eligible research Routines, and both were correct: production holds two real
 * accounts, of which one — `Brain Research A` — carries all four research
 * Routines and the other, `friend-2`, has its single Routine quarantined. So
 * one account is proven and four surfaces are eligible, and a reader with one
 * of those numbers in front of them has no way to know it is not the other.
 * §23 drew exactly this distinction and warned what happens to arithmetic that
 * ignores it: **an account holds a subscription allowance; a Routine is a fire
 * surface.** Both counts are reported now, each labelled as what it counts.
 *
 * The `required` figures stay and stop nothing — §32 removed the lock and the
 * counts kept their honesty. They are the topology the sprint was designed
 * around rather than a bar, which is why `mayStart` is read by nobody who can
 * refuse anything.
 *
 * Nothing private crosses. A member appears as a display name and a state, so
 * the Cash page can say `3 / 4 READY` without telling anybody who holds which
 * device, what they can reach, or whether they have an address.
 */
import { listUsers } from '../../repos/identity.ts';
import { countLivePasskeys, listEnrollments } from '../../repos/passkeys.ts';
import { listAccounts, listRoutines } from '../../repos/fleet.ts';
import { nowIso } from '../../repos/util.ts';

/** The topology the gate is measured against. Four people, four accounts. */
export const REQUIRED_MEMBERS = 4;
export const REQUIRED_CAPACITY_ACCOUNTS = 4;

export type MemberState = 'READY' | 'INVITED' | 'NOT_INVITED';

export interface MemberReadiness {
  userId: string;
  displayName: string;
  state: MemberState;
  /** Set only while a link is outstanding, so an administrator can chase it. */
  linkExpiresAt?: string;
}

export interface AccountReadiness {
  accountId: string;
  name: string;
  state: 'HEALTHY' | 'CONFIGURED' | 'UNAVAILABLE';
  /** Why it is not healthy, in words with a remedy in them. */
  because?: string;
  /** How many of this account's Routines Brain could fire right now. */
  eligibleSurfaces: number;
  /** Every Routine under it, so a quarantine is visible rather than implied. */
  surfaces: SurfaceReadiness[];
}

/**
 * One Routine, which is a fire surface rather than an allowance.
 *
 * `reason` is `fleet_routines.state_reason` — the provider's own words for
 * what refused the last fire. §29 records what it cost for that column to be
 * written on every quarantine and read by nothing: a fleet with no usable
 * surface showed `QUARANTINED` and offered nowhere to find out why.
 */
export interface SurfaceReadiness {
  routineId: string;
  name: string;
  state: string;
  /** Whether Brain could route a fire to it now. */
  eligible: boolean;
  /** Why not, when it is not. Only for a surface that is actually held back. */
  because?: string;
}

export interface CashReadiness {
  members: { ready: number; required: number; rows: MemberReadiness[] };
  capacity: {
    healthy: number;
    required: number;
    rows: AccountReadiness[];
    /**
     * Execution surfaces, which is the number the fleet reports and is not the
     * number of accounts. One account can carry four Routines, and four
     * accounts can carry one between them.
     */
    eligibleSurfaces: number;
    totalSurfaces: number;
  };
  /** The one question the button asks. */
  mayStart: boolean;
  /** What is still missing, for a person reading rather than counting. */
  blockedBy: string[];
}

export async function cashReadiness(): Promise<CashReadiness> {
  const now = nowIso();

  /*
   * People, not principals. A worker has no display name a person chose and is
   * not somebody who can enter the Brain, so the count is over `users` only.
   */
  const users = (await listUsers()).filter((user) => !user.disabledAt);
  const enrollments = await listEnrollments();

  const rows: MemberReadiness[] = [];
  for (const user of users) {
    const live = await countLivePasskeys(user.id);
    if (live > 0) {
      rows.push({ userId: user.id, displayName: user.displayName, state: 'READY' });
      continue;
    }
    const outstanding = enrollments.find(
      (one) => one.userId === user.id && !one.usedAt && !one.revokedAt && one.expiresAt > now,
    );
    rows.push({
      userId: user.id,
      displayName: user.displayName,
      state: outstanding ? 'INVITED' : 'NOT_INVITED',
      ...(outstanding ? { linkExpiresAt: outstanding.expiresAt } : {}),
    });
  }

  const ready = rows.filter((row) => row.state === 'READY').length;

  const accounts = await listAccounts();
  const routines = await listRoutines();
  const capacityRows: AccountReadiness[] = accounts
    /*
     * The verification fixtures are not capacity. They exist to be refused —
     * their secret is a sentinel that is never set — and counting them would
     * make the fleet look two accounts larger than it is.
     */
    .filter((account) => !account.name.startsWith('verify-hosted'))
    .map((account): AccountReadiness => {
      const mine = routines.filter((routine) => routine.accountId === account.id);
      const usable = mine.filter(
        (routine) => routine.state === 'ENABLED' && routine.workerId !== null,
      );
      /*
       * `totalFires > 0` with an arrival credited is the cheap reading of
       * surface proof available from these two tables. It is deliberately not
       * "a row exists": a Routine registered this morning with a secret and no
       * fire behind it is CONFIGURED, and saying HEALTHY would be the claim
       * §23 refuses.
       */
      const proven = usable.filter(
        (routine) => routine.totalFires > 0 && routine.consecutiveNoShows === 0,
      );
      const surfaces: SurfaceReadiness[] = mine.map((routine) => {
        const eligible = routine.state === 'ENABLED' && routine.workerId !== null;
        return {
          routineId: routine.id,
          name: routine.name,
          state: routine.state,
          eligible,
          ...(eligible
            ? {}
            : {
                /*
                 * The provider's own words where there are any, and never a
                 * paraphrase. A quarantine carries why the last fire was
                 * refused, and a screen that summarised it into "held back"
                 * would be the column §29 found nothing was reading.
                 */
                because:
                  routine.stateReason ??
                  (routine.workerId === null
                    ? 'bound to no worker, so nothing can be fired at it'
                    : `it is ${routine.state.toLowerCase()}`),
              }),
        };
      });
      const common = { eligibleSurfaces: usable.length, surfaces };
      if (proven.length > 0) {
        return { accountId: account.id, name: account.name, state: 'HEALTHY', ...common };
      }
      if (usable.length > 0) {
        return {
          accountId: account.id,
          name: account.name,
          state: 'CONFIGURED',
          because: 'registered and bound, but no fire has arrived and finished here yet',
          ...common,
        };
      }
      return {
        accountId: account.id,
        name: account.name,
        state: 'UNAVAILABLE',
        because:
          mine.length === 0
            ? 'no Routine is registered under this account'
            : 'its Routine is not enabled, or is bound to no worker',
        ...common,
      };
    });

  const healthy = capacityRows.filter((row) => row.state === 'HEALTHY').length;

  const blockedBy: string[] = [];
  if (ready < REQUIRED_MEMBERS) {
    blockedBy.push(`${REQUIRED_MEMBERS - ready} more member(s) need a passkey registered.`);
  }
  if (healthy < REQUIRED_CAPACITY_ACCOUNTS) {
    blockedBy.push(
      `${REQUIRED_CAPACITY_ACCOUNTS - healthy} more Claude capacity account(s) need a proven surface.`,
    );
  }

  return {
    members: { ready, required: REQUIRED_MEMBERS, rows },
    capacity: {
      healthy,
      required: REQUIRED_CAPACITY_ACCOUNTS,
      rows: capacityRows,
      eligibleSurfaces: capacityRows.reduce((total, row) => total + row.eligibleSurfaces, 0),
      totalSurfaces: capacityRows.reduce((total, row) => total + row.surfaces.length, 0),
    },
    mayStart: ready >= REQUIRED_MEMBERS && healthy >= REQUIRED_CAPACITY_ACCOUNTS,
    blockedBy,
  };
}
