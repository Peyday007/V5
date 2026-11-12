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
  OPERATOR_HERMES_TOOLSETS,
  OPERATOR_MAX_TURNS,
  OPERATOR_RUN_BUDGET_SECONDS,
  OPERATOR_RUN_TIMEOUT_MINUTES,
  OPERATOR_TOOL_NAMES,
  operatorBrief,
  operatorDue,
  operatorIntervalMinutes,
  operatorModels,
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
  return operatorModels({
    lane: freeUrl ? { url: freeUrl, key: env['BRAIN_CHEAP_LLM_KEY']?.trim() || null, models: freeModels } : null,
    pod: pod ? { url: pod.url, key: pod.key, model: pod.model } : null,
    override: env['BRAIN_OPERATOR_MODEL'] ?? null,
  });
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
  for (const project of await listProjects()) {
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
export async function operatorTickIfDue(nowMs = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const config = operatorConfig(env);
  if (!config || inFlight) return null;
  await failStaleOperatorRuns(new Date(nowMs - OPERATOR_RUN_TIMEOUT_MINUTES * 60_000).toISOString());
  const running = await runningOperatorRun();
  const last = (await recentOperatorRuns(1))[0] ?? null;
  if (!operatorDue({ lastStartedAt: last?.startedAt ?? null, running: running !== null, nowMs, intervalMinutes: operatorIntervalMinutes(env), processStartedMs })) {
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
      calls.push({ tool: String(event['tool']).slice(0, 120), ok: event['ok'] !== false });
    } else if (event['type'] === 'result') {
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

async function performRun(runId: string, config: OperatorConfig, models: OperatorModel[]): Promise<void> {
  let credentialId: string | null = null;
  try {
    const workerId = await ensureOperatorIdentity();
    const expiresAt = new Date(Date.now() + (OPERATOR_RUN_TIMEOUT_MINUTES + 5) * 60_000).toISOString();
    const issued = await issueWorkerCredential({ workerId, expiresAt, issuedByType: 'SYSTEM', issuedById: `operator:${runId}` });
    credentialId = issued.credential.id;
    const memory = await readOperatorMemory();
    const body = {
      runId,
      prompt: operatorBrief({ nowIso: new Date().toISOString(), runId }),
      models: models.map((m) => ({ baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey })),
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
    const stored = await storeOperatorMemory(runId, result.memory);
    // A run whose every Brain call failed directed nothing, whatever its report says.
    const brainCalls = result.toolCalls.filter((c) => c.tool.includes('brain_operator_'));
    if (result.error === null && brainCalls.length > 0 && brainCalls.every((c) => !c.ok)) {
      result.error = `every Brain tool call failed (${brainCalls.length})${result.preflight ? `; preflight: ${result.preflight}` : ''}`;
    }
    const ok = result.error === null && result.final !== null;
    await finishOperatorRun({ id: runId, state: ok ? 'DONE' : 'FAILED', summary: result.final, toolCalls: result.toolCalls, error: result.error });
    await recordIntegrationEvent({
      integrationId: OPERATOR_INTEGRATION,
      kind: 'USAGE',
      state: ok ? 'RUN_DONE' : 'RUN_FAILED',
      detail: `run ${runId} on ${result.model ?? models[0]!.label}: ${result.toolCalls.length} tool call(s), ${stored} memory entr(ies), MCP preflight ${result.preflight ?? 'not reported'}${result.error ? `; ${result.error}` : ''}`,
      source: 'operator tick',
    });
    const projects = await listProjects();
    const anchor = projects[0];
    if (anchor) {
      await recordEvent({
        projectId: anchor.id,
        entityType: 'PROJECT',
        entityId: anchor.id,
        eventType: 'OPERATOR_RUN_FINISHED',
        payload: { runId, ok, model: result.model, tools: result.toolCalls.map((c) => c.tool), summary: result.final?.slice(0, 1500) ?? null, error: result.error },
      });
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    await finishOperatorRun({ id: runId, state: 'FAILED', summary: null, toolCalls: [], error: message });
    await recordIntegrationEvent({ integrationId: OPERATOR_INTEGRATION, kind: 'USAGE', state: 'RUN_FAILED', detail: `run ${runId}: ${message}`, source: 'operator tick' });
  } finally {
    if (credentialId) await revokeCredential(credentialId, 'OPERATOR_RUN_ENDED').catch(() => undefined);
  }
}
