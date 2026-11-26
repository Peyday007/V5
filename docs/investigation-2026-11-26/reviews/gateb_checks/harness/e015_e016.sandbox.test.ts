/**
 * E-015(b) and E-016: the REAL production ask chain (proposeGoalRoutes) on a sandbox SQLite database built with the
 * repository's own test helpers, with fake chat models. Writes observations to raw/E-015/chain.json and raw/E-016/lessons.json.
 * Assertions are kept minimal: this file observes and records, it does not judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import { freshProject, researchedFindings } from '../../../../../tests/helpers.ts';
import { getDb } from '../../../../../server/db/database.ts';
import { createUser } from '../../../../../server/repos/identity.ts';
import { activate } from '../../../../../server/services/cash/lifecycle.ts';
import { createGoal } from '../../../../../server/services/goals/decide.ts';
import { workstreamEventsOfKind } from '../../../../../server/repos/register.ts';
import { proposeGoalRoutes, ROUTE_EVENT, ROUTE_PROPOSAL_EVERY_MS, type RouteDeps } from '../../../../../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../../../../../server/services/cheap/modelBench.ts';

const EXP = path.resolve(import.meta.dirname, '..');
const probes = JSON.parse(fs.readFileSync(path.join(EXP, 'raw/E-010/probes.json'), 'utf8')) as any[];
const TRUNC = probes.find((c) => c.case === 'E-002_eval_p02_cap').replies[0].content as string;
const ROUTE = { title: 'Subcontracted podcast editing for agencies', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'Media', payer: 'Marketing agencies with podcasts', offer: 'Edited podcast episodes', price: 250, monthly: false, channel: 'Agency directory contact forms', performer: 'SUBCONTRACTOR', fulfiller: 'A freelance audio editor', directCost: 90, acquisitionCostPerSale: 20, capital: 100, ownerHoursPerDeal: 0.5, daysToFirstCash: 10, buyerCount: 5000, ownerFit: 'Subcontracted.' };
const ROUTE2 = { ...ROUTE, title: 'Bookkeeping catch-up for salons', payer: 'Hair salons', offer: 'Bookkeeping catch-up', price: 300, directCost: 120 };
const VALID = JSON.stringify({ owner: { skills: ['none stated'] }, rethink: 'LESSON-ALPHA: agencies buy editing by the episode, not by retainer.', routes: [ROUTE] });
// One complete route, then cut off inside the second (a truncated reply that still yields something).
const PARTIAL = `{"owner":{"skills":[]},"rethink":null,"routes":[${JSON.stringify(ROUTE2)},{"title":"Second route cut off","payer":"x","off`;

let goalId = '';
const now = new Date();
const obs: Record<string, unknown> = {};
const dump = (rel: string, data: unknown) => {
  fs.mkdirSync(path.dirname(path.join(EXP, rel)), { recursive: true });
  fs.writeFileSync(path.join(EXP, rel), JSON.stringify(data, null, 1));
};

beforeEach(async () => {
  const fixture = await freshProject();
  const projectId = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`inv-${projectId.slice(-6)}`, projectId]);
  const owner = await createUser({ email: `inv-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  const goal = await createGoal({ projectId, objective: 'Collect 3000 dollars of settled cash within 30 days using at most $500', actorRef: 'test', userId: owner.id, now: new Date(now.getTime() - 60_000) });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  goalId = goal.goal.id;
});

/** A model that answers proposals from a script and returns no critique (so the proposal stands), logging every turn. */
function model(label: string, replies: string[], log: unknown[]): { label: string; chat: ChatFn } {
  let n = 0;
  return {
    label,
    chat: async (messages, _tools, maxTokens) => {
      const role = /strategist/.test(String((messages[0] as { content: string }).content)) ? 'proposer' : 'critic';
      const user = String((messages[1] as { content: string }).content);
      const content = role === 'proposer' ? (replies[Math.min(n++, replies.length - 1)] ?? '') : '{"note":"no review"}';
      log.push({ label, role, maxTokens, replyChars: content.length, lessonsSection: /WHAT EARLIER ASKS FOR THIS GOAL LEARNED/.test(user), lessonAlpha: user.includes('LESSON-ALPHA') });
      return { content, toolCalls: [], ms: 1, completionTokens: 1, error: null };
    },
  };
}
const deps = (chats: { label: string; chat: ChatFn }[]): RouteDeps => ({ chats: async () => chats, claims: researchedFindings, delivers: async () => ['spreadsheet'], startDives: async () => [] });
const events = async () =>
  (await workstreamEventsOfKind(goalId, ROUTE_EVENT, '2000-01-01T00:00:00Z', 50)).map((e) => ({ at: e.createdAt, summary: e.summary, outcome: e.detail['outcome'], model: e.detail['model'], reason: e.detail['reason'] ?? null, detailKeys: Object.keys(e.detail), rethink: e.detail['rethink'] ?? null, critique: e.detail['critique'] ?? null }));

