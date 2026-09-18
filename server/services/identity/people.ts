/**
 * Who has actually joined this Brain.
 *
 * ---------------------------------------------------------------------------
 * The defect this file exists for
 * ---------------------------------------------------------------------------
 *
 * `cashReadiness` counted every `users` row that was not disabled, so the two
 * accounts `scripts/verify-hosted.ts` creates on every deploy — *Hosted
 * verification* and *Hosted verification owner* — were rendered on the product
 * surface as two of the four people the sprint was waiting for. They are not
 * people. They exist to be signed in as, refused, and forgotten, and their
 * presence in that list made the count meaningless in the one direction that
 * matters: it said more of the team had joined than had.
 *
 * The answer is a **declared** kind rather than a recognised name — migration
 * 065, following `projects.purpose` from 028. A name-prefix filter is a string
 * comparison standing in for a fact, and it stops working silently on the first
 * row somebody names differently.
 *
 * ---------------------------------------------------------------------------
 * What a person's state means
 * ---------------------------------------------------------------------------
 *
 * `READY` is **can sign in**, which is holding at least one live passkey. Not
 * "a slot exists" and not "a link was sent": both of those are things an
 * administrator did, and neither is evidence that the person on the other end
 * has a device registered. `INVITED` and `NOT_INVITED` are kept apart for the
 * same reason — *nobody has been asked yet* and *somebody was asked and has not
 * finished* have different remedies.
 *
 * Nothing private crosses. A name, a state, and whether this row is you. Not an
 * address, not a device, not what anybody can reach. An administrator sees the
 * outstanding links because chasing one is their job; nobody sees a token,
 * because the server does not hold one.
 *
 * It writes nothing.
 */
import { listUsers } from '../../repos/identity.ts';
import { countLivePasskeys, listEnrollments } from '../../repos/passkeys.ts';
import { nowIso } from '../../repos/util.ts';

export type MemberState = 'READY' | 'INVITED' | 'NOT_INVITED';

export interface PersonReading {
  userId: string;
  displayName: string;
  state: MemberState;
  /** Whether this row is the person reading the page. */
  isYou: boolean;
  /** Shown so somebody knows who to ask. Never a contact detail. */
  isBrainAdmin: boolean;
  /** Set only while a link is outstanding, so an administrator can chase it. */
  linkExpiresAt?: string;
}

export interface PeopleReading {
  /** Real human members, disabled ones excluded, system identities excluded. */
  people: PersonReading[];
  joined: number;
  invited: number;
  /**
   * Identities this reading deliberately left out, counted and named by kind.
   *
   * Reported rather than silently dropped: somebody asking *"where did Hosted
   * verification go"* must be able to find out, and a row that simply vanished
   * answers nothing. Administrator depth only.
   */
  excluded: { systemIdentities: number; disabledAccounts: number };
}

export async function peopleReading(viewerId: string | null): Promise<PeopleReading> {
  const now = nowIso();
  const all = await listUsers();
  const enrollments = await listEnrollments();

  const systemIdentities = all.filter((user) => user.kind !== 'PERSON').length;
  const disabledAccounts = all.filter(
    (user) => user.kind === 'PERSON' && user.disabledAt !== null,
  ).length;

  const people: PersonReading[] = [];
  for (const user of all) {
    if (user.kind !== 'PERSON') continue;
    if (user.disabledAt !== null) continue;

    const live = await countLivePasskeys(user.id);
    if (live > 0) {
      people.push({
        userId: user.id,
        displayName: user.displayName,
        state: 'READY',
        isYou: user.id === viewerId,
        isBrainAdmin: user.isBrainAdmin,
      });
      continue;
    }
    const outstanding = enrollments.find(
      (one) => one.userId === user.id && !one.usedAt && !one.revokedAt && one.expiresAt > now,
    );
    people.push({
      userId: user.id,
      displayName: user.displayName,
      state: outstanding ? 'INVITED' : 'NOT_INVITED',
      isYou: user.id === viewerId,
      isBrainAdmin: user.isBrainAdmin,
      ...(outstanding ? { linkExpiresAt: outstanding.expiresAt } : {}),
    });
  }

  return {
    people,
    joined: people.filter((one) => one.state === 'READY').length,
    invited: people.filter((one) => one.state === 'INVITED').length,
    excluded: { systemIdentities, disabledAccounts },
  };
}
