/**
 * What the puzzle kernel may and may not conclude.
 *
 * ---------------------------------------------------------------------------
 * The refusals are what this file is for
 * ---------------------------------------------------------------------------
 *
 * Almost every assertion here is a refusal, because in this kernel an
 * acceptance is the expensive mistake. A puzzle wrongly refused costs a seed;
 * a puzzle wrongly accepted is a page in a book somebody paid for that cannot
 * be finished. A contribution wrongly withheld costs a question; a
 * contribution computed from a shelf price is a print run somebody funded on a
 * number the publisher never sees.
 *
 * ---------------------------------------------------------------------------
 * The validators are driven with broken artifacts on purpose
 * ---------------------------------------------------------------------------
 *
 * A test that generates a puzzle and checks it passes proves the generator and
 * the validator agree, which is the one thing a generator's own belief would
 * also prove. What establishes that the validator is doing work is handing it
 * a grid with a word missing, a maze with an extra opening, a sudoku with two
 * solutions, and a key that points at the wrong place — and watching it say
 * so, in each case, from the printed artifact alone.
 */
import { describe, expect, it } from 'vitest';
import {
  CROSSWORD,
  CRYPTOGRAM,
  MAZE,
  SUDOKU,
  WORD_SEARCH,
  formatFor,
  implementedFormats,
  type PuzzleArtifact,
  type PuzzleSpec,
} from '../server/services/puzzle/formats/index.ts';
import { CORPORA, mayCompileCommercially } from '../server/domain/puzzleCorpora.ts';
import { validatePuzzleFinding, loadBearingFor, directionFor, basisFor } from '../server/domain/puzzle.ts';
import { PUZZLE_ECONOMIC_COMPONENTS } from '../server/domain/types.ts';
import { readOne, readEconomics, dollarBookReading } from '../server/services/puzzle/economics.ts';
import { qualify } from '../server/services/puzzle/products.ts';
import { readMaturity } from '../server/services/puzzle/maturity.ts';
import { readLedger, MONETIZATION_ROUTES } from '../server/services/puzzle/ledger.ts';
import { readLeverage } from '../server/services/puzzle/leverage.ts';
import { readLessons } from '../server/services/puzzle/lessons.ts';
import type {
  PuzzleEconomic,
  PuzzleFormatEntry,
  PuzzleInstance,
  PuzzleObservation,
  PuzzleProduct,
} from '../server/domain/types.ts';

/* --------------------------------------------------------------------------
 * The generators
 * ------------------------------------------------------------------------ */

function spec(formatKey: string, corpusId: string, seed: string, parameters = {}): PuzzleSpec {
  return { formatKey, corpusId, seed, parameters };
}

