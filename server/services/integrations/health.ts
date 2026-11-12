/**
 * The health of every declared integration (§103), read the same way for all
 * of them: each credential present and well-formed where the registry says it
 * lives, then the integration's live probe (which sends nothing), then the one
 * next step — an automatic repair Brain will make, or the owner's action when
 * no automatic path remains.
 *
 * Every string names settings and states, never a value.
 */
import { getDb } from '../../db/database.ts';
import { probeInstantly } from '../cash/providers/instantly.ts';
import { probeStripe } from '../cash/providers/stripe.ts';
import { listIntegrationEvents, recordIntegrationEvent, type IntegrationEvent } from '../../repos/integrationEvents.ts';
import { INTEGRATIONS, type CredentialDelivery, type IntegrationDefinition } from './registry.ts';
import { probeV2Places } from './v2Bridge.ts';

export type IntegrationState =
  /** Credentials present and the live probe accepted them. */
  | 'CONNECTED'
  /** Credentials present; this integration has no live probe, or it was not run. */
  | 'CONFIGURED'
  /** A required credential is absent, and an automatic delivery exists for it. */
  | 'REPAIRING'
  /** A required credential is absent, and only the owner can supply it. */
  | 'NEEDS_OWNER'
  /** Present but malformed, or the service refused it (expired, revoked, restricted). */
  | 'REFUSED'
  /** The service did not answer; nothing is wrong with the configuration that Brain can see. */
  | 'UNREACHABLE'
  /** Not required and not set: implemented, and not chosen. */
  | 'NOT_IN_USE';

export type CredentialState = 'PRESENT' | 'MISSING' | 'MALFORMED' | 'ELSEWHERE';

export interface CredentialReading {
  name: string;
  where: string;
  required: boolean;
  state: CredentialState;
  /** The automatic delivery Brain uses for it when missing, or null when only the owner can. */
  repair: CredentialDelivery | null;
}

export interface IntegrationReading {
  id: string;
  name: string;
  purpose: string;
  heldBy: string;
  state: IntegrationState;
  detail: string;
  credentials: CredentialReading[];
  consumers: { component: string; path: string }[];
  capabilities: string[];
  dailyCeiling: number | null;
  /** Only set when the owner's hands are needed. */
  ownerAction: string | null;
  checkedAt: string;
}

/** ok: accepted; false: refused (the owner's); null: no answer; 'repairing': Brain is completing it. */
export interface ProbeResult {
  ok: boolean | null | 'repairing';
  detail: string;
}

const AUTOMATIC: CredentialDelivery[] = ['GITHUB_SECRET', 'CONNECTOR_SEALED', 'GENERATED', 'WORKFLOW'];

export interface ReadOptions {
  env?: NodeJS.ProcessEnv;
  /** Names of the GitHub repository secrets that exist (the Integrations workflow passes them). */
  githubSecrets?: Set<string> | null;
  /** Run the live probes. Off for the page's instant reading, on for a check. */
  probe?: boolean;
  /** Injected by tests. */
  probes?: Partial<Record<string, () => Promise<ProbeResult>>>;
}

function readCredential(
  spec: IntegrationDefinition['credentials'][number],
  env: NodeJS.ProcessEnv,
  githubSecrets: Set<string> | null,
): CredentialReading {
  // A GitHub secret supplies nothing when the repository holds none of that
  // name, so with the workflow's list in hand that path is not counted.
  const usable = (d: CredentialDelivery) => AUTOMATIC.includes(d) && !(d === 'GITHUB_SECRET' && githubSecrets && !githubSecrets.has(spec.name));
  const repair = spec.delivery.find(usable) ?? null;
  const base = { name: spec.name, where: spec.where, required: spec.required, repair };
  if (spec.where === 'CONNECTED_PROJECT') return { ...base, state: 'ELSEWHERE' };
  if (spec.where === 'GITHUB_ACTIONS') {
    if (!githubSecrets) return { ...base, state: 'ELSEWHERE' };
    return { ...base, state: githubSecrets.has(spec.name) ? 'PRESENT' : 'MISSING' };
  }
  const value = (env[spec.name] ?? '').trim();
  if (!value) return { ...base, state: 'MISSING' };
  if (spec.shape && !spec.shape.test(value)) return { ...base, state: 'MALFORMED' };
  return { ...base, state: 'PRESENT' };
}

/** The live probes, each answering ok (true), refused (false) or unreachable (null). */
function liveProbes(env: NodeJS.ProcessEnv): Record<string, () => Promise<ProbeResult>> {
  return {
    instantly: async () => {
      const r = await probeInstantly({ env });
      return { ok: r.verdict === 'VERIFIED' ? true : r.verdict === 'REFUSED' ? false : null, detail: r.detail };
    },
    stripe: async () => {
      const r = await probeStripe({ env });
      return { ok: r.verdict === 'VERIFIED' ? true : r.verdict === 'BAD_CREDENTIAL' ? false : null, detail: r.detail };
    },
    // A bridge V2 does not trust yet (key unpinned, route undeployed) is Brain's
    // own unfinished repair, never the owner's; only V2 holding no Places key is.
    'v2-places': async () => {
      const r = await probeV2Places({ env });
      const ok = r.places === 'VERIFIED' ? true : r.places === 'UNREACHABLE' ? null : r.bridge !== 'VERIFIED' ? 'repairing' : false;
      return { ok, detail: r.detail };
    },
    'v2-bridge': async () => {
      const r = await probeV2Places({ env });
      return { ok: r.bridge === 'VERIFIED' ? true : r.bridge === 'UNREACHABLE' ? null : 'repairing', detail: r.detail };
    },
    database: async () => {
      await getDb().all('SELECT 1 AS one', []);
      return { ok: true, detail: 'The database answered.' };
    },
  };
}

