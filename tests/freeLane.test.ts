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
import { ensureFreeWorkers, firstJson, freeLaneTick, quotedIn, resetFreeLaneMemberships } from '../server/services/freeLane/worker.ts';
import { freeLaneMayTakeImprovement, resetActivationCache } from '../server/services/improvement/activation.ts';
import { createLayer } from '../server/repos/layers.ts';
import { IMPROVEMENT_RESEARCH_SLOT_CAP } from '../server/domain/improvement.ts';
import { createUser } from '../server/repos/identity.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
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

  it('shows the model why every claim was dropped and takes its corrected answer, under the same checks', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const base = model();
    const prompts: string[] = [];
    const completer: Completer = async (config, name, system, prompt) => {
      if (prompt.includes('Extract the material claims')) prompts.push(prompt);
      // First claims answer cites a sentence that is not on the page.
      if (prompt.includes('Extract the material claims') && !prompt.includes('Brain could not use your previous answer')) {
        return JSON.stringify({ claims: [{ claim: 'The median wage was $17.39.', source: 1, sentences: [999], evidence_lane: 'wage' }] });
      }
      return base.completer(config, name, system, prompt);
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/cited sentences outside the page/);
    expect(await listClaimsForFragment(fragment.id)).toHaveLength(1);
    expect((await getWorkItem(itemId))?.state).toBe('SUCCEEDED');
  });

  it('hands an item back with its attempt refunded when Brain\'s own database is unavailable', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const { completer } = model();
    const busy = async (): Promise<SourceFetch> => {
      throw new Error('The database pool had no free connection within 10000ms: 8/8 connection(s) in use, 593 caller(s) waiting');
    };
    await freeLaneTick({ config: CONFIG, completer, fetchSource: busy, search: async () => [] });
    const item = await getWorkItem(itemId);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(0);
    const event = await getDb().get<{ outcome: string; reason: string }>(
      "SELECT outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ? ORDER BY at DESC LIMIT 1",
      [itemId],
    );
    expect(event).toMatchObject({ outcome: 'RELEASED_TRANSIENT' });
    expect(event!.reason).toMatch(/threw: The database pool had no free connection/);
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

  it('cools an item down for the model whose provider failed, not for the other model (RunPod GPU beside a free one)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(CONFIG);
    const working = model().completer;
    // brain-a's provider is busy; brain-b answers.
    const completer: Completer = async (config, name, system, prompt, options) => {
      if (name === 'brain-a') throw new Error('cheap lane HTTP 503');
      return working(config, name, system, prompt, options);
    };
    const base = { workers, completer, fetchSource, search: async () => [], config: CONFIG };
    const first = await takeOne({ ...base, worker: workers[0]!, index: 0 });
    expect(first.claimed).not.toBeNull();
    expect(first.ok).toBe(false);
    // Cooling down for brain-a…
    expect((await takeOne({ ...base, worker: workers[0]!, index: 0 })).claimed).toBeNull();
    // …but the other model may take it at once.
    const other = await takeOne({ ...base, worker: workers[1]!, index: 1, spillover: true });
    expect(other.claimed?.workItemId).toBe(first.claimed!.workItemId);
    expect(other.ok).toBe(true);
  });

  it('counts an item as untakeable only while every model is cooling down on it (the GPU is not kept on for it)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const { takeOne, coolingForEveryModel, endFreeLaneCooldowns } = await import('../server/services/freeLane/worker.ts');
    endFreeLaneCooldowns();
    const workers = await ensureFreeWorkers(CONFIG);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    const base = { workers, completer: down, fetchSource, search: async () => [], config: CONFIG };
    await takeOne({ ...base, worker: workers[0]!, index: 0 });
    expect(coolingForEveryModel(['brain-a', 'brain-b'])).toBe(0);
    await takeOne({ ...base, worker: workers[1]!, index: 1, spillover: true });
    expect(coolingForEveryModel(['brain-a', 'brain-b'])).toBe(1);
    endFreeLaneCooldowns();
    expect(coolingForEveryModel(['brain-a', 'brain-b'])).toBe(0);
  });

  it('never lets a provider that keeps answering 503/429 spend the item’s attempts', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const busy: Completer = async () => {
      throw new Error('cheap lane HTTP 429');
    };
    const { endFreeLaneCooldowns } = await import('../server/services/freeLane/worker.ts');
    for (let i = 0; i < 5; i++) {
      await freeLaneTick({ config: CONFIG, completer: busy, fetchSource, search: async () => [] });
      endFreeLaneCooldowns();
    }
    const item = await getWorkItem(itemId);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(0);
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

  it('reads a sentence cited as "S1.n" with no separate source, the way models often write it', async () => {
    const { citedExcerpt, sentencesOf } = await import('../server/services/freeLane/worker.ts');
    const numbered = [{ url: 'https://a', sentences: sentencesOf(PAGE) }, { url: 'https://b', sentences: ['Another source sentence that says something.'] }];
    expect(citedExcerpt({ sentences: ['S1.1'] }, numbered)?.excerpt).toBe(sentencesOf(PAGE)[0]);
    expect(citedExcerpt({ sentences: ['[S2.1]'] }, numbered)?.url).toBe('https://b');
    expect(citedExcerpt({ source: 'SOURCE 1', sentences: [1] }, numbered)?.url).toBe('https://a');
    expect(citedExcerpt({ sentences: ['S9.1'] }, numbered)).toBeNull();
  });

  it('reads every way models write a citation instead of dropping the claim (FREE_LANE:CITATION_DROPPED)', async () => {
    const { citedExcerpt, citationFailure } = await import('../server/services/freeLane/worker.ts');
    const s = ['First sentence of the page here.', 'Second sentence of the page here.', 'Third sentence of the page here.', 'Fourth sentence of the page here.', 'Fifth sentence of the page here.'];
    const one = [{ url: 'https://a', sentences: s }];
    const two = [...one, { url: 'https://b', sentences: ['Other source sentence number one.'] }];
    expect(citedExcerpt({ sentences: ['S1.3, S1.4'] }, one)?.excerpt).toBe(`${s[2]} ${s[3]}`);
    expect(citedExcerpt({ sentences: ['[S1.3] [S1.4]'] }, one)?.excerpt).toBe(`${s[2]} ${s[3]}`);
    expect(citedExcerpt({ sentences: ['S1.3-S1.5'] }, one)?.excerpt).toBe(`${s[2]} ${s[3]} ${s[4]}`);
    expect(citedExcerpt({ sentences: ['S1.3-5'] }, one)?.locator).toBe('sentences 3, 4, 5');
    expect(citedExcerpt({ sentences: ['3-5'] }, one)?.excerpt).toBe(`${s[2]} ${s[3]} ${s[4]}`);
    expect(citedExcerpt({ sentences: ['S3'] }, one)?.excerpt).toBe(s[2]);
    expect(citedExcerpt({ sentences: 'sentences 3 and 4' }, one)?.excerpt).toBe(`${s[2]} ${s[3]}`);
    expect(citedExcerpt({ sentences: '1, 2' }, one)?.excerpt).toBe(`${s[0]} ${s[1]}`);
    expect(citedExcerpt({ source: 'https://b', sentences: [1] }, two)?.url).toBe('https://b');
    expect(citedExcerpt({ source: 'SOURCE 2 \u2014 https://b', sentences: ['1'] }, two)?.url).toBe('https://b');
    expect(citedExcerpt({ source: '2', sentences: ['S2.1'] }, two)?.url).toBe('https://b');
    // A number in prose is not a reference: a year or a count does not become a cited sentence.
    expect(citedExcerpt({ sentences: ['published in 2 papers'] }, one)).toBeNull();
    expect(citationFailure({ sentences: ['the 2nd one, from 2019'] }, one)).toBe('citation not readable as sentence numbers');
    expect(citedExcerpt({ sentences: ['see S1.2 (published in 2019)'] }, one)?.excerpt).toBe(s[1]);
    // Still never invented: a number outside the page, or no number at all, is dropped and says which.
    expect(citedExcerpt({ sentences: ['S1.9'] }, one)).toBeNull();
    expect(citationFailure({ sentences: ['S1.9'] }, one)).toBe('cited sentences outside the page');
    expect(citationFailure({ sentences: ['the first one'] }, one)).toBe('citation not readable as sentence numbers');
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

  /** A packet of the improvement loop's own research goal, and a Brain packet that is not. */
  async function improvementPackets() {
    const brain = await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' });
    const brainLayer = (await createLayer({ projectId: brain.id, name: 'Methods', orderIndex: 0 })).id;
    const owner = await createUser({ email: 'gate-owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    const goal = await createResearchGoal({
      projectId: brain.id, ownerUserId: owner.id, createdByUserId: owner.id, name: 'Improve: free-lane sources',
      maxPackets: 1, maxFragments: 4, deadline: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const saved = layerId;
    layerId = brainLayer;
    const ours = await packet(brain.id, 'Improve: free-lane sources');
    const other = await packet(brain.id, 'How Brain judges a source');
    layerId = saved;
    await getDb().run('UPDATE research_orchestrations SET goal_id = ? WHERE id = ?', [goal.id, ours.orchestration.id]);
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO improvement_candidates (id, weakness_key, kind, title, problem, metric_key, owner_component, scope, severity, research_goal_id, created_at, updated_at)
       VALUES ('imp_t', 'FREE_LANE:NO_READABLE_SOURCE', 'FREE_LANE_FAILURE', 't', 'p', 'FREE_LANE_FRAGMENT_PASS_RATE', 'server/services/freeLane/worker.ts', 'GENERAL', 'HIGH', ?, ?, ?)`,
      [goal.id, at, at],
    );
    return { brain, ours, other };
  }

  async function activate(): Promise<void> {
    await getDb().run(
      "INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason) VALUES ('improvement_free_research', 1, ?, 'readiness-gate', '{}')",
      [new Date().toISOString()],
    );
    resetActivationCache();
    resetFreeLaneMemberships();
  }

  it('takes the improvement loop\'s own research only while its activation is ACTIVE (§87)', async () => {
    const { brain, ours, other } = await improvementPackets();
    const ourItem = await enqueue(brain.id, 'RESEARCH_FRAGMENT', ours.orchestration, ours.fragment);
    const otherItem = await enqueue(brain.id, 'RESEARCH_FRAGMENT', other.orchestration, other.fragment);

    // Inactive: nothing of Brain's is the free lane's.
    resetActivationCache();
    expect((await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] })).claimed).toBe(0);
    expect((await getWorkItem(ourItem))?.state).toBe('QUEUED');

    // ACTIVE: the loop's own research is taken and gated like any other; other Brain research still is not.
    await activate();
    const tick = await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    expect((await getWorkItem(ourItem))?.state).toBe('SUCCEEDED');
    expect((await getWorkItem(otherItem))?.state).toBe('QUEUED');
    expect(await listClaimsForFragment(ours.fragment.id)).toHaveLength(1);
  });

  it('takes a Brain research packet Claude routines have left unclaimed for hours, while active, and not a fresh one', async () => {
    const { brain, other } = await improvementPackets();
    const item = await enqueue(brain.id, 'RESEARCH_FRAGMENT', other.orchestration, other.fragment);
    await activate();
    expect((await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] })).claimed).toBe(0);
    await getDb().run('UPDATE bins SET ready_at = ? WHERE orchestration_id = ?', [new Date(Date.now() - 7 * 3_600_000).toISOString(), other.orchestration.id]);
    resetFreeLaneMemberships();
    expect((await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] })).submitted).toBe(1);
    expect((await getWorkItem(item))?.state).toBe('SUCCEEDED');
  });

  it('holds no more improvement leases than the cap, so commercial research keeps the rest of the lane', async () => {
    const { brain, ours } = await improvementPackets();
    await activate();
    const [worker] = await ensureFreeWorkers(CONFIG);
    const items: string[] = [];
    for (let i = 0; i < IMPROVEMENT_RESEARCH_SLOT_CAP + 1; i += 1) items.push(await enqueue(brain.id, 'RESEARCH_FRAGMENT', ours.orchestration, ours.fragment));
    const candidate = { id: items.at(-1)!, orchestration_id: ours.orchestration.id };
    expect(await freeLaneMayTakeImprovement(candidate)).toBe(true);
    await getDb().run(
      `UPDATE work_items SET state = 'LEASED', lease_id = 'lse_t' || id, worker_id = ?, lease_expires_at = ? WHERE id IN (${items.slice(0, IMPROVEMENT_RESEARCH_SLOT_CAP).map(() => '?').join(', ')})`,
      [worker!.workerId, new Date(Date.now() + 600_000).toISOString(), ...items.slice(0, IMPROVEMENT_RESEARCH_SLOT_CAP)],
    );
    expect(await freeLaneMayTakeImprovement(candidate)).toBe(false);
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
  it('re-asks an audit over a compact brief when the model answers it without JSON', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await getDb().run("UPDATE research_orchestrations SET status = 'RESEARCHING' WHERE id = ?", [orchestration.id]);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    let longBriefs = 0;
    let compactBriefs = 0;
    for (let round = 0; round < 8; round += 1) {
      const base = model();
      const completer: Completer = async (config, name, system, prompt) => {
        if (prompt.includes('Audit brief (the document')) {
          longBriefs += 1;
          return 'The packet looks reasonable overall, with a few gaps.';
        }
        if (prompt.includes('Audit brief (shortened')) {
          compactBriefs += 1;
          return base.completer(config, name, system, prompt.replace('Audit brief (shortened;', 'Audit brief (the document,'));
        }
        return base.completer(config, name, system, prompt);
      };
      const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
      const { advancePacket } = await import('../server/services/research/packetRunner.ts');
      await advancePacket(orchestration.id);
      if (tick.claimed === 0 && round > 0) break;
    }
    const status = await getDb().get<{ status: string }>('SELECT status FROM research_orchestrations WHERE id = ?', [orchestration.id]);
    expect(longBriefs).toBeGreaterThanOrEqual(3);
    expect(compactBriefs).toBeGreaterThanOrEqual(3);
    expect(status?.status).toBe('COMPLETE');
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
