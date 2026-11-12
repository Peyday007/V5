/**
 * The search report, read from a real entry point after a real pass.
 *
 * `buildSearchReport` was reached only by its own test. The cash scoreboard —
 * what `scripts/cash-report.ts` prints — now carries the shared search
 * report's counts through `detectionReading`, and the rows it reads are the
 * ones the feeds pass (`runDetectors()`) records. Nothing here writes a run or
 * a mode by hand.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createSearchMethod, recordDetectorExample } from '../server/repos/searchMethods.ts';
import { DELIVERABLE_KINDS } from '../server/services/cash/deliverables/spec.ts';
import { createDetectorFromExamples, MIN_JUDGED_FOR_PROMOTION } from '../server/services/feeds/learned.ts';
import { methodForDetector } from '../server/services/feeds/learnFromScreens.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { scoreboard } from '../server/services/cash/scoreboard.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
const item = (id: string, title: string) => ({ externalId: id, url: `https://x.test/${id}`, title, body: null, organization: null, publishedAt: null });

/** A feed item and the two models' SCREEN_LEAD answers on it, exactly as the feed run stores them. */
let seq = 0;
async function screened(title: string, answers: readonly ('KEEP' | 'DROP')[]): Promise<void> {
  const ext = `w${seq++}`;
  await insertFeedItems('jobs', [item(ext, title)]);
  const row = await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE external_id = ?', [ext]);
  for (const [i, verdict] of answers.entries()) {
    const output = JSON.stringify({ verdict, window: 'SHORT', deliverable: verdict === 'KEEP' ? DELIVERABLE_KINDS[0] : 'NONE', need: 'n', payer: '', reason: 'r' });
    await getDb().run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
      [`cr_${row!.id}_${i}`, `h_${row!.id}`, row!.id, `model-${i}`, output, new Date().toISOString()],
    );
  }
}

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  seq = 0;
});

describe('the search report, walked from the scoreboard', () => {
  it('says nothing is known before anything was learned', async () => {
    const board = await scoreboard(projectId);
    expect(board.detections?.search?.counts).toMatchObject({ known: 0, automatic: 0, proven: 0 });
    expect(board.detections?.search?.turnedIntoCode).toEqual([]);
  });

  it('reports a method the feed run executed by code, and its detector turned ACTIVE, as automatic and still unproven', async () => {
    const method = await createSearchMethod({
      scope: 'GENERAL', methodKey: 'report-welders', finds: 'employers hiring welders', sources: ['jobs'],
      checkProcedure: 'the title names welding fabrication',
    });
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', methodId: method.id, detectorKey: 'report-welders-det', sources: ['jobs'], positives, negatives: [], threshold: 0.8,
    });
    if (!made.ok) throw new Error('setup');
    for (let i = 0; i < 5; i++) {
      await recordDetectorExample({ detectorId: made.detector.id, itemRef: `ok${i}`, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    }
    await insertFeedItems('jobs', [item('a', 'Welding fabricator wanted'), item('b', 'Pastry chef')]);
    await runDetectors();

    const search = (await scoreboard(projectId)).detections?.search;
    expect(search?.counts).toMatchObject({ known: 1, automatic: 1, proven: 0, unproven: 1, stillLearning: 1 });
    expect(search?.turnedIntoCode).toEqual([{ methodKey: 'report-welders', detectorKey: 'report-welders-det', mode: 'ACTIVE' }]);
  });

  it("does not show a project's private method on the shared reading", async () => {
    await createSearchMethod({
      scope: 'PROJECT', projectId, methodKey: 'private-method', finds: 'x', sources: ['jobs'], checkProcedure: 'y',
    });
    const search = (await scoreboard(projectId)).detections?.search;
    expect(search?.counts.known).toBe(0);
  });
  it('reaches the scoreboard as automatic from a detector the feeds pass proposed itself, with no method linked by hand', async () => {
    // Only what production writes: feed items and agreed screen answers. The
    // detector, its method, its judged firings, its mode and its CODE runs all
    // come from runDetectors() — the feeds pass — and nothing else.
    for (const t of ['Welding fabricator needed now', 'Senior welding fabricator role', 'Welding fabricator for trailers']) await screened(t, ['KEEP', 'KEEP']);
    await screened('Pastry chef wanted', ['DROP', 'DROP']);
    await runDetectors();
    for (let i = 0; i < MIN_JUDGED_FOR_PROMOTION; i++) await screened(`Welding fabricator job ${i}`, ['KEEP', 'KEEP']);
    await runDetectors();

    const detector = await getDb().get<{ method_id: string | null; mode: string; detector_key: string }>(
      'SELECT method_id, mode, detector_key FROM learned_detectors',
    );
    expect(detector?.method_id).toBeTruthy();
    expect(detector?.mode).toBe('ACTIVE');
    const runs = await getDb().all<{ executor: string }>('SELECT executor FROM search_method_runs WHERE method_id = ?', [detector!.method_id]);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.executor === 'CODE')).toBe(true);

    const search = (await scoreboard(projectId)).detections?.search;
    expect(search?.counts.automatic).toBeGreaterThanOrEqual(1);
    expect(search?.turnedIntoCode).toContainEqual({ methodKey: detector!.detector_key, detectorKey: detector!.detector_key, mode: 'ACTIVE' });
  });

  it('does not hide a real failure behind a detector with no method: only a privacy refusal yields null', async () => {
    // A shareable definition gets its method.
    expect(await methodForDetector('screen:jobs:fabricator+welding', { sources: ['jobs'], terms: ['fabricator', 'welding'] })).not.toBeNull();
    // A definition naming this project cannot be GENERAL, and is refused into null rather than shared.
    expect(await methodForDetector(`screen:jobs:${projectId}`, { sources: ['jobs'], terms: [projectId] })).toBeNull();
  });
});
