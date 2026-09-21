/**
 * The name a person types at the sign-in screen, and what makes it theirs.
 *
 * ---------------------------------------------------------------------------
 * Why this is a domain rule rather than a line in the lookup
 * ---------------------------------------------------------------------------
 *
 * A member who enrolled from a link holds **no address at all** — that is the
 * whole point of the credential-less row `createCredentiallessUser` writes —
 * so their display name is the only thing they can present. It is therefore a
 * *sign-in identity*, and an identity two accounts can both claim is not one.
 *
 * Nothing kept it unique, and the consequence was a locked door with nothing
 * on it: `getPinCredentialByIdentity` refuses an ambiguous name by design, and
 * refuses it with the same sentence a wrong PIN gets, because invariant 23 is
 * doing its job. So an administrator inviting a second *Caleb* — most likely
 * by re-inviting somebody whose first link expired — locked **both** of them
 * out, silently, with the People page still reporting them ready.
 *
 * Three readers have to agree about it or it is not a rule: the lookup that
 * resolves a typed name, the guard that refuses a colliding one, and the
 * reading that tells an administrator somebody is stuck. They agree by sharing
 * this module rather than by each spelling it out.
 *
 * ---------------------------------------------------------------------------
 * Case and space
 * ---------------------------------------------------------------------------
 *
 * Folded, because a person typing their own name cannot be expected to
 * reproduce the capitalisation an administrator chose for them, and a phone
 * will capitalise the first letter whether they meant it or not. That is a
 * convenience at the door and a **strengthening** of the uniqueness rule: two
 * names that differ only in case are not two identities to anybody reading
 * them, so allowing both would be allowing the collision this file exists to
 * prevent.
 *
 * The comparison is done here, in JavaScript, and never left to SQL. `LOWER`
 * exists in both dialects and agrees with `toLowerCase` for ASCII, but a rule
 * whose answer depends on which database is running is not one rule — and this
 * repository has already been told twice by the second backend that a
 * statement true in one dialect is not true in the other. SQL may narrow;
 * only this decides.
 */

/** The identity a typed name resolves to. Empty means *nothing was typed*. */
export function signInName(typed: string): string {
  return typed.trim().toLowerCase();
}

/** Do these two names name one sign-in identity? */
export function sameSignInName(a: string, b: string): boolean {
  const left = signInName(a);
  return left.length > 0 && left === signInName(b);
}

/**
 * The identities an account can be signed in as.
 *
 * Both, because the lookup tries the address first: an account whose *name* is
 * another account's *address* would take that address's traffic, which is the
 * same collision one column along.
 */
export function identitiesOf(account: { email: string | null; displayName: string }): string[] {
  const names = [signInName(account.displayName)];
  if (account.email !== null) names.push(signInName(account.email));
  return names.filter((one) => one.length > 0);
}

/**
 * Would this name collide with an account that can already be signed into?
 *
 * Asked of every account rather than only of people: a machinery row is
 * signed into as well, at the password door, so a name that takes its traffic
 * is a collision whatever kind the row declares. Disabled accounts are
 * excluded because they can never be signed into, so holding a name against a
 * live person would be a row nobody can reach making somebody else
 * unreachable.
 *
 * It is a pure function over rows the caller already has, so the guard and the
 * reading cannot answer it differently.
 */
export function signInNameIsTaken(
  proposed: string,
  accounts: readonly { id: string; email: string | null; displayName: string; disabled: boolean }[],
  options: { exceptUserId?: string } = {},
): boolean {
  const wanted = signInName(proposed);
  if (wanted.length === 0) return false;
  return accounts.some(
    (account) =>
      !account.disabled &&
      account.id !== options.exceptUserId &&
      identitiesOf(account).includes(wanted),
  );
}

/**
 * The sign-in names more than one live account answers to.
 *
 * Returned as the folded form, so a caller comparing a row against it uses the
 * same rule the lookup does.
 */
export function ambiguousSignInNames(
  accounts: readonly { email: string | null; displayName: string; disabled: boolean }[],
): Set<string> {
  const seen = new Map<string, number>();
  for (const account of accounts) {
    if (account.disabled) continue;
    // The *name*, not the address: two accounts cannot share an address, which
    // has its own unique index, and counting both would report a single
    // account twice whenever its name and address fold to one string.
    const name = signInName(account.displayName);
    if (name.length === 0) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
}
