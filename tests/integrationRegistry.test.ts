/**
 * The integration registry (§103): one declared list, read the same way for
 * every service, and no credential wired around it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { INTEGRATIONS, declaredSettings, githubSyncable, sealable } from '../server/services/integrations/registry.ts';
import { checkAndRecord, integrationsView, readIntegrations } from '../server/services/integrations/health.ts';
import { keyId, seal, sealPublicKey, signRequest, signedString, signingKey, signingPublicKey, unseal } from '../server/services/integrations/keys.ts';
import { probeV2Places, searchPlacesViaV2, V2_PLACES_PATH } from '../server/services/integrations/v2Bridge.ts';
import { messagingConfig, billingConfig } from '../server/services/cash/providers/config.ts';
import { recordIntegrationEvent } from '../server/repos/integrationEvents.ts';
import { discoverPlaces, PLACES_QUERIES, type Deps } from '../server/services/cash/neighborCard.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|yml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Brain's own settings that look like credentials and are not integrations with an outside service. */
const BRAIN_INTERNAL = new Set([
  'BRAIN_BRIDGE_KEY', 'BRAIN_OAUTH_ROTATION_KEY', 'BRAIN_PUBLIC_URL', 'BRAIN_URL', 'BRAIN_ROUTINE_BASE_URL',
  'BRAIN_CHEAP_LLM_WINDOW_TOKENS', 'BRAIN_TEST_DATABASE_URL', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_SERVER_URL',
  'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ETSY_AUTH_REDIRECT_URL',
]);

const ed = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

