/**
 * Brain's operator from a terminal (§106).
 *
 *   show   recent runs (state, model, tools called, report), the memory the
 *          operator keeps, its lessons, and the actions it took — read from rows.
 *   run    start one run now and wait for it (the tick starts them hourly).
 *          `run --mission <file-or-text>` (or `--mission-b64 <base64>`, `--mission-key KEY`)
 *          first sets or refreshes the standing mission (default key SURGE:B), which every
 *          later run's brief carries until `mission close [KEY]`.
 *   mission show | set <file-or-text> [--mission-key KEY] | close [KEY]  — the standing missions.
 *   probe  is the operator app reachable and is a model configured; changes nothing.
 *   prove  one run now, then the proof from rows (§108): it inspected a real goal and its
 *          plan, committed a decision, took an action through Brain, observed the result
 *          after it, and kept what it learned. Also prints the allocation reading and the
 *          operator's decision record on the ledger. `OPERATOR-PROOF: OK` only when all hold.
 *
 * On the deployed Brain: `agents.yml` with `operator-show`, `operator-run`, `operator-status`.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { listOperatorLearnings, readOperatorMemory, recentOperatorRuns } from '../server/repos/operator.ts';
import { modelsFor, operatorConfig, runOperatorNow } from '../server/services/operator/run.ts';

const command = process.argv[2] ?? 'show';

/** The value after `--name`, if given. */
function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** A mission given as a path to a readable file is that file's text; anything else is the text itself. */
async function missionText(value: string): Promise<string> {
  const { readFile, stat } = await import('node:fs/promises');
  const isFile = await stat(value).then((s) => s.isFile(), () => false);
  return isFile ? readFile(value, 'utf8') : value;
}

