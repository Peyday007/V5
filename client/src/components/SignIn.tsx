/**
 * The sign-in screen. One button, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * What was here, and why it is gone
 * ---------------------------------------------------------------------------
 *
 * This screen used to carry an address, a password, the words OR WITH A
 * PASSWORD, and a change-password form behind them — with a comment explaining
 * that the password half was "what the owner's own account still uses", and
 * that it was deliberately not hidden behind a link because a fallback somebody
 * cannot find is a lockout.
 *
 * Both halves of that were true and the conclusion was wrong. The owner's
 * account was password-backed because nobody had ever given it a device, not
 * because it had to be; and an alternative that is on the screen is not a
 * fallback, it is a way in. What a person reads on a sign-in screen is what
 * they believe the system is, so a password sitting under the device button
 * taught every member that this Brain has passwords — and the first two members
 * who joined have never had one.
 *
 * So: no email input, no password input, no alternative, and no explanation of
 * a legacy account. A person signs in with a device.
 *
 * ---------------------------------------------------------------------------
 * What replaced the fallback
 * ---------------------------------------------------------------------------
 *
 * The lockout the old comment worried about is real, and it is answered
 * somewhere a person is not looking at every day: an unlinked recovery address
 * (`/recovery`), and behind that the deployment's own break-glass switch. None
 * of that is named here, because internal recovery machinery on the front door
 * is the same mistake one step quieter — it tells somebody probing that there
 * is a second door and where it is.
 *
 * Nothing on this screen interprets a failure. The server answers every refused
 * sign-in the same way on purpose, and a client that tried to be more helpful
 * would hand back exactly the distinction the server spent effort refusing to
 * make.
 */
import { useState } from 'react';
import { Api, ApiError, type SessionUser } from '../lib/api.ts';
import { PASSKEY_UNSUPPORTED, Passkeys, passkeysAvailable } from '../lib/passkeys.ts';

interface Props {
  /** Set once the person is signed in. */
  onSignedIn: (user: SessionUser) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function SignIn({ onSignedIn }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sign in with a device.
   *
   * Nothing is typed and nothing is looked up first: a resident key names its
   * own account, which is what lets somebody who holds no address sign in at
   * all. Every failure is the server's one sentence.
   */
  async function signInWithDevice(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await Passkeys.signIn();
      const session = await Api.session();
      if (session.user) onSignedIn(session.user);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">BRAIN</h1>
        <p className="signin__lede">This Brain is private.</p>
        {passkeysAvailable() ? (
          <>
            <button
              type="button"
              className="btn btn--primary signin__submit"
              disabled={busy}
              onClick={() => void signInWithDevice()}
            >
              {busy ? 'WAITING FOR YOUR DEVICE…' : 'SIGN IN WITH YOUR DEVICE'}
            </button>
            <p className="signin__hint">
              Use Face ID, Touch ID, your fingerprint, or your device screen lock.
            </p>
          </>
        ) : (
          <p className="signin__hint">{PASSKEY_UNSUPPORTED}</p>
        )}
        {error ? <div className="signin__error">{error}</div> : null}
      </div>
    </div>
  );
}