describe('E-015(b): truncated and empty replies in the real ask chain', () => {
  it('truncated-only primary, valid fallback', async () => {
    const log: unknown[] = [];
    const outcome = await proposeGoalRoutes({ goalId, now }, deps([model('primary', [TRUNC], log), model('fallback', [VALID], log)]));
    obs['truncPrimary_validFallback'] = { outcome: { kind: outcome.kind, model: (outcome as any).model, filed: (outcome as any).filed?.length, reason: (outcome as any).reason }, turns: log, events: await events() };
    expect(outcome.kind).toBeTruthy();
  });
  it('truncated reply from every model', async () => {
    const log: unknown[] = [];
    const outcome = await proposeGoalRoutes({ goalId, now }, deps([model('primary', [TRUNC], log), model('fallback', [TRUNC], log)]));
    obs['truncAll'] = { outcome: { kind: outcome.kind, reason: (outcome as any).reason }, turns: log, events: await events() };
  });
  it('truncated reply that completed one route', async () => {
    const log: unknown[] = [];
    const outcome = await proposeGoalRoutes({ goalId, now }, deps([model('primary', [PARTIAL], log), model('fallback', [VALID], log)]));
    obs['partialPrimary'] = { outcome: { kind: outcome.kind, model: (outcome as any).model, filed: (outcome as any).filed?.length }, turns: log, events: await events() };
  });
  it('empty twice from primary, fallback answers', async () => {
    const log: unknown[] = [];
    const outcome = await proposeGoalRoutes({ goalId, now }, deps([model('primary', ['', ''], log), model('fallback', [VALID], log)]));
    obs['emptyPrimary_validFallback'] = { outcome: { kind: outcome.kind, model: (outcome as any).model, filed: (outcome as any).filed?.length }, turns: log, events: await events() };
    dump('raw/E-015/chain.json', obs);
  });
});

describe('E-016: does a rethink written by one ask reach the next?', () => {
  it('second ask after the ordinary interval, and a third after a day', async () => {
    const log: unknown[] = [];
    const m = model('primary', [VALID, JSON.stringify({ rethink: null, routes: [ROUTE2] }), JSON.stringify({ rethink: null, routes: [{ ...ROUTE2, title: 'Third', payer: 'Gyms', offer: 'Gym bookkeeping' }] })], log);
    const first = await proposeGoalRoutes({ goalId, now }, deps([m]));
    const t2 = new Date(now.getTime() + ROUTE_PROPOSAL_EVERY_MS + 60_000);
    const second = await proposeGoalRoutes({ goalId, now: t2 }, deps([m]));
    const t3 = new Date(t2.getTime() + 25 * 3_600_000);
    const third = await proposeGoalRoutes({ goalId, now: t3 }, deps([m]));
    const learnings = await getDb().all<{ lesson: string }>('SELECT lesson FROM operator_learnings').catch((e: unknown) => [{ lesson: `query failed: ${String(e)}` }]);
    dump('raw/E-016/lessons.json', { outcomes: [first.kind, (second as any).reason ?? second.kind, (third as any).reason ?? third.kind], turns: log, events: await events(), operatorLearnings: learnings });
  });
});
