/**
 * Runs one mootRequests scenario against the code under test, on a database of its own.
 *
 * What the harness owns and what the variant owns, because a variant is code an agent wrote:
 *
 *   * The steps go through the variant's own exported operations (`askHuman`,
 *     `answerHumanRequest`, `transitionMission`, `reopenRequest`, the loop's `tick`), so a
 *     variant that changes how a mission leaves NEEDS_HUMAN, or how the loop settles an
 *     answer, is measured doing it.
 *   * The end state is read by the harness itself, in plain SQL over the rows, never through a
 *     variant's reader — a variant cannot report a card withdrawn that is still open. A row
 *     that vanished is history destroyed (invariant 5) and fails its case.
 *   * Whether a card is moot is the harness's own predicate, the operator's definition
 *     (domain/operator.ts `moot`) restated here: a card about a mission that is in any state
 *     but NEEDS_HUMAN.
 *
 * Every scenario opens a copy of one migrated, seeded template database, so scenarios cannot
 * see each other's rows and migrations run once per suite, not once per case.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MootCase, Step } from './case.ts';

/** Prefixes of resume keys whose cards are not about a research mission (domain/operator.ts). */
const NOT_ABOUT_A_MISSION = ['capability-authority:', 'cash-reconsider:'];

export interface Template {
  file: string;
  projectId: string;
  layerId: string;
  userId: string;
}

export interface ScenarioOutcome {
  /** Each named request's end state as the rows read it: OPEN, ANSWERED, RESUMED, WITHDRAWN, or GONE. */
  states: Record<string, string>;
  /** Cards left OPEN about a mission no longer at NEEDS_HUMAN (the defect, counted). */
  mootOpen: number;
  /** Answers left ANSWERED about a mission no longer at NEEDS_HUMAN: invisible, and never to apply. */
  mootAnswered: number;
}

async function freshDatabase(file: string): Promise<void> {
  const { closeDatabase, initDatabase } = await import('../../server/db/database.ts');
  await closeDatabase({ drainMs: 200 });
  const { resetStallLog } = await import('../../server/db/infra.ts');
  const { resetPressure } = await import('../../server/db/pressure.ts');
  resetStallLog();
  resetPressure();
  await initDatabase({ dbPath: file });
}

/** Migrate and seed one database the scenarios copy. */
export async function buildTemplate(dir: string): Promise<Template> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'template.db');
  await freshDatabase(file);
  const { seedDealDispatch } = await import('../../server/seed.ts');
  const { createUser } = await import('../../server/repos/identity.ts');
  const { project, layers } = await seedDealDispatch();
  const layer = layers.find((l) => l.name === 'World Model') ?? layers[0];
  if (!layer) throw new Error('the seeded project has no layer');
  const user = await createUser({ email: 'bench-person@example.test', displayName: 'Bench person', password: 'correct horse battery staple' });
  const { closeDatabase } = await import('../../server/db/database.ts');
  await closeDatabase({ drainMs: 200 });
  return { file, projectId: project.id, layerId: layer.id, userId: user.id };
}

export async function closeScenarioDatabase(): Promise<void> {
  const { closeDatabase } = await import('../../server/db/database.ts');
  await closeDatabase({ drainMs: 200 });
}

