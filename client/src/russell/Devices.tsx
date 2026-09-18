/**
 * Your own devices.
 *
 * Yours and nobody else's. A Brain administrator cannot list or revoke somebody
 * else's from here, and that is deliberate rather than missing: taking a lost
 * device out of service is a recovery link, which is audited and retires the
 * credential as part of issuing the replacement rather than as a quiet
 * administrative act.
 *
 * **Revoking your last one is refused.** A person who removed their only device
 * would be locked out and would need an administrator — an escalation with an
 * answering transition, but an entirely avoidable one, and §24's rule is that a
 * control should not produce a state its own user cannot resolve. The refusal
 * is the server's; this screen shows it rather than pre-empting it, so the
 * sentence a person reads is the one the rule actually applies.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  PASSKEY_UNSUPPORTED,
  Passkeys,
  passkeysAvailable,
  type MemberPasskey,
} from '../lib/passkeys.ts';
import { ClaudeConnectionCard } from './ClaudeConnection.tsx';

const ORIGIN_LABEL: Record<MemberPasskey['originKind'], string> = {
  ENROLLMENT: 'Registered when you joined',
  ADDED_DEVICE: 'Added later',
  RECOVERY: 'Registered from a recovery link',
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Devices(): JSX.Element {
  const [devices, setDevices] = useState<MemberPasskey[] | null>(null);
  const [label, setLabel] = useState('Another device');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const read = useCallback(() => {
    Passkeys.mine().then(
      (answer) => setDevices(answer),
      (error) => setProblem(describe(error)),
    );
  }, []);

  useEffect(read, [read]);

  async function add(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await Passkeys.addDevice(label.trim() || 'Another device');
      read();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await Passkeys.revoke(id, 'Removed by its owner.');
      read();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  const live = (devices ?? []).filter((one) => !one.revokedAt);
  const retired = (devices ?? []).filter((one) => one.revokedAt);

  return (
    <section className="rs-view">
      <h2>Your devices</h2>
      <p className="rs-hint">
        You sign in with a device rather than a password. Keep more than one registered, so losing
        a phone is an inconvenience rather than a lockout.
      </p>

      {devices === null ? (
        <p className="rs-state rs-state-loading">Reading your devices&hellip;</p>
      ) : (
        <ul className="rs-ready-list">
          {live.map((one) => (
            <li key={one.id} className="rs-ready-row">
              <span>
                {one.label}
                <span className="rs-hint"> &middot; {ORIGIN_LABEL[one.originKind]}</span>
              </span>
              <span className="rs-hint">
                {one.lastUsedAt
                  ? `Last used ${new Date(one.lastUsedAt).toLocaleDateString()}`
                  : 'Not used yet'}
              </span>
              <button
                type="button"
                className="rs-button-quiet"
                disabled={busy}
                onClick={() => void revoke(one.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}

      <label className="rs-field-label" htmlFor="device-name">
        Add another device
      </label>
      <input
        id="device-name"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        disabled={busy}
      />
      {passkeysAvailable() ? (
        <button type="button" className="rs-button" disabled={busy} onClick={() => void add()}>
          {busy ? 'Waiting for your device…' : 'Register this device too'}
        </button>
      ) : (
        <p className="rs-hint">{PASSKEY_UNSUPPORTED}</p>
      )}

      {retired.length > 0 ? (
        <>
          <h3>Removed</h3>
          {/* Kept rather than deleted: a device that stopped working is
              something a person should be able to see afterwards. */}
          <ul className="rs-ready-list">
            {retired.map((one) => (
              <li key={one.id} className="rs-ready-row">
                <span>{one.label}</span>
                <span className="rs-hint">
                  Removed {new Date(one.revokedAt as string).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {/*
        * The member list and the invite control used to be here too, behind a
        * `Members` panel that rendered only for an administrator.
        *
        * Your devices is about *you*; who else has joined and what can run are
        * about the Brain, and they are on People & capacity now. One page owns
        * each question, so there is no second reading of either to disagree
        * with the first.
        */}
      <p className="rs-hint">
        Who else has joined, and how much Claude research capacity this Brain can fire, are on{' '}
        <a className="rs-link" href="/people">
          People &amp; capacity
        </a>
        .
      </p>
      {/*
        * Your Claude connection is a credential of yours, like the devices
        * above it, so this is where somebody looks for it — and `alwaysShow`
        * because on this page it is a permanent entry point rather than a
        * prompt. It opens the one canonical panel, which is on People &
        * capacity; there is no second version of it here.
        */}
      <ClaudeConnectionCard alwaysShow />
    </section>
  );
}
