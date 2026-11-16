/**
 * `sh /app/scripts/runpod-cycle.sh` — prove the pod's automatic power in production.
 *
 * Run inside the released container, beside the running Brain whose supervisor
 * (`runpodPod.ts`, driven by the free lane's controller) owns the pod's power:
 *
 *   1. the account key and pod id are configured (`podConfig`), and RunPod
 *      reports the pod RUNNING;
 *   2. this script stops it with the supervisor's own call (`powerPod`) and
 *      waits for RunPod to report it EXITED;
 *   3. it then does nothing: the running Brain must notice the stopped pod
 *      while research waits and start it by itself (a `RUNPOD_POD` STARTED event
 *      written by the app, not by this script);
 *   4. RunPod reports it RUNNING and vLLM answers `/models` with its key.
 *
 * Every step is timed. If no research waits, Brain is right to leave the pod
 * stopped; the script says so and starts it again itself, so a test never leaves
 * the GPU off. It passes only when step 3 was Brain's own doing.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { runpodConfig } from '../server/services/cheap/runpod.ts';
import { loadMovedPod, podConfig, powerPod, readPod, vllmReady } from '../server/services/cheap/runpodPod.ts';
import { waitingNow } from '../server/services/freeLane/capacity.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const secs = (from: number) => Math.round((Date.now() - from) / 1000);

async function until(what: string, limitMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (await check()) {
      console.log(`  ${what} after ${secs(started)}s`);
      return true;
    }
    await sleep(15_000);
  }
  console.log(`  ${what}: not within ${Math.round(limitMs / 60_000)} min`);
  return false;
}

function fail(why: string): void {
  console.log(`FAIL ${why}`);
  console.log('RUNPOD-CYCLE: FAIL');
  process.exitCode = 1;
}

async function main(): Promise<void> {
  await initDatabase();
  // The pod Brain moved to, if it moved one: the deploy secret may still name the old one.
  await loadMovedPod();
  const config = podConfig();
  if (!config) return fail('automatic power is off: BRAIN_RUNPOD_API_KEY, the GPU in primary mode, or a pod id is missing');
  console.log(`POD ${config.podId} · stopped after ${Math.round(config.idleStopMs / 60_000)} idle min`);
  const before = await readPod(config);
  if (before.status === 'UNKNOWN') return fail("RunPod's API did not answer with the account key");
  console.log(`PASS RunPod's API answers with the account key: ${before.status}${before.costPerHr ? ` at $${before.costPerHr}/h` : ''}`);
  if (before.status !== 'RUNNING') return fail(`the pod is ${before.status}, not RUNNING; nothing to cycle`);

  const started = new Date().toISOString();
  const stopAt = Date.now();
  const stop = await powerPod(config, 'stop');
  await recordBinEvent({
    eventType: 'RUNPOD_POD',
    provider: 'runpod',
    outcome: stop.ok ? 'STOPPED' : 'STOP_FAILED',
    reason: 'runpod-cycle: stopped by the production test',
    measures: { podId: config.podId, test: true },
    evidenceClass: 'MEASURED',
  }).catch(() => undefined);
  if (!stop.ok) return fail(`RunPod refused the stop: HTTP ${stop.status}`);
  console.log(`PASS stop accepted (HTTP ${stop.status})`);
  const stopped = await until('RunPod reports EXITED', 5 * 60_000, async () => (await readPod(config)).status === 'EXITED');
  console.log(`  research waiting now: ${await waitingNow()}`);

  const startWait = Date.now();
  // Recovery is either a start of this pod or, when its host has no GPU left, a move to a new
  // pod (runpodPod.ts): production 2026-11-16 00:21Z, the host was full again within seconds of
  // the stop, and Brain moved the pod at 00:33Z. Both are the automatic recovery; waiting only for
  // a start called a correct move a failure. The window covers three refused starts and the move.
  const recovered = await until('Brain started or moved the pod by itself', 25 * 60_000, async () => {
    const row = await getDb().get<{ outcome: string }>(
      `SELECT outcome FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome IN ('STARTED', 'MIGRATED') AND at >= ?
        ORDER BY at DESC LIMIT 1`,
      [started],
    );
    return !!row;
  });
  let target = config;
  if (recovered) {
    await loadMovedPod();
    const now = podConfig();
    if (now && now.podId !== config.podId) {
      target = now;
      console.log(`PASS Brain moved the pod to ${now.podId} by itself ${secs(startWait)}s after the test stopped it (its host had no GPU left)`);
    } else console.log(`PASS Brain started the pod by itself ${secs(startWait)}s after the test stopped it`);
  } else {
    const waiting = await waitingNow();
    console.log(
      waiting > 0
        ? `FAIL ${waiting} research item(s) waited and Brain neither started nor moved the pod; starting it here`
        : 'NOTE no research waited, so Brain rightly left the pod stopped; starting it here so the test does not leave the GPU off',
    );
    const start = await powerPod(config, 'start');
    if (!start.ok) console.log(`  RunPod refused the start: HTTP ${start.status}${start.body ? `: ${start.body}` : ''}`);
    await recordBinEvent({
      eventType: 'RUNPOD_POD',
      provider: 'runpod',
      outcome: start.ok ? 'STARTED' : 'START_FAILED',
      reason: `runpod-cycle: restarted by the production test${start.ok ? '' : ` (RunPod answered HTTP ${start.status}: ${start.body})`}`.slice(0, 400),
      measures: { podId: config.podId, test: true },
      evidenceClass: 'MEASURED',
    }).catch(() => undefined);
  }
  const running = await until('RunPod reports RUNNING', 10 * 60_000, async () => (await readPod(target)).status === 'RUNNING');
  const bootAt = Date.now();
  const ready = running && (await until('vLLM answers /models with its key', 20 * 60_000, () => vllmReady(target, fetch)));
  if (ready) console.log(`  model served ${secs(bootAt)}s after RUNNING`);
  // A real completion, not only a listing: the model must answer.
  let answered = false;
  if (ready) {
    const model = runpodConfig()?.model ?? '';
    try {
      const response = await fetch(`${target.vllm.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(target.vllm.key ? { authorization: `Bearer ${target.vllm.key}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word READY. /no_think' }], max_tokens: 16, temperature: 0 }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
      const text = body?.choices?.[0]?.message?.content ?? '';
      answered = response.ok && text.trim().length > 0;
      console.log(`${answered ? 'PASS' : 'FAIL'} a real completion from ${model}: HTTP ${response.status} "${text.replace(/\s+/g, ' ').trim().slice(0, 40)}"`);
    } catch (error) {
      console.log(`FAIL a real completion: ${(error as Error).name}`);
    }
  }
  const ok = stopped && recovered && running && ready && answered;
  console.log(`${ok ? 'PASS' : 'FAIL'} stop → automatic start or move → model served and answering, ${secs(stopAt)}s overall`);
  console.log(`RUNPOD-CYCLE: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('RUNPOD-CYCLE: FAIL', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
