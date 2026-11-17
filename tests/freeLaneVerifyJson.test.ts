/**
 * RESEARCH_VERIFY replies that held no JSON Brain could read (production,
 * 2026-11-17 01:37–07:37Z: 112 releases and 40 failures "no JSON in a
 * N-character reply", the same 4527/4082/4855/2329-character reply on every
 * retry). A reply that states its verdicts is read wherever the model put them;
 * one that does not is told what was wrong once, and then fails — counted
 * against the model — instead of being handed back to loop.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, listClaimsForFragment } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import {
  firstJson,
  freeLaneTick,
  noJsonRepair,
  replyShape,
  resetFreeLaneFitness,
  verdictsOf,
} from '../server/services/freeLane/worker.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);

const verdict = (id: string): Record<string, unknown> => ({
  claim_id: id,
  supports_claim: true,
  geography: 'MATCH',
  timeframe: 'MATCH',
  population: 'MATCH',
  definitions: 'MATCH',
  geography_basis: 'The page is the US national figure.',
  timeframe_basis: 'May 2024, inside the fragment window.',
  population_basis: 'Receptionists, the population asked about.',
  definitions_basis: 'Median hourly wage as asked.',
});
const answer = (id: string): string => JSON.stringify({ verdicts: [verdict(id)], sufficiency: 'SUFFICIENT', missing_lanes: [] }, null, 2);

describe('reading a verification reply', () => {
  const id = 'clm_0f3a9c';
  const json = answer(id);

  it('reads the verdict object when prose around it has braces of its own', () => {
    // Reasoning first, naming the claim the way the prompt showed it.
    const reasoned = `Checking claim {${id}} against the BLS page: it states "$17.39 in May 2024", so it is supported.\n\n${json}`;
    expect(verdictsOf(firstJson(reasoned)!)).toHaveLength(1);
    // A closing remark that quotes a field after the object.
    const remark = `${json}\n\nNote: {"sufficiency"} is SUFFICIENT because the one required lane is answered.`;
    expect(firstJson(remark)).toMatchObject({ sufficiency: 'SUFFICIENT' });
    // A draft, then the answer.
    const drafted = `Draft: {"verdicts": [], "sufficiency": "INSUFFICIENT"} — wait, the page does state it.\nFinal:\n${json}`;
    expect(verdictsOf(firstJson(drafted)!)).toHaveLength(1);
    // Fenced, with braces in the prose before the fence.
    expect(verdictsOf(firstJson(`For {${id}}:\n\`\`\`json\n${json}\n\`\`\``)!)).toHaveLength(1);
  });

  it('reads a bare list of verdicts and a verdict keyed the way the claims were shown', () => {
    expect(verdictsOf(firstJson(JSON.stringify([verdict(id)]))!)).toEqual([verdict(id)]);
    const { claim_id: _drop, ...rest } = verdict(id);
    expect(verdictsOf({ verdicts: [{ claimId: id, ...rest }] })).toEqual([verdict(id)]);
  });

  it('accepts no reply that does not state a verdict, and says why', () => {
    const cut = json.slice(0, Math.floor(json.length * 0.6));
    expect(firstJson(cut)).toBeNull();
    expect(replyShape(cut)).toBe('cut off inside its JSON');
    const prose = 'The page supports the claim: the BLS reports a median hourly wage of $17.39 in May 2024 for receptionists.';
    expect(firstJson(prose)).toBeNull();
    expect(replyShape(prose)).toBe('prose only');
    expect(replyShape('')).toBe('empty');
    expect(replyShape('<think>The claim says $17.39 so I should answer {"verdicts": [')).toBe('reasoning never closed');
    const broken = '{"verdicts": [{"claim_id": "clm_1", "supports_claim": True}], "sufficiency": "SUFFICIENT"}';
    expect(firstJson(broken)).toBeNull();
    expect(replyShape(broken)).toBe('JSON that does not parse');
  });

  it('asks for the object alone, and for brevity only when the reply ran out of room', () => {
    expect(noJsonRepair('PROMPT', 'prose only')).toMatch(/^PROMPT\n\n.*ONLY the one JSON object/s);
    expect(noJsonRepair('PROMPT', 'prose only')).not.toMatch(/short sentence/);
    expect(noJsonRepair('PROMPT', 'cut off inside its JSON')).toMatch(/one short sentence/);
  });
});

let play: TestProject;
let layerId = '';

const fetchSource = async (url: string): Promise<SourceFetch> =>
  url === PAGE_URL
    ? { readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: new Date().toISOString(), sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length }
    : { readable: false, requestedUrl: url, finalUrl: null, status: 404, retrievedAt: new Date().toISOString(), reason: 'HTTP_ERROR' as never, detail: '404' };

/** Answers the fragment stage as a capable model would; the verify stage is the test's. */
function model(verify: (prompt: string, id: string) => string): { completer: Completer; verifyPrompts: string[]; verifyOptions: unknown[] } {
  const verifyPrompts: string[] = [];
  const verifyOptions: unknown[] = [];
  const completer: Completer = async (_config, _name, _system, prompt, options) => {
    if (prompt.includes('Name up to')) return JSON.stringify({ urls: [PAGE_URL] });
    if (prompt.includes('Extract the material claims')) {
      const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
      const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
      return JSON.stringify({
        claims: [
          {
            claim: 'The US median hourly wage for receptionists was $17.39 in May 2024.',
            claim_type: 'SOURCED_FACT',
            source: Number(ref?.[1]),
            sentences: [Number(ref?.[2])],
            source_title: 'Receptionists — Occupational Outlook Handbook',
            source_publisher: 'U.S. Bureau of Labor Statistics',
            source_date: '2025-04-18',
            evidence_lane: 'wage',
            primary_source: true,
            confidence: 0.9,
          },
        ],
      });
    }
    if (prompt.includes('For each claim decide')) {
      verifyPrompts.push(prompt);
      verifyOptions.push(options);
      return verify(prompt, /"claimId":\s*"([^"]+)"/.exec(prompt)?.[1] ?? '');
    }
    return '{}';
  };
  return { completer, verifyPrompts, verifyOptions };
}

