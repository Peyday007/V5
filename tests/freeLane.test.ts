/**
 * The free research lane (§85): research Claude routines no longer take is
 * claimed, answered and gated through the ordinary queue and tools, with a free
 * model (stubbed here) as the worker and Brain opening every source itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, listBinEvents } from '../server/repos/bins.ts';
import { createProject } from '../server/repos/projects.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, listClaimsForFragment } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { firstJson, freeLaneTick, quotedIn } from '../server/services/freeLane/worker.ts';
import { freeLaneReading, laneCoverage } from '../server/services/freeLane/coverage.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import type { ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE_URL = 'https://www.bls.gov/ooh/office-and-administrative-support/receptionists.htm';
const PAGE =
  'Receptionists. Summary. The median hourly wage for receptionists was $17.39 in May 2024. ' +
  'Employment of receptionists is projected to show little or no change from 2024 to 2034. '.repeat(3);
const QUOTE = 'The median hourly wage for receptionists was $17.39 in May 2024.';

let play: TestProject;
let layerId = '';

/** A free model that answers each stage's prompt the way a capable one would. */
function model(options: { quote?: string } = {}): { completer: Completer; calls: string[] } {
  const calls: string[] = [];
  const completer: Completer = async (_config, name, _system, prompt) => {
    calls.push(name);
    if (prompt.includes('Name up to')) return JSON.stringify({ urls: [PAGE_URL], search: 'receptionist wage' });
    if (prompt.includes('Extract the material claims') && !options.quote) {
      // Cites by sentence number, as the prompt asks; Brain copies the sentence.
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
    if (prompt.includes('Extract the material claims')) {
      return (
        '```json\n' +
        JSON.stringify({
          claims: [
            {
              claim: 'The US median hourly wage for receptionists was $17.39 in May 2024.',
              claim_type: 'SOURCED_FACT',
              source_url: PAGE_URL,
              source_title: 'Receptionists — Occupational Outlook Handbook',
              source_publisher: 'U.S. Bureau of Labor Statistics',
              source_date: '2025-04-18',
              evidence_excerpt: options.quote ?? QUOTE,
              evidence_lane: 'wage',
              primary_source: true,
              confidence: 0.9,
            },
          ],
        }) +
        '\n```'
      );
    }
    if (prompt.includes('For each claim decide')) {
      const id = /"claimId":\s*"([^"]+)"/.exec(prompt)?.[1] ?? '';
      return JSON.stringify({
        verdicts: [
          {
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
          },
        ],
        sufficiency: 'SUFFICIENT',
        missing_lanes: [],
      });
    }
    if (prompt.includes('Write the research packet')) {
      const ids = [...prompt.matchAll(/"claimId":\s*"([^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify({
        report:
          `# Receptionist labour cost\n\nThe US median hourly wage for receptionists was $17.39 in May 2024 [${ids[0]}]. ` +
          'That is the wage alone; it excludes benefits and employer taxes, which the evidence here does not establish. ' +
          'A buyer comparing an AI receptionist against a hire should therefore treat $17.39 an hour as a floor.',
        cited_claim_ids: ids,
        still_missing: ['Fully loaded cost including benefits'],
      });
    }
    const role = /You are the (PRIMARY|ADVERSARIAL|JUDGE) auditor/.exec(prompt)?.[1];
    if (role === 'PRIMARY') {
      return JSON.stringify({ primary: { assignment_satisfied: 'PARTIAL', requirement_findings: ['Wage established; loaded cost not.'], notes: 'Sound for what it claims.' } });
    }
    if (role === 'ADVERSARIAL') {
      return JSON.stringify({
        adversarial: {
          attacks: [{ attack: 'One source only.', assessment: 'NOT_MATERIAL', reasoning: 'It is the official national statistic.' }],
          strongest_reason_not_to_advance: 'The loaded cost is missing.',
        },
      });
    }
    if (role === 'JUDGE') {
      // Unwrapped on purpose: models often answer with the role's object itself.
      return JSON.stringify({ verdict: 'PASS', summary: 'Answers the wage question from the official source.', next_action: 'Use the figure.' });
    }
    return '{}';
  };
  return { completer, calls };
}

