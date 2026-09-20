/**
 * The browser half of a passkey.
 *
 * Three jobs and nothing else: turn the server's options into the shapes
 * `navigator.credentials` wants, hand what comes back to the server, and say
 * plainly when this browser cannot do it at all.
 *
 * **Nothing here decides anything.** The challenge is the server's, the
 * relying party is the server's, the account is the server's, and every
 * refusal is the server's sentence rendered as it arrived. A client that
 * interpreted a refusal would hand back exactly the distinction the server
 * spent effort refusing to make.
 *
 * **The enrollment token travels in the body, never in a path.** It reaches
 * this browser in the URL fragment — never sent to a server, never written to
 * an access log — and putting it into a path here would undo that.
 */
import { ApiError } from './api.ts';

/** What the server answers when it will not say why. */
export const PASSKEY_UNSUPPORTED =
  'This browser cannot use passkeys. Open the link on a phone or a laptop with a screen lock.';

export function passkeysAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function'
  );
}

/* --------------------------------------------------------------- encoding */

function fromBase64url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ----------------------------------------------------------- the two calls */

export interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  authenticatorSelection: Record<string, unknown>;
  attestation: string;
  timeout: number;
}

export interface RegistrationAnswer {
  challenge: string;
  clientDataJSON: string;
  attestationObject: string;
}

/** Ask the device to make a credential, and return what the server needs. */
export async function makeCredential(options: RegistrationOptions): Promise<RegistrationAnswer> {
  if (!passkeysAvailable()) throw new Error(PASSKEY_UNSUPPORTED);
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64url(options.challenge),
      rp: { id: options.rp.id, name: options.rp.name },
      user: {
        id: fromBase64url(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria,
      attestation: options.attestation as AttestationConveyancePreference,
      timeout: options.timeout,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No device answered. Try again.');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    challenge: options.challenge,
    clientDataJSON: toBase64url(response.clientDataJSON),
    attestationObject: toBase64url(response.attestationObject),
  };
}

export interface AuthenticationOptions {
  challenge: string;
  rpId: string;
  userVerification: string;
  timeout: number;
}

export interface AuthenticationAnswer {
  challenge: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Ask the device to sign the server's challenge. */
export async function getAssertion(options: AuthenticationOptions): Promise<AuthenticationAnswer> {
  if (!passkeysAvailable()) throw new Error(PASSKEY_UNSUPPORTED);
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64url(options.challenge),
      rpId: options.rpId,
      userVerification: options.userVerification as UserVerificationRequirement,
      timeout: options.timeout,
      // No allow-list: a resident key names itself, which is what lets somebody
      // sign in without typing an identifier they do not have.
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No device answered. Try again.');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    challenge: options.challenge,
    credentialId: credential.id,
    clientDataJSON: toBase64url(response.clientDataJSON),
    authenticatorData: toBase64url(response.authenticatorData),
    signature: toBase64url(response.signature),
  };
}

/* ------------------------------------------------------------------ calls */

async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : 'That did not work.';
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}

export interface EnrollmentPreview {
  displayName: string;
  kind: 'ENROLLMENT' | 'RECOVERY';
  expiresAt: string;
}

export interface MemberPasskey {
  id: string;
  label: string;
  originKind: 'ENROLLMENT' | 'ADDED_DEVICE' | 'RECOVERY';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const Passkeys = {
  /** What the link is for. Reads it; never spends it. */
  preview(token: string): Promise<EnrollmentPreview> {
    return call<EnrollmentPreview>('/api/enroll/preview', { token });
  },

  /** Spend the link, register this device, and come back signed in. */
  async enrol(token: string, label: string): Promise<{ user: { id: string; displayName: string } }> {
    const options = await call<RegistrationOptions>('/api/enroll/options', { token });
    const made = await makeCredential(options);
    return call<{ user: { id: string; displayName: string } }>('/api/enroll/complete', {
      token,
      label,
      ...made,
    });
  },

  /**
   * Spend the link on a PIN instead of a device.
   *
   * It lives here beside `enrol` because it is the same link being spent, and
   * a second module for it would be a second place the token travels through.
   * The token is in the body, never a path — it reached this browser in the URL
   * fragment, which is not sent to any server and not written to any access
   * log, and putting it into a path here would undo that.
   */
  enrolWithPin(token: string, pin: string): Promise<{ user: { id: string; displayName: string } }> {
    return call<{ user: { id: string; displayName: string } }>('/api/enroll/pin', { token, pin });
  },

  async signIn(): Promise<{ user: { id: string; displayName: string } }> {
    const options = await call<AuthenticationOptions>('/api/auth/passkey/options', {});
    const assertion = await getAssertion(options);
    return call<{ user: { id: string; displayName: string } }>('/api/auth/passkey/verify', assertion);
  },

  async mine(): Promise<MemberPasskey[]> {
    const response = await fetch('/api/me/passkeys');
    if (!response.ok) throw new ApiError('Could not read your devices.', response.status, null);
    return ((await response.json()) as { passkeys: MemberPasskey[] }).passkeys;
  },

  async addDevice(label: string): Promise<MemberPasskey> {
    const options = await call<RegistrationOptions>('/api/me/passkeys/options', {});
    const made = await makeCredential(options);
    const done = await call<{ passkey: MemberPasskey }>('/api/me/passkeys', { label, ...made });
    return done.passkey;
  },

  revoke(id: string, reason: string): Promise<{ revoked: boolean }> {
    return call<{ revoked: boolean }>(`/api/me/passkeys/${encodeURIComponent(id)}/revoke`, {
      reason,
    });
  },
};
