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

/** What production ran until 2026-11-12: RTX 2000 Ada (16 GB), vLLM, Qwen3-4B, measured at $0.24/h. */
export const POD_NAME = 'brain-vllm';
export const POD_GPU = 'NVIDIA RTX 2000 Ada Generation';
/**
 * Production's GPU first, then cards with at least its 16 GB. RunPod had no
 * RTX 2000 Ada free on 2026-11-10; the price ceiling, not this list, keeps a
 * dearer card out — one priced above it is deleted the moment it is created.
 */
export const POD_GPUS = [POD_GPU, 'NVIDIA RTX A4000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation'];
/** Qwen3 needs vLLM 0.8.5+; this build runs on CUDA 12.4 drivers, so more hosts qualify. */
export const POD_IMAGE = 'vllm/vllm-openai:v0.8.5.post1';
export const POD_MODEL = 'Qwen/Qwen3-4B';
/** The pod's measured price (docs/PARALLEL-EXECUTION-RESULT-2026-11-06.md). A dearer pod is refused. */
export const DEFAULT_MAX_USD_PER_HOUR = 0.24;

/**
 * A recipe is everything a pod serves, written down (§108): the model, the GPUs
 * that hold it, the image, and vLLM's flags — tool calling and context
 * included. Production's 4B recipe served no tool-call parser and 32K, so
 * Hermes' every call to it failed with HTTP 400 (opr_540994dd, opr_c2f2294d);
 * every recipe Brain can now choose names its parser and a window of 64K or more.
 */
export interface PodRecipe {
  key: string;
  /** The Hugging Face repository vLLM loads. */
  model: string;
  /** The name vLLM serves it under (what Brain sends as `model`). */
  served: string;
  gpus: string[];
  image: string;
  cuda: string[];
  maxModelLen: number;
  /** vLLM flags beyond the common ones: parsers, KV dtype, memory. */
  args: string[];
  containerDiskInGb: number;
  /** The GPU memory the recipe needs; a card with less is never asked for. */
  minGpuGb: number;
  /** Which RunPod cloud to ask first: the 24 GB cards are cheapest on COMMUNITY, the 2000 Ada on SECURE. */
  clouds: ('SECURE' | 'COMMUNITY')[];
  note: string;
}

/** 24 GB cards from cheapest measured community price (runpod-survey, 2026-11-12). */
const GPUS_24 = ['NVIDIA RTX A5000', 'NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 3090 Ti'];
/** 20 GB and up, for a model whose weights and 64K window fit 20 GB: more cards, so more stock. */
const GPUS_20 = ['NVIDIA RTX A5000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 3090 Ti'];
const CUDA_129 = ['12.9', '13.0'];
const IMAGE_2026 = 'vllm/vllm-openai:v0.32.0-cu129';

export const RECIPES: Record<string, PodRecipe> = {
  'qwen3-4b-legacy': {
    key: 'qwen3-4b-legacy',
    model: POD_MODEL,
    served: POD_MODEL,
    gpus: POD_GPUS,
    image: POD_IMAGE,
    cuda: ['12.4', '12.5', '12.6', '12.7', '12.8', '12.9', '13.0'],
    maxModelLen: 32768,
    args: ['--gpu-memory-utilization', '0.92', '--max-num-seqs', '16'],
    containerDiskInGb: 40,
    minGpuGb: 16,
    clouds: ['SECURE', 'COMMUNITY'],
    note: 'what production ran to 2026-11-12: no tool-call parser, 32K — unfit for the operator',
  },
  'gpt-oss-20b': {
    key: 'gpt-oss-20b',
    model: 'openai/gpt-oss-20b',
    served: 'openai/gpt-oss-20b',
    gpus: GPUS_20,
    image: IMAGE_2026,
    cuda: CUDA_129,
    // 64K fits a 20 GB card beside the 14 GB of weights; the operator needs 64K, not 128K.
    maxModelLen: 65536,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '16',
      '--enable-auto-tool-choice', '--tool-call-parser', 'openai', '--reasoning-parser', 'openai_gptoss',
    ],
    containerDiskInGb: 60,
    minGpuGb: 20,
    clouds: ['COMMUNITY', 'SECURE'],
    note: 'MoE 21B/3.6B active, MXFP4 ~14 GB, 128K native served at 64K; the free lane already runs its 120B sibling',
  },
  'qwen3.8-27b-awq': {
    key: 'qwen3.8-27b-awq',
    model: 'cyankiwi/Qwen3.8-27B-AWQ-INT4',
    served: 'Qwen/Qwen3.8-27B',
    gpus: GPUS_24,
    image: IMAGE_2026,
    cuda: CUDA_129,
    maxModelLen: 65536,
    args: [
      '--gpu-memory-utilization', '0.95', '--max-num-seqs', '8', '--kv-cache-dtype', 'fp8',
      '--limit-mm-per-prompt', '{"image":0,"video":0}',
      '--enable-auto-tool-choice', '--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'qwen3',
    ],
    containerDiskInGb: 60,
    minGpuGb: 24,
    clouds: ['COMMUNITY', 'SECURE'],
    note: 'dense hybrid 27B, AWQ 21 GB, 64K with FP8 KV; strongest model that fits 24 GB',
  },
  'gemma-4-26b-a4b-awq': {
    key: 'gemma-4-26b-a4b-awq',
    model: 'cyankiwi/gemma-4-26B-A4B-it-AWQ-4bit',
    served: 'google/gemma-4-26B-A4B-it',
    gpus: GPUS_24,
    image: IMAGE_2026,
    cuda: CUDA_129,
    maxModelLen: 65536,
    args: [
      '--gpu-memory-utilization', '0.93', '--max-num-seqs', '8',
      '--limit-mm-per-prompt', '{"image":0,"video":0}',
      '--enable-auto-tool-choice', '--tool-call-parser', 'gemma4', '--reasoning-parser', 'gemma4',
    ],
    containerDiskInGb: 50,
    minGpuGb: 24,
    clouds: ['COMMUNITY', 'SECURE'],
    note: 'MoE 26B/4B active, AWQ 17 GB, 64K',
  },
};

