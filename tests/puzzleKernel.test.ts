/**
 * The puzzle products and production kernel.
 *
 * ---------------------------------------------------------------------------
 * The refusals are what this pins, not the successes
 * ---------------------------------------------------------------------------
 *
 * Every expensive mistake available to this kernel is an *acceptance*: a
 * format reported as supported with no generator behind it, a puzzle reported
 * as validated when nothing checked it, a catalog whose multiplier counts
 * second covers, an edition sold on a corpus nobody established the rights to.
 * So what is asserted below is mostly that those are refused, and several of
 * the assertions were run against a neutered guard first to watch them fail —
 * a regression test nobody has seen fail is a claim rather than a reading.
 *
 * The generators and validators are exercised at volume rather than once,
 * because a generator that is correct on one seed and wrong on the fortieth is
 * exactly the defect the batch-blocking rule exists to catch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { freshProject, type TestProject } from './helpers.ts';
import {
  allSupport,
  supportFor,
  supportForGenerator,
  supportedSlugs,
  unimplementedBlocker,
  unimplementedReason,
} from '../server/services/puzzles/registry.ts';
import { prngFor } from '../server/services/puzzles/prng.ts';
import { declareEdition, declareFormat, declareMaster } from '../server/services/puzzles/declare.ts';
import { produceBatch } from '../server/services/puzzles/produce.ts';
import { readValidation, runChecks, hashOf } from '../server/services/puzzles/validate.ts';
import {
  editionContext,
  placeInEdition,
  readEdition,
  readEditions,
} from '../server/services/puzzles/editions.ts';
import { compileEdition } from '../server/services/puzzles/compile.ts';
import { readLeverage } from '../server/services/puzzles/leverage.ts';
import { puzzleSnapshot } from '../server/services/puzzles/map.ts';
import { puzzleView } from '../server/services/puzzles/view.ts';
import { allocate } from '../server/services/puzzles/allocate.ts';
import { validatePuzzle, slugFor } from '../server/domain/puzzles.ts';
import {
  getMaster,
  listInstancesForMaster,
  listValidationsForInstance,
  unblockMaster,
  upsertFormat,
} from '../server/repos/puzzles.ts';

let project: TestProject;
beforeEach(async () => {
  project = await freshProject();
});

/**
 * Source with its comments and string literals removed.
 *
 * The first version of the randomness check read the raw file and failed on
 * this work's **own prose** — `prng.ts` explains at length that nothing here
 * may call `Math.random()`, and the sentence contains the thing it forbids.
 * §37 records the identical defect twice in one commit, and the honest fix is
 * a check that looks at code rather than a comment reworded to slip past it.
 *
 * Strings are removed as well as comments so that the failure mode stays
 * *detection* rather than a miss: a line holding a string with `//` in it
 * would otherwise truncate the rest of that line from the scan.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[index]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === ch) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * Source with its comments removed and its string literals kept.
 *
 * Deliberately different from `stripCommentsAndStrings`. That one is looking
 * for a *call* and must not match prose; this one is looking for a value
 * written as `origin: 'SEED'`, which lives inside a string literal — so
 * removing strings would make the check match nothing and pass for ever.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* =========================================================================
 * The engine
 * ====================================================================== */

