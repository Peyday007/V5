/**
 * KNOW-25-1 on production rows: every deterministic-extraction pass records,
 * on its existing FEED_EXTRACTION row, the processing graph judged per source,
 * the delta against the previous pass's fingerprint index, identity resolution
 * with collisions, selective-deepening decisions and the intelligence funnel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { insertFeedItems, markShortlisted } from '../server/repos/feeds.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { getDb } from '../server/db/database.ts';
import { EXTRACTION_EVENT, LEAD_MAX_AGE_MS, recordFeedExtraction, routeEscalation, screenFeedLeads, screenOrder, SCREENS_PER_PASS, type ExtractionPass } from '../server/services/feeds/run.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';

let projectId = '';
let play: TestProject;
beforeEach(async () => {
  play = await freshProject();
  projectId = play.project.id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function records(source: string, tag: string) {
  return [
    {
      externalId: `${source}-rfq-${tag}`,
      url: `https://example.test/${source}/rfq`,
      title: 'Request for quotes: 500 kg of packaging film',
      body: 'Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget $4,000.',
      organization: 'Acme Foods LLC',
      publishedAt: hoursAgo(5),
    },
    {
      externalId: `${source}-ad-${tag}`,
      url: `https://example.test/${source}/ad`,
      title: 'Lawn care now booking',
      body: 'We offer weekly mowing in Portland, OR for $45.',
      organization: 'Acme Foods LLC',
      publishedAt: hoursAgo(4),
    },
    {
      externalId: `${source}-vague-${tag}`,
      url: `https://example.test/${source}/vague`,
      title: 'Thoughts on the market',
      body: 'Something is happening and nobody knows what.',
      organization: null,
      publishedAt: hoursAgo(3),
    },
  ];
}

async function rows(): Promise<ExtractionPass[]> {
  const found = await getDb().all<{ detail: string }>(
    'SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at, id',
    [projectId, EXTRACTION_EVENT],
  );
  return found.map((r) => JSON.parse(r.detail) as ExtractionPass);
}

describe('recordFeedExtraction records the processing graph, delta, identity, deepening and funnel', () => {
  it('the recorded row carries every stage', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 });
    const [row] = await rows();
    expect(row).toBeDefined();

    expect(row!.processingGraph!.length).toBe(1);
    const plan = row!.processingGraph![0]!;
    expect(plan.sourceId).toBe(source);
    expect(plan.status).toBe('PLANNED');
    expect(plan.stages.length).toBeGreaterThan(0);
    expect(plan.stages.every((s) => (s.executor === 'LLM') === (s.llmReason !== null))).toBe(true);

    expect(row!.delta!.counts.NEW).toBe(3);
    expect(row!.delta!.newItems.length).toBe(3);
    expect(row!.delta!.unchangedItems).toEqual([]);
    expect(row!.delta!.recomputedKeys.length).toBeGreaterThan(0);

    // Same name, different stated place: kept apart and reported, never fused.
    expect(row!.identity!.links).toEqual([]);
    expect(row!.identity!.collisions.length).toBe(1);
    expect(row!.identity!.collisions[0]!.attribute).toBe('location');

    const decided = [...row!.deepening!.promoted, ...row!.deepening!.held];
    expect(row!.deepening!.capacity).toBe(1);
    expect(decided.some((d) => d.id.startsWith('item:'))).toBe(true);
    expect(decided.every((d) => d.reasons.length > 0)).toBe(true);
    expect(row!.deepening!.promoted.length).toBeLessThanOrEqual(1);

    const stages = row!.funnel!.reading.stages.map((s) => s.stage);
    expect(stages).toEqual(['RAW_INTAKE', 'PARSED', 'NORMALIZED_FACTS', 'EVIDENCE_ACCEPTED', 'RELATIONSHIPS_UPDATED', 'GOAL_DECISIONS']);
    expect(row!.funnel!.reading.stages[0]!.raw).toBe(3);
    expect(row!.funnel!.gain.usableIntelligence).toBeGreaterThan(0);
    expect(row!.stageFailures).toEqual([]);
    expect(row!.deltaIndex).toBeDefined();
  });

  it('a second pass over unchanged records recomputes nothing and gains no usable intelligence', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 2 });
    await tick();
    // The same records republished under new ids: raw intake grows, understanding does not.
    await insertFeedItems(source, records(source, 'b'));
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 2 }))!;
    expect(second.items).toBe(3);
    expect(second.delta!.counts.UNCHANGED).toBe(3);
    expect(second.delta!.unchangedItems.length).toBe(3);
    expect(second.delta!.recomputedKeys).toEqual([]);
    expect(second.facts).toEqual([]);
    expect(second.funnel!.gain.usableIntelligence).toBe(0);
    expect(second.funnel!.gain.falseSpeed).toBe(true);
    expect(second.processingGraph![0]!.status).toBe('UNCHANGED');
    expect((await rows()).length).toBe(2);
  });

  it('a changed record is re-read and only its keys are recomputed', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    await tick();
    const changed = records(source, 'b').map((r, i) => (i === 0 ? { ...r, body: r.body!.replace('$4,000', '$6,500') } : r));
    await insertFeedItems(source, changed);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts).toMatchObject({ CHANGED: 1, UNCHANGED: 2, NEW: 0 });
    const rfqKeys = first.facts.filter((f) => f.evidence.itemId === first.delta!.newItems.find((id) => first.facts.some((x) => x.evidence.itemId === id && x.evidence.text.includes('4,000')))).map((f) => f.key);
    for (const key of rfqKeys) expect(second.delta!.recomputedKeys).toContain(key);
    expect(second.facts.every((f) => f.evidence.itemId === second.delta!.changedItems[0])).toBe(true);
    // No capacity: nothing is promoted, and the threshold says so.
    expect(second.deepening!.promoted).toEqual([]);
  });

  it('a pass still records when one stage fails, naming the stage', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1, failStages: ['identity'] }))!;
    expect(pass.stageFailures!.map((f) => f.stage)).toEqual(['identity']);
    const [row] = await rows();
    expect(row!.stageFailures!.map((f) => f.stage)).toEqual(['identity']);
    expect(row!.delta!.counts.NEW).toBe(3);
    expect(row!.facts.length).toBeGreaterThan(0);
    expect(row!.funnel).toBeDefined();
    const summary = await getDb().get<{ summary: string }>('SELECT summary FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, EXTRACTION_EVENT]);
    expect(summary!.summary).toContain('identity');
  });
});

describe('selective deepening routes the model reads (repair: deepening not consumed)', () => {
  const vague = (id: string, ageHours: number) => ({
    id,
    source: 'any',
    url: `https://example.test/${id}`,
    title: `Musing ${id}`,
    body: 'Something is happening and nobody knows what.',
    organization: null,
    publishedAt: hoursAgo(ageHours),
    fetchedAt: hoursAgo(ageHours),
  });
  const readable = {
    id: 'rfq',
    source: 'any',
    url: 'https://example.test/rfq',
    title: 'Request for quotes: 500 kg of packaging film',
    body: 'Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget $4,000.',
    organization: 'Acme Foods LLC',
    publishedAt: hoursAgo(1),
    fetchedAt: hoursAgo(1),
  };

  it('promotes unreadable records by value of information within capacity, and holds the rest from the model', () => {
    const items = [vague('old', 24 * 15), vague('fresh', 1), readable, vague('mid', 24 * 5), vague('expired', LEAD_MAX_AGE_MS / 3_600_000 + 1)];
    const route = routeEscalation(items, now, 2);
    expect(route.promoted.map((one) => one.id)).toEqual(['fresh', 'mid']);
    expect(route.held.map((one) => one.item.id).sort()).toEqual(['expired', 'old']);
    expect(route.held.every((one) => !one.decision.promote && one.decision.reasons.length >= 3)).toBe(true);
    expect(route.held.find((one) => one.item.id === 'expired')!.decision.reasons.at(-1)).toMatch(/cost of deepening/);
    expect(route.readable.map((one) => one.id)).toEqual(['rfq']);
    expect(route.deepening.capacity).toBe(2);
    // The screen order is the routing: promoted first by score, readable after, held left out.
    expect(screenOrder(items, now, 2).map((one) => one.id)).toEqual(['fresh', 'mid', 'rfq']);
    // More capacity promotes more; an expired lead is worth no read at any capacity.
    expect(screenOrder(items, now).map((one) => one.id)).toEqual(['fresh', 'mid', 'old', 'rfq']);
  });

  it('the screen pass sends only promoted unreadable records to the models; held ones wait for capacity', async () => {
    const source = `dp${Math.random().toString(36).slice(2, 8)}`;
    const fresh = Array.from({ length: SCREENS_PER_PASS }, (_, i) => ({
      externalId: `${source}-f${i}`,
      url: `https://example.test/${source}/f${i}`,
      title: `Musing fresh ${i} ${source}`,
      body: 'Something is happening and nobody knows what.',
      organization: null,
      publishedAt: new Date(now.getTime() - (60 + i) * 60_000).toISOString(),
    }));
    const old = Array.from({ length: 10 }, (_, i) => ({
      externalId: `${source}-o${i}`,
      url: `https://example.test/${source}/o${i}`,
      title: `Musing old ${i} ${source}`,
      body: 'Something is happening and nobody knows what.',
      organization: null,
      publishedAt: hoursAgo(24 * (10 + i)),
    }));
    await insertFeedItems(source, [...old, ...fresh]);
    const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 10_000, timeoutMs: 1000 };
    const drop = { verdict: 'DROP', window: 'UNKNOWN', deliverable: 'NONE', need: '', payer: '', reason: 'nothing to sell' };
    const asked: string[] = [];
    const completer: Completer = async (_c, _m, _s, prompt) => {
      asked.push(prompt);
      if (!prompt.includes('{"answers"')) return JSON.stringify(drop);
      const posts = prompt.split(/\nPost \d+:\n/).slice(1);
      return JSON.stringify({ answers: posts.map((_p, i) => ({ post: i + 1, ...drop })) });
    };
    await screenFeedLeads({ now, config, completer });
    const first = asked.join('\n');
    // Capacity is the pass's own model budget: the low-value old records were held, not read.
    for (let i = 0; i < 10; i += 1) expect(first).not.toContain(`Musing old ${i} ${source}`);
    expect(fresh.filter((one) => first.includes(one.title)).length).toBeGreaterThan(SCREENS_PER_PASS / 2);
    // Held is not dropped: with the fresh ones answered, the next pass has capacity for them.
    asked.length = 0;
    await screenFeedLeads({ now, config, completer });
    await screenFeedLeads({ now, config, completer });
    const later = asked.join('\n');
    for (let i = 0; i < 10; i += 1) expect(later).toContain(`Musing old ${i} ${source}`);
  });
});

describe('the funnel reads evidence accepted and goal decisions from their own rows, and gains against the previous pass', () => {
  async function orchestration(): Promise<string> {
    const layerId = (await play.layerByName('Monetization Logic')).id;
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
    return (await createOrchestration({ projectId, layerId, runId: run.id, title: 'pricing', assignment: 'What does it cost?', provider: 'WORKER', autoApprove: false })).id;
  }
  let claimSeq = 0;
  async function claim(orchestrationId: string, hash: string, opts: { accepted?: boolean; contradiction?: string } = {}): Promise<void> {
    claimSeq += 1;
    await getDb().run(
      `INSERT INTO research_claims
         (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, confidence, contradiction_state,
          validation_state, sourced, derived, derived_from, accepted, content_hash, created_at)
       VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, 0.9, ?, 'SOURCED', 1, 0, '[]', ?, ?, ?)`,
      [`clm_funnel_${claimSeq}`, orchestrationId, `Claim ${hash}`, 'https://acme-supply.com/pricing', opts.contradiction ?? 'UNCHALLENGED', opts.accepted === false ? 0 : 1, hash, new Date().toISOString()],
    );
  }
  async function round(): Promise<string> {
    const id = `cdr_funnel_${Math.random().toString(36).slice(2, 8)}`;
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, harvested_at, found, created_at, updated_at)
       VALUES (?, ?, 'cm_test', ?, 'EXPLICIT_PAID_REQUEST', 1, ?, 'OPEN', ?, NULL, 0, ?, ?)`,
      [id, projectId, `bucket-${id}`, `cand-${id}`, at, at, at],
    );
    return id;
  }
  const stageOf = (pass: ExtractionPass, name: string) => pass.funnel!.reading.stages.find((s) => s.stage === name)!;

  it('counts gate-accepted claims and shortlist decisions, not empty literals', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const orch = await orchestration();
    await claim(orch, 'h-accepted');
    await claim(orch, 'h-contested', { contradiction: 'CONTESTED' });
    await claim(orch, 'h-rejected', { accepted: false });
    const items = await getDb().all<{ id: string }>('SELECT id FROM feed_items WHERE source = ? ORDER BY id', [source]);
    await markShortlisted([items[0]!.id], await round());
    await tick();

    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 }))!;
    const evidence = stageOf(pass, 'EVIDENCE_ACCEPTED');
    // Only the gate's accepted claims are this stage's records; the contested one is held out under its reason.
    expect(evidence.raw).toBe(2);
    expect(evidence.usable).toBe(1);
    expect(evidence.excluded.CONTESTED).toBe(1);
    const decisions = stageOf(pass, 'GOAL_DECISIONS');
    expect(decisions.raw).toBe(1);
    expect(decisions.usable).toBe(1);
    expect(pass.funnel!.against).toBe('FIRST_PASS');
    expect(pass.funnel!.cumulative).toEqual(pass.funnel!.reading);
    // The stored row carries the same reading.
    const [row] = await rows();
    expect(row!.funnel!.reading.stages.find((s) => s.stage === 'EVIDENCE_ACCEPTED')!.raw).toBe(2);
  });

  it('measures gain against the previous pass, so restated evidence and re-imports gain nothing', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const orch = await orchestration();
    await claim(orch, 'h-same');
    await tick();
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 }))!;
    expect(first.funnel!.gain.usableIntelligence).toBe(first.funnel!.reading.usableIntelligence);
    await tick();

    // The same claim restated after the first pass, and the same records republished.
    await claim(orch, 'h-same');
    await insertFeedItems(source, records(source, 'b'));
    await tick();
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 }))!;
    expect(second.funnel!.against).toBe('PREVIOUS_PASS');
    const evidence = stageOf(second, 'EVIDENCE_ACCEPTED');
    expect(evidence.raw).toBe(1);
    expect(evidence.excluded.DUPLICATE).toBe(1);
    // Cumulative is the previous cumulative plus this pass, and gain is the difference between them.
    expect(second.funnel!.cumulative.raw).toBe(first.funnel!.cumulative.raw + second.funnel!.reading.raw);
    expect(second.funnel!.gain.raw).toBe(second.funnel!.cumulative.raw - first.funnel!.cumulative.raw);
    expect(second.funnel!.gain.usableIntelligence).toBe(0);
    expect(second.funnel!.gain.falseSpeed).toBe(true);
    expect(second.funnel!.window.since).toBe((await getDb().get<{ created_at: string }>('SELECT MIN(created_at) AS created_at FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, EXTRACTION_EVENT]))!.created_at);
  });

  it('a pass whose evidence and decision rows cannot be read claims no funnel and names the stage', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1, failStages: ['funnelRecords'] }))!;
    expect(pass.stageFailures!.map((f) => f.stage)).toEqual(['funnelRecords', 'funnel']);
    expect(pass.funnel).toBeUndefined();
  });
});
