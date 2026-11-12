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
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { createLearnedDetector, createSearchMethod, recordDetectorExample } from '../server/repos/searchMethods.ts';
import { DELIVERABLE_KINDS } from '../server/services/cash/deliverables/spec.ts';
import { proposedKey } from '../server/services/feeds/learnFromScreens.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { scoreboard } from '../server/services/cash/scoreboard.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
const item = (id: string, title: string) => ({ externalId: id, url: `https://x.test/${id}`, title, body: null, organization: null, publishedAt: null });

let projectId = '';
let seq = 0;

/** A feed item and two models' SCREEN_LEAD answers on it, as the cheap lane stores them. */
async function screened(title: string, verdict: 'KEEP' | 'DROP'): Promise<string> {
  const ext = `s${seq++}`;
  await insertFeedItems('jobs', [item(ext, title)]);
  const id = (await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE external_id = ?', [ext]))!.id;
  for (const i of [0, 1]) {
    const output = JSON.stringify({
      verdict, window: 'SHORT', deliverable: verdict === 'KEEP' ? DELIVERABLE_KINDS[0] : 'NONE', need: 'a stated need', payer: '', reason: 'r',
    });
    await getDb().run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
      [`cr_${id}_${i}`, `h_${id}`, id, `model-${i}`, output, new Date().toISOString()],
    );
  }
  return id;
}

const codeRuns = (methodId: string) =>
  getDb().all<{ executor: string }>(`SELECT executor FROM search_method_runs WHERE method_id = ? AND executor = 'CODE'`, [methodId]);
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

  it('a detector the feed run proposes from screen answers alone is linked to a method, and its passes are CODE runs', async () => {
    for (const t of positives) await screened(t, 'KEEP');
    await screened('Pastry chef for a bakery', 'DROP');
    await runDetectors();

    const rows = await getDb().all<{ id: string; method_id: string | null; detector_key: string }>(
      `SELECT id, method_id, detector_key FROM learned_detectors WHERE detector_key LIKE 'screen:%'`,
    );
    expect(rows.length).toBe(1);
    const methodId = rows[0]!.method_id;
    expect(methodId).not.toBeNull();
    const method = await getDb().get<{ scope: string; method_key: string }>('SELECT scope, method_key FROM search_methods WHERE id = ?', [methodId]);
    expect(method).toMatchObject({ scope: 'GENERAL', method_key: rows[0]!.detector_key });

    // A later pull of its source is executed by code and recorded against the method.
    await insertFeedItems('jobs', [item('later', 'Welding fabricator wanted for night shift')]);
    await runDetectors();
    expect((await codeRuns(methodId!)).length).toBeGreaterThan(0);
    expect((await scoreboard(projectId)).detections?.search?.counts.known).toBe(1);
  });

  it('links a screen-proposed detector created before the link existed, on the next pass', async () => {
    const terms = ['fabricator', 'welding'];
    const legacy = await createLearnedDetector({
      scope: 'GENERAL', detectorKey: proposedKey('jobs', terms), threshold: 0.8,
      definition: { sources: ['jobs'], terms, trainedOn: [] },
    });
    expect(legacy.methodId).toBeNull();
    await insertFeedItems('jobs', [item('a', 'Welding fabricator wanted')]);
    await runDetectors();

    const row = await getDb().get<{ method_id: string | null }>('SELECT method_id FROM learned_detectors WHERE id = ?', [legacy.id]);
    expect(row?.method_id).not.toBeNull();
    await insertFeedItems('jobs', [item('b', 'Fabricator welding certified role')]);
    await runDetectors();
    expect((await codeRuns(row!.method_id!)).length).toBeGreaterThan(0);
  });

  it("does not show a project's private method on the shared reading", async () => {
    await createSearchMethod({
      scope: 'PROJECT', projectId, methodKey: 'private-method', finds: 'x', sources: ['jobs'], checkProcedure: 'y',
    });
    const search = (await scoreboard(projectId)).detections?.search;
    expect(search?.counts.known).toBe(0);
  });
});
