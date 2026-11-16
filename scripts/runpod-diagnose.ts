/**
 * `npx tsx scripts/runpod-diagnose.ts --recipe <key>` — why a recipe's pod never serves (§108).
 *
 * RunPod's API returns no container logs, and a pod that crash-loops (2026-11-16: gpt-oss-120b
 * on an H100, uptime never above 6 s for an hour, three times) leaves nothing to read. This starts
 * the recipe's exact image, GPU and vLLM arguments on a temporary pod, but under a shell that
 * writes vLLM's output to a file and, when vLLM exits, serves that file on the pod's port. It reads
 * the file, prints its tail, and deletes the pod. Bounded: 25 minutes, the price ceiling, and the
 * benchmark prefix the sweeper deletes if this run is cancelled. Prints no secret.
 */
import { randomBytes } from 'node:crypto';
import { BENCH_PREFIX, DEFAULT_MAX_USD_PER_HOUR, deletePod, podSpec, recipeFor } from '../server/services/cheap/runpodRestore.ts';

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? '') : null;
};
const apiKey = process.env['RUNPOD_API_KEY']?.trim() ?? '';
const ceiling = Number(process.env['RUNPOD_MAX_USD_PER_HOUR']) > 0 ? Number(process.env['RUNPOD_MAX_USD_PER_HOUR']) : DEFAULT_MAX_USD_PER_HOUR;
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function main(): Promise<void> {
  if (!apiKey) throw new Error('RUNPOD_API_KEY is required');
  const recipe = recipeFor(arg('recipe'));
  const key = randomBytes(16).toString('hex');
  let made: { id: string; cost: number } | null = null;
  for (const cloud of recipe.clouds) {
    const spec = podSpec(key, undefined, cloud, recipe, `${BENCH_PREFIX}diag-${recipe.key}`) as Record<string, unknown>;
    const entry = (spec['dockerEntrypoint'] as string[]).map(quote).join(' ');
    const args = (spec['dockerStartCmd'] as string[]).map(quote).join(' ');
    const script =
      `( echo "IMAGE ${recipe.image}"; nvidia-smi 2>&1 | head -15; which vllm python3 2>&1; ` +
      `${entry} ${args}; echo "EXIT=$?" ) > /tmp/vllm.log 2>&1; ` +
      'cd /tmp && (python3 -m http.server 8000 || python -m http.server 8000)';
    spec['dockerEntrypoint'] = ['bash', '-c', script];
    spec['dockerStartCmd'] = [];
    const res = await fetch('https://rest.runpod.io/v1/pods', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`REFUSED ${cloud}: HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
      continue;
    }
    const pod = JSON.parse(text) as { id: string; costPerHr?: number | string; adjustedCostPerHr?: number | string; gpu?: { displayName?: string } };
    const cost = Number(pod.adjustedCostPerHr ?? pod.costPerHr);
    if (!Number.isFinite(cost) || cost > ceiling + 1e-9) {
      console.log(`PRICED ${cloud} at ${cost}/h, over ${ceiling}; deleted (HTTP ${await deletePod(apiKey, pod.id)})`);
      continue;
    }
    console.log(`DIAG pod ${pod.id} on ${cloud} at $${cost}/h (${pod.gpu?.displayName ?? '?'})`);
    made = { id: pod.id, cost };
    break;
  }
  if (!made) throw new Error('no diagnostic pod could be created');
  const started = Date.now();
  try {
    while (Date.now() - started < 25 * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      const res = await fetch(`https://${made.id}-8000.proxy.runpod.net/vllm.log`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (res?.ok) {
        const log = await res.text();
        console.log(`LOG after ${Math.round((Date.now() - started) / 60_000)} min (${log.length} bytes), last 120 lines:`);
        for (const line of log.split('\n').slice(-120)) console.log(`| ${line.slice(0, 400)}`);
        return;
      }
    }
    console.log('NO LOG in 25 min: vLLM is still running (it did not exit) or the container never started');
  } finally {
    console.log(`DELETED ${made.id} (HTTP ${await deletePod(apiKey, made.id)}) after ~$${((made.cost * (Date.now() - started)) / 3_600_000).toFixed(2)}`);
  }
}

main().catch((error: unknown) => {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
