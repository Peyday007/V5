/**
 * What a password is still for, now that a person signs in with a device.
 *
 * ---------------------------------------------------------------------------
 * The rule, in one sentence
 * ---------------------------------------------------------------------------
 *
 * **A password is accepted only from an account that cannot sign in with a
 * device.** Not "only from a member", not "only from a machine", and not behind
 * a flag somebody sets: it is derived from rows, per account, on every request,
 * and it closes by itself the moment the device path is shown to work.
 *
 * That single rule is what makes the migration safe to ship in one change, and
 * it is worth spelling out what it answers, because three separate accounts had
 * three different needs and a policy that named any of them would have been
 * wrong about the others:
 *
 *   * **The owner, today.** One `PERSON` row, Brain administrator, a password
 *     and no passkey — so the door is open for exactly as long as it is the
 *     only way that account can get in, and shuts the first time a device signs
 *     them in. That is "verify successful passkey authentication before
 *     disabling ordinary password login" expressed as a derivation rather than
 *     as a step somebody has to remember to take.
 *   * **The members.** A device each, so the door is already shut for them, and
 *     it was shut by their own enrollment rather than by anything written here.
 *     They also hold no address and no verifier, so there is nothing for a
 *     password to be compared against either — belt and braces, in the order
 *     that matters.
 *   * **The hosted verification identities.** `kind = 'SYSTEM'`, created by
 *     `scripts/verify-hosted.ts` on every deploy, no device and never one. They
 *     are machinery proving itself and they keep the door, without this module
 *     having to know they exist. A rule that said "refuse every person" would
 *     have needed a `kind` check here, and a `kind` check is a second place for
 *     the question "is this a human" to be answered differently.
 *
 * ---------------------------------------------------------------------------
 * Break-glass, and why it is a deployment secret
 * ---------------------------------------------------------------------------
 *
 * The rule above has one sharp edge: the sole Brain administrator who loses
 * their only device. Recovery is an administrator issuing a link, and they are
 * the administrator — so the ordinary answering transition is the one thing
 * they cannot reach, and a refusal with no remedy is stuck rather than waiting.
 *
 * So `BRAIN_BREAK_GLASS` re-opens the door for everybody, and it is read from
 * the environment on every request rather than cached at boot, because an
 * emergency switch that needs a redeploy to *turn off* is one that stays on.
 * Setting it is a deliberate act by somebody who can already set this
 * deployment's secrets and therefore already controls everything — §26's rule
 * that reaching the shell is the authentication, and the same reasoning
 * `BRAIN_BOOTSTRAP_ADMIN_RESET` already runs on. What it adds over simply
 * leaving the door open is that it cannot happen by accident: it has to be
 * turned on, used, and turned off again, and the boot banner says so while it
 * is on.
 *
 * It grants no authority of its own. A password still has to be right, the
 * throttle still applies, the account still has to be enabled, and the session
 * it opens is the short one.
 *
 * ---------------------------------------------------------------------------
 * One refusal
 * ---------------------------------------------------------------------------
 *
 * A closed door, a wrong password, an unknown address and a disabled account
 * are **one sentence with one body**. The difference between them is exactly
 * what somebody probing would like to learn — and here it would be worth
 * learning twice over, because "that account signs in with a device" says both
 * that the account exists and that it holds one. The sentence names the remedy
 * instead of the reason, which is the shape every other refusal in this
 * codebase already has.
 */
import { countProvenPasskeys } from '../../repos/passkeys.ts';

/**
 * One sentence for every way of failing at the password door.
 *
 * It names the ordinary way in rather than the reason this attempt failed, so
 * somebody who has simply forgotten how this Brain signs people in is told what
 * to do, and somebody probing is told nothing.
 *
 * **It named the wrong way in for a while, and that is worth recording rather
 * than quietly editing.** It said *"this Brain signs people in with their
 * device"* — true when it was written, and false from the moment the ordinary
 * credential became a PIN. A refusal that names a remedy has to be re-read
 * every time the remedy moves, or it becomes the most confidently wrong
 * sentence on the surface: the person most likely to see it is the one who has
 * mistyped their password *at the recovery door*, on their way to creating a
 * PIN, and telling them to use a device is sending them back to the thing that
 * locked them out.
 */
export const PASSWORD_DOOR_REFUSED =
  'Those credentials were not accepted. This Brain signs people in with a six-digit PIN.';

/** Set in the deployment's own secrets, read per request, off by default. */
export function breakGlassArmed(): boolean {
  const value = (process.env['BRAIN_BREAK_GLASS'] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * May this account present a password?
 *
 * Asked of the account the credentials resolved to rather than of the caller,
 * so nothing the request said about itself contributes — the same property the
 * rest of `services/identity/` rests on.
 */
export async function passwordDoorOpenFor(userId: string): Promise<boolean> {
  if (breakGlassArmed()) return true;
  return (await countProvenPasskeys(userId)) === 0;
}
