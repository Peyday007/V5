/**
 * The six-digit PIN a person signs in with.
 *
 * ---------------------------------------------------------------------------
 * Why a PIN, written down because the previous answer was wrong
 * ---------------------------------------------------------------------------
 *
 * The sign-in screen offered one credential — a passkey — and the account that
 * administers this Brain had never successfully presented one. Its browser
 * answered *"the operation either timed out or was not allowed"*, which is
 * WebAuthn's single refusal for every reason it has, and there was nothing
 * else on the screen. The owner could not get in.
 *
 * The defect was not WebAuthn. It was making an **unproven** credential
 * mandatory, on a surface with no second route, for an account that had not
 * yet enrolled. A credential nobody has successfully used is not a credential
 * yet, and a sign-in screen that offers only one of those is a locked door.
 *
 * So the ordinary human credential is something every browser on every device
 * can present without asking hardware for permission: six digits the person
 * chose. Passkeys stay in the schema and in the code, optional, and nothing
 * requires one.
 *
 * ---------------------------------------------------------------------------
 * Six digits is a million, and the throttle is the strength
 * ---------------------------------------------------------------------------
 *
 * A password carries its own strength; a PIN does not, and pretending
 * otherwise is how six digits becomes a bad idea rather than a convenient one.
 * Three things carry it here, and all three are server-side:
 *
 *   * **scrypt**, the same verifier the password path uses, so one attempt
 *     costs the server ~60ms and an attacker the same. There is no cheaper
 *     hash for a short secret, and a fast one would make an offline copy of
 *     the table exhaustible in minutes.
 *   * **A progressive cooldown**, from five seconds to an hour, so the
 *     attempts an attacker gets in a day is a number rather than a rate. The
 *     ladder is the whole defence and is written here rather than tuned in a
 *     call site.
 *   * **Rows rather than memory.** `/api/auth/login`'s throttle is a `Map`,
 *     correct for a secret with its own entropy and wrong for this one: a
 *     restart empties it, and this Brain restarts on every deploy. The counter
 *     and the cooldown are columns, so they survive exactly as the verifier
 *     does.
 *
 * ---------------------------------------------------------------------------
 * One refusal
 * ---------------------------------------------------------------------------
 *
 * An unknown identity, a wrong PIN, an account with no PIN, a disabled one and
 * one inside its cooldown are **one sentence with one body**. The differences
 * between them are what somebody probing would like to learn — most of all
 * *which identities exist*, which a six-digit space makes worth learning.
 *
 * A cooldown says it is a cooldown, because that is a fact about the caller's
 * own recent behaviour rather than about the account: somebody who has just
 * typed their own PIN wrong four times is owed the reason they are waiting.
 * It still names no identity and no count of what remains.
 */
import { hashPassword, verifyPassword } from './secrets.ts';

/** Exactly six, exactly digits. Not five, not seven, and not `01234 `. */
export const PIN_LENGTH = 6;

/** One sentence for every way of failing to sign in with a PIN. */
export const PIN_REFUSED = 'That did not sign you in.';

/** What a caller is told when the PIN they sent is not a PIN at all. */
export const PIN_MALFORMED = `A PIN is exactly ${PIN_LENGTH} digits.`;

/**
 * The cooldown after each consecutive failure, in milliseconds.
 *
 * Nothing for the first two — a mistyped digit is the ordinary case and must
 * not feel like a punishment — then a ladder that reaches an hour and stays
 * there. Ten failures buys an attacker roughly twenty-four attempts a day
 * against a million values, which is the arithmetic this exists to produce.
 *
 * It is indexed by the failure count, so the last entry is the standing
 * penalty rather than a cliff somebody falls off once.
 */
const COOLDOWN_LADDER_MS = [
  0, // 1st failure
  0, // 2nd
  5_000, // 3rd
  15_000, // 4th
  60_000, // 5th
  5 * 60_000, // 6th
  15 * 60_000, // 7th
  60 * 60_000, // 8th and every one after it
];

export function isWellFormedPin(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(value);
}

/**
 * How long to lock out after this many consecutive failures.
 *
 * Exported so the test that pins the ladder reads the same numbers the server
 * applies, rather than a copy of them that could drift.
 */
export function cooldownAfter(failures: number): number {
  if (failures <= 0) return 0;
  const index = Math.min(failures, COOLDOWN_LADDER_MS.length) - 1;
  return COOLDOWN_LADDER_MS[index] ?? 0;
}

/** The scrypt verifier, from the same module the password path uses. */
export async function hashPin(pin: string): Promise<string> {
  if (!isWellFormedPin(pin)) throw new PinFormatError(PIN_MALFORMED);
  return await hashPassword(
    /*
     * Domain-separated before hashing.
     *
     * A bare six-digit string hashed with the same function and parameters as
     * a password means one precomputed table serves both columns. The prefix
     * costs nothing and makes a PIN verifier useless against a password one.
     */
    pinMaterial(pin),
  );
}

export async function pinMatches(pin: string, verifier: string): Promise<boolean> {
  if (!isWellFormedPin(pin)) return false;
  return await verifyPassword(pinMaterial(pin), verifier);
}

/**
 * Something to compare against when there is nothing to compare against.
 *
 * An account with no PIN, and an identity that does not exist, must take the
 * same ~60ms as a real account with a wrong PIN — otherwise the *timing* says
 * which identities have set one, which is exactly the enumeration the single
 * refusal sentence is there to prevent.
 */
export const UNMATCHABLE_PIN_VERIFIER =
  'scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';

function pinMaterial(pin: string): string {
  // Padded to clear `assertUsablePassword`'s minimum as well as separating the
  // domains: the hash function is shared, so its input rule is too.
  return `brain-account-pin:v1:${pin}`;
}

export class PinFormatError extends Error {}
