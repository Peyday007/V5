/**
 * Brain's operator from a terminal (§106).
 *
 *   show   recent runs (state, model, tools called, report), the memory the
 *          operator keeps, its lessons, and the actions it took — read from rows.
 *   run    start one run now and wait for it (the tick starts them hourly).
 *   probe  is the operator app reachable and is a model configured; changes nothing.
 *
 * On the deployed Brain: `agents.yml` with `operator-show`, `operator-run`, `operator-status`.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { listOperatorLearnings, readOperatorMemory, recentOperatorRuns } from '../server/repos/operator.ts';
import { modelsFor, operatorConfig, runOperatorNow } from '../server/services/operator/run.ts';

const command = process.argv[2] ?? 'show';

async function show(): Promise<void> {
  const runs = await recentOperatorRuns(Number(process.argv[3] ?? 5));
  console.log(`OPERATOR ${operatorConfig() ? 'connected' : 'not connected'} · models: ${(await modelsFor()).map((m) => m.label).join(' → ') || 'none'}`);
  for (const run of runs) {
    console.log(`RUN ${run.id} ${run.state} ${run.startedAt} → ${run.finishedAt ?? '…'} on ${run.model}`);
    console.log(`  tools  ${run.toolCalls.map((c) => `${c.tool.replace(/^mcp__brain__/, '')}${c.ok ? '' : `(failed: ${c.error ?? '?'})`}`).join(', ') || 'none'}`);
    if (run.error) console.log(`  error  ${run.error}`);
    if (run.summary) console.log(`  report ${run.summary.replace(/\n/g, '\n         ')}`);
  }
  const memory = await readOperatorMemory();
  console.log(`MEMORY ${Object.keys(memory).length} entr(ies): ${Object.keys(memory).join(', ')}`);
  for (const [name, body] of Object.entries(memory)) console.log(`  ${name}: ${body.slice(0, 600).replace(/\n/g, ' | ')}`);
  for (const one of await listOperatorLearnings({ limit: 15 })) {
    console.log(`LESSON ${one.recordedAt} ${one.goalId ?? '-'}: ${one.lesson} [${one.evidence}]`);
  }
  const actions = await getDb().all<{ event_type: string; payload: string; created_at: string }>(
    "SELECT event_type, payload, created_at FROM project_events WHERE event_type LIKE 'OPERATOR_%' ORDER BY created_at DESC LIMIT 20",
    [],
  );
  for (const action of actions) console.log(`ACTION ${action.created_at} ${action.event_type} ${action.payload.slice(0, 500)}`);
  // What Brain's MCP door answered the operator, call by call (the audit rows §17 writes).
  const calls = await getDb().all<{ created_at: string; target_id: string | null; result: string; reason: string | null; metadata: string | null }>(
    `SELECT e.created_at, e.target_id, e.result, e.reason, e.metadata FROM identity_events e
       JOIN workers w ON w.id = e.actor_id
      WHERE e.action = 'MCP_TOOL_CALL' AND w.name = 'brain-operator'
      ORDER BY e.created_at DESC LIMIT 25`,
    [],
  ).catch(() => []);
  for (const call of calls) console.log(`MCP ${call.created_at} ${call.target_id} ${call.result} ${call.reason ?? ''} ${(call.metadata ?? '').slice(0, 300)}`);
  const usage = await getDb().all<{ recorded_at: string; state: string; detail: string }>(
    "SELECT recorded_at, state, detail FROM integration_events WHERE integration_id = 'operator' ORDER BY recorded_at DESC LIMIT 6",
    [],
  );
  for (const one of usage) console.log(`USAGE ${one.recorded_at} ${one.state} ${one.detail}`);
}

async function probe(): Promise<void> {
  const config = operatorConfig();
  if (!config) {
    console.log('OPERATOR-PROBE: not connected (BRAIN_OPERATOR_URL / BRAIN_OPERATOR_KEY unset)');
    return;
  }
  const models = await modelsFor();
  const health = await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.status).catch((e: Error) => e.message);
  console.log(`OPERATOR-PROBE: app ${health} · brain ${config.brainUrl} · models ${models.map((m) => m.label).join(' → ') || 'none'}`);
}

await initDatabase();
try {
  if (command === 'show') await show();
  else if (command === 'probe') await probe();
  else if (command === 'run') {
    const id = await runOperatorNow();
    console.log(`OPERATOR-RUN ${id}`);
    await show();
    const run = (await recentOperatorRuns(1))[0];
    console.log(run?.state === 'DONE' ? 'OPERATOR-RUN: OK' : `OPERATOR-RUN: FAILED ${run?.error ?? ''}`);
  } else {
    console.error('usage: operator show [n] | run | probe');
    process.exitCode = 2;
  }
} finally {
  await closeDatabase();
}
