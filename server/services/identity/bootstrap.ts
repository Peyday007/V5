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
import { countUsers, createUser, getUserByEmail } from '../../repos/identity.ts';
import { WeakPasswordError } from './secrets.ts';

export interface BootstrapOutcome {
  created: boolean;
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
    return { created: false, email: null, reason: null };
  }
  if (!email || !password) {
    return {
      created: false,
      email: null,
      reason:
        'BRAIN_BOOTSTRAP_ADMIN_EMAIL and BRAIN_BOOTSTRAP_ADMIN_PASSWORD must both be set, or neither.',
    };
  }

  // Only into an empty Brain. Not "if this address is missing" — that would let
  // the variables re-add an administrator somebody had deliberately removed.
  if ((await countUsers()) > 0) {
    return {
      created: false,
      email: null,
      reason:
        'this Brain already has accounts, so the bootstrap variables were ignored — remove them',
    };
  }

  if (await getUserByEmail(email)) {
    return { created: false, email: null, reason: 'that address already has an account' };
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
    return { created: true, email: user.email, reason: null };
  } catch (error) {
    if (error instanceof WeakPasswordError) {
      // The message names the rule, never the value that broke it.
      return { created: false, email: null, reason: error.message };
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
