/**
 * Starting and finishing an operator run (§106).
 *
 * Brain's own tick decides when the operator runs (`operatorDue`), so the
 * operator adds no scheduler: Hermes' cron is not used, and its machine stops
 * when idle. Each run:
 *
 *   1. finishes any run a restart left RUNNING, and refuses to overlap one;
 *   2. makes sure the operator worker exists with `OPERATOR_SCOPES` on every
 *      project (the operator directs all of Brain's goals and businesses);
 *   3. mints a credential that expires with the run — the agent holds nothing
 *      between runs, and the credential is revoked as soon as the run ends;
 *   4. sends the brief, the models (capacity Brain already has: the free
 *      switchboard, the RunPod GPU — never a paid frontier API), the MCP door
 *      with that credential, and the memory Brain stored from the last run;
 *   5. reads the run's streamed result, stores the memory it returns and the
 *      report, and records an `OPERATOR_RUN_FINISHED` event.
 *
 * Unset `BRAIN_OPERATOR_URL`/`_KEY`, or no model, and the tick does nothing.
 */
import { listProjects } from '../../repos/projects.ts';
import {
  createWorker,
  getWorkerByName,
  grantMembership,
  issueWorkerCredential,
  revokeCredential,
} from '../../repos/identity.ts';
import {
  failStaleOperatorRuns,
  MEMORY_MAX_BYTES,
  recordOperatorLearning,
  finishOperatorRun,
  readOperatorMemory,
  recentOperatorRuns,
  runningOperatorRun,
  startOperatorRun,
  storeOperatorMemory,
  type OperatorToolCall,
} from '../../repos/operator.ts';
import { recordIntegrationEvent } from '../../repos/integrationEvents.ts';
import { recordEvent } from '../../repos/events.ts';
import { OPERATOR_SCOPES } from '../../domain/types.ts';
import {
  OPERATOR_BOOT_GRACE_MINUTES,
  OPERATOR_HERMES_TOOLSETS,
  OPERATOR_MAX_TURNS,
  OPERATOR_RUN_BUDGET_SECONDS,
  OPERATOR_RUN_TIMEOUT_MINUTES,
  OPERATOR_TOOL_NAMES,
  operatorBrief,
  operatorDue,
  operatorIntervalMinutes,
  operatorModels,
  rankOperatorModels,
  OPERATOR_FREE_ROUTE,
  type OperatorModel,
} from '../../domain/operator.ts';

export const OPERATOR_WORKER = 'brain-operator';
export const OPERATOR_INTEGRATION = 'operator';

export interface OperatorConfig {
  url: string;
  key: string;
  brainUrl: string;
}

export function operatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig | null {
  const url = env['BRAIN_OPERATOR_URL']?.trim().replace(/\/+$/, '');
  const key = env['BRAIN_OPERATOR_KEY']?.trim();
  if (!url || !key) return null;
  const app = env['FLY_APP_NAME']?.trim();
  const brainUrl = (env['BRAIN_OPERATOR_BRAIN_URL']?.trim() || (app ? `http://${app}.internal:8080` : 'http://127.0.0.1:8080')).replace(/\/+$/, '');
  return { url, key, brainUrl };
}

export async function modelsFor(env: NodeJS.ProcessEnv = process.env): Promise<OperatorModel[]> {
  const { laneConfig } = await import('../cheap/lane.ts');
  const { runpodConfig, isRunpodSlot } = await import('../cheap/runpod.ts');
  const lane = laneConfig(env);
  const pod = runpodConfig(env);
  const freeUrl = env['BRAIN_CHEAP_LLM_URL']?.trim() || null;
  // The switchboard's models, without the GPU's slot label `laneConfig` puts first.
  const freeModels = lane ? lane.models.filter((m) => !isRunpodSlot(m)) : [];
  // The GPU only once its recipe serves tool calls in a window Hermes accepts (64K):
  // production's pod ran Qwen3-4B at 32K without a tool-call parser, and a fallback
  // to it failed every run it reached (HTTP 400, 2026-11-12 09:18). The connect step
  // sets BRAIN_RUNPOD_TOOLS=on only after the probe's tool-call check passed (§108).
  const podReady = (env['BRAIN_OPERATOR_GPU'] ?? '').trim() === 'on' || (env['BRAIN_RUNPOD_TOOLS'] ?? '').trim() === 'on';
  const context = Number(env['BRAIN_RUNPOD_CONTEXT']);
  const models = operatorModels({
    lane: freeUrl ? { url: freeUrl, key: env['BRAIN_CHEAP_LLM_KEY']?.trim() || null, models: freeModels } : null,
    pod: pod && podReady ? { url: pod.url, key: pod.key, model: pod.model, contextLength: Number.isFinite(context) && context > 0 ? context : null } : null,
    override: env['BRAIN_OPERATOR_MODEL'] ?? OPERATOR_FREE_ROUTE,
  });
  return rankOperatorModels(models, await operatorModelRecord().catch(() => new Map()), benchmarkToolScores(env));
}

