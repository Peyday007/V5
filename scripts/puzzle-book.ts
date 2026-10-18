/**
 * `npm run puzzle-book -- --volume v1 --count 100 --out <dir> [--layout large-print]`
 *
 * Makes one sudoku volume from Brain's own generator. Every puzzle is proved by
 * the format's independent validator, duplicates are refused by canonical form,
 * and the book is ordered by measured difficulty and typeset as an 8.5" × 11"
 * KDP-ready interior.
 *
 * It writes two files: the PDF, and a manifest naming every puzzle's seed, its
 * canonical hash, its verdict and the PDF's sha-256. Each seed is the
 * puzzle's whole specification, so any puzzle can be re-rendered and checked
 * by anybody with this repository.
 * The manifest is the audit trail for the product's one claim: every puzzle
 * has exactly one solution.
 *
 * It reads and writes no database row and contacts nobody.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SUDOKU } from '../server/services/puzzle/formats/index.ts';
import type { PuzzleSpec } from '../server/services/puzzle/formats/engine.ts';
import { typesetSudokuBook, type BookPuzzle } from '../server/services/puzzle/typeset.ts';

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

const ORDER = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];
const INTENDED = ['EASY', 'MEDIUM', 'HARD', 'HARD'] as const;

async function main(): Promise<void> {
  const volume = flag('volume') ?? 'v1';
  const count = Number(flag('count') ?? '100');
  const out = flag('out');
  const layout = flag('layout') === 'large-print' ? 'LARGE_PRINT' : 'STANDARD';
  if (!out) throw new Error('--out <directory> is required.');
  if (!Number.isInteger(count) || count < 1 || count > 400) throw new Error('--count must be 1..400.');

  const seen = new Set<string>();
  const kept: (BookPuzzle & { spec: PuzzleSpec })[] = [];
  let attempts = 0;
  let invalid = 0;
  let duplicates = 0;
  while (kept.length < count) {
    if (attempts >= count * 4) throw new Error(`Only ${kept.length} valid distinct puzzles after ${attempts} attempts.`);
    const spec: PuzzleSpec = {
      formatKey: SUDOKU.key,
      corpusId: 'common-english-v1',
      seed: `sudoku-book-${volume}-${attempts}`,
      parameters: { difficulty: INTENDED[attempts % INTENDED.length]! },
    };
    attempts += 1;
    const artifact = SUDOKU.render!(spec);
    const verdict = SUDOKU.validate(artifact);
    if (verdict.state !== 'VALID') {
      invalid += 1;
      continue;
    }
    if (seen.has(verdict.canonicalHash)) {
      duplicates += 1;
      continue;
    }
    seen.add(verdict.canonicalHash);
    kept.push({ spec, artifact, verdict });
  }
  kept.sort(
    (a, b) =>
      ORDER.indexOf(a.verdict.measuredDifficulty ?? '') - ORDER.indexOf(b.verdict.measuredDifficulty ?? ''),
  );

  const book = await typesetSudokuBook({
    title: `${layout === 'LARGE_PRINT' ? 'Large Print ' : ''}Sudoku: ${count} Puzzles With Exactly One Solution`,
    subtitle: `Easy to Expert, solutions included. Volume ${volume.replace(/^v/, '')}.`,
    rightsNotice:
      'Puzzles generated and independently verified by the Brain puzzle kernel. The buyer of this ' +
      'interior is granted a non-exclusive commercial licence to print, publish and sell the ' +
      'puzzles in their own books, including on Amazon KDP, and to change the layout, cover and ' +
      'title. The buyer may not resell or give away this PDF file, or the puzzle set as a set, ' +
      'as a template or interior product. Set in DejaVu Sans (Bitstream Vera licence).',
    puzzles: kept,
    layout,
  });

  fs.mkdirSync(out, { recursive: true });
  const name = `sudoku-${volume}${layout === 'LARGE_PRINT' ? '-large-print' : ''}`;
  const pdfPath = path.join(out, `${name}.pdf`);
  fs.writeFileSync(pdfPath, book.bytes);
  const sha256 = createHash('sha256').update(book.bytes).digest('hex');
  const byDifficulty: Record<string, number> = {};
  for (const one of kept) {
    const key = one.verdict.measuredDifficulty ?? 'UNRATED';
    byDifficulty[key] = (byDifficulty[key] ?? 0) + 1;
  }
  const manifest = {
    volume,
    pdf: path.basename(pdfPath),
    sha256,
    pages: book.pages,
    trim: '8.5x11in, no bleed',
    layout,
    puzzles: kept.length,
    attempts,
    refusedInvalid: invalid,
    refusedDuplicate: duplicates,
    byDifficulty,
    entries: kept.map((one, index) => ({
      number: index + 1,
      seed: one.spec.seed,
      intended: one.spec.parameters['difficulty'],
      measured: one.verdict.measuredDifficulty,
      canonicalHash: one.verdict.canonicalHash,
      checks: one.verdict.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}`),
    })),
  };
  fs.writeFileSync(path.join(out, `${name}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `PUZZLE-BOOK: OK volume=${volume} puzzles=${kept.length} pages=${book.pages} ` +
      `refused_invalid=${invalid} refused_duplicate=${duplicates} by=${JSON.stringify(byDifficulty)} sha256=${sha256}`,
  );
}

main().catch((error: Error) => {
  console.error(`PUZZLE-BOOK: FAILED ${error.message}`);
  process.exitCode = 1;
});
