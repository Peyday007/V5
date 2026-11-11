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
import { createSearchMethod, recordDetectorExample } from '../server/repos/searchMethods.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { scoreboard } from '../server/services/cash/scoreboard.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
const item = (id: string, title: string) => ({ externalId: id, url: `https://x.test/${id}`, title, body: null, organization: null, publishedAt: null });

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
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
});
