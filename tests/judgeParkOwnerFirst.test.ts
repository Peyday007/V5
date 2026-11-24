/**
 * The corrected-round pass takes the owner's directed goal's parked packets first.
 *
 * Production, 2026-11-24: the $10K goal's packet was parked on MORE_RESEARCH,
 * assessed RESUME, and waited behind ~90 older parks for one of ~10 live slots,
 * oldest first — while it was the critical path of the only goal the owner set.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { OWNER_DIRECTED_GOAL_IDS } from '../server/domain/binPurpose.ts';
import { judgeParkedPacketIds } from '../server/services/research/judgeRound.ts';

let t: TestProject;
beforeEach(async () => {
  t = await freshProject();
});

async function parked(label: string, updatedAt: string): Promise<string> {
  const layer = await t.layerByName('Discovery Logic');
  const run = await createRun({ projectId: t.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: label });
  const packet = await createOrchestration({ projectId: t.project.id, layerId: layer.id, runId: run.id, title: label, assignment: label, provider: 'WORKER', autoApprove: false });
  const audit = `aud_${packet.id}`;
  await getDb().run(`INSERT INTO audits (id, project_id, verdict, created_at) VALUES (?, ?, 'MORE_RESEARCH', ?)`, [audit, t.project.id, updatedAt]);
  await getDb().run(
    `UPDATE research_orchestrations SET status = 'NEEDS_HUMAN', verdict = 'MORE_RESEARCH', audit_id = ?, updated_at = ? WHERE id = ?`,
    [audit, updatedAt, packet.id],
  );
  return packet.id;
}

describe('judge-parked packets', () => {
  it('are taken oldest first, with the owner-directed goal’s packets ahead of every other', async () => {
    const goalId = OWNER_DIRECTED_GOAL_IDS[0]!;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [goalId, t.project.id, '$10K', 'Collect 10000 dollars', 'REVENUE_DIRECT', now, now],
    );
    const oldest = await parked('oldest', '2026-11-01T00:00:00.000Z');
    const older = await parked('older', '2026-11-02T00:00:00.000Z');
    const direct = await parked('goal, linked directly', '2026-11-24T00:00:00.000Z');
    const viaMission = await parked('goal, through a mission', '2026-11-23T00:00:00.000Z');
    expect(await judgeParkedPacketIds()).toEqual([oldest, older, viaMission, direct]);

    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at) VALUES ('wsl_p', ?, 'PACKET', ?, 'PURSUES', 'BRAIN', ?)`,
      [goalId, direct, now],
    );
    await getDb().run(
      `INSERT INTO russell_missions (id, project_id, objective, why_now, state, orchestration_id, idempotency_key, created_at, updated_at)
       VALUES ('rms_g', ?, 'who pays', 'the plan needs it', 'RUNNING', ?, 'key_g', ?, ?)`,
      [t.project.id, viaMission, now, now],
    );
    await getDb().run(
      `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at) VALUES ('wsl_m', ?, 'MISSION', 'rms_g', 'PURSUES', 'BRAIN', ?)`,
      [goalId, now],
    );
    expect(await judgeParkedPacketIds()).toEqual([viaMission, direct, oldest, older]);

    // A link the goal superseded no longer puts its packet first.
    await getDb().run("UPDATE workstream_links SET superseded_at = ?, superseded_reason = 'test' WHERE id = 'wsl_p'", [now]);
    expect(await judgeParkedPacketIds()).toEqual([viaMission, oldest, older, direct]);
  });
});
