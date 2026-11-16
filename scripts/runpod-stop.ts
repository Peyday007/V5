/**
 * `npx tsx scripts/runpod-stop.ts` — stop (never delete) every Brain pod (name starts with
 * `brain-vllm`), through RunPod's GraphQL API (the same endpoint runpod-survey reads). A stopped pod
 * bills no GPU; runpod-auto recreates a deleted pod but never starts a stopped one. Owner cost
 * control, 2026-11-16. Prints no secret.
 */
const key = process.env['RUNPOD_API_KEY']?.trim();
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
const listed = await gql('{ myself { pods { id name desiredStatus } } }');
const pods = (((listed.data?.['myself'] as { pods?: { id: string; name: string; desiredStatus: string }[] }) ?? {}).pods ?? []).filter((p) => p.name.startsWith('brain-vllm'));
if (listed.errors?.length) console.log(`FAIL list: ${listed.errors.map((e) => e.message).join('; ')}`);
if (!pods.length) console.log('STOP none: no Brain pod listed');
for (const pod of pods) {
  const r = await gql(`mutation { podStop(input: { podId: "${pod.id}" }) { id desiredStatus } }`);
  console.log(`STOP ${pod.id} was ${pod.desiredStatus} -> ${r.errors?.length ? `ERROR ${r.errors.map((e) => e.message).join('; ')}` : JSON.stringify(r.data?.['podStop'])}`);
}
