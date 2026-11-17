/**
 * `npx tsx scripts/runpod-start.ts` — resume Brain's stopped pod (name `brain-vllm`) through
 * RunPod's GraphQL API and wait up to 50 minutes for vLLM to serve /v1/models. Used for a bounded,
 * budget-capped GPU run after `runpod-stop` (owner cost control, 2026-11-16). Prints no secret.
 */
const key = process.env['RUNPOD_API_KEY']?.trim();
const vllmKey = process.env['RUNPOD_VLLM_KEY']?.trim() ?? '';
if (!key) {
  console.log('FAIL config: RUNPOD_API_KEY is required');
  process.exit(2);
}
async function gql(query: string): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch('https://api.runpod.io/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(60_000),
      });
      return JSON.parse(await res.text());
    } catch (error) {
      console.log(`retry ${attempt}: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  return { errors: [{ message: 'unreachable after 4 attempts' }] };
}
const listed = await gql('{ myself { pods { id name desiredStatus gpuCount } } }');
const pod = (((listed.data?.['myself'] as { pods?: { id: string; name: string; desiredStatus: string; gpuCount: number }[] }) ?? {}).pods ?? []).find((p) => p.name.startsWith('brain-vllm'));
if (!pod) {
  console.log('FAIL start: no Brain pod listed');
  process.exit(1);
}
if (pod.desiredStatus !== 'RUNNING') {
  const r = await gql(`mutation { podResume(input: { podId: "${pod.id}", gpuCount: ${pod.gpuCount || 1} }) { id desiredStatus } }`);
  if (r.errors?.length) {
    console.log(`FAIL start ${pod.id}: ${r.errors.map((e) => e.message).join('; ')}`);
    process.exit(1);
  }
  console.log(`STARTED ${pod.id}`);
} else console.log(`RUNNING ${pod.id} already`);
const url = `https://${pod.id}-8000.proxy.runpod.net/v1/models`;
const started = Date.now();
while (Date.now() - started < 50 * 60_000) {
  const status = await fetch(url, { headers: { authorization: `Bearer ${vllmKey}` }, signal: AbortSignal.timeout(15_000) }).then((r) => r.status).catch(() => 0);
  if (status === 200) {
    console.log(`READY ${pod.id} served after ${Math.round((Date.now() - started) / 1000)}s`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
console.log(`FAIL start: ${pod.id} did not serve within 50 min`);
process.exit(1);
export {};