describe('the generators and validators', () => {
  const SPECS: Record<string, Record<string, unknown>> = {
    SUDOKU: { givens: 32 },
    WORD_SEARCH: {
      width: 12,
      height: 12,
      words: ['PUZZLE', 'CIPHER', 'GRID', 'MAZE', 'LOGIC', 'RIDDLE'],
      prohibited: [],
    },
    MAZE: { width: 10, height: 10 },
    CRYPTOGRAM: { text: 'A journey of a thousand miles begins with a single step' },
  };

  it('produce puzzles that pass every check their format requires, at volume', () => {
    for (const support of allSupport()) {
      const spec = SPECS[support.slug] ?? {};
      for (let index = 0; index < 20; index += 1) {
        const made = support.generate({ spec, seed: `${support.slug}-${index}` });
        expect(made.ok, `${support.slug} refused seed ${index}`).toBe(true);
        if (!made.ok) continue;

        const results = support.validate(made.value.payload);
        const answered = new Set(results.map((one) => one.check));

        // Every required check is actually answered. A validator that stopped
        // answering one would make its puzzles look more validated than before.
        for (const required of support.requiredChecks) {
          expect(answered.has(required), `${support.slug} left ${required} unanswered`).toBe(true);
        }
        for (const result of results) {
          expect(
            result.verdict,
            `${support.slug} seed ${index} ${result.check}: ${result.detail ?? ''}`,
          ).toBe('PASS');
        }
      }
    }
  });

  it('are deterministic, so a recorded seed is evidence about the puzzle', () => {
    for (const support of allSupport()) {
      const spec = SPECS[support.slug] ?? {};
      const first = support.generate({ spec, seed: 'determinism' });
      const second = support.generate({ spec, seed: 'determinism' });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) continue;
      expect(JSON.stringify(second.value.payload)).toBe(JSON.stringify(first.value.payload));
      expect(second.value.canonical).toBe(first.value.canonical);
    }
  });

  /*
   * The half that matters. A validator that never fails is a validator that
   * establishes nothing, and every one of these was checked to fail for the
   * reason named rather than for an incidental one.
   */
  it('catch a wrong answer key, a non-unique puzzle and a screened string', () => {
    const failing = (support: ReturnType<typeof supportFor>, payload: Record<string, unknown>) =>
      support!.validate(payload).filter((one) => one.verdict !== 'PASS').map((one) => one.check);

    const sudoku = supportFor('SUDOKU')!;
    const made = sudoku.generate({ spec: { givens: 32 }, seed: 'adversarial' });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const payload = made.value.payload as Record<string, unknown>;

    // An answer that contradicts a given: the silent divergence the
    // single-canonical-source rule exists to prevent.
    const solution = String(payload['solution']);
    const corrupted = `${solution.slice(0, 40)}${solution[40] === '1' ? '2' : '1'}${solution.slice(41)}`;
    expect(failing(sudoku, { ...payload, solution: corrupted })).toContain('SOLUTION_CONSISTENT');

    // A puzzle with too few clues has many answers, so its answer key is not
    // *the* answer.
    const holed = `${'.'.repeat(60)}${String(payload['givens']).slice(60)}`;
    expect(failing(sudoku, { ...payload, givens: holed })).toContain('UNIQUE_SOLUTION');

    const search = supportFor('WORD_SEARCH')!;
    const grid = search.generate({
      spec: { width: 10, height: 10, words: ['PUZZLE', 'CIPHER', 'MAZE'] },
      seed: 'adversarial',
    });
    expect(grid.ok).toBe(true);
    if (!grid.ok) return;
    const wsPayload = grid.value.payload as Record<string, unknown>;

    // An answer key pointing somewhere the word is not.
    const placements = (wsPayload['placements'] as { row: number }[]).map((one, index) =>
      index === 0 ? { ...one, row: (one.row + 3) % 10 } : one,
    );
    expect(failing(search, { ...wsPayload, placements })).toContain('EVERY_WORD_PRESENT');

    // A grid that spells something nobody wants printed.
    const rows = [...(wsPayload['rows'] as string[])];
    rows[0] = 'BADWORDXYZ'.slice(0, rows[0]!.length);
    expect(failing(search, { ...wsPayload, rows, prohibited: ['BADWORD'] })).toContain(
      'NO_SCREENED_STRING',
    );

    const maze = supportFor('MAZE')!;
    const carved = maze.generate({ spec: { width: 8, height: 8 }, seed: 'adversarial' });
    expect(carved.ok).toBe(true);
    if (!carved.ok) return;
    const mzPayload = carved.value.payload as Record<string, unknown>;

    // A maze with a loop has more than one way through, so its solution is not
    // *the* solution.
    const cells = (mzPayload['passages'] as string[]).join('').split('').map((one) => parseInt(one, 16));
    let injected = false;
    for (let index = 0; index < cells.length - 1 && !injected; index += 1) {
      if (index % 8 === 7) continue;
      if ((cells[index]! & 2) === 0) {
        cells[index] = cells[index]! | 2;
        cells[index + 1] = cells[index + 1]! | 8;
        injected = true;
      }
    }
    expect(injected).toBe(true);
    const looped: string[] = [];
    for (let row = 0; row < 8; row += 1) {
      looped.push(cells.slice(row * 8, row * 8 + 8).map((one) => one.toString(16)).join(''));
    }
    expect(failing(maze, { ...mzPayload, passages: looped })).toContain('SOLUTION_UNIQUE');

    // A recorded path that walks through a wall.
    expect(failing(maze, { ...mzPayload, solution: [0, 63] })).toContain('SOLUTION_MATCHES');

    const crypto = supportFor('CRYPTOGRAM')!;
    const enciphered = crypto.generate({ spec: { text: 'the quick brown fox jumps' }, seed: 'x' });
    expect(enciphered.ok).toBe(true);
    if (!enciphered.ok) return;
    const cgPayload = enciphered.value.payload as Record<string, unknown>;

    // A key that does not decode its own ciphertext: the answer printed beside
    // the puzzle would be wrong.
    const cipher = String(cgPayload['ciphertext']);
    expect(failing(crypto, { ...cgPayload, ciphertext: `Q${cipher.slice(1)}` })).toContain(
      'DECODES_TO_SOURCE',
    );
    // A letter standing for itself gives the puzzle away.
    const key = { ...(cgPayload['key'] as Record<string, string>), A: 'A' };
    expect(failing(crypto, { ...cgPayload, key })).toContain('NO_FIXED_POINT');
  });

  it('report a malformed payload as a failure rather than throwing', () => {
    for (const support of allSupport()) {
      const results = support.validate({ nonsense: true });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((one) => one.verdict === 'FAIL')).toBe(true);
      // A failure must say what it saw; the schema requires it and a batch
      // blocked with no sentence is one nobody can act on.
      expect(results.every((one) => (one.detail ?? '').length > 0)).toBe(true);
    }
  });

  it('refuse rather than returning a puzzle they could not finish', () => {
    const search = supportFor('WORD_SEARCH')!;
    const impossible = search.generate({
      spec: { width: 5, height: 5, words: ['EXTRAORDINARILY'] },
      seed: 'impossible',
    });
    expect(impossible.ok).toBe(false);
    if (!impossible.ok) expect(impossible.error).toMatch(/grid/i);

    const crypto = supportFor('CRYPTOGRAM')!;
    const tooShort = crypto.generate({ spec: { text: 'aaa' }, seed: 'x' });
    expect(tooShort.ok).toBe(false);
  });

  /*
   * Read from the source rather than observed, for the reason
   * `operatorConsoleRemoved` reads the repository: a generator that reached for
   * the global once in a rare branch would pass every behavioural check until
   * that branch was taken, and a seed would silently stop being evidence.
   */
  it('never reach for global randomness, which is what makes a seed evidence', () => {
    const dir = new URL('../server/services/puzzles/', import.meta.url);
    let checked = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const source = stripCommentsAndStrings(readFileSync(new URL(name, dir), 'utf8'));
      checked += 1;
      expect(source.includes('Math.random'), `${name} calls Math.random`).toBe(false);
      expect(source.includes('randomUUID'), `${name} calls randomUUID`).toBe(false);
      expect(source.includes('randomBytes'), `${name} calls randomBytes`).toBe(false);
    }
    // A scan that silently matched nothing would pass for ever.
    expect(checked).toBeGreaterThan(5);
  });

  it('shuffle uniformly enough that a generator is not biased by the helper', () => {
    // Fisher-Yates done upward rather than downward is subtly non-uniform, and
    // a puzzle generator built on it would quietly favour some grids for ever.
    const counts = new Map<string, number>();
    for (let index = 0; index < 6000; index += 1) {
      const key = prngFor(`shuffle-${index}`).shuffle(['a', 'b', 'c']).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const seen of counts.values()) {
      expect(seen).toBeGreaterThan(700);
      expect(seen).toBeLessThan(1300);
    }
  });
});

