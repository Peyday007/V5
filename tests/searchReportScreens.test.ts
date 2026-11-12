/**
 * The search report shows the AI usage learned detectors actually avoid.
 *
 * Before this, a detector the feed run proposed from the cheap lane's agreed
 * screen answers carried no search method, so `recordLearnedPass` recorded no
 * CODE run and the report counted only Claude's bucket runs, while the screens
 * its ACTIVE coverage skipped were counted only in `detectionReading`. The
 * owner's cash-goal report (`runSearchCli report --project P`) then read
 * "0 did not" and "turned into code: none" with detectors skipping screens.
 *
 * These tests write only what production writes — feed items and SCREEN_LEAD
 * answers — call nothing but `runDetectors()` and the report entry, and read
 * the report a project sees.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createLearnedDetector } from '../server/repos/searchMethods.ts';
import { DELIVERABLE_KINDS } from '../server/services/cash/deliverables/spec.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { MIN_JUDGED_FOR_PROMOTION } from '../server/services/feeds/learned.ts';
import { readerForProject } from '../server/services/research/searchMethods/bucketMethods.ts';
import { buildSearchReport, renderSearchReport } from '../server/services/research/searchReport/report.ts';
import { runSearchCli } from '../server/services/research/searchReport/cli.ts';

const KIND = DELIVERABLE_KINDS[0]!;
let seq = 0;
let projectId = '';

async function screened(title: string, answers: readonly ('KEEP' | 'DROP')[]): Promise<string> {
  const ext = `s${seq++}`;
  await insertFeedItems('jobs', [{ externalId: ext, url: `https://x.test/${ext}`, title, body: null, organization: null, publishedAt: null }]);
  const row = await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE external_id = ?', [ext]);
  const id = row!.id;
  for (const [i, verdict] of answers.entries()) {
    const output = JSON.stringify({ verdict, window: 'SHORT', deliverable: verdict === 'KEEP' ? KIND : 'NONE', need: 'a stated need', payer: '', reason: 'r' });
    await getDb().run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
      [`cr_${id}_${i}`, `h_${id}`, id, `model-${i}`, output, new Date().toISOString()],
    );
  }
  return id;
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  seq = 0;
});

describe('AI usage avoided, as the project report reads it', () => {
  it('a screen-proposed detector serves a GENERAL method, runs by code, and its skipped screens are counted', async () => {
    for (const t of ['Welding fabricator needed now', 'Senior welding fabricator role', 'Welding fabricator for trailers']) await screened(t, ['KEEP', 'KEEP']);
    await screened('Pastry chef wanted', ['DROP', 'DROP']);
    await runDetectors();
    for (let i = 0; i < MIN_JUDGED_FOR_PROMOTION; i++) await screened(`Welding fabricator job ${i}`, ['KEEP', 'KEEP']);
    await runDetectors();
    const detector = await getDb().get<{ method_id: string | null; mode: string; detector_key: string }>('SELECT method_id, mode, detector_key FROM learned_detectors');
    expect(detector?.mode).toBe('ACTIVE');
    expect(detector?.method_id).toBeTruthy();

    // Two new items the ACTIVE detector covers; no screen is ever asked about them.
    await screened('Welding fabricator urgently needed', []);
    await screened('Welding fabricator night shift', []);
    await runDetectors();

    const report = await buildSearchReport(readerForProject(projectId));
    const line = report.methods.find((m) => m.methodKey === detector!.detector_key);
    expect(line).toMatchObject({ automatic: true, aiJobsConsumed: 0 });
    expect(line!.aiJobsAvoided).toBeGreaterThan(0);
    expect(line!.screensAvoided).toBe(2);
    expect(report.aiUsage.avoided).toBeGreaterThan(0);
    expect(report.aiUsage.screensAvoided).toBe(2);
    expect(report.counts.automatic).toBeGreaterThanOrEqual(1);
    expect(report.turnedIntoCode).toContainEqual({ methodKey: detector!.detector_key, detectorKey: detector!.detector_key, mode: 'ACTIVE' });

    const printed = await runSearchCli(['report', '--project', projectId], { downstream: async () => new Map() });
    expect(printed.out).toContain('free-model screens skipped by active learned detectors: 2');
    expect(printed.out).not.toContain('turned into code: none');
    expect(printed.out).not.toMatch(/runs used it, 0 did not/);
  });

  it('links a GENERAL detector that was created without a method on the next feeds pass', async () => {
    const made = await createLearnedDetector({
      scope: 'GENERAL', detectorKey: 'screen:jobs:fabricator+welding',
      definition: { sources: ['jobs'], terms: ['fabricator', 'welding'], positives: 3, negatives: 0 }, threshold: 0.8,
    });
    expect(made.methodId).toBeNull();
    await screened('Welding fabricator wanted', []);
    await runDetectors();
    const row = await getDb().get<{ method_id: string | null }>('SELECT method_id FROM learned_detectors WHERE id = ?', [made.id]);
    expect(row?.method_id).toBeTruthy();
    const method = await getDb().get<{ scope: string; method_key: string }>('SELECT scope, method_key FROM search_methods WHERE id = ?', [row!.method_id]);
    expect(method).toEqual({ scope: 'GENERAL', method_key: 'screen:jobs:fabricator+welding' });
    const runs = await getDb().all<{ executor: string }>('SELECT executor FROM search_method_runs WHERE method_id = ?', [row!.method_id]);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.executor === 'CODE')).toBe(true);
  });

  it('counts no screen as skipped while a detector is only in SHADOW', async () => {
    for (const t of ['Welding fabricator needed now', 'Senior welding fabricator role', 'Welding fabricator for trailers']) await screened(t, ['KEEP', 'KEEP']);
    await runDetectors();
    await screened('Welding fabricator urgently needed', []);
    await runDetectors();
    const report = await buildSearchReport(readerForProject(projectId));
    expect(report.aiUsage.screensAvoided).toBe(0);
    expect(renderSearchReport(report)).toContain('free-model screens skipped by active learned detectors: 0');
  });
});
