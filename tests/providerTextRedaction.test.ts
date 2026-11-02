/**
 * Everything Brain issues a credential under, redacted before it becomes a row.
 *
 * `sanitizeProviderDetail` stripped a bearer token, a key=value secret, a JWT,
 * a signed URL's query string and a `brnw_` worker credential — but not the
 * other three markers `server/services/identity/secrets.ts` defines (`brnt_`
 * OAuth tokens, `brnv_` invitations, `brnc_` bridge credentials), and
 * `failureDetail` passed an error's own message through unredacted, so a
 * credential interpolated straight into a message reached a row untouched.
 * Neither gap had a test: nothing under `tests/` imported `failureDetail.ts`.
 *
 * Separately, `fire.ts` stored a provider's response body and a caught
 * network error's message as a fire outcome's `message` — which becomes
 * `fleet_routines.state_reason` and a bin event — with no redaction at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  failureDetail,
  redactCredentials,
  sanitizeProviderDetail,
} from '../server/services/effects/failureDetail.ts';
import {
  generateBridgeCredential,
  generateInvitationToken,
  generateOAuthToken,
  generateWorkerCredential,
} from '../server/services/identity/secrets.ts';
import { fireRoutine } from '../server/services/dispatch/fire.ts';

const MARKERS = [
  { name: 'brnw_ worker credential', generate: () => generateWorkerCredential().plaintext },
  { name: 'brnt_ OAuth token', generate: () => generateOAuthToken().plaintext },
  { name: 'brnv_ invitation', generate: () => generateInvitationToken().plaintext },
  { name: 'brnc_ bridge credential', generate: () => generateBridgeCredential().plaintext },
];

describe('redacting every marker this Brain issues a credential under', () => {
  for (const { name, generate } of MARKERS) {
    it(`redactCredentials strips a ${name}, leaving the surrounding words`, () => {
      const secret = generate();
      const cleaned = redactCredentials(`context before ${secret} context after`);
      expect(cleaned).not.toContain(secret);
      expect(cleaned).toContain('context before');
      expect(cleaned).toContain('context after');
      expect(cleaned).toContain('[redacted]');
    });

    it(`sanitizeProviderDetail strips a ${name} the same way`, () => {
      const secret = generate();
      expect(sanitizeProviderDetail(`upstream said: ${secret}`)).not.toContain(secret);
    });
  }

  it('does not collapse whitespace or bound length, unlike sanitizeProviderDetail', () => {
    const text = 'line one\n\nline   two, with no credential in it';
    expect(redactCredentials(text)).toBe(text);
  });

  it('redacts a credential interpolated into an error message, not only into detail', () => {
    const secret = generateBridgeCredential().plaintext;
    const result = failureDetail(new Error(`upload failed for ${secret}`));
    expect(result).not.toContain(secret);
    expect(result).not.toContain(secret.split('.')[0]);
  });

  it('leaves an ordinary message and detail exactly as they are today', () => {
    const error = Object.assign(
      new Error('The document store refused an upload (HTTP 400).'),
      { detail: 'the store rejected the object reports/q3.pdf' },
    );
    expect(failureDetail(error)).toBe(
      'The document store refused an upload (HTTP 400). · the store rejected the object reports/q3.pdf',
    );
  });

  it('returns the message alone when there is no string detail', () => {
    expect(failureDetail(new Error('plain failure'))).toBe('plain failure');
  });
});

describe('fireRoutine redacts what it stores as a fire outcome message', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('redacts a token echoed in a 403 body before it becomes the fire message', async () => {
    const leakedBearer = 'a'.repeat(40);
    const leakedIssued = generateOAuthToken().plaintext;
    const body = JSON.stringify({
      message: `Authorization: Bearer ${leakedBearer} was refused; token ${leakedIssued} is not authorized for this routine`,
    });
    globalThis.fetch = (async () =>
      new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const outcome = await fireRoutine({ target: { routineId: 'trig_test', token: 'irrelevant' } });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.kind).toBe('AUTH');
    expect(outcome.message.startsWith('403')).toBe(true);
    expect(outcome.message).not.toContain(leakedBearer);
    expect(outcome.message).not.toContain(leakedIssued);
  });

  it('preserves an ordinary provider message verbatim after the status', async () => {
    const body = JSON.stringify({ message: 'routines are not available for this organization' });
    globalThis.fetch = (async () =>
      new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const outcome = await fireRoutine({ target: { routineId: 'trig_test', token: 'irrelevant' } });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.message).toBe(`403 ${body}`);
  });

  it('redacts a credential surfaced through the network-error path', async () => {
    const leaked = generateWorkerCredential().plaintext;
    globalThis.fetch = (async () => {
      throw new Error(`fetch failed while presenting ${leaked}`);
    }) as typeof fetch;

    const outcome = await fireRoutine({ target: { routineId: 'trig_test', token: 'irrelevant' } });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.kind).toBe('NETWORK');
    expect(outcome.message).not.toContain(leaked);
  });
});
