/**
 * The free research lane (§85): research Claude routines no longer take is
 * claimed, answered and gated through the ordinary queue and tools, with a free
 * model (stubbed here) as the worker and Brain opening every source itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, listBinEvents, recordBinEvent } from '../server/repos/bins.ts';
import { createProject } from '../server/repos/projects.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, listClaimsForFragment } from '../server/repos/research.ts';
import { enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { freeLaneAdmits, resetFailedBy, resetPurposeCache, asksByPriority, citedWithinLimit, claimAsks, droppedReason, emptyListRepair, ensureFreeWorkers, firstJson, freeLaneTick, noneBecause, PARTIAL_EVIDENCE, quotedIn, resetFreeLaneMemberships, retryNotReached, takeWave } from '../server/services/freeLane/worker.ts';
import { MAX_LIST_ITEMS } from '../server/mcp/researchTools.ts';
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
  (await import('../server/services/freeLane/worker.ts')).resetFreeLaneFitness();
  layerId = (await play.layerByName('Monetization Logic')).id;
  await setBrainOnlyMode(true, 'test', 'free lane suite');
});

describe('the free research lane', () => {
  it('never shows the model a page that is not about the question, and opens the next candidate instead', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    // Production, 2026-11-17: search results about physics and NHS wellbeing filled the brief.
    const OFF = 'https://arxiv.example.test/quantum';
    const offText =
      'Quantum entanglement is a phenomenon in which the state of each particle cannot be described independently. '.repeat(4);
    const withOffTopic = async (url: string): Promise<SourceFetch> =>
      url === OFF
        ? { readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: new Date().toISOString(), sha256: 'y', text: offText, truncated: false, totalChars: offText.length }
        : fetchSource(url);
    const prompts: string[] = [];
    const { completer: inner } = model();
    const completer: Completer = async (config, name, system, prompt, ...rest) => {
      prompts.push(prompt);
      return inner(config, name, system, prompt, ...rest);
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource: withOffTopic, search: async () => [OFF, PAGE_URL] });
    expect(tick.submitted).toBe(1);
    const extract = prompts.find((p) => p.includes('Extract the material claims')) ?? '';
    expect(extract).toContain(PAGE_URL);
    expect(extract).not.toContain(OFF);
    expect((await listClaimsForFragment(fragment.id))[0]!.sourceUrl).toBe(PAGE_URL);
  });

  it('never opens an arXiv preprint, a search interface or a contact page for a non-academic fragment (W16)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    // Production, 2026-11-17 15:20–16:15Z: the candidates gpt-oss-120b was handed.
    const NOT_SOURCES = ['https://arxiv.org/abs/2107.07566', 'https://www.sec.gov/edgar/search/', 'https://www.vestaminesupply.com/contact-us/'];
    const fetched: string[] = [];
    const recording = async (url: string): Promise<SourceFetch> => {
      fetched.push(url);
      return fetchSource(url);
    };
    const prompts: string[] = [];
    const { completer: inner } = model();
    const completer: Completer = async (config, name, system, prompt, ...rest) => {
      prompts.push(prompt);
      return inner(config, name, system, prompt, ...rest);
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource: recording, search: async () => [...NOT_SOURCES, PAGE_URL] });
    expect(tick.submitted).toBe(1);
    expect(fetched.some((url) => NOT_SOURCES.includes(url))).toBe(false);
    const extract = prompts.find((p) => p.includes('Extract the material claims')) ?? '';
    for (const url of NOT_SOURCES) expect(extract).not.toContain(url);
    expect((await listClaimsForFragment(fragment.id))[0]!.sourceUrl).toBe(PAGE_URL);
  });

  it('opens candidate pages at once, one per host, and still reads the page it needs', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    let inFlight = 0;
    let peak = 0;
    const hostsInFlight = new Map<string, number>();
    let hostOverlap = false;
    const slowFetch = async (url: string): Promise<SourceFetch> => {
      const host = new URL(url).host;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      hostsInFlight.set(host, (hostsInFlight.get(host) ?? 0) + 1);
      if (hostsInFlight.get(host)! > 1) hostOverlap = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      hostsInFlight.set(host, hostsInFlight.get(host)! - 1);
      inFlight -= 1;
      return fetchSource(url);
    };
    const searched = ['https://a.example.test/1', 'https://a.example.test/2', 'https://b.example.test/1', 'https://c.example.test/1', PAGE_URL];
    const { completer } = model();
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource: slowFetch, search: async () => searched });
    expect(tick.submitted).toBe(1);
    expect(peak).toBeGreaterThan(1);
    expect(hostOverlap).toBe(false);
    expect((await listClaimsForFragment(fragment.id))[0]!.sourceUrl).toBe(PAGE_URL);
  });

  it('asks Brain again when its database was not reached, and never after an outcome it cannot know', async () => {
    let calls = 0;
    const full = async () => {
      calls += 1;
      if (calls < 3) throw new Error('The database pool had no free connection within 10000ms: 7/7 connection(s) in use, 0 idle, 12 caller(s) waiting.');
      return 'submitted';
    };
    await expect(retryNotReached(full, [1, 1, 1])).resolves.toBe('submitted');
    expect(calls).toBe(3);
    // A statement that may have run is not asked again (invariant 26).
    let timedOut = 0;
    await expect(retryNotReached(async () => { timedOut += 1; throw new Error('The database did not answer in time.'); }, [1, 1])).rejects.toThrow(/did not answer/);
    expect(timedOut).toBe(1);
    // Past the backoff it throws as before.
    await expect(retryNotReached(async () => { throw new Error('too many clients already'); }, [1])).rejects.toThrow(/too many clients/);
  });

  it('takes a wave of pages in order, at most one per host', () => {
    const queue = ['https://a.test/1', 'https://a.test/2', 'https://b.test/1', 'https://c.test/1'];
    expect(takeWave(queue, 2)).toEqual(['https://a.test/1', 'https://b.test/1']);
    expect(queue).toEqual(['https://a.test/2', 'https://c.test/1']);
    expect(takeWave(queue, 6)).toEqual(['https://a.test/2', 'https://c.test/1']);
    expect(queue).toEqual([]);
  });

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

  it('gives a mostly failing model\u2019s role to the other model, not only a model that failed everything (production, 2026-11-07)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    // brain-b found the claim (it took the fragment as spillover), so brain-a may check it.
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(CONFIG);
    const found = await takeOne({ workers, worker: workers[1]!, index: 1, spillover: true, completer: model().completer, fetchSource, search: async () => [], config: CONFIG });
    expect(found.ok).toBe(true);
    const verifyId = (await getDb().get<{ id: string }>("SELECT id FROM work_items WHERE orchestration_id = ? AND work_type = 'RESEARCH_VERIFY'", [orchestration.id]))!.id;
    // brain-b holds the verify role, but answered 1 of its last 10 items: the role goes to brain-a.
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_AUDIT', outcome: 'SUBMITTED', reason: 'model brain-b: ok' });
    for (let i = 0; i < 9; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_AUDIT', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-b: model call failed: cheap lane HTTP 503' });
    }
    const second = model();
    const tick = await freeLaneTick({ config: CONFIG, completer: second.completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_VERIFY']).toBe(1);
    expect(second.calls.every((name) => name === 'brain-a')).toBe(true);
    expect((await getWorkItem(verifyId))?.state).toBe('SUCCEEDED');
  });

  it('gives an item one model failed to the other model next, instead of the same model again (production, 2026-11-24)', async () => {
    // wki_f067d73e3418427a8a3e: a RESEARCH_PLAN went to gpt-oss-120b three times ("no usable JSON") and exhausted.
    resetFailedBy();
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(CONFIG);
    const base = model();
    // An answer Brain refuses (a citation to a sentence the page does not have), every time it is asked.
    const broken: Completer = async (config, name, system, prompt) =>
      prompt.includes('Extract the material claims')
        ? JSON.stringify({ claims: [{ claim: 'The median wage was $17.39.', source: 1, sentences: [999], evidence_lane: 'wage' }] })
        : base.completer(config, name, system, prompt);
    const first = await takeOne({ workers, worker: workers[0]!, index: 0, spillover: true, completer: broken, fetchSource, search: async () => [], config: CONFIG });
    expect(first.claimed?.workItemId).toBe(itemId);
    expect(first.ok).toBe(false);
    await getDb().run(`UPDATE work_items SET state = 'QUEUED', available_at = ? WHERE id = ? AND state <> 'SUCCEEDED'`, [new Date(0).toISOString(), itemId]);
    const again = await takeOne({ workers, worker: workers[0]!, index: 0, spillover: true, completer: base.completer, fetchSource, search: async () => [], config: CONFIG });
    expect(again.claimed).toBeNull();
    const other = await takeOne({ workers, worker: workers[1]!, index: 1, spillover: true, completer: base.completer, fetchSource, search: async () => [], config: CONFIG });
    expect(other.claimed?.workItemId).toBe(itemId);
    expect(other.ok).toBe(true);
  });

  it('records a claim on a page Brain read as retrieved, and drops fields the tool does not define (production, 2026-11-07)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const base = model();
    const completer: Completer = async (config, name, system, prompt) => {
      const answer = await base.completer(config, name, system, prompt);
      if (!prompt.includes('Extract the material claims')) return answer;
      const parsed = JSON.parse(answer) as { claims: Record<string, unknown>[] };
      for (const claim of parsed.claims) Object.assign(claim, { retrieval_state: 'NOT_REACHABLE', geography: 'US', timeframe: 'May 2024' });
      return JSON.stringify(parsed);
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.retrievalState).toBe('RETRIEVED');
  });

  it('drops a qualifier on a self-describing finding and a closing date with no opening, instead of losing the submission (production, 2026-11-07)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const base = model();
    const completer: Completer = async (config, name, system, prompt) => {
      const answer = await base.completer(config, name, system, prompt);
      if (!prompt.includes('Extract the material claims')) return answer;
      const parsed = JSON.parse(answer) as { claims: Record<string, unknown>[] };
      for (const claim of parsed.claims) Object.assign(claim, { structural_qualifier: 'DEPOSIT', closes_on: '2026-12-01' });
      return JSON.stringify(parsed);
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.closesOn ?? null).toBeNull();
  });

  it('keeps the good claims when Brain refuses one numbered claim, without asking the model again (production, 2026-11-07)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const base = model();
    const prompts: string[] = [];
    const completer: Completer = async (config, name, system, prompt) => {
      const answer = await base.completer(config, name, system, prompt);
      if (!prompt.includes('Extract the material claims')) return answer;
      prompts.push(prompt);
      const parsed = JSON.parse(answer) as { claims: Record<string, unknown>[] };
      // A second claim on the same sentence with a date that does not exist: Brain refuses claims[1].
      parsed.claims.push({ ...parsed.claims[0]!, claim: 'The wage was published as a dated opening.', opportunity_signal: 'EXISTING_BUYING_SIGNAL', closes_on: '2026-02-30' });
      return JSON.stringify(parsed);
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    expect(prompts).toHaveLength(1);
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.claim).toMatch(/median hourly wage/);
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

  it('asks the model again for a payer claim that never says anybody pays, instead of submitting a claim the gate rejects (production, 2026-11-23)', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await getDb().run('UPDATE research_fragments SET required_evidence = ? WHERE id = ?', [
      JSON.stringify([{ id: 'payer', description: 'Who actually pays for this', necessity: 'REQUIRED' }]),
      fragment.id,
    ]);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const prompts: string[] = [];
    const completer: Completer = async (config, name, system, prompt) => {
      if (!prompt.includes('Extract the material claims')) return model().completer(config, name, system, prompt);
      prompts.push(prompt);
      const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
      const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
      const repair = prompt.includes('Brain could not use your previous answer');
      const claim = repair
        ? 'Employers pay receptionists a median hourly wage of $17.39 (May 2024).'
        : 'The U.S. Bureau of Labor Statistics publishes the receptionist occupation profile.';
      return JSON.stringify({ claims: [{ claim, source: Number(ref?.[1]), sentences: [Number(ref?.[2])], evidence_lane: 'payer' }] });
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/payer lane asks who pays/);
    expect(tick.submitted).toBe(1);
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims.map((one) => one.claim)).toEqual(['Employers pay receptionists a median hourly wage of $17.39 (May 2024).']);
  });

  it('takes Brain-improvement work Claude routing has refused for hours, and not before (production, 2026-11-23)', async () => {
    // bin_7e4b9543427d462f9f78: refused NO_SURFACE_SERVES_THIS_PROJECT on every tick since 2026-10-07.
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const bin = await getDb().get<{ id: string }>('SELECT id FROM bins WHERE orchestration_id = ?', [orchestration.id]);
    await getDb().run(`UPDATE bins SET purpose = 'BRAIN_IMPROVEMENT', purpose_basis = 'test' WHERE id = ?`, [bin!.id]);
    resetPurposeCache();
    const item = { id: itemId, bin_id: null, orchestration_id: orchestration.id, project_id: play.project.id };
    expect(await freeLaneAdmits(item)).toBe(false);
    await recordBinEvent({ eventType: 'DISPATCH_UNROUTED', binId: bin!.id, outcome: 'NO_SURFACE_SERVES_THIS_PROJECT', reason: 'No enabled Routine serves this project' });
    // Fresh: a Routine that can serve it still goes first.
    expect(await freeLaneAdmits(item)).toBe(false);
    await getDb().run('UPDATE bins SET created_at = ? WHERE id = ?', [new Date(Date.now() - 24 * 3_600_000).toISOString(), bin!.id]);
    expect(await freeLaneAdmits(item)).toBe(true);
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

  it('gives two passes that race to create the free workers the same rows, instead of a refused duplicate', async () => {
    // Out of the way, not deleted: other rows may name these workers.
    await getDb().run("UPDATE workers SET name = name || '-was-' || id WHERE name IN ('free-lane-a', 'free-lane-b')", []);
    const [one, two] = await Promise.all([ensureFreeWorkers(CONFIG), ensureFreeWorkers(CONFIG)]);
    expect(one.map((w) => w.workerId)).toEqual(two.map((w) => w.workerId));
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

  it('ends a route-outage cooldown when the same route answers, so its idle slots take the waiting items (production 2026-11-15: brain-a 4/12 busy, 11 waiting)', async () => {
    const { takeOne, coolingForEveryModel } = await import('../server/services/freeLane/worker.ts');
    // 22 items; brain-a's provider answers most calls but drops one in two with a 503.
    for (let i = 0; i < 22; i += 1) {
      const { orchestration, fragment } = await packet(play.project.id, `intermittent ${i}`);
      await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    }
    const workers = await ensureFreeWorkers(CONFIG);
    const working = model().completer;
    let fail = false;
    const completer: Completer = async (config, name, system, prompt, options) => {
      if (fail) throw new Error('cheap lane HTTP 503');
      return working(config, name, system, prompt, options);
    };
    const base = { workers, completer, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };
    const cooled = new Set<string>();
    for (let i = 0; i < 11; i += 1) {
      fail = true;
      const failed = await takeOne(base);
      expect(failed.ok).toBe(false);
      cooled.add(failed.claimed!.workItemId);
      fail = false;
      const answered = await takeOne(base);
      expect(answered.ok).toBe(true);
      expect(cooled.has(answered.claimed!.workItemId)).toBe(false);
    }
    // 11 items wait, every one handed back after a 503 on a route that has answered since.
    const waiting = await getDb().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM work_items WHERE project_id = ? AND state = 'QUEUED' AND work_type = 'RESEARCH_FRAGMENT'",
      [play.project.id],
    );
    expect(Number(waiting?.n)).toBe(11);
    expect(coolingForEveryModel(['brain-a'])).toBe(0);
    // brain-a's slots take all of them (beside the follow-on work the answers queued);
    // none sits idle beside them waiting out a clock.
    const taken = new Set<string>();
    for (let i = 0; i < 60 && taken.size < cooled.size; i += 1) {
      const next = await takeOne(base);
      expect(next.claimed).not.toBeNull();
      if (cooled.has(next.claimed!.workItemId)) taken.add(next.claimed!.workItemId);
    }
    expect(taken).toEqual(cooled);
  });

  it('keeps the cooldown while the route itself is still failing', async () => {
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const workers = await ensureFreeWorkers(CONFIG);
    const down: Completer = async () => {
      throw new Error('cheap lane HTTP 503');
    };
    const base = { workers, completer: down, fetchSource, search: async () => [], config: CONFIG, worker: workers[0]!, index: 0 };
    expect((await takeOne(base)).claimed).not.toBeNull();
    expect((await takeOne(base)).claimed).toBeNull();
  });

  it('renews the lease while a long model call runs, so a slow GPU answer is still current at submit (production 2026-11-18: audits refused "This lease is no longer current")', async () => {
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const { orchestration, fragment } = await packet(play.project.id);
    const itemId = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const workers = await ensureFreeWorkers(CONFIG);
    const working = model().completer;
    // Every model call is slow, as the GPU's ~671 s calls were; heartbeats are 20 ms apart here.
    const slow: Completer = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return working(...args);
    };
    const before = await getDb().get<{ lease_expires_at: string | null }>('SELECT lease_expires_at FROM work_items WHERE id = ?', [itemId]);
    expect(before?.lease_expires_at ?? null).toBeNull();
    const taken = await takeOne({ workers, worker: workers[0]!, index: 0, completer: slow, fetchSource, search: async () => [], config: CONFIG, heartbeatMs: 20 });
    expect(taken.claimed?.workItemId).toBe(itemId);
    expect(taken.ok).toBe(true);
    const lease = await getDb().get<{ heartbeat_count: number; outcome: string | null }>(
      'SELECT heartbeat_count, outcome FROM work_leases WHERE work_item_id = ? AND lease_generation = ?',
      [itemId, taken.claimed!.leaseGeneration],
    );
    expect(Number(lease?.heartbeat_count)).toBeGreaterThan(0);
    expect(lease?.outcome).toBe('SUCCEEDED');
  });

  it('hands back, at shutdown, the lease on an item still being worked \u2014 QUEUED again, its attempt not charged \u2014 and touches no lease another worker holds (production 2026-11-20: 25% of free-lane items expired across ~22-minute restarts)', async () => {
    const lane = await import('../server/services/freeLane/worker.ts');
    const { claimWork } = await import('../server/repos/workQueue.ts');
    const { CONNECTOR_SCOPES } = await import('../server/domain/types.ts');
    const first = await packet(play.project.id);
    const mine = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', first.orchestration, first.fragment);
    const workers = await ensureFreeWorkers(CONFIG);
    const working = model().completer;
    // The model is mid-call when the process is told to stop: it answers only when the gate opens.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let asked!: () => void;
    const midCall = new Promise<void>((resolve) => (asked = resolve));
    const held: Completer = async (...args) => {
      asked();
      await gate;
      return working(...args);
    };
    try {
      const taking = lane.takeOne({ workers, worker: workers[0]!, index: 0, completer: held, fetchSource, search: async () => [], config: CONFIG });
      await midCall;
      const leased = await getDb().get<{ state: string; attempt_count: number; worker_id: string; lease_generation: number }>(
        'SELECT state, attempt_count, worker_id, lease_generation FROM work_items WHERE id = ?',
        [mine],
      );
      expect(leased?.state).toBe('LEASED');
      expect(Number(leased?.attempt_count)).toBe(1);

      // Another worker holds another item: not this process's slot, and not the shutdown's to return.
      const second = await packet(play.project.id, 'AI receptionist pricing, second packet');
      const theirs = await enqueue(play.project.id, 'RESEARCH_FRAGMENT', second.orchestration, second.fragment);
      const [other] = await claimWork({
        workerId: workers[1]!.workerId,
        scopes: [{ projectId: play.project.id, scopes: [...CONNECTOR_SCOPES] }],
        workTypes: ['RESEARCH_FRAGMENT'],
        orchestrationId: second.orchestration.id,
        limit: 1,
      });
      expect(other?.workItemId).toBe(theirs);

      // SIGTERM's path (server/index.ts installShutdown).
      await lane.drainFreeLane?.({ timeoutMs: 5_000 });

      const returned = await getDb().get<{ state: string; attempt_count: number; worker_id: string | null; lease_id: string | null }>(
        'SELECT state, attempt_count, worker_id, lease_id FROM work_items WHERE id = ?',
        [mine],
      );
      expect(returned?.state).toBe('QUEUED');
      expect(Number(returned?.attempt_count)).toBe(0);
      expect(returned?.worker_id ?? null).toBeNull();
      // Released by the lease that held it: the same worker and generation, ended RELEASED (not EXPIRED, not FAILED).
      const lease = await getDb().get<{ worker_id: string; outcome: string | null }>(
        'SELECT worker_id, outcome FROM work_leases WHERE work_item_id = ? AND lease_generation = ?',
        [mine, leased!.lease_generation],
      );
      expect(lease?.worker_id).toBe(leased!.worker_id);
      expect(lease?.outcome).toBe('RELEASED');

      const untouched = await getDb().get<{ state: string; worker_id: string; lease_generation: number; attempt_count: number }>(
        'SELECT state, worker_id, lease_generation, attempt_count FROM work_items WHERE id = ?',
        [theirs],
      );
      expect(untouched?.state).toBe('LEASED');
      expect(untouched?.worker_id).toBe(workers[1]!.workerId);
      expect(Number(untouched?.lease_generation)).toBe(other!.leaseGeneration);
      expect(Number(untouched?.attempt_count)).toBe(1);

      // The model answers after the hand-back: nothing is submitted, failed or charged.
      open();
      const taken = await taking;
      expect(taken.ok).toBe(false);
      const after = await getDb().get<{ state: string; attempt_count: number }>('SELECT state, attempt_count FROM work_items WHERE id = ?', [mine]);
      expect(after?.state).toBe('QUEUED');
      expect(Number(after?.attempt_count)).toBe(0);
      expect(await listClaimsForFragment(first.fragment.id)).toHaveLength(0);
      // While draining, the lane claims nothing new.
      expect((await lane.takeOne({ workers, worker: workers[0]!, index: 0, completer: working, fetchSource, search: async () => [], config: CONFIG })).claimed).toBeNull();
    } finally {
      open?.();
      lane.resetFreeLaneDrain?.();
    }
  });

  it('never hands back at shutdown a lease whose submission has started: an unknown outcome is not "not done" (invariant 26)', async () => {
    const { releasableAtShutdown } = await import('../server/services/freeLane/worker.ts');
    expect(releasableAtShutdown({ touched: false, state: 'working' })).toBe(true);
    expect(releasableAtShutdown({ touched: true, state: 'working' })).toBe(false);
    expect(releasableAtShutdown({ touched: false, state: 'returned' })).toBe(false);
  });

  it('stops renewing at the first refusal, and never renews after it is stopped (\u00a724: a heartbeat proves ownership, it does not take it)', async () => {
    const { keepLeaseAlive } = await import('../server/services/freeLane/worker.ts');
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let refused = 0;
    const stopRefused = keepLeaseAlive(async () => {
      refused += 1;
      throw new Error('This lease is no longer current.');
    }, 5);
    await wait(60);
    expect(refused).toBe(1);
    stopRefused();
    let renewed = 0;
    const stop = keepLeaseAlive(async () => {
      renewed += 1;
    }, 5);
    await wait(40);
    stop();
    const atStop = renewed;
    expect(atStop).toBeGreaterThan(1);
    await wait(40);
    expect(renewed).toBe(atStop);
  });

  it('keeps renewing through a heartbeat that did not reach Brain, and stops only when the lease itself is refused (production 2026-11-18 16:31–16:51Z: "Brain database saturated")', async () => {
    const { keepLeaseAlive, leaseRefused } = await import('../server/services/freeLane/worker.ts');
    const { ToolError } = await import('../server/mcp/errors.ts');
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let beats = 0;
    const stop = keepLeaseAlive(async () => {
      beats += 1;
      if (beats <= 2) throw new Error('Brain is temporarily busy; the database did not answer in time.');
      if (beats === 4) throw new ToolError('FENCE_LOST', 'This lease is not current for that work item.');
    }, 5);
    await wait(120);
    stop();
    // Two busy beats did not end it; the fourth, a lease refusal, did.
    expect(beats).toBe(4);
    expect(leaseRefused(new Error('Brain is temporarily busy'))).toBe(false);
    expect(leaseRefused(new ToolError('FENCE_LOST', 'This lease is no longer current.'))).toBe(true);
    expect(leaseRefused(new Error('This lease is no longer current.'))).toBe(true);
  });

  it('does not judge a model by answers the queue refused for an expired lease (production 2026-11-18: gpt-oss-120b HELD BACK from audits by 27 lease refusals)', async () => {
    const { notTheAnswer, recentAnswers, unfitPairs } = await import('../server/services/freeLane/worker.ts');
    const refused = 'model gpu: brain_submit_audit refused: This lease is no longer current.';
    expect(notTheAnswer(refused)).toBe(true);
    // A refusal of the answer itself still counts.
    expect(notTheAnswer('model gpu: brain_submit_audit refused: the verdict cites no passage')).toBe(false);
    const rows = [
      ...Array.from({ length: 8 }, () => ({ reason: refused, work_type: 'RESEARCH_AUDIT', outcome: 'FAILED_RETRYABLE' })),
      { reason: 'model gpu', work_type: 'RESEARCH_AUDIT', outcome: 'SUBMITTED' },
    ];
    expect([...unfitPairs(recentAnswers(rows), ['gpu', 'other'])]).toEqual([]);
  });

  it('asks for the most important waiting work first, so a revenue goal\u2019s research does not wait behind unrelated later stages', () => {
    const asks = claimAsks([{ model: 'a' }], 0);
    // A goal fragment boosted to 7 outranks an ordinary synthesis at 5.
    const goalFirst = asksByPriority(asks, new Map([['RESEARCH_SYNTHESIZE', 5], ['RESEARCH_FRAGMENT', 7]]));
    expect(goalFirst.flat()).toEqual(['RESEARCH_FRAGMENT', 'RESEARCH_SYNTHESIZE']);
    // Equal priority keeps stage order: finish what is paid for first.
    const tie = asksByPriority(asks, new Map([['RESEARCH_SYNTHESIZE', 5], ['RESEARCH_FRAGMENT', 5]]));
    expect(tie.flat()).toEqual(['RESEARCH_SYNTHESIZE', 'RESEARCH_FRAGMENT']);
    // A type with nothing waiting is not asked for.
    expect(asksByPriority(asks, new Map()).length).toBe(0);
  });

  it('asks per work type and never for the other worker\u2019s role, so declined rows cannot fill the claim window (IDLE_CAPACITY)', async () => {
    const two = [{ model: 'a' }, { model: 'b' }];
    // Slot 0 never asks for verification (always worker 1's); slot 1 asks for it first among its own.
    expect(claimAsks(two, 0).flat()).toEqual(['RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT', 'RESEARCH_PLAN', 'RESEARCH_FRAGMENT']);
    expect(claimAsks(two, 1).flat()).toEqual(['RESEARCH_AUDIT', 'RESEARCH_VERIFY']);
    // Spillover and a single worker keep every type, in the lane's priority order, one per ask.
    expect(claimAsks(two, 0, true).flat()).toEqual(['RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT', 'RESEARCH_VERIFY', 'RESEARCH_PLAN', 'RESEARCH_FRAGMENT']);
    expect(claimAsks([{ model: 'a' }], 0).every((ask) => ask.length === 1)).toBe(true);

    // The recorded failure: more declined rows at the head of the queue than one claim window reads.
    const { orchestration, fragment } = await packet(play.project.id);
    const verify = workType('RESEARCH_VERIFY');
    for (let i = 0; i < 70; i += 1) {
      await enqueueWork({
        projectId: play.project.id,
        workType: 'RESEARCH_VERIFY',
        payload: verify.validate({}),
        requiredScopes: verify.requiredScopes,
        orchestrationId: orchestration.id,
        fragmentId: fragment.id,
        createdByType: 'SYSTEM',
        priority: 9,
      });
    }
    const wanted = await enqueue(play.project.id, 'RESEARCH_SYNTHESIZE', orchestration, fragment);
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(CONFIG);
    const taken = await takeOne({ workers, worker: workers[0]!, index: 0, completer: model().completer, fetchSource, search: async () => [], config: CONFIG });
    expect(taken.claimed?.workItemId).toBe(wanted);
  });

  it('pages past a window of declined rows of the same type, one packet at a time (IDLE_CAPACITY)', async () => {
    const audit = workType('RESEARCH_AUDIT');
    const crowded = await packet(play.project.id, 'crowded packet');
    // Slot 1 declines ADVERSARIAL audits (slot 0's role); more of them than one claim window reads.
    for (let i = 0; i < 70; i += 1) {
      await enqueueWork({
        projectId: play.project.id,
        workType: 'RESEARCH_AUDIT',
        payload: audit.validate({ role: 'ADVERSARIAL' }),
        requiredScopes: audit.requiredScopes,
        orchestrationId: crowded.orchestration.id,
        fragmentId: crowded.fragment.id,
        createdByType: 'SYSTEM',
        priority: 9,
      });
    }
    const other = await packet(play.project.id, 'other packet');
    const wanted = (
      await enqueueWork({
        projectId: play.project.id,
        workType: 'RESEARCH_AUDIT',
        payload: audit.validate({ role: 'PRIMARY' }),
        requiredScopes: audit.requiredScopes,
        orchestrationId: other.orchestration.id,
        fragmentId: other.fragment.id,
        createdByType: 'SYSTEM',
      })
    ).id;
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(CONFIG);
    const taken = await takeOne({ workers, worker: workers[1]!, index: 1, completer: model().completer, fetchSource, search: async () => [], config: CONFIG });
    expect(taken.claimed?.workItemId).toBe(wanted);
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

  it('reads a citation a model put under another key, and still refuses one that resolves to nothing', async () => {
    const { citedExcerpt, sentencesOf } = await import('../server/services/freeLane/worker.ts');
    const one = [{ url: 'https://a', sentences: sentencesOf(PAGE) }];
    const s = one[0]!.sentences;
    expect(citedExcerpt({ claim: 'x', source: 1, sentence_numbers: [1] }, one)?.excerpt).toBe(s[0]);
    expect(citedExcerpt({ claim: 'x', citations: ['[S1.2]'] }, one)?.excerpt).toBe(s[1]);
    expect(citedExcerpt({ claim: 'x', evidence_locator: 'S1.1, S1.2' }, one)?.excerpt).toBe(`${s[0]} ${s[1]}`);
    expect(citedExcerpt({ claim: 'x', evidence_excerpt: 'see [S1.1]' }, one)?.excerpt).toBe(s[0]);
    expect(citedExcerpt({ claim: 'x', citations: ['S1.999'] }, one)).toBeNull();
    expect(citedExcerpt({ claim: 'x', evidence_excerpt: 'published in 2019' }, one)).toBeNull();
    expect(citedExcerpt({ claim: 'x' }, one)).toBeNull();
  });

  it('records which keys an uncited claim carried, names only, so the next widening is read from rows', async () => {
    const { uncitedReason } = await import('../server/services/freeLane/worker.ts');
    expect(uncitedReason({ claim: 'x', evidence_lane: 'a' })).toBe('no citation and no verbatim quote');
    expect(uncitedReason({ claim: 'x', evidence_lane: 'a', ref_ids: [1], page: 'SECRET VALUE' })).toBe('no citation and no verbatim quote (claim keys: ref_ids,page)');
    expect(uncitedReason({ claim: 'x', 'we ird\n': 1 })).toContain('(claim keys: weird)');
    expect(uncitedReason({ claim: 'x', ref_ids: [1] })).toMatch(/^no citation and no verbatim quote/);
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
    expect(citationFailure({ sentences: ['the 2nd one, from 2019'] }, one)).toMatch(/^citation not readable as sentence numbers/);
    expect(citedExcerpt({ sentences: ['see S1.2 (published in 2019)'] }, one)?.excerpt).toBe(s[1]);
    // Still never invented: a number outside the page, or no number at all, is dropped and says which.
    expect(citedExcerpt({ sentences: ['S1.9'] }, one)).toBeNull();
    expect(citationFailure({ sentences: ['S1.9'] }, one)).toBe('cited sentences outside the page');
    expect(citationFailure({ sentences: ['the first one'] }, one)).toMatch(/^citation not readable as sentence numbers/);
  });

  it('reads the claim list in every shape a model sends it, and the lane a label names (FREE_LANE:CITATION_DROPPED#3)', async () => {
    const { listedClaims, laneFor, citedExcerpt, sentencesOf } = await import('../server/services/freeLane/worker.ts');
    const one = { claim: 'The median hourly wage was $17.39.', source: 1, sentences: [3], evidence_lane: 'wage' };
    const two = { claim: 'Employment shows little change.', source: 1, sentences: [4], evidence_lane: 'wage' };
    // Production shapes that were read as "0 claim(s) offered": each now lists its claims.
    expect(listedClaims(firstJson(JSON.stringify([one]))!)).toEqual([one]);
    expect(listedClaims(firstJson(JSON.stringify([one, two]))!)).toEqual([one, two]);
    expect(listedClaims(firstJson(JSON.stringify({ Claims: [one, two] }))!)).toEqual([one, two]);
    expect(listedClaims(firstJson(JSON.stringify({ claims: one }))!)).toEqual([one]);
    expect(listedClaims(firstJson(JSON.stringify(one))!)).toEqual([one]);
    const thinking = `<think>The answer looks like {"claims":[]} or \`\`\`json\n{"x":1}\n\`\`\` maybe.</think>\n${JSON.stringify({ claims: [one] })}`;
    expect(listedClaims(firstJson(thinking)!)).toEqual([one]);
    expect(listedClaims(firstJson(`<think>{"claim": "draft"}</think>\n${JSON.stringify([one, two])}`)!)).toEqual([one, two]);
    // Prose after the list, even prose with its own brackets, is not part of the list.
    expect(listedClaims(firstJson(`${JSON.stringify([one])} per [S1]`)!)).toEqual([one]);
    expect(listedClaims(firstJson(`${JSON.stringify([one, two])} per [S1.3] and [S1.4]`)!)).toEqual([one, two]);
    expect(listedClaims(firstJson(`Here: ${JSON.stringify([{ ...one, claim: 'a ] b [ c' }, two])} — see [S1]`)!)).toHaveLength(2);
    // Prose with a bracketed reference before the object is still the object.
    expect(firstJson(`Per [S1.3]: ${JSON.stringify({ claims: [one] })}`)).toEqual({ claims: [one] });
    // Reasoning that was never closed (cut off, or the template never closes it): its own braces are not the answer.
    expect(firstJson('<think>unfinished {"claims":[]} reasoning\n[{"claim":"a"}]')).toEqual({ claims: [{ claim: 'a' }] });
    expect(listedClaims(firstJson(`<think>maybe {"claims":[]} or [S1.2] says "}" ${JSON.stringify({ claims: [one, two] })}`)!)).toEqual([one, two]);
    expect(firstJson('<think>still reasoning about {"claims":[]} when the reply was cut off')).toEqual({ claims: [] });
    expect(firstJson('<think>no answer at all [S1.2] and {broken')).toBeNull();
    // A template that opened the block itself leaves only its close: the reasoning before it is not the answer.
    expect(listedClaims(firstJson(`draft {"claims":[]} here</think>\n${JSON.stringify([one])}`)!)).toEqual([one]);
    expect(listedClaims({ claims: [] })).toEqual([]);
    expect(listedClaims({ answer: 'none' })).toEqual([]);
    // Each listed claim still has to cite a sentence Brain fetched.
    const numbered = [{ url: PAGE_URL, sentences: sentencesOf(PAGE) }];
    expect(PAGE).toContain(citedExcerpt(listedClaims(firstJson(JSON.stringify([one]))!)[0]!, numbered)!.excerpt);
    expect(citedExcerpt({ claim: 'x' }, numbered)).toBeNull();
    expect(citedExcerpt({ claim: 'x', source: 1, sentences: [999] }, numbered)).toBeNull();
    // A lane label that names one declared lane is that lane; an ambiguous or unknown one names none.
    const lanes = [{ id: 'lane_1', description: 'an official wage statistic' }, { id: 'L2', description: 'primary sources' }];
    expect(laneFor('Lane 1', lanes)).toBe('lane_1');
    expect(laneFor('LANE-1', lanes)).toBe('lane_1');
    expect(laneFor('L2: primary sources', lanes)).toBe('L2');
    expect(laneFor('An official wage statistic.', lanes)).toBe('lane_1');
    expect(laneFor('lane_1', lanes)).toBe('lane_1');
    expect(laneFor('Lane 1', [{ id: 'lane_1', description: 'a' }, { id: 'lane-1', description: 'b' }])).toBeNull();
    expect(laneFor('Lane 3', lanes)).toBeNull();
    expect(laneFor('', lanes)).toBeNull();
    // A two-part label names a lane through its first part; the second only confirms it.
    expect(laneFor('Lane 3 (primary sources)', lanes)).toBeNull();
    expect(laneFor('Lane 3: an official wage statistic', lanes)).toBeNull();
    expect(laneFor('primary sources (L2)', lanes)).toBe('L2');
    expect(laneFor('L2 - primary sources', lanes)).toBe('L2');
    expect(laneFor('Lane 1: primary sources', lanes)).toBeNull();
    expect(laneFor('Lane 1: wage figures', lanes)).toBe('lane_1');
  });

  it('submits cited claims from a top-level array behind a <think> block, where it once offered none', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const base = model();
    const completer: Completer = async (config, name, system, prompt, opts) => {
      const reply = await base.completer(config, name, system, prompt, opts);
      if (!prompt.includes('Extract the material claims')) return reply;
      const claims = (JSON.parse(reply) as { claims: unknown[] }).claims;
      return `<think>Maybe {"claims": []}? No: cite the sentence.</think>\n${JSON.stringify(claims)}`;
    };
    const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.submitted).toBe(1);
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(PAGE).toContain(String(claims[0]!.evidenceExcerpt));
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
    // The 24h consumption count is the admin readout's alone: the dispatch
    // tick's per-minute watch never pays for it (48-82 s on production).
    expect(typeof reading.coverage.consumedLastDay).toBe('number');
    expect((await laneCoverage()).consumedLastDay).toBeNull();
  });
  it('asks an audit that already timed out over the compact brief, so it stops cycling', async () => {
    const { endFreeLaneCooldowns } = await import('../server/services/freeLane/worker.ts');
    const { orchestration, fragment } = await packet(play.project.id);
    await getDb().run("UPDATE research_orchestrations SET status = 'RESEARCHING' WHERE id = ?", [orchestration.id]);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    let compactBriefs = 0;
    for (let round = 0; round < 14; round += 1) {
      const base = model();
      const completer: Completer = async (config, name, system, prompt) => {
        if (prompt.includes('Audit brief (the document')) throw new Error('cheap lane HTTP 504: upstream timed out');
        if (prompt.includes('Audit brief (shortened')) {
          compactBriefs += 1;
          return base.completer(config, name, system, prompt.replace('Audit brief (shortened;', 'Audit brief (the document,'));
        }
        return base.completer(config, name, system, prompt);
      };
      const tick = await freeLaneTick({ config: CONFIG, completer, fetchSource, search: async () => [] });
      endFreeLaneCooldowns();
      const { advancePacket } = await import('../server/services/research/packetRunner.ts');
      await advancePacket(orchestration.id);
      const st = await getDb().get<{ status: string }>('SELECT status FROM research_orchestrations WHERE id = ?', [orchestration.id]);
      if (st?.status === 'COMPLETE' || (tick.claimed === 0 && round > 2)) break;
    }
    const status = await getDb().get<{ status: string }>('SELECT status FROM research_orchestrations WHERE id = ?', [orchestration.id]);
    expect(compactBriefs).toBeGreaterThanOrEqual(3);
    expect(status?.status).toBe('COMPLETE');
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

describe('a model keeps only the kinds of work Brain accepts from it', () => {
  it('marks a model whose answers for one work type are rejected, never every model for a type', async () => {
    const { unfitPairs } = await import('../server/services/freeLane/worker.ts');
    const rows = [
      { model: 'small', work_type: 'RESEARCH_AUDIT', outcome: 'FAILED_RETRYABLE', n: 6 },
      { model: 'small', work_type: 'RESEARCH_AUDIT', outcome: 'RELEASED_TRANSIENT', n: 40 },
      { model: 'small', work_type: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', n: 9 },
      { model: 'small', work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', n: 4 },
      { model: 'large', work_type: 'RESEARCH_AUDIT', outcome: 'SUBMITTED', n: 7 },
      { model: 'large', work_type: 'RESEARCH_VERIFY', outcome: 'FAILED_RETRYABLE', n: 5 },
      { model: 'small', work_type: 'RESEARCH_VERIFY', outcome: 'FAILED_RETRYABLE', n: 5 },
    ];
    const unfit = unfitPairs(rows, ['small', 'large']);
    expect([...unfit]).toEqual(['small|RESEARCH_AUDIT']);
    // Too few rejections to judge: nothing is marked.
    expect(unfitPairs([{ model: 'small', work_type: 'RESEARCH_AUDIT', outcome: 'FAILED_RETRYABLE', n: 3 }], ['small', 'large']).size).toBe(0);
    // An outage recorded as a failure is not the model's answer.
    const outage = [{ model: 'small', work_type: 'RESEARCH_AUDIT', outcome: 'FAILED_RETRYABLE', n: 9, reason: 'model small: threw: The database pool had no free connection within 10000ms' }];
    expect(unfitPairs(outage, ['small', 'large']).size).toBe(0);
    // A call that never reached the model, or pages nobody could open, judge no answer.
    const unanswered = [
      { model: 'gpu', work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', n: 9, reason: "model gpu: model call failed [broken GPU]: GPU slot's own calls failing; the fallback then said: cheap lane HTTP 400" },
      { model: 'gpu', work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', n: 9, reason: 'model gpu: no readable source among 12 candidate page(s): {"HTTP_ERROR":12} the site answered 404' },
    ];
    expect(unfitPairs(unanswered, ['gpu', 'large']).size).toBe(0);
    const rejected = [{ model: 'gpu', work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', n: 9, reason: "model gpu: the answer did not survive Brain's own checks: 0 claim(s) offered, dropped {}" }];
    expect([...unfitPairs(rejected, ['gpu', 'large'])]).toEqual(['gpu|RESEARCH_FRAGMENT']);
    // A GPU slot answering through 'large' is 'large': held back with it, and no alternative to it.
    const viaFallback = [
      { model: 'a', work_type: 'RESEARCH_AUDIT', outcome: 'FAILED_RETRYABLE', n: 6 },
      { model: 'gpu', work_type: 'RESEARCH_AUDIT', outcome: 'SUBMITTED', n: 6 },
    ];
    expect([...unfitPairs(viaFallback, ['a', 'b', 'gpu'])]).toEqual(['a|RESEARCH_AUDIT']);
    expect([...unfitPairs(viaFallback, ['a', 'gpu'], { gpu: 'a' })]).toEqual([]);
    expect([...unfitPairs(viaFallback, ['a', 'b', 'gpu'], { gpu: 'a' })].sort()).toEqual(['a|RESEARCH_AUDIT', 'gpu|RESEARCH_AUDIT']);
  });

  it('takes the work anyway when the only other model’s route is down', async () => {
    const { heldBackFor } = await import('../server/services/freeLane/worker.ts');
    const unfit = new Set(['gpu|RESEARCH_FRAGMENT']);
    const healthy = () => null;
    const free429 = (m: string) => (m === 'free' ? 'model route failing (provider availability)' : null);
    expect(heldBackFor('gpu', 'RESEARCH_FRAGMENT', ['gpu', 'free'], unfit, healthy)).toBe(true);
    expect(heldBackFor('gpu', 'RESEARCH_FRAGMENT', ['gpu', 'free'], unfit, free429)).toBe(false);
    // The item cooling down for the other model after its 429s: it cannot take it either.
    const freeCooling = (m: string) => (m === 'free' ? 'cooling down after a provider failure' : null);
    expect(heldBackFor('gpu', 'RESEARCH_FRAGMENT', ['gpu', 'free'], unfit, freeCooling)).toBe(false);
    expect(heldBackFor('gpu', 'RESEARCH_FRAGMENT', ['gpu'], unfit, healthy)).toBe(false);
    expect(heldBackFor('free', 'RESEARCH_FRAGMENT', ['gpu', 'free'], unfit, healthy)).toBe(false);
  });

  it('judges a pair on its latest answers, so rejections from before a fix stop holding it back (2026-11-17)', async () => {
    const { recentAnswers, unfitPairs, RECENT_ANSWERS } = await import('../server/services/freeLane/worker.ts');
    const ok = { reason: 'model gpu: 3 claims', work_type: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED' };
    const bad = { reason: 'model gpu: answers rejected', work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE' };
    const outage = { reason: 'model gpu: model call failed', work_type: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE' };
    // Newest first: two accepted answers after the fix, thirty rejections before it.
    const after = [ok, ok, ...Array(30).fill(bad)];
    expect(unfitPairs(recentAnswers(Array(30).fill(bad)), ['gpu', 'free']).has('gpu|RESEARCH_FRAGMENT')).toBe(true);
    expect(unfitPairs(recentAnswers(after), ['gpu', 'free']).size).toBe(0);
    const judged = recentAnswers(after).reduce((n, r) => n + r.n, 0);
    expect(judged).toBe(RECENT_ANSWERS);
    // An outage is not the model's answer and does not use up the window.
    const withOutage = recentAnswers([outage, outage, ok, ok, ...Array(30).fill(bad)]);
    expect(withOutage.reduce((n, r) => n + r.n, 0)).toBe(RECENT_ANSWERS + 2);
  });

  it('gives a held pair one re-probe item per interval', async () => {
    const { pairProbeDue, takePairProbe, resetFreeLaneFitness, PAIR_REPROBE_MS } = await import('../server/services/freeLane/worker.ts');
    resetFreeLaneFitness();
    const t = 1_000_000_000_000;
    expect(pairProbeDue('gpu', 'RESEARCH_FRAGMENT', t)).toBe(true);
    takePairProbe('gpu', 'RESEARCH_FRAGMENT', t);
    expect(pairProbeDue('gpu', 'RESEARCH_FRAGMENT', t + 60_000)).toBe(false);
    expect(pairProbeDue('gpu', 'RESEARCH_AUDIT', t + 60_000)).toBe(true);
    expect(pairProbeDue('gpu', 'RESEARCH_FRAGMENT', t + PAIR_REPROBE_MS)).toBe(true);
  });
});

describe('gpt-oss-120b refusals (production, 2026-11-16)', () => {
  it('tells a model that listed no claims what partial evidence is, and never that an empty list is fine', () => {
    const prompt = emptyListRepair('BRIEF', 5, 'L1');
    expect(prompt).toContain('listed no claims from the 5 source(s)');
    expect(prompt).toContain(PARTIAL_EVIDENCE);
    expect(prompt).toContain('"evidence_lane":"L1"');
    expect(prompt).toContain('only if no sentence in any source bears on the brief at all');
  });

  it('asks a model that lists no claims to name why, and records its words instead of an empty drop map (W13)', () => {
    const prompt = emptyListRepair('BRIEF', 5, 'L1');
    expect(prompt).toContain('{"claims":[],"none_because":"…"}');
    expect(prompt).toContain('the sources are about something else');
    // Production 2026-11-17 08:50Z: the reply after #998's re-ask over five read pages, now with each page's class.
    const pages = ['https://www.agriculture.pa.gov/x', 'https://acme-farm-supply.com/pricing', 'https://en.wikipedia.org/wiki/Farm', 'https://blog.example.com/a', 'https://shop.example.net/b'];
    expect(droppedReason(0, {}, pages, { claims: [] })).toBe(
      'the answer did not survive Brain\'s own checks: 0 claim(s) offered, dropped {} from 5 source(s) ' +
        '{"official":1,"commercial":3,"reference":1}; the reply was {"claims":[]}',
    );
    const stated = { claims: [], none_because: 'SOURCE 1-5 are vendor\n pricing pages; the brief excludes vendor marketing pages.' };
    expect(droppedReason(0, {}, pages.slice(1, 2), stated)).toBe(
      'the answer did not survive Brain\'s own checks: 0 claim(s) offered, dropped {} from 1 source(s) {"commercial":1}; ' +
        'the model listed none because: SOURCE 1-5 are vendor pricing pages; the brief excludes vendor marketing pages.',
    );
    // A model that listed claims the checks dropped is reported as before, with the reasons by count.
    const dropped = { 'citation not readable as sentence numbers (evidence_locator="Entire site content")': 1 };
    expect(droppedReason(1, dropped, pages, stated)).toBe(
      `the answer did not survive Brain's own checks: 1 claim(s) offered, dropped ${JSON.stringify(dropped)}`,
    );
  });

  it('reads a stated reason under the keys a model uses, bounded and without a credential', () => {
    expect(noneBecause({ claims: [], reason: 'nothing on Pennsylvania' })).toBe('nothing on Pennsylvania');
    expect(noneBecause({ claims: [], why: '  ' })).toBeNull();
    expect(noneBecause({ claims: [] })).toBeNull();
    expect(noneBecause({ claims: [], none_because: 'x'.repeat(500) })).toHaveLength(240);
    expect(noneBecause({ claims: [], none_because: 'page said api_key=abcdefghijklmnop1234' })).not.toContain('abcdefghijklmnop1234');
  });

  it('keeps a synthesis within the list limit, inline citations first, instead of refusing it whole', () => {
    const ids = Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => `clm_${String(i).padStart(3, '0')}`);
    const inline = ids.slice(-3);
    const kept = citedWithinLimit(`report citing [${inline.join('] [')}]`, [...ids, ids[0]!]);
    expect(kept).toHaveLength(MAX_LIST_ITEMS);
    expect(kept.slice(0, 3)).toEqual(inline);
    expect(new Set(kept).size).toBe(kept.length);
    expect(citedWithinLimit('r', ['a', 'b', 'a'])).toEqual(['a', 'b']);
  });
});

describe('a check is answered by a different model than produced it, whatever the slot is called (production, 2026-11-20)', () => {
  /*
   * The pod behind `runpod/openai/gpt-oss-120b` was stopped (budget window ended),
   * so every call on that slot was answered by its fallback `auto/best-coding` —
   * slot B's own model. Fragments found by `auto/best-coding` were then verified
   * by `auto/best-coding`, and the capacity reading still said gpt-oss-120b.
   */
  const GPU = 'runpod/openai/gpt-oss-120b';
  const FREE = 'auto/best-coding';
  const GPU_CONFIG: LaneConfig = {
    url: 'http://lane.test/v1',
    key: null,
    models: [GPU, FREE],
    dailyBudget: 100,
    timeoutMs: 1000,
    runpod: { url: 'https://pod.test/v1', key: null, model: 'openai/gpt-oss-120b', label: GPU },
    fallbackModel: FREE,
  };

  /** The lane's route, as `httpCompleter` routes it: a paused GPU slot is answered by the fallback, which says so. */
  async function routed(): Promise<{ completer: Completer; answeredBy: string[] }> {
    const { runpodPaused } = await import('../server/services/cheap/runpod.ts');
    const inner = model().completer;
    const answeredBy: string[] = [];
    const completer: Completer = async (config, name, system, prompt, options) => {
      const served = name === GPU && runpodPaused() ? FREE : name;
      answeredBy.push(served);
      const text = await inner(config, served, system, prompt, options);
      options?.onServed?.(served);
      return text;
    };
    return { completer, answeredBy };
  }

  async function fragmentFoundWhilePaused(): Promise<{ verifyId: string; fragmentId: string }> {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    const { completer } = await routed();
    const tick = await freeLaneTick({ config: GPU_CONFIG, completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_FRAGMENT']).toBe(1);
    const verify = await getDb().get<{ id: string }>("SELECT id FROM work_items WHERE orchestration_id = ? AND work_type = 'RESEARCH_VERIFY'", [orchestration.id]);
    return { verifyId: verify!.id, fragmentId: fragment.id };
  }

  beforeEach(async () => {
    const { resetRunpod, setRunpodPaused } = await import('../server/services/cheap/runpod.ts');
    resetRunpod();
    setRunpodPaused('pod stopped: budget window ended');
  });

  it('records the model that actually answered the GPU slot, and does not verify with it', async () => {
    const { verifyId } = await fragmentFoundWhilePaused();
    // The fragment's row names the model that answered, not only the slot.
    const row = await getDb().get<{ reason: string; measures: string }>(
      "SELECT e.reason, e.measures FROM bin_events e JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND w.work_type = 'RESEARCH_FRAGMENT' AND e.outcome = 'SUBMITTED' ORDER BY e.at DESC LIMIT 1",
    );
    expect(row!.reason).toBe(`model ${GPU}`);
    expect(JSON.parse(row!.measures)['servedBy']).toEqual([FREE]);

    // Slot B is the same model: the verification is not taken by it, nor by the GPU slot's spillover.
    const second = await routed();
    const tick = await freeLaneTick({ config: GPU_CONFIG, completer: second.completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_VERIFY']).toBeUndefined();
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(GPU_CONFIG);
    for (const index of [0, 1]) {
      const spill = await takeOne({ workers, worker: workers[index]!, index, spillover: true, completer: second.completer, fetchSource, search: async () => [], config: GPU_CONFIG });
      expect(spill.claimed).toBeNull();
    }
    expect(second.answeredBy).toEqual([]);
    expect((await getWorkItem(verifyId))?.state).toBe('QUEUED');
  });

  it('checks it with the GPU once the GPU itself answers', async () => {
    const { verifyId } = await fragmentFoundWhilePaused();
    const { setRunpodPaused } = await import('../server/services/cheap/runpod.ts');
    setRunpodPaused(null);
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(GPU_CONFIG);
    const gpu = await routed();
    const taken = await takeOne({ workers, worker: workers[0]!, index: 0, spillover: true, completer: gpu.completer, fetchSource, search: async () => [], config: GPU_CONFIG });
    expect(taken.claimed?.workItemId).toBe(verifyId);
    expect(taken.ok).toBe(true);
    expect(new Set(gpu.answeredBy)).toEqual(new Set([GPU]));
  });

  it('routes the check to a configured alternate free model that did not produce it', async () => {
    const { verifyId } = await fragmentFoundWhilePaused();
    const withAlternate: LaneConfig = { ...GPU_CONFIG, alternateModel: 'auto' };
    const second = await routed();
    const tick = await freeLaneTick({ config: withAlternate, completer: second.completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_VERIFY']).toBe(1);
    expect(tick.submitted).toBe(1);
    expect(second.answeredBy.length).toBeGreaterThan(0);
    expect(second.answeredBy.every((name) => name === 'auto')).toBe(true);
    expect((await getWorkItem(verifyId))?.state).toBe('SUCCEEDED');
    const row = await getDb().get<{ reason: string; measures: string }>(
      "SELECT reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND work_item_id = ? ORDER BY at DESC LIMIT 1",
      [verifyId],
    );
    expect(row!.reason).toBe('model auto');
    expect(JSON.parse(row!.measures)['servedBy']).toEqual(['auto']);
  });

  it('holds a check whose own model is the one that found the claim, when the other model is failing', async () => {
    const { orchestration, fragment } = await packet(play.project.id);
    await enqueue(play.project.id, 'RESEARCH_FRAGMENT', orchestration, fragment);
    await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    const verifyId = (await getDb().get<{ id: string }>("SELECT id FROM work_items WHERE orchestration_id = ? AND work_type = 'RESEARCH_VERIFY'", [orchestration.id]))!.id;
    // brain-a found it; brain-b, which would check it, is failing.
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_AUDIT', outcome: 'SUBMITTED', reason: 'model brain-b: ok' });
    for (let i = 0; i < 9; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_AUDIT', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-b: model call failed: cheap lane HTTP 503' });
    }
    const tick = await freeLaneTick({ config: CONFIG, completer: model().completer, fetchSource, search: async () => [] });
    expect(tick.byType['RESEARCH_VERIFY']).toBeUndefined();
    expect((await getWorkItem(verifyId))?.state).toBe('QUEUED');
  });

  it('voids an answer a producer gave after all (the GPU failing over mid-check)', async () => {
    await fragmentFoundWhilePaused();
    const { setRunpodPaused } = await import('../server/services/cheap/runpod.ts');
    setRunpodPaused(null);
    const { takeOne } = await import('../server/services/freeLane/worker.ts');
    const workers = await ensureFreeWorkers(GPU_CONFIG);
    const inner = model().completer;
    // Admitted while the GPU answered; the call itself was answered by the fallback.
    const failedOver: Completer = async (config, name, system, prompt, options) => {
      const text = await inner(config, FREE, system, prompt, options);
      options?.onServed?.(FREE);
      return text;
    };
    const taken = await takeOne({ workers, worker: workers[0]!, index: 0, spillover: true, completer: failedOver, fetchSource, search: async () => [], config: GPU_CONFIG });
    expect(taken.claimed).not.toBeNull();
    expect(taken.ok).toBe(false);
    expect((await getWorkItem(taken.claimed!.workItemId))?.state).toBe('QUEUED');
  });

  it('names the model that actually answers a slot in the lane reading', async () => {
    const { routeLabel, servedRoute } = await import('../server/services/cheap/lane.ts');
    expect(servedRoute(GPU_CONFIG, GPU)).toEqual({ model: FREE, why: 'pod paused' });
    expect(routeLabel(GPU_CONFIG, GPU)).toBe(`${GPU} → ${FREE} (pod paused)`);
    expect(routeLabel(GPU_CONFIG, FREE)).toBe(FREE);
    const { setRunpodPaused } = await import('../server/services/cheap/runpod.ts');
    setRunpodPaused(null);
    expect(routeLabel(GPU_CONFIG, GPU)).toBe(GPU);
  });
});