/** The recipe production serves. Chosen by measurement (docs/RUNPOD.md, §108), changed only with a benchmark behind it. */
export const ACTIVE_RECIPE = 'qwen3-4b-legacy';

export function recipeFor(key?: string | null): PodRecipe {
  const recipe = RECIPES[(key ?? '').trim() || ACTIVE_RECIPE];
  if (!recipe) throw new Error(`no pod recipe "${key}"; known: ${Object.keys(RECIPES).join(', ')}`);
  return recipe;
}

/** The pod body for RunPod's REST API. `model` overrides only the legacy recipe's model (its old signature). */
export function podSpec(
  apiKey: string,
  model = POD_MODEL,
  cloudType: 'SECURE' | 'COMMUNITY' = 'SECURE',
  recipe: PodRecipe = RECIPES['qwen3-4b-legacy']!,
  name = POD_NAME,
): Record<string, unknown> {
  const served = recipe.key === 'qwen3-4b-legacy' ? model : recipe.served;
  const loaded = recipe.key === 'qwen3-4b-legacy' ? model : recipe.model;
  return {
    name,
    cloudType,
    computeType: 'GPU',
    gpuTypeIds: recipe.gpus,
    gpuTypePriority: 'custom',
    gpuCount: 1,
    interruptible: false,
    imageName: recipe.image,
    allowedCudaVersions: recipe.cuda,
    dockerEntrypoint: ['python3', '-m', 'vllm.entrypoints.openai.api_server'],
    dockerStartCmd: [
      '--model', loaded, '--served-model-name', served,
      '--host', '0.0.0.0', '--port', '8000',
      '--api-key', apiKey,
      '--max-model-len', String(recipe.maxModelLen),
      '--enable-prefix-caching',
      ...recipe.args,
    ],
    ports: ['8000/http'],
    // Wiped with the pod; no persistent volume is ever paid for (the API's default is 20 GB).
    containerDiskInGb: recipe.containerDiskInGb,
    volumeInGb: 0,
  };
}

/** The model a pod was started with, read from its start command. */
export function podServedModel(pod: { dockerStartCmd?: unknown }): string | null {
  const cmd = Array.isArray(pod.dockerStartCmd) ? (pod.dockerStartCmd as string[]) : [];
  const at = cmd.indexOf('--served-model-name');
  return at >= 0 ? (cmd[at + 1] ?? null) : null;
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
type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; text: string }>;

