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
