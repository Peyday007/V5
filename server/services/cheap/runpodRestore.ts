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
  /**
   * Cards in the pod (default 1). Above 1 the recipe serves `--data-parallel-size` replicas of
   * the model behind one address, so Brain's single GPU route gets that many times the sequences.
   */
  gpuCount?: number;
  /** Which RunPod cloud to ask first: the 24 GB cards are cheapest on COMMUNITY, the 2000 Ada on SECURE. */
  clouds: ('SECURE' | 'COMMUNITY')[];
  note: string;
}

/** 24 GB cards from cheapest measured community price (runpod-survey, 2026-11-12). */
const GPUS_24 = ['NVIDIA RTX A5000', 'NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 3090 Ti'];
/** 20 GB and up, for a model whose weights and 64K window fit 20 GB: more cards, so more stock. */
const GPUS_20 = ['NVIDIA RTX A5000', 'NVIDIA RTX A4500', 'NVIDIA RTX 4000 Ada Generation', 'NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 3090 Ti'];
/** 48 GB cards from cheapest measured community price (runpod-survey 43281884981, 2026-11-12). */
const GPUS_48 = ['NVIDIA RTX A6000', 'NVIDIA A40', 'NVIDIA L40', 'NVIDIA L40S', 'NVIDIA RTX 6000 Ada Generation'];
/** 80 GB and up, fastest first: the H100s and H200 serve MXFP4 natively; the A100s are the stock fallback. */
const GPUS_80 = ['NVIDIA H100 80GB HBM3', 'NVIDIA H100 NVL', 'NVIDIA H100 PCIe', 'NVIDIA H200', 'NVIDIA A100-SXM4-80GB', 'NVIDIA A100 80GB PCIe'];
/**
 * The CUDA versions a host may offer this image. v0.11.0 is built for 12.8, which every
 * 12.8+ driver runs (the earlier 12.9/13.0 list served the v0.32 image, which never ran).
 */
const CUDA_129 = ['12.8', '12.9', '13.0'];
/**
 * The image for every recipe newer than the 2025 4B one. Measured, not assumed (cheap-lane
 * runpod-diagnose on an H200, CUDA 12.9 driver, 2026-11-16): v0.32.0-cu129 and v0.31.0-cu129 fail
 * to import vLLM (torchcodec needs libnvrtc.so.13, a CUDA 13 library the cu129 image lacks);
 * v0.30.0-cu129 fails on a torchvision mismatch; the untagged builds are CUDA 13, which these
 * hosts' drivers do not run. v0.11.0 and v0.10.2 import cleanly (torch 2.8.0+cu128) and serve
 * gpt-oss's tool and reasoning parsers. Every pod on the v0.32 image crash-looped within seconds,
 * which is why no 2026 recipe ever served before this.
 */
const IMAGE_2026 = 'vllm/vllm-openai:v0.11.0';


