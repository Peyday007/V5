/**
 * `npx tsx scripts/runpod-bench.ts --recipes a,b [--baseline] [--reps N]` —
 * measure candidate models on Brain's own tasks (§108).
 *
 * For each recipe: a temporary pod named `brain-bench-<recipe>` is created
 * within the price ceiling, waited on, benchmarked (`modelBench.ts`) and
 * deleted — always, in `finally`; `sweepBenchPods` deletes any a cancelled
 * run left behind. `--baseline` also measures what Brain runs today: the
 * production pod (RUNPOD_VLLM_URL/_KEY) and the free switchboard
 * (CHEAP_URL + OMNIROUTE_API_KEY, model OMNIROUTE_MODEL or `auto`).
 *
 * Spending: no pod above RUNPOD_MAX_USD_PER_HOUR (default 0.24) is kept, and no
 * benchmark pod starts while the account's spend rate plus the new pod would
 * pass RUNPOD_MAX_TOTAL_USD_PER_HOUR (default 0.45) or the balance would last
 * under 24 hours. Prints `BENCH-JSON <summary>` lines; prints no secret.
 */
import { randomBytes } from 'node:crypto';
import { BENCH_PREFIX, DEFAULT_MAX_USD_PER_HOUR, POD_NAME, createPod, deletePod, listPods, podUrl, recipeFor, sweepBenchPods } from '../server/services/cheap/runpodRestore.ts';
import { chooseModel, runBench, type BenchEndpoint, type BenchSummary } from '../server/services/cheap/modelBench.ts';
import { accountReading } from '../server/services/cheap/runpodAccount.ts';

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? '') : null;
};
const apiKey = process.env['RUNPOD_API_KEY']?.trim() ?? '';
const ceiling = Number(process.env['RUNPOD_MAX_USD_PER_HOUR']) > 0 ? Number(process.env['RUNPOD_MAX_USD_PER_HOUR']) : DEFAULT_MAX_USD_PER_HOUR;
const totalCeiling = Number(process.env['RUNPOD_MAX_TOTAL_USD_PER_HOUR']) > 0 ? Number(process.env['RUNPOD_MAX_TOTAL_USD_PER_HOUR']) : 0.45;
const reps = Math.max(1, Math.min(3, Number(arg('reps') ?? 1) || 1));

function print(summary: BenchSummary): void {
  console.log(`BENCH ${summary.label} quality ${summary.quality.toFixed(2)} tool ${summary.toolSuccess === null ? '-' : summary.toolSuccess.toFixed(2)} median ${Math.round(summary.medianMs / 1000)}s parallel ${summary.parallel ? `${summary.parallel.ok}/${summary.parallel.requests} in ${Math.round(summary.parallel.wallMs / 1000)}s` : '-'} $/task ${summary.usdPerTask === null ? 'free' : summary.usdPerTask.toFixed(4)}`);
  for (const t of summary.tasks) {
    console.log(`  ${t.task.padEnd(14)} ${t.score.toFixed(2)} ${String(Math.round(t.ms / 1000)).padStart(4)}s tools ${t.toolOk}/${t.toolCalls}${t.error ? ` ERROR ${t.error.slice(0, 120)}` : ''}`);
    for (const n of t.notes.slice(0, 8)) console.log(`      ${n.slice(0, 200)}`);
  }
  console.log(`BENCH-JSON ${JSON.stringify({ ...summary, tasks: summary.tasks.map((t) => ({ ...t, notes: t.notes.slice(0, 6).map((n) => n.slice(0, 160)) })) })}`);
}

async function waitReady(url: string, key: string, minutes: number): Promise<boolean> {
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (r.ok) return true;
    } catch {
      /* booting or downloading */
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  return false;
}

