/**
 * The break-glass door, and the only password form left in this application.
 *
 * ---------------------------------------------------------------------------
 * Why it exists at all
 * ---------------------------------------------------------------------------
 *
 * A Brain whose sign-in screen offers nothing but a device is exactly right,
 * and shipping only that would have locked the owner out on the deploy that did
 * it: their account held a password and no passkey, which is the state every
 * account created before enrollment existed is in. Removing the form and
 * leaving them unable to authenticate is the failure this screen exists to
 * prevent — a migration that strands the one account that can administer the
 * Brain is not a migration.
 *
 * So there is one address, `/recovery`, that nothing links to. It is not a
 * second way in for ordinary use, and three separate things make that true
 * rather than promised:
 *
 *   * **the server closes it per account.** A password is refused the moment
 *     that account holds a device it has actually signed in with. Nothing here
 *     decides that, and nothing here can open it — see
 *     `services/identity/passwordDoor.ts`.
 *   * **nothing navigates here.** No link, no button, no redirect, no mention
 *     on the sign-in screen. Somebody who needs it has been told the address.
 *   * **it ends in a device.** A break-glass sign-in lands on *register this
 *     device* rather than on the Brain, because the point of getting in this
 *     way is to stop needing to.
 *
 * ---------------------------------------------------------------------------
 * The change-password form, quarantined rather than deleted
 * ---------------------------------------------------------------------------
 *
 * An account an administrator created, or one bootstrapped into an empty Brain,
 * arrives carrying a password somebody else chose, and the server will let it
 * do nothing else until that is replaced. That gate still exists and still
 * matters — for the hosted verification identities, and for an account that
 * predates all of this. What changed is where it is asked: on this screen,
 * which somebody reaches deliberately, rather than in front of the door
 * everybody uses.
 *
 * Nothing here interprets a refusal. Every one of them is the server's sentence
 * rendered as it arrived.
 */
import { useState } from 'react';
import { Api, ApiError, type SessionUser } from '../lib/api.ts';
import { PASSKEY_UNSUPPORTED, Passkeys, passkeysAvailable } from '../lib/passkeys.ts';

interface Props {
  /** Re-asks the session, which is what takes the person out of this screen. */
  onSignedIn: () => void;
  /** Present when a session already exists but its password must be replaced. */
  pendingUser?: SessionUser | null;
}

