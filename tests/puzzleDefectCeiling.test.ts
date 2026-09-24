/**
 * The generator's systematic-defect stop, against a generator whose honest
 * failure rate is not zero.
 *
 * A word search is refused when a prohibited string forms by accident, which
 * happens to about one grid in thirty-seven — a property of placing letters
 * at random, not a defect. The stop used to judge "systematic" after four
 * attempts, so a master whose first four seeds included two such grids (about
 * one master id in two hundred and fifty) was stopped at two puzzles and
 * reported as a broken generator. Seeds are derived from the master's random
 * id, so the suite met one intermittently — and the release gate with it.
 *
 * `pzm_probe_668` is a master id found by search whose fifth attempt is its
 * second such grid — tripping the old stop with two or three made, the shape
 * CI met — so this reproduces the condition every run rather than hoping for
 * it. Measured over 3000 random master ids and 75 attempts each, the twelve-
 * attempt minimum stopped none of them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { defineMaster, seedFormat } from '../server/services/puzzle/seed.ts';
import { generateBatch } from '../server/services/puzzle/generate.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('the defect stop needs a sample before it can say "systematic"', () => {
  it('does not stop a healthy generator whose first seeds happened to fail', async () => {
    await seedFormat({ projectId, actorRef: 'test', name: 'word search', note: 'fixture' });
    const defined = await defineMaster({
      projectId,
      actorRef: 'BRAIN',
      title: 'Word search — medium',
      formatName: 'word search',
      corpusId: 'common-english-v1',
      difficulty: 'MEDIUM',
      parameters: {},
    });
    if (!('master' in defined)) throw new Error('no master');
    await getDb().run('UPDATE puzzle_masters SET id = ? WHERE id = ?', ['pzm_probe_668', defined.master.id]);

    const report = await generateBatch({ projectId, masterId: 'pzm_probe_668', count: 25 });
    // The condition is real: early refusals happened.
    expect(report.invalid.length).toBeGreaterThanOrEqual(2);
    // And a healthy generator still finished the batch.
    expect(report.blocked).toBeNull();
    expect(report.made).toHaveLength(25);
  });
});
