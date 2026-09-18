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
 */
import { useCallback, useEffect, useState } from 'react';
import {
  PASSKEY_UNSUPPORTED,
  Passkeys,
  passkeysAvailable,
  type EnrollmentPreview,
} from '../lib/passkeys.ts';

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
  const [label, setLabel] = useState('This device');

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

  const register = useCallback(() => {
    setBusy(true);
    setError(null);
    Passkeys.enrol(token, label.trim() || 'This device').then(
      () => onEnrolled(),
      (failure) => {
        setError(describe(failure));
        setBusy(false);
      },
    );
  }, [token, label, onEnrolled]);

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
          Your previous device has already been taken out of service. Registering here replaces it.
        </p>
      ) : (
        <p className="rs-enrol-note">
          Brain has no password and asks for no email address. You sign in with this device — its
          fingerprint, face or screen lock — and you can add more devices later.
        </p>
      )}

      <label className="rs-enrol-label" htmlFor="device-label">
        What to call this device
      </label>
      <input
        id="device-label"
        className="rs-enrol-input"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        disabled={busy}
      />

      {passkeysAvailable() ? (
        <button className="rs-enrol-go" onClick={register} disabled={busy}>
          {busy ? 'Waiting for your device…' : 'Register this device'}
        </button>
      ) : (
        <p className="rs-enrol-error">{PASSKEY_UNSUPPORTED}</p>
      )}

      {error ? <p className="rs-enrol-error">{error}</p> : null}
      <p className="rs-enrol-expiry">
        This link stops working on {new Date(preview.expiresAt).toLocaleString()}.
      </p>
    </main>
  );
}