const fetchSource = async (url: string): Promise<SourceFetch> =>
  url === PAGE_URL
    ? {
        readable: true,
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: 'text/html',
        retrievedAt: new Date().toISOString(),
        sha256: 'x',
        text: PAGE,
        truncated: false,
        totalChars: PAGE.length,
      }
    : { readable: false, requestedUrl: url, finalUrl: null, status: 404, retrievedAt: new Date().toISOString(), reason: 'HTTP_ERROR' as never, detail: '404' };

async function packet(projectId: string, title = 'AI receptionist pricing'): Promise<{ orchestration: ResearchOrchestration; fragment: ResearchFragment }> {
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
  return { orchestration, fragment: fragment! };
}

async function enqueue(projectId: string, type: string, orchestration: ResearchOrchestration, fragment: ResearchFragment): Promise<string> {
  const definition = workType(type);
  const item = await enqueueWork({
    projectId,
    workType: type,
    payload: definition.validate({}),
    requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id,
    fragmentId: fragment.id,
    createdByType: 'SYSTEM',
  });
  return item.id;
}

beforeEach(async () => {
  play = await freshProject();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane suite');
});

describe('the free research lane', () => {
  it('takes a parked play-research fragment, sources it through Brain, and the gate records the claim', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    // Claude may not have it.
    expect((await checkIn({ principal: { type: 'WORKER', id: 'nobody', memberships: [] } as never, workerId: 'nobody' })).assigned).toBe(false);

    const { completer, calls } = model();
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    expect(calls.every((name) => name === 'brain-a')).toBe(true);

    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sourceUrl).toBe(PAGE_URL);
    expect((await getWorkItem(itemId))?.state).toBe('SUCCEEDED');
    const events = await listBinEvents((await getDb().get<{ id: string }>('SELECT id FROM bins WHERE orchestration_id = ?', [orchestration.id]))!.id);
    expect(events.length).toBeGreaterThan(0);
  });

  it('verifies with the other model, against the page Brain fetched again', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const first = model();
    await freeLaneTick({ config: CONFIG, completer: first.completer, fetchSource, search: async () => [] });
    const queued = await getDb().all<{ id: string; state: string }>(
      "SELECT id, state FROM work_items WHERE orchestration_id = ? AND work_type = 'RESEARCH_VERIFY'",
      [orchestration.id],
    );
    // The packet runner queued the next stage by itself when the free lane finished the fragment.
    expect(queued.filter((q) => q.state === 'QUEUED')).toHaveLength(1);
    const verifyId = queued[0]!.id;

    const second = model();
    const tick = await freeLaneTick({ config: CONFIG, completer: second.completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_VERIFY']).toBe(1);
    expect(tick.submitted).toBe(1);
    expect(second.calls.every((name) => name === 'brain-b')).toBe(true);
    expect((await getWorkItem(verifyId))?.state).toBe('SUCCEEDED');
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims[0]!.accepted).toBe(true);
  });

  it('drops a quote that is not in the fetched page, and fails the item retryably instead of discarding it', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const { completer } = model({ quote: 'Receptionists earn a median of $40 an hour nationwide in 2024.' });
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.failed).toBe(1);
    expect(await listClaimsForFragment(fragment.id)).toHaveLength(0);
    const item = await getWorkItem(itemId);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(1);
  });

  it('hands an item back with its attempt refunded when the provider fails, and lets it cool down', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    const first = await freeLaneTick({ config: CONFIG, completer: down, fetchSource, search: async () => [] });
    expect(first.failed).toBe(1);
    const item = await getWorkItem(itemId);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(0);
    // Cooling down: the next tick does not spend another call on it.
    const second = await freeLaneTick({ config: CONFIG, completer: down, fetchSource, search: async () => [] });
    expect(second.claimed).toBe(0);
  });

  it('copies the cited sentences itself, so the excerpt is the page verbatim', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(PAGE).toContain(String(claims[0]!.evidenceExcerpt));
    expect(String(claims[0]!.evidenceLocator)).toMatch(/^sentence/);
  });

  it('accepts a quote that differs from the page only in typography, and never in words', () => {
    const page = 'The median hourly wage for receptionists was $17.39 in May 2024 \u2014 the \u201Cnational\u201D figure.';
    expect(quotedIn('wage for receptionists was $17.39 in May 2024 - the "national" figure.', page)).toBe(true);
    expect(quotedIn('wage for receptionists was $19.39 in May 2024 - the "national" figure.', page)).toBe(false);
  });

  it('never takes Brain-improvement or legal work', async () => {
    const brain = await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' });
    const own = await packet(brain.id, 'How Brain judges a source');
    const ownItem = await enqueue(brain.id, 'RESEARCH_FRAGMENT', own.orchestration, own.fragment);
    const legal = await packet(play.project.id, 'Export controls on selling to Iran');
    const legalItem = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', legal.orchestration, legal.fragment);
    const tick = await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    expect(tick.claimed).toBe(0);
    expect((await getWorkItem(ownItem))?.state).toBe('QUEUED');
    expect((await getWorkItem(legalItem))?.state).toBe('QUEUED');
  });

  it('does nothing, and says so, when no free model is configured', async () => {
    const tick = await freeLaneTick({ config: null });
    expect(tick).toMatchObject({ configured: false, claimed: 0 });
  });

  it('reads a model reply fenced or bare, and checks quotes against the page', () => {
    expect(firstJson('sure ```json\n{"a":1}\n``` done')).toEqual({ a: 1 });
    expect(firstJson('{"b":2}')).toEqual({ b: 2 });
    expect(firstJson('no json')).toBeNull();
    expect(quotedIn(QUOTE, PAGE)).toBe(true);
    expect(quotedIn('a figure nobody published anywhere', PAGE)).toBe(false);
  });
});

