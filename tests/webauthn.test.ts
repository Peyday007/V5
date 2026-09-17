/**
 * The passkey verifier, driven by a real authenticator made of Node crypto.
 *
 * A fixture blob copied from somewhere would prove this file parses that blob.
 * Building the credential here — a genuine P-256 key, CBOR the test encodes
 * itself, a signature over the bytes the specification says are signed — proves
 * the verifier accepts a correct credential and, more importantly, that each
 * refusal below is refusing something that would otherwise have worked.
 */
import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  ES256,
  bufferToBase64url,
  decodeCbor,
  parseAuthenticatorData,
  verifyAssertion,
  verifyRegistration,
} from '../server/services/identity/webauthn.ts';
import { authenticator as makeAuthenticator } from './helpers/authenticator.ts';

const RP_ID = 'northline-brain.fly.dev';
const ORIGIN = `https://${RP_ID}`;

/*
 * The authenticator itself is `tests/helpers/authenticator.ts`, shared with the
 * enrollment suites: one synthetic device, so a change to what a real browser
 * sends is made in one place rather than in three that can disagree.
 */
function authenticator() {
  return makeAuthenticator({ rpId: RP_ID });
}

const CHALLENGE = 'a-server-chosen-challenge';

describe('registering a passkey', () => {
  it('accepts a correct registration and reports the credential', () => {
    const device = authenticator();
    const result = verifyRegistration({
      ...device.register(CHALLENGE),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentialId).toBe(device.credentialId);
    expect(result.value.algorithm).toBe(ES256);
    expect(result.value.publicKey.length).toBeGreaterThan(20);
  });

  it('refuses a challenge the server did not issue', () => {
    const device = authenticator();
    const result = verifyRegistration({
      ...device.register('a-challenge-from-somewhere-else'),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: 'challenge mismatch' });
  });

  it('refuses another relying party’s credential', () => {
    const device = authenticator();
    const result = verifyRegistration({
      ...device.register(CHALLENGE, { rpId: 'evil.example' }),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: 'relying party mismatch' });
  });

  it('refuses a device that did not verify the person', () => {
    const device = authenticator();
    // Attested and present, but the UV bit is clear.
    const result = verifyRegistration({
      ...device.register(CHALLENGE, { flags: 0x41 }),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: 'user was not verified by the authenticator' });
  });
});

describe('signing in with a passkey', () => {
  function enrolled() {
    const device = authenticator();
    const registration = verifyRegistration({
      ...device.register(CHALLENGE),
      expectedChallenge: CHALLENGE,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
    });
    if (!registration.ok) throw new Error(registration.reason);
    return { device, stored: registration.value };
  }

  it('accepts a signature the registered key actually made', () => {
    const { device, stored } = enrolled();
    const result = verifyAssertion({
      ...device.assert('a-sign-in-challenge'),
      expectedChallenge: 'a-sign-in-challenge',
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      storedPublicKey: stored.publicKey,
      storedAlgorithm: stored.algorithm,
      storedSignCount: 0,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a signature from a different device', () => {
    const { stored } = enrolled();
    const impostor = authenticator();
    const result = verifyAssertion({
      ...impostor.assert('a-sign-in-challenge'),
      expectedChallenge: 'a-sign-in-challenge',
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      storedPublicKey: stored.publicKey,
      storedAlgorithm: stored.algorithm,
      storedSignCount: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'signature did not verify' });
  });

  it('refuses a replay against a different challenge', () => {
    const { device, stored } = enrolled();
    const captured = device.assert('the-original-challenge');
    const result = verifyAssertion({
      ...captured,
      // The server has moved on; the captured blob still names the old one.
      expectedChallenge: 'a-fresh-challenge',
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      storedPublicKey: stored.publicKey,
      storedAlgorithm: stored.algorithm,
      storedSignCount: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'challenge mismatch' });
  });

  it('refuses an assertion made for another origin', () => {
    const { device, stored } = enrolled();
    const result = verifyAssertion({
      ...device.assert('c', { origin: 'https://phish.example' }),
      expectedChallenge: 'c',
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      storedPublicKey: stored.publicKey,
      storedAlgorithm: stored.algorithm,
      storedSignCount: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'origin mismatch' });
  });

  it('refuses a counter that went backwards, and tolerates one that never moves', () => {
    const { device, stored } = enrolled();
    const cloned = verifyAssertion({
      ...device.assert('c', { signCount: 3 }),
      expectedChallenge: 'c',
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      storedPublicKey: stored.publicKey,
      storedAlgorithm: stored.algorithm,
      storedSignCount: 9,
    });
    expect(cloned).toMatchObject({ ok: false, reason: 'signature counter did not advance' });

    // Most platform passkeys report zero for ever. Zero is not evidence of a
    // clone and must not be read as one.
    const platform = verifyAssertion({
      ...device.assert('c', { signCount: 0 }),
      expectedChallenge: 'c',
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      storedPublicKey: stored.publicKey,
      storedAlgorithm: stored.algorithm,
      storedSignCount: 0,
    });
    expect(platform.ok).toBe(true);
  });
});

describe('the parsers refuse what they cannot represent', () => {
  it('refuses authenticator data that is too short to hold its own header', () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(10))).toThrow(/too short/);
  });

  it('refuses trailing bytes after the public key', () => {
    const device = authenticator();
    const registration = device.register(CHALLENGE);
    const attestation = Buffer.from(registration.attestationObject, 'base64url');
    const { value } = decodeCbor(attestation);
    const authData = (value as Map<unknown, unknown>).get('authData') as Buffer;
    expect(() => parseAuthenticatorData(Buffer.concat([authData, Buffer.from([0xff])]))).toThrow(
      /trailing bytes/,
    );
  });
});