describe('the registry is the only way in', () => {
  it('declares every credential the server, scripts and workflows read', () => {
    const files = [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, '.github/workflows'))];
    const used = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/process\.env(?:\.|\[['"])([A-Z][A-Z0-9_]+)/g)) used.add(m[1]!);
      for (const m of text.matchAll(/secrets\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]!);
      for (const m of text.matchAll(/_ENV = '([A-Z][A-Z0-9_]+)'/g)) used.add(m[1]!);
    }
    const declared = declaredSettings();
    const credentialLike = [...used].filter((n) => /KEY|TOKEN|SECRET|PASSWORD|_URL$/.test(n));
    const undeclared = credentialLike.filter((n) => !declared.has(n) && !BRAIN_INTERNAL.has(n) && !/^BRAIN_ROUTINE_TOKEN/.test(n));
    expect(undeclared, 'declare these in server/services/integrations/registry.ts').toEqual([]);
  });

  it('gives every integration consumers, capabilities and an owner sentence, with unique ids', () => {
    expect(new Set(INTEGRATIONS.map((i) => i.id)).size).toBe(INTEGRATIONS.length);
    for (const one of INTEGRATIONS) {
      expect(one.consumers.length, one.id).toBeGreaterThan(0);
      expect(one.capabilities.length, one.id).toBeGreaterThan(0);
      expect(one.ownerAction.length, one.id).toBeGreaterThan(0);
    }
  });

  it('keeps the Integrations workflow naming exactly the secrets the registry declares', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/integrations.yml'), 'utf8');
    // GitHub refuses a run that reads every secret at once; each is named instead.
    expect(yml).not.toContain('toJSON(secrets)');
    const synced = [...yml.matchAll(/SYNC_([A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) \}\}/g)].map((m) => { expect(m[1]).toBe(m[2]); return m[1]!; });
    expect(synced.sort()).toEqual(githubSyncable());
    const present = [...yml.matchAll(/HAS_([A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) != '' \}\}/g)].map((m) => { expect(m[1]).toBe(m[2]); return m[1]!; });
    const actionsCredentials = [...new Set(INTEGRATIONS.flatMap((i) => i.credentials).filter((c) => c.where === 'GITHUB_ACTIONS').map((c) => c.name))].sort();
    expect(present.sort()).toEqual(actionsCredentials);
  });

  it('lets a connector deliver Instantly, and a GitHub secret supply Instantly and Stripe', () => {
    expect(sealable()).toContain('INSTANTLY_API_KEY');
    expect(githubSyncable()).toEqual(expect.arrayContaining(['INSTANTLY_API_KEY', 'STRIPE_SECRET_KEY']));
    // Model keys are never copied automatically: selecting a paid model is the owner's.
    expect(githubSyncable()).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('a held key selects its provider (the configuration mismatch that stopped the mailer)', () => {
  it('reads an Instantly key with no selection as Instantly', () => {
    const r = messagingConfig({ INSTANTLY_API_KEY: 'k'.repeat(40) });
    expect(r).toMatchObject({ provider: 'instantly', configured: true, derived: true });
  });
  it('keeps an explicit selection and still reads nothing as nothing', () => {
    expect(messagingConfig({ BRAIN_MESSAGING_PROVIDER: 'resend', INSTANTLY_API_KEY: 'k'.repeat(40) }).provider).toBe('resend');
    expect(messagingConfig({}).provider).toBeNull();
    expect(billingConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' })).toMatchObject({ provider: 'stripe', mode: 'TEST', derived: true });
  });
});

describe('health is read the same way for every integration', () => {
  it('says Brain repairs what it can supply and asks the owner only for the rest', async () => {
    const readings = await readIntegrations({ env: {}, githubSecrets: new Set(['FLY_API_TOKEN']) });
    const by = Object.fromEntries(readings.map((r) => [r.id, r]));
    expect(by.instantly!.state).toBe('REPAIRING');
    expect(by.instantly!.ownerAction).toBeNull();
    expect(by['google-places']!.state).toBe('REPAIRING');
    expect(by.supabase!.state).toBe('NEEDS_OWNER');
    expect(by.supabase!.ownerAction).toBeTruthy();
    expect(by.fly!.state).toBe('CONFIGURED');
    expect(by.etsy!.state).toBe('NEEDS_OWNER');
    expect(by.resend!.state).toBe('NOT_IN_USE');
  });

  it('turns a live refusal into the owner action and never prints the value', async () => {
    const secret = 'k'.repeat(30) + 'SECRETVALUE';
    const readings = await readIntegrations({
      env: { INSTANTLY_API_KEY: secret },
      probe: true,
      probes: { instantly: async () => ({ ok: false, detail: 'Instantly refused the key (401).' }) },
    });
    const instantly = readings.find((r) => r.id === 'instantly')!;
    expect(instantly.state).toBe('REFUSED');
    expect(instantly.ownerAction).toContain('INSTANTLY_API_KEY');
    expect(JSON.stringify(readings)).not.toContain('SECRETVALUE');
  });

  it('flags a malformed credential as refused, not missing', async () => {
    const readings = await readIntegrations({ env: { STRIPE_SECRET_KEY: 'not-a-key' } });
    expect(readings.find((r) => r.id === 'stripe')!.state).toBe('REFUSED');
  });
});

describe('the deployment keys', () => {
  it('signs exactly what V2 verifies', () => {
    const env = { BRAIN_INTEGRATION_SIGNING_KEY: ed() };
    const pub = signingPublicKey(env)!;
    expect(pub.kid).toBe(keyId(Buffer.from(pub.spki, 'base64')));
    const body = JSON.stringify({ probe: true });
    const headers = signRequest(signingKey(env)!, { method: 'POST', path: V2_PLACES_PATH, body, now: 1700000000000 });
    expect(headers['x-brain-key-id']).toBe(pub.kid);
    const key = createPublicKey({ key: Buffer.from(pub.spki, 'base64'), format: 'der', type: 'spki' });
    const data = Buffer.from(signedString('POST', V2_PLACES_PATH, '1700000000000', body), 'utf8');
    expect(verify(null, data, key, Buffer.from(headers['x-brain-signature'], 'base64'))).toBe(true);
  });

  it('reads an RSA seal key the way OpenSSL 3 writes it (PKCS#1 DER)', () => {
    const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'der', type: 'pkcs1' }).toString('base64');
    const env = { BRAIN_INTEGRATION_SEAL_KEY: pkcs1 };
    expect(sealPublicKey(env)).not.toBeNull();
    expect(unseal(seal(sealPublicKey(env)!.spki, 'v'), env)).toBe('v');
  });

  it('opens a sealed credential only with the deployment key', () => {
    const env = { BRAIN_INTEGRATION_SEAL_KEY: rsa() };
    const sealed = seal(sealPublicKey(env)!.spki, 'instantly-key-value');
    expect(sealed).not.toContain('instantly-key-value');
    expect(unseal(sealed, env)).toBe('instantly-key-value');
    expect(() => unseal(sealed, { BRAIN_INTEGRATION_SEAL_KEY: rsa() })).toThrow(/does not open/);
    expect(() => unseal(sealed, {})).toThrow(/not set/);
  });
});

describe('Google Places through V2', () => {
  const env = { BRAIN_INTEGRATION_SIGNING_KEY: ed() };
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('probes without a Google call and names an unpinned key', async () => {
    expect((await probeV2Places({ env, fetch: answer(200, { ok: true, placesKeyConfigured: true }) })).places).toBe('VERIFIED');
    const refused = await probeV2Places({ env, fetch: answer(401, { error: 'unauthorized' }) });
    expect(refused.bridge).toBe('REFUSED');
    expect(refused.detail).toContain('pinned');
    expect((await probeV2Places({ env: {} })).bridge).toBe('NOT_CONFIGURED');
  });

  it("reads an unpinned bridge as Brain's repair, not the owner's", async () => {
    const readings = await readIntegrations({
      env: { ...env, INSTANTLY_API_KEY: 'k'.repeat(40) },
      probe: true,
      probes: { 'v2-places': async () => ({ ok: 'repairing', detail: 'not pinned' }), 'v2-bridge': async () => ({ ok: 'repairing', detail: 'not pinned' }) },
    });
    for (const id of ['google-places', 'v2']) {
      const r = readings.find((one) => one.id === id)!;
      expect(r.state).toBe('REPAIRING');
      expect(r.ownerAction).toBeNull();
    }
  });

  it('records each search before sending it and stops at the ceiling', async () => {
    let used = 0;
    const meter = { used: async () => used, record: async () => { used += 1; } };
    const places = await searchPlacesViaV2('dentist in Camp Hill, PA', meter, { env, fetch: answer(200, { ok: true, places: [{ id: 'p1', name: 'Smile', website: 'https://smile.example' }] }) });
    expect(places).toHaveLength(1);
    expect(used).toBe(1);
    used = 24;
    await expect(searchPlacesViaV2('x in y', meter, { env, fetch: answer(200, { ok: true, places: [] }) })).rejects.toThrow(/ceiling/);
  });

  it('feeds the Neighbor Card discovery with operating businesses that have a site', async () => {
    const deps = {
      places: async () => [
        { id: 'a', name: 'Open Dental', website: 'opendental.example', businessStatus: 'OPERATIONAL', address: null, phone: null, primaryType: null },
        { id: 'b', name: 'No Site', website: null, businessStatus: 'OPERATIONAL', address: null, phone: null, primaryType: null },
        { id: 'c', name: 'Closed', website: 'https://closed.example', businessStatus: 'CLOSED_PERMANENTLY', address: null, phone: null, primaryType: null },
      ],
    } as unknown as Deps;
    const { found, line } = await discoverPlaces(deps, 0);
    expect(found.map((f) => f.website)).toEqual(['http://opendental.example']);
    expect(line).toContain(PLACES_QUERIES[0]!.query);
    expect((await discoverPlaces({} as Deps, 0)).found).toEqual([]);
  });
});

describe('recorded readings and repairs reach the page', () => {
  let dir = '';
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-integrations-'));
    await initDatabase({ dbPath: path.join(dir, 'brain.db') });
  });
  afterAll(async () => {
    await closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the latest live check, the repairs, and the owner actions', async () => {
    const env = { INSTANTLY_API_KEY: 'k'.repeat(40) };
    await recordIntegrationEvent({ integrationId: 'instantly', kind: 'REPAIR', state: 'SEALED', detail: 'INSTANTLY_API_KEY delivered sealed.', source: 'test' });
    await checkAndRecord({ env, source: 'test', probes: { instantly: async () => ({ ok: true, detail: '12 of 18 sending accounts healthy' }) } });
    const view = await integrationsView(env);
    const instantly = view.integrations.find((r) => r.id === 'instantly')!;
    expect(instantly.state).toBe('CONNECTED');
    expect(instantly.lastCheck?.detail).toContain('12 of 18');
    expect(view.repairs.map((r) => r.state)).toContain('SEALED');
    expect(view.ownerActions.some((a) => a.integration.startsWith('Supabase'))).toBe(true);
  });
});