describe('a restriction must name a replacement that is doing the work', () => {
  it('refuses to turn brain-only mode on while displaced research has no free model, keeping the old route', async () => {
    await setBrainOnlyMode(false, 'test', 'start with routines on everything');
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    delete process.env['BRAIN_CHEAP_LLM_URL'];
    const coverage = await laneCoverage();
    expect(coverage.displaced['RESEARCH_FRAGMENT']).toBe(1);
    expect(coverage.ready).toBe(false);
    await expect(setBrainOnlyMode(true, 'test', 'restrict')).rejects.toThrow(/not turned on/);
    const { brainOnlyMode } = await import('../server/services/bins/brainOnly.ts');
    expect(await brainOnlyMode()).toBe(false);
  });

  it('reports free-lane work that reached Brain', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    const reading = await freeLaneReading();
    expect(reading.packetsTouched).toBe(1);
    expect(reading.claimsSubmitted).toBe(1);
    expect(reading.outcomesLastDay['RESEARCH_FRAGMENT:SUBMITTED']).toBe(1);
  });
});

describe('the whole packet on the free lane', () => {
  it('carries a packet from fragment to synthesis to its audits, each stage queued by the runner', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await getDb().run("UPDATE research_orchestrations SET status = 'RESEARCHING' WHERE id = ?", [orchestration.id]);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const seen: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      const { completer } = model();
      const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
      seen.push(JSON.stringify(tick.byType));
      // The packet runner's own pass, which its loop makes in production.
      const { advancePacket } = await import('../server/services/research/packetRunner.ts');
      await advancePacket(orchestration.id);
      if (tick.claimed === 0 && round > 0) break;
    }
    const items = await getDb().all<{ work_type: string; state: string }>(
      'SELECT work_type, state FROM work_items WHERE orchestration_id = ? ORDER BY created_at',
      [orchestration.id],
    );
    const status = await getDb().get<{ status: string }>('SELECT status FROM research_orchestrations WHERE id = ?', [orchestration.id]);
    expect(items.map((i) => `${i.work_type}:${i.state}`)).toEqual([
      'RESEARCH_FRAGMENT:SUCCEEDED',
      'RESEARCH_VERIFY:SUCCEEDED',
      'RESEARCH_SYNTHESIZE:SUCCEEDED',
      'RESEARCH_AUDIT:SUCCEEDED',
      'RESEARCH_AUDIT:SUCCEEDED',
      'RESEARCH_AUDIT:SUCCEEDED',
    ]);
    expect(status?.status).toBe('COMPLETE');
    expect(seen.length).toBeGreaterThan(5);
    // Brain filed the document, and the lane closed the bin nobody leased.
    const filed = await getDb().get<{ document_id: string | null }>('SELECT document_id FROM research_orchestrations WHERE id = ?', [orchestration.id]);
    expect(filed?.document_id).toBeTruthy();
    await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    const bin = await getDb().get<{ state: string }>('SELECT state FROM bins WHERE orchestration_id = ?', [orchestration.id]);
    expect(bin?.state).toBe('COMPLETE');
  });
});
