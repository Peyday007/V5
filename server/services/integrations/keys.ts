/**
 * The two keys the deployment owns for its integrations (§103), both generated
 * by `integrations.yml` straight into the deployment's secrets and never seen
 * by a person or a session:
 *
 *  - **signing** (Ed25519): Brain's identity to a connected project. V2 pins
 *    the public half in its source, so V2 can let Brain use its Google Places
 *    connection without the Google key ever leaving V2's deployment.
 *  - **seal** (RSA-OAEP, SHA-256): a session holding an authorized connector
 *    (the owner's Instantly workspace is connected to every Claude session)
 *    encrypts a credential to the public half; only this machine can open it,
 *    so the ciphertext may travel through a workflow input and a log.
 *
 * Both are stored as base64 PKCS#8 DER, the form `openssl genpkey -outform DER`
 * writes. Nothing here returns or logs a private value.
 */
import { createHash, createPrivateKey, createPublicKey, constants, privateDecrypt, publicEncrypt, sign, type KeyObject } from 'node:crypto';
import { SEAL_KEY_ENV, SIGNING_KEY_ENV } from './registry.ts';

function privateKey(name: string, env: NodeJS.ProcessEnv): KeyObject | null {
  const raw = (env[name] ?? '').trim();
  if (!raw) return null;
  const der = Buffer.from(raw, 'base64');
  // OpenSSL 3's `genpkey -outform DER` writes Ed25519 as PKCS#8 but RSA as
  // PKCS#1, so both are read (the first live pass read the seal key as absent).
  for (const type of ['pkcs8', 'pkcs1'] as const) {
    try {
      return createPrivateKey({ key: der, format: 'der', type });
    } catch {
      /* the other encoding */
    }
  }
  return null;
}

export function keyId(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

export interface PublicKeyReading {
  kid: string;
  spki: string;
}

function publicOf(key: KeyObject): PublicKeyReading {
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { kid: keyId(spki), spki: spki.toString('base64') };
}

export function signingKey(env: NodeJS.ProcessEnv = process.env): KeyObject | null {
  const key = privateKey(SIGNING_KEY_ENV, env);
  return key && key.asymmetricKeyType === 'ed25519' ? key : null;
}

export function sealKey(env: NodeJS.ProcessEnv = process.env): KeyObject | null {
  const key = privateKey(SEAL_KEY_ENV, env);
  return key && key.asymmetricKeyType === 'rsa' ? key : null;
}

export function signingPublicKey(env: NodeJS.ProcessEnv = process.env): PublicKeyReading | null {
  const key = signingKey(env);
  return key ? publicOf(key) : null;
}

export function sealPublicKey(env: NodeJS.ProcessEnv = process.env): PublicKeyReading | null {
  const key = sealKey(env);
  return key ? publicOf(key) : null;
}

/** The exact string V2's `verifyBrainRequest` checks. */
export function signedString(method: string, path: string, timestamp: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function signRequest(
  key: KeyObject,
  input: { method: string; path: string; body: string; now?: number },
): { 'x-brain-key-id': string; 'x-brain-timestamp': string; 'x-brain-signature': string } {
  const timestamp = String(input.now ?? Date.now());
  const signature = sign(null, Buffer.from(signedString(input.method, input.path, timestamp, input.body), 'utf8'), key);
  return {
    'x-brain-key-id': publicOf(key).kid,
    'x-brain-timestamp': timestamp,
    'x-brain-signature': signature.toString('base64'),
  };
}

/** Encrypt a credential to the deployment's seal key. Run by a session; the result is safe to publish. */
export function seal(publicSpki: string, plaintext: string): string {
  const key = createPublicKey({ key: Buffer.from(publicSpki, 'base64'), format: 'der', type: 'spki' });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(plaintext, 'utf8')).toString('base64');
}

/** Open a sealed credential on the machine. Throws a message that names no value. */
export function unseal(ciphertext: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = sealKey(env);
  if (!key) throw new Error(`${SEAL_KEY_ENV} is not set on this deployment; run the Integrations workflow once.`);
  try {
    return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(ciphertext, 'base64')).toString('utf8');
  } catch {
    throw new Error('The sealed value does not open with this deployment\'s seal key (sealed to another key, or damaged).');
  }
}
