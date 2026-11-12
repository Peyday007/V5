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
      expect(Number(cmd[cmd.indexOf('--max-model-len') + 1])).toBeGreaterThanOrEqual(65536);
      expect(cmd[cmd.indexOf('--served-model-name') + 1]).toBe(recipe.served);
    }
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