function dataParallel120b(n: number): PodRecipe {
  return {
    key: `gpt-oss-120b-${n}x80`,
    model: 'openai/gpt-oss-120b',
    served: 'openai/gpt-oss-120b',
    // Only the types RunPod shows multi-card stock for (runpod-survey 43897665060, 2026-11-16:
    // x2/x4 H100 HBM3 and H200 "Low", every other 80 GB type none); a list naming types with no
    // multi-card stock was refused "no instances currently available".
    gpus: ['NVIDIA H100 80GB HBM3', 'NVIDIA H200'],
    image: IMAGE_2026,
    // No CUDA filter: with it, x2 and x4 were refused "no instances" while the survey showed stock.
    // A host whose driver cannot run the image fails the probe, and the upgrade deletes the pod.
    cuda: [],
    maxModelLen: 131072,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '48', '--data-parallel-size', String(n),
      '--enable-auto-tool-choice', '--tool-call-parser', 'openai', '--reasoning-parser', 'openai_gptoss',
    ],
    containerDiskInGb: 250,
    minGpuGb: 80,
    gpuCount: n,
    clouds: ['SECURE', 'COMMUNITY'],
    note: `gpt-oss-120b, ${n} data-parallel replicas on ${n} x 80 GB, 128K, ${48 * n} parallel sequences behind one address`,
  };
}

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
  /**
   * The existing 16 GB pod, repurposed rather than replaced (§108): its known-good
   * image, a stronger model, the tool-call parser, and 64K by YaRN with an FP8 KV
   * cache (weights ~6 GB + 64K × 72 KiB ≈ 4.7 GB fits the 14.7 GB vLLM may use).
   * 2026-11-12: the 24 GB cards had no stock and a 20B pod on a fresh image never
   * served; this one keeps the host, the GPU and the image that already boot.
   */
  'qwen3-8b-awq-tools': {
    key: 'qwen3-8b-awq-tools',
    model: 'Qwen/Qwen3-8B-AWQ',
    served: 'Qwen/Qwen3-8B-AWQ',
    gpus: POD_GPUS,
    image: POD_IMAGE,
    cuda: ['12.4', '12.5', '12.6', '12.7', '12.8', '12.9', '13.0'],
    maxModelLen: 65536,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '12', '--kv-cache-dtype', 'fp8',
      '--rope-scaling', '{"rope_type":"yarn","factor":2.0,"original_max_position_embeddings":32768}',
      '--enable-auto-tool-choice', '--tool-call-parser', 'hermes',
    ],
    containerDiskInGb: 40,
    minGpuGb: 16,
    clouds: ['SECURE', 'COMMUNITY'],
    note: 'Qwen3-8B AWQ on the existing 16 GB pod: tool calls (hermes parser), 64K by YaRN, FP8 KV',
  },
  /**
   * The 4B at 4 bits on the same pod: weights ~2.5 GB leave room for a full
   * 64K bf16 KV cache (64K × 144 KiB ≈ 9.4 GB) with no FP8 KV — the 8B with FP8 KV
   * served /v1/models and answered every chat HTTP 500 on this vLLM build (2026-11-12 21:17).
   */
  'qwen3-4b-awq-tools': {
    key: 'qwen3-4b-awq-tools',
    model: 'Qwen/Qwen3-4B-AWQ',
    served: 'Qwen/Qwen3-4B-AWQ',
    gpus: POD_GPUS,
    image: POD_IMAGE,
    cuda: ['12.4', '12.5', '12.6', '12.7', '12.8', '12.9', '13.0'],
    maxModelLen: 65536,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '8',
      '--rope-scaling', '{"rope_type":"yarn","factor":2.0,"original_max_position_embeddings":32768}',
      '--enable-auto-tool-choice', '--tool-call-parser', 'hermes',
    ],
    containerDiskInGb: 40,
    minGpuGb: 16,
    clouds: ['SECURE', 'COMMUNITY'],
    note: 'Qwen3-4B AWQ on the existing 16 GB pod: tool calls, 64K by YaRN, bf16 KV',
  },
  /** The production model with only the missing parser added, at its native 32K: the last step before reverting. */
  'qwen3-4b-tools-32k': {
    key: 'qwen3-4b-tools-32k',
    model: POD_MODEL,
    served: POD_MODEL,
    gpus: POD_GPUS,
    image: POD_IMAGE,
    cuda: ['12.4', '12.5', '12.6', '12.7', '12.8', '12.9', '13.0'],
    maxModelLen: 32768,
    args: ['--gpu-memory-utilization', '0.92', '--max-num-seqs', '16', '--enable-auto-tool-choice', '--tool-call-parser', 'hermes'],
    containerDiskInGb: 40,
    minGpuGb: 16,
    clouds: ['SECURE', 'COMMUNITY'],
    note: 'production 4B plus the hermes tool-call parser, 32K: research and tools, under Hermes 64K',
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
  /**
   * The strongest open reasoning model one card holds (2026-11-16 acceleration, owner-funded
   * $250 / 15 h): gpt-oss-120b, MoE 117B/5.1B active, MXFP4 ~61 GB on an 80 GB card. Its
   * sliding-window layers keep the KV cache small, so 128K and 48 sequences fit beside the
   * weights: one pod serves Hermes and the research lane in parallel. Above every default
   * ceiling — dispatched only with an explicit `max_usd_per_hour`.
   */
  'gpt-oss-120b-80': {
    key: 'gpt-oss-120b-80',
    model: 'openai/gpt-oss-120b',
    served: 'openai/gpt-oss-120b',
    gpus: GPUS_80,
    image: IMAGE_2026,
    cuda: CUDA_129,
    maxModelLen: 131072,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '48',
      '--enable-auto-tool-choice', '--tool-call-parser', 'openai', '--reasoning-parser', 'openai_gptoss',
    ],
    // 120 GB ran out mid-download (runpod-diagnose 2026-11-16: "CAS service error: No space left on
    // device"): ~65 GB of weights plus the hub's chunk cache of the same bytes. Disk is cents an hour.
    containerDiskInGb: 250,
    minGpuGb: 80,
    clouds: ['SECURE', 'COMMUNITY'],
    note: 'MoE 117B/5.1B active, MXFP4 ~61 GB on an 80 GB card (H100/H200/A100-80), 128K, 48 parallel sequences',
  },
  /**
   * gpt-oss-120b as data-parallel replicas on 2 or 4 80 GB cards behind one address (owner's
   * $250 acceleration, 2026-11-16): Brain routes to one GPU URL, so more throughput is more
   * replicas there, not a second pod nobody routes to. Each replica is the 80 GB recipe.
   */
  /**
   * gpt-oss-120b on one 141-180 GB card (B200, else H200): the multi-card hosts were refused
   * "no instances" while single B200/H200 cards were in stock (runpod-survey 43897665060), and the
   * larger card holds a far bigger KV cache, so one address serves 128 sequences instead of 48.
   */
  'gpt-oss-120b-big': {
    key: 'gpt-oss-120b-big',
    model: 'openai/gpt-oss-120b',
    served: 'openai/gpt-oss-120b',
    gpus: ['NVIDIA B200', 'NVIDIA H200'],
    image: IMAGE_2026,
    cuda: [],
    maxModelLen: 131072,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '128',
      '--enable-auto-tool-choice', '--tool-call-parser', 'openai', '--reasoning-parser', 'openai_gptoss',
    ],
    containerDiskInGb: 250,
    minGpuGb: 141,
    clouds: ['SECURE', 'COMMUNITY'],
    note: 'gpt-oss-120b on one B200/H200: 128K, 128 parallel sequences behind one address',
  },
  'gpt-oss-120b-2x80': dataParallel120b(2),
  'gpt-oss-120b-4x80': dataParallel120b(4),
  /**
   * A director-class model for the operator (Surge B H2-9): Qwen3-32B at 4 bits (~19 GB) on a
   * 48 GB card, 64K by YaRN with an FP8 KV cache, hermes tool calls and qwen3 reasoning.
   * runpod-survey 2026-11-12: RTX A6000 $0.33/h, A40 $0.35/h community — above the 0.24 default
   * ceiling, so it is benched only when RUNPOD_MAX_USD_PER_HOUR and RUNPOD_MAX_TOTAL_USD_PER_HOUR
   * are raised in the repository's variables; the code's defaults are unchanged.
   */
  'qwen3-32b-awq-48': {
    key: 'qwen3-32b-awq-48',
    model: 'Qwen/Qwen3-32B-AWQ',
    served: 'Qwen/Qwen3-32B-AWQ',
    gpus: GPUS_48,
    image: IMAGE_2026,
    cuda: CUDA_129,
    maxModelLen: 65536,
    args: [
      '--gpu-memory-utilization', '0.92', '--max-num-seqs', '8', '--kv-cache-dtype', 'fp8',
      '--rope-scaling', '{"rope_type":"yarn","factor":2.0,"original_max_position_embeddings":32768}',
      '--enable-auto-tool-choice', '--tool-call-parser', 'hermes', '--reasoning-parser', 'qwen3',
    ],
    containerDiskInGb: 60,
    minGpuGb: 48,
    clouds: ['COMMUNITY', 'SECURE'],
    note: 'dense 32B, AWQ ~19 GB on a 48 GB card (A6000/A40), 64K by YaRN with FP8 KV: the director-class operator model',
  },
};

