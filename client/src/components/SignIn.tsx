/**
 * The sign-in screen. An identity and six digits.
 *
 * ---------------------------------------------------------------------------
 * What was here, and why it is gone
 * ---------------------------------------------------------------------------
 *
 * One button: SIGN IN WITH YOUR DEVICE. It was the only thing on the screen,
 * and for the account that administers this Brain it did not work — the
 * browser answered *"the operation either timed out or was not allowed"*,
 * which is the single refusal WebAuthn gives for every reason it has. There
 * was nothing else to press. The owner could not get in.
 *
 * The mistake was not the passkey. It was making a credential mandatory that
 * **nobody had ever successfully presented**, on a surface with no second
 * route, for an account that had not enrolled. A credential that has never
 * worked is not a credential yet, and a screen offering only one of those is a
 * locked door with a button on it.
 *
 * So the ordinary way in is six digits the person chose: no hardware, no
 * biometric prompt, no pairing, nothing a device can refuse. Passkeys remain in
 * the schema and the code and are optional; nothing on this screen asks for
 * one, and nothing anywhere requires one.
 *
 * ---------------------------------------------------------------------------
 * The remembered identity is a convenience and not a credential
 * ---------------------------------------------------------------------------
 *
 * The last identity typed here is kept in `localStorage` so the next visit can
 * show one box instead of two. That is **all** it is. It authenticates nobody,
 * it is not consulted by the server, and a browser that has it still has to
 * present the PIN — so it is a saved form field rather than a pairing, and
 * "not this account" throws it away and asks again.
 *
 * Storage can throw, and can come back empty in a private window or with site
 * data cleared. Every read and write is wrapped, and the screen is correct with
 * neither: it simply asks for both.
 *
 * ---------------------------------------------------------------------------
 *
 * Nothing here interprets a failure. The server answers every refused sign-in
 * the same way on purpose — a wrong PIN, an unknown identity and an account
 * with no PIN are one sentence — and a client that tried to be more helpful
 * would hand back exactly the distinction the server spent effort refusing to
 * make. The one thing it does render specially is the cooldown, because that
 * is what the server itself chose to say.
 */
import { useState } from 'react';
import { Api, ApiError, type SessionUser } from '../lib/api.ts';

interface Props {
  /** Set once the person is signed in. */
  onSignedIn: (user: SessionUser) => void;
}

/** Where the last identity is remembered. Read defensively; never required. */
const LAST_IDENTITY_KEY = 'brain.lastIdentity';

function rememberedIdentity(): string {
  try {
    return window.localStorage.getItem(LAST_IDENTITY_KEY) ?? '';
  } catch {
    return '';
  }
}

function remember(identity: string): void {
  try {
    window.localStorage.setItem(LAST_IDENTITY_KEY, identity);
  } catch {
    /* a convenience that could not be saved is still a convenience */
  }
}

function forget(): void {
  try {
    window.localStorage.removeItem(LAST_IDENTITY_KEY);
  } catch {
    /* nothing to do, and nothing depends on it */
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function SignIn({ onSignedIn }: Props): JSX.Element {
  const known = rememberedIdentity();
  const [identity, setIdentity] = useState(known);
  /** Whether the identity box is shown. Hidden only when one is remembered. */
  const [askIdentity, setAskIdentity] = useState(known.length === 0);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await Api.signInWithPin(identity.trim(), pin);
      remember(identity.trim());
      setPin('');
      onSignedIn(user);
    } catch (err) {
      setError(describe(err));
      // The digits go, the identity stays. Retyping an address you have just
      // typed correctly is the friction that makes people give up on a typo.
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">BRAIN</h1>
        <form key="pin-sign-in" onSubmit={(event) => void submit(event)}>
          <p className="signin__lede">This Brain is private.</p>

          {askIdentity ? (
            <>
              <label className="signin__label" htmlFor="identity">
                YOUR NAME OR EMAIL
              </label>
              <input
                id="identity"
                className="signin__input"
                type="text"
                autoComplete="username"
                autoFocus
                value={identity}
                onChange={(event) => setIdentity(event.target.value)}
                required
              />
            </>
          ) : (
            <p className="signin__hint">
              Signing in as <strong>{identity}</strong>.{' '}
              <button
                type="button"
                className="signin__linkbutton"
                onClick={() => {
                  forget();
                  setIdentity('');
                  setAskIdentity(true);
                }}
              >
                Not you?
              </button>
            </p>
          )}

          <label className="signin__label" htmlFor="pin">
            SIX-DIGIT PIN
          </label>
          <input
            id="pin"
            className="signin__input signin__input--pin"
            /*
             * `text` with a numeric mode rather than `type="number"`: a number
             * input strips leading zeros, offers a spinner, and lets the arrow
             * keys change a credential. `inputMode` is what actually brings up
             * the digit keypad on a phone, which is where this is typed most.
             */
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="current-password"
            maxLength={6}
            autoFocus={!askIdentity}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            required
          />

          {error ? <div className="signin__error">{error}</div> : null}

          <button
            type="submit"
            className="btn btn--primary signin__submit"
            disabled={busy || pin.length !== 6 || identity.trim().length === 0}
          >
            {busy ? 'SIGNING IN…' : 'SIGN IN'}
          </button>
        </form>
      </div>
    </div>
  );
}