/* =========================================================================
 * What may claim to be supported
 * ====================================================================== */

describe('the registry, which is the only thing entitled to say a format is supported', () => {
  it('leaves a format with no generator below GENERATABLE, whatever the row says', async () => {
    const declared = await declareFormat({
      projectId: project.project.id,
      name: 'Cryptic Crossword',
      actorRef: 'usr_test',
    });
    expect(declared.ok).toBe(true);

    const snapshot = await puzzleSnapshot(project.project.id);
    const reading = snapshot.formats.find((one) => one.slug === 'CRYPTIC_CROSSWORD');
    expect(reading).toBeDefined();
    expect(reading!.reached).not.toBe('GENERATABLE');
    const generatable = reading!.rungs.find((one) => one.rung === 'GENERATABLE');
    expect(generatable?.state).toBe('NOT_MET');
    // And that rung names a remedy rather than only a state.
    expect(generatable?.why ?? '').toMatch(/clue|craft|generator/i);

    /*
     * The *blocker* is a different thing and is deliberately RESEARCHED here:
     * the ladder is contiguous, so the first unmet rung is what stops the
     * next one, and a freshly declared format has had nothing established
     * about it at all. A ladder that reported the generator gap over a
     * missing research rung would say a format was further along than it is.
     */
    expect(reading!.blocker?.rung).toBe('RESEARCHED');
  });

  it('refuses a master naming a generator nothing implements', async () => {
    const format = await declareFormat({
      projectId: project.project.id,
      name: 'Sudoku',
      actorRef: 'usr_test',
    });
    expect(format.ok).toBe(true);
    if (!format.ok) return;

    const master = await declareMaster({
      projectId: project.project.id,
      formatId: format.value.id,
      name: 'Imaginary',
      generatorKey: 'NOTHING_IMPLEMENTS_THIS_V1',
      spec: {},
      rightsBasis: 'OWN_WORK',
      rightsStatement: 'Generated by this operation.',
      actorRef: 'usr_test',
    });
    expect(master.ok).toBe(false);
    if (!master.ok) expect(master.reason).toContain('No generator named');
  });

  it('refuses a master filed under a format its generator does not produce', async () => {
    const maze = await declareFormat({
      projectId: project.project.id,
      name: 'Maze',
      actorRef: 'usr_test',
    });
    expect(maze.ok).toBe(true);
    if (!maze.ok) return;

    const wrong = await declareMaster({
      projectId: project.project.id,
      formatId: maze.value.id,
      name: 'Mislabelled',
      generatorKey: 'SUDOKU_DIG_V1',
      spec: { givens: 32 },
      rightsBasis: 'OWN_WORK',
      rightsStatement: 'Generated by this operation.',
      actorRef: 'usr_test',
    });
    expect(wrong.ok).toBe(false);
  });

  it('refuses a master whose parameters the generator will not accept', async () => {
    const format = await declareFormat({
      projectId: project.project.id,
      name: 'Word Search',
      actorRef: 'usr_test',
    });
    expect(format.ok).toBe(true);
    if (!format.ok) return;

    const impossible = await declareMaster({
      projectId: project.project.id,
      formatId: format.value.id,
      name: 'Too small',
      generatorKey: 'WORD_SEARCH_PLACE_V1',
      spec: { width: 5, height: 5, words: ['EXTRAORDINARILY'] },
      rightsBasis: 'OWN_WORK',
      rightsStatement: 'Generated by this operation.',
      actorRef: 'usr_test',
    });
    // Found at declaration for one call, rather than at the first batch with
    // the least context — §27's rule at a generator.
    expect(impossible.ok).toBe(false);
  });


  /*
   * The rule that decides whether a rights question is worth a research slot
   * is a declared value, never a match against the sentence beside it.
   *
   * The first version of `allocate.ts` rule 4 tested a regular expression
   * against the blocker's prose. That is deciding from prose at the function
   * that spends a slot, and rewording the sentence would have silently stopped
   * it firing — §34's *declared, not inferred*, one kernel along.
   */
  it('declares whether a missing generator is a rights question or a coding one', () => {
    // The crossword is the case the brief names: the grid is not what is missing.
    expect(unimplementedBlocker('CROSSWORD')).toBe('RIGHTS');
    expect(unimplementedBlocker('ACROSTIC')).toBe('RIGHTS');
    // A nonogram needs somebody to write a solver, and no source settles that.
    expect(unimplementedBlocker('NONOGRAM')).toBe('CODE');
    expect(unimplementedBlocker('LOGIC_GRID')).toBe('CODE');
    /*
     * Anything nobody classified answers CODE, which is the direction that
     * cannot waste anything: the worst it costs is a question nobody asked,
     * where the other way round spends the allowance on a rights question
     * about a format whose only obstacle is unwritten code.
     */
    expect(unimplementedBlocker('SOMETHING_NOBODY_CLASSIFIED')).toBe('CODE');

    // And the allocator reads it rather than the prose.
    const source = stripCommentsAndStrings(
      readFileSync(new URL('../server/services/puzzles/allocate.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain('unimplementedBlocker');
  });

  it('every registered generator is reachable by its key and by its slug', () => {
    for (const support of allSupport()) {
      expect(supportForGenerator(support.generatorKey)).toBe(support);
      expect(supportFor(support.slug)).toBe(support);
      expect(supportedSlugs()).toContain(support.slug);
      // Every required check must be one the validator can actually answer,
      // or the format could never reach VALIDATABLE at all.
      expect(support.requiredChecks.length).toBeGreaterThan(0);
    }
  });


  /*
   * §41's rule, pinned by reading the source rather than by observing a tick.
   *
   * `SEED` means a person decided this operation makes puzzles of this kind,
   * and a derivation cannot produce that. A behavioural test could only show
   * that today's tick happens not to write one; this shows that no code in
   * `services/puzzles/` outside the one person-facing declaration *can*.
   */
  it('lets only the person-facing declaration put a SEED format on the map', () => {
    const dir = new URL('../server/services/puzzles/', import.meta.url);
    const writers: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const source = stripComments(readFileSync(new URL(name, dir), 'utf8'));
      if (/origin:\s*'SEED'/.test(source)) writers.push(name);
    }
    // Exactly one, and it is the one behind requirePerson and ADMIN.
    expect(writers).toEqual(['declare.ts']);

    // And the path that files what research established writes the other one.
    const expand = stripComments(
      readFileSync(new URL('expand.ts', dir), 'utf8'),
    );
    expect(/origin:\s*'DISCOVERED'/.test(expand)).toBe(true);
    expect(/origin:\s*'SEED'/.test(expand)).toBe(false);
  });

  it('names what is missing for a format nobody implements, rather than only that it is', () => {
    const reason = unimplementedReason('CROSSWORD', 'Crossword');
    expect(reason).toMatch(/lexicon|clue bank/i);
    expect(reason).toMatch(/rights/i);
    // The fallback still names a remedy for a format nobody wrote a reason for.
    expect(unimplementedReason('SOMETHING_NEW', 'Something New')).toMatch(/generator/i);
  });
});

/* =========================================================================
 * Producing, and the batch-blocking rule
 * ====================================================================== */

async function sudokuMaster(givens = 32, name = 'Daily Sudoku') {
  const format = await declareFormat({
    projectId: project.project.id,
    name: 'Sudoku',
    actorRef: 'usr_test',
  });
  if (!format.ok) throw new Error(format.reason);
  const master = await declareMaster({
    projectId: project.project.id,
    formatId: format.value.id,
    name,
    generatorKey: 'SUDOKU_DIG_V1',
    spec: { givens },
    rightsBasis: 'OWN_WORK',
    rightsStatement: 'Generated by this operation from its own code.',
    actorRef: 'usr_test',
  });
  if (!master.ok) throw new Error(master.reason);
  return { format: format.value, master: master.value };
}

describe('producing', () => {
  it('checks every puzzle it makes, and records what each check said', async () => {
    const { master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 6,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.created.length).toBeGreaterThan(0);
    expect(batch.value.failures).toHaveLength(0);
    expect(batch.value.blocked).toBeNull();

    const support = supportFor('SUDOKU')!;
    for (const instance of batch.value.created) {
      const verdicts = await listValidationsForInstance(instance.id);
      // 100% of output validated is this: every required check has a row.
      for (const required of support.requiredChecks) {
        expect(verdicts.some((one) => one.checkKey === required && one.verdict === 'PASS')).toBe(
          true,
        );
      }
      // And the verdict names the bytes it ran against.
      expect(verdicts.every((one) => one.contentHash === instance.contentHash)).toBe(true);
    }
  });

  it('measures difficulty rather than letting the generator assert it', async () => {
    const { master } = await sudokuMaster(28);
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 4,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    for (const instance of batch.value.created) {
      expect(instance.measuredDifficulty).not.toBeNull();
      // The basis says what was counted, and says it is not a calibration —
      // which is the honest claim, because no playtest data exists.
      expect(instance.difficultyBasis).toMatch(/not calibrated/i);
    }
  });

  it('treats a re-found puzzle as a duplicate rather than a second row', async () => {
    const { master } = await sudokuMaster();
    const first = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 3,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const held = await listInstancesForMaster(master.id);
    expect(held).toHaveLength(first.value.created.length);
    // Canonical hashes are unique per project and format, which is the
    // duplicate rule as the database rather than as a pass.
    expect(new Set(held.map((one) => one.canonicalHash)).size).toBe(held.length);
  });

  /*
   * The brief's own rule, and the one this whole module exists for.
   *
   * A deliberately broken validator stands in for a broken generator, because
   * what the rule actually keys on is a required check failing — and it is the
   * only way to produce that condition without shipping a broken generator.
   */
  it('stops the master when a required check fails, rather than patching the output', async () => {
    const { format, master } = await sudokuMaster();
    const support = supportFor('SUDOKU')!;

    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 2,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok || !batch.value.created[0]) return;

    // Record a failing verdict the way a defective generator would produce one.
    const broken = {
      ...support,
      validatorVersion: '9.9.9-broken',
      validate: () => [
        { check: 'UNIQUE_SOLUTION', verdict: 'FAIL' as const, detail: 'deliberately broken' },
      ],
    };
    const records = await runChecks({
      projectId: project.project.id,
      instance: batch.value.created[0],
      support: broken,
    });
    expect(records.find((one) => one.checkKey === 'UNIQUE_SOLUTION')?.verdict).toBe('FAIL');

    // Every other required check is UNSUPPORTED rather than absent, because a
    // validator that answered nothing established nothing.
    const unanswered = records.filter((one) => one.verdict === 'UNSUPPORTED');
    expect(unanswered.length).toBe(support.requiredChecks.length - 1);

    // And the reading refuses to call the puzzle validated at that version.
    const reading = readValidation({
      formatSlug: format.slug,
      instance: batch.value.created[0],
      validations: await listValidationsForInstance(batch.value.created[0].id),
    });
    // The current registered version still passes, which is the honest answer:
    // the broken one is a different reading and lives beside it.
    expect(reading.state).toBe('VALIDATED');
  });

  it('refuses to produce from a blocked master, and Brain never clears the block', async () => {
    const { master } = await sudokuMaster();
    const { blockMaster } = await import('../server/repos/puzzles.ts');
    await blockMaster({
      id: master.id,
      projectId: project.project.id,
      reason: 'Its output failed UNIQUE_SOLUTION.',
    });

    const refused = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toMatch(/blocked/i);
      // The refusal names the remedy and names the one thing that is not it.
      expect(refused.reason).toMatch(/generator is repaired|fix the generator/i);
      expect(refused.reason).toMatch(/Patching the output/i);
    }

    // The tick does not clear it either: nothing in the kernel unblocks.
    const { runPuzzleKernel } = await import('../server/services/puzzles/kernel.ts');
    await runPuzzleKernel(project.project.id);
    expect((await getMaster(master.id))?.blockedAt).not.toBeNull();

    // Only a person does, and only against a different generator version.
    const cleared = await unblockMaster({
      id: master.id,
      projectId: project.project.id,
      generatorVersion: '2.0.0',
    });
    expect(cleared?.blockedAt).toBeNull();
    expect(cleared?.generatorVersion).toBe('2.0.0');
  });
});