/**
 * The recipe production serves, and the one a lost pod is recreated from. 2026-11-12 21:25
 * (run 43309470657): served on pod odsft6ptpi2reh in place, chat 5.1 s, a structured operator
 * tool call 2.5 s, 4/4 in parallel, 64K — the 8B with FP8 KV answered HTTP 500 on this build.
 */
export const ACTIVE_RECIPE = 'qwen3-4b-awq-tools';

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
    gpuCount: recipe.gpuCount ?? 1,
    interruptible: false,
    imageName: recipe.image,
    ...(recipe.cuda.length ? { allowedCudaVersions: recipe.cuda } : {}),
    // The 2026 images start with `vllm serve <model>` (their own ENTRYPOINT); the module path the
    // 2025 image needs is deprecated there, and every pod on it crash-looped within seconds
    // (2026-11-16 09:42–10:42: uptime never above 6 s, GPU memory 0%, /v1/models 404 for an hour).
    dockerEntrypoint: recipe.image === IMAGE_2026 ? ['vllm', 'serve'] : ['python3', '-m', 'vllm.entrypoints.openai.api_server'],
    dockerStartCmd: [
      ...(recipe.image === IMAGE_2026 ? [loaded] : ['--model', loaded]), '--served-model-name', served,
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

/* ------------------------------------------------------------------------- */
/* GraphQL, when the REST host cannot be reached                              */
/* ------------------------------------------------------------------------- */

/**
 * RunPod's REST host stopped answering (production 2026-11-16 ~21:30Z: "fetch failed" from
 * GitHub's runners, CONNECT 502 through proxies) while https://api.runpod.io/graphql answered.
 * Listing, creating and retiring a pod must not depend on one API, so each of them sends the
 * same request to GraphQL when — and only when — the REST request throws. An HTTP answer from
 * REST is RunPod's own word and is kept, exactly as `runpodPod.ts`'s `api()` does (#1006).
 */
const GRAPHQL = 'https://api.runpod.io/graphql';

async function graphql(apiKey: string, query: string, fetchImpl?: Fetch): Promise<{ ok: boolean; data: Record<string, unknown> | null; error: string }> {
  const response = await (fetchImpl ?? fetch)(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => null)) as { data?: Record<string, unknown> | null; errors?: { message?: string }[] } | null;
  const errors = body?.errors?.map((e) => e.message ?? 'error').join('; ') ?? '';
  const ok = response.ok && !!body?.data && !errors;
  return { ok, data: body?.data ?? null, error: errors || (ok ? '' : `GraphQL HTTP ${response.status}`) };
}