/** Set the mission from `--mission` / `--mission-b64` when given; returns false after printing a refusal. */
async function missionFromFlags(fallbackText: string | null = null): Promise<boolean> {
  const b64 = flag('mission-b64');
  const raw = b64 !== null ? Buffer.from(b64, 'base64').toString('utf8') : (flag('mission') ?? fallbackText);
  if (raw === null || !raw.trim()) return true;
  const { setMission } = await import('../server/services/operator/inventory.ts');
  const result = await setMission({ key: flag('mission-key') ?? undefined, text: await missionText(raw.trim()) }, { runId: null, actor: 'terminal' });
  if (!result.ok) {
    console.log(`OPERATOR-MISSION: REFUSED ${result.reason}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`OPERATOR-MISSION: ${result.created ? 'SET' : 'REFRESHED'} ${result.mission.key} (${result.mission.text.length} chars)`);
  return true;
}

async function show(): Promise<void> {
  // `run --mission-b64 …` reaches here too: only a bare number is a limit.
  const limit = /^\d+$/.test(process.argv[3] ?? '') ? Number(process.argv[3]) : 5;
  const runs = await recentOperatorRuns(limit);
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
    "SELECT event_type, payload, created_at FROM project_events WHERE event_type IN ('OPERATOR_WITHDREW_MOOT_REQUEST', 'OPERATOR_FIX_SUBMITTED', 'OPERATOR_FIX_NOT_STARTED', 'OPERATOR_RUN_FINISHED', 'OPERATOR_DECISION', 'OPERATOR_DECISION_VERIFIED', 'OPERATOR_GOAL_FOCUS') ORDER BY created_at DESC LIMIT 20",
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

async function prove(): Promise<void> {
  // `prove latest` judges the newest finished run Brain's own tick started — the autonomous one —
  // instead of starting another (a shared workflow queue can cancel a dispatched run, and a run
  // is refused while one is in progress).
  const latest = process.argv[3] === 'latest';
  const id = latest ? ((await recentOperatorRuns(10)).find((r) => r.state !== 'RUNNING')?.id ?? '') : await runOperatorNow();
  const run = (await recentOperatorRuns(20)).find((r) => r.id === id);
  if (!run) {
    console.log('OPERATOR-PROOF: FAILED no finished run');
    return;
  }
  const names = run.toolCalls.map((c) => ({ tool: c.tool.replace(/^mcp__brain__/, ''), ok: c.ok }));
  console.log(`RUN ${run.id} ${run.state} on ${run.model}${run.error ? ` error ${run.error}` : ''}`);
  console.log(`  tools ${names.map((n) => `${n.tool}${n.ok ? '' : '(failed)'}`).join(', ') || 'none'}`);
  if (run.summary) console.log(`  report ${run.summary.slice(0, 2500).replace(/\n/g, '\n         ')}`);
  const { judgeOperatorRun } = await import('../server/services/operator/judge.ts');
  const { checks: judged, decisions } = await judgeOperatorRun(run);
  for (const d of decisions) {
    const p = JSON.parse(d.payload) as { input: { kind: string; question: string; options: { action: string }[]; chosen: number; prediction: { outcome: string; probability: number; horizonDays: number } }; challenge: unknown };
    console.log(`DECISION ${d.entity_id} ${p.input.kind}: ${p.input.question} → ${p.input.options[p.input.chosen]?.action} · predicts "${p.input.prediction.outcome}" p=${p.input.prediction.probability} in ${p.input.prediction.horizonDays}d · challenge ${typeof p.challenge === 'object' ? JSON.stringify(p.challenge).slice(0, 300) : p.challenge}`);
  }
  const verified = await getDb().all<{ entity_id: string; payload: string }>(
    "SELECT entity_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION_VERIFIED' AND payload LIKE ?",
    [`%"runId":"${run.id}"%`],
  );
  for (const v of verified) console.log(`VERIFIED ${v.entity_id} ${v.payload.slice(0, 300)}`);
  const checks: [string, boolean, string][] = judged.map((c) => [c.step, c.pass, c.detail]);
  for (const [name, pass, detail] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  const { readAllocation } = await import('../server/services/operator/allocation.ts');
  const { listProjects } = await import('../server/repos/projects.ts');
  const allocation = await readAllocation((await listProjects()).map((p) => p.id));
  for (const a of allocation.allocations.slice(0, 8)) console.log(`ALLOCATION ${a.stance.padEnd(7)} ${a.marginalUsdPerUnit.toFixed(2).padStart(9)} $/unit share ${(a.share * 100).toFixed(0)}% ${a.id} ${a.title.slice(0, 60)} — ${a.why}`);
  const { readLedger } = await import('../server/services/quant/ledger.ts');
  const ledger = await readLedger(null);
  const ops = ledger.predictions.filter((p) => p.comparableKey.startsWith('operator:'));
  console.log(`LEDGER operator predictions ${ops.length} · judged ${ops.filter((p) => ledger.outcomes.some((o) => o.predictionId === p.id)).length}`);
  console.log(checks.every((c) => c[1]) ? 'OPERATOR-PROOF: OK' : `OPERATOR-PROOF: FAILED ${checks.filter((c) => !c[1]).map((c) => c[0]).join(',')}`);
}

await initDatabase();
try {
  if (command === 'show') await show();
  else if (command === 'probe') await probe();
  else if (command === 'mission') {
    const sub = process.argv[3] ?? 'show';
    const inventory = await import('../server/services/operator/inventory.ts');
    if (sub === 'set') {
      const text = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
      await missionFromFlags(text);
    } else if (sub === 'close') {
      const key = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : 'SURGE:B';
      const closed = await inventory.closeMission(key, { runId: null, actor: 'terminal' });
      console.log(`OPERATOR-MISSION: ${closed.ok ? 'CLOSED' : 'REFUSED'} ${closed.reason}`);
      if (!closed.ok) process.exitCode = 1;
    } else {
      for (const m of await inventory.openMissions()) console.log(`MISSION ${m.key} set ${m.setAt} by ${m.setBy}\n  ${m.text.replace(/\n/g, '\n  ')}`);
      for (const i of await inventory.listInventory()) console.log(`FINDING ${i.id} [${i.status}, ${i.severity}] ${i.capability}: ${i.symptom.slice(0, 200)}${i.verification ? ` · verified ${i.verification.kind} ${i.verification.ref}` : ''}`);
    }
  } else if (command === 'run') {
    if (!(await missionFromFlags())) throw new Error('the mission was refused; no run started');
    const id = await runOperatorNow();
    console.log(`OPERATOR-RUN ${id}`);
    await show();
    const run = (await recentOperatorRuns(1))[0];
    console.log(run?.state === 'DONE' ? 'OPERATOR-RUN: OK' : `OPERATOR-RUN: FAILED ${run?.error ?? ''}`);
  } else if (command === 'engineering') {
    // §109: what the operator commissioned and what came of it, and what the rows show is weak.
    const { engineeringOutcomes, readDeficiencies, readingId, directorPass } = await import('../server/services/operator/director.ts');
    const pass = await directorPass();
    console.log(`DIRECTOR pass: ${pass.recorded} outcome(s) recorded, ${pass.wake} wake the operator`);
    for (const one of await engineeringOutcomes({ limit: 10 })) {
      console.log(`ENGINEERING ${one.candidateId} ${one.weaknessKey} [${one.status} → ${one.next}] priority ${one.priority ?? '-'} goal ${one.goalId ?? '-'}`);
      console.log(`  ${one.title}`);
      console.log(`  ${one.sentence}`);
      if (one.factory) console.log(`  factory ${one.factory.status} pr ${one.factory.prUrl ?? '-'} merge ${one.factory.mergeSha ?? '-'} deployed ${one.factory.deployed} verified ${one.factory.verified} tests ${one.factory.tests} changed ${one.factory.changedPaths.join(', ') || '-'}`);
      if (one.measurement) console.log(`  measured ${one.measurement.metric}: ${one.measurement.before} → ${one.measurement.after} (${one.measurement.verdict ?? 'not yet'})`);
      console.log(`  goal ${one.goal.effect}: ${one.goal.reasons.join('; ')}`);
    }
    for (const one of await readDeficiencies()) {
      console.log(`DEFICIENCY ${readingId(one)} ${one.diagnosis.deficiency} → ${one.intervention}: ${one.diagnosis.title} (${one.why})`);
    }
  } else if (command === 'commission') {
    // The standing director's own act, from a terminal: commission a deficiency by its id as the rows state it.
    const { commission, readDeficiencies, readingId } = await import('../server/services/operator/director.ts');
    const id = process.argv[3] ?? '';
    const found = (await readDeficiencies()).find((one) => readingId(one) === id);
    if (!found) {
      console.log(`OPERATOR-COMMISSION: no current deficiency ${id}`);
      process.exitCode = 1;
    } else {
      const run = (await recentOperatorRuns(1))[0];
      console.log(`OPERATOR-COMMISSION: ${JSON.stringify(await commission({ ...found.diagnosis, runId: run?.id ?? null }))}`);
    }
  } else if (command === 'prove') {
    await prove();
  } else {
    console.error('usage: operator show [n] | run [--mission <file-or-text> | --mission-b64 <b64>] [--mission-key KEY] | mission show|set|close | probe | prove | engineering | commission <dfx_id>');
    process.exitCode = 2;
  }
} finally {
  await closeDatabase();
}
