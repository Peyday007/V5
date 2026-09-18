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
}

export interface CashReadiness {
  members: { ready: number; required: number; rows: MemberReadiness[] };
  capacity: { healthy: number; required: number; rows: AccountReadiness[] };
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
    .map((account) => {
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
      if (proven.length > 0) {
        return { accountId: account.id, name: account.name, state: 'HEALTHY' as const };
      }
      if (usable.length > 0) {
        return {
          accountId: account.id,
          name: account.name,
          state: 'CONFIGURED' as const,
          because: 'registered and bound, but no fire has arrived and finished here yet',
        };
      }
      return {
        accountId: account.id,
        name: account.name,
        state: 'UNAVAILABLE' as const,
        because:
          mine.length === 0
            ? 'no Routine is registered under this account'
            : 'its Routine is not enabled, or is bound to no worker',
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
    capacity: { healthy, required: REQUIRED_CAPACITY_ACCOUNTS, rows: capacityRows },
    mayStart: ready >= REQUIRED_MEMBERS && healthy >= REQUIRED_CAPACITY_ACCOUNTS,
    blockedBy,
  };
}
