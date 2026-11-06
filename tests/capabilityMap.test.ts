/**
 * The capability map (§88): what a complete research system must do, and
 * Brain's own reading of whether it does.
 *
 * Owner's order, 2026-11-04: stop discovering predictable missing capabilities
 * through production failures. These pin that the map is whole (every stage,
 * every dependency resolvable, every owner on disk), that existing code is
 * never WORKING by existing, that the gap a whole process sits behind ranks
 * first, that a small objective pays for no audit, and that a gap reaches the
 * improvement loop once — not beside a detector that already raised it.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import {
  assessObjective,
  classify,
  connectedGaps,
  downstreamOf,
  gapsForImprovement,
  isSubstantial,
  mapsFor,
  PROBES,
  RESEARCH_MAP,
  RESEARCH_STAGES,
  type Assessed,
} from '../server/domain/capabilityMap.ts';
import { assessMap, capabilityWeaknesses, formatAssessment } from '../server/services/selfmodel/capabilities.ts';
import { assessLiveObjectives } from '../server/services/selfmodel/objectives.ts';

const req = (id: string) => RESEARCH_MAP.requirements.find((r) => r.id === id)!;

describe('the research map is whole', () => {
  it('covers every stage the owner named, and every reference resolves', () => {
    const stages = new Set(RESEARCH_MAP.requirements.map((r) => r.stage));
    for (const stage of RESEARCH_STAGES) expect(stages.has(stage), stage).toBe(true);
    const ids = new Set(RESEARCH_MAP.requirements.map((r) => r.id));
    expect(ids.size).toBe(RESEARCH_MAP.requirements.length);
    for (const r of RESEARCH_MAP.requirements) {
      for (const dep of r.dependsOn) expect(ids.has(dep), `${r.id} → ${dep}`).toBe(true);
      expect(PROBES).toContain(r.proof.probe);
      expect(r.inputs.length && r.outputs.length && r.failureConditions.length, r.id).toBeTruthy();
      // The owner is the existing module, not a plan for one.
      for (const owner of r.owner) expect(fs.existsSync(owner), `${r.id} owner ${owner}`).toBe(true);
    }
  });

  it('has no dependency cycle', () => {
    for (const r of RESEARCH_MAP.requirements) expect(downstreamOf(RESEARCH_MAP, r.id)).not.toContain(r.id);
  });
});

describe('classification: existing code is not working behaviour', () => {
  it('answers MISSING, UNPROVEN, BROKEN and WORKING from the owner and the reading only', () => {
    const r = req('ACCESS.READ');
    expect(classify(r, false, { ok: 90, total: 100, detail: '' }).status).toBe('MISSING');
    expect(classify(r, true, null).status).toBe('UNPROVEN');
    expect(classify(r, true, { ok: 3, total: 4, detail: '' }).status).toBe('UNPROVEN');
    expect(classify(r, true, { ok: 12, total: 37, detail: '' }).status).toBe('BROKEN');
    expect(classify(r, true, { ok: 30, total: 37, detail: '' }).status).toBe('WORKING');
  });

  it('ranks the gap a process sits behind first, and marks what is behind it', () => {
    const assessed: Assessed[] = RESEARCH_MAP.requirements.map((r) =>
      r.id === 'DISCOVERY.SEARCH'
        ? classify(r, false, { ok: 0, total: 89, detail: '' })
        : r.id === 'DISCOVERY.READABLE'
          ? classify(r, true, { ok: 49, total: 89, detail: '' })
          : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    const gaps = connectedGaps(RESEARCH_MAP, assessed);
    expect(gaps[0]!.id).toBe('DISCOVERY.SEARCH');
    expect(gaps[0]!.status).toBe('MISSING');
    const readable = gaps.find((g) => g.id === 'DISCOVERY.READABLE')!;
    expect(readable.behind).toEqual(['DISCOVERY.SEARCH']);
    // The free-lane detector already sees this failure class: it owns it, with its own
    // thresholds and recency test, and the map opens no second candidate.
    expect(gapsForImprovement(gaps, RESEARCH_MAP, [], 15)).toEqual([]);
  });

  it('routes to the loop only a gap no detector sees, once, and not one sitting behind another', () => {
    const assessed: Assessed[] = RESEARCH_MAP.requirements.map((r) =>
      r.id === 'RECOVERY.LEASES'
        ? classify(r, true, { ok: 10, total: 40, detail: '' })
        : r.id === 'DELIVERY.WRITEBACK'
          ? classify(r, true, { ok: 0, total: 30, detail: '' })
          : r.id === 'DECISION.JOB_OUTCOME'
            ? classify(r, true, { ok: 2, total: 30, detail: '' })
            : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    const gaps = connectedGaps(RESEARCH_MAP, assessed);
    const routed = gapsForImprovement(gaps, RESEARCH_MAP, [], 15).map((g) => g.gap.id);
    // Leases: nothing else detects it. Write-back sits behind the job-outcome gap, which the
    // packet detector owns — so neither is the map's to raise.
    expect(routed).toEqual(['RECOVERY.LEASES']);
    expect(gapsForImprovement(gaps, RESEARCH_MAP, ['CAPABILITY:RESEARCH.RECOVERY.LEASES#2'], 15)).toEqual([]);
  });
});

describe('reuse: an objective is assessed only when it is substantial', () => {
  it('skips a one-packet question and assesses a multi-outcome plan', () => {
    expect(isSubstantial({ text: 'What does the SBA count as a small business?' })).toBe(false);
    expect(isSubstantial({ text: 'x', budget: 3000 })).toBe(true);
    expect(isSubstantial({ text: 'Plan:\n1. research demand\n2. price it\n3. find buyers\n4. validate the market' })).toBe(true);
    expect(mapsFor({ text: 'Research the buyer market and validate demand' }).map((m) => m.key)).toEqual(['RESEARCH']);
    expect(mapsFor({ text: 'Rename the settings button' })).toEqual([]);

    const broken = RESEARCH_MAP.requirements.map((r) => classify(r, r.id !== 'DISCOVERY.SEARCH', { ok: 100, total: 100, detail: '' }));
    const small = assessObjective({ text: 'Is this price right?' }, { RESEARCH: broken });
    expect(small).toMatchObject({ substantial: false, ready: true, blocking: [] });
    const big = assessObjective({ text: 'Research demand for a $10K commercial plan', budget: 3000 }, { RESEARCH: broken });
    expect(big.substantial).toBe(true);
    expect(big.ready).toBe(false);
    expect(big.blocking.map((g) => g.id)).toEqual(['DISCOVERY.SEARCH']);
  });
});

describe('the assessor reads production rows', () => {
  beforeEach(async () => {
    await freshProject();
  });

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  async function laneItem(outcome: string, reason: string | null, measures?: Record<string, unknown>) {
    await recordBinEvent({
      eventType: 'FREE_LANE_ITEM',
      workloadClass: 'RESEARCH_FRAGMENT',
      outcome,
      reason,
      evidenceClass: 'MEASURED',
      ...(measures ? { measures } : {}),
    } as Parameters<typeof recordBinEvent>[0]);
  }

  it('reads discovery BROKEN when fragments fail for want of a readable source, and the loop gets the gap', async () => {
    for (let i = 0; i < 4; i += 1) await laneItem('SUBMITTED', 'model m', { discovery: { searched: 6, readFromSearch: 2, readFromModel: 0 } });
    for (let i = 0; i < 16; i += 1) {
      await laneItem('FAILED_RETRYABLE', 'model m: no readable source among 9 candidate page(s): {"HTTP_ERROR":9}', { discovery: { searched: 0, readFromSearch: 0, readFromModel: 0 } });
    }
    // Provider failures are not a discovery verdict.
    for (let i = 0; i < 5; i += 1) await laneItem('FAILED_RETRYABLE', 'model m: model call failed: cheap lane HTTP 429');
    const a = await assessMap(RESEARCH_MAP, { hours: 2, now: new Date(Date.now() + 1000) });
    const by = new Map(a.assessed.map((x) => [x.requirement.id, x]));
    expect(by.get('DISCOVERY.SEARCH')!.status).toBe('BROKEN');
    expect(by.get('DISCOVERY.SEARCH')!.reading).toMatchObject({ ok: 4, total: 20 });
    expect(by.get('DISCOVERY.READABLE')!.reading).toMatchObject({ ok: 4, total: 20 });
    expect(by.get('DISCOVERY.READABLE')!.status).toBe('BROKEN');
    // Nothing ran: unproven, not working.
    expect(by.get('ANALYSIS.AUDIT')!.status).toBe('UNPROVEN');
    expect(formatAssessment(a).join('\n')).toContain('CONNECTED GAPS');

    // The free-lane detector owns this class; the map adds no second candidate for it.
    expect((await capabilityWeaknesses(new Date(), [])).map((x) => x.key)).toEqual([]);
  });

  it('counts only judged claims when it asks whether rejections are explained', async () => {
    const a = await assessMap(RESEARCH_MAP, { hours: 24 });
    const explained = a.assessed.find((x) => x.requirement.id === 'VERIFICATION.REASONS')!;
    expect(explained.reading?.total).toBe(0);
    expect(explained.status).toBe('UNPROVEN');
  });

  it('records a substantial goal\'s blocking gaps once, and again only when they change', async () => {
    const db = getDb();
    const project = await db.get<{ id: string }>('SELECT id FROM projects LIMIT 1');
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at, capital_ceiling_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['wst_cap', project!.id, '$10K', 'Research demand and validate buyers for a $10K plan', 'REVENUE_DIRECT', now, now, 300000],
    );
    for (let i = 0; i < 20; i += 1) await laneItem('FAILED_RETRYABLE', 'model m: no readable source among 3 candidate page(s): {}');
    const first = await assessLiveObjectives({});
    expect(first).toHaveLength(1);
    expect(first[0]!.recorded).toBe(true);
    expect(first[0]!.assessment.blocking.map((g) => g.id)).toContain('DISCOVERY.SEARCH');
    const again = await assessLiveObjectives({});
    expect(again[0]!.recorded).toBe(false);
    const events = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_events WHERE event_type = 'CAPABILITY_ASSESSED' AND entity_id = 'wst_cap'",
    );
    expect(Number(events[0]!.n)).toBe(1);
  });
});

describe('every probe reads on a real schema', () => {
  beforeEach(async () => {
    await freshProject();
  });
  it('answers each probe without an error (an unreadable probe is UNPROVEN for the wrong reason)', async () => {
    const { readProbe } = await import('../server/services/selfmodel/capabilities.ts');
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 86_400_000).toISOString();
    for (const probe of PROBES) await expect(readProbe(probe, from, to), probe).resolves.toHaveProperty('total');
  });
});

describe('the goal-plan map: the whole $10K chain, connections included', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('is whole: every stage, every reference resolves, owners on disk, no cycle', async () => {
    const { GOAL_PLAN_MAP, GOAL_STAGES, CAPABILITY_MAPS } = await import('../server/domain/capabilityMap.ts');
    expect(CAPABILITY_MAPS['GOAL_PLAN']).toBe(GOAL_PLAN_MAP);
    const stages = new Set(GOAL_PLAN_MAP.requirements.map((r) => r.stage));
    for (const stage of GOAL_STAGES) expect(stages.has(stage), stage).toBe(true);
    const ids = new Set(GOAL_PLAN_MAP.requirements.map((r) => r.id));
    expect(ids.size).toBe(GOAL_PLAN_MAP.requirements.length);
    for (const r of GOAL_PLAN_MAP.requirements) {
      for (const dep of r.dependsOn) expect(ids.has(dep), `${r.id} → ${dep}`).toBe(true);
      expect(PROBES).toContain(r.proof.probe);
      for (const owner of r.owner) expect(fs.existsSync(owner), `${r.id} owner ${owner}`).toBe(true);
      expect(downstreamOf(GOAL_PLAN_MAP, r.id)).not.toContain(r.id);
    }
  });

  it('is the map a money goal starts with, beside research', () => {
    expect(mapsFor({ text: 'Collect 10000 dollars of settled cash within 30 days' }).map((m) => m.key)).toEqual(['RESEARCH', 'GOAL_PLAN']);
    expect(mapsFor({ text: 'Produce a $10K plan' }).map((m) => m.key)).toEqual(['RESEARCH', 'GOAL_PLAN']);
    expect(mapsFor({ text: 'Rename the settings button' })).toEqual([]);
  });

  it('reads a stalled planner, a dead GPU and a saturated database from the rows', async () => {
    const { GOAL_PLAN_MAP } = await import('../server/domain/capabilityMap.ts');
    const db = getDb();
    const project = await db.get<{ id: string }>('SELECT id FROM projects LIMIT 1');
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at, target_metric, target_project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['wst_goalmap', project!.id, '$10K', 'Collect 10000 dollars of settled cash', 'REVENUE_DIRECT', now, now, 'SETTLED_CASH', project!.id],
    );
    const lane = (outcome: string, reason: string) =>
      recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason, evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
    for (let i = 0; i < 6; i += 1) await lane('RELEASED_TRANSIENT', 'model runpod/Qwen/Qwen3-4B: model call failed: cheap lane HTTP 503');
    await recordBinEvent({ eventType: 'RUNPOD_POD', outcome: 'START_FAILED', reason: 'not enough free GPUs', evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
    for (let i = 0; i < 15; i += 1) await lane('RELEASED_TRANSIENT', 'model brain-a: threw: The database pool had no free connection within 10000ms');
    for (let i = 0; i < 10; i += 1) await lane('SUBMITTED', 'model brain-a');

    const a = await assessMap(GOAL_PLAN_MAP, { hours: 2, now: new Date(Date.now() + 1000) });
    const by = new Map(a.assessed.map((x) => [x.requirement.id, x]));
    // A live goal and no scenario run in two hours: the planner has stopped.
    expect(by.get('GOAL.PLAN_FRESH')).toMatchObject({ status: 'BROKEN', reading: { ok: 0, total: 1 } });
    expect(by.get('COMPUTE.GPU')).toMatchObject({ status: 'BROKEN', reading: { ok: 0, total: 7 } });
    expect(by.get('COMPUTE.DATABASE')).toMatchObject({ status: 'BROKEN', reading: { ok: 16, total: 31 } });
    expect(by.get('COMPUTE.FREE_MODELS')).toMatchObject({ status: 'WORKING', reading: { ok: 10, total: 10 } });
    // Nothing settled yet: unproven, not working.
    expect(by.get('CONSTRUCTION.ROUNDS_FILE')!.status).toBe('UNPROVEN');
    // The database sits under the plan: it ranks ahead of what depends on it.
    const gaps = a.gaps.filter((g) => g.status === 'BROKEN').map((g) => g.id);
    expect(gaps.indexOf('COMPUTE.DATABASE')).toBeLessThan(gaps.indexOf('GOAL.PLAN_FRESH'));
    expect(formatAssessment(a).join('\n')).toContain('MAP GOAL_PLAN');
  });
});

describe('the goal-plan map reaches the improvement loop', () => {
  it('routes a broken link no detector covers, and leaves a covered one to its detector', async () => {
    const { GOAL_PLAN_MAP } = await import('../server/domain/capabilityMap.ts');
    const assessed = GOAL_PLAN_MAP.requirements.map((r) =>
      r.id === 'EVIDENCE.PATH_ANSWERS' || r.id === 'EVIDENCE.PACKETS_COMPLETE'
        ? classify(r, true, { ok: 1, total: 40, detail: '' })
        : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    const routed = gapsForImprovement(connectedGaps(GOAL_PLAN_MAP, assessed), GOAL_PLAN_MAP, [], 15).map((g) => g.gap.id);
    // Path answers sit behind the packets, which the PACKETS: detector already owns.
    expect(routed).toEqual([]);
    const alone = GOAL_PLAN_MAP.requirements.map((r) =>
      r.id === 'EVIDENCE.PATH_ANSWERS' ? classify(r, true, { ok: 1, total: 40, detail: '' }) : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    expect(gapsForImprovement(connectedGaps(GOAL_PLAN_MAP, alone), GOAL_PLAN_MAP, [], 15).map((g) => g.gap.id)).toEqual(['EVIDENCE.PATH_ANSWERS']);
  });
});

describe('the automatic repair loop: a failed check produces repair work, a released repair is judged on itself', () => {
  beforeEach(async () => {
    await freshProject();
  });

  async function laneItem(outcome: string, reason: string | null) {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason, evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
  }

  it('routes the goal map’s root gap, the database, so a failed check is never silent', async () => {
    const { GOAL_PLAN_MAP } = await import('../server/domain/capabilityMap.ts');
    // Production 2026-11-06: COMPUTE.DATABASE BROKEN with ten links behind it, and no repair raised.
    const assessed = GOAL_PLAN_MAP.requirements.map((r) =>
      r.id === 'COMPUTE.DATABASE' ? classify(r, true, { ok: 1151, total: 1675, detail: '' }) : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    const routed = gapsForImprovement(connectedGaps(GOAL_PLAN_MAP, assessed), GOAL_PLAN_MAP, [], 15);
    expect(routed.map((g) => g.gap.id)).toEqual(['COMPUTE.DATABASE']);
    // Factory may release what it changes: nothing in the scope is reserved for a person.
    const { RELEASE_EXCLUDED_PATHS } = await import('../server/domain/factoryRelease.ts');
    for (const path of routed[0]!.route.mutationScope) {
      for (const reserved of RELEASE_EXCLUDED_PATHS) expect(path.startsWith(reserved.replace('/**', '/')) || path === reserved, `${path} is reserved`).toBe(false);
    }
  });

  it('routes a gap that sits behind an upstream gap nothing is fixing, and waits behind one that is in hand', async () => {
    const { GOAL_PLAN_MAP } = await import('../server/domain/capabilityMap.ts');
    // GOAL.PLAN_EVALUATED has no route; GOAL.PLAN_FRESH depends on it and has one.
    const assessed = GOAL_PLAN_MAP.requirements.map((r) =>
      r.id === 'GOAL.PLAN_EVALUATED' || r.id === 'GOAL.PLAN_FRESH'
        ? classify(r, true, { ok: 0, total: 40, detail: '' })
        : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    const gaps = connectedGaps(GOAL_PLAN_MAP, assessed);
    expect(gaps.find((g) => g.id === 'GOAL.PLAN_FRESH')!.behind).toContain('GOAL.PLAN_EVALUATED');
    expect(gapsForImprovement(gaps, GOAL_PLAN_MAP, [], 15).map((g) => g.gap.id)).toEqual(['GOAL.PLAN_FRESH']);
    // Behind the database while the database's own repair is open, it waits for that repair.
    const behindDb = GOAL_PLAN_MAP.requirements.map((r) =>
      r.id === 'COMPUTE.DATABASE' || r.id === 'EVIDENCE.PATH_ANSWERS'
        ? classify(r, true, { ok: 0, total: 40, detail: '' })
        : classify(r, true, { ok: 100, total: 100, detail: '' }),
    );
    expect(gapsForImprovement(connectedGaps(GOAL_PLAN_MAP, behindDb), GOAL_PLAN_MAP, ['CAPABILITY:GOAL_PLAN.COMPUTE.DATABASE'], 15)).toEqual([]);
  });

  it('judges the running release on its own attempts once it has the sample, and the day before that', async () => {
    const { GOAL_PLAN_MAP } = await import('../server/domain/capabilityMap.ts');
    const db = getDb();
    const lane = (outcome: string, reason: string) =>
      recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason, evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
    // The previous build: thirty attempts lost to the pool, three hours ago.
    for (let i = 0; i < 30; i += 1) await lane('RELEASED_TRANSIENT', 'model brain-a: threw: The database pool had no free connection within 10000ms');
    const before = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await db.run(`UPDATE bin_events SET at = ? WHERE event_type = 'FREE_LANE_ITEM'`, [before]);
    const release = new Date(Date.now() - 3_600_000);
    const dbReq = (a: Awaited<ReturnType<typeof assessMap>>) => a.assessed.find((x) => x.requirement.id === 'COMPUTE.DATABASE')!;

    // Only five attempts since the release: below the sample, so the day's reading stands.
    for (let i = 0; i < 5; i += 1) await lane('SUBMITTED', 'model brain-a');
    const early = await assessMap(GOAL_PLAN_MAP, { hours: 24, since: release, now: new Date(Date.now() + 1000) });
    expect(dbReq(early).status).toBe('BROKEN');

    // Twenty clean attempts since the release: the release is judged on itself, and raises no repair.
    for (let i = 0; i < 15; i += 1) await lane('SUBMITTED', 'model brain-a');
    const later = await assessMap(GOAL_PLAN_MAP, { hours: 24, since: release, now: new Date(Date.now() + 1000) });
    expect(dbReq(later)).toMatchObject({ status: 'WORKING', reading: { ok: 20, total: 20 } });
    expect(dbReq(later).reading!.detail).toContain('since the release');
    const day = await assessMap(GOAL_PLAN_MAP, { hours: 24, now: new Date(Date.now() + 1000) });
    expect(dbReq(day).status).toBe('BROKEN');
    const raised = await capabilityWeaknesses(new Date(Date.now() + 1000), [], release);
    expect(raised.map((w) => w.key)).not.toContain('CAPABILITY:GOAL_PLAN.COMPUTE.DATABASE');
    const unscoped = await capabilityWeaknesses(new Date(Date.now() + 1000), []);
    expect(unscoped.map((w) => w.key)).toContain('CAPABILITY:GOAL_PLAN.COMPUTE.DATABASE');
  });

  it('names the gaps a repair cleared from a goal, so its plan is read at once', async () => {
    const db = getDb();
    const project = await db.get<{ id: string }>('SELECT id FROM projects LIMIT 1');
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at, capital_ceiling_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['wst_rep', project!.id, '$10K', 'Research demand and validate buyers for a $10K plan', 'REVENUE_DIRECT', now, now, 300000],
    );
    for (let i = 0; i < 20; i += 1) await laneItem('FAILED_RETRYABLE', 'model m: no readable source among 3 candidate page(s): {}');
    const first = await assessLiveObjectives({});
    expect(first[0]!.assessment.blocking.map((g) => g.id)).toContain('DISCOVERY.SEARCH');
    expect(first[0]!.cleared).toEqual([]);
    // The repair is released: the failing rows are the previous build's.
    await db.run(`UPDATE bin_events SET at = ? WHERE event_type = 'FREE_LANE_ITEM'`, [new Date(Date.now() - 48 * 3_600_000).toISOString()]);
    const after = await assessLiveObjectives({});
    expect(after[0]!.recorded).toBe(true);
    expect(after[0]!.cleared).toContain('DISCOVERY.SEARCH');
    const payload = await db.get<{ payload: string }>(
      "SELECT payload FROM project_events WHERE event_type = 'CAPABILITY_ASSESSED' AND entity_id = 'wst_rep' ORDER BY created_at DESC LIMIT 1",
    );
    expect(JSON.parse(payload!.payload).cleared).toContain('DISCOVERY.SEARCH');
  });
});
