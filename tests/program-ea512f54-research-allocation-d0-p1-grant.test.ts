/**
 * RES-15-5 repair R2-F2: the research allocation's ADD_CAPACITY verdict is
 * applied, by the one owner of a free-lane model's target.
 *
 * The goals tick recorded `ADD_CAPACITY` for a `free-lane:<model>` lane when
 * queued qualified research waited on a measured limit, and nothing read it:
 * the §86 controller kept its own target. The controller now reads the newest
 * `RESEARCH_ALLOCATION_DECIDED` row and raises the model's target by the
 * granted units, once per decision, inside the headroom it measured itself and
 * under every cap it already had; the decision row says who applies it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import { recordImprovementEvent } from '../server/repos/improvement.ts';
import {
  GRANT_MAX_AGE_MS,
  applyGrant,
  controlStep,
  grantsFromDecision,
  readCapacity,
  slotShare,
  startAdaptivePool,
  stopAdaptivePool,
  type CapacityGrant,
} from '../server/services/freeLane/capacity.ts';
import { FREE_LANE_CONTROLLER, RESEARCH_ALLOCATION_DECIDED, latestResearchDecision, reallocateResearch, type ResearchAllocationPorts } from '../server/services/goals/tick.ts';
import { QUEUE_WAIT_CONSTRAINT_MS, RESEARCH_PURPOSES, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';
import type { ResearchYieldReading, YieldBucket } from '../server/services/goals/researchYield.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const calm = { db: false, lagMs: 5, cpu: 0.1 };
const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const PAGE = 'The median hourly wage for receptionists was $17.39 in May 2024. ' + 'Employment is projected to show little change through 2034. '.repeat(4);
let play: TestProject;
let inFlight = 0;
let peak = 0;

/** A model that takes a moment, so concurrency is observable. */
const completer: Completer = async (_c, _m, _s, prompt) => {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, 40));
  inFlight -= 1;
  if (prompt.includes('Name up to')) return JSON.stringify({ urls: ['https://www.bls.gov/x'] });
  const line = prompt.split('\n').find((one) => one.startsWith('[S') && one.includes('median hourly wage'));
  const ref = /\[S(\d+)\.(\d+)\]/.exec(line ?? '');
  return JSON.stringify({
    claims: [{ claim: 'US median receptionist wage was $17.39 an hour in May 2024.', claim_type: 'SOURCED_FACT', source: Number(ref?.[1]), sentences: [Number(ref?.[2])], evidence_lane: 'wage' }],
  });
};
const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
  retrievedAt: new Date().toISOString(), sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length,
});

