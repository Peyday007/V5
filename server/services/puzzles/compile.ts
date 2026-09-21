/**
 * Turning a qualified edition into bytes somebody can hold.
 *
 * ---------------------------------------------------------------------------
 * What this produces is a proof sheet, and it says so on its first page
 * ---------------------------------------------------------------------------
 *
 * It is a complete, readable rendering of every puzzle in the edition with its
 * answer key — the thing a person reviews before anything is sold, and the
 * thing a buyer of a digital pack could actually use. It is **not** a
 * press-ready artifact: there is no typography, no page architecture, no trim,
 * no bleed and no imposition, and the brief lists all of those as parts of a
 * master. Saying so in the artifact itself is the point, because a file called
 * "edition.pdf" that nobody reads the first page of is how a proof gets sent
 * to a printer.
 *
 * `view.ts` reports the missing layout compiler as a named gap with a remedy,
 * so the absence is visible rather than implied.
 *
 * ---------------------------------------------------------------------------
 * It renders from the payload and never re-derives an answer
 * ---------------------------------------------------------------------------
 *
 * The brief requires the puzzle, the solution, the answer key and the layout
 * to come from one canonical source. The renderers below read
 * `puzzle_instances.payload` and solve nothing: a compiler that worked out the
 * answers itself would be a second derivation, and the two would eventually
 * disagree about the same book.
 *
 * ---------------------------------------------------------------------------
 * It refuses to compile something that is not a product
 * ---------------------------------------------------------------------------
 *
 * An unqualified edition produces no artifact. That is the one place in this
 * kernel where a derived reading *gates* rather than reports, and it is
 * deliberate: everything else here is a statement about the world, and this is
 * the step that makes a file somebody might send to a buyer.
 */
import { getProject } from '../../repos/projects.ts';
import { getMaster, listEditionInstances, markEditionCompiled } from '../../repos/puzzles.ts';
import { getEdition } from '../../repos/puzzles.ts';
import { recordEvent } from '../../repos/events.ts';
import { storeFile } from '../storage.ts';
import { editionContext, readEdition } from './editions.ts';
import { readValidation } from './validate.ts';
import type { PuzzleEdition, PuzzleInstance } from '../../domain/types.ts';

/* ==========================================================================
 * Renderers. One per format, reading the payload and nothing else.
 * ======================================================================== */

function renderSudoku(payload: Record<string, unknown>): { puzzle: string; answer: string } {
  const givens = typeof payload['givens'] === 'string' ? payload['givens'] : '';
  const solution = typeof payload['solution'] === 'string' ? payload['solution'] : '';

  const draw = (text: string) => {
    const lines: string[] = [];
    for (let row = 0; row < 9; row += 1) {
      if (row % 3 === 0) lines.push('+-------+-------+-------+');
      const cells: string[] = [];
      for (let col = 0; col < 9; col += 1) {
        if (col % 3 === 0) cells.push('|');
        cells.push(text[row * 9 + col] ?? '.');
      }
      cells.push('|');
      lines.push(cells.join(' '));
    }
    lines.push('+-------+-------+-------+');
    return lines.join('\n');
  };

  return { puzzle: draw(givens), answer: draw(solution) };
}

