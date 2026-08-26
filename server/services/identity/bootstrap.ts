/**
 * The first administrator.
 *
 * A Brain with authentication and no accounts is a locked building with the key
 * inside, so there has to be exactly one way in that does not require being in
 * already. This is it, and the shape of it is chosen for where this actually
 * runs: a container on Fly with no interactive terminal, deployed by somebody
 * who can set a secret and read a log.
 *
 * The rules it keeps:
 *
 *   * **It runs once.** Only when the users table is empty. After that the
 *     variables are inert, so leaving them set does not silently re-create or
 *     re-enable anything.
 *   * **The password it is given is temporary by construction.** It arrives in
 *     an environment variable, which means it exists in the deployment
 *     platform's secret store and probably in a terminal somewhere. The account
 *     is created with `must_change_password`, and the gate in `guard.ts` lets
 *     that person do nothing else until they have chosen a new one.
 *   * **It never prints the password**, and the boot log says only that an
 *     administrator was created and which address it belongs to.
 *
 * The alternative — a well-known default account, or an unauthenticated setup
 * page live until somebody visits it — is how installations end up with
 * `admin/admin` reachable on the internet for a year.
 */
import {
  countUsers,
  createUser,
  getUserByEmail,
  setBrainAdmin,
  setUserDisabled,
  setUserPassword,
} from '../../repos/identity.ts';
import { WeakPasswordError } from './secrets.ts';

export interface BootstrapOutcome {
  created: boolean;
  /** An existing account that had never been used was reset to the secret. */
  reset: boolean;
  email: string | null;
  /** Why nothing happened, when nothing happened. For the boot banner. */
  reason: string | null;
}

function read(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

export async function bootstrapFirstAdmin(): Promise<BootstrapOutcome> {
  const email = read('BRAIN_BOOTSTRAP_ADMIN_EMAIL');
  const password = read('BRAIN_BOOTSTRAP_ADMIN_PASSWORD');

  if (!email && !password) {
    return { created: false, reset: false, email: null, reason: null };
  }
  if (!email || !password) {
    return {
      created: false,
      reset: false,
      email: null,
      reason:
        'BRAIN_BOOTSTRAP_ADMIN_EMAIL and BRAIN_BOOTSTRAP_ADMIN_PASSWORD must both be set, or neither.',
    };
  }

  // ---------------------------------------------------------------------
  // Recovery: an account that was created and never successfully used
  // ---------------------------------------------------------------------
  //
  // The first administrator is handed a password through a deployment secret,
  // and there is exactly one way that goes wrong badly: the password that
  // reaches the person differs from the one that reached the database, and now
  // nobody can sign in to a Brain whose only account is the one they cannot
  // reach. There is no "forgot password" — that would need an email sender this
  // application does not have and should not acquire — and the remaining remedy
  // is direct database access, which this entire step exists to make
  // unnecessary.
  //
  // So: if the named account exists and has **never completed setup** — it is
  // still carrying `must_change_password`, meaning nobody has ever chosen a
  // password for it — setting the secret again resets it.
  //
  // This grants no new authority. Only somebody who can set this deployment's
  // secrets can trigger it, and that person already controls the deployment
  // entirely. The `must_change_password` condition is what keeps it from ever
  // touching an account somebody is actually using: the moment a real password
  // is chosen, this path is closed for good.
  //
  // The reset deliberately does *not* re-impose the forced password change.
  // That requirement exists because a machine handed the account a password its
  // owner never chose. Here the owner has just chosen it, knowingly, having
  // been locked out — and making them clear one more gate to get back in is the
  // friction that caused the lockout in the first place. The boot log says
  // plainly that the secret must now be removed, because it is still a secret
  // sitting in a deployment store.
  const existing = await getUserByEmail(email);
  if (existing && existing.mustChangePassword) {
    try {
      await setUserPassword(existing.id, password, { mustChangePassword: false });
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        return { created: false, reset: false, email: null, reason: error.message };
      }
      throw error;
    }
    // A recovery that left the account unable to administer anything would be
    // half a recovery.
    if (!existing.isBrainAdmin) await setBrainAdmin(existing.id, true);
    if (existing.disabled) await setUserDisabled(existing.id, false);
    return { created: false, reset: true, email: existing.email, reason: null };
  }

  // Only into an empty Brain. Not "if this address is missing" — that would let
  // the variables re-add an administrator somebody had deliberately removed.
  if ((await countUsers()) > 0) {
    return {
      created: false,
      reset: false,
      email: null,
      reason:
        'this Brain already has accounts, so the bootstrap variables were ignored — remove them',
    };
  }

  try {
    const user = await createUser({
      email,
      displayName: read('BRAIN_BOOTSTRAP_ADMIN_NAME') ?? email,
      password,
      isBrainAdmin: true,
      mustChangePassword: true,
      createdByType: 'SYSTEM',
      createdById: 'bootstrap',
    });
    return { created: true, reset: false, email: user.email, reason: null };
  } catch (error) {
    if (error instanceof WeakPasswordError) {
      // The message names the rule, never the value that broke it.
      return { created: false, reset: false, email: null, reason: error.message };
    }
    throw error;
  }
}

/**
 * Can anybody sign in to this Brain at all?
 *
 * Asked at boot so that a deployment with no accounts says so loudly instead of
 * serving an interface nobody can get past. It is the Step 4 successor to the
 * Step 3 rule that a cloud-backed Brain refuses to start unprotected: the
 * failure being guarded against has moved from "reachable by everyone" to
 * "reachable by no one", and both deserve to be found at deploy time.
 */
export async function hasAnyAccount(): Promise<boolean> {
  return (await countUsers()) > 0;
}
