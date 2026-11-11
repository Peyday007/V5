/**
 * CAP-16-3: every one of the six stages the spec names is measured from its own
 * rows — not only the two the free lane runs. Source ingestion from
 * `feed_pulls`, parsing and indexing from `extraction_runs`, graph / detection /
 * quant computation from `feed_detections`, `feed_item_coverage` and
 * `scenario_runs`, and commercial execution from `cash_actions` and
 * `cash_needs`. A measure a stage's rows genuinely cannot give still says why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordFeedPull } from '../server/repos/feeds.ts';
import { STAGES, stageCapacity, type StageReading } from '../server/services/freeLane/stageCapacity.ts';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('stageCapacity measures every stage from its own rows', () => {
  let fixture: TestProject;

  beforeEach(async () => {
    fixture = await freshProject();
  });

  afterEach(async () => {
    await teardown();
  });

  async function report(now: number): Promise<Record<string, StageReading>> {
    const result = await stageCapacity({ hours: 2, now });
    return Object.fromEntries(result.stages.map((s) => [s.stage, s]));
  }

  it('leaves no stage without a measured throughput, even on an empty database', async () => {
    const stages = await report(Date.now());
    expect(Object.keys(stages)).toEqual(STAGES.map((s) => s.id));
    for (const stage of Object.values(stages)) {
      expect(stage.itemsProcessedPerHour, stage.stage).toEqual({ measured: true, value: 0 });
      expect(stage.uniqueUsableFacts.measured, stage.stage).toBe(true);
      expect(stage.droppedOrDuplicate.measured, stage.stage).toBe(true);
    }
  });

  it('measures source ingestion from feed_pulls: new records, records already held, failed pulls', async () => {
    const now = Date.now();
    await recordFeedPull({ source: 'a', ok: true, fetched: 10, inserted: 7, error: null, at: iso(now - 60_000) });
    await recordFeedPull({ source: 'b', ok: true, fetched: 4, inserted: 4, error: null, at: iso(now - 60_000) });
    await recordFeedPull({ source: 'c', ok: false, fetched: 0, inserted: 0, error: 'HTTP 503', at: iso(now - 60_000) });
    // Outside the two-hour window.
    await recordFeedPull({ source: 'a', ok: true, fetched: 99, inserted: 99, error: null, at: iso(now - 5 * 3_600_000) });

    const s = (await report(now))['source-ingestion']!;
    expect(s.measuredFrom).toEqual(['feed_pulls']);
    expect(s.itemsProcessedPerHour).toEqual({ measured: true, value: 3 / 2 });
    expect(s.uniqueUsableFacts).toEqual({ measured: true, value: 11 });
    expect(s.droppedOrDuplicate).toEqual({ measured: true, value: 3 });
    expect(s.providerFailures).toEqual({ measured: true, value: 1 });
    expect(s.accepted).toBe(2);
    expect(s.queueSize.measured).toBe(false);
  });

  it('measures parsing and indexing from extraction_runs: queue, usable, failed, duplicate and elapsed', async () => {
    const now = Date.now();
    const docA = await addDocument(fixture, fixture.layers[0]!.name, 'v1.0', { withFile: false });
    const docB = await addDocument(fixture, fixture.layers[0]!.name, 'v1.1', { withFile: false });
    const run = (id: string, documentId: string, status: string, hash: string | null, createdMs: number, startedMs: number | null, completedMs: number | null) =>
      getDb().run(
        `INSERT INTO extraction_runs (id, document_id, project_id, status, pipeline_version, source_hash, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'p1', ?, ?, ?, ?, ?)`,
        [id, documentId, fixture.project.id, status, hash, startedMs === null ? null : iso(startedMs), completedMs === null ? null : iso(completedMs), iso(createdMs), iso(createdMs)],
      );
    await run('ext_old', docA.id, 'READY', 'h1', now - 10 * 3_600_000, now - 10 * 3_600_000, now - 10 * 3_600_000 + 1000);
    await run('ext_dup', docA.id, 'READY', 'h1', now - 30 * 60_000, now - 30 * 60_000, now - 30 * 60_000 + 2000);
    await run('ext_ok', docB.id, 'READY_WITH_WARNINGS', 'h2', now - 20 * 60_000, now - 20 * 60_000, now - 20 * 60_000 + 3000);
    await run('ext_fail', docB.id, 'FAILED', 'h3', now - 10 * 60_000, now - 10 * 60_000, now - 10 * 60_000 + 500);
    await run('ext_q', docB.id, 'QUEUED', null, now - 45 * 60_000, null, null);

    const s = (await report(now))['parsing-indexing']!;
    expect(s.measuredFrom).toEqual(['extraction_runs']);
    expect(s.queueSize).toEqual({ measured: true, value: 1 });
    expect(s.oldestUsefulItemMinutes).toEqual({ measured: true, value: 45 });
    expect(s.itemsProcessedPerHour).toEqual({ measured: true, value: 3 / 2 });
    expect(s.accepted).toBe(2);
    expect(s.uniqueUsableFacts).toEqual({ measured: true, value: 2 });
    // One failed run, and one run over bytes an earlier run already read.
    expect(s.droppedOrDuplicate).toEqual({ measured: true, value: 2 });
    expect(s.elapsedMs).toEqual({ measured: true, value: 5500 });
  });

  it('measures graph / detection / quant computation, including model calls the detectors avoided', async () => {
    const now = Date.now();
    const db = getDb();
    const detection = (id: string, group: string, mode: string, atMs: number) =>
      db.run(
        `INSERT INTO feed_detections (id, rule_id, rule_version, group_key, label, window_from, window_to, member_ids, source_urls, qualifiers, mode, detected_at, updated_at)
         VALUES (?, 'rule', 1, ?, 'l', ?, ?, '[]', '[]', '{}', ?, ?, ?)`,
        [id, group, iso(atMs), iso(atMs), mode, iso(atMs), iso(atMs)],
      );
    await detection('det_a', 'g1', 'ACTIVE', now - 60_000);
    await detection('det_s', 'g2', 'SHADOW', now - 60_000);
    const cover = (item: string, det: string, atMs: number) =>
      db.run('INSERT INTO feed_item_coverage (item_id, detection_id, covered_at) VALUES (?, ?, ?)', [item, det, iso(atMs)]);
    await cover('item1', 'det_a', now - 60_000);
    await cover('item2', 'det_a', now - 60_000);
    // Already covered before the window: not avoided again.
    await cover('item3', 'det_old', now - 10 * 3_600_000);
    await cover('item3', 'det_a', now - 60_000);

    await db.run(
      `INSERT INTO scenario_models (id, project_id, title, definition_json, definition_hash, created_by_id, created_at, updated_at)
       VALUES ('scm_1', ?, 't', '{}', 'dh', 'u', ?, ?)`,
      [fixture.project.id, iso(now), iso(now)],
    );
    const scenario = (id: string, state: string, configHash: string, digest: string | null, startedMs: number, elapsed: number) =>
      db.run(
        `INSERT INTO scenario_runs (id, model_id, project_id, seed, evaluations, config_json, config_hash, engine_version, state, result_digest, elapsed_ms, created_by_id, started_at, finished_at)
         VALUES (?, 'scm_1', ?, 1, 10, '{}', ?, 'e1', ?, ?, ?, 'u', ?, ?)`,
        [id, fixture.project.id, configHash, state, digest, elapsed, iso(startedMs), iso(startedMs + elapsed)],
      );
    await scenario('scr_1', 'COMPLETE', 'c1', 'd1', now - 50 * 60_000, 400);
    await scenario('scr_2', 'COMPLETE', 'c1', 'd1', now - 40 * 60_000, 300); // recomputed the same config
    await scenario('scr_3', 'FAILED', 'c2', null, now - 30 * 60_000, 100);

    const s = (await report(now))['graph-quant']!;
    expect(s.measuredFrom).toEqual(['feed_detections', 'feed_item_coverage', 'scenario_runs']);
    expect(s.itemsProcessedPerHour).toEqual({ measured: true, value: 5 / 2 });
    expect(s.accepted).toBe(3);
    // One ACTIVE detection and one distinct scenario result.
    expect(s.uniqueUsableFacts).toEqual({ measured: true, value: 2 });
    expect(s.droppedOrDuplicate).toEqual({ measured: true, value: 2 });
    expect(s.modelCallsAvoided).toEqual({ measured: true, value: 2 });
    expect(s.elapsedMs).toEqual({ measured: true, value: 800 });
  });

  it('measures commercial execution from cash_actions and the cash_needs waiting on a person', async () => {
    const now = Date.now();
    const db = getDb();
    await db.run(
      `INSERT INTO cash_authorities (id, project_id, owner_user_id, name, policy_version, allowed_actions, prohibitions, max_committed_cents,
         max_per_action_cents, max_concurrent, currency, starts_at, state, created_by_user_id, created_at, updated_at)
       VALUES ('cau_1', ?, 'u', 'a', 1, '[]', '[]', 0, 0, 1, 'USD', ?, 'ACTIVE', 'u', ?, ?)`,
      [fixture.project.id, iso(now), iso(now), iso(now)],
    );
    const action = (id: string, opportunity: string, atMs: number) =>
      db.run(
        `INSERT INTO cash_actions (id, project_id, opportunity_id, authority_id, action, performed_by, detail, confirmed_by, request_key, created_at)
         VALUES (?, ?, ?, 'cau_1', 'SEND', 'PERSON', 'd', 'u', ?, ?)`,
        [id, fixture.project.id, opportunity, id, iso(atMs)],
      );
    await action('cac_1', 'opp1', now - 60_000);
    await action('cac_2', 'opp1', now - 60_000);
    await action('cac_3', 'opp2', now - 60_000);
    const need = (id: string, state: string, createdMs: number, updatedMs: number) =>
      db.run(
        `INSERT INTO cash_needs (id, project_id, blocked_action, why_it_matters, recommended_path, setup_effort, next_step, state, created_at, updated_at)
         VALUES (?, ?, 'b', 'w', 'r', 's', 'n', ?, ?, ?)`,
        [id, fixture.project.id, state, iso(createdMs), iso(updatedMs)],
      );
    await need('cnd_open', 'OPEN', now - 90 * 60_000, now - 90 * 60_000);
    await need('cnd_gone', 'WITHDRAWN', now - 3 * 3_600_000, now - 30 * 60_000);

    const s = (await report(now))['commercial-execution']!;
    expect(s.measuredFrom).toEqual(['cash_actions', 'cash_needs']);
    expect(s.queueSize).toEqual({ measured: true, value: 1 });
    expect(s.oldestUsefulItemMinutes).toEqual({ measured: true, value: 90 });
    expect(s.itemsProcessedPerHour).toEqual({ measured: true, value: 3 / 2 });
    expect(s.uniqueUsableFacts).toEqual({ measured: true, value: 2 });
    expect(s.droppedOrDuplicate).toEqual({ measured: true, value: 1 });
    expect(s.accepted).toBe(3);
  });
});