function renderWordSearch(payload: Record<string, unknown>): { puzzle: string; answer: string } {
  const rows = Array.isArray(payload['rows']) ? (payload['rows'] as unknown[]) : [];
  const words = Array.isArray(payload['words']) ? (payload['words'] as unknown[]) : [];
  const placements = Array.isArray(payload['placements'])
    ? (payload['placements'] as unknown[])
    : [];

  const grid = rows
    .map((row) => (typeof row === 'string' ? [...row].join(' ') : ''))
    .join('\n');
  const list = words
    .filter((word): word is string => typeof word === 'string')
    .map((word) => `  - ${word}`)
    .join('\n');

  const key = placements
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const one = entry as Record<string, unknown>;
      const word = one['word'];
      const row = one['row'];
      const col = one['col'];
      const dr = one['dr'];
      const dc = one['dc'];
      if (typeof word !== 'string' || typeof row !== 'number' || typeof col !== 'number') {
        return null;
      }
      const heading =
        `${dr === -1 ? 'up' : dr === 1 ? 'down' : ''}${dc === -1 ? 'left' : dc === 1 ? 'right' : ''}` ||
        'here';
      return `  - ${word}: row ${row + 1}, column ${col + 1}, running ${heading}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');

  return { puzzle: `${grid}\n\nFind:\n${list}`, answer: key };
}

function renderMaze(payload: Record<string, unknown>): { puzzle: string; answer: string } {
  const rows = Array.isArray(payload['passages']) ? (payload['passages'] as unknown[]) : [];
  const width = typeof payload['width'] === 'number' ? payload['width'] : 0;
  const height = typeof payload['height'] === 'number' ? payload['height'] : 0;
  const start = typeof payload['start'] === 'number' ? payload['start'] : 0;
  const end = typeof payload['end'] === 'number' ? payload['end'] : 0;
  const solution = Array.isArray(payload['solution'])
    ? (payload['solution'] as unknown[]).filter((one): one is number => typeof one === 'number')
    : [];

  const open = (cell: number): number => {
    const row = Math.floor(cell / width);
    const col = cell % width;
    const text = rows[row];
    if (typeof text !== 'string') return 0;
    const value = Number.parseInt(text[col] ?? '0', 16);
    return Number.isInteger(value) ? value : 0;
  };

  /*
   * Two characters per cell, so the passages between them are visible. A maze
   * drawn one character per cell has nowhere to put a wall.
   */
  const draw = (path: ReadonlySet<number>): string => {
    const lines: string[] = [];
    lines.push('+'.padEnd(width * 2 + 1, '-').replace(/-/g, '--').slice(0, width * 2 + 1));
    for (let row = 0; row < height; row += 1) {
      let body = '|';
      let under = '+';
      for (let col = 0; col < width; col += 1) {
        const cell = row * width + col;
        const bits = open(cell);
        const mark = cell === start ? 'S' : cell === end ? 'E' : path.has(cell) ? '*' : ' ';
        body += mark;
        body += (bits & 2) !== 0 ? ' ' : '|';
        under += (bits & 4) !== 0 ? ' ' : '-';
        under += '+';
      }
      lines.push(body, under);
    }
    return lines.join('\n');
  };

  return {
    puzzle: draw(new Set()),
    answer: draw(new Set(solution)),
  };
}

function renderCryptogram(payload: Record<string, unknown>): { puzzle: string; answer: string } {
  const ciphertext = typeof payload['ciphertext'] === 'string' ? payload['ciphertext'] : '';
  const plaintext = typeof payload['plaintext'] === 'string' ? payload['plaintext'] : '';
  const attribution = typeof payload['attribution'] === 'string' ? payload['attribution'] : null;

  const wrap = (text: string) =>
    (text.match(/.{1,60}(\s|$)/g) ?? [text]).map((line) => `  ${line.trim()}`).join('\n');

  return {
    puzzle: wrap(ciphertext) + (attribution ? `\n\n  — ${attribution}` : ''),
    answer: wrap(plaintext),
  };
}

const RENDERERS: Record<string, (payload: Record<string, unknown>) => { puzzle: string; answer: string }> =
  {
    SUDOKU: renderSudoku,
    WORD_SEARCH: renderWordSearch,
    MAZE: renderMaze,
    CRYPTOGRAM: renderCryptogram,
  };

/** What a puzzle looks like on a page, or an honest note that nothing draws it. */
export function render(instance: PuzzleInstance): { puzzle: string; answer: string } {
  const kind = typeof instance.payload['kind'] === 'string' ? instance.payload['kind'] : '';
  const renderer = RENDERERS[kind];
  if (!renderer) {
    return {
      puzzle: `  [No renderer in this repository draws a ${kind || 'puzzle'} of this kind.]`,
      answer: '  [Not rendered.]',
    };
  }
  return renderer(instance.payload);
}

export interface CompiledEdition {
  editionId: string;
  artifactKey: string;
  artifactHash: string;
  bytes: number;
  puzzles: number;
}

export type CompileOutcome =
  | { ok: true; value: CompiledEdition }
  | { ok: false; reason: string };

export async function compileEdition(input: {
  projectId: string;
  editionId: string;
}): Promise<CompileOutcome> {
  const edition = await getEdition(input.editionId);
  if (!edition || edition.projectId !== input.projectId) {
    return { ok: false, reason: 'No edition with that id.' };
  }
  if (edition.compiledAt) {
    return {
      ok: false,
      reason:
        `${edition.name} has already been compiled. Its artifact is what a buyer received and ` +
        'its hash is what describes it; compiling over that would make every earlier statement ' +
        'about this edition unverifiable. A changed edition is a new edition.',
    };
  }

  const context = await editionContext(input.projectId);
  const reading = readEdition(edition, context);
  if (!reading.qualified) {
    const unmet = reading.conditions.filter((one) => one.state !== 'MET');
    return {
      ok: false,
      reason:
        `${edition.name} is not a qualified output, so nothing is compiled from it. ` +
        unmet.map((one) => `${one.key}: ${one.why}`).join(' '),
    };
  }

  const [project, master, members] = await Promise.all([
    getProject(edition.projectId),
    getMaster(edition.masterId),
    listEditionInstances(edition.id),
  ]);
  if (!project) return { ok: false, reason: 'The project this edition belongs to is gone.' };
  if (!master) return { ok: false, reason: 'The master this edition was compiled from is gone.' };

  const instances = members
    .map((member) => context.instances.get(member.instanceId))
    .filter((one): one is PuzzleInstance => one !== undefined);

  const pages: string[] = [];
  const keys: string[] = [];

  instances.forEach((instance, index) => {
    const drawn = render(instance);
    const format = context.formats.get(instance.formatId);
    const validation = readValidation({
      formatSlug: format?.slug ?? '',
      instance,
      validations: context.validations.get(instance.id) ?? [],
    });
    pages.push(
      [
        `## Puzzle ${index + 1}`,
        '',
        '```',
        drawn.puzzle,
        '```',
        '',
        `*${format?.name ?? 'Unknown format'}` +
          (instance.measuredDifficulty !== null
            ? ` · measured difficulty ${instance.measuredDifficulty}`
            : '') +
          `. ${validation.why}*`,
        '',
      ].join('\n'),
    );
    keys.push([`### Puzzle ${index + 1}`, '', '```', drawn.answer, '```', ''].join('\n'));
  });

  const rights =
    `${master.rightsBasis}` +
    (master.rightsStatement ? ` — ${master.rightsStatement}` : '') +
    (master.rightsClaimId ? ` (established by claim ${master.rightsClaimId})` : '');

  const document = [
    `# ${edition.name}`,
    '',
    `**${edition.productClass}**, compiled from the master *${master.name}*.`,
    '',
    `${edition.rationale}`,
    '',
    '> **This is a proof sheet, not a press-ready artifact.** It carries every puzzle in this',
    '> edition and its answer key, rendered as text, so that a person can check the work and a',
    '> digital pack can be assembled from it. It has no typography, no page architecture, no',
    '> trim, no bleed and no imposition. Sending this to a printer as artwork would be a',
    '> mistake; Brain has no layout compiler and says so rather than implying one.',
    '',
    '## Provenance',
    '',
    `- Master: ${master.name} (${master.id})`,
    `- Generator: ${master.generatorKey} ${master.generatorVersion}`,
    `- Rights basis: ${rights}`,
    `- Distinctness: ${edition.distinctnessAxis}` +
      (edition.distinctnessValue ? ` — ${edition.distinctnessValue}` : ''),
    `- Puzzles: ${instances.length}, every one of which passed every check its format requires.`,
    '',
    'Each puzzle below carries the seed it was generated from in this edition’s record, so any',
    'one of them can be reproduced exactly and re-checked.',
    '',
    '---',
    '',
    ...pages,
    '---',
    '',
    '# Answer key',
    '',
    ...keys,
  ].join('\n');

  const contents = Buffer.from(document, 'utf8');

  /*
   * Through the storage layer, never by building a path.
   *
   * §1's rule: a path built by hand is correct in exactly one deployment mode,
   * and this Brain runs in two. The filename is Brain's, composed from the
   * edition's own name and id rather than from anything a caller sent.
   */
  const stored = await storeFile({
    projectSlug: project.slug,
    layerSlug: null,
    filename: `${edition.name.replace(/[^A-Za-z0-9 _-]/g, '')} (${edition.id}).md`,
    contents,
  });

  const marked = await markEditionCompiled({
    id: edition.id,
    projectId: input.projectId,
    artifactKey: stored.storageKey,
    artifactHash: stored.hash,
  });

  await recordEvent({
    projectId: input.projectId,
    entityType: 'puzzle_edition',
    entityId: edition.id,
    eventType: 'PUZZLE_EDITION_COMPILED',
    payload: {
      name: edition.name,
      productClass: edition.productClass,
      puzzles: instances.length,
      artifactKey: stored.storageKey,
      artifactHash: stored.hash,
      bytes: contents.byteLength,
      proofSheetOnly: true,
    },
  });

  return {
    ok: true,
    value: {
      editionId: edition.id,
      artifactKey: marked?.artifactKey ?? stored.storageKey,
      artifactHash: marked?.artifactHash ?? stored.hash,
      bytes: contents.byteLength,
      puzzles: instances.length,
    },
  };
}

/** The edition a caller asked about, for a route that needs it before compiling. */
export async function editionById(id: string): Promise<PuzzleEdition | null> {
  return getEdition(id);
}
