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
 * `READY` is **can sign in**, and it is derived from whether a live credential
 * exists rather than from a device. Not "a slot exists" and not "a link was
 * sent": both of those are things an administrator did, and neither is evidence
 * that the person on the other end can get in. `INVITED` and `NOT_INVITED` are
 * kept apart for the same reason — *nobody has been asked yet* and *somebody
 * was asked and has not finished* have different remedies.
 *
 * **A passkey is not the only credential, and counting only passkeys was wrong
 * in the same direction as counting the verification rows.** The live Brain's
 * own administrator — the row `bootstrap.ts` writes, holding a password and no
 * device — read `NOT_INVITED` here: the one account that can administer this
 * Brain, reported as a slot nobody has filled. That is the member count wrong
 * in the *under*-stating direction, which is the shape §29 cares about, so the
 * reading asks whether any credential is live and `signsInWith` says which. The
 * enrollment journey only ever applies to `DEVICE`, so the distinction has to
 * travel rather than be inferred from a blank.
 *
 * Nothing private crosses. A name, a state, how they sign in, and whether this
 * row is you. Not a device, not what anybody can reach, and **not an address**
 * — including where a display name *is* one, which `bootstrap.ts` also
 * produces. The domain is dropped, because a page every member reads is not a
 * place to publish the owner's inbox, and this is a redaction rather than a
 * classification: the worst a false positive costs is a shortened name, and
 * nothing is typed by it.
 *
 * An administrator sees the outstanding links because chasing one is their job;
 * nobody sees a token, because the server does not hold one.
 *
 * It writes nothing.
 */
import { listUsers } from '../../repos/identity.ts';
import { countLivePasskeys, listEnrollments } from '../../repos/passkeys.ts';
import { nowIso } from '../../repos/util.ts';

export type MemberState = 'READY' | 'INVITED' | 'NOT_INVITED';

/**
 * Which credential lets this person in.
 *
 * `DEVICE` is a live passkey; `PASSWORD` is the `bootstrap.ts` account, which
 * is a real way in and is deliberately not called a device. `NONE` is a slot
 * that holds neither, which is every `INVITED` and `NOT_INVITED` row.
 */
export type SignsInWith = 'DEVICE' | 'PASSWORD' | 'NONE';

export interface PersonReading {
  userId: string;
  /** Never an address: a display name that is one has its domain dropped. */
  displayName: string;
  state: MemberState;
  signsInWith: SignsInWith;
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

/**
 * A display name with any address domain removed.
 *
 * `bootstrap.ts` names the first administrator after the address it was created
 * with, so the owner's inbox was the label every member read on this page — and
 * this module's own contract is that no contact detail crosses it. Dropping
 * everything from the `@` keeps the row recognisable to the person it is and
 * leaves nothing anybody can write to.
 *
 * It is not a classification and nothing is typed by it: §4's rule against
 * name-matching is about deciding *what a row is*, which `users.kind` now
 * declares. A false positive here shortens a name.
 */
export function withoutDomain(displayName: string): string {
  const at = displayName.indexOf('@');
  return at > 0 ? displayName.slice(0, at) : displayName;
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
    /*
     * A timestamp, never a verifier. `passwordUpdatedAt` is non-null exactly
     * when this account has had a password set, and it is already on the mapped
     * view type — so establishing that a password credential exists costs
     * nothing and reveals nothing about it.
     */
    const signsInWith: SignsInWith =
      live > 0 ? 'DEVICE' : user.passwordUpdatedAt !== null ? 'PASSWORD' : 'NONE';

    if (signsInWith !== 'NONE') {
      people.push({
        userId: user.id,
        displayName: withoutDomain(user.displayName),
        state: 'READY',
        signsInWith,
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
      displayName: withoutDomain(user.displayName),
      state: outstanding ? 'INVITED' : 'NOT_INVITED',
      signsInWith,
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