/**
 * Which model of a run's chain did the work: the one the run reported
 * (`OPERATOR_RUN_FINISHED`'s `model`, the served name Hermes ran on) matched to
 * its label in the chain, else the first in the chain. Pure.
 *
 * Crediting the first in the chain always gave a fallback's success (or
 * failure) to the model that had already failed over, so the ranking moved the
 * wrong model.
 */
export function creditedModel(chain: string, reported: string | null | undefined): string | null {
  const labels = chain.split(' → ').map((one) => one.trim()).filter(Boolean);
  if (labels.length === 0) return null;
  const served = (reported ?? '').trim();
  if (served) {
    const match = labels.find((label) => label === served || label.slice(label.indexOf(':') + 1) === served);
    if (match) return match;
  }
  return labels[0]!;
}

/** The model each finished run reported, read from its `OPERATOR_RUN_FINISHED` event (anchor project, indexed by type). */
async function reportedModels(runIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (runIds.length === 0) return out;
  const anchor = (await listProjects())[0];
  if (!anchor) return out;
  const { getDb } = await import('../../db/database.ts');
  const rows = await getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE project_id = ? AND event_type = 'OPERATOR_RUN_FINISHED' ORDER BY created_at DESC LIMIT ?`,
    [anchor.id, Math.max(40, runIds.length * 2)],
  );
  const wanted = new Set(runIds);
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload) as { runId?: unknown; model?: unknown };
      if (typeof p.runId === 'string' && wanted.has(p.runId) && typeof p.model === 'string' && p.model.trim() && !out.has(p.runId)) out.set(p.runId, p.model);
    } catch {
      /* a malformed payload credits the first model, as before */
    }
  }
  return out;
}

/** Each model's operator runs, attributed to the model the run reported doing the work on. */
export async function operatorModelRecord(): Promise<Map<string, { runs: number; ok: number }>> {
  const record = new Map<string, { runs: number; ok: number }>();
  const runs = (await recentOperatorRuns(20)).filter((run) => run.state !== 'RUNNING');
  const reported = await reportedModels(runs.map((run) => run.id)).catch(() => new Map<string, string>());
  for (const run of runs) {
    const credited = creditedModel(run.model ?? '', reported.get(run.id));
    if (!credited) continue;
    const r = record.get(credited) ?? { runs: 0, ok: 0 };
    r.runs += 1;
    if (run.state === 'DONE') r.ok += 1;
    record.set(credited, r);
  }
  return record;
}

/** The benchmark's operator tool score for the GPU's served model, set by the connect step (§108). */
export function benchmarkToolScores(env: NodeJS.ProcessEnv): Map<string, number> {
  const out = new Map<string, number>();
  const score = Number(env['BRAIN_RUNPOD_TOOL_SCORE']);
  const model = env['BRAIN_RUNPOD_MODEL']?.trim();
  if (model && Number.isFinite(score) && score >= 0 && score <= 1) out.set(`gpu:${model}`, score);
  return out;
}

/** The operator worker, its memberships on every project, created on first use. */
export async function ensureOperatorIdentity(): Promise<string> {
  let worker = await getWorkerByName(OPERATOR_WORKER);
  if (!worker) {
    worker = await createWorker({
      name: OPERATOR_WORKER,
      displayName: 'Brain operator (Hermes Agent)',
      description: "Brain's general operator (§106). Holds a credential only for the length of one run.",
      createdByType: 'SYSTEM',
      createdById: 'operator',
    });
  }
  // Only what is missing or narrower than OPERATOR_SCOPES: under a saturated pool every write is a checkout.
  const { listMembershipsForPrincipal } = await import('../../repos/identity.ts');
  const held = new Map((await listMembershipsForPrincipal('WORKER', worker.id)).map((m) => [m.projectId, m.scopes]));
  for (const project of await listProjects()) {
    const scopes = held.get(project.id);
    if (scopes && OPERATOR_SCOPES.every((one) => scopes.includes(one))) continue;
    await grantMembership({
      projectId: project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      scopes: [...OPERATOR_SCOPES],
      grantedByType: 'SYSTEM',
      grantedById: 'operator',
    });
  }
  return worker.id;
}

let inFlight: Promise<void> | null = null;
const processStartedMs = Date.now();

/** The tick's call: start a run when one is due. Never awaits the run itself. */
const DIRECTOR_EVERY_MS = 5 * 60_000;
let lastDirectorMs = 0;

/**
 * §109: deliver engineering outcomes to the operator's record, and let Brain's standing
 * director act on a goal-blocking engineering deficiency the operator's runs could not.
 * Rows only; runs whether or not the operator app is connected, after the boot grace.
 */
async function directorTick(nowMs: number): Promise<void> {
  if (nowMs - lastDirectorMs < DIRECTOR_EVERY_MS || nowMs - processStartedMs < OPERATOR_BOOT_GRACE_MINUTES * 60_000) return;
  lastDirectorMs = nowMs;
  const { directorPass, standingCommission } = await import('./director.ts');
  await directorPass().catch((error: unknown) => console.warn(`operator director pass: ${String((error as Error)?.message ?? error)}`));
  await standingCommission(new Date(nowMs)).catch((error: unknown) => console.warn(`operator standing director: ${String((error as Error)?.message ?? error)}`));
}

export async function operatorTickIfDue(nowMs = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!inFlight) await directorTick(nowMs);
  const config = operatorConfig(env);
  if (!config || inFlight) return null;
  // A run this process did not start (a restart cut its stream): collect its result from the app.
  await collectOrphanedRuns(config);
  await failStaleOperatorRuns(new Date(nowMs - OPERATOR_RUN_TIMEOUT_MINUTES * 60_000).toISOString());
  const running = await runningOperatorRun();
  const last = (await recentOperatorRuns(1))[0] ?? null;
  const lastActedNothing = last !== null && last.state === 'FAILED' && !last.toolCalls.some((c) => c.ok && c.tool.includes('brain_operator_'));
  const { unseenOutcomeSince } = await import('./director.ts');
  const outcomeWaiting = await unseenOutcomeSince(last?.startedAt ?? null).catch(() => false);
  if (!operatorDue({ lastStartedAt: last?.startedAt ?? null, running: running !== null, nowMs, intervalMinutes: operatorIntervalMinutes(env), processStartedMs, lastActedNothing, outcomeWaiting })) {
    return null;
  }
  const models = await modelsFor(env);
  if (models.length === 0) return null;
  const run = await startOperatorRun(models.map((m) => m.label).join(' → '));
  inFlight = performRun(run.id, config, models).finally(() => {
    inFlight = null;
  });
  return run.id;
}

/** Start one run now and wait for it (the terminal's `operator run`). */
export async function runOperatorNow(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = operatorConfig(env);
  if (!config) throw new Error('BRAIN_OPERATOR_URL and BRAIN_OPERATOR_KEY are not set; deploy the operator first (agents.yml operator-deploy).');
  await failStaleOperatorRuns(new Date(Date.now() - OPERATOR_RUN_TIMEOUT_MINUTES * 60_000).toISOString());
  if (await runningOperatorRun()) throw new Error('An operator run is already in progress.');
  const models = await modelsFor(env);
  if (models.length === 0) throw new Error('No model: neither the free switchboard nor the RunPod GPU is configured.');
  const run = await startOperatorRun(models.map((m) => m.label).join(' → '));
  await performRun(run.id, config, models);
  return run.id;
}

export interface OperatorResult {
  final: string | null;
  toolCalls: OperatorToolCall[];
  memory: Record<string, string>;
  model: string | null;
  error: string | null;
  /** What the operator app saw when it first reached Brain's MCP door. */
  preflight?: string | null;
}

/** The last `{"type":"result"}` line of the operator's NDJSON stream, with every tool event before it. */
export function parseOperatorStream(text: string): OperatorResult {
  const calls: OperatorToolCall[] = [];
  let result: OperatorResult | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['type'] === 'tool' && typeof event['tool'] === 'string') {
      calls.push({
        tool: String(event['tool']).slice(0, 120),
        ok: event['ok'] !== false,
        ...(typeof event['error'] === 'string' && event['error'] ? { error: event['error'].slice(0, 300) } : {}),
      });
    } else if (event['type'] === 'result') {
      // A result collected after a restart carries its tool events itself.
      if (calls.length === 0 && Array.isArray(event['toolEvents'])) {
        for (const one of event['toolEvents'] as Record<string, unknown>[]) {
          if (typeof one['tool'] === 'string') calls.push({ tool: one['tool'].slice(0, 120), ok: one['ok'] !== false, ...(typeof one['error'] === 'string' && one['error'] ? { error: one['error'].slice(0, 300) } : {}) });
        }
      }
      const memory = event['memory'] && typeof event['memory'] === 'object' ? (event['memory'] as Record<string, string>) : {};
      result = {
        final: typeof event['final'] === 'string' ? event['final'] : null,
        toolCalls: calls,
        memory,
        model: typeof event['model'] === 'string' ? event['model'] : null,
        error: typeof event['error'] === 'string' ? event['error'] : null,
        preflight: typeof event['preflight'] === 'string' ? event['preflight'] : null,
      };
    }
  }
  return result ?? { final: null, toolCalls: calls, memory: {}, model: null, error: 'the operator ended without a result' };
}

/**
 * Production, 2026-11-12 (opr_a3690c66): the run reached Brain and acted — a
 * continued idle pool, goal reads — and a deploy restarted Brain mid-run, so
 * its report and memory never arrived and the run read FAILED. The app finishes
 * a run whatever happens to the stream and keeps the result; this collects it.
 */
async function collectOrphanedRuns(config: OperatorConfig): Promise<void> {
  const running = await runningOperatorRun();
  if (!running || inFlight) return;
  try {
    const res = await fetch(`${config.url}/v1/operator/runs/${running.id}`, {
      headers: { authorization: `Bearer ${config.key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return;
    await recordResult(running.id, parseOperatorStream(JSON.stringify(await res.json())), running.model, 'collected after a restart');
  } catch {
    /* the app is stopped or still working; failStaleOperatorRuns bounds the wait */
  }
}

