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
 * **It never says what will happen; it asks.** Whether an account is needed is
 * the server's answer from rows, carried in the preview, so the form cannot ask
 * a new person for nothing or an existing one for a device they already hold.
 *
 * **An account it creates holds no password, and never did hold one for long.**
 * This screen used to ask an invited person to choose one, which was the last
 * path in the application that could mint a password-backed human — and under
 * `services/identity/passwordDoor.ts` that password would have *worked*, which
 * is precisely the credential no member is meant to have. The account is
 * created credential-less now, and the enrollment link that comes back with
 * the acceptance is spent here, so the journey still ends with somebody signed
 * in rather than holding a membership they cannot reach.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError, type AcceptedInvitation, type InvitationPreview } from '../lib/api.ts';
import { PASSKEY_UNSUPPORTED, Passkeys, passkeysAvailable } from '../lib/passkeys.ts';

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

  /**
   * Accept, and — for an account this acceptance creates — register the device
   * in the same breath.
   *
   * The account it makes holds **no credential at all**, so stopping at the
   * acceptance would leave somebody a member of a project they cannot sign in
   * to. The enrollment link comes back in the reply, is spent here, and is
   * never stored: `Passkeys.enrol` ends with them signed in, which is why the
   * screen after this offers to open the Brain rather than to sign in.
   *
   * A device that refuses is not a failed acceptance. The membership is
   * granted and the link is still live, so the sentence says so and points at
   * the link they already have rather than at a retry that would be refused.
   */
  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const outcome = await Api.acceptInvitation({
        token,
        ...(preview?.accountNeeded ? { displayName } : {}),
      });
      if (outcome.enrollment) {
        await Passkeys.enrol(outcome.enrollment.token, 'This device');
      }
      setAccepted(outcome);
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
              ? 'Your device is registered, and it is how you sign in from now on. There is no ' +
                'password and no address to remember.'
              : `Sign in with your device to see it.`}
          </p>
          <button type="button" className="btn btn--primary signin__submit" onClick={onAccepted}>
            {accepted.createdAccount ? 'OPEN THE BRAIN' : 'SIGN IN'}
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
                <p className="signin__hint">
                  {passkeysAvailable()
                    ? 'Accepting creates your account and registers this device. Your device ' +
                      'will ask you for your fingerprint, your face or your screen lock. ' +
                      'There is no password to choose.'
                    : PASSKEY_UNSUPPORTED}
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
