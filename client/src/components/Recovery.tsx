/**
 * Recovery: the password, and the PIN it exists to set.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 *
 * The ordinary sign-in screen asks for six digits. Two things have to be true
 * for that to be safe to ship, and this screen is the second of them:
 *
 *   * an account that has **no PIN yet** must be able to set one, and
 *   * an account whose owner has **forgotten** theirs must be able to replace
 *     it.
 *
 * Both are the same journey, and the password is what authorizes it. That is
 * the whole of what the password is for now: it is not on the sign-in screen,
 * the ordinary client never posts it anywhere else, and holding one does not
 * open the Brain — it opens this form, which ends in a PIN.
 *
 * This screen is at an address nothing links to. That is deliberate and it is
 * not the security boundary: `/api/auth/login` decides, from rows, whether the
 * account may present a password at all (`services/identity/passwordDoor.ts`).
 * Not linking it keeps it off the front door, where an alternative credential
 * teaches everybody that the Brain has passwords.
 *
 * ---------------------------------------------------------------------------
 * What it does not do any more
 * ---------------------------------------------------------------------------
 *
 * It used to end by registering a device, and that is what locked the owner
 * out: the password half worked perfectly, and the WebAuthn half their browser
 * refused was the only way off this screen. **A journey whose last step can
 * fail with no alternative is a journey that strands people**, so the last
 * step is now two boxes of digits that cannot be refused by any device.
 *
 * Nothing here interprets a refusal. Every one of them is the server's own
 * sentence rendered as it arrived.
 */
import { useState } from 'react';
import { Api, ApiError, type SessionUser } from '../lib/api.ts';

interface Props {
  /** Re-asks the session, which is what takes the person out of this screen. */
  onSignedIn: () => void;
  /** Present when a session already exists but its password must be replaced. */
  pendingUser?: SessionUser | null;
}

type Step = 'SIGN_IN' | 'CHANGE_PASSWORD' | 'SET_PIN' | 'DONE';

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
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
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  /** Whether the account already had one, so the screen says the right word. */
  const [replacing, setReplacing] = useState(pendingUser?.hasPin ?? false);
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
      setReplacing(user.hasPin === true);
      // The server decides which of the two follows, not this form.
      setStep(user.mustChangePassword ? 'CHANGE_PASSWORD' : 'SET_PIN');
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
      setStep('SET_PIN');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The point of the whole screen.
   *
   * It sets the PIN on the account already signed in — the same user id, the
   * same administration, the same memberships, the same history. Nothing is
   * created and nothing is replaced but the six digits. Every other session
   * this account holds ends, which is the server's rule rather than this
   * form's.
   */
  async function submitPin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (pin !== confirmPin) {
      setError('Those two PINs are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await Api.setPin(pin);
      setPin('');
      setConfirmPin('');
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
          <form key="recovery-sign-in" onSubmit={(event) => void submitSignIn(event)}>
            <p className="signin__lede">
              Recovery. This is not how you sign in day to day — it is here to set a PIN, or to
              replace one you have forgotten.
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
              {busy ? 'SIGNING IN…' : 'CONTINUE'}
            </button>
            <p className="signin__hint">Every attempt here is recorded.</p>
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
              At least 12 characters. Generate one rather than choosing one where you can — this
              password is only ever used here.
            </p>
            {error ? <div className="signin__error">{error}</div> : null}
            <button type="submit" className="btn btn--primary signin__submit" disabled={busy}>
              {busy ? 'SAVING…' : 'SET PASSWORD'}
            </button>
          </form>
        ) : null}

        {step === 'SET_PIN' ? (
          <form key="set-pin" onSubmit={(event) => void submitPin(event)}>
            <p className="signin__lede">
              {replacing ? 'Choose a new six-digit PIN.' : 'Create your six-digit PIN.'} This is
              what you will use to sign in from now on.
            </p>
            <label className="signin__label" htmlFor="new-pin">
              {replacing ? 'NEW PIN' : 'CREATE SIX-DIGIT PIN'}
            </label>
            <input
              id="new-pin"
              className="signin__input signin__input--pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              maxLength={6}
              autoFocus
              value={pin}
              onChange={(event) => setPin(onlyDigits(event.target.value))}
              required
            />
            <label className="signin__label" htmlFor="confirm-pin">
              CONFIRM PIN
            </label>
            <input
              id="confirm-pin"
              className="signin__input signin__input--pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              maxLength={6}
              value={confirmPin}
              onChange={(event) => setConfirmPin(onlyDigits(event.target.value))}
              required
            />
            <p className="signin__hint">
              Six digits. Nobody else is ever shown it, and it is not stored anywhere it could be
              read back — so if you forget it, come here again with your password.
            </p>
            {error ? <div className="signin__error">{error}</div> : null}
            <button
              type="submit"
              className="btn btn--primary signin__submit"
              disabled={busy || pin.length !== 6 || confirmPin.length !== 6}
            >
              {busy ? 'SAVING…' : 'SAVE AND ENTER BRAIN'}
            </button>
          </form>
        ) : null}

        {step === 'DONE' ? (
          <div key="done">
            <p className="signin__lede">
              Your PIN is set. From now on the sign-in screen asks for it — nothing else.
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