type Step = 'SIGN_IN' | 'CHANGE_PASSWORD' | 'REGISTER_DEVICE' | 'DONE';

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function Recovery({ onSignedIn, pendingUser }: Props): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /**
   * The password this tab signed in with, kept only in memory.
   *
   * It is what makes the current-password field unnecessary when the change
   * form follows a sign-in in the same tab. It never reaches storage, a cookie
   * or the URL, and it is gone the moment the tab is closed or reloaded —
   * which is exactly the case the field below still exists for.
   */
  const [knownPassword, setKnownPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [label, setLabel] = useState('This device');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(
    pendingUser?.mustChangePassword ? 'CHANGE_PASSWORD' : 'SIGN_IN',
  );

  /** After a reload there is no remembered password, so it has to be asked for. */
  const needsCurrentPassword = step === 'CHANGE_PASSWORD' && knownPassword.length === 0;

  async function submitSignIn(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await Api.login(email.trim(), password);
      // Remembered before the field is cleared, so the change form that may be
      // about to appear does not have to ask for it again.
      setKnownPassword(password);
      setPassword('');
      // The server decides which of the two follows, not this form.
      setStep(user.mustChangePassword ? 'CHANGE_PASSWORD' : 'REGISTER_DEVICE');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitPasswordChange(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Those two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await Api.changePassword(knownPassword || password, newPassword);
      setKnownPassword(newPassword);
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setStep('REGISTER_DEVICE');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The point of the whole screen.
   *
   * It registers a device against the account already signed in — the same
   * user id, the same administration, the same memberships, the same history.
   * Nothing is created and nothing is replaced. Once that device has signed
   * somebody in, the server stops accepting this account's password by itself.
   */
  async function registerDevice(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await Passkeys.addDevice(label.trim() || 'This device');
      setStep('DONE');
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

        {step === 'SIGN_IN' ? (
          <form key="break-glass" onSubmit={(event) => void submitSignIn(event)}>
            <p className="signin__lede">
              Recovery. This is not how you sign in to this Brain — it is here for an account
              that has no working device yet.
            </p>
            <label className="signin__label" htmlFor="recovery-email">
              EMAIL
            </label>
            <input
              id="recovery-email"
              className="signin__input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label className="signin__label" htmlFor="recovery-password">
              PASSWORD
            </label>
            <input
              id="recovery-password"
              className="signin__input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error ? <div className="signin__error">{error}</div> : null}
            <button type="submit" className="btn btn--primary signin__submit" disabled={busy}>
              {busy ? 'SIGNING IN…' : 'SIGN IN'}
            </button>
            <p className="signin__hint">
              Every attempt here is recorded. If this account already signs in with a device,
              its password is refused.
            </p>
          </form>
        ) : null}

        {step === 'CHANGE_PASSWORD' ? (
          <form key="change-password" onSubmit={(event) => void submitPasswordChange(event)}>
            <p className="signin__lede">
              {pendingUser?.displayName ?? 'This account'} is using a password somebody else
              chose. Pick your own before going any further.
            </p>
            {needsCurrentPassword ? (
              <>
                <label className="signin__label" htmlFor="current">
                  CURRENT PASSWORD
                </label>
                <input
                  id="current"
                  className="signin__input"
                  type="password"
                  // Not `current-password`: the credential a browser has saved
                  // for this origin is as likely to be the shared token from the
                  // outer prompt as it is to be this account's, and offering to
                  // fill it here is how somebody ends up submitting the wrong
                  // secret three times without seeing what changed.
                  autoComplete="off"
                  name="brain-current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </>
            ) : null}
            <label className="signin__label" htmlFor="new">
              NEW PASSWORD
            </label>
            <input
              id="new"
              className="signin__input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
            <label className="signin__label" htmlFor="confirm">
              NEW PASSWORD AGAIN
            </label>
            <input
              id="confirm"
              className="signin__input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
            <p className="signin__hint">
              At least 12 characters. Generate one rather than choosing one where you can —
              every other session this account holds ends when you save.
            </p>
            {error ? <div className="signin__error">{error}</div> : null}
            <button type="submit" className="btn btn--primary signin__submit" disabled={busy}>
              {busy ? 'SAVING…' : 'SET PASSWORD'}
            </button>
          </form>
        ) : null}

        {step === 'REGISTER_DEVICE' ? (
          <div key="register-device">
            <p className="signin__lede">
              Now register this device. After it has signed you in once, this account&rsquo;s
              password stops being accepted and your device is the way in.
            </p>
            {passkeysAvailable() ? (
              <>
                <label className="signin__label" htmlFor="device-label">
                  WHAT TO CALL IT
                </label>
                <input
                  id="device-label"
                  className="signin__input"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                {error ? <div className="signin__error">{error}</div> : null}
                <button
                  type="button"
                  className="btn btn--primary signin__submit"
                  disabled={busy}
                  onClick={() => void registerDevice()}
                >
                  {busy ? 'WAITING FOR YOUR DEVICE…' : 'REGISTER THIS DEVICE'}
                </button>
                <p className="signin__hint">
                  Your device asks you for your fingerprint, your face or your screen lock.
                  Nothing is typed, and no address or password is stored for it.
                </p>
              </>
            ) : (
              <p className="signin__hint">{PASSKEY_UNSUPPORTED}</p>
            )}
          </div>
        ) : null}

        {step === 'DONE' ? (
          <div key="done">
            <p className="signin__lede">
              That device is registered. Open the Brain and sign in with it — the ordinary
              way, from now on.
            </p>
            <button
              type="button"
              className="btn btn--primary signin__submit"
              onClick={() => onSignedIn()}
            >
              OPEN THE BRAIN
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
