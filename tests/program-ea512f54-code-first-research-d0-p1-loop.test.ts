/**
 * ALGO-19-4 Derive/Act/Codify (repair R3-F2): the feed loop derives
 * missing-link questions from its ranked constructions, the shortlist that runs
 * on the same tick puts them to research, and what the loop's code could not
 * read becomes a parser proposal in the improvement loop. Every construction
 * and every question stays a hypothesis until a quoted source answers it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createUser } from '../server/repos/identity.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { constructFromGraph, missingLinkQuestions } from '../server/services/cash/construct.ts';
import { EventGraph, resetEventGraph, type GraphFact } from '../server/services/industry/eventGraph.ts';
import {
  LOOP_QUESTIONS_ASKED_EVENT,
  openFeedShortlist,
  PARSER_PROPOSAL_MIN,
  pendingLoopQuestions,
  proposeParsersForUnreadable,
  unreadableSourceKey,
  unreadableSourceWeakness,
} from '../server/services/feeds/run.ts';
import { FEED_LOOP_EVENT, runFeedLoopCycle } from '../server/services/russell/loop.ts';

let seq = 0;
function fact(over: Partial<GraphFact> & Pick<GraphFact, 'kind' | 'subject'>): GraphFact {
  seq += 1;
  const id = over.id ?? `q${String(seq).padStart(3, '0')}`;
  return {
    id,
    basis: 'STATED_REQUEST',
    actor: { key: `actor-${id}`, name: null, role: over.kind === 'WANT' ? 'BUYER' : 'SUPPLIER' },
    region: 'lancaster pa',
    quantity: null,
    unit: null,
    priceCents: null,
    currency: null,
    side: null,
    statedCostCents: null,
    window: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' },
    channel: null,
    rights: [],
    evidence: [{ rawId: `raw-${id}`, source: 'test-feed', url: `https://feed.test/${id}`, observedAt: '2026-11-10T00:00:00.000Z' }],
    ...over,
  };
}

describe('derive: the ranking implies missing-link questions', () => {
  it('one gap shared by several mechanisms is one question, ranked by everything it would move', () => {
    const graph = new EventGraph();
    for (const f of [fact({ kind: 'WANT', subject: 'Barn roofing' }), fact({ kind: 'OFFER', subject: 'Barn roofing' })]) graph.add(f);
    const result = constructFromGraph(graph.hypotheses(), { capitalCeilingCents: null, delivers: [] });
    expect(result.kept.length).toBeGreaterThan(1);
    const questions = missingLinkQuestions(result);
    expect(questions.length).toBeGreaterThan(0);
    // Every condition a kept construction carries is asked, once per neighborhood.
    const conditions = new Set(result.kept.flatMap((k) => k.missingConditions));
    expect(new Set(questions.map((q) => q.condition))).toEqual(conditions);
    expect(new Set(questions.map((q) => q.key)).size).toBe(questions.length);
    const shared = questions.find((q) => q.condition.startsWith('a detection is not a verified opportunity'))!;
    expect(shared.structures.length).toBe(result.kept.length);
    const commission = questions.find((q) => q.condition === 'the commission share the supplier would pay is not established')!;
    expect(commission.structures).toEqual(['BROKER']);
    // A gap in front of more designs ranks higher; the ranking is deterministic.
    expect(questions.indexOf(shared)).toBeLessThan(questions.indexOf(commission));
    expect(missingLinkQuestions({ kept: [...result.kept].reverse() })).toEqual(questions);
    // Research starts where the graph did, and the question never asserts the answer.
    expect(shared.evidenceUrls.length).toBeGreaterThan(0);
    for (const q of questions) expect(q.question).toMatch(/nobody has established this yet/);
  });

  it('a pruned design asks nothing: its hard constraint failed', () => {
    const graph = new EventGraph();
    graph.add(fact({ kind: 'WANT', subject: 'Hay delivery' }));
    graph.add(fact({ kind: 'OFFER', subject: 'Hay delivery' }));
    const result = constructFromGraph(graph.hypotheses(), { capitalCeilingCents: 0, delivers: [] });
    const keys = new Set(missingLinkQuestions(result).flatMap((q) => q.constructionKeys));
    for (const p of result.pruned) expect(keys.has(p.key)).toBe(false);
  });
});

describe('act: what the loop derived reaches research on the same tick', () => {
  let projectId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    resetEventGraph();
  });

  it('runFeedLoopCycle records its questions and openFeedShortlist puts them to Claude, once', async () => {
    const owner = await createUser({ email: `loop-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const now = new Date();
    const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
    const due = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    await insertFeedItems('rfq-board', [
      {
        externalId: 'loop-rfq',
        url: 'https://board.test/loop-rfq',
        title: 'Request for quotes: gutter cleaning',
        body: `Seeking quotes from a supplier in Tulsa, OK by ${due}. Budget $300.`,
        organization: 'Maple HOA',
        publishedAt: hoursAgo(5),
      },
      {
        externalId: 'loop-ad',
        url: 'https://board.test/loop-ad',
        title: 'Gutter cleaning now booking',
        body: 'We offer gutter cleaning in Tulsa, OK for $150.',
        organization: 'Clear Gutters',
        publishedAt: hoursAgo(4),
      },
    ]);

    const cycle = await runFeedLoopCycle(projectId, { pulled: [], detectors: [], now });
    expect(cycle).not.toBeNull();
    expect(cycle!.derive).not.toBeNull();
    const questions = cycle!.derive!.questions;
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.some((q) => q.neighborhood === 'gutter cleaning')).toBe(true);
    const rows = await cashEventsOfKindInProject(projectId, FEED_LOOP_EVENT);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.detail as { derive: { questions: unknown[] } }).derive.questions).toHaveLength(questions.length);

    // The consumer reads the row, in the row's ranking.
    const pending = await pendingLoopQuestions(projectId, now);
    expect(pending.map((q) => q.key)).toEqual(questions.slice(0, pending.length).map((q) => q.key));

    // No screened lead exists, and the derived gaps still open a round.
    const roundId = await openFeedShortlist({ projectId, now });
    expect(roundId).not.toBeNull();
    const round = (await listRounds(projectId)).find((one) => one.id === roundId)!;
    const candidate = await getCandidate(round.candidateId!);
    for (const q of pending) expect(candidate!.statement).toContain(q.question);
    const asked = await cashEventsOfKindInProject(projectId, LOOP_QUESTIONS_ASKED_EVENT);
    expect(asked).toHaveLength(1);
    expect((asked[0]!.detail as { keys: string[]; roundId: string }).keys).toEqual(pending.map((q) => q.key));
    expect((asked[0]!.detail as { roundId: string }).roundId).toBe(roundId);

    // Asked once: the same gaps are not put to research again in the re-ask window.
    const left = await pendingLoopQuestions(projectId, now);
    for (const q of left) expect(pending.map((p) => p.key)).not.toContain(q.key);
    resetEventGraph();
  });
});

describe('codify: what code could not read becomes a parser proposal', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('below the threshold nothing is proposed; at it, one candidate per source', async () => {
    expect(unreadableSourceWeakness('odd-feed', PARSER_PROPOSAL_MIN - 1, 10, [])).toBeNull();
    const w = unreadableSourceWeakness('odd-feed', PARSER_PROPOSAL_MIN, 10, ['a', 'b'])!;
    expect(w.key).toBe(unreadableSourceKey('odd-feed'));
    expect(w.ownerComponent).toBe('server/services/feeds/extract.ts');

    const source = `odd-${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(
      source,
      Array.from({ length: PARSER_PROPOSAL_MIN }, (_, n) => ({
        externalId: `odd-${n}`,
        url: `https://odd.test/${n}`,
        title: `Untitled entry ${n}`,
        body: null,
        organization: null,
        publishedAt: new Date().toISOString(),
      })),
    );
    const ids = (await getDb().all<{ id: string }>(`SELECT id FROM feed_items WHERE source = ? ORDER BY id`, [source])).map((r) => r.id);
    expect(ids).toHaveLength(PARSER_PROPOSAL_MIN);
    const keys = await proposeParsersForUnreadable({ items: ids.length, needsModel: [ids] });
    expect(keys).toEqual([unreadableSourceKey(source)]);
    const row = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM improvement_candidates WHERE weakness_key = ?`, [unreadableSourceKey(source)]);
    expect(Number(row?.n)).toBe(1);
    // Idempotent: the same source refreshes its one candidate.
    await proposeParsersForUnreadable({ items: ids.length, needsModel: [ids] });
    const again = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM improvement_candidates WHERE weakness_key = ?`, [unreadableSourceKey(source)]);
    expect(Number(again?.n)).toBe(1);
  });
});