export async function readIntegrations(options: ReadOptions = {}): Promise<IntegrationReading[]> {
  const env = options.env ?? process.env;
  const githubSecrets = options.githubSecrets ?? null;
  const probes = { ...liveProbes(env), ...(options.probes ?? {}) };
  const checkedAt = new Date().toISOString();

  return Promise.all(INTEGRATIONS.map(async (def): Promise<IntegrationReading> => {
    const credentials = def.credentials.map((spec) => readCredential(spec, env, githubSecrets));
    const required = credentials.filter((c) => c.required);
    const missing = required.filter((c) => c.state === 'MISSING');
    const malformed = credentials.filter((c) => c.state === 'MALFORMED');
    const reading = (state: IntegrationState, detail: string, owner = false): IntegrationReading => ({
      id: def.id,
      name: def.name,
      purpose: def.purpose,
      heldBy: def.heldBy,
      state,
      detail,
      credentials,
      consumers: def.consumers,
      capabilities: def.capabilities,
      dailyCeiling: def.dailyCeiling,
      ownerAction: owner ? def.ownerAction : null,
      checkedAt,
    });

    if (malformed.length > 0) {
      return reading('REFUSED', `Malformed: ${malformed.map((c) => c.name).join(', ')}.`, true);
    }
    if (missing.length > 0) {
      const ownerOnly = missing.filter((c) => c.repair === null);
      const names = missing.map((c) => `${c.name}${c.repair ? ` (Brain supplies it: ${c.repair.toLowerCase().replace('_', ' ')})` : ''}`);
      return ownerOnly.length > 0
        ? reading('NEEDS_OWNER', `Missing: ${names.join(', ')}.`, true)
        : reading('REPAIRING', `Missing: ${names.join(', ')}.`);
    }
    if (required.length === 0 && credentials.every((c) => c.state === 'MISSING')) {
      return reading('NOT_IN_USE', 'Implemented and not selected.');
    }
    if (!def.probe || !options.probe) {
      const elsewhere = credentials.filter((c) => c.state === 'ELSEWHERE').map((c) => `${c.name} (${c.where === 'GITHUB_ACTIONS' ? 'GitHub Actions' : 'connected project'})`);
      const held = elsewhere.length ? ` Held outside this machine: ${elsewhere.join(', ')}.` : '';
      return reading('CONFIGURED', `${def.probe ? 'Credentials present; the live check runs with the next Integrations pass.' : 'Credentials present.'}${held}`);
    }
    const probe = probes[def.probe];
    if (!probe) return reading('CONFIGURED', 'Credentials present.');
    try {
      const result = await probe();
      if (result.ok === true) return reading('CONNECTED', result.detail);
      if (result.ok === 'repairing') return reading('REPAIRING', result.detail);
      if (result.ok === false) return reading('REFUSED', result.detail, true);
      return reading('UNREACHABLE', result.detail);
    } catch (error) {
      return reading('UNREACHABLE', error instanceof Error ? error.message : String(error));
    }
  }));
}

/** Probe everything and record each reading (the Integrations workflow's check). */
export async function checkAndRecord(options: ReadOptions & { source: string }): Promise<IntegrationReading[]> {
  const readings = await readIntegrations({ ...options, probe: true });
  for (const r of readings) {
    await recordIntegrationEvent({ integrationId: r.id, kind: 'CHECK', state: r.state, detail: r.detail, source: options.source });
  }
  return readings;
}

export interface IntegrationsView {
  integrations: (IntegrationReading & { lastCheck: IntegrationEvent | null })[];
  repairs: IntegrationEvent[];
  ownerActions: { integration: string; action: string }[];
}

/**
 * What the Integrations page shows: the registry, read against this machine's
 * environment now, with the newest recorded check (which carries the live
 * probe's answer) and the repairs Brain has made.
 */
export async function integrationsView(env: NodeJS.ProcessEnv = process.env): Promise<IntegrationsView> {
  const now = await readIntegrations({ env, probe: false });
  const checks = await listIntegrationEvents('CHECK', 500);
  const repairs = await listIntegrationEvents('REPAIR', 50);
  const integrations = now.map((r) => {
    const lastCheck = checks.find((c) => c.integrationId === r.id) ?? null;
    // A recorded live answer is more specific than presence, unless presence has since changed.
    if (lastCheck && r.state === 'CONFIGURED') {
      const state = lastCheck.state as IntegrationState;
      const owner = state === 'REFUSED' || state === 'NEEDS_OWNER';
      return { ...r, state, detail: lastCheck.detail, ownerAction: owner ? INTEGRATIONS.find((d) => d.id === r.id)!.ownerAction : null, lastCheck };
    }
    return { ...r, lastCheck };
  });
  return {
    integrations,
    repairs,
    ownerActions: integrations.filter((r) => r.ownerAction).map((r) => ({ integration: r.name, action: r.ownerAction! })),
  };
}
