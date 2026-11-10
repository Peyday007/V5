/**
 * The GPU worker's recipe, and recovery when its pod is gone.
 *
 * RunPod deletes a pod when the account runs out of balance (production,
 * 2026-11-10: the pod's proxy answered 404 and every GPU call fell back). The
 * pod was made by hand, so nothing could make it again. `POD_SPEC` is that pod,
 * written down: the GPU, image, start command and model production ran, with no
 * paid persistent volume. `ensurePod` finds Brain's pod, or creates one from the
 * spec and deletes it again at once if RunPod prices it above the ceiling.
 *
 * It never starts or stops an existing pod: that is `runpodPod.ts`'s job.
 */
import type { Fetch } from './runpod.ts';

const API = 'https://rest.runpod.io/v1';

/** What production ran: RTX 2000 Ada (16 GB), vLLM, Qwen3-4B, measured at $0.24/h. */
export const POD_NAME = 'brain-vllm';
export const POD_GPU = 'NVIDIA RTX 2000 Ada Generation';
export const POD_IMAGE = 'vllm/vllm-openai:v0.10.1.1';
export const POD_MODEL = 'Qwen/Qwen3-4B';
/** The pod's measured price (docs/PARALLEL-EXECUTION-RESULT-2026-11-06.md). A dearer pod is refused. */
export const DEFAULT_MAX_USD_PER_HOUR = 0.24;

export function podSpec(apiKey: string, model = POD_MODEL, cloudType: 'SECURE' | 'COMMUNITY' = 'SECURE'): Record<string, unknown> {
  return {
    name: POD_NAME,
    cloudType,
    computeType: 'GPU',
    gpuTypeIds: [POD_GPU],
    gpuCount: 1,
    interruptible: false,
    imageName: POD_IMAGE,
    allowedCudaVersions: ['12.8', '12.9', '13.0'],
    dockerEntrypoint: ['python3', '-m', 'vllm.entrypoints.openai.api_server'],
    dockerStartCmd: [
      '--model', model, '--served-model-name', model,
      '--host', '0.0.0.0', '--port', '8000',
      '--api-key', apiKey,
      '--max-model-len', '32768', '--gpu-memory-utilization', '0.92',
      '--enable-prefix-caching', '--max-num-seqs', '16',
    ],
    ports: ['8000/http'],
    // Wiped with the pod; no persistent volume is ever paid for (the API's default is 20 GB).
    containerDiskInGb: 40,
    volumeInGb: 0,
  };
}

export const podUrl = (podId: string): string => `https://${podId}-8000.proxy.runpod.net/v1`;

interface Pod {
  id: string;
  name?: string;
  desiredStatus?: string;
  costPerHr?: number | string;
  adjustedCostPerHr?: number | string;
  gpu?: { displayName?: string };
}

const price = (pod: Pod): number | null => {
  const n = Number(pod.adjustedCostPerHr ?? pod.costPerHr);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export interface EnsureResult {
  podId: string;
  url: string;
  status: string;
  costPerHr: number | null;
  created: boolean;
  log: string[];
}

/**
 * Brain's pod: the one the old address names, else one named `POD_NAME`, else
 * a new one from the spec. Throws, with RunPod's words, when none can be had
 * within the ceiling.
 */
export async function ensurePod(input: {
  apiKey: string;
  vllmKey: string;
  oldUrl?: string | null;
  model?: string;
  maxUsdPerHour?: number;
  fetchImpl?: Fetch;
}): Promise<EnsureResult> {
  const f = input.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${input.apiKey}` };
  const ceiling = input.maxUsdPerHour ?? DEFAULT_MAX_USD_PER_HOUR;
  const log: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await f(`${API}${path}`, {
      method,
      headers: body ? { ...auth, 'content-type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, text };
  };
  const live = (pod: Pod | undefined) => !!pod && pod.desiredStatus !== 'TERMINATED';

  const oldId = /^https?:\/\/([a-z0-9]+)-\d+\.proxy\.runpod\.net/i.exec(input.oldUrl?.trim() ?? '')?.[1]?.toLowerCase();
  const listed = await call('GET', '/pods');
  if (!listed.ok) throw new Error(`RunPod refused to list pods: HTTP ${listed.status} ${listed.text.slice(0, 200)}`);
  const pods = (JSON.parse(listed.text || '[]') as Pod[]) ?? [];
  const found = pods.find((p) => p.id === oldId && live(p)) ?? pods.find((p) => p.name === POD_NAME && live(p));
  if (found) {
    log.push(`found pod ${found.id} (${found.desiredStatus ?? 'unknown'})`);
    return { podId: found.id, url: podUrl(found.id), status: found.desiredStatus ?? 'UNKNOWN', costPerHr: price(found), created: false, log };
  }
  log.push(oldId ? `pod ${oldId} no longer exists` : 'no pod recorded');

  const refusals: string[] = [];
  for (const cloud of ['SECURE', 'COMMUNITY'] as const) {
    const made = await call('POST', '/pods', podSpec(input.vllmKey, input.model ?? POD_MODEL, cloud));
    if (!made.ok) {
      refusals.push(`${cloud}: HTTP ${made.status} ${made.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      continue;
    }
    const pod = JSON.parse(made.text) as Pod;
    const cost = price(pod);
    if (cost === null || cost > ceiling + 1e-9) {
      const gone = await call('DELETE', `/pods/${encodeURIComponent(pod.id)}`);
      refusals.push(`${cloud}: priced ${cost ?? 'unknown'}/h, over the ${ceiling}/h ceiling; deleted (HTTP ${gone.status})`);
      continue;
    }
    log.push(`created pod ${pod.id} on ${cloud} at $${cost}/h (${pod.gpu?.displayName ?? POD_GPU})`);
    return { podId: pod.id, url: podUrl(pod.id), status: pod.desiredStatus ?? 'RUNNING', costPerHr: cost, created: true, log };
  }
  throw new Error(`no pod within $${ceiling}/h could be created: ${refusals.join(' | ')}`);
}
