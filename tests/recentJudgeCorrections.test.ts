/**
 * A first synthesis is told what independent judges in its project recently
 * corrected (§80): counted, most frequent first, PATCH only, this project only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import {
  RECENT_CORRECTIONS_LIMIT,
  recentJudgeCorrections,
  resetRecentCorrections,
} from '../server/services/research/judgeRound.ts';

let projectId = '';
let n = 0;

async function gap(project: string, classification: string, title: string, at = new Date().toISOString()): Promise<void> {
  n += 1;
  const audit = `aud_t${n}`;
  await getDb().run(
    `INSERT INTO audits (id, project_id, verdict, created_at) VALUES (?, ?, 'PATCH', ?)`,
    [audit, project, at],
  );
  await getDb().run(
    `INSERT INTO audit_gaps (id, audit_id, ordinal, classification, title, created_at) VALUES (?, ?, 0, ?, ?, ?)`,
    [`gap_t${n}`, audit, classification, title, at],
  );
}

beforeEach(async () => {
  resetRecentCorrections();
  projectId = (await freshProject()).project.id;
});

describe('recent judge corrections', () => {
  it('is null when no judge has corrected anything', async () => {
    expect(await recentJudgeCorrections(projectId)).toBeNull();
  });

  it('counts PATCH corrections in this project, most frequent first', async () => {
    await gap(projectId, 'PATCH', 'Summary overclaims verification status');
    await gap(projectId, 'PATCH', 'summary  overclaims verification status');
    await gap(projectId, 'PATCH', 'Dated figure presented as current');
    await gap(projectId, 'TARGETED_RESEARCH_GAP', 'Not a correction');
    await gap(projectId, 'PATCH', 'Too old', new Date(Date.now() - 30 * 86_400_000).toISOString());
    const other = await createProject({ name: 'Elsewhere', slug: 'elsewhere' });
    await gap(other.id, 'PATCH', 'Another project');

    const reading = (await recentJudgeCorrections(projectId))!;
    expect(reading.sample).toBe(3);
    expect(reading.corrections.map((one) => one.times)).toEqual([2, 1]);
    expect(reading.corrections[0]!.title).toMatch(/overclaims verification/i);
    expect(reading.corrections.some((one) => /Another project|Not a correction|Too old/.test(one.title))).toBe(false);
    expect(reading.instruction).toMatch(/judge still decides/);
  });

  it('hands over at most the limit', async () => {
    for (let i = 0; i < RECENT_CORRECTIONS_LIMIT + 3; i += 1) await gap(projectId, 'PATCH', `Correction ${i}`);
    expect((await recentJudgeCorrections(projectId))!.corrections).toHaveLength(RECENT_CORRECTIONS_LIMIT);
  });
});