describe('a generated puzzle is not a puzzle until a solver proves it', () => {
  it('every generated format renders, validates and reproduces byte for byte', () => {
    const cases: { format: typeof SUDOKU; spec: PuzzleSpec }[] = [
      { format: SUDOKU, spec: spec('sudoku', 'common-english-v1', 'a') },
      {
        format: WORD_SEARCH,
        spec: spec('word search', 'common-english-v1', 'b', { size: 12, words: 8 }),
      },
      { format: MAZE, spec: spec('maze', 'common-english-v1', 'c', { width: 8, height: 6 }) },
      { format: CRYPTOGRAM, spec: spec('cryptogram', 'traditional-proverbs-v1', 'd') },
    ];

    for (const one of cases) {
      const render = one.format.render;
      expect(render, `${one.format.key} has a generator`).not.toBeNull();
      const first = (render as NonNullable<typeof render>)(one.spec);
      const verdict = one.format.validate(first);
      expect(
        verdict.state,
        `${one.format.key}: ${verdict.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.name} — ${c.detail}`)
          .join('; ')}`,
      ).toBe('VALID');

      /*
       * Determinism is load-bearing rather than a nicety: the stored content
       * hash describes something nobody can reproduce if the same seed does
       * not render the same artifact, and "the specification is the storage"
       * becomes a claim rather than a property.
       */
      const second = (render as NonNullable<typeof render>)(one.spec);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it('a sudoku with two solutions is refused, from the printed grid alone', () => {
    const artifact = (SUDOKU.render as NonNullable<typeof SUDOKU.render>)(
      spec('sudoku', 'common-english-v1', 'unique'),
    );
    /*
     * Blank a cell that was a given. The grid stays legal, looks identical in
     * kind, and — for at least one choice of cell — stops having one answer.
     * The validator is handed nothing but the new grid.
     */
    let broken: PuzzleArtifact | null = null;
    for (let row = 0; row < 9 && !broken; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const line = artifact.grid[row] as string;
        if (line[col] === '.') continue;
        const blanked = [...artifact.grid];
        blanked[row] = `${line.slice(0, col)}.${line.slice(col + 1)}`;
        const candidate = { ...artifact, grid: blanked };
        if (SUDOKU.validate(candidate).state === 'INVALID') {
          broken = candidate;
          break;
        }
      }
    }
    expect(broken, 'blanking some given makes the grid non-unique').not.toBeNull();
    const verdict = SUDOKU.validate(broken as PuzzleArtifact);
    expect(verdict.state).toBe('INVALID');
    expect(verdict.measuredDifficulty).toBeNull();
  });

  it('a sudoku whose printed key is not its solution is refused', () => {
    const artifact = (SUDOKU.render as NonNullable<typeof SUDOKU.render>)(
      spec('sudoku', 'common-english-v1', 'key'),
    );
    const wrong = [...artifact.solution];
    const first = wrong[0] as string;
    /* One digit changed in the key. The grid is untouched and still unique. */
    wrong[0] = `${first[0] === '9' ? '8' : '9'}${first.slice(1)}`;
    const verdict = SUDOKU.validate({ ...artifact, solution: wrong, answerKey: wrong });
    expect(verdict.state).toBe('INVALID');
    expect(
      verdict.checks.find((one) => one.name === 'the printed solution is that solution')?.ok,
    ).toBe(false);
  });

  it('a word search missing one of its listed words is refused', () => {
    const artifact = (WORD_SEARCH.render as NonNullable<typeof WORD_SEARCH.render>)(
      spec('word search', 'common-english-v1', 'missing', { size: 12, words: 8 }),
    );
    const verdict = WORD_SEARCH.validate({
      ...artifact,
      prompts: [...artifact.prompts, 'ZZZZZZ'],
    });
    expect(verdict.state).toBe('INVALID');
    expect(
      verdict.checks.find((one) => one.name === 'every listed word is in the grid')?.detail,
    ).toContain('ZZZZZZ');
  });

  it('a word search whose grid spells a prohibited string is refused', () => {
    const artifact = (WORD_SEARCH.render as NonNullable<typeof WORD_SEARCH.render>)(
      spec('word search', 'common-english-v1', 'screen', { size: 12, words: 6 }),
    );
    const grid = [...artifact.grid];
    const line = grid[0] as string;
    grid[0] = `SHIT${line.slice(4)}`;
    const verdict = WORD_SEARCH.validate({ ...artifact, grid });
    expect(verdict.state).toBe('INVALID');
    expect(
      verdict.checks.find((one) => one.name === 'no prohibited string formed by accident')?.ok,
    ).toBe(false);
  });

  it('a maze with one extra opening is refused, because it then has two answers', () => {
    const artifact = (MAZE.render as NonNullable<typeof MAZE.render>)(
      spec('maze', 'common-english-v1', 'loop', { width: 6, height: 6 }),
    );
    expect(MAZE.validate(artifact).state).toBe('VALID');

    /*
     * Knock out one interior wall. The maze still prints, still has a route,
     * and now has a loop — so the answer key names one of two correct ways
     * through, and nothing about the picture shows it. The edge count does.
     */
    const grid = [...artifact.grid];
    let opened = false;
    for (let r = 2; r < grid.length - 2 && !opened; r += 1) {
      const line = grid[r] as string;
      for (let c = 2; c < line.length - 2; c += 1) {
        if (line[c] !== '#') continue;
        const candidate = [...grid];
        candidate[r] = `${line.slice(0, c)} ${line.slice(c + 1)}`;
        const verdict = MAZE.validate({ ...artifact, grid: candidate });
        const tree = verdict.checks.find((one) => one.name === 'exactly one route through');
        if (tree && !tree.ok) {
          grid[r] = candidate[r] as string;
          opened = true;
          break;
        }
      }
    }
    expect(opened, 'some interior wall removal creates a loop').toBe(true);
    expect(MAZE.validate({ ...artifact, grid }).state).toBe('INVALID');
  });

  it('a cryptogram claims a consistent cipher and never uniqueness', () => {
    const artifact = (CRYPTOGRAM.render as NonNullable<typeof CRYPTOGRAM.render>)(
      spec('cryptogram', 'traditional-proverbs-v1', 'crypt'),
    );
    const verdict = CRYPTOGRAM.validate(artifact);
    expect(verdict.state).toBe('VALID');
    /*
     * The check names are the contract. Nothing here says "unique", because
     * establishing it would mean searching 26! mappings against a definition
     * of English nobody has — and a check that claimed it would be the one
     * assertion in this kernel nothing stands behind.
     */
    expect(verdict.checks.map((one) => one.name).join(' ')).not.toContain('unique');
    expect(CRYPTOGRAM.limitation).toContain('Uniqueness is NOT established');
  });

  it('a cryptogram where a letter stands for itself is refused', () => {
    const artifact = (CRYPTOGRAM.render as NonNullable<typeof CRYPTOGRAM.render>)(
      spec('cryptogram', 'traditional-proverbs-v1', 'fixed'),
    );
    const plain = artifact.solution[0] as string;
    const verdict = CRYPTOGRAM.validate({
      ...artifact,
      grid: [plain],
      answerKey: [plain, ''],
    });
    expect(verdict.state).toBe('INVALID');
    expect(verdict.checks.find((one) => one.name === 'no letter stands for itself')?.ok).toBe(false);
  });

  it('crosswords have a validator and deliberately no generator', () => {
    expect(CROSSWORD.render).toBeNull();
    expect(CROSSWORD.authoring).toBe('AUTHORED');
    expect(CROSSWORD.requiresHumanEdit).toBe(true);

    /* A grid with an unchecked square and a missing clue, both found. */
    const verdict = CROSSWORD.validate({
      formatKey: 'crossword',
      instructions: '',
      grid: ['...#.', '...#.', '.....', '.#...', '.#...'],
      prompts: [],
      solution: ['CAT#S', 'ARE#P', 'MODEL', 'P#OWE', 'S#TEN'],
      answerKey: [],
      intendedDifficulty: 'MEDIUM',
    });
    expect(verdict.state).toBe('INVALID');
    expect(
      verdict.checks.find((one) => one.name === 'every white square is crossed both ways')?.ok,
    ).toBe(false);
    expect(
      verdict.checks.find((one) => one.name === 'there is exactly one clue per entry')?.ok,
    ).toBe(false);
    /* And difficulty is never measured, because what makes one hard is prose. */
    expect(verdict.measuredDifficulty).toBeNull();
  });

  it('a generator refuses a parameter it does not implement rather than clamping it', () => {
    expect(() =>
      (SUDOKU.render as NonNullable<typeof SUDOKU.render>)(
        spec('sudoku', 'common-english-v1', 'bad', { givens: 3 }),
      ),
    ).toThrow(/between 17 and 81/);
  });

  it('a corpus with no commercial rights compiles nothing, and says which', () => {
    const clue = CORPORA['crossword-clue-bank'];
    expect(clue).toBeDefined();
    expect(mayCompileCommercially((clue as NonNullable<typeof clue>).rights)).toBe(false);
    expect(mayCompileCommercially('UNKNOWN')).toBe(false);
    expect(mayCompileCommercially('NON_COMMERCIAL')).toBe(false);
    expect(mayCompileCommercially('PUBLIC_DOMAIN')).toBe(true);
    expect(mayCompileCommercially('OWNED')).toBe(true);
  });

  it('the format registry is a reading of this repository rather than a taxonomy', () => {
    /*
     * The registry answers *which formats can this repository make or check*,
     * which is a fact about code. It must never become the list of formats
     * that exist — that lives in `puzzle_formats` and is built from claims and
     * seeds. The assertion that keeps them apart is that a format nobody has
     * implemented resolves to nothing here rather than to a stub.
     */
    expect(formatFor('nonogram')).toBeNull();
    expect(formatFor('WORD  SEARCH')).toBe(WORD_SEARCH);
    expect(implementedFormats().filter((one) => one.render !== null)).toHaveLength(4);
    expect(implementedFormats()).toHaveLength(5);
  });
});

/* --------------------------------------------------------------------------
 * The declaration
 * ------------------------------------------------------------------------ */

describe('the one validator both submission doors call', () => {
  const base = {
    where: 'claims[0]',
    finding: undefined as unknown,
    subject: undefined as unknown,
    format: undefined as unknown,
    productClass: undefined as unknown,
    value: undefined as unknown,
    amountCents: undefined as unknown,
    currency: undefined as unknown,
  };

  it('accepts a claim that says nothing about the puzzle trade', () => {
    const result = validatePuzzleFinding(base);
    expect(result.ok).toBe(true);
  });

  it('refuses a companion field with no finding, rather than storing it', () => {
    const result = validatePuzzleFinding({ ...base, subject: 'Some publisher' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no puzzle_finding');
  });

  it('refuses a cost line declared as a price point, and names the remedy', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'PRICE_POINT',
      subject: 'one copy',
      format: 'word search',
      productClass: 'PRINT_BOOK',
      value: 'UNIT_PRINT_COST',
      amountCents: 90,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      /*
       * The refusal names the *other* finding rather than only reciting what
       * is accepted. A worker that made this mistake has made a real one with
       * a real remedy, and it is the one mistake here that would put a cost
       * into the revenue accumulator.
       */
      expect(result.error).toContain('PRODUCTION_COST');
      expect(result.error).toContain('makes a product look profitable');
    }
  });

  it('refuses a figure with no product class, because nothing could judge it', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'PRODUCTION_COST',
      subject: 'one copy',
      format: 'word search',
      value: 'UNIT_PRINT_COST',
      amountCents: 90,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('puzzle_product_class');
  });

  it('accepts a published zero, because an absent line and a zero line differ', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'PRODUCTION_COST',
      subject: 'one copy',
      format: 'word search',
      productClass: 'PRINT_BOOK',
      value: 'CHANNEL_FEE',
      amountCents: 0,
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.amountCents).toBe(0);
  });

  it('refuses a format on a rights constraint, which applies across formats', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'RIGHTS_CONSTRAINT',
      subject: 'A marketplace',
      format: 'word search',
      value: 'PLATFORM_RULE',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('applies across formats');
  });

  it('refuses a figure with no currency, because Brain never converts one', () => {
    const result = validatePuzzleFinding({
      ...base,
      finding: 'PRICE_POINT',
      subject: 'one copy',
      format: 'word search',
      productClass: 'PRINT_BOOK',
      value: 'NET_RECEIPT_PER_UNIT',
      amountCents: 40,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('puzzle_currency');
  });

  it('every economic component has a side and a basis, with no gaps', () => {
    /*
     * Two lookups that have to be total over the union. A component belonging
     * to neither would drop out of both accumulators silently, which is the
     * shape of error that makes a product look more profitable than it is —
     * §27's two `Set`s that had to be total between them and were not.
     */
    for (const component of PUZZLE_ECONOMIC_COMPONENTS) {
      expect(['REVENUE', 'COST']).toContain(directionFor(component));
      expect(['PER_UNIT', 'PER_RUN']).toContain(basisFor(component));
    }
  });

  it('a retail price is load-bearing for nothing, in any product class', () => {
    for (const productClass of [
      'PRINT_BOOK',
      'CARD_OR_BOXED',
      'DIGITAL_DOWNLOAD',
      'SERVICE',
    ] as const) {
      expect(loadBearingFor(productClass)).not.toContain('RETAIL_PRICE');
    }
  });
});

/* --------------------------------------------------------------------------
 * The money
 * ------------------------------------------------------------------------ */

function figure(
  component: PuzzleEconomic['component'],
  amountCents: number,
  productClass: PuzzleEconomic['productClass'] = 'PRINT_BOOK',
  currency = 'USD',
): PuzzleEconomic {
  return {
    id: `pze_${component}_${amountCents}_${currency}`,
    projectId: 'prj',
    formatKey: 'word search',
    productClass,
    component,
    amountCents,
    currency,
    basisNote: 'one copy',
    publisher: 'A printer',
    observedOn: '2026-08-01',
    sourceClaimId: `clm_${component}_${amountCents}_${currency}`,
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('the contribution is withheld rather than estimated', () => {
  it('a shelf price is never treated as receipts', () => {
    const reading = readOne('word search', 'PRINT_BOOK', [
      figure('RETAIL_PRICE', 100),
      figure('UNIT_PRINT_COST', 30),
      figure('FREIGHT_PER_UNIT', 10),
      figure('CHANNEL_FEE', 40),
      figure('RETURNS_ALLOWANCE', 5),
    ]);
    expect(reading.contributionPerUnitCents).toBeNull();
    expect(reading.retailPriceCents).toBe(100);
    expect(reading.withheld).toContain('what a shopper pays');
  });

  it('a missing load-bearing line withholds the total and names it', () => {
    const reading = readOne('word search', 'PRINT_BOOK', [
      figure('NET_RECEIPT_PER_UNIT', 45),
      figure('UNIT_PRINT_COST', 30),
    ]);
    expect(reading.contributionPerUnitCents).toBeNull();
    expect(reading.withheld).toContain('FREIGHT_PER_UNIT');
    expect(reading.withheld).toContain('CHANNEL_FEE');
  });

  it('two currencies withhold the total rather than converting', () => {
    const reading = readOne('word search', 'DIGITAL_DOWNLOAD', [
      figure('NET_RECEIPT_PER_UNIT', 300, 'DIGITAL_DOWNLOAD', 'USD'),
      figure('CHANNEL_FEE', 90, 'DIGITAL_DOWNLOAD', 'GBP'),
    ]);
    expect(reading.contributionPerUnitCents).toBeNull();
    expect(reading.withheld).toContain('never converts');
  });

  it('a complete class reports a contribution, at the worst published end', () => {
    const reading = readOne('word search', 'DIGITAL_DOWNLOAD', [
      figure('NET_RECEIPT_PER_UNIT', 500, 'DIGITAL_DOWNLOAD'),
      { ...figure('NET_RECEIPT_PER_UNIT', 400, 'DIGITAL_DOWNLOAD'), id: 'pze_b', sourceClaimId: 'clm_b' },
      figure('CHANNEL_FEE', 150, 'DIGITAL_DOWNLOAD'),
      figure('SETUP_COST', 2000, 'DIGITAL_DOWNLOAD'),
    ]);
    expect(reading.withheld).toBeNull();
    /* The lowest receipt and the highest cost: the end this could least defend. */
    expect(reading.receiptsPerUnitCents).toBe(400);
    expect(reading.contributionPerUnitCents).toBe(250);
    /* And the per-run cost is a breakeven rather than part of the unit total. */
    expect(reading.perUnitCostCents).toBe(150);
    expect(reading.perRunCostCents).toBe(2000);
    expect(reading.breakevenUnits).toBe(8);
  });

  it('a negative contribution is reported rather than withheld', () => {
    const reading = readOne('word search', 'DIGITAL_DOWNLOAD', [
      figure('NET_RECEIPT_PER_UNIT', 100, 'DIGITAL_DOWNLOAD'),
      figure('CHANNEL_FEE', 150, 'DIGITAL_DOWNLOAD'),
    ]);
    expect(reading.withheld).toBeNull();
    expect(reading.contributionPerUnitCents).toBe(-50);
    expect(reading.breakevenUnits).toBeNull();
  });

  it('the dollar-book question names what is missing rather than guessing', () => {
    const empty = dollarBookReading([]);
    expect(empty.verdict).toContain('Nothing has been established');
    expect(empty.missing.length).toBeGreaterThan(5);

    const partial = dollarBookReading([figure('RETAIL_PRICE', 100)]);
    expect(partial.established.some((one) => one.startsWith('RETAIL_PRICE'))).toBe(true);
    expect(partial.missing.some((one) => one.startsWith('NET_RECEIPT_PER_UNIT'))).toBe(true);
  });

  it('readEconomics keeps each (format, class) apart', () => {
    const rows = [
      figure('NET_RECEIPT_PER_UNIT', 400, 'DIGITAL_DOWNLOAD'),
      figure('RETAIL_PRICE', 100, 'PRINT_BOOK'),
    ];
    const readings = readEconomics(rows);
    expect(readings).toHaveLength(2);
  });
});

/* --------------------------------------------------------------------------
 * Products and leverage
 * ------------------------------------------------------------------------ */

function product(overrides: Partial<PuzzleProduct> & { id: string }): PuzzleProduct {
  return {
    projectId: 'prj',
    masterId: 'pzm_1',
    title: overrides.id,
    productClass: 'DIGITAL_DOWNLOAD',
    audience: null,
    useOccasion: null,
    language: 'en',
    difficulty: 'MEDIUM',
    channel: null,
    buyer: null,
    instanceCount: 10,
    opportunityId: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('a reskin has nowhere to be declared as a difference', () => {
  it('the same puzzles with nothing else changed is a reskin', () => {
    const products = [product({ id: 'a' }), product({ id: 'b' })];
    const membership = new Map([
      ['a', ['i1', 'i2', 'i3', 'i4']],
      ['b', ['i1', 'i2', 'i3', 'i4']],
    ]);
    const verdicts = qualify({ products, membership });
    const b = verdicts.find((one) => one.productId === 'b');
    expect(b?.verdict).toBe('RESKIN');
    expect(b?.dimensions).toHaveLength(0);
    expect(b?.because).toContain('cover');
  });

  it('the same puzzles in another language is a distinct output', () => {
    const products = [product({ id: 'a' }), product({ id: 'b', language: 'fr' })];
    const membership = new Map([
      ['a', ['i1', 'i2']],
      ['b', ['i1', 'i2']],
    ]);
    const b = qualify({ products, membership }).find((one) => one.productId === 'b');
    expect(b?.verdict).toBe('QUALIFIED');
    expect(b?.dimensions).toContain('LANGUAGE');
  });

  it('genuinely new content is a distinct output with nothing else changed', () => {
    const products = [product({ id: 'a' }), product({ id: 'b' })];
    const membership = new Map([
      ['a', ['i1', 'i2', 'i3', 'i4']],
      ['b', ['i5', 'i6', 'i7', 'i8']],
    ]);
    const b = qualify({ products, membership }).find((one) => one.productId === 'b');
    expect(b?.verdict).toBe('QUALIFIED');
    expect(b?.dimensions).toContain('PUZZLE_CONTENT');
  });

  it('a sampler drawn entirely from a bigger book is the buyer’s own puzzles again', () => {
    /*
     * The overlap is measured against the *smaller* product deliberately. By
     * Jaccard this pair scores 0.25 and looks distinct; to somebody who owns
     * the big book, the sampler is four puzzles they already have.
     */
    const products = [product({ id: 'big', instanceCount: 16 }), product({ id: 'sampler' })];
    const membership = new Map([
      ['big', ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10', 'i11', 'i12', 'i13', 'i14', 'i15', 'i16']],
      ['sampler', ['i1', 'i2', 'i3', 'i4']],
    ]);
    const sampler = qualify({ products, membership }).find((one) => one.productId === 'sampler');
    expect(sampler?.verdict).toBe('RESKIN');
  });

  it('leverage counts qualified outputs and reports the rest as UNKNOWN', () => {
    const instances: PuzzleInstance[] = [1, 2, 3].map((n) => ({
      id: `pzi_${n}`,
      projectId: 'prj',
      masterId: 'pzm_1',
      seed: `s${n}`,
      contentHash: `h${n}`,
      canonicalHash: `c${n}`,
      validationState: 'VALID',
      measuredDifficulty: 'MEDIUM',
      checks: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    const products = [product({ id: 'a' }), product({ id: 'b', language: 'fr' })];
    const membership = new Map([
      ['a', ['pzi_1']],
      ['b', ['pzi_1']],
    ]);
    const leverage = readLeverage({
      masters: [],
      instances,
      products,
      qualifications: qualify({ products, membership }),
      observations: [],
    });
    expect(leverage.provenMasters).toBe(1);
    expect(leverage.qualifiedOutputs).toBe(2);
    expect(leverage.masterToSku.evidence).toBe('MEASURED');
    expect(leverage.masterToSku.value).toBe(2);

    /*
     * Zero is a measurement and a missing measurement is not. Nothing here has
     * been printed or paid for, so both of these are UNKNOWN with what would
     * move them — never 0, which would read as a yield of nothing.
     */
    expect(leverage.setupToUnitYield.evidence).toBe('UNKNOWN');
    expect(leverage.setupToUnitYield.value).toBeNull();
    expect(leverage.contributionPerSetup.evidence).toBe('UNKNOWN');
    expect(leverage.validPuzzlesPerEditorialHour.note).toContain('not a substitute');
  });
});

/* --------------------------------------------------------------------------
 * The ladder and the ledger
 * ------------------------------------------------------------------------ */

function formatEntry(name: string): PuzzleFormatEntry {
  return {
    id: `pzf_${name}`,
    projectId: 'prj',
    name,
    formatKey: name.toLowerCase(),
    note: null,
    origin: 'SEED',
    sourceClaimId: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function emptyMaturityInput() {
  return {
    formats: [formatEntry('word search')],
    masters: [],
    instances: [],
    products: [],
    qualifications: [],
    demand: [],
    routes: [],
    constraints: [],
    observations: [],
    settledOpportunityIds: new Set<string>(),
    heldCapabilities: [],
  };
}

describe('the maturity ladder stops at the first rung that is not true', () => {
  it('a format with nothing established reads DISCOVERED and asks for research', () => {
    const [one] = readMaturity(emptyMaturityInput());
    expect(one?.rung).toBe('DISCOVERED');
    expect(one?.remedy).toBe('RESEARCH');
  });

  it('a format nothing implements can never reach GENERATABLE, whatever else is true', () => {
    const [one] = readMaturity({
      ...emptyMaturityInput(),
      formats: [formatEntry('nonogram')],
      demand: [
        {
          id: 'pzd_1',
          projectId: 'prj',
          formatKey: 'nonogram',
          buyer: 'A magazine',
          buyerKey: 'a magazine',
          statement: 'They publish submission terms.',
          publisher: 'A magazine',
          observedOn: '2026-08-01',
          sourceClaimId: 'clm_1',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
    expect(one?.rung).toBe('RESEARCHED');
    expect(one?.remedy).toBe('CODE');
    expect(one?.waitingOn).toContain('code change');
  });

  it('SELLABLE needs a person to have read what the machine made', () => {
    const base = {
      ...emptyMaturityInput(),
      masters: [{ id: 'pzm_1', formatKey: 'word search' }],
      instances: [
        {
          id: 'pzi_1',
          projectId: 'prj',
          masterId: 'pzm_1',
          seed: 's',
          contentHash: 'h',
          canonicalHash: 'c',
          validationState: 'VALID' as const,
          measuredDifficulty: 'MEDIUM' as const,
          checks: [],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      products: [product({ id: 'a' })],
      qualifications: [
        { productId: 'a', verdict: 'QUALIFIED' as const, dimensions: [], because: 'first' },
      ],
      routes: [
        {
          id: 'pzr_1',
          projectId: 'prj',
          kind: 'CHANNEL' as const,
          formatKey: 'word search',
          name: 'A marketplace',
          nameKey: 'a marketplace',
          terms: '30% of list, no exclusivity.',
          publisher: 'A marketplace',
          observedOn: '2026-08-01',
          sourceClaimId: 'clm_2',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    };

    const without = readMaturity(base)[0];
    expect(without?.rung).toBe('PRODUCTIZABLE');
    expect(without?.remedy).toBe('PERSON');
    expect(without?.waitingOn).toContain('read or played');

    const observation: PuzzleObservation = {
      id: 'pzo_1',
      projectId: 'prj',
      kind: 'HUMAN_EDIT_PASSED',
      formatKey: 'word search',
      productId: null,
      monetizationRoute: null,
      statement: 'Read twenty of them; the fill is fine and nothing is ambiguous.',
      recordedBy: 'usr_1',
      createdAt: '2026-08-02T00:00:00.000Z',
    };
    const withEdit = readMaturity({ ...base, observations: [observation] })[0];
    expect(withEdit?.rung).toBe('SELLABLE');
    /* And REVENUE_PROVEN still needs a settlement, not an agreement. */
    expect(withEdit?.remedy).toBe('MONEY');
  });
});

describe('the ladder does not sort a catalog below an empty format', () => {
  it('ties break on what exists rather than on the name', () => {
    /*
     * The defect this pins was found by running the kernel rather than by
     * reading it: with every format stuck at DISCOVERED for want of a buyer,
     * the tie fell through to the name and put a crossword Brain cannot
     * generate above a sudoku holding forty proved puzzles and two products.
     * Technically true, and it sends somebody to the wrong format.
     */
    const ranked = readMaturity({
      ...emptyMaturityInput(),
      formats: [formatEntry('crossword'), formatEntry('sudoku')],
      masters: [{ id: 'pzm_s', formatKey: 'sudoku' }],
      instances: Array.from({ length: 40 }, (_unused, n) => ({
        id: `pzi_${n}`,
        projectId: 'prj',
        masterId: 'pzm_s',
        seed: `s${n}`,
        contentHash: `h${n}`,
        canonicalHash: `c${n}`,
        validationState: 'VALID' as const,
        measuredDifficulty: 'MEDIUM' as const,
        checks: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      })),
      products: [product({ id: 'a', masterId: 'pzm_s' })],
      qualifications: [
        { productId: 'a', verdict: 'QUALIFIED' as const, dimensions: [], because: 'first' },
      ],
    });
    expect(ranked[0]?.name).toBe('sudoku');
    expect(ranked[0]?.rung).toBe('DISCOVERED');
    expect(ranked[0]?.evidence.validPuzzles).toBe(40);
    /* Both are on the same rung, and the counts say they are not the same situation. */
    expect(ranked[1]?.rung).toBe('DISCOVERED');
    expect(ranked[1]?.evidence.validPuzzles).toBe(0);
  });
});

describe('the monetization ledger keeps everything and ranks without a score', () => {
  it('routes are never removed, and a rejected one stays with its reason', () => {
    const rejected: PuzzleObservation = {
      id: 'pzo_r',
      projectId: 'prj',
      kind: 'ROUTE_REJECTED',
      formatKey: null,
      productId: null,
      monetizationRoute: 'mechanical-puzzles',
      statement: 'Too much tooling for this sprint.',
      recordedBy: 'usr_1',
      createdAt: '2026-08-02T00:00:00.000Z',
    };
    const ledger = readLedger({
      maturity: [],
      demand: [],
      routes: [],
      economics: [],
      constraints: [],
      observations: [rejected],
      heldCapabilities: [],
    });
    expect(ledger).toHaveLength(MONETIZATION_ROUTES.length);
    const one = ledger.find((entry) => entry.route.id === 'mechanical-puzzles');
    expect(one?.state).toBe('ARCHIVED');
    expect(one?.next).toContain('Too much tooling');
  });

  it('the order is by state, then unmet requirements, then capital at risk', () => {
    const ledger = readLedger({
      maturity: [],
      demand: [],
      routes: [],
      economics: [],
      constraints: [],
      observations: [],
      heldCapabilities: [],
    });
    /*
     * With nothing established every route is UNPROVEN, so the separation is
     * entirely by requirement count and capital — which is the ordering
     * statement: the cheapest thing that risks nothing comes first.
     */
    const first = ledger[0];
    expect(first?.route.capitalAtRisk).toBe('NONE');
    for (let i = 1; i < ledger.length; i += 1) {
      const a = ledger[i - 1];
      const b = ledger[i];
      if (!a || !b || a.state !== b.state) continue;
      expect(a.unmet.length).toBeLessThanOrEqual(b.unmet.length);
    }
  });

  it('reads validated output from the catalog, never from the business ladder', () => {
    /*
     * The defect this pins was printed in a live operator report: the ledger
     * asked whether a format had *reached* VALIDATABLE, the ladder stops at
     * the first rung that is not met, and a format with 136 proved puzzles
     * and no published buyer stops at DISCOVERED. So the report said "No
     * format here yet produces puzzles that pass their own checks" about a
     * catalog that did — every row healthy and the sentence false.
     */
    const ledger = readLedger({
      maturity: [
        {
          formatKey: 'word search',
          name: 'word search',
          rung: 'DISCOVERED',
          waitingOn: 'no published buyer',
          remedy: 'RESEARCH',
          reached: ['DISCOVERED'],
          evidence: { validPuzzles: 136, products: 6, buyers: 0, channels: 0 },
          limitation: null,
        },
      ],
      demand: [],
      routes: [],
      economics: [],
      constraints: [],
      observations: [],
      heldCapabilities: [],
    });
    const licensing = ledger.find((one) => one.route.id === 'licensing-catalog');
    expect(licensing?.met).toContain('VALIDATED_OUTPUT');
    expect(licensing?.next).not.toContain('pass their own checks');
    expect(licensing?.next).toContain('who actually pays');
  });

  it('a route short only of things no question can answer reads BLOCKED', () => {
    const ledger = readLedger({
      maturity: [
        {
          formatKey: 'word search',
          name: 'word search',
          rung: 'PRODUCTIZABLE',
          waitingOn: '',
          remedy: 'PERSON',
          reached: ['DISCOVERED', 'RESEARCHED', 'GENERATABLE', 'VALIDATABLE', 'PRODUCTIZABLE'],
          evidence: { validPuzzles: 1, products: 1, buyers: 0, channels: 0 },
          limitation: null,
        },
      ],
      demand: [],
      routes: [],
      economics: [],
      constraints: [],
      observations: [],
      heldCapabilities: [],
    });
    const licensing = ledger.find((one) => one.route.id === 'licensing-catalog');
    /* VALIDATED_OUTPUT is met and PUBLISHED_BUYER is not, so it is a question. */
    expect(licensing?.state).toBe('NEXT_BEST');
    expect(licensing?.next).toContain('research question');
  });
});

describe('a lesson is derived with its sample shown', () => {
  it("Brain's own readings are counted apart from a person's", () => {
    const rows: PuzzleObservation[] = [1, 2, 3].map((n) => ({
      id: `pzo_${n}`,
      projectId: 'prj',
      kind: 'SUBMISSION_REJECTED',
      formatKey: 'word search',
      productId: null,
      monetizationRoute: null,
      statement: `rejection ${n}`,
      recordedBy: 'BRAIN',
      createdAt: `2026-08-0${n}T00:00:00.000Z`,
    }));
    const brainOnly = readLessons(rows);
    expect(brainOnly[0]?.observations).toBe(3);
    expect(brainOnly[0]?.strength).toBe('ANECDOTE');

    const withPeople = readLessons(rows.map((one) => ({ ...one, recordedBy: 'usr_1' })));
    expect(withPeople[0]?.strength).toBe('PATTERN');
    expect(withPeople[0]?.fromPeople).toBe(3);
    /* And the rows travel with the rule, so a reader can check rather than believe. */
    expect(withPeople[0]?.statements).toHaveLength(3);
  });
});
