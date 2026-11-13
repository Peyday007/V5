/**
 * `npx tsx scripts/runpod-survey.ts` — what Brain's RunPod account holds and
 * what it could rent, read from RunPod itself (§108).
 *
 * Reads RUNPOD_API_KEY. Prints the balance and current spend, every pod with
 * its GPU, status and price, and every GPU type with its memory, price and
 * stock — the facts a GPU choice is made from. Prints no secret, changes nothing.
 */
const key = process.env['RUNPOD_API_KEY']?.trim();
if (!key) {
  console.log('FAIL config: RUNPOD_API_KEY is required');
  process.exit(2);
}

async function gql(query: string): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await fetch('https://api.runpod.io/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { errors: [{ message: `HTTP ${res.status} ${text.slice(0, 200)}` }] };
  }
}

async function first(queries: string[]): Promise<Record<string, unknown> | null> {
  for (const q of queries) {
    const r = await gql(q);
    if (r.data && !r.errors?.length) return r.data;
    console.log(`query refused: ${(r.errors ?? []).map((e) => e.message).join('; ').slice(0, 300)}`);
  }
  return null;
}

async function main(): Promise<void> {
  const me = await first([
    '{ myself { clientBalance currentSpendPerHr spendLimit underBalance } }',
    '{ myself { clientBalance currentSpendPerHr } }',
  ]);
  const m = (me?.['myself'] ?? {}) as Record<string, unknown>;
  console.log(`ACCOUNT balance $${m['clientBalance'] ?? '?'} · spending $${m['currentSpendPerHr'] ?? '?'}/h · limit ${m['spendLimit'] ?? '?'} · under balance ${m['underBalance'] ?? '?'}`);

  const pods = await fetch('https://rest.runpod.io/v1/pods', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000) });
  const podList = (await pods.json().catch(() => [])) as Record<string, unknown>[];
  for (const p of Array.isArray(podList) ? podList : []) {
    const gpu = (p['gpu'] as Record<string, unknown> | undefined)?.['displayName'] ?? (p['machine'] as Record<string, unknown> | undefined)?.['gpuDisplayName'] ?? '?';
    const cmd = Array.isArray(p['dockerStartCmd']) ? (p['dockerStartCmd'] as string[]).map((a, i, all) => (all[i - 1] === '--api-key' ? '<key>' : a)).join(' ') : '';
    console.log(`POD ${p['id']} ${p['name']} ${p['desiredStatus']} ${gpu} $${p['adjustedCostPerHr'] ?? p['costPerHr']}/h image ${p['imageName']} cloud ${p['cloudType'] ?? '?'} :: ${cmd}`);
  }

  const gpus = await first([
    '{ gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice secureSpotPrice communitySpotPrice lowestPrice(input: { gpuCount: 1 }) { minimumBidPrice uninterruptablePrice stockStatus } } }',
    '{ gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice lowestPrice(input: { gpuCount: 1 }) { uninterruptablePrice stockStatus } } }',
    '{ gpuTypes { id displayName memoryInGb securePrice communityPrice } }',
  ]);
  const types = ((gpus?.['gpuTypes'] ?? []) as Record<string, unknown>[])
    .filter((g) => Number(g['memoryInGb']) >= 16)
    .sort((a, b) => Number(a['memoryInGb']) - Number(b['memoryInGb']) || Number(a['communityPrice'] ?? 99) - Number(b['communityPrice'] ?? 99));
  for (const g of types) {
    const low = (g['lowestPrice'] ?? {}) as Record<string, unknown>;
    console.log(
      `GPU ${String(g['memoryInGb']).padStart(3)}GB ${String(g['id']).padEnd(42)} secure $${g['securePrice'] ?? '-'} community $${g['communityPrice'] ?? '-'} spot $${g['communitySpotPrice'] ?? g['secureSpotPrice'] ?? '-'} · lowest $${low['uninterruptablePrice'] ?? '-'} stock ${low['stockStatus'] ?? '-'}`,
    );
  }
  console.log('RUNPOD-SURVEY: OK');
}

main().catch((error) => {
  console.log(`FAIL survey: ${(error as Error).message}`);
  process.exit(1);
});
