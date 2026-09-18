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
import { CashApi, type CashReadiness } from '../lib/cashApi.ts';
import { ReadinessPanel } from './Readiness.tsx';
import {
  PASSKEY_UNSUPPORTED,
  Passkeys,
  passkeysAvailable,
  type MemberPasskey,
} from '../lib/passkeys.ts';

const ORIGIN_LABEL: Record<MemberPasskey['originKind'], string> = {
  ENROLLMENT: 'Registered when you joined',
  ADDED_DEVICE: 'Added later',
  RECOVERY: 'Registered from a recovery link',
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Who can get in, on a page that is always reachable.
 *
 * The same panel sits on the Cash activation card, which is where the count is
 * read and where the owner is looking before anything starts — but that card
 * stops rendering the moment Cash Mode is running, and taking somebody's only
 * way of inviting a person with it would be the disappearing control §29 keeps
 * having to correct. Here it survives activation.
 *
 * Offered to a Brain administrator only. That is a convenience and never the
 * control: `/api/members` refuses anybody else with the same 404 a missing one
 * gives, whatever this renders, so the worst an ordinary member sees is a
 * section that did not appear.
 */
function Members(): JSX.Element | null {
  const [readiness, setReadiness] = useState<CashReadiness | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    CashApi.members().then(
      (answer) => {
        if (!live) return;
        setReadiness(answer.readiness);
        setAllowed(true);
      },
      () => {
        if (live) setAllowed(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (allowed !== true || !readiness) return null;
  return (
    <section className="rs-view">
      <h2>People and capacity</h2>
      <p className="rs-hint">
        Cash Mode starts when four people can sign in and four capacity accounts have each proven
        a surface. Being ready is not being authorized: what Brain may spend is a separate
        decision, and it stays yours.
      </p>
      <ReadinessPanel readiness={readiness} isBrainAdmin />
    </section>
  );
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
      <Members />
    </section>
  );
}
