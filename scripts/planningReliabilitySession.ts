/**
 * Planning reliability of app-session-authored plans, on the completion specification's own cases
 * and grader (docs/COMPLETION-SPEC.md, bench/planningReliability). Each case gets an isolated world
 * built exactly as the bench builds it (its openings filed by `fileOpening`, its goal by `createGoal`
 * from the case's words, its changes by `applyChange`); a session then plans it through
 * scripts/planningSession.ts — the same adapter the MCP tools serve — and `grade` scores the
 * session's current revision through `observeSession`.
 *
 *   npx tsx scripts/planningReliabilitySession.ts prepare --case ID --dir D     world + world.json + OBJECTIVE.txt
 *   npx tsx scripts/planningReliabilitySession.ts change  --case ID --dir D --step K
 *   npx tsx scripts/planningReliabilitySession.ts grade   --case ID --dir D [--step K]   one graded row (JSON)
 *   npx tsx scripts/planningReliabilitySession.ts summary --rows a.json,b.json,…         the reliability table
 *
 * The world directory a session is given holds no expectation: the case's rubric is read only here,
 * by `grade`. Nothing touches production, spends or contacts anyone.
 */
import fs from 'node:fs';
import path from 'node:path';

const [cmd = '', ...rest] = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? null) : null;
};
const need = (name: string): string => {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required for ${cmd}`);
  return v;
};
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function caseOf(id: string) {
  const { PUBLIC_CASES } = await import('../bench/planningReliability/cases.ts');
  const c = PUBLIC_CASES.find((one) => one.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

interface WorldMeta { projectId: string; userId: string; goalId: string; caseId: string; keys: Record<string, string> }

async function main(): Promise<void> {
  if (cmd === 'summary') {
    const rows = need('rows').split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as { id: string; heldOut: boolean; pass: boolean; published?: boolean; failures: string[]; critical: string[]; usable?: { pass: boolean }; e2e?: { pass: boolean; failures?: string[] } });
    const { wilson } = await import('../server/services/cash/goalScenario.ts');
    const passed = rows.filter((r) => r.pass).length;
    const w = wilson(passed, rows.length);
    out({
      cases: rows.length,
      passed,
      reliability: rows.length ? passed / rows.length : null,
      wilson95: w,
      criticalFailures: rows.filter((r) => r.critical.length).length,
      published: rows.filter((r) => r.published !== false).length,
      usable: rows.filter((r) => r.usable?.pass).length,
      e2e: rows.filter((r) => r.e2e?.pass).length,
      e2eFailures: rows.flatMap((r) => r.e2e?.failures ?? []).reduce<Record<string, number>>((m, f) => ({ ...m, [f]: (m[f] ?? 0) + 1 }), {}),
      failures: rows.filter((r) => !r.pass).map((r) => ({ id: r.id, failures: r.failures, critical: r.critical })),
    });
    return;
  }
  const c = await caseOf(need('case'));
  const dir = need('dir');
  const { initDatabase, closeDatabase } = await import('../server/db/database.ts');
  const db = path.join(dir, 'session.db');
  if (cmd === 'prepare') {
    const { buildTemplate, fileOpening, proveDeliverables } = await import('../bench/planningReliability/world.ts');
    const t = await buildTemplate(path.join(dir, '.template'));
    fs.copyFileSync(t.file, db);
    await initDatabase({ dbPath: db });
    await proveDeliverables();
    const { getCashMode } = await import('../server/repos/cashMode.ts');
    const { createGoal } = await import('../server/services/goals/decide.ts');
    const now = new Date();
    const cashModeId = (await getCashMode(t.projectId))!.id;
    const keys: Record<string, string> = {};
    for (const f of c.openings) keys[await fileOpening(f, t, cashModeId, now)] = f.key;
    const created = await createGoal({ projectId: t.projectId, objective: c.objective, actorRef: `person:${t.userId}`, userId: t.userId, now: new Date(now.getTime() - 60_000) });
    if (!created.ok) throw new Error(`the objective did not make a goal: ${created.reason}`);
    const meta: WorldMeta = { projectId: t.projectId, userId: t.userId, goalId: created.goal.id, caseId: c.id, keys };
    // The session's own world.json (scripts/planningSession.ts reads projectId and userId); the keys stay with the grader.
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ projectId: t.projectId, userId: t.userId, goalId: created.goal.id }, null, 2));
    fs.writeFileSync(`${dir.replace(/\/$/, '')}.grader.json`, JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'OBJECTIVE.txt'), `${c.objective}\n`);
    fs.rmSync(path.join(dir, '.template'), { recursive: true, force: true });
    await closeDatabase({ drainMs: 200 });
    out({ ok: true, goalId: created.goal.id });
    return;
  }
  const meta = JSON.parse(fs.readFileSync(`${dir.replace(/\/$/, '')}.grader.json`, 'utf8')) as WorldMeta;
  await initDatabase({ dbPath: db });
  try {
    const { changeSteps, caseAtStep } = await import('../bench/planningReliability/case.ts');
    if (cmd === 'change') {
      const k = Number(need('step'));
      const step = changeSteps(c)[k - 1];
      if (!step) throw new Error(`case ${c.id} has no change ${k}`);
      const { applyChange } = await import('../bench/planningReliability/world.ts');
      const ids = Object.fromEntries(Object.entries(meta.keys).map(([id, key]) => [key, id]));
      await applyChange(step.change, { goalId: meta.goalId, projectId: meta.projectId, userId: meta.userId, idOf: (key) => ids[key]!, step: k, now: new Date() });
      if (step.change.kind === 'OBJECTIVE') fs.writeFileSync(path.join(dir, 'OBJECTIVE.txt'), `${step.change.objective}\n`);
      out({ ok: true, applied: step.change.kind });
      return;
    }
    if (cmd === 'grade') {
      const k = Number(flag('step') ?? '0');
      // A case with changes is graded per reading against that step's rubric (as `gradeAdaptation` does); a step with none is ungraded.
      const graded = changeSteps(c).length ? caseAtStep(c, k) : c;
      if (!graded) {
        out({ id: c.id, step: k, heldOut: !!c.heldOut, ungraded: true, detail: 'this step carries no rubric' });
        return;
      }
      const { planningState, PLANNING_EVENTS } = await import('../server/services/planning/sessionPlanning.ts');
      const { workstreamEventsOfKind } = await import('../server/repos/register.ts');
      const { observeSession } = await import('../bench/planningReliability/session.ts');
      const { grade, CRITICAL } = await import('../bench/planningReliability/grade.ts');
      const state = await planningState(meta.goalId);
      const keyOf = (id: string) => meta.keys[id] ?? id;
      const base = { id: c.id, step: k, heldOut: !!c.heldOut, expect: graded.expect.verdict };
      // The benchmark grades the result of the whole process: the plan published after Brain's checks and an
      // independent review of that exact revision. A case that published nothing delivered no plan.
      const reviews = state.reviews.length;
      const revisionsN = state.revisions.length;
      if (!state.final) {
        out({ ...base, published: false, revisions: revisionsN, reviews, observed: null, pass: false, failures: ['NOT_PUBLISHED'], critical: [], detail: state.current ? `nothing published; current revision ${state.current.revisionId} (${state.current.stance}) ${state.currentCheck?.problems.length ?? '?'} problem(s), last review ${state.reviews.at(-1)?.verdict ?? 'none'}` : 'the session submitted no revision', usable: { pass: false, detail: 'nothing published' }, e2e: { pass: false, failures: ['NOT_OBSERVED'], gaps: [], detail: 'nothing published' } });
        return;
      }
      const published = state.final.plan;
      const run = (await workstreamEventsOfKind(meta.goalId, PLANNING_EVENTS.brain, '1970-01-01T00:00:00.000Z', 1))[0]?.detail['summary'] as never;
      const o = observeSession(published, run ?? { scope: null, openings: [], excluded: [] }, keyOf);
      const g = grade(graded, o);
      out({
        ...base,
        published: true,
        revisions: revisionsN,
        reviews,
        reviewVerdicts: state.reviews.map((r) => r.verdict),
        revisionId: published.revisionId,
        stance: published.stance,
        reviewer: state.final.review.reviewer,
        observed: o.stance,
        pass: g.pass,
        outcome: g.outcome,
        failures: g.failures,
        critical: g.failures.filter((f) => CRITICAL.has(f)),
        detail: g.detail,
        e2e: g.e2e,
        usable: g.usable,
      });
      return;
    }
    throw new Error(`unknown command ${cmd}`);
  } finally {
    await closeDatabase({ drainMs: 200 });
  }
}

main().then(() => process.exit(0), (err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
