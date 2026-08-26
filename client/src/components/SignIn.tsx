/**
 * The sign-in screen, and the password change that sometimes follows it.
 *
 * Two screens rather than one because they are two different moments: the first
 * is "prove who you are", the second is "the password you were given was never
 * meant to be kept". An account created by an administrator, or bootstrapped
 * into an empty Brain, arrives with a password that somebody else chose and that
 * has probably passed through a deployment secret and a terminal. The server
 * will not let that account do anything else until this screen is done with.
 *
 * Nothing here interprets a failure. The server answers every wrong sign-in the
 * same way on purpose, and a client that tried to be more helpful — "no account
 * with that address" — would hand back exactly the distinction the server spent
 * effort refusing to make.
 *
 * ---------------------------------------------------------------------------
 * Two mistakes this file used to make, both of which locked somebody out
 * ---------------------------------------------------------------------------
 *
 * **It asked for a password it already had.** Somebody signs in, and is then
 * shown a form demanding the same password again. That is not a security
 * property — the session is already established, and the server's own check is
 * against the account, not against whatever this form collects. It was pure
 * friction, and friction in front of a mandatory step is a lockout waiting to
 * happen. When the password is already known it is now used, and the field is
 * not shown at all.
 *
 * **The two forms shared DOM nodes.** Rendered by a ternary at the same
 * position, React reconciled the sign-in form's inputs onto the change form's
 * inputs — the email box became the current-password box with its `type`
 * swapped underneath it. A browser that sees a password field appear offers to
 * fill it, and the credential it had saved for this origin was the shared
 * access token from the outer HTTP Basic prompt, not the account password.
 * Clearing the field did nothing: the next render filled it again. Each form
 * now has its own `key`, so React unmounts one and mounts the other instead of
 * quietly turning one into the other.
 */
import { useState } from 'react';
import { Api, ApiError, type SessionUser } from '../lib/api.ts';

interface Props {
  /** Set once the person is signed in and their password is their own. */
  onSignedIn: (user: SessionUser) => void;
  /** Present when a session exists but the password must be replaced first. */
  pendingUser?: SessionUser | null;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function SignIn({ onSignedIn, pendingUser }: Props): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /**
   * The password this tab signed in with, kept only in memory and only until
   * the change succeeds.
   *
   * It is what makes the current-password field unnecessary in the ordinary
   * case. Held in React state rather than anywhere durable: it never reaches
   * storage, a cookie, or the URL, and it is gone the moment the tab is closed
   * or reloaded — which is exactly the case the field below still exists for.
   */
  const [knownPassword, setKnownPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mustChange = pendingUser?.mustChangePassword ?? false;
  /** After a reload there is no remembered password, so it has to be asked for. */
  const needsCurrentPassword = mustChange && knownPassword.length === 0;

  async function submitSignIn(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await Api.login(email.trim(), password);
      // Remembered before the field is cleared, so the change form that may be
      // about to appear does not have to ask for it again.
      setKnownPassword(password);
      // The server decides this, not the form: if the account still carries a
      // temporary password, it is handed straight to the second screen.
      onSignedIn(user);
      setPassword('');
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
      // The remembered one where there is one; the typed one after a reload.
      await Api.changePassword(knownPassword || password, newPassword);
      const session = await Api.session();
      if (session.user) onSignedIn(session.user);
      setPassword('');
      setKnownPassword('');
      setNewPassword('');
      setConfirmPassword('');
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

        {mustChange ? (
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
              {needsCurrentPassword
                ? ' Your current password is needed because this page was reloaded.'
                : ' You are already signed in, so the current password is not needed again.'}
            </p>
            {error ? <div className="signin__error">{error}</div> : null}
            <button type="submit" className="btn btn--primary signin__submit" disabled={busy}>
              {busy ? 'SAVING…' : 'SET PASSWORD'}
            </button>
          </form>
        ) : (
          <form key="sign-in" onSubmit={(event) => void submitSignIn(event)}>
            <p className="signin__lede">This Brain is private.</p>
            <label className="signin__label" htmlFor="email">
              EMAIL
            </label>
            <input
              id="email"
              className="signin__input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label className="signin__label" htmlFor="password">
              PASSWORD
            </label>
            <input
              id="password"
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
          </form>
        )}
      </div>
    </div>
  );
}