async function queueFragments(n: number): Promise<void> {
  const layerId = (await play.layerByName('Monetization Logic')).id;
  for (let i = 0; i < n; i += 1) {
    const run = await createRun({ projectId: play.project.id, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${i}` });
    const orchestration = await createOrchestration({ projectId: play.project.id, layerId, runId: run.id, title: `Receptionist wage ${i}`, assignment: 'wage', provider: 'WORKER', autoApprove: false });
    const [fragment] = await createFragments([{
      orchestrationId: orchestration.id, projectId: play.project.id, layerId, fragmentIndex: 0, fragmentKey: `wage-${i}`,
      question: 'What is the US median hourly wage of a receptionist?', geography: 'United States', timeframe: '2024',
      population: 'Receptionists', definitions: 'Median hourly wage',
      requiredEvidence: [{ id: 'wage', description: 'official wage statistic', necessity: 'REQUIRED' }],
      acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: ['one figure'], dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
    }]);
    await createBin({
      projectId: play.project.id, kind: 'RESEARCH_PACKET', title: `Receptionist wage ${i}`, objective: 'wage', orchestrationId: orchestration.id,
      manifest: { objective: 'wage', why: 't', lineage: { projectId: play.project.id, layerId, goal: 'wage', orchestrationId: orchestration.id }, units: [], acceptableSources: [], excludedSources: [], evidence: [], outputs: [], authorizedActions: [], prohibitedActions: [], budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 60 }, stoppingConditions: [] },
      completionContract: 'RESEARCH_PACKET_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    const def = workType('RESEARCH_FRAGMENT');
    await enqueueWork({ projectId: play.project.id, workType: 'RESEARCH_FRAGMENT', payload: def.validate({}), requiredScopes: def.requiredScopes, orchestrationId: orchestration.id, fragmentId: fragment!.id, createdByType: 'SYSTEM' });
  }
}


/* The capacity suite's measured reading: a reliable, rate-limited free lane with actionable yield. */
function bucket(over: Partial<YieldBucket> = {}): YieldBucket {
  return {
    submissions: 0, completions: 0, inFlight: 0,
    failures: { total: 0, rateLimited: 0, other: 0, causes: [] },
    queueWait: { measured: 0, medianMs: null, p90Ms: null },
    acceptedClaims: 0, sourceQuality: { primary: 0, secondary: 0, unretrieved: 0, primaryShare: null },
    packetsFiled: 0, newMechanisms: 0, qualifiedPositions: 0, executableOffers: 0, paidTransactions: 0, usefulResults: 0,
    jobMs: 0, costMinor: null, uncostedJobs: 0, msPerUsefulResult: null, costMinorPerUsefulResult: null, utilization: 0,
    ...over,
  };
}

const LANE = 'free-lane:brain-a';

/** A lane that yields actionable links (so no remedy comes first), is rate limited, and is reliable enough to grow. */
function reading(): ResearchYieldReading {
  const purposes = Object.fromEntries([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].map((p) => [p, bucket()])) as Record<ResearchPurpose | 'UNATTRIBUTED', YieldBucket>;
  purposes.TRANSACTION_ROUTES = bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 });
  return {
    window: { since: '2026-11-13T00:00:00.000Z', until: '2026-11-14T00:00:00.000Z', ms: 86_400_000 },
    total: bucket({ submissions: 20, completions: 20, usefulResults: 12, jobMs: 3_600_000 }),
    lanes: {
      // 30 jobs already running and a 40-minute median wait for jobs that already started: neither is waiting work.
      [LANE]: bucket({ submissions: 60, completions: 54, acceptedClaims: 40, qualifiedPositions: 20, executableOffers: 10, jobMs: 3_600_000, failures: { total: 6, rateLimited: 6, other: 0, causes: [] }, inFlight: 30, queueWait: { measured: 30, medianMs: 40 * 60_000, p90Ms: 60 * 60_000 } }),
    },
    purposes,
    costCountedOnce: { jobs: 60, totalJobMs: 3_600_000, purposeJobMs: 3_600_000, totalCostMinor: null, purposeCostMinor: null, holds: true },
    attributions: [{ jobId: 'job_1', lane: LANE, purposes: ['TRANSACTION_ROUTES'], basis: ['deal bucket'] }],
    notes: [],
  };
}

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const decision = (capacity: unknown[], at = new Date(NOW - 10 * 60_000).toISOString(), fingerprint = 'fp-1') => ({ detail: { fingerprint, capacity }, at });
const add = (lane: string, units: number) => ({ lane, kind: 'ADD_CAPACITY', resource: 'MODEL_RATE_LIMIT', units, incrementalCost: 0, reason: `${units} slot(s) for queued research`, recommendationOnly: false });

describe('the verdict, read from the decision row', () => {
  it('yields a grant per free-lane ADD_CAPACITY and nothing else', () => {
    const grants = grantsFromDecision(decision([
      add('free-lane:brain-a', 3),
      { lane: 'free-lane:brain-b', kind: 'NO_CAPACITY', resource: null, units: 0, incrementalCost: 0, reason: 'nothing waits' },
      add('routine:claude', 2),
    ]), NOW);
    expect(grants).toEqual([{ model: 'brain-a', units: 3, fingerprint: 'fp-1', reason: '3 slot(s) for queued research', decidedAt: new Date(NOW - 10 * 60_000).toISOString() }]);
  });

  it('applies no stale, unfingerprinted or absent decision', () => {
    expect(grantsFromDecision(null, NOW)).toEqual([]);
    expect(grantsFromDecision(decision([add('free-lane:brain-a', 3)], new Date(NOW - GRANT_MAX_AGE_MS - 1).toISOString()), NOW)).toEqual([]);
    expect(grantsFromDecision({ detail: { capacity: [add('free-lane:brain-a', 3)] }, at: new Date(NOW).toISOString() }, NOW)).toEqual([]);
  });
});

describe('the controller applies a grant under its own measurements', () => {
  const grant: CapacityGrant = { model: 'brain-a', units: 3, fingerprint: 'fp-1', reason: 'queued', decidedAt: '' };
  const hold = { target: 4, reason: 'slots not filled (1 of 4 busy)', stable: true };

  it('raises a held target by the granted units, within measured sustainable concurrency', () => {
    const r = applyGrant({ target: 4, stableHigh: 20, decision: hold, grant });
    expect(r.applied).toBe(true);
    expect(r.decision.target).toBe(7);
    expect(r.decision.reason).toContain('(allocation fp-1)');
    expect(applyGrant({ target: 4, stableHigh: 5, decision: hold, grant }).decision.target).toBe(5);
    expect(applyGrant({ target: 4, stableHigh: 20, decision: hold, grant, ceiling: 6 }).decision.target).toBe(6);
  });

  it('never overrides a shrink, and never lowers a larger grow', () => {
    const shrink = { target: 2, reason: 'provider overloaded', stable: false };
    expect(applyGrant({ target: 4, stableHigh: 20, decision: shrink, grant })).toEqual({ decision: shrink, applied: false });
    const grow = { target: 8, reason: 'useful research waiting', stable: true };
    expect(applyGrant({ target: 4, stableHigh: 20, decision: grow, grant })).toEqual({ decision: grow, applied: false });
    expect(applyGrant({ target: 4, stableHigh: 20, decision: hold, grant: null })).toEqual({ decision: hold, applied: false });
  });
});

beforeEach(async () => {
  play = await freshProject();
  await setBrainOnlyMode(true, 'test', 'grant suite');
  inFlight = 0;
  peak = 0;
});
afterEach(() => stopAdaptivePool());

describe('a recorded ADD_CAPACITY reaches the running pool', () => {
  it('raises the model\'s target once per decision, and not again after a restart', async () => {
    await queueFragments(12);
    await getDb().run('DELETE FROM free_lane_capacity', []);
    // Learned before: brain-a sustained 20 at once; it resumes at half of its saved 8.
    await getDb().run("INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 8, 20, '2026-11-14T00:00:00Z', 't'), ('brain-b', 8, 20, '2026-11-14T00:00:00Z', 't')", []);
    // The allocation's own row: brain-a's queued research is held by a measured limit.
    await recordImprovementEvent({ candidateId: null, kind: RESEARCH_ALLOCATION_DECIDED, detail: { fingerprint: 'fp-grant', capacity: [add('free-lane:brain-a', 3)] } });
    expect(grantsFromDecision(await latestResearchDecision())).toHaveLength(1);
    // Contended connections make the controller hold rather than grow, so only the grant can move brain-a.
    const contended = { ...calm, dbContended: true };
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => contended }, 60_000);
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    const targets = async () => new Map((await readCapacity()).map((r) => [r.model, r.target]));
    // The lane's share of the database pool still bounds the step (Postgres has one; SQLite has none).
    const share = slotShare(2);
    const capped = (n: number): number => (share === null ? n : Math.min(n, share));
    expect((await targets()).get('brain-a')).toBe(capped(7));
    expect((await targets()).get('brain-b')).toBe(capped(4));
    const applied = async () => Number((await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class = 'brain-a' AND reason LIKE '%(allocation fp-grant)%'", []))?.n ?? 0);
    expect(await applied()).toBe(1);
    // Applied once: the next step holds at what the controller now runs.
    await controlStep();
    expect((await targets()).get('brain-a')).toBe(capped(7));
    expect(await applied()).toBe(1);
    // A restart forgets nothing: the row says the decision was already applied.
    stopAdaptivePool();
    startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => contended }, 60_000);
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    expect(await applied()).toBe(1);
  }, 60_000);
});

describe('the decision row says the free lane applies it', () => {
  it('marks a free-lane ADD_CAPACITY as applied by its controller, and any other verdict as a recommendation', async () => {
    const decisions: Record<string, unknown>[] = [];
    const ports: ResearchAllocationPorts = {
      readYield: async () => reading(),
      readLaneCapacity: async () => [{ lane: 'free-lane:brain-a', queued: 7, queueWaitMs: QUEUE_WAIT_CONSTRAINT_MS + 60_000, quotaHeadroom: 3, incrementalCostPerUnit: 0, basis: ['test'] }],
      lastDecision: async () => null,
      recordDecision: async (_s, detail) => { decisions.push(detail); },
    };
    const goal = { id: 'wst_a', projectId: 'prj_1', lifecycle: 'ACTIVE', dueAt: null, target: null } as never;
    const report = await reallocateResearch({ goals: [goal], now: '2026-11-14T00:00:00.000Z' }, ports);
    const verdicts = decisions[0]!.capacity as { lane: string; kind: string; recommendationOnly: boolean; appliedBy?: string }[];
    expect(verdicts.some((v) => v.kind === 'ADD_CAPACITY' && v.lane === 'free-lane:brain-a')).toBe(true);
    for (const v of verdicts) {
      if (v.kind === 'ADD_CAPACITY' && v.lane.startsWith('free-lane:')) {
        expect(v.recommendationOnly).toBe(false);
        expect(v.appliedBy).toBe(FREE_LANE_CONTROLLER);
      } else {
        expect(v.recommendationOnly).toBe(true);
        expect(v.appliedBy).toBeUndefined();
      }
    }
    expect(report.capacity.length).toBe(verdicts.length);
  });
});
