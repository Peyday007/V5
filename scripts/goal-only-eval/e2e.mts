// Local end-to-end goal-only evaluation of Brain's route generation, with real research answers.
//
//   ROOT=<repo> npx tsx e2e.mts questions <requests.json> <dir>      — one world per request: goal from the objective
//                                                                       alone, Brain's own discovery round opened; writes
//                                                                       <dir>/questions.json (id → Brain's question)
//   ROOT=<repo> npx tsx e2e.mts file <dir> <id> <answer.json>        — the answer filed through Brain's real submission and
//                                                                       evidence gate, harvested, one operating tick, plan read;
//                                                                       writes <dir>/<id>.plan.json
//   ROOT=<repo> npx tsx e2e.mts next <dir> <id>                       — Brain opens its next round for the goal (its own
//                                                                       recovery), appends to questions.json
//
// answer.json: { "claims": [ { claim, sourceUrl, sourceTitle, sourcePublisher, sourceDate, evidenceExcerpt, evidenceLocator,
//   evidenceLane, opportunitySignal?, route?, claimType?, supportsClaim: true|false } ], "unresolved": [] }
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.ROOT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const R = (p: string) => path.join(ROOT, p);
const [cmd, a1, a2, a3] = process.argv.slice(2);

async function open(file: string) {
  const { closeDatabase, initDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
  await initDatabase({ dbPath: file });
}

async function world(dir: string) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'template.json'), 'utf8'));
  return meta as { file: string; projectId: string; userId: string };
}