async function recordResult(runId: string, result: OperatorResult, modelLabel: string, how: string): Promise<boolean> {
  // A run whose every Brain call failed directed nothing, whatever its report says.
  const brainCalls = result.toolCalls.filter((c) => c.tool.includes('brain_operator_'));
  if (result.error === null && brainCalls.length > 0 && brainCalls.every((c) => !c.ok)) {
    result.error = `every Brain tool call failed (${brainCalls.length})${result.preflight ? `; preflight: ${result.preflight}` : ''}`;
  }
  const ok = result.error === null && result.final !== null;
  const finished = await finishOperatorRun({ id: runId, state: ok ? 'DONE' : 'FAILED', summary: result.final, toolCalls: result.toolCalls, error: result.error });
  if (!finished) return false;
  const stored = await storeOperatorMemory(runId, ok ? await carriedMemory(runId, result) : result.memory);
  await recordIntegrationEvent({
    integrationId: OPERATOR_INTEGRATION,
    kind: 'USAGE',
    state: ok ? 'RUN_DONE' : 'RUN_FAILED',
    detail: `run ${runId} on ${result.model ?? modelLabel} (${how}): ${result.toolCalls.length} tool call(s), ${stored} memory entr(ies), MCP preflight ${result.preflight ?? 'not reported'}${result.error ? `; ${result.error}` : ''}`,
    source: 'operator tick',
  });
  const anchor = (await listProjects())[0];
  if (anchor) {
    await recordEvent({
      projectId: anchor.id,
      entityType: 'PROJECT',
      entityId: anchor.id,
      eventType: 'OPERATOR_RUN_FINISHED',
      payload: { runId, ok, how, model: result.model, tools: result.toolCalls.map((c) => c.tool), summary: result.final?.slice(0, 1500) ?? null, error: result.error },
    });
  }
  return true;
}

