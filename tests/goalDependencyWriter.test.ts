/**
 * Declaring a goal dependency has one writer and one cycle rule (§46, §50).
 * The route and the terminal both call `setDependency`; neither writes a
 * DEPENDS_ON link itself.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, listLinks, listWorkstreamEvents } from '../server/repos/register.ts';
import { createUser } from '../server/repos/identity.ts';
import { setDependency } from '../server/services/goals/decide.ts';

let projectId = '';
let by = { actorRef: 'person:test', userId: '' };

async function goal(title: string) {
  return createWorkstream({ projectId, title, intent: `Intent of ${title}.`, purpose: 'CAPABILITY', createdByUserId: null });
}

async function writes(): Promise<{ links: number; events: number }> {
  const links = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM workstream_links WHERE relation = 'DEPENDS_ON'`);
  const events = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM workstream_events WHERE kind = 'GOAL_DEPENDENCY_SET'`);
  return { links: Number(links?.n ?? 0), events: Number(events?.n ?? 0) };
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const user = await createUser({ email: `dep-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
  by = { actorRef: `person:${user.id}`, userId: user.id };
});

describe('setDependency', () => {
  it('refuses a self-reference and a three-goal cycle, writing nothing', async () => {
    const a = await goal('A');
    const b = await goal('B');
    const c = await goal('C');
    expect((await setDependency(a.id, a.id, by)).ok).toBe(false);
    expect((await setDependency(a.id, b.id, by)).ok).toBe(true);
    expect((await setDependency(b.id, c.id, by)).ok).toBe(true);
    const before = await writes();
    const refused = await setDependency(c.id, a.id, by);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('That would make the two goals wait on each other for ever.');
    expect(await writes()).toEqual(before);
  });

  it('writes one labelled live link and one event carrying dependsOn and linkId', async () => {
    const a = await goal('A');
    const b = await goal('Wait for me');
    const made = await setDependency(a.id, b.id, by);
    expect(made.ok).toBe(true);
    const links = (await listLinks(a.id)).filter((one) => one.relation === 'DEPENDS_ON');
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('WORKSTREAM');
    expect(links[0]!.ref).toBe(b.id);
    expect(links[0]!.label).toBe('Wait for me');
    const events = (await listWorkstreamEvents(a.id)).filter((one) => one.kind === 'GOAL_DEPENDENCY_SET');
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ dependsOn: b.id, linkId: links[0]!.id });
  });
});

describe('the two doors share the writer', () => {
  const cli = readFileSync('scripts/goals.ts', 'utf8');
  const route = readFileSync('server/routes/goals.ts', 'utf8');

  it('both call setDependency and neither links DEPENDS_ON directly', () => {
    for (const source of [cli, route]) {
      expect(source).toContain('setDependency(');
      expect(source).not.toMatch(/relation:\s*'DEPENDS_ON'/);
    }
  });

  it('the terminal accepts objective and undepend', () => {
    expect(cli).toContain("case 'objective'");
    expect(cli).toContain("case 'undepend'");
    expect(cli).toContain('supersedeLink(');
    expect(cli).toContain("kind: 'LINK_SUPERSEDED'");
    expect(cli).toContain('undepend needs --reason');
  });
});