async function openRound(goalId: string) {
  const { getWorkstream } = await import(R('server/repos/register.ts'));
  const { forgetGoalReadings, readGoalPlan } = await import(R('server/services/goals/plan.ts'));
  const { openGoalDiscovery } = await import(R('server/services/cash/discovery.ts'));
  const { getCandidate } = await import(R('server/repos/russellCandidates.ts'));
  forgetGoalReadings();
  const plan = await readGoalPlan({ goalId, evaluations: 200 });
  if (!plan) throw new Error('the planner returned no reading for the new goal');
  const opened = await openGoalDiscovery({ goal: (await getWorkstream(goalId))!, target: plan.target, bestReach: plan.bestReach ?? null, heldTitles: plan.excluded.map((one: { title: string }) => one.title).slice(0, 8), now: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  if (!opened) return null;
  const candidate = await getCandidate(opened.candidateId);
  return { ...opened, question: candidate?.statement ?? '' };
}

if (cmd === 'questions') {
  const requests = JSON.parse(fs.readFileSync(a1!, 'utf8')) as { id: string; objective: string }[];
  const dir = a2!;
  fs.mkdirSync(dir, { recursive: true });
  const { buildTemplate } = await import(R('bench/planningReliability/world.ts'));
  const t = await buildTemplate(path.join(dir, 'tpl'));
  fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(t));
  const out: Record<string, unknown> = {};
  for (const r of requests) {
    const file = path.join(dir, `${r.id}.db`);
    fs.copyFileSync(t.file, file);
    await open(file);
    const { createGoal } = await import(R('server/services/goals/decide.ts'));
    const created = await createGoal({ projectId: t.projectId, objective: r.objective, actorRef: `person:${t.userId}`, userId: t.userId, now: new Date(Date.now() - 60_000) });
    if (!created.ok) { out[r.id] = { error: created.reason }; continue; }
    let round = null; let err: string | null = null;
    try { round = await openRound(created.goal.id); } catch (e) { err = String((e as Error)?.message ?? e); }
    out[r.id] = { goalId: created.goal.id, objective: r.objective, rounds: round ? [round] : [], error: err ?? (round ? null : 'no discovery round opened') };
    console.log(r.id, round ? round.bucketId : 'NO ROUND');
  }
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(out, null, 1));
  const { closeDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
}

if (cmd === 'next') {
  const dir = a1!; const id = a2!;
  const qs = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  await open(path.join(dir, `${id}.db`));
  const round = await openRound(qs[id].goalId);
  if (round) qs[id].rounds.push(round);
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(qs, null, 1));
  console.log(id, round ? round.bucketId : 'NO ROUND');
  const { closeDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
}

if (cmd === 'file') {
  const dir = a1!; const id = a2!;
  const t = await world(dir);
  const qs = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  const q = qs[id];
  const round = q.rounds[q.rounds.length - 1];
  const answer = JSON.parse(fs.readFileSync(a3!, 'utf8'));
  await open(path.join(dir, `${id}.db`));
  const { createRun } = await import(R('server/repos/runs.ts'));
  const { createFragments, createOrchestration, currentFragments } = await import(R('server/repos/research.ts'));
  const { launchMission, linkMission, transitionMission } = await import(R('server/repos/russellMissions.ts'));
  const { recordFragmentClaims, gateFragment } = await import(R('server/services/research/submission.ts'));
  const { parseResearchPass } = await import(R('server/services/research/schema.ts'));
  const { goalMechanismProfile } = await import(R('server/services/russell/compilerProfiles.ts'));
  const { listLayers } = await import(R('server/repos/layers.ts'));
  const { harvest } = await import(R('server/services/cash/discovery.ts'));
  const { operate } = await import(R('server/services/cash/operate.ts'));
  const { forgetGoalReadings, readGoalPlan } = await import(R('server/services/goals/plan.ts'));
  const profile = goalMechanismProfile('RUSSELL_CASH_DISCOVERY_V1')!;
  const layers = await listLayers(t.projectId);
  const layer = layers[0];
  const run = await createRun({ projectId: t.projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'goal round' });
  const orch = await createOrchestration({ projectId: t.projectId, layerId: layer.id, runId: run.id, title: 'goal round', assignment: round.question, provider: 'WORKER', autoApprove: false });
  await createFragments([{
    orchestrationId: orch.id, projectId: t.projectId, layerId: layer.id, geography: null, timeframe: null, population: null,
    requiredEvidence: profile.lanes, acceptableSourceTypes: ['published sources'], excludedSourceTypes: ['forecasts'],
    completionCriteria: ['answered'], minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'goal-round', question: round.question, dependsOn: [], attempt: 1,
  }] as never);
  const [fragment] = await currentFragments(orch.id);
  const { mission } = await launchMission({ projectId: t.projectId, layerId: layer.id, visibility: 'SHARED', objective: 'goal round', whyNow: 'goal', idempotencyKey: `m:${orch.id}`, candidateId: round.candidateId, attempt: 1 } as never);
  await linkMission({ missionId: mission.id, orchestrationId: orch.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  const rows = (answer.claims as any[]).map((c) => { const row = { claimType: 'SOURCED_FACT', confidence: 0.8, retrievedAt: new Date().toISOString().slice(0, 10), primarySource: false, ...c }; delete (row as any).supportsClaim; return row; });
  const parsed: any = parseResearchPass(JSON.stringify({ claims: rows, searchQueries: answer.searchQueries ?? [], unresolved: answer.unresolved ?? [], notes: '' }));
  if (!parsed.ok) throw new Error(`answer refused by the claim parser: ${JSON.stringify(parsed).slice(0, 400)}`);
  const claims = parsed.value.claims;
  const { startPass, finishPass } = await import(R('server/repos/research.ts'));
  const pass = await startPass({ orchestrationId: orch.id, fragmentId: fragment!.id, passKey: 'TARGETED', ordinal: 2, attempt: 1, provider: 'WORKER', model: 'e2e-research-worker', prompt: round.question, promptSha256: 'x', executorWorkerId: null, executorRoutineId: null, executorAccountId: null, executorSessionRef: null } as never);
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: JSON.stringify(answer).slice(0, 100000), parsed: answer } as never);
  const stored = await recordFragmentClaims({ orchestration: orch, fragment: fragment!, passId: pass.id, passKey: 'TARGETED', claims });
  const supports = (answer.claims as any[]).map((c) => c.supportsClaim !== false);
  const gate = await gateFragment({
    fragment: fragment!,
    verifications: stored.map((s: any, i: number) => ({ claimId: s.id, supportsClaim: supports[i]!, scopeMatch: { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' }, note: '' })),
    sufficiency: 'SUFFICIENT', missingLanes: [], unresolvedGaps: answer.unresolved ?? [],
  });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
  const harvested = await harvest({ projectId: t.projectId });
  const op = await operate(t.projectId);
  forgetGoalReadings();
  const p: any = await readGoalPlan({ goalId: q.goalId, evaluations: 400 });
  const { listOpportunities } = await import(R('server/repos/cashPortfolio.ts'));
  const { cardFactMap } = await import(R('server/repos/cashCardFacts.ts'));
  const cards: any[] = [];
  for (const o of await listOpportunities({ projectId: t.projectId })) {
    if (o.duplicateOfId) continue;
    const f = await cardFactMap(o.id, t.projectId);
    cards.push({ id: o.id, title: o.title, payer: o.payer, priceCents: o.priceCents, channel: o.reachableChannel, fulfiller: o.fulfillmentOwner, facts: Object.fromEntries(['payer', 'price', 'revenueRange', 'access', 'fulfillment', 'directCosts', 'hours', 'buyerVolume', 'timeToFirstCash', 'captureMechanism', 'offer'].map((k) => [k, f(k) ? `${f(k)!.kind}: ${String(f(k)!.value).slice(0, 220)}` : null])) });
  }
  const out = {
    id, objective: q.objective, gate: { accepted: (gate as any).accepted ?? null, status: (gate as any).status ?? null },
    stored: stored.length, harvested: harvested.length, operateFailures: op.failures,
    verdict: p.verdict, target: { remainingCents: p.target?.remainingCents, daysLeft: p.target?.daysLeft, capital: p.target?.capitalCeilingCents, hours: p.target?.hoursCeiling },
    strategies: p.strategies.map((s: any) => ({ key: s.key, label: s.label, verdict: s.verdict, chainComplete: s.chainComplete, failed: s.constraintsFailed, open: s.links.filter((l: any) => !l.ok).map((l: any) => `${l.link}: ${l.basis}`), conservative: s.conservativeSettled })),
    chosen: p.chosenStrategy, nextTest: p.nextTest, infeasible: p.infeasible,
    steps: p.steps.map((s: any) => `${s.order}. [${s.owner}/${s.executor?.operation}] ${s.label} — ${String(s.detail).slice(0, 260)}`),
    excluded: p.excluded, cards,
  };
  fs.writeFileSync(path.join(dir, `${id}.plan.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ id, stored: stored.length, harvested: harvested.length, verdict: p.verdict, strategies: out.strategies.map((s: any) => [s.key, s.verdict, s.open.map((x: string) => x.split(':')[0])]) }));
  const { closeDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
}

if (cmd === 'dives') {
  const dir = a1!; const id = a2!;
  await open(path.join(dir, `${id}.db`));
  const { getDb } = await import(R('server/db/database.ts'));
  const { getCandidate } = await import(R('server/repos/russellCandidates.ts'));
  const { missionsForCandidate } = await import(R('server/repos/russellMissions.ts')).catch(() => ({ missionsForCandidate: null as any }));
  const rows = await getDb().all<{ opportunity_id: string; detail: string }>("SELECT opportunity_id, detail FROM cash_events WHERE kind = 'CASH_VALIDATION_STARTED' ORDER BY created_at");
  const out: any[] = [];
  for (const row of rows) {
    const d = JSON.parse(row.detail);
    const done = missionsForCandidate ? (await missionsForCandidate(d.candidateId)).length > 0 : false;
    if (done) continue;
    const c = await getCandidate(d.candidateId);
    if (!c) continue;
    const f = path.join(dir, `${id}.dive.${row.opportunity_id}.txt`);
    fs.writeFileSync(f, c.statement);
    out.push({ opportunityId: row.opportunity_id, candidateId: d.candidateId, questionFile: f });
  }
  fs.writeFileSync(path.join(dir, `${id}.dives.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.map((o) => o.opportunityId)));
  const { closeDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
}

if (cmd === 'filedive') {
  const dir = a1!; const id = a2!; const oppId = a3!; const answerFile = process.argv[6]!;
  const t = await world(dir);
  const qs = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  const dives = JSON.parse(fs.readFileSync(path.join(dir, `${id}.dives.json`), 'utf8'));
  const dive = dives.find((d: any) => d.opportunityId === oppId);
  const answer = JSON.parse(fs.readFileSync(answerFile, 'utf8'));
  await open(path.join(dir, `${id}.db`));
  const { createRun } = await import(R('server/repos/runs.ts'));
  const { createFragments, createOrchestration, currentFragments, startPass, finishPass } = await import(R('server/repos/research.ts'));
  const { launchMission, linkMission, transitionMission } = await import(R('server/repos/russellMissions.ts'));
  const { recordFragmentClaims, gateFragment } = await import(R('server/services/research/submission.ts'));
  const { parseResearchPass } = await import(R('server/services/research/schema.ts'));
  const { profileFor } = await import(R('server/services/russell/compilerProfiles.ts'));
  const { listLayers } = await import(R('server/repos/layers.ts'));
  const { updateOpportunity } = await import(R('server/repos/cashPortfolio.ts'));
  const profile = profileFor('RUSSELL_CASH_VALIDATION_V1')!;
  const layer = (await listLayers(t.projectId))[0];
  const question = fs.readFileSync(dive.questionFile, 'utf8');
  const run = await createRun({ projectId: t.projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'dive' });
  const orch = await createOrchestration({ projectId: t.projectId, layerId: layer.id, runId: run.id, title: 'dive', assignment: question, provider: 'WORKER', autoApprove: false });
  await createFragments([{ orchestrationId: orch.id, projectId: t.projectId, layerId: layer.id, geography: null, timeframe: null, population: null, requiredEvidence: profile.lanes, acceptableSourceTypes: ['published sources'], excludedSourceTypes: ['forecasts'], completionCriteria: ['answered'], minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'opening-validation', question, dependsOn: [], attempt: 1 }] as never);
  const [fragment] = await currentFragments(orch.id);
  const { mission } = await launchMission({ projectId: t.projectId, layerId: layer.id, visibility: 'SHARED', objective: 'dive', whyNow: 'goal', idempotencyKey: `m:${orch.id}`, candidateId: dive.candidateId, attempt: 1 } as never);
  await linkMission({ missionId: mission.id, orchestrationId: orch.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await updateOpportunity(oppId, { validation_state: 'RUNNING', validation_orchestration_id: orch.id } as never).catch(() => null);
  const rows = (answer.claims as any[]).map((c) => { const row = { claimType: 'SOURCED_FACT', confidence: 0.8, retrievedAt: new Date().toISOString().slice(0, 10), primarySource: false, ...c }; delete (row as any).supportsClaim; return row; });
  const parsed: any = parseResearchPass(JSON.stringify({ claims: rows, searchQueries: [], unresolved: answer.unresolved ?? [], notes: '' }));
  if (!parsed.ok) throw new Error(`dive answer refused: ${JSON.stringify(parsed).slice(0, 400)}`);
  const pass = await startPass({ orchestrationId: orch.id, fragmentId: fragment!.id, passKey: 'TARGETED', ordinal: 2, attempt: 1, provider: 'WORKER', model: 'e2e-research-worker', prompt: question, promptSha256: 'x', executorWorkerId: null, executorRoutineId: null, executorAccountId: null, executorSessionRef: null } as never);
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: JSON.stringify(answer).slice(0, 100000), parsed: answer } as never);
  const stored = await recordFragmentClaims({ orchestration: orch, fragment: fragment!, passId: pass.id, passKey: 'TARGETED', claims: parsed.value.claims });
  const supports = (answer.claims as any[]).map((c) => c.supportsClaim !== false);
  await gateFragment({ fragment: fragment!, verifications: stored.map((s: any, i: number) => ({ claimId: s.id, supportsClaim: supports[i]!, scopeMatch: { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' }, note: '' })), sufficiency: 'SUFFICIENT', missingLanes: [], unresolvedGaps: answer.unresolved ?? [] });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
  console.log(JSON.stringify({ id, oppId, stored: stored.length }));
  const { closeDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
}

if (cmd === 'plan') {
  // One operating tick, then the plan read and written, as `file` does at its end.
  const dir = a1!; const id = a2!;
  const t = await world(dir);
  const qs = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  await open(path.join(dir, `${id}.db`));
  const { operate } = await import(R('server/services/cash/operate.ts'));
  const { harvest } = await import(R('server/services/cash/discovery.ts'));
  await harvest({ projectId: t.projectId });
  for (let i = 0; i < 2; i++) await operate(t.projectId);
  const { forgetGoalReadings, readGoalPlan } = await import(R('server/services/goals/plan.ts'));
  forgetGoalReadings();
  const p: any = await readGoalPlan({ goalId: qs[id].goalId, evaluations: 400 });
  const { listOpportunities } = await import(R('server/repos/cashPortfolio.ts'));
  const { cardFactMap } = await import(R('server/repos/cashCardFacts.ts'));
  const cards: any[] = [];
  for (const o of await listOpportunities({ projectId: t.projectId })) {
    if (o.duplicateOfId) continue;
    const f = await cardFactMap(o.id, t.projectId);
    cards.push({ id: o.id, title: o.title, payer: o.payer, priceCents: o.priceCents, channel: o.reachableChannel, hours: o.humanHours, caps: o.requiredCapabilities, validation: o.validationState, facts: Object.fromEntries(['payer', 'price', 'revenueRange', 'access', 'fulfillment', 'directCosts', 'hours', 'buyerVolume', 'buyingEvidence', 'timeToFirstCash', 'captureMechanism', 'offer', 'requiredCapital'].map((k) => [k, f(k) ? `${f(k)!.kind}: ${String(f(k)!.value).slice(0, 220)}` : null])) });
  }
  const out = { id, objective: qs[id].objective, verdict: p.verdict, strategies: p.strategies.map((s: any) => ({ key: s.key, label: s.label, verdict: s.verdict, chainComplete: s.chainComplete, failed: s.constraintsFailed, open: s.links.filter((l: any) => !l.ok).map((l: any) => `${l.link}: ${l.basis}`), conservative: s.conservativeSettled })), chosen: p.chosenStrategy, nextTest: p.nextTest, infeasible: p.infeasible, steps: p.steps.map((s: any) => `${s.order}. [${s.owner}/${s.executor?.operation}] ${s.label} — ${String(s.detail).slice(0, 300)}`), excluded: p.excluded, cards };
  fs.writeFileSync(path.join(dir, `${id}.plan.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ id, verdict: p.verdict, strategies: out.strategies.map((s: any) => [s.key, s.verdict, s.open.map((x: string) => x.split(':')[0]), s.failed.slice(0, 1)]) }));
  const { closeDatabase } = await import(R('server/db/database.ts'));
  await closeDatabase({ drainMs: 100 });
}
