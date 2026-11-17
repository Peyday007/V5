/**
 * KNOW-25-1 on production rows: every deterministic-extraction pass records,
 * on its existing FEED_EXTRACTION row, the processing graph judged per source,
 * the delta against the previous pass's fingerprint index, identity resolution
 * with collisions, selective-deepening decisions and the intelligence funnel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { EXTRACTION_EVENT, readParserHistory, recordFeedExtraction, type ExtractionPass } from '../server/services/feeds/run.ts';
import { EXTRACTOR_VERSION } from '../server/services/feeds/extract.ts';
import { judgeStructure, plannedStage, planProcessing } from '../server/services/knowledge/processingGraph.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
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

  it('the plan is judged before any stage runs and decides what runs, per source, from that source\'s own evidence', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 }))!;
    const plan = first.processingGraph![0]!;
    // Evidence from the source itself: fielded records with no declared format are semi-structured, and a
    // first read has no parser history, so parsing is given to the model with its reason.
    expect(plannedStage(plan, 'PARSE_NORMALIZE')).toMatchObject({ executor: 'LLM', llmReason: 'SOURCE_INTERPRETATION' });
    // Every stage the pass ran is one the plan contains, with the executor the plan gave it.
    expect(first.stagesRun!.length).toBeGreaterThan(0);
    for (const run of first.stagesRun!) {
      expect(run.planned).toBe(true);
      expect(plannedStage(plan, run.stage)?.executor).toBe(run.executor);
    }
    expect(first.stagesRun!.map((r) => r.stage)).toEqual(expect.arrayContaining(['PARSE_NORMALIZE', 'ENTITY_IDENTIFICATION', 'EVENT_DETECTION']));
    // A model parse queues what code could not read for the model.
    expect(first.needsModel.flat().length).toBeGreaterThan(0);
    // The parser's measured record is carried for the next pass's plan.
    expect(first.parserHistory).toEqual({ parserVersion: EXTRACTOR_VERSION, sources: { [source]: expect.objectContaining({ runs: 3 }) } });
  });

  it('a source whose parser has proved itself is parsed by code, and what it cannot read is not spent on the model', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    // A prior pass recorded under the current parser: 40 of 40 records read on this source.
    await recordCashEvent({
      projectId,
      kind: EXTRACTION_EVENT,
      actorRef: 'BRAIN',
      summary: 'prior pass',
      detail: { parserHistory: { parserVersion: EXTRACTOR_VERSION, sources: { [source]: { runs: 40, successes: 40, decisionValue: 1, reconstructs: false } } } },
    });
    await tick();
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 }))!;
    const plan = pass.processingGraph![0]!;
    expect(plannedStage(plan, 'PARSE_NORMALIZE')).toMatchObject({ executor: 'CODE', llmReason: null });
    expect(pass.stagesRun!.find((r) => r.stage === 'PARSE_NORMALIZE')).toMatchObject({ executor: 'CODE', records: 3 });
    // The vague record is still unreadable by code, but no unreadable record is handed to the model or promoted.
    expect(pass.items - pass.readable).toBeGreaterThan(0);
    expect(pass.needsModel).toEqual([]);
    expect([...pass.deepening!.promoted, ...pass.deepening!.held].some((d) => d.id.startsWith('item:'))).toBe(false);
    expect(pass.parserHistory!.sources[source]!.runs).toBe(43);
  });

  it('a source whose records state no time is not handed to event detection', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a').map((r) => ({ ...r, publishedAt: null })));
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 }))!;
    const plan = pass.processingGraph![0]!;
    expect(plannedStage(plan, 'EVENT_DETECTION')).toBeNull();
    expect(plan.skipped.map((s) => s.stage)).toContain('EVENT_DETECTION');
    expect(pass.stagesRun!.map((r) => r.stage)).not.toContain('EVENT_DETECTION');
    expect(pass.graph).toBeNull();
  });

  it('the plan\'s structure is judged from the source, and the carried history from its own parser version only', () => {
    expect(judgeStructure('JSON', [])).toBe('STRUCTURED');
    expect(judgeStructure('pdf', [])).toBe('UNSTRUCTURED');
    expect(judgeStructure(null, [{ organization: 'Acme', publishedAt: null }])).toBe('SEMI_STRUCTURED');
    expect(judgeStructure(undefined, [{ organization: null, publishedAt: null }])).toBe('UNSTRUCTURED');
    expect(readParserHistory({ parserVersion: 'old', sources: { s: { runs: 4, successes: 4 } } }, 'new')).toEqual({});
    expect(readParserHistory({ parserVersion: 'v', sources: { s: { runs: 2, successes: 3 } } }, 'v')).toEqual({});
    expect(readParserHistory({ parserVersion: 'v', sources: { s: { runs: 4, successes: 4 } } }, 'v')).toEqual({ s: { runs: 4, successes: 4, decisionValue: 1, reconstructs: false } });
    const unchanged = planProcessing(
      { sourceId: 's', structure: 'STRUCTURED', authoritative: true, routes: [{ url: 'u', kind: 'FEED', updateMechanism: 'CONDITIONAL_FETCH', automatable: true }], hasCheckpoint: true, contentChanged: false, priorParserRuns: 1, priorParserSuccesses: 1, establishedEntityMappings: true, identityCollisionsSuspected: false, timeSeries: true },
      { questionId: 'q', decision: 'd', decisionValue: 1, uncertainty: 0, needsReconstruction: false, needsRelationships: false, novel: false },
    );
    // An unchanged source's plan runs no parse at all.
    expect(plannedStage(unchanged, 'PARSE_NORMALIZE')).toBeNull();
  });
});
