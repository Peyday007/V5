/**
 * Brain's door into V2 (`Peyday007/V2`, the Dispatch Board on Vercel), §103.
 *
 * V2 holds a working Google Places (New) key in its own deployment. Copying it
 * to Brain would need the owner, and would leave two copies to rotate; instead
 * V2 serves `/api/brain/places`, which accepts only a request signed with the
 * key `keys.ts` reads, whose public half V2 pins in `src/lib/brainBridge.ts`.
 * The Google key never leaves V2, and nothing new is configured on Vercel.
 *
 * Places bills per call, so every search is metered against the registry's
 * daily ceiling before it is sent (invariant 38: a ceiling first, then a
 * commitment), and the probe sends no Google request at all.
 */
import { signRequest, signingKey } from './keys.ts';
import { integration } from './registry.ts';

export const V2_BASE_URL = 'https://v2-4-points.vercel.app';
export const V2_PLACES_PATH = '/api/brain/places';

type FetchLike = typeof fetch;

export interface V2Place {
  id: string;
  name: string | null;
  address: string | null;
  website: string | null;
  phone: string | null;
  primaryType: string | null;
  businessStatus: string | null;
}

export interface PlacesMeter {
  /** Calls already made today. */
  used(): Promise<number>;
  /** Record one call before it is sent. */
  record(detail: string): Promise<void>;
}

async function call(
  body: Record<string, unknown>,
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; baseUrl?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const key = signingKey(options.env ?? process.env);
  if (!key) throw new Error('BRAIN_INTEGRATION_SIGNING_KEY is not set on this deployment; the Integrations workflow generates it.');
  const raw = JSON.stringify(body);
  const headers = signRequest(key, { method: 'POST', path: V2_PLACES_PATH, body: raw });
  const res = await (options.fetch ?? fetch)(`${options.baseUrl ?? V2_BASE_URL}${V2_PLACES_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* an unreadable answer is reported by status */
  }
  return { status: res.status, json };
}

export type BridgeVerdict = 'VERIFIED' | 'NOT_CONFIGURED' | 'REFUSED' | 'UNREACHABLE';

/** Is the bridge accepted, and does V2 hold a Places key? Sends no Google request. */
export async function probeV2Places(options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; baseUrl?: string } = {}): Promise<{
  bridge: BridgeVerdict;
  places: BridgeVerdict;
  detail: string;
}> {
  if (!signingKey(options.env ?? process.env)) {
    return { bridge: 'NOT_CONFIGURED', places: 'NOT_CONFIGURED', detail: 'BRAIN_INTEGRATION_SIGNING_KEY is not set on this deployment.' };
  }
  try {
    // `verify` asks V2 to ask Google with an IDs-only search (no charge), so a
    // key Google refuses reads as refused rather than as merely present.
    const { status, json } = await call({ probe: true, verify: true }, options);
    if (status === 401) {
      return { bridge: 'REFUSED', places: 'REFUSED', detail: "V2 refused Brain's signature: the deployment's public key is not pinned in V2's src/lib/brainBridge.ts." };
    }
    if (status === 404) return { bridge: 'NOT_CONFIGURED', places: 'NOT_CONFIGURED', detail: 'V2 does not serve /api/brain/places yet (its bridge is not deployed).' };
    if (status !== 200) return { bridge: 'UNREACHABLE', places: 'UNREACHABLE', detail: `V2 answered ${status}.` };
    if (json.placesKeyConfigured !== true) {
      return { bridge: 'VERIFIED', places: 'NOT_CONFIGURED', detail: 'V2 accepted the signed probe and has no GOOGLE_PLACES_API_KEY.' };
    }
    const google = json.google as { accepted?: boolean; status?: number; reasons?: string[]; googleStatus?: string | null } | undefined;
    if (!google) return { bridge: 'VERIFIED', places: 'VERIFIED', detail: 'V2 accepted the signed probe and holds a Places key.' };
    if (google.accepted) return { bridge: 'VERIFIED', places: 'VERIFIED', detail: 'V2 accepted the signed probe, and Google accepted its Places key.' };
    if (!google.status) return { bridge: 'VERIFIED', places: 'UNREACHABLE', detail: 'V2 could not reach Google.' };
    return { bridge: 'VERIFIED', places: 'REFUSED', detail: `Google refused V2's Places key: ${googleRefusal(google.status, google.reasons ?? [], google.googleStatus ?? null)}` };
  } catch (error) {
    return { bridge: 'UNREACHABLE', places: 'UNREACHABLE', detail: `V2 did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Google's own refusal codes, as the one setting to change. */
export function googleRefusal(status: number, reasons: string[], googleStatus: string | null): string {
  const codes = [...reasons, ...(googleStatus ? [googleStatus] : [])];
  const has = (re: RegExp) => codes.some((c) => re.test(c));
  const fix = has(/BILLING/) ? 'billing is not enabled on the Google Cloud project the key belongs to'
    : has(/SERVICE_DISABLED|API_NOT_ACTIVATED/) ? 'Places API (New) is not enabled on the key\'s Google Cloud project'
    : has(/SERVICE_BLOCKED/) ? 'the key\'s API restrictions do not include Places API (New)'
    : has(/REFERRER|IP_ADDRESS|ANDROID|IOS/) ? 'the key has an application restriction a server call cannot meet (set Application restrictions to None)'
    : has(/API_KEY_INVALID|INVALID_ARGUMENT/) ? 'the key is invalid or deleted'
    : 'see the codes';
  return `HTTP ${status}${codes.length ? ` (${codes.join(', ')})` : ''}; ${fix}.`;
}

/** One Text Search through V2, inside the daily ceiling. */
export async function searchPlacesViaV2(
  textQuery: string,
  meter: PlacesMeter,
  options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; baseUrl?: string; latitude?: number; longitude?: number; radiusM?: number } = {},
): Promise<V2Place[]> {
  const ceiling = integration('google-places').dailyCeiling ?? 0;
  const used = await meter.used();
  if (used >= ceiling) throw new Error(`the Places ceiling of ${ceiling} calls a day is reached (${used} today)`);
  await meter.record(textQuery);
  const { latitude, longitude, radiusM } = options;
  const { status, json } = await call({ textQuery, ...(latitude != null && longitude != null && radiusM ? { latitude, longitude, radiusM } : {}) }, options);
  if (status !== 200) {
    const hint = typeof json.hint === 'string' && json.hint ? `: ${json.hint}` : '';
    throw new Error(`V2 Places answered ${status} ${String(json.error ?? '')}${hint}`.trim());
  }
  return Array.isArray(json.places) ? (json.places as V2Place[]) : [];
}
