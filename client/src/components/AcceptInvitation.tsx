/**
 * Where an invitation link lands.
 *
 * The only screen in this application a person with no Brain account may reach,
 * so `Root` renders it *before* the sign-in gate rather than behind it. Anything
 * else would make the journey reachable only by people who are already in, which
 * is the dead end §26 records as missing.
 *
 * **The token is read from `location.hash` and never from the path.** A fragment
 * is not sent to any server and is not written to any access log, which is what
 * makes an invitation link safe to put in a message — §17's rule that a
 * credential may not appear in a URL that gets recorded. It is held in this
 * component's memory for the length of the visit and is stripped from the
 * address bar as soon as it has been read, so a screenshot or a shoulder does
 * not carry it.
 *
 * **Nothing here interprets a refusal.** The server answers every unusable
 * invitation — unknown, expired, already accepted, withdrawn — with one sentence
 * on purpose, and a client that tried to be more helpful would hand back exactly
 * the distinction the server spent effort refusing to make. What it does instead
 * is show that sentence, which already names the remedy.
 *
 * **It never says what will happen; it asks.** Whether a password is needed is
 * the server's answer from rows, carried in the preview, so the form cannot ask
 * a new person for nothing or an existing one for a password they already have.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError, type AcceptedInvitation, type InvitationPreview } from '../lib/api.ts';

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Take the token out of the address, once.
 *
 * Reading it and then replacing the history entry means a reload does not
 * re-present it and the address bar stops showing it. The value lives in React
 * state from then on — never in storage, never in a cookie, and gone when the
 * tab is closed.
 */
function takeTokenFromHash(): string {
  const raw = window.location.hash.replace(/^#/, '').trim();
  if (raw.length === 0) return '';
  window.history.replaceState({}, '', window.location.pathname);
  return raw;
}

export function AcceptInvitation({ onAccepted }: { onAccepted: () => void }): JSX.Element {
  const [token] = useState(takeTokenFromHash);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [accepted, setAccepted] = useState<AcceptedInvitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const look = useCallback(() => {
    if (token.length === 0) {
      setLoading(false);
      setError(
        'This address needs the invitation link you were sent, in full. Open the link itself ' +
          'rather than typing the address — the part after the # is what identifies it.',
      );
      return;
    }
    setLoading(true);
    Api.previewInvitation(token).then(
      (found) => {
        setPreview(found);
        setError(null);
        setLoading(false);
      },
      (problem: unknown) => {
        setError(describe(problem));
        setLoading(false);
      },
    );
  }, [token]);

  useEffect(look, [look]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (preview?.accountNeeded && password !== confirm) {
      setError('Those two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAccepted(
        await Api.acceptInvitation({
          token,
          ...(preview?.accountNeeded ? { password, displayName } : {}),
        }),
      );
      setPassword('');
      setConfirm('');
    } catch (problem) {
      setError(describe(problem));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">BRAIN</h1>
          <p className="signin__lede">Looking at your invitation…</p>
        </div>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">BRAIN</h1>
          <p className="signin__lede">
            You are on {accepted.projectName}, as {accepted.role.toLowerCase()}.
          </p>
          <p className="signin__hint">
            {accepted.createdAccount
              ? `Your account is ${accepted.email}. Sign in with the password you just chose.`
              : `Sign in as ${accepted.email} to see it.`}
          </p>
          <button type="button" className="btn btn--primary signin__submit" onClick={onAccepted}>
            SIGN IN
          </button>
        </div>
      </div>
    );
  }

  // No preview: the invitation cannot be used, and the server's own sentence
  // says so and names the remedy. There is nothing to retry here, so nothing
  // offers to.
  if (!preview) {
    return (
      <div className="signin">
        <div className="signin__card">
          <h1 className="signin__title">BRAIN</h1>
          <div className="signin__error" role="alert">
            {error ?? 'This invitation cannot be used.'}
          </div>
          <button type="button" className="btn signin__submit" onClick={onAccepted}>
            GO TO SIGN IN
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <h1 className="signin__title">BRAIN</h1>
        <p className="signin__lede">
          {preview.invitedByName} invited {preview.invitedEmail} to {preview.projectName}.
        </p>
        <p className="signin__hint">{preview.roleExplanation}</p>

        {!preview.acceptable ? (
          <>
            {/* An escalation with its remedy named, rather than a dead end: the
                invitation is not spent, and it works the moment the account
                exists. Nothing here offers a button that cannot work. */}
            <div className="signin__error" role="alert">
              {preview.blockedReason}
            </div>
            <button type="button" className="btn signin__submit" onClick={onAccepted}>
              GO TO SIGN IN
            </button>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            {preview.accountNeeded ? (
              <>
                <label className="signin__label" htmlFor="invite-name">
                  YOUR NAME
                </label>
                <input
                  id="invite-name"
                  className="signin__input"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={preview.invitedEmail}
                />
                <label className="signin__label" htmlFor="invite-password">
                  CHOOSE A PASSWORD
                </label>
                <input
                  id="invite-password"
                  className="signin__input"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <label className="signin__label" htmlFor="invite-confirm">
                  PASSWORD AGAIN
                </label>
                <input
                  id="invite-confirm"
                  className="signin__input"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                />
                <p className="signin__hint">
                  At least 12 characters. Your account will be {preview.invitedEmail} — the
                  address you were invited at, which is not something this page can change.
                </p>
              </>
            ) : (
              <p className="signin__hint">
                {preview.invitedEmail} already has a Brain account. Accepting puts that account
                on this project; you will still sign in the usual way.
              </p>
            )}
            {error ? (
              <div className="signin__error" role="alert">
                {error}
              </div>
            ) : null}
            <button type="submit" className="btn btn--primary signin__submit" disabled={busy}>
              {busy ? 'ACCEPTING…' : 'ACCEPT'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