/** A GraphQL string literal. JSON's escaping is GraphQL's. */
const lit = (value: string): string => JSON.stringify(value);

/** Split GraphQL's `dockerArgs` string back into the argument list REST calls `dockerStartCmd`. */
export function splitDockerArgs(args: unknown): string[] {
  if (typeof args !== 'string') return [];
  const out: string[] = [];
  for (const m of args.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** The argument list as GraphQL's single `dockerArgs` string: a token with whitespace or quotes is single-quoted. */
export function joinDockerArgs(args: readonly string[]): string {
  return args.map((a) => (/^[^\s'"]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

interface GraphqlPod {
  id: string;
  name?: string;
  desiredStatus?: string;
  costPerHr?: number | string;
  adjustedCostPerHr?: number | string;
  imageName?: string;
  gpuCount?: number;
  dockerArgs?: string;
  machine?: { gpuDisplayName?: string } | null;
}

/** A GraphQL pod in the REST shape every caller reads. */
function fromGraphql(pod: GraphqlPod): Pod & { dockerStartCmd?: unknown; imageName?: string; gpuCount?: number; via: 'graphql' } {
  return {
    id: pod.id,
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    ...(pod.desiredStatus !== undefined ? { desiredStatus: pod.desiredStatus } : {}),
    ...(pod.costPerHr !== undefined && pod.costPerHr !== null ? { costPerHr: pod.costPerHr } : {}),
    ...(pod.adjustedCostPerHr !== undefined && pod.adjustedCostPerHr !== null ? { adjustedCostPerHr: pod.adjustedCostPerHr } : {}),
    ...(pod.imageName !== undefined ? { imageName: pod.imageName } : {}),
    ...(pod.gpuCount !== undefined ? { gpuCount: pod.gpuCount } : {}),
    ...(pod.machine?.gpuDisplayName ? { gpu: { displayName: pod.machine.gpuDisplayName } } : {}),
    dockerStartCmd: splitDockerArgs(pod.dockerArgs),
    via: 'graphql',
  };
}

async function listPodsViaGraphql(apiKey: string, fetchImpl?: Fetch): Promise<(Pod & { dockerStartCmd?: unknown })[]> {
  const r = await graphql(
    apiKey,
    'query { myself { pods { id name desiredStatus costPerHr adjustedCostPerHr imageName gpuCount dockerArgs machine { gpuDisplayName } } } }',
    fetchImpl,
  );
  const myself = r.data?.['myself'] as { pods?: GraphqlPod[] } | null | undefined;
  if (!r.ok || !myself) throw new Error(`RunPod refused to list pods (GraphQL): ${r.error.slice(0, 200)}`);
  return (myself.pods ?? []).map(fromGraphql);
}

async function terminateViaGraphql(apiKey: string, podId: string, fetchImpl?: Fetch): Promise<number> {
  // podTerminate returns nothing: success is an answer with data and no errors.
  const r = await graphql(apiKey, `mutation { podTerminate(input: { podId: ${lit(podId)} }) }`, fetchImpl);
  return r.ok ? 200 : 502;
}

/**
 * One pod from a recipe on one cloud, through GraphQL. It takes one GPU type, not REST's
 * list, so the recipe's GPUs are tried in its order until one is created. GraphQL has no
 * entrypoint override, so `dockerArgs` is REST's start command for the image's OWN entrypoint
 * — which is what `podSpec` sets anyway: `vllm serve` on the 2026 image (positional model),
 * the module path on the 2025 one (`--model`).
 */
async function createViaGraphql(
  apiKey: string,
  spec: Record<string, unknown>,
  recipe: PodRecipe,
  fetchImpl?: Fetch,
): Promise<{ pod: Pod | null; refusals: string[] }> {
  const refusals: string[] = [];
  const cudas = recipe.cuda.map(Number).filter(Number.isFinite);
  const minCuda = cudas.length ? recipe.cuda[cudas.indexOf(Math.min(...cudas))] : null;
  // `--model <name>` rather than a positional model: both the image's `vllm serve` and the module
  // entrypoint accept it, so the start command does not depend on which entrypoint the image ships
  // (production 2026-11-17 00:31Z: a positional-model pod crash-looped for 12 minutes).
  const cmd = [...(spec['dockerStartCmd'] as string[])];
  if (cmd[0] && !cmd[0].startsWith('-')) cmd.unshift('--model');
  const dockerArgs = joinDockerArgs(cmd);
  // A recipe with no CUDA filter still needs a driver that runs the image (12.8 for the 2026 one).
  const minCudaFor = minCuda ?? (recipe.image === IMAGE_2026 ? '12.8' : null);
  for (const gpu of recipe.gpus) {
    const input = [
      `cloudType: ${spec['cloudType']}`,
      'gpuCount: 1',
      `gpuTypeId: ${lit(gpu)}`,
      `name: ${lit(String(spec['name']))}`,
      `imageName: ${lit(recipe.image)}`,
      `containerDiskInGb: ${recipe.containerDiskInGb}`,
      'volumeInGb: 0',
      'ports: "8000/http"',
      `dockerArgs: ${lit(dockerArgs)}`,
      ...(minCudaFor ? [`minCudaVersion: ${lit(minCudaFor)}`] : []),
    ].join(', ');
    const r = await graphql(apiKey, `mutation { podFindAndDeployOnDemand(input: { ${input} }) { id desiredStatus costPerHr machine { gpuDisplayName } } }`, fetchImpl);
    const made = r.data?.['podFindAndDeployOnDemand'] as GraphqlPod | null | undefined;
    if (r.ok && made?.id) return { pod: fromGraphql(made), refusals };
    refusals.push(`${gpu}: ${r.error.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return { pod: null, refusals };
}

export async function listPods(apiKey: string, fetchImpl?: Fetch): Promise<(Pod & { dockerStartCmd?: unknown })[]> {
  let listed: Awaited<ReturnType<Call>>;
  try {
    listed = await caller(apiKey, fetchImpl)('GET', '/pods');
  } catch (error) {
    try {
      return await listPodsViaGraphql(apiKey, fetchImpl);
    } catch {
      throw error;
    }
  }
  if (!listed.ok) throw new Error(`RunPod refused to list pods: HTTP ${listed.status} ${listed.text.slice(0, 200)}`);
  return (JSON.parse(listed.text || '[]') as Pod[]) ?? [];
}

/**
 * Repurpose an existing pod to a recipe (§108): RunPod's update changes the image
 * and start command and restarts the pod on the same host and GPU — no second
 * pod, no stock to find. Only a recipe whose GPUs include the pod's own card.
 */
export async function repurposePod(apiKey: string, podId: string, recipe: PodRecipe, vllmKey: string, fetchImpl?: Fetch): Promise<{ ok: boolean; status: number; detail: string }> {
  const spec = podSpec(vllmKey, undefined, 'SECURE', recipe);
  const body = { imageName: spec['imageName'], dockerEntrypoint: spec['dockerEntrypoint'], dockerStartCmd: spec['dockerStartCmd'], containerDiskInGb: spec['containerDiskInGb'], ports: spec['ports'] };
  const r = await caller(apiKey, fetchImpl)('PATCH', `/pods/${encodeURIComponent(podId)}`, body);
  return { ok: r.ok, status: r.status, detail: r.text.replace(/\s+/g, ' ').slice(0, 400) };
}

export async function deletePod(apiKey: string, podId: string, fetchImpl?: Fetch): Promise<number> {
  try {
    return (await caller(apiKey, fetchImpl)('DELETE', `/pods/${encodeURIComponent(podId)}`)).status;
  } catch (error) {
    const status = await terminateViaGraphql(apiKey, podId, fetchImpl).catch(() => null);
    if (status === null) throw error;
    return status;
  }
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
    const spec = podSpec(input.vllmKey, input.model ?? POD_MODEL, cloud, input.recipe, input.name);
    let pod: Pod;
    let via = '';
    try {
      const made = await call('POST', '/pods', spec);
      if (!made.ok) {
        refusals.push(`${cloud}: HTTP ${made.status} ${made.text.replace(/\s+/g, ' ').slice(0, 700)}`);
        continue;
      }
      pod = JSON.parse(made.text) as Pod;
    } catch (error) {
      // REST unreachable (a thrown request, not an answer): the same pod through GraphQL.
      const viaGql = await createViaGraphql(input.apiKey, spec, input.recipe, input.fetchImpl).catch((e: Error) => ({ pod: null, refusals: [`GraphQL: ${e.message}`] }));
      if (!viaGql.pod) {
        refusals.push(`${cloud}: REST ${(error as Error)?.message ?? error}; GraphQL ${viaGql.refusals.join('; ')}`);
        continue;
      }
      pod = viaGql.pod;
      via = ' via GraphQL';
    }
    const cost = price(pod);
    if (cost === null || cost > input.maxUsdPerHour + 1e-9) {
      const gone = await deletePod(input.apiKey, pod.id, input.fetchImpl).catch(() => 0);
      refusals.push(`${cloud}: priced ${cost ?? 'unknown'}/h, over the ${input.maxUsdPerHour}/h ceiling; deleted (HTTP ${gone})`);
      continue;
    }
    log.push(`created pod ${pod.id} (${input.name}, ${input.recipe.key}) on ${cloud}${via} at $${cost}/h (${pod.gpu?.displayName ?? input.recipe.gpus[0]})`);
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
    // GraphQL's listing carries no creation time: an age it cannot read is not a leak, so a
    // benchmark that is still running is never deleted under it.
    if (!Number.isFinite(created) && (pod as { via?: string }).via === 'graphql') continue;
    const age = Number.isFinite(created) ? (nowMs - created) / 60_000 : Infinity;
    if (age < BENCH_MAX_MINUTES) continue;
    await deletePod(apiKey, pod.id, fetchImpl);
    gone.push(pod.id);
  }
  return gone;
}
