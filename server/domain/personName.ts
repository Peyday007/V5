/**
 * What a person is called, in the product.
 *
 * ---------------------------------------------------------------------------
 * What was wrong
 * ---------------------------------------------------------------------------
 *
 * The owner of this Brain was called `rosserpeyton@gmail.com` — in the shell's
 * account menu, on every activity row, on the consent screen, and anywhere else
 * a name was shown. Nothing was broken: `users.display_name` held exactly that,
 * because `bootstrap.ts` creates the first administrator with
 * `read('BRAIN_BOOTSTRAP_ADMIN_NAME') ?? email` and that variable was never
 * set. An **authentication fallback had become the product's idea of who
 * somebody is.**
 *
 * That matters beyond tidiness. What a person reads on a screen is what they
 * believe the system is, so a product that calls its owner by an address is a
 * product that has told every member it thinks of them as a login. And the name
 * leaks: §35 already had to stop it becoming a deployment secret's name, which
 * is the same defect one layer down and is why `withoutDomain` existed at all.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 *
 * A display name that is an address is not a display name, and this is the one
 * place that decides so. Two properties are the point:
 *
 *   * **It never invents.** The fallback is the address's own local part, with
 *     nothing capitalised, split or prettified — turning `rosserpeyton` into
 *     "Rosser Peyton" would be guessing at somebody's name from a string, and a
 *     confidently wrong name is worse than a plain one. It is a *fallback for
 *     an incomplete legacy account*, not a substitute for somebody saying what
 *     they are called.
 *   * **It is not the repair.** The repair is the row: `npm run admin -- people
 *     rename` sets a real name, and from then on this function returns it
 *     untouched. This exists so that an account nobody has renamed yet still
 *     reads as a person rather than as a credential, and so that no new account
 *     can be created carrying an address as its name.
 *
 * `looksLikeAddress` is deliberately narrow — a local part, an `@`, and a
 * domain with a dot in it. A name that merely contains an `@` (a handle
 * somebody chose) is left exactly as it is: the failure mode is fixed at
 * *shows an address nobody renamed*, never at *rewrites a name somebody
 * chose*.
 */

/** Whether this string is an email address rather than a name. */
export function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return false;
  if (trimmed.indexOf('@', at + 1) !== -1) return false;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (/\s/.test(trimmed)) return false;
  return local.length > 0 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/**
 * The name to show a person, from whatever the row holds.
 *
 * Total and pure: the same row always produces the same name, which is what
 * lets every surface call this instead of each deciding for itself.
 */
export function personName(user: { displayName: string }): string {
  const value = (user.displayName ?? '').trim();
  if (value.length === 0) return 'Someone';
  if (!looksLikeAddress(value)) return value;
  return value.slice(0, value.indexOf('@'));
}

/**
 * Whether a name somebody is being *given* is acceptable.
 *
 * Used where an account is created or renamed, so an address cannot become a
 * display name again through the door that made this necessary. Refusing at
 * the door is the half that makes the fallback above a legacy accommodation
 * rather than a permanent workaround.
 */
export function refuseAddressAsName(value: string): void {
  if (looksLikeAddress(value)) {
    throw new Error(
      'A display name is what a person is called, not their address. An address is how they ' +
        'sign in and how they are contacted, and it is kept separately.',
    );
  }
}