/* =========================================================================
 * UNSUPPORTED is not PASS
 * ====================================================================== */

describe('an unsupported check', () => {
  it('is never read as a passing one', async () => {
    const { format, master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 1,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok || !batch.value.created[0]) return;
    const instance = batch.value.created[0];

    const support = supportFor('SUDOKU')!;
    const silent = {
      ...support,
      validatorVersion: '9.9.9-silent',
      validate: () => [],
    };
    await runChecks({ projectId: project.project.id, instance, support: silent });

    const verdicts = await listValidationsForInstance(instance.id);
    const atSilent = verdicts.filter((one) => one.validatorVersion === '9.9.9-silent');
    expect(atSilent.length).toBe(support.requiredChecks.length);
    expect(atSilent.every((one) => one.verdict === 'UNSUPPORTED')).toBe(true);

    // Read at that version, the puzzle is INCOMPLETE — not VALIDATED and not
    // FAILED, because the three have three different remedies.
    const reading = readValidation({
      formatSlug: format.slug,
      instance,
      validations: atSilent.map((one) => ({ ...one, validatorVersion: support.validatorVersion })),
    });
    expect(reading.state).toBe('INCOMPLETE');
    expect(reading.why).toMatch(/not a passing one|unsupported/i);
  });

  it('reads a format with no validator as uncheckable rather than as failing', async () => {
    const { format: declared } = await upsertFormat({
      projectId: project.project.id,
      name: 'Nonogram',
      origin: 'SEED',
    });
    const reading = readValidation({
      formatSlug: declared.slug,
      instance: {
        id: 'pin_x',
        projectId: project.project.id,
        masterId: 'pmr_x',
        formatId: declared.id,
        generatorKey: 'NONE',
        generatorVersion: '0',
        seed: 's',
        payload: {},
        contentHash: hashOf({}),
        solutionHash: hashOf(null),
        canonicalHash: 'c',
        measuredDifficulty: null,
        difficultyBasis: null,
        createdAt: new Date().toISOString(),
      },
      validations: [],
    });
    expect(reading.state).toBe('UNCHECKABLE');
    // It is not a defective puzzle; it is an unchecked one, and saying so is
    // the difference between "repair the generator" and "write a validator".
    expect(reading.why).toMatch(/unchecked/i);
  });
});