/** A packet whose fragment the free lane has sourced, with its verification queued. */
async function verificationQueued(): Promise<{ verifyId: string; fragmentId: string; orchestrationId: string }> {
  const projectId = play.project.id;
  const title = 'AI receptionist pricing';
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: title });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title,
    assignment: 'What does a human receptionist cost per hour in the US?',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'receptionist-wage',
      question: 'What is the US median hourly wage of a receptionist?',
      geography: 'United States',
      timeframe: '2024',
      population: 'Receptionists',
      definitions: 'Median hourly wage',
      requiredEvidence: [{ id: 'wage', description: 'an official wage statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official statistics'],
      excludedSourceTypes: [],
      completionCriteria: ['One official wage figure'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
    },
  ]);
  await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title,
    objective: title,
    orchestrationId: orchestration.id,
    manifest: {
      objective: title,
      why: 'test',
      lineage: { projectId, layerId, goal: title, orchestrationId: orchestration.id },
      units: [],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 60 },
      stoppingConditions: [],
    },
    completionContract: 'RESEARCH_PACKET_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const definition = workType('RESEARCH_FRAGMENT');
  await enqueueWork({
    projectId,
    workType: 'RESEARCH_FRAGMENT',
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: fragment!.id,
    createdByType: 'SYSTEM',
  });
  await freeLaneTick({ config: CONFIG, completer: model(() => '{}').completer, fetchSource, search: async () => [] });
  const verify = await getDb().get<{ id: string }>(
    "SELECT id FROM work_items WHERE orchestration_id = ? AND work_type = 'RESEARCH_VERIFY' AND state = 'QUEUED'",
    [orchestration.id],
  );
  expect(verify).toBeTruthy();
  return { verifyId: verify!.id, fragmentId: fragment!.id, orchestrationId: orchestration.id };
}

async function verifyEvents(orchestrationId: string): Promise<{ outcome: string; reason: string }[]> {
  return getDb().all<{ outcome: string; reason: string }>(
    `SELECT e.outcome, e.reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND w.work_type = 'RESEARCH_VERIFY' AND w.orchestration_id = ?`,
    [orchestrationId],
  );
}

