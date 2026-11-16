import { describe, expect, it } from 'vitest';
import { POD_GPUS, POD_NAME, ensurePod, podSpec } from '../server/services/cheap/runpodRestore.ts';

type Call = { method: string; url: string; body?: Record<string, unknown> };

function runpod(pods: unknown[], createdCost: number[]) {
  const calls: Call[] = [];
  let made = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return new Response(JSON.stringify(pods), { status: 200 });
    if (method === 'POST') {
      const cost = createdCost[made++];
      if (cost === undefined) return new Response('{"error":"no GPUs available"}', { status: 500 });
      return new Response(JSON.stringify({ id: `new${made}`, desiredStatus: 'RUNNING', costPerHr: cost }), { status: 201 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('GPU pod recovery', () => {
  it('uses the pod the old address names, and creates nothing', async () => {
    const { calls, fetchImpl } = runpod([{ id: 'abc123', desiredStatus: 'EXITED', costPerHr: 0.24 }], []);
    const pod = await ensurePod({ apiKey: 'k', vllmKey: 'v', oldUrl: 'https://abc123-8000.proxy.runpod.net/v1', fetchImpl });
    expect(pod).toMatchObject({ podId: 'abc123', created: false, url: 'https://abc123-8000.proxy.runpod.net/v1' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('recreates a deleted pod from the recipe, with no paid volume', async () => {
    const { calls, fetchImpl } = runpod([], [0.24]);
    const pod = await ensurePod({ apiKey: 'k', vllmKey: 'v', oldUrl: 'https://gone99-8000.proxy.runpod.net', fetchImpl });
    expect(pod).toMatchObject({ podId: 'new1', created: true, costPerHr: 0.24 });
    const body = calls.find((c) => c.method === 'POST')!.body!;
    expect(body).toMatchObject({ name: POD_NAME, gpuTypeIds: POD_GPUS, volumeInGb: 0, interruptible: false, ports: ['8000/http'] });
    expect(body['dockerStartCmd']).toContain('--api-key');
  });

  it('deletes a pod priced over the ceiling and never keeps a dearer one', async () => {
    const { calls, fetchImpl } = runpod([], [0.4, 0.5]);
    await expect(ensurePod({ apiKey: 'k', vllmKey: 'v', fetchImpl })).rejects.toThrow(/over the 0.24\/h ceiling/);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      'https://rest.runpod.io/v1/pods/new1',
      'https://rest.runpod.io/v1/pods/new2',
    ]);
  });

  it('serves the model production ran with research-sized context', () => {
    const cmd = podSpec('v')['dockerStartCmd'] as string[];
    expect(cmd[cmd.indexOf('--max-model-len') + 1]).toBe('32768');
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('Qwen/Qwen3-4B');
  });
});

describe('recipes, benchmark pods and the account (§108)', () => {
  it('every recipe after the legacy one names its tool-call parser and serves 64K or more', async () => {
    const { RECIPES, podSpec } = await import('../server/services/cheap/runpodRestore.ts');
    for (const recipe of Object.values(RECIPES)) {
      if (recipe.key === 'qwen3-4b-legacy') continue;
      const cmd = podSpec('v', undefined, 'COMMUNITY', recipe)['dockerStartCmd'] as string[];
      expect(cmd).toContain('--enable-auto-tool-choice');
      expect(cmd[cmd.indexOf('--tool-call-parser') + 1]).toBeTruthy();
      // Only the last fallback before a revert stays at the native 32K; it is never what the operator needs.
      if (recipe.key !== 'qwen3-4b-tools-32k') expect(Number(cmd[cmd.indexOf('--max-model-len') + 1])).toBeGreaterThanOrEqual(65536);
      expect(cmd[cmd.indexOf('--served-model-name') + 1]).toBe(recipe.served);
    }
  });

  it('the 48 GB director recipe serves Qwen3-32B-AWQ with hermes tools, qwen3 reasoning, 64K by YaRN and FP8 KV on an A6000 or A40', async () => {
    const { RECIPES, podSpec, ACTIVE_RECIPE } = await import('../server/services/cheap/runpodRestore.ts');
    const recipe = RECIPES['qwen3-32b-awq-48']!;
    expect(recipe).toMatchObject({ model: 'Qwen/Qwen3-32B-AWQ', minGpuGb: 48, gpus: ['NVIDIA RTX A6000', 'NVIDIA A40', 'NVIDIA L40', 'NVIDIA L40S', 'NVIDIA RTX 6000 Ada Generation'] });
    const cmd = podSpec('v', undefined, 'COMMUNITY', recipe)['dockerStartCmd'] as string[];
    expect(cmd[cmd.indexOf('--max-model-len') + 1]).toBe('65536');
    expect(cmd[cmd.indexOf('--tool-call-parser') + 1]).toBe('hermes');
    expect(cmd[cmd.indexOf('--reasoning-parser') + 1]).toBe('qwen3');
    expect(cmd[cmd.indexOf('--kv-cache-dtype') + 1]).toBe('fp8');
    expect(JSON.parse(cmd[cmd.indexOf('--rope-scaling') + 1]!)).toEqual({ rope_type: 'yarn', factor: 2.0, original_max_position_embeddings: 32768 });
    // A challenger only: production's recipe and the price defaults are unchanged.
    expect(ACTIVE_RECIPE).toBe('qwen3-4b-awq-tools');
  });

  it('cheap-lane passes both RunPod ceilings from repository variables to bench and upgrade', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync('.github/workflows/cheap-lane.yml', 'utf8');
    expect(yml).toContain('RUNPOD_MAX_USD_PER_HOUR: ${{ inputs.max_usd_per_hour || vars.RUNPOD_MAX_USD_PER_HOUR }}');
    expect(yml).toContain('RUNPOD_MAX_TOTAL_USD_PER_HOUR: ${{ vars.RUNPOD_MAX_TOTAL_USD_PER_HOUR }}');
    // A dispatch's own ceiling is that dispatch's only: the hourly schedule passes no input.
    expect(yml).toMatch(/RUNPOD_MAX_TOTAL_USD_PER_HOUR=\$\(awk -v c="\$ceil_in"/);
  });

  it('the 80 GB recipe is a challenger above every default ceiling, with tool calls and 128K', async () => {
    const { RECIPES, podSpec, DEFAULT_MAX_USD_PER_HOUR } = await import('../server/services/cheap/runpodRestore.ts');
    const recipe = RECIPES['gpt-oss-120b-80']!;
    expect(recipe.minGpuGb).toBe(80);
    expect(recipe.gpus.every((g) => /H100|H200|A100/.test(g))).toBe(true);
    const cmd = podSpec('k', undefined, 'SECURE', recipe)['dockerStartCmd'] as string[];
    expect(cmd[cmd.indexOf('--tool-call-parser') + 1]).toBe('openai');
    expect(cmd[cmd.indexOf('--max-model-len') + 1]).toBe('131072');
    expect(DEFAULT_MAX_USD_PER_HOUR).toBe(0.24);
  });

  it('sweeps only benchmark pods older than the bound', async () => {
    const { sweepBenchPods } = await import('../server/services/cheap/runpodRestore.ts');
    const now = Date.parse('2026-11-12T20:00:00Z');
    const pods = [
      { id: 'old', name: 'brain-bench-x', createdAt: '2026-11-12T18:00:00Z' },
      { id: 'young', name: 'brain-bench-y', createdAt: '2026-11-12T19:30:00Z' },
      { id: 'prod', name: 'brain-vllm', createdAt: '2026-11-01T00:00:00Z' },
    ];
    const { calls, fetchImpl } = runpod(pods, []);
    expect(await sweepBenchPods('k', now, fetchImpl)).toEqual(['old']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['https://rest.runpod.io/v1/pods/old']);
  });

  it('reads the runway from RunPod, and an unknown is unknown', async () => {
    const { accountReading, runway } = await import('../server/services/cheap/runpodAccount.ts');
    const fetchImpl = (async () => new Response(JSON.stringify({ data: { myself: { clientBalance: 15.48, currentSpendPerHr: 0.196 } } }))) as typeof fetch;
    const r = await accountReading('k', fetchImpl);
    expect(Math.round(r.runwayHours!)).toBe(79);
    expect(runway(10, 0)).toBeNull();
    expect(runway(null, 0.2)).toBeNull();
  });
});
