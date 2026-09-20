/**
 * Where an enrollment link lands.
 *
 * The second screen in this application a person with no Brain account may
 * reach, and `Root` renders it before the sign-in gate for `AcceptInvitation`'s
 * reason: the whole point is that they do not have a credential yet.
 *
 * **The token is read from `location.hash` and never from the path.** A
 * fragment is not sent to any server and is not written to any access log,
 * which is what makes the link safe to send in a message. It is taken out of
 * the address as soon as it is read, so a reload does not re-present it.
 *
 * **Nothing here interprets a refusal.** Unknown, expired, spent and withdrawn
 * are one sentence on the server on purpose, and a client that tried to be more
 * helpful would hand back the distinction the server refused to make.
 *
 * **There is no password field, and there is no email field.** That is the
 * feature rather than an omission: an address exists to recover a password, and
 * there is no password here to recover.
 *
 * **It ends in a PIN rather than a device**, and the correction is worth
 * recording. WebAuthn answers every refusal with one sentence — *"the
 * operation either timed out or was not allowed"* — and the browser that
 * refuses cannot be argued with. This Brain's owner met exactly that on a
 * screen whose only control was the device button, and could not get in. A
 * journey whose last step can be refused with no alternative is one that
 * strands people, so the last step is six digits. A device can be added
 * afterwards, from *Your devices*, and nothing requires one.
 */
import { useCallback, useEffect, useState } from 'react';
import { Passkeys, type EnrollmentPreview } from '../lib/passkeys.ts';

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function takeTokenFromHash(): string {
  const raw = window.location.hash.replace(/^#/, '').trim();
  if (raw.length === 0) return '';
  window.history.replaceState({}, '', window.location.pathname);
  return raw;
}

export function Enrol({ onEnrolled }: { onEnrolled: () => void }): JSX.Element {
  const [token] = useState(takeTokenFromHash);
  const [preview, setPreview] = useState<EnrollmentPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError('This link is incomplete. Ask the person who sent it for a new one.');
      return;
    }
    let live = true;
    Passkeys.preview(token).then(
      (answer) => {
        if (!live) return;
        setPreview(answer);
        setLoading(false);
      },
      (failure) => {
        if (!live) return;
        setError(describe(failure));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  /**
   * Spend the link on a PIN.
   *
   * It used to spend it on a device, and that is what locked this Brain's
   * owner out: WebAuthn answers every refusal with one sentence, the browser
   * that refuses cannot be argued with, and there was nothing else on the
   * screen. Six digits cannot be refused by any device, so that is what the
   * journey ends in. Registering a device is still possible afterwards, from
   * *Your devices*, and is optional.
   */
  const createPin = useCallback(() => {
    if (pin !== confirmPin) {
      setError('Those two PINs are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    Passkeys.enrolWithPin(token, pin).then(
      () => onEnrolled(),
      (failure) => {
        setError(describe(failure));
        setBusy(false);
      },
    );
  }, [token, pin, confirmPin, onEnrolled]);

  if (loading) return <div className="rs-boot">Checking your link…</div>;

  if (!preview) {
    return (
      <main className="rs-enrol">
        <h1>This link cannot be used</h1>
        <p className="rs-enrol-error">{error}</p>
      </main>
    );
  }

  const recovery = preview.kind === 'RECOVERY';

  return (
    <main className="rs-enrol">
      <h1>{recovery ? 'Set up a new device' : 'Welcome to Brain'}</h1>
      <p className="rs-enrol-name">
        This link is for <strong>{preview.displayName}</strong>.
      </p>
      {recovery ? (
        <p className="rs-enrol-note">
          Whatever you were signing in with before has already been taken out of service. What you
          set here replaces it.
        </p>
      ) : (
        <>
          <p className="rs-enrol-note">
            Brain has no password and asks for no email address. You choose a six-digit PIN, and
            that is what you sign in with from now on.
          </p>
          {/*
            * What happens next, said here rather than discovered later.
            *
            * Connecting a Claude account is the second thing everybody does and
            * it used to be the thing nobody was told about — so the journey is
            * named at the moment somebody joins, and the setup itself is behind
            * the one card waiting for them. This is a sentence, deliberately:
            * a second copy of the instructions would be a second copy to drift.
            */}
          <p className="rs-enrol-note">
            Once you are in, the first card on your home page is where you connect your Claude
            account, so this Brain can run research on it. It takes a few minutes and you can stop
            and come back to it.
          </p>
        </>
      )}

      <label className="rs-enrol-label" htmlFor="enrol-pin">
        Choose a six-digit PIN
      </label>
      <input
        id="enrol-pin"
        className="rs-enrol-input"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="new-password"
        maxLength={6}
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
        disabled={busy}
      />

      <label className="rs-enrol-label" htmlFor="enrol-pin-confirm">
        Confirm your PIN
      </label>
      <input
        id="enrol-pin-confirm"
        className="rs-enrol-input"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="new-password"
        maxLength={6}
        value={confirmPin}
        onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
        disabled={busy}
      />

      <button
        className="rs-enrol-go"
        onClick={createPin}
        disabled={busy || pin.length !== 6 || confirmPin.length !== 6}
      >
        {busy ? 'Saving…' : 'Save and enter Brain'}
      </button>

      {error ? <p className="rs-enrol-error">{error}</p> : null}
      <p className="rs-enrol-expiry">
        This link stops working on {new Date(preview.expiresAt).toLocaleString()}.
      </p>
    </main>
  );
}
