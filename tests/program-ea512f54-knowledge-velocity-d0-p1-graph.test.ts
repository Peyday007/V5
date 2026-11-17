import { describe, expect, it } from 'vitest';
import { chooseRoute, deepeningJudgment, planIsWellFormed, planProcessing } from '../server/services/knowledge/processingGraph.ts';
import type { QuestionEvidence, RouteEvidence, SourceEvidence } from '../server/services/knowledge/processingGraph.ts';

const bulk: RouteEvidence = { url: 'https://example.org/all.zip', kind: 'BULK', updateMechanism: 'BULK_SNAPSHOT', automatable: true };
const paged: RouteEvidence = { url: 'https://example.org/api?page=1', kind: 'API', updateMechanism: 'PAGED_API', automatable: true };
const keyed: RouteEvidence = { url: 'https://example.org/stream', kind: 'FEED', updateMechanism: 'EVENT_SUBSCRIPTION', automatable: false, constraints: ['authentication required'] };

const structured: SourceEvidence = {
  sourceId: 'src-a',
  structure: 'STRUCTURED',
  authoritative: true,
  routes: [paged, bulk],
  hasCheckpoint: false,
  contentChanged: null,
  priorParserRuns: 0,
  priorParserSuccesses: 0,
  establishedEntityMappings: true,
  identityCollisionsSuspected: false,
  timeSeries: true,
};
const documents: SourceEvidence = {
  sourceId: 'src-b',
  structure: 'UNSTRUCTURED',
  authoritative: false,
  routes: [{ url: 'https://example.net/report.pdf', kind: 'DOCUMENT', updateMechanism: 'CONDITIONAL_FETCH', automatable: true }],
  hasCheckpoint: true,
  contentChanged: true,
  priorParserRuns: 2,
  priorParserSuccesses: 0,
  establishedEntityMappings: false,
  identityCollisionsSuspected: true,
  timeSeries: false,
};
const routine: QuestionEvidence = { questionId: 'q1', decision: 'refresh a price index', decisionValue: 10, uncertainty: 0.1, needsReconstruction: true, needsRelationships: false, novel: false };
const weighty: QuestionEvidence = { questionId: 'q2', decision: 'choose a supplier', decisionValue: 10_000, uncertainty: 0.6, needsReconstruction: false, needsRelationships: true, novel: false };

describe('KNOW-25-1 processing graph', () => {
  it('gives different source/question pairs different graphs, each with recorded reasons', () => {
    const a = planProcessing(structured, routine);
    const b = planProcessing(documents, weighty);
    expect(a.status).toBe('PLANNED');
    expect(b.status).toBe('PLANNED');
    expect(a.stages.map((s) => s.stage)).not.toEqual(b.stages.map((s) => s.stage));
    for (const p of [a, b]) {
      expect(p.stages.every((s) => s.why.length > 0)).toBe(true);
      expect(p.judgment.length).toBeGreaterThan(0);
      expect(planIsWellFormed(p)).toBe(true);
    }
  });

  it('keeps repeatable transformations as CODE', () => {
    const a = planProcessing(structured, routine);
    expect(a.stages.every((s) => s.executor === 'CODE')).toBe(true);
  });

  it('uses an LLM only with a stated ambiguity/novelty/interpretation/consequence reason', () => {
    const b = planProcessing(documents, weighty);
    const llmStages = b.stages.filter((s) => s.executor === 'LLM');
    expect(llmStages.length).toBeGreaterThan(0);
    for (const s of llmStages) expect(['AMBIGUITY', 'NOVELTY', 'SOURCE_INTERPRETATION', 'CONSEQUENTIAL_DECISION']).toContain(s.llmReason);
    expect(b.stages.find((s) => s.stage === 'PARSE_NORMALIZE')?.llmReason).toBe('SOURCE_INTERPRETATION');
    expect(b.stages.find((s) => s.stage === 'ENTITY_IDENTIFICATION')?.llmReason).toBe('AMBIGUITY');
  });

  it('prefers a bulk or incremental authoritative route over paged polling', () => {
    expect(chooseRoute([paged, bulk]).chosen).toBe(bulk);
    const a = planProcessing(structured, routine);
    expect(a.retrieval?.route).toBe(bulk);
    expect(a.stages.some((s) => s.stage === 'QUERY_PLANNING')).toBe(false);
    const resumed = planProcessing({ ...structured, hasCheckpoint: true, contentChanged: true }, routine);
    expect(resumed.retrieval?.mode).toBe('INCREMENTAL');
    expect(resumed.stages.some((s) => s.stage === 'CHANGE_DATA_CAPTURE')).toBe(true);
    expect(resumed.stages.some((s) => s.stage === 'SOURCE_INDEXING')).toBe(false);
  });

  it('removes a route a permission constraint stops instead of working around it', () => {
    const { chosen, removed } = chooseRoute([keyed, paged]);
    expect(chosen).toBe(paged);
    expect(removed[0]?.url).toBe(keyed.url);
    const none = planProcessing({ ...structured, routes: [keyed] }, routine);
    expect(none.status).toBe('NO_PERMITTED_ROUTE');
    expect(none.retrieval).toBeNull();
    expect(none.stages.some((s) => s.stage === 'RETRIEVAL' || s.stage === 'CHANGE_DATA_CAPTURE')).toBe(false);
  });

  it('does not reprocess an unchanged source and plans nothing without a decision', () => {
    expect(planProcessing({ ...structured, hasCheckpoint: true, contentChanged: false }, routine).status).toBe('UNCHANGED');
    expect(planProcessing(structured, { ...routine, decision: null }).status).toBe('NO_DECISION');
  });

  it('deepens by value of information against capacity, not keywords', () => {
    expect(deepeningJudgment(weighty, { llmIdleShare: 1 }).deepen).toBe(true);
    expect(deepeningJudgment(routine, { llmIdleShare: 1 }).deepen).toBe(false);
    expect(deepeningJudgment({ ...weighty, decisionValue: 100 }, { llmIdleShare: 1 }).deepen).toBe(true);
    expect(deepeningJudgment({ ...weighty, decisionValue: 100 }, { llmIdleShare: 0.05 }).deepen).toBe(false);
  });

  it('is serializable for recording', () => {
    const p = planProcessing(documents, weighty);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
