/**
 * What a recovery has to take away before it gives anything back.
 *
 * ---------------------------------------------------------------------------
 * The defect this is written from
 * ---------------------------------------------------------------------------
 *
 * §32 states the rule and gives the reason in one sentence: *"A replacement
 * link handed out beside a credential that still works is not a recovery, it
 * is a second door — and if the device was lost because somebody else has it,
 * the whole point is that it stops working now rather than when the
 * replacement is used."*
 *
 * `issueRecovery` implemented exactly that, for the credentials that existed
 * when it was written: it revoked every passkey and every session. Then
 * migration 078 made a **PIN** the ordinary human credential, and nothing went
 * back to the recovery path. So the one command an administrator has for *my
 * phone is in somebody else's hands* retired the device nobody could sign in
 * with any more, ended the sessions, and left the six digits that actually
 * open the door working — indefinitely, since an unredeemed link never
 * replaces anything.
 *
 * Nothing about that looked wrong. The passkeys were revoked, the sessions
 * were ended, the audit row was written, and the link arrived. The account was
 * simply still reachable by whoever had prompted the recovery.
 *
 * ---------------------------------------------------------------------------
 * Why it is a module rather than three more lines in `issueRecovery`
 * ---------------------------------------------------------------------------
 *
 * Because the failure was **forgetting**, not mis-implementing. A credential
 * class was added and the recovery path was not revisited, and no test could
 * fail for a class it had never heard of.
 *
 * So the classes are declared here, in one list, and three things read it: the
 * recovery that retires them, the foundation reading that reports whether an
 * account's holdings are covered, and a test that holds the two against each
 * other. Adding a fourth credential to this Brain means adding it to
 * `CREDENTIAL_CLASSES`, and every one of those three starts failing until it
 * is genuinely retired. That is the difference between a rule and a comment.
 *
 * It is kept out of `enrollment.ts` for `negation.ts`'s reason: a rule that
 * lives inside one of its two callers is a cycle waiting to be found by
 * whichever file loads first.
 *
 * ---------------------------------------------------------------------------
 * What it is not
 * ---------------------------------------------------------------------------
 *
 * It authorizes nothing, revokes nothing and reads no rows. It is a statement
 * about the *mechanism*, which is why `recoveryRetiresEverything` takes what
 * an account holds rather than a user id: the question "would a recovery cover
 * this" has to be answerable from a snapshot, the way `router.ts` insists its
 * own decisions are.
 */

/**
 * Every kind of thing that can let somebody into this Brain as a person.
 *
 * A password is deliberately **not** here, and that is a decision rather than
 * an omission. `passwordDoorOpenFor` admits one only while the account has no
 * proven passkey, and it is what `/recovery` itself takes — so retiring it
 * during a recovery would remove the route the recovery is being performed
 * through. An account reachable by password is reachable by the person who
 * already holds the administrator credential, which is not the threat this
 * exists for.
 */
export const CREDENTIAL_CLASSES = ['PASSKEY', 'PIN', 'SESSION'] as const;

export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

/** What an account is holding, as far as this question is concerned. */
export interface Holdings {
  hasPin: boolean;
  livePasskeys: number;
}

export interface RecoveryCoverage {
  /** True when a recovery would leave nothing this account holds still working. */
  complete: boolean;
  /** The classes a recovery does not retire, of the ones this account holds. */
  uncovered: CredentialClass[];
  /** What is true now, in one sentence. */
  because: string;
  /** The one thing that would fix it. Empty when `complete`. */
  remedy: string;
}

/**
 * The classes `issueRecovery` actually retires.
 *
 * This is the half that has to be kept true by hand, so it is one line with a
 * test pointed at it rather than a derivation that could quietly agree with a
 * broken implementation. `tests/recoveryContract.test.ts` performs a real
 * recovery against a real account holding each class and asserts that none of
 * them still works afterwards — so a class listed here and not retired fails
 * loudly, and a class retired and not listed fails too.
 */
export const RETIRED_BY_RECOVERY: readonly CredentialClass[] = ['PASSKEY', 'PIN', 'SESSION'];

/**
 * Would a recovery issued right now leave anything this account holds working?
 *
 * Only what the account actually holds counts. An account with no PIN is not
 * short of anything because PINs are retired; it simply has none, and
 * reporting that as a gap would be the kind of noise that teaches a reader to
 * stop reading a matrix.
 */
export function recoveryRetiresEverything(holdings: Holdings): RecoveryCoverage {
  const held: CredentialClass[] = [];
  if (holdings.hasPin) held.push('PIN');
  if (holdings.livePasskeys > 0) held.push('PASSKEY');
  // A session is held by definition whenever anything else is, and is retired
  // unconditionally, so it is never the thing that makes this incomplete.

  const uncovered = held.filter((one) => !RETIRED_BY_RECOVERY.includes(one));

  if (uncovered.length === 0) {
    return {
      complete: true,
      uncovered: [],
      because:
        held.length === 0
          ? 'This account holds no credential, so a recovery has nothing to retire and ' +
            'issues a link that sets one.'
          : `A recovery retires everything this account holds (${held.join(', ').toLowerCase()}) ` +
            'before the replacement link can be redeemed.',
      remedy: '',
    };
  }

  return {
    complete: false,
    uncovered,
    because:
      `A recovery would not retire this account's ${uncovered.join(' or ').toLowerCase()}, so ` +
      'whoever prompted the recovery would still be able to sign in afterwards.',
    remedy:
      `Retire ${uncovered.join(' and ').toLowerCase()} in issueRecovery, beside the passkeys ` +
      'and sessions it already ends.',
  };
}