/**
 * Production, 2026-11-12 (opr_516308bd): the run withdrew fifteen moot requests
 * and commissioned a fix, then ended its report without calling
 * record_learning or its memory tool — so the next run would have started from
 * nothing it learned. What a run found is Brain's state (invariant 12) and does
 * not depend on the model remembering step 7: a run that acted and wrote no
 * lesson has its report kept as one, and its report becomes the memory's
 * "last run" so the next run continues from it.
 */
export async function carriedMemory(runId: string, result: OperatorResult): Promise<Record<string, string>> {
  const acted = result.toolCalls.some((c) => c.ok && OPERATOR_ACTION_TOOLS.some((t) => c.tool.endsWith(t)));
  const learned = result.toolCalls.some((c) => c.ok && c.tool.endsWith('brain_operator_record_learning'));
  if (acted && !learned && result.final) {
    await recordOperatorLearning({ goalId: null, runId, lesson: `Run ${runId} report (kept by Brain; the run recorded no lesson itself): ${result.final}`, evidence: `operator_runs ${runId}; tools ${result.toolCalls.filter((c) => c.ok).map((c) => c.tool.replace(/^mcp__brain__/, '')).join(', ')}` });
  }
  const memory = Object.keys(result.memory).length ? { ...result.memory } : await readOperatorMemory();
  if (result.final) {
    const prior = (memory['memories/MEMORY.md'] ?? '').replace(/\n?## Last run[\s\S]*$/, '').trimEnd();
    memory['memories/MEMORY.md'] = `${prior}${prior ? '\n\n' : ''}## Last run (${runId})\n${result.final}`.slice(-MEMORY_MAX_BYTES);
  }
  return memory;
}

/** The tools that change Brain's operations, as opposed to reading it. */
const OPERATOR_ACTION_TOOLS = [
  'brain_operator_withdraw_moot_request',
  'brain_operator_continue_idle',
  'brain_operator_submit_fix',
  'brain_operator_set_goal_focus',
  'brain_operator_commission',
  'brain_operator_prioritize_engineering',
];

async function performRun(runId: string, config: OperatorConfig, models: OperatorModel[]): Promise<void> {
  let credentialId: string | null = null;
  try {
    const { withPoolRetry } = await import('./snapshot.ts');
    const workerId = await withPoolRetry(() => ensureOperatorIdentity());
    const expiresAt = new Date(Date.now() + (OPERATOR_RUN_TIMEOUT_MINUTES + 5) * 60_000).toISOString();
    const issued = await issueWorkerCredential({ workerId, expiresAt, issuedByType: 'SYSTEM', issuedById: `operator:${runId}` });
    credentialId = issued.credential.id;
    const memory = await readOperatorMemory();
    // The goals, read once here — outside the MCP call limit — and served to the run's read tools.
    const { operatorSnapshot, snapshotForBrief } = await import('./snapshot.ts');
    const projectIds = (await listProjects()).map((p) => p.id);
    const snapshot = await operatorSnapshot(projectIds, { fresh: true });
    // §109: what Factory did with what the operator commissioned, and the deficiencies the rows show.
    const { engineeringBrief } = await import('./director.ts');
    const engineering = await engineeringBrief().catch(() => '');
    // What the previous finished run skipped, asked for again by Brain (§108).
    const { previousRunGaps } = await import('./judge.ts');
    const previous = (await recentOperatorRuns(5)).find((r) => r.id !== runId && r.state !== 'RUNNING') ?? null;
    const gaps = await previousRunGaps(previous).catch(() => '');
    const body = {
      runId,
      prompt: operatorBrief({ nowIso: new Date().toISOString(), runId, goals: snapshotForBrief(snapshot), engineering: [gaps, engineering].filter(Boolean).join('\n\n') || undefined }),
      models: models.map((m) => ({ baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey, ...(m.contextLength ? { contextLength: m.contextLength } : {}) })),
      mcp: { url: `${config.brainUrl}/mcp`, token: issued.plaintext, tools: [...OPERATOR_TOOL_NAMES] },
      toolsets: [...OPERATOR_HERMES_TOOLSETS],
      memory,
      maxTurns: OPERATOR_MAX_TURNS,
      budgetSeconds: OPERATOR_RUN_BUDGET_SECONDS,
    };
    const res = await fetch(`${config.url}/v1/operator/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((OPERATOR_RUN_BUDGET_SECONDS + 240) * 1000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`operator answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    const result = parseOperatorStream(text);
    await recordResult(runId, result, models[0]!.label, 'streamed');
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    await finishOperatorRun({ id: runId, state: 'FAILED', summary: null, toolCalls: [], error: message });
    await recordIntegrationEvent({ integrationId: OPERATOR_INTEGRATION, kind: 'USAGE', state: 'RUN_FAILED', detail: `run ${runId}: ${message}`, source: 'operator tick' });
  } finally {
    if (credentialId) await revokeCredential(credentialId, 'OPERATOR_RUN_ENDED').catch(() => undefined);
  }
}