function caller(apiKey: string, fetchImpl?: Fetch): Call {
  const f = fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${apiKey}` };
  return async (method, path, body) => {
    const response = await f(`${API}${path}`, {
      method,
      headers: body ? { ...auth, 'content-type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, text };
  };
}

export async function listPods(apiKey: string, fetchImpl?: Fetch): Promise<(Pod & { dockerStartCmd?: unknown })[]> {
  const listed = await caller(apiKey, fetchImpl)('GET', '/pods');
  if (!listed.ok) throw new Error(`RunPod refused to list pods: HTTP ${listed.status} ${listed.text.slice(0, 200)}`);
  return (JSON.parse(listed.text || '[]') as Pod[]) ?? [];
}

export async function deletePod(apiKey: string, podId: string, fetchImpl?: Fetch): Promise<number> {
  return (await caller(apiKey, fetchImpl)('DELETE', `/pods/${encodeURIComponent(podId)}`)).status;
}

/**
 * Create one pod from a recipe, on each cloud in the recipe's order, and keep it
 * only when RunPod prices it within the ceiling — a dearer one is deleted at once.
 */
export async function createPod(input: {
  apiKey: string;
  vllmKey: string;
  recipe: PodRecipe;
  name: string;
  maxUsdPerHour: number;
  model?: string;
  fetchImpl?: Fetch;
}): Promise<EnsureResult> {
  const call = caller(input.apiKey, input.fetchImpl);
  const log: string[] = [];
  const refusals: string[] = [];
  for (const cloud of input.recipe.clouds) {
    const made = await call('POST', '/pods', podSpec(input.vllmKey, input.model ?? POD_MODEL, cloud, input.recipe, input.name));
    if (!made.ok) {
      refusals.push(`${cloud}: HTTP ${made.status} ${made.text.replace(/\s+/g, ' ').slice(0, 700)}`);
      continue;
    }
    const pod = JSON.parse(made.text) as Pod;
    const cost = price(pod);
    if (cost === null || cost > input.maxUsdPerHour + 1e-9) {
      const gone = await call('DELETE', `/pods/${encodeURIComponent(pod.id)}`);
      refusals.push(`${cloud}: priced ${cost ?? 'unknown'}/h, over the ${input.maxUsdPerHour}/h ceiling; deleted (HTTP ${gone.status})`);
      continue;
    }
    log.push(`created pod ${pod.id} (${input.name}, ${input.recipe.key}) on ${cloud} at $${cost}/h (${pod.gpu?.displayName ?? input.recipe.gpus[0]})`);
    return { podId: pod.id, url: podUrl(pod.id), status: pod.desiredStatus ?? 'RUNNING', costPerHr: cost, created: true, log };
  }
  throw new Error(`no pod within $${input.maxUsdPerHour}/h could be created: ${refusals.join(' | ')}`);
}

/**
 * Brain's pod: the one the old address names, else one named `POD_NAME`, else
 * a new one from the recipe. Throws, with RunPod's words, when none can be had
 * within the ceiling.
 */
export async function ensurePod(input: {
  apiKey: string;
  vllmKey: string;
  oldUrl?: string | null;
  model?: string;
  recipe?: PodRecipe;
  maxUsdPerHour?: number;
  fetchImpl?: Fetch;
}): Promise<EnsureResult> {
  const ceiling = input.maxUsdPerHour ?? DEFAULT_MAX_USD_PER_HOUR;
  const live = (pod: Pod | undefined) => !!pod && pod.desiredStatus !== 'TERMINATED';
  const oldId = /^https?:\/\/([a-z0-9]+)-\d+\.proxy\.runpod\.net/i.exec(input.oldUrl?.trim() ?? '')?.[1]?.toLowerCase();
  const pods = await listPods(input.apiKey, input.fetchImpl);
  const found = pods.find((p) => p.id === oldId && live(p)) ?? pods.find((p) => p.name === POD_NAME && live(p));
  if (found) {
    return {
      podId: found.id,
      url: podUrl(found.id),
      status: found.desiredStatus ?? 'UNKNOWN',
      costPerHr: price(found),
      created: false,
      log: [`found pod ${found.id} (${found.desiredStatus ?? 'unknown'}) serving ${podServedModel(found) ?? 'unknown'}`],
    };
  }
  const made = await createPod({
    apiKey: input.apiKey,
    vllmKey: input.vllmKey,
    recipe: input.recipe ?? recipeFor(null),
    name: POD_NAME,
    maxUsdPerHour: ceiling,
    ...(input.model ? { model: input.model } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return { ...made, log: [oldId ? `pod ${oldId} no longer exists` : 'no pod recorded', ...made.log] };
}

/** Pods a benchmark made are named so; one older than this is a leak and is deleted (§108). */
export const BENCH_PREFIX = 'brain-bench-';
export const BENCH_MAX_MINUTES = 90;

/** Delete benchmark pods left behind by a cancelled run. Returns what it deleted. */
export async function sweepBenchPods(apiKey: string, nowMs = Date.now(), fetchImpl?: Fetch): Promise<string[]> {
  const gone: string[] = [];
  for (const pod of await listPods(apiKey, fetchImpl)) {
    if (!pod.name?.startsWith(BENCH_PREFIX)) continue;
    const created = Date.parse(String((pod as unknown as Record<string, unknown>)['createdAt'] ?? ''));
    const age = Number.isFinite(created) ? (nowMs - created) / 60_000 : Infinity;
    if (age < BENCH_MAX_MINUTES) continue;
    await deletePod(apiKey, pod.id, fetchImpl);
    gone.push(pod.id);
  }
  return gone;
}