beforeEach(async () => {
  play = await freshProject();
  resetFreeLaneFitness();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane verify JSON suite');
});

describe('a verification whose reply held no JSON', () => {
  it('asks for the verification as a JSON object, and records a verdict wrapped in prose with braces', async () => {
    const { verifyId, fragmentId } = await verificationQueued();
    const lane = model((_prompt, id) => `I checked claim {${id}} against the page Brain fetched; it states the figure exactly.\n\n${answer(id)}`);
    const tick = await freeLaneTick({ config: CONFIG, completer: lane.completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_VERIFY']).toBe(1);
    expect(tick.submitted).toBe(1);
    expect(lane.verifyPrompts).toHaveLength(1);
    expect(lane.verifyOptions[0]).toMatchObject({ json: true });
    expect((await getWorkItem(verifyId))?.state).toBe('SUCCEEDED');
    expect((await listClaimsForFragment(fragmentId))[0]!.accepted).toBe(true);
  });

  it('tells a model whose reply was cut off what was wrong, and records the verdict it then gives', async () => {
    const { verifyId, fragmentId } = await verificationQueued();
    const lane = model((prompt, id) => {
      const full = answer(id);
      return prompt.includes('held no JSON object Brain could read') ? full : full.slice(0, Math.floor(full.length * 0.7));
    });
    await freeLaneTick({ config: CONFIG, completer: lane.completer, fetchSource, search: async () => [] });
    expect(lane.verifyPrompts).toHaveLength(2);
    expect(lane.verifyPrompts[1]).toContain('(cut off inside its JSON)');
    expect(lane.verifyPrompts[1]).toContain('one short sentence');
    expect((await getWorkItem(verifyId))?.state).toBe('SUCCEEDED');
    expect((await listClaimsForFragment(fragmentId))[0]!.accepted).toBe(true);
  });

  it('fails a reply that states no verdict at once, counted against the model, and leaves the item to another model', async () => {
    const { verifyId, fragmentId, orchestrationId } = await verificationQueued();
    const prose = 'The page supports the claim: the BLS reports a median hourly wage of $17.39 in May 2024 for receptionists.';
    const lane = model(() => prose);
    await freeLaneTick({ config: CONFIG, completer: lane.completer, fetchSource, search: async () => [] });
    // Asked once, told once, then failed: not handed back to be asked the same way again.
    expect(lane.verifyPrompts).toHaveLength(2);
    const events = await verifyEvents(orchestrationId);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('FAILED_RETRYABLE');
    expect(events[0]!.reason).toMatch(/no JSON in a \d+-character reply: prose only/);
    const item = await getWorkItem(verifyId);
    expect(item?.attemptCount).toBe(1);
    expect((await listClaimsForFragment(fragmentId))[0]!.accepted).not.toBe(true);
    // The model that answered in words does not take the same item again once the queue offers it.
    await getDb().run('UPDATE work_items SET available_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), verifyId]);
    const again = model((_prompt, id) => answer(id));
    await freeLaneTick({ config: CONFIG, completer: again.completer, fetchSource, search: async () => [] });
    const takers = (await verifyEvents(orchestrationId)).slice(1).map((e) => e.reason.replace(/^model /, '').split(':')[0]);
    expect(takers).not.toContain(events[0]!.reason.replace(/^model /, '').split(':')[0]);
  });

  it('still hands back an empty reply, which says nothing about the work', async () => {
    const { orchestrationId } = await verificationQueued();
    const lane = model(() => '');
    await freeLaneTick({ config: CONFIG, completer: lane.completer, fetchSource, search: async () => [] });
    expect(lane.verifyPrompts).toHaveLength(2);
    // Asked again as it was: there was nothing to correct.
    expect(lane.verifyPrompts[1]).toBe(lane.verifyPrompts[0]);
    const events = await verifyEvents(orchestrationId);
    expect(events.map((e) => e.outcome)).toEqual(['RELEASED_TRANSIENT']);
    expect(events[0]!.reason).toMatch(/no JSON in a 0-character reply: empty/);
  });
});