async function benchRecipe(key: string): Promise<BenchSummary | null> {
  const recipe = recipeFor(key);
  const account = await accountReading(apiKey);
  console.log(`ACCOUNT balance $${account.balance?.toFixed(2) ?? '?'} spending $${account.spendPerHour?.toFixed(3) ?? '?'}/h`);
  if (account.spendPerHour !== null && account.spendPerHour + ceiling > totalCeiling + 1e-9) {
    console.log(`SKIP ${key}: spending $${account.spendPerHour}/h plus a pod up to $${ceiling}/h would pass the $${totalCeiling}/h total ceiling`);
    return null;
  }
  if (account.balance !== null && account.spendPerHour !== null && account.balance / (account.spendPerHour + ceiling) < 24) {
    console.log(`SKIP ${key}: the balance would last under 24 hours with a benchmark pod running`);
    return null;
  }
  const vllmKey = randomBytes(24).toString('hex');
  let podId: string | null = null;
  const started = Date.now();
  try {
    const pod = await createPod({ apiKey, vllmKey, recipe, name: `${BENCH_PREFIX}${key}`, maxUsdPerHour: ceiling });
    podId = pod.podId;
    pod.log.forEach((l) => console.log(l));
    const ready = await waitReady(pod.url, vllmKey, 30);
    console.log(`${ready ? 'READY' : 'NOT READY'} ${key} after ${Math.round((Date.now() - started) / 1000)}s`);
    if (!ready) return null;
    const endpoint: BenchEndpoint = { label: `gpu:${key}`, url: pod.url, key: vllmKey, model: recipe.served, usdPerHour: pod.costPerHr };
    const summary = await runBench(endpoint, { reps, parallel: 6 });
    print(summary);
    return summary;
  } catch (error) {
    console.log(`FAIL ${key}: ${(error as Error).message.slice(0, 400)}`);
    return null;
  } finally {
    if (podId) {
      const status = await deletePod(apiKey, podId).catch((e: Error) => `error ${e.message}`);
      const minutes = (Date.now() - started) / 60_000;
      console.log(`DELETED ${podId} (HTTP ${status}) after ${minutes.toFixed(1)} min`);
    }
  }
}

async function main(): Promise<void> {
  if (!apiKey) throw new Error('RUNPOD_API_KEY is required');
  const swept = await sweepBenchPods(apiKey);
  if (swept.length) console.log(`SWEPT leftover benchmark pods: ${swept.join(', ')}`);
  const results: BenchSummary[] = [];
  if (arg('baseline') !== null) {
    // The production pod by name — the URL secret can name a pod RunPod already replaced.
    const prod = (await listPods(apiKey)).find((p) => p.name === POD_NAME && p.desiredStatus === 'RUNNING');
    const podKey = process.env['RUNPOD_VLLM_KEY']?.trim() ?? null;
    if (prod) {
      const base = podUrl(prod.id);
      const listed = await fetch(`${base}/models`, { headers: podKey ? { authorization: `Bearer ${podKey}` } : {}, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}));
      const model = (listed as { data?: { id: string }[] }).data?.[0]?.id ?? 'unknown';
      const cost = Number(prod.adjustedCostPerHr ?? prod.costPerHr);
      const summary = await runBench({ label: `gpu:production(${model})`, url: base, key: podKey, model, usdPerHour: Number.isFinite(cost) && cost > 0 ? cost : 0.19 }, { reps, parallel: 6 });
      print(summary);
      results.push(summary);
    }
    const freeUrl = process.env['CHEAP_URL']?.trim();
    const freeKey = process.env['OMNIROUTE_API_KEY']?.trim() ?? null;
    if (freeUrl && freeKey) {
      // The switchboard's own names: production sends the combo it lists (BRAIN_CHEAP_LLM_MODELS).
      const listed = await fetch(`${freeUrl}/models`, { headers: { authorization: `Bearer ${freeKey}` }, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => ({}));
      const names = ((listed as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
      console.log(`SWITCHBOARD models: ${names.slice(0, 30).join(', ')}`);
      const model = ['brain-a', process.env['OMNIROUTE_MODEL']?.trim() ?? ''].find((m) => m && names.includes(m)) ?? names[0] ?? 'auto';
      const summary = await runBench({ label: `free:${model}`, url: freeUrl, key: freeKey, model, usdPerHour: null }, { reps, parallel: 3 });
      print(summary);
      results.push(summary);
    }
  }
  for (const key of (arg('recipes') ?? '').split(',').map((k) => k.trim()).filter(Boolean)) {
    const summary = await benchRecipe(key);
    if (summary) results.push(summary);
  }
  const { winner, why } = chooseModel(results);
  console.log(`WINNER ${winner?.label ?? 'none'} — ${why}`);
  console.log('RUNPOD-BENCH: OK');
}

main().catch((error) => {
  console.log(`FAIL bench: ${(error as Error).message}`);
  process.exit(1);
});