export async function runScenario(c: MootCase, template: Template, dir: string, index: number): Promise<ScenarioOutcome> {
  const file = path.join(dir, `case-${index}.db`);
  fs.copyFileSync(template.file, file);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  await freshDatabase(file);

  const { getDb } = await import('../../server/db/database.ts');
  const { newId, nowIso } = await import('../../server/repos/util.ts');
  const { createRun } = await import('../../server/repos/runs.ts');
  const { createFragments, createOrchestration } = await import('../../server/repos/research.ts');
  const { createGoal } = await import('../../server/repos/russellAuthority.ts');
  const missions = await import('../../server/repos/russellMissions.ts');
  const { NEEDS_HUMAN_CHOICES } = await import('../../server/services/russell/needsHuman.ts');
  const { tick } = await import('../../server/services/russell/loop.ts');
  const db = getDb();

  const missionIds = new Map<string, string>();
  const requestIds = new Map<string, string>();
  const offered = [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP];

  const step = async (s: Step): Promise<void> => {
    switch (s.do) {
      case 'park': {
        const run = await createRun({ projectId: template.projectId, layerId: template.layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'bench' });
        const orchestration = await createOrchestration({
          projectId: template.projectId, layerId: template.layerId, runId: run.id, title: `Bench packet ${s.mission}`,
          assignment: 'what the packet asks', provider: 'WORKER', autoApprove: false,
        });
        await createFragments([
          {
            orchestrationId: orchestration.id, projectId: template.projectId, layerId: template.layerId, geography: 'United States',
            requiredEvidence: [{ id: 'published_price', description: 'a price', necessity: 'REQUIRED' }],
            acceptableSourceTypes: ['the platform itself'], excludedSourceTypes: ['a blog about it'], completionCriteria: ['one dated price'],
            minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'prices', question: 'What does each platform publish?',
            dependsOn: [], attempt: 1, status: 'PLANNED',
          },
        ] as unknown as Parameters<typeof createFragments>[0]);
        if (s.packet === 'AWAITING_APPROVAL') {
          await db.run(`UPDATE research_orchestrations SET status = 'AWAITING_APPROVAL' WHERE id = ?`, [orchestration.id]);
        }
        const id = newId('rms');
        const at = nowIso();
        await db.run(
          `INSERT INTO russell_missions (id, project_id, layer_id, visibility, objective, why_now, state, waiting_on,
             orchestration_id, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'SHARED', ?, ?, 'NEEDS_HUMAN', ?, ?, ?, ?, ?)`,
          [id, template.projectId, template.layerId, 'Settle the question.', 'It is open.', 'a person to authorize the plan', orchestration.id, `bench-${id}`, at, at],
        );
        missionIds.set(s.mission, id);
        return;
      }
      case 'ask': {
        const missionId = s.mission === null ? null : missionIds.get(s.mission)!;
        const { request } = await missions.askHuman({
          projectId: template.projectId,
          visibility: 'SHARED',
          missionId,
          authorityNeeded: 'Authorize the plan.',
          whyNotRussell: 'Only a person can authorize research.',
          choices: offered,
          resumeKey: s.resumeKey ?? `bench:${c.id}:${s.request}`,
        });
        requestIds.set(s.request, request.id);
        return;
      }
      case 'answer': {
        const requestId = requestIds.get(s.request)!;
        const known = offered.some((o) => o.key === s.choice);
        const answered = await missions.answerHumanRequest({ requestId, actorUserId: template.userId, choice: known ? s.choice : NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key });
        if (!answered.ok) throw new Error(`answer refused: ${answered.reason}`);
        // A choice this Brain does not offer can only be an older version's card: written as it stands.
        if (!known) await db.run(`UPDATE russell_human_requests SET answered_choice = ? WHERE id = ?`, [s.choice, requestId]);
        return;
      }
      case 'move': {
        const missionId = missionIds.get(s.mission)!;
        const row = await db.get<{ state: string }>(`SELECT state FROM russell_missions WHERE id = ?`, [missionId]);
        if (!row) throw new Error(`mission ${s.mission} is gone`);
        if (row.state === s.to) return;
        const waits = s.to === 'WAITING' || s.to === 'NEEDS_HUMAN';
        const moved = await missions.transitionMission({
          missionId,
          from: row.state as never,
          to: s.to,
          ...(waits ? { waitingOn: 'a person to authorize the plan' } : {}),
          ...(s.to === 'DONE' || s.to === 'FAILED' || s.to === 'CANCELLED' ? { terminalReason: `bench: moved to ${s.to}` } : {}),
        });
        if (!moved) throw new Error(`mission ${s.mission} did not move ${row.state} -> ${s.to}`);
        return;
      }
      case 'reopen': {
        const requestId = requestIds.get(s.request)!;
        const request = await missions.getHumanRequest(requestId);
        if (!request) throw new Error(`request ${s.request} is gone`);
        await missions.reopenRequest({
          requestId,
          choices: request.choices,
          recommendation: s.recommendation ?? 'the mission moved out of Needs You before the answer could be applied',
        });
        return;
      }
      case 'slotFull': {
        const missionId = missionIds.get(s.mission)!;
        const goal = await createGoal({
          projectId: template.projectId, ownerUserId: template.userId, createdByUserId: template.userId, name: `One slot ${s.mission}`,
          allowedWork: ['RESEARCH'], maxMissions: 5, maxFragments: 20, maxConcurrent: 1, maxProbes: 5,
        });
        const past = new Date(Date.now() - 3_600_000).toISOString();
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const lapsed = newId('rsv');
        for (const [id, expires] of [[newId('rsv'), future], [lapsed, past]] as const) {
          await db.run(
            `INSERT INTO russell_budget_reservations (id, goal_id, kind, amount, idempotency_key, state, expires_at, created_at)
             VALUES (?, ?, 'MISSION', 1, ?, 'HELD', ?, ?)`,
            [id, goal.id, `bench-slot-${id}`, expires, nowIso()],
          );
        }
        await db.run(`UPDATE russell_missions SET reservation_id = ? WHERE id = ?`, [lapsed, missionId]);
        return;
      }
      case 'tick':
        await tick(`bench-${c.id}`.slice(0, 60));
        return;
    }
  };

  for (const s of c.steps) await step(s);

  // The harness's own reading of the rows.
  const states: Record<string, string> = {};
  let mootOpen = 0;
  let mootAnswered = 0;
  for (const [name, id] of requestIds) {
    const row = await db.get<{ state: string; resume_key: string; mission_state: string | null; mission_id: string | null }>(
      `SELECT r.state, r.resume_key, r.mission_id, m.state AS mission_state
         FROM russell_human_requests r LEFT JOIN russell_missions m ON m.id = r.mission_id
        WHERE r.id = ?`,
      [id],
    );
    states[name] = row?.state ?? 'GONE';
    if (!row || !row.mission_id || NOT_ABOUT_A_MISSION.some((p) => row.resume_key.startsWith(p))) continue;
    const moot = row.mission_state === null || row.mission_state !== 'NEEDS_HUMAN';
    if (moot && row.state === 'OPEN') mootOpen += 1;
    if (moot && row.state === 'ANSWERED') mootAnswered += 1;
  }
  return { states, mootOpen, mootAnswered };
}
