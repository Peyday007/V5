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
