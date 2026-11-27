/**
 * The app-session planning adapter on a terminal: the same service the MCP tools call
 * (server/services/planning/sessionPlanning.ts), for a session that already has repository
 * command access. Every call is one process on one database file, so the state a later call
 * reads is the state the earlier call saved — never memory.
 *
 *   npx tsx scripts/planningSession.ts init --world DIR
 *   npx tsx scripts/planningSession.ts goal --world DIR --objective "…owner's words…"
 *   npx tsx scripts/planningSession.ts <contract|routes|research|verify-research|revise|review> --world DIR --goal G --file payload.json --session S [--model M]
 *   npx tsx scripts/planningSession.ts <context|brain|state> --world DIR --goal G [--session S]
 *   npx tsx scripts/planningSession.ts finalize --world DIR --goal G --revision R --session S
 *
 * `init` builds an isolated world: a migrated database with one project in Cash Mode and Brain's
 * deliverables proved (the planning-reliability bench's own template). Nothing here touches
 * production, spends, or contacts anyone.
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

async function open(world: string): Promise<{ projectId: string; userId: string }> {
  const meta = JSON.parse(fs.readFileSync(path.join(world, 'world.json'), 'utf8')) as { projectId: string; userId: string };
  const { initDatabase } = await import('../server/db/database.ts');
  await initDatabase({ dbPath: path.join(world, 'session.db') });
  return meta;
}

async function main(): Promise<void> {
  const world = need('world');
  if (cmd === 'init') {
    const { buildTemplate, proveDeliverables } = await import('../bench/planningReliability/world.ts');
    const t = await buildTemplate(world);
    fs.copyFileSync(t.file, path.join(world, 'session.db'));
    const { initDatabase, closeDatabase } = await import('../server/db/database.ts');
    await initDatabase({ dbPath: path.join(world, 'session.db') });
    await proveDeliverables();
    await closeDatabase({ drainMs: 200 });
    fs.writeFileSync(path.join(world, 'world.json'), JSON.stringify({ projectId: t.projectId, userId: t.userId }, null, 2));
    out({ ok: true, world, projectId: t.projectId, userId: t.userId });
    return;
  }
  const meta = await open(world);
  const svc = await import('../server/services/planning/sessionPlanning.ts');
  const actor = () => ({ kind: 'APP_SESSION' as const, id: need('session'), model: flag('model') });
  const payload = () => JSON.parse(fs.readFileSync(need('file'), 'utf8')) as Record<string, unknown>;
  try {
    switch (cmd) {
      case 'goal': {
        const { createGoal } = await import('../server/services/goals/decide.ts');
        const r = await createGoal({ projectId: meta.projectId, objective: need('objective'), actorRef: `person:${meta.userId}`, userId: meta.userId });
        out(r.ok ? { ok: true, goalId: r.goal.id, title: r.goal.title, target: r.target, reading: r.reading } : { ok: false, reason: r.reason, reading: r.reading });
        break;
      }
      case 'contract': {
        const p = payload();
        out(await svc.establishContract({ goalId: need('goal'), words: String(p['words']), source: p['source'] as never, terms: p['terms'] as never, explanations: (p['explanations'] ?? {}) as never, actor: actor() }));
        break;
      }
      case 'context':
        out(await svc.planningContext(need('goal')));
        break;
      case 'routes':
        out(await svc.admitRoutes({ goalId: need('goal'), routes: (payload()['routes'] as unknown[]) ?? [], actor: actor() }));
        break;
      case 'brain':
        out(await svc.runBrain({ goalId: need('goal'), actor: actor() }));
        break;
      case 'research': {
        const p = payload();
        out(await svc.answerResearch({ goalId: need('goal'), needId: String(p['needId']), actor: actor(), method: String(p['method'] ?? ''), claims: (p['claims'] as never) ?? [], unanswered: p['unanswered'] === true }));
        break;
      }
      case 'verify-research': {
        const p = payload();
        out(await svc.verifyResearch({ goalId: need('goal'), needId: String(p['needId']), verifier: actor(), verdicts: (p['verdicts'] as never) ?? [], sufficiency: p['sufficiency'] === 'SUFFICIENT' ? 'SUFFICIENT' : 'INSUFFICIENT' }));
        break;
      }
      case 'revise':
        out(await svc.submitRevision({ revision: { ...payload(), goalId: need('goal') } as never, actor: actor() }));
        break;
      case 'review': {
        const p = payload();
        out(await svc.recordReview({ goalId: need('goal'), revisionId: String(p['revisionId']), reviewer: p['reviewer'] as never, verdict: p['verdict'] as never, reasons: String(p['reasons'] ?? ''), findings: (p['findings'] as string[]) ?? [], resolution: (p['resolution'] as string | null) ?? null }));
        break;
      }
      case 'finalize':
        out(await svc.finalizePlan({ goalId: need('goal'), revisionId: need('revision'), actor: actor() }));
        break;
      case 'state':
        out(await svc.planningState(need('goal')));
        break;
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  } catch (err) {
    if (err instanceof svc.PlanningRefusal) out({ ok: false, refused: true, reason: err.message, scope: err.scope });
    else throw err;
  } finally {
    const { closeDatabase } = await import('../server/db/database.ts');
    await closeDatabase({ drainMs: 200 });
  }
}

main().then(() => process.exit(0), (err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
