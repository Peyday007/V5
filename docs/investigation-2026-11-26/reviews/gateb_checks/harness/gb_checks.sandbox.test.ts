/**
 * GATE B independent checks (no network, no model, sandbox DB from the repository's own test helpers).
 * GB-S: sensitivity controls for E-015's readStream fault injections (is the erasure specific to "content arrived"?).
 * GB-G: what E-013's readObjective misses become at goal creation (createGoal with interpreter null = reader alone).
 * Writes reviews/gateb_checks/raw/gb_checks.json. Observes; does not judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { freshProject } from '../../../../../tests/helpers.ts';
import { getDb } from '../../../../../server/db/database.ts';
import { createUser } from '../../../../../server/repos/identity.ts';
import { activate } from '../../../../../server/services/cash/lifecycle.ts';
import { createGoal } from '../../../../../server/services/goals/decide.ts';
import { chatFor } from '../../../../../server/services/cheap/modelBench.ts';
import { askModel } from '../../../../../server/services/goals/routeProposal.ts';

const OUT = path.resolve(import.meta.dirname, '../raw/gb_checks.json');
const out: Record<string, unknown> = {};
const ep = { label: 'fake', url: 'http://fake.invalid/v1', key: 'k', model: 'm', usdPerHour: null };
const sse = (events: (object | string)[], throwAfter = false) => {
  const enc = new TextEncoder();
  const chunks = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]!)); else if (throwAfter) c.error(new Error('socket hang up (connection reset)')); else c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const d = (content: string | null, extra: object = {}) => ({ choices: [{ delta: { content, ...extra } }] });
const run = async (mk: () => Response) => {
  const chat = chatFor(ep, (async () => mk()) as unknown as typeof fetch, 5000);
  const r = await chat([{ role: 'user', content: 'x' }], undefined, 4000);
  return { content: r.content.slice(0, 60), error: r.error, completionTokens: r.completionTokens };
};

describe('GB-S readStream sensitivity controls', () => {
  it('error preserved when no content arrived; erased when content arrived; clean stream with [DONE]', async () => {
    out['S1_errorEvent_noContent'] = await run(() => sse([{ error: { message: 'upstream overloaded' } }]));
    out['S2_errorEvent_afterContent'] = await run(() => sse([d('{"routes":['), { error: { message: 'upstream overloaded' } }]));
    out['S3_reset_noContent'] = await run(() => sse([d('')], true));
    out['S4_reset_afterContent'] = await run(() => sse([d('{"routes":[')], true));
    out['S5_clean_withDone'] = await run(() => sse([d('{"routes":[]}'), { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 7 } }, '[DONE]']));
    // vLLM-style gpt-oss length stop during reasoning: reasoning deltas only, finish_reason length, usage = max_tokens.
    out['S6_reasoningOnly_lengthStop'] = await run(() => sse([d(null, { reasoning_content: 'analysis...' }), { choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 4000 } }, '[DONE]']));
    // askModel on S6: what the record keeps of an H1b-shaped reply (does completionTokens=4000 survive?)
    const chat = chatFor(ep, (async () => sse([d(null, { reasoning_content: 'analysis...' }), { choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 4000 } }, '[DONE]'])) as unknown as typeof fetch, 5000);
    const a = await askModel(chat, 's', 'u', 4000);
    out['S7_askModel_on_S6'] = { content: a.content, error: a.error ?? null, keys: Object.keys(a) };
  });
});

const PHRASES = [
  "I can only spare a couple of evenings a week. I'd like to make $1,500 by the end of January with no more than two grand.",
  "Help me earn ten thousand bucks in the next three months; I won't do any selling myself and I've got $3k to put in.",
  'I need 2k fast, within a fortnight. Zero budget. Maybe 6 hrs a week.',
  'Target: $750/mo recurring by March 1st. Max spend $250. I work full time so maybe 5 hours weekly.',
  'Looking to net $600 this weekend. I have no money but plenty of time.',
  'Can you get me to $12k in revenue over the next 6 weeks? Budget is capped at $4k. Ten hours a week tops.',
  "I want $3,000 in 45 days. I'm not putting a cent in.",
  "Half a grand in ten days, no upfront money, I'm free weekends only.",
  "I want twenty-five hundred dollars by New Year's Eve with a $300 budget.",
  "I can't spend more than $1k and can't work more than 8 hours total; goal is $2,000 in 3 weeks.",
];

describe('GB-G createGoal on E-013 paraphrases (reader alone)', () => {
  it('records ok/reason/target per phrase', async () => {
    const rows: unknown[] = [];
    for (const objective of PHRASES) {
      const fixture = await freshProject();
      const projectId = fixture.project.id;
      await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`gb-${projectId.slice(-6)}`, projectId]);
      const owner = await createUser({ email: `gb-${projectId.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
      const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
      if (!started.ok) throw new Error('could not activate');
      const g = await createGoal({ projectId, objective, actorRef: 'gateb', userId: owner.id, interpreter: null, now: new Date('2026-11-26T06:00:00Z') });
      const gg = g as any;
      rows.push({ objective, ok: g.ok, reason: gg.reason ?? null, dueAt: gg.goal?.dueAt ?? null, target: gg.goal?.target ?? null, readingKind: gg.reading?.kind ?? null });
    }
    out['G_createGoal'] = rows;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  });
});