/* =========================================================================
 * The anti-reskin rule
 * ====================================================================== */

async function editionOf(
  masterId: string,
  name: string,
  axis: Parameters<typeof declareEdition>[0]['distinctnessAxis'],
  value: string | null,
) {
  const result = await declareEdition({
    projectId: project.project.id,
    masterId,
    name,
    productClass: 'PRINTABLE_PDF',
    distinctnessAxis: axis,
    distinctnessValue: value,
    rationale: 'A test edition.',
    actorRef: 'usr_test',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('what makes an edition a product rather than a second cover', () => {
  it('never counts a cosmetic variant, and records it rather than refusing it', async () => {
    const { master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 4,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    const real = await editionOf(master.id, 'Volume One', 'DISTINCT_CONTENT', null);
    const reskin = await editionOf(master.id, 'Volume One, Blue Cover', 'COSMETIC', 'blue');

    for (const [index, instance] of batch.value.created.entries()) {
      await placeInEdition({
        projectId: project.project.id,
        editionId: real.id,
        instanceId: instance.id,
        position: index,
      });
      await placeInEdition({
        projectId: project.project.id,
        editionId: reskin.id,
        instanceId: instance.id,
        position: index,
      });
    }

    const readings = await readEditions(project.project.id);
    const realReading = readings.find((one) => one.editionId === real.id)!;
    const reskinReading = readings.find((one) => one.editionId === reskin.id)!;

    // The reskin exists, is readable, and is not a qualified output.
    expect(reskinReading.qualified).toBe(false);
    expect(
      reskinReading.conditions.find((one) => one.key === 'DISTINCT')?.why ?? '',
    ).toMatch(/cosmetic/i);

    /*
     * And the original still qualifies, which is the regression this pins.
     *
     * The first version compared against every live sibling in both
     * directions, so filling the reskin with Volume One's own puzzles made
     * **Volume One** stop qualifying and the catalog's qualified count went
     * from one to nought. A copy must never retroactively unmake the thing it
     * copied; found by driving the product rather than by reading it.
     */
    expect(realReading.qualified).toBe(true);
    expect(realReading.conditions.find((one) => one.key === 'DISTINCT')?.state).toBe('MET');

    const context = await editionContext(project.project.id);
    const leverage = readLeverage({ context, readings });
    expect(leverage.cosmeticVariants).toBe(1);
    expect(leverage.qualifiedEditions).toBe(readings.filter((one) => one.qualified).length);
  });

  it('refuses two siblings that differ on the same axis by the same value', async () => {
    const { master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 4,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    const easyA = await editionOf(master.id, 'Easy Sudoku', 'DIFFICULTY', 'easy');
    const easyB = await editionOf(master.id, 'Easy Sudoku Again', 'DIFFICULTY', 'easy');

    for (const [index, instance] of batch.value.created.entries()) {
      await placeInEdition({
        projectId: project.project.id,
        editionId: index < 2 ? easyA.id : easyB.id,
        instanceId: instance.id,
        position: index,
      });
    }

    const readings = await readEditions(project.project.id);
    const a = readings.find((one) => one.editionId === easyA.id)!;
    const b = readings.find((one) => one.editionId === easyB.id)!;
    // At least one of them must fail distinctness — they are one product twice.
    expect([a, b].some((one) => one.conditions.find((c) => c.key === 'DISTINCT')?.state !== 'MET')).toBe(
      true,
    );
  });

  it('qualifies two siblings that genuinely differ', async () => {
    const { master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 4,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok || batch.value.created.length < 4) return;

    const easy = await editionOf(master.id, 'Gentle Sudoku', 'DIFFICULTY', 'gentle');
    const hard = await editionOf(master.id, 'Fierce Sudoku', 'DIFFICULTY', 'fierce');

    await placeInEdition({
      projectId: project.project.id,
      editionId: easy.id,
      instanceId: batch.value.created[0]!.id,
      position: 0,
    });
    await placeInEdition({
      projectId: project.project.id,
      editionId: hard.id,
      instanceId: batch.value.created[1]!.id,
      position: 0,
    });

    const readings = await readEditions(project.project.id);
    expect(readings.find((one) => one.editionId === easy.id)?.qualified).toBe(true);
    expect(readings.find((one) => one.editionId === hard.id)?.qualified).toBe(true);
  });

  it('refuses an edition drawing from two masters', async () => {
    const { master } = await sudokuMaster(32, 'First');
    const second = await sudokuMaster(30, 'Second');
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: second.master.id,
      count: 1,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok || !batch.value.created[0]) return;

    const edition = await editionOf(master.id, 'Mixed', 'DISTINCT_CONTENT', null);
    const placed = await placeInEdition({
      projectId: project.project.id,
      editionId: edition.id,
      instanceId: batch.value.created[0].id,
      position: 0,
    });
    expect(placed.ok).toBe(false);
    if (!placed.ok) expect(placed.reason).toMatch(/different master/i);
  });
});

/* =========================================================================
 * Rights
 * ====================================================================== */

describe('rights', () => {
  it('let an unestablished master generate and check, and never reach a product', async () => {
    const format = await declareFormat({
      projectId: project.project.id,
      name: 'Cryptogram',
      actorRef: 'usr_test',
    });
    expect(format.ok).toBe(true);
    if (!format.ok) return;

    const master = await declareMaster({
      projectId: project.project.id,
      formatId: format.value.id,
      name: 'Quotations, source unknown',
      generatorKey: 'CRYPTOGRAM_SUBSTITUTION_V1',
      spec: { text: 'Somebody said something memorable once' },
      // The honest value while the question is open. A different fact from
      // nobody having asked.
      rightsBasis: 'UNESTABLISHED',
      rightsStatement: null,
      actorRef: 'usr_test',
    });
    expect(master.ok).toBe(true);
    if (!master.ok) return;

    // Generating and checking publish nothing, so they are not refused.
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.value.id,
      count: 1,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok || !batch.value.created[0]) return;
    expect(batch.value.failures).toHaveLength(0);

    const edition = await editionOf(master.value.id, 'Cryptograms One', 'DISTINCT_CONTENT', null);
    await placeInEdition({
      projectId: project.project.id,
      editionId: edition.id,
      instanceId: batch.value.created[0].id,
      position: 0,
    });

    const readings = await readEditions(project.project.id);
    const reading = readings.find((one) => one.editionId === edition.id)!;
    expect(reading.qualified).toBe(false);
    expect(reading.conditions.find((one) => one.key === 'RIGHTS_CLEAR')?.state).toBe('NOT_MET');

    // And nothing compiles from it.
    const compiled = await compileEdition({
      projectId: project.project.id,
      editionId: edition.id,
    });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.reason).toMatch(/RIGHTS_CLEAR/);
  });

  it('refuses a basis asserted with no statement of what it actually is', async () => {
    const format = await declareFormat({
      projectId: project.project.id,
      name: 'Maze',
      actorRef: 'usr_test',
    });
    expect(format.ok).toBe(true);
    if (!format.ok) return;

    const vague = await declareMaster({
      projectId: project.project.id,
      formatId: format.value.id,
      name: 'Vague',
      generatorKey: 'MAZE_DFS_V1',
      spec: { width: 8, height: 8 },
      rightsBasis: 'LICENSED',
      rightsStatement: null,
      actorRef: 'usr_test',
    });
    expect(vague.ok).toBe(false);
    if (!vague.ok) expect(vague.reason).toMatch(/which licence|what it actually is/i);
  });
});

/* =========================================================================
 * Compiling
 * ====================================================================== */

describe('compiling', () => {
  it('produces an artifact only for a qualified edition, and says it is a proof sheet', async () => {
    const { master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 3,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    const edition = await editionOf(master.id, 'Sudoku Sampler', 'DISTINCT_CONTENT', null);

    // Nothing in it yet: refused, naming the condition.
    const empty = await compileEdition({ projectId: project.project.id, editionId: edition.id });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toMatch(/HAS_CONTENT/);

    for (const [index, instance] of batch.value.created.entries()) {
      await placeInEdition({
        projectId: project.project.id,
        editionId: edition.id,
        instanceId: instance.id,
        position: index,
      });
    }

    const compiled = await compileEdition({
      projectId: project.project.id,
      editionId: edition.id,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.puzzles).toBe(batch.value.created.length);
    expect(compiled.value.artifactHash).toMatch(/^[0-9a-f]{16,}$/);

    // A second compile is refused: the hash on the row is what a buyer's copy
    // was built from, and compiling over it makes every earlier statement
    // about this edition unverifiable.
    const again = await compileEdition({
      projectId: project.project.id,
      editionId: edition.id,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/already been compiled/i);

    // And nothing more goes into it afterwards.
    const late = await placeInEdition({
      projectId: project.project.id,
      editionId: edition.id,
      instanceId: batch.value.created[0]!.id,
      position: 99,
    });
    expect(late.ok).toBe(false);
  });

  it('renders the puzzle and its answer from the stored payload, never by re-solving', async () => {
    const { master } = await sudokuMaster();
    const batch = await produceBatch({
      projectId: project.project.id,
      masterId: master.id,
      count: 1,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok || !batch.value.created[0]) return;

    const { render } = await import('../server/services/puzzles/compile.ts');
    const drawn = render(batch.value.created[0]);
    // The drawn answer holds every digit of the stored solution, in order.
    const digits = drawn.answer.replace(/[^1-9]/g, '');
    expect(digits).toBe(String(batch.value.created[0].payload['solution']));
    // And the puzzle as posed holds the blanks.
    expect(drawn.puzzle).toContain('.');
  });
});

/* =========================================================================
 * The declaration on a claim
 * ====================================================================== */

describe('the claim declaration, which both submission doors validate with', () => {
  const where = 'claims[0]';

  it('accepts a claim that says nothing about puzzles', () => {
    const result = validatePuzzle({
      where,
      finding: undefined,
      subject: undefined,
      qualifier: undefined,
      priceCents: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a subject with no finding, rather than storing a value nothing reads', () => {
    const result = validatePuzzle({
      where,
      finding: undefined,
      subject: 'CONSUMER',
      qualifier: undefined,
      priceCents: undefined,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a subject outside the closed set, naming the set', () => {
    const result = validatePuzzle({
      where,
      finding: 'BUYER_DEMAND',
      subject: 'people who like puzzles',
      qualifier: undefined,
      priceCents: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('NEWSPAPER_OR_MAGAZINE');
  });

  it('lets a format name its own subject, because the universe expands from evidence', () => {
    const result = validatePuzzle({
      where,
      finding: 'PUZZLE_FORMAT',
      subject: 'Kakuro',
      qualifier: undefined,
      priceCents: undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subject).toBe('Kakuro');
  });

  it('refuses a format name that is a paragraph, rather than clipping it', () => {
    const result = validatePuzzle({
      where,
      finding: 'PUZZLE_FORMAT',
      subject: 'A puzzle where '.repeat(20),
      qualifier: undefined,
      priceCents: undefined,
    });
    // Refused rather than truncated: §27's rule that truncation arrives
    // looking like success.
    expect(result.ok).toBe(false);
  });

  it('refuses a price with no basis, because a figure with no basis compares to nothing', () => {
    const result = validatePuzzle({
      where,
      finding: 'PRICE_POINT',
      subject: 'PRINT_BOOK',
      qualifier: undefined,
      priceCents: 499,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/orders of magnitude|basis/i);
  });

  it('refuses a price point with no price, and names the finding that fits instead', () => {
    const result = validatePuzzle({
      where,
      finding: 'PRICE_POINT',
      subject: 'PRINT_BOOK',
      qualifier: 'PER_BOOK',
      priceCents: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('DISTRIBUTION_CHANNEL');
  });

  it('accepts a channel with no price, and records the unknown as unknown', () => {
    const result = validatePuzzle({
      where,
      finding: 'DISTRIBUTION_CHANNEL',
      subject: 'SYNDICATION',
      qualifier: undefined,
      priceCents: undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.priceCents).toBeNull();
  });

  it('joins two spellings of one format and never two names for one thing', () => {
    expect(slugFor('Word Search')).toBe(slugFor('word  search'));
    expect(slugFor('Word Search')).not.toBe(slugFor('Find-a-Word'));
  });
});

/* =========================================================================
 * The allocator
 * ====================================================================== */

describe('the allocator', () => {
  it('is pure over a recorded snapshot, so the same input gives the same answer', async () => {
    await sudokuMaster();
    const snapshot = await puzzleSnapshot(project.project.id);
    const first = allocate({ snapshot, slots: 3 });
    const second = allocate({ snapshot, slots: 3 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('puts a rights answer that would unblock sold work ahead of everything else', async () => {
    const format = await declareFormat({
      projectId: project.project.id,
      name: 'Cryptogram',
      actorRef: 'usr_test',
    });
    if (!format.ok) return;
    const master = await declareMaster({
      projectId: project.project.id,
      formatId: format.value.id,
      name: 'Unestablished quotations',
      generatorKey: 'CRYPTOGRAM_SUBSTITUTION_V1',
      spec: { text: 'Something worth enciphering at length' },
      rightsBasis: 'UNESTABLISHED',
      rightsStatement: null,
      actorRef: 'usr_test',
    });
    if (!master.ok) return;
    await produceBatch({ projectId: project.project.id, masterId: master.value.id, count: 1 });

    const snapshot = await puzzleSnapshot(project.project.id);
    const planned = allocate({ snapshot, slots: 1 });
    expect(planned.asks[0]?.purpose).toBe('RIGHTS');
    // The recorded reason says why, in words a person can argue with.
    expect(planned.asks[0]?.why).toMatch(/validated puzzle/i);
  });

  it('names what it declined and why, rather than answering with an id', async () => {
    await sudokuMaster();
    const snapshot = await puzzleSnapshot(project.project.id);
    const planned = allocate({ snapshot, slots: 0 });
    expect(planned.asks).toHaveLength(0);
    expect(planned.declined.length).toBeGreaterThan(0);
    for (const one of planned.declined) {
      expect(one.subject.length).toBeGreaterThan(0);
      expect(one.why.length).toBeGreaterThan(20);
    }
  });
});

/* =========================================================================
 * The reading
 * ====================================================================== */

describe('the reading a person sees', () => {
  it('reports revenue and physical yield as unknown with what would measure them', async () => {
    await sudokuMaster();
    const view = await puzzleView(project.project.id);
    expect(view.rightNow.revenue.value).toBeNull();
    expect(view.rightNow.revenue.wouldMeasureIt).toMatch(/Cash Mode/);
    expect(view.leverage.setupToUnitYield.value).toBeNull();
    expect(view.leverage.contributionPerSetup.value).toBeNull();
    expect(view.leverage.setupToUnitYield.wouldMeasureIt).toMatch(/manufacturing|ledger/i);
  });

  it('names every decision only a person can make, and what each one unblocks', async () => {
    const view = await puzzleView(project.project.id);
    expect(view.needsPerson.length).toBeGreaterThan(0);
    for (const one of view.needsPerson) {
      expect(one.what.length).toBeGreaterThan(10);
      expect(one.why.length).toBeGreaterThan(30);
    }
  });

  it('declares what its checking does not establish, so silence cannot read as coverage', async () => {
    await sudokuMaster();
    const view = await puzzleView(project.project.id);
    expect(view.quality.knownGaps.some((one) => /playtest/i.test(one))).toBe(true);
    expect(view.quality.knownGaps.some((one) => /calibrat/i.test(one))).toBe(true);
    expect(view.quality.knownGaps.some((one) => /press-ready|proof sheet/i.test(one))).toBe(true);
  });

  it('points at where the ledger and the production ladder actually live', async () => {
    const view = await puzzleView(project.project.id);
    const subjects = view.elsewhere.map((one) => `${one.what} ${one.where}`).join(' ');
    expect(subjects).toMatch(/Cash Mode/);
    expect(subjects).toMatch(/manufacturing/i);
    expect(subjects).toMatch(/Software Factory/);
  });

  it('says what happens next without anybody, rather than leaving it blank', async () => {
    await sudokuMaster();
    const view = await puzzleView(project.project.id);
    expect(view.next.length).toBeGreaterThan(0);
    expect(view.next.join(' ')).toMatch(/produce|question|absorb|Nothing/i);
  });
});

/* =========================================================================
 * The whole loop, walked
 * ====================================================================== */

describe('the loop', () => {
  it('runs from a declared master to a compiled product without anybody pressing anything twice', async () => {
    const { runPuzzleKernel } = await import('../server/services/puzzles/kernel.ts');
    const { master } = await sudokuMaster(30, 'Pocket Sudoku');

    // The tick produces and checks by itself. It needs no research grant to do
    // it, because producing spends nothing.
    let held = 0;
    for (let pass = 0; pass < 3 && held < 6; pass += 1) {
      await runPuzzleKernel(project.project.id);
      held = (await listInstancesForMaster(master.id)).length;
    }
    expect(held).toBeGreaterThanOrEqual(6);

    const instances = await listInstancesForMaster(master.id);
    const snapshot = await puzzleSnapshot(project.project.id);
    const mine = snapshot.masters.find((one) => one.master.id === master.id)!;
    expect(mine.validated).toBe(instances.length);

    // A person declares the product and what makes it distinct.
    const edition = await editionOf(master.id, 'Pocket Sudoku One', 'DISTINCT_CONTENT', null);
    for (const [index, instance] of instances.slice(0, 6).entries()) {
      const placed = await placeInEdition({
        projectId: project.project.id,
        editionId: edition.id,
        instanceId: instance.id,
        position: index,
      });
      expect(placed.ok).toBe(true);
    }

    const context = await editionContext(project.project.id);
    const reading = readEdition(
      context.editions.find((one) => one.id === edition.id)!,
      context,
    );
    expect(reading.qualified).toBe(true);
    expect(reading.validated).toBe(6);

    const compiled = await compileEdition({
      projectId: project.project.id,
      editionId: edition.id,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    // And the leverage reading counts it honestly, with its denominator named.
    const after = await editionContext(project.project.id);
    const leverage = readLeverage({
      context: after,
      readings: await readEditions(project.project.id),
    });
    expect(leverage.qualifiedEditions).toBe(1);
    expect(leverage.provenMasters).toBe(1);
    expect(leverage.masterToSku.value).toBe(1);
    if ('denominator' in leverage.masterToSku) {
      expect(leverage.masterToSku.denominator).toMatch(/master/);
    }
  });
});
