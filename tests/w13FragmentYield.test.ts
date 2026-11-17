/**
 * W13 (2026-11-17): gpt-oss-120b listed no claims on 20 of its 21 refused
 * RESEARCH_FRAGMENT answers in an hour, with an empty drop map. These tests
 * cover the follow-up. A coverage-repair (gap) fragment is held to the source
 * rules the planner set for its requirement, not to blanket official-only
 * rules. An empty list with a stated reason is not counted as the model's bad
 * answer. Fragment yield is readable by kind.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { GAP_DEFAULT_SOURCE_RULES, gapSourceRules } from '../server/services/research/packet.ts';
import { droppedReason, hostClass, notTheAnswer, recentAnswers, unfitPairs } from '../server/services/freeLane/worker.ts';
import { fragmentYieldByKind, isGapFragment } from '../server/services/freeLane/coverage.ts';

const GPU = 'runpod/openai/gpt-oss-120b';

describe('a coverage fragment keeps the source rules its requirement was planned with', () => {
  const planned = {
    fragmentKey: 'pricing',
    requirementIds: ['req_price'],
    acceptableSourceTypes: ['vendor price lists', 'published tariffs'],
    excludedSourceTypes: ['unattributed summaries'],
    preferredSourceTypes: ['vendor price lists'],
    prohibitedEvidence: ['estimates without a source'],
  };

  it('inherits the latest planned fragment for the same requirement', () => {
    const rules = gapSourceRules([planned], 'req_price');
    expect(rules).toEqual({
      acceptableSourceTypes: ['vendor price lists', 'published tariffs'],
      excludedSourceTypes: ['unattributed summaries'],
      preferredSourceTypes: ['vendor price lists'],
      prohibitedEvidence: ['estimates without a source'],
    });
    // A copy: the fragment's rules are not shared arrays with the planned one.
    rules.acceptableSourceTypes.push('x');
    expect(planned.acceptableSourceTypes).toHaveLength(2);
  });

  it('never inherits from an earlier coverage fragment, another requirement, or a fragment that set no rules', () => {
    const earlierGap = { ...planned, fragmentKey: 'coverage-1-pricing', acceptableSourceTypes: ['government statistics'] };
    expect(gapSourceRules([planned, earlierGap], 'req_price').acceptableSourceTypes).toEqual(['vendor price lists', 'published tariffs']);
    expect(gapSourceRules([planned], 'req_other')).toEqual(GAP_DEFAULT_SOURCE_RULES);
    expect(gapSourceRules([{ ...planned, acceptableSourceTypes: [] }], 'req_price')).toEqual(GAP_DEFAULT_SOURCE_RULES);
  });

  it('keeps the official-only defaults where the planner set nothing', () => {
    expect(gapSourceRules([], 'req_price')).toEqual({
      acceptableSourceTypes: ['government statistics', 'regulatory filings', 'official registries'],
      excludedSourceTypes: ['vendor marketing pages', 'unattributed summaries'],
      preferredSourceTypes: ['official statistics', 'regulatory filings'],
      prohibitedEvidence: [],
    });
  });
});

describe('an empty list with a stated reason is not counted as the model failing', () => {
  const pages = ['https://acme-supply.com/pricing', 'https://shop.example.net/b'];
  const stated = `model ${GPU}: ${droppedReason(0, {}, pages, { claims: [], none_because: 'Both pages are vendor pages; the brief excludes vendor marketing pages.' })}`;
  const bare = `model ${GPU}: ${droppedReason(0, {}, pages, { claims: [] })}`;
  const dropped = `model ${GPU}: ${droppedReason(2, { 'cited sentences outside the page': 2 }, pages, { claims: [] })}`;

  it('reads a stated reason as not the answer, and a bare empty list or dropped claims as the answer', () => {
    expect(notTheAnswer(stated)).toBe(true);
    expect(notTheAnswer(bare)).toBe(false);
    expect(notTheAnswer(dropped)).toBe(false);
  });

  it('does not hold a model back for declining to invent, and still holds it for bare empty lists', () => {
    const rows = (reason: string): { model: string; work_type: string; outcome: string; n: number; reason: string }[] => [
      { model: GPU, work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', n: 9, reason },
      { model: GPU, work_type: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', n: 1, reason: `model ${GPU}: submitted` },
      { model: 'brain-a', work_type: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', n: 5, reason: 'model brain-a: submitted' },
    ];
    expect(unfitPairs(rows(stated), [GPU, 'brain-a']).has(`${GPU}|RESEARCH_FRAGMENT`)).toBe(false);
    expect(unfitPairs(rows(bare), [GPU, 'brain-a']).has(`${GPU}|RESEARCH_FRAGMENT`)).toBe(true);
  });

  it('does not let stated reasons use up the window of answers fitness is judged on', () => {
    const newestFirst = [
      ...Array.from({ length: 12 }, () => ({ reason: stated, work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE' })),
      ...Array.from({ length: 3 }, () => ({ reason: `model ${GPU}: submitted`, work_type: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED' })),
    ];
    const judged = recentAnswers(newestFirst).find((r) => r.outcome === 'SUBMITTED');
    expect(judged?.n).toBe(3);
  });
});

describe('a page class, read and never judged by', () => {
  it('names official, reference and commercial hosts', () => {
    expect(hostClass('https://www.agriculture.pa.gov/Plants_Land_Water/farmland')).toBe('official');
    expect(hostClass('https://www.bls.gov/oes/')).toBe('official');
    expect(hostClass('https://www.gov.uk/guidance/x')).toBe('official');
    expect(hostClass('https://ec.europa.eu/eurostat')).toBe('official');
    expect(hostClass('https://extension.psu.edu/x')).toBe('reference');
    expect(hostClass('https://en.wikipedia.org/wiki/Farm')).toBe('reference');
    expect(hostClass('https://www.acme-supply.com/pricing')).toBe('commercial');
    expect(hostClass('https://governor-news.com/x')).toBe('commercial');
    expect(hostClass('not a url')).toBe('unknown');
  });
});

describe('fragment yield by kind', () => {
  let play: TestProject;
  beforeEach(async () => {
    play = await freshProject();
  });

  it('counts gap and other fragments the free lane worked, and which reached an accepted claim', async () => {
    const projectId = play.project.id;
    const layerId = (await play.layerByName('Monetization Logic')).id;
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
    const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'pricing', assignment: 'What does it cost?', provider: 'WORKER', autoApprove: false });
    const base = {
      orchestrationId: orchestration.id, projectId, layerId, geography: null, timeframe: null, population: null, definitions: null,
      requiredEvidence: [{ id: 'price', description: 'a published price', necessity: 'REQUIRED' as const }],
      acceptableSourceTypes: ['vendor price lists'], excludedSourceTypes: [], completionCriteria: ['One price'],
      dependsOn: [], minIndependentSources: 1, status: 'QUEUED' as const,
    };
    const [planned, gap] = await createFragments([
      { ...base, fragmentIndex: 0, fragmentKey: 'pricing', question: 'What does a pallet cost?' },
      { ...base, fragmentIndex: 1, fragmentKey: 'coverage-1-pricing', question: 'What does a pallet cost? Answer only the part the packet is missing.' },
    ]);
    expect(isGapFragment(gap!.fragmentKey)).toBe(true);
    const definition = workType('RESEARCH_FRAGMENT');
    const item = async (fragmentId: string): Promise<string> =>
      (await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: definition.validate({}), requiredScopes: definition.requiredScopes, orchestrationId: orchestration.id, fragmentId, createdByType: 'SYSTEM' })).id;
    const plannedItem = await item(planned!.id);
    const gapItem = await item(gap!.id);
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workItemId: plannedItem, outcome: 'SUBMITTED', reason: `model ${GPU}: submitted`, workloadClass: 'RESEARCH_FRAGMENT' });
    for (let i = 0; i < 2; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workItemId: gapItem, outcome: 'FAILED_RETRYABLE', reason: `model ${GPU}: x`, workloadClass: 'RESEARCH_FRAGMENT' });
    }
    await getDb().run(
      `INSERT INTO research_claims
         (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, confidence, contradiction_state,
          validation_state, sourced, derived, derived_from, accepted, content_hash, created_at)
       VALUES (?, ?, ?, NULL, 'RESEARCH', ?, ?, 0.9, 'UNCHALLENGED', 'VALID', 1, 0, '[]', 1, ?, ?)`,
      ['clm_w13', orchestration.id, planned!.id, 'A pallet costs $40.', 'https://acme-supply.com/pricing', 'hash-w13', new Date().toISOString()],
    );

    const kinds = await fragmentYieldByKind(new Date(Date.now() - 3_600_000).toISOString());
    expect(kinds).toEqual([
      { kind: 'gap', fragments: 1, yielded: 0, acceptedByHost: {}, outcomes: { FAILED_RETRYABLE: 2 } },
      { kind: 'other', fragments: 1, yielded: 1, acceptedByHost: { commercial: 1 }, outcomes: { SUBMITTED: 1 } },
    ]);
  });
});
