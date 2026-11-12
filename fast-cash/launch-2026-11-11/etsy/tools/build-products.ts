/**
 * Builds every Etsy product PDF for the 2026-11-11 launch.
 *
 *   npx tsx fast-cash/launch-2026-11-11/etsy/tools/build-products.ts
 *
 * Puzzles come from Brain's own formats (server/services/puzzle/formats):
 *  - sudoku: SUDOKU.render + SUDOKU.validate (exactly one solution, proved), typeset by
 *    Brain's typesetSudokuBook;
 *  - mazes: MAZE.render + MAZE.validate (perfect maze: a tree, one route);
 *  - Christmas word searches: placed here with themed word lists, then accepted only if
 *    WORD_SEARCH.validate passes (every word found exactly once by searching the printed
 *    grid, answer key re-derived, prohibited-string screen).
 * Every puzzle's canonical hash is checked against every other product, so no two
 * products share a puzzle. Each product gets a manifest of seeds and verdicts.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { MAZE, SUDOKU, WORD_SEARCH, Rng } from '../../../../server/services/puzzle/formats/index.ts';
import type { PuzzleArtifact, PuzzleSpec, PuzzleVerdict } from '../../../../server/services/puzzle/formats/engine.ts';
import { typesetSudokuBook } from '../../../../server/services/puzzle/typeset.ts';
import { KID_THEMES, THEMES, type Theme } from './words.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright') as typeof import('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRODUCTS = path.join(ROOT, 'products');

interface Made {
  spec: PuzzleSpec;
  artifact: PuzzleArtifact;
  verdict: PuzzleVerdict;
  theme?: string;
}

const SEEN = new Set<string>();
const ORDER = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];
const LABEL: Record<string, string> = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard', EXPERT: 'Expert' };

const NOTICE =
  '© 2026. All rights reserved. PERSONAL-USE LICENSE: you may print as many copies as you ' +
  'like for yourself, your family, and non-commercial use in your own classroom, church group ' +
  'or care community. Please do not resell, share, upload or redistribute the file or the ' +
  'puzzles, in print or digital form. Puzzles were generated and checked by our own puzzle ' +
  'software, and every sudoku was proved by a solver to have exactly one solution. ' +
  'Set in DejaVu Sans (Bitstream Vera licence).';

/* ------------------------------------------------------------------ sudoku */

function sudokus(prefix: string, count: number, intended: string[], accept: (d: string) => boolean): Made[] {
  const kept: Made[] = [];
  for (let attempt = 0; kept.length < count; attempt += 1) {
    if (attempt > count * 40) throw new Error(`${prefix}: only ${kept.length}/${count} after ${attempt}`);
    const spec: PuzzleSpec = {
      formatKey: SUDOKU.key,
      corpusId: 'common-english-v1',
      seed: `etsy-2026-${prefix}-${attempt}`,
      parameters: { difficulty: intended[attempt % intended.length]! },
    };
    const artifact = SUDOKU.render!(spec);
    const verdict = SUDOKU.validate(artifact);
    if (verdict.state !== 'VALID') continue;
    if (!accept(verdict.measuredDifficulty ?? '')) continue;
    if (SEEN.has(verdict.canonicalHash)) continue;
    SEEN.add(verdict.canonicalHash);
    kept.push({ spec, artifact, verdict });
  }
  kept.sort((a, b) => ORDER.indexOf(a.verdict.measuredDifficulty ?? '') - ORDER.indexOf(b.verdict.measuredDifficulty ?? ''));
  return kept;
}

/* ------------------------------------------------------------- word search */

const DIRS = [
  { name: 'right', dr: 0, dc: 1 },
  { name: 'left', dr: 0, dc: -1 },
  { name: 'down', dr: 1, dc: 0 },
  { name: 'up', dr: -1, dc: 0 },
  { name: 'down-right', dr: 1, dc: 1 },
  { name: 'down-left', dr: 1, dc: -1 },
  { name: 'up-right', dr: -1, dc: 1 },
  { name: 'up-left', dr: -1, dc: -1 },
];
const KID_DIRS = DIRS.filter((d) => ['right', 'down', 'down-right'].includes(d.name));

function pickWords(rng: Rng, theme: Theme, n: number, max: number): string[] {
  const out: string[] = [];
  for (const w of rng.shuffle(theme.words.filter((x) => x.length <= max))) {
    if (out.length >= n) break;
    const rev = (s: string) => [...s].reverse().join('');
    const clash = out.some((o) => o.includes(w) || w.includes(o) || o.includes(rev(w)) || w.includes(rev(o)));
    if (!clash) out.push(w);
  }
  return out;
}

function placeWordSearch(seed: string, theme: Theme, size: number, n: number, dirs: typeof DIRS): PuzzleArtifact | null {
  const rng = new Rng(seed);
  const words = pickWords(rng, theme, n, size).sort((a, b) => b.length - a.length);
  if (words.length < n) return null;
  const grid: string[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => ''));
  const placed: { word: string; row: number; col: number; dir: string }[] = [];
  for (const word of words) {
    let done = false;
    const starts = rng.shuffle(Array.from({ length: size * size }, (_u, i) => i));
    for (const s of starts) {
      if (done) break;
      const r = Math.floor(s / size);
      const c = s % size;
      for (const d of rng.shuffle(dirs)) {
        let ok = true;
        for (let i = 0; i < word.length && ok; i += 1) {
          const rr = r + d.dr * i;
          const cc = c + d.dc * i;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) ok = false;
          else {
            const have = grid[rr]![cc]!;
            if (have !== '' && have !== word[i]) ok = false;
          }
        }
        if (!ok) continue;
        for (let i = 0; i < word.length; i += 1) grid[r + d.dr * i]![c + d.dc * i] = word[i]!;
        placed.push({ word, row: r, col: c, dir: d.name });
        done = true;
        break;
      }
    }
    if (!done) return null;
  }
  const LETTERS = 'ABCDEFGHIJKLMNOPRSTUWY'; // no Q/V/X/Z/J/K filler: friendlier grid, fewer accidental words
  for (const row of grid) for (let c = 0; c < size; c += 1) if (row[c] === '') row[c] = LETTERS[rng.int(LETTERS.length)]!;
  const marked = Array.from({ length: size }, () => Array.from({ length: size }, () => '.'));
  for (const p of placed) {
    const d = DIRS.find((x) => x.name === p.dir)!;
    for (let i = 0; i < p.word.length; i += 1) marked[p.row + d.dr * i]![p.col + d.dc * i] = p.word[i]!;
  }
  const sorted = placed.slice().sort((a, b) => a.word.localeCompare(b.word));
  return {
    formatKey: 'word search',
    instructions: `Find all ${placed.length} words hidden in the grid. Theme: ${theme.name}.`,
    grid: grid.map((r) => r.join('')),
    prompts: sorted.map((p) => p.word),
    solution: marked.map((r) => r.join('')),
    answerKey: sorted.map((p) => `${p.word}: row ${p.row + 1}, column ${p.col + 1}, ${p.dir}`),
    intendedDifficulty: 'MEDIUM',
  };
}

function wordSearches(prefix: string, count: number, themes: Theme[], size: number, n: number, dirs: typeof DIRS): Made[] {
  const kept: Made[] = [];
  for (let attempt = 0; kept.length < count; attempt += 1) {
    if (attempt > count * 50) throw new Error(`${prefix}: only ${kept.length}/${count}`);
    const theme = themes[kept.length % themes.length]!;
    const seed = `etsy-2026-${prefix}-${attempt}`;
    const artifact = placeWordSearch(seed, theme, size, n, dirs);
    if (!artifact) continue;
    const verdict = WORD_SEARCH.validate(artifact);
    if (verdict.state !== 'VALID' || SEEN.has(verdict.canonicalHash)) continue;
    SEEN.add(verdict.canonicalHash);
    kept.push({ spec: { formatKey: 'word search', corpusId: 'etsy-christmas-v1', seed, parameters: { size, words: n, theme: theme.name } }, artifact, verdict, theme: theme.name });
  }
  return kept;
}

/* -------------------------------------------------------------------- maze */

function mazes(prefix: string, sizes: [number, number][]): Made[] {
  const kept: Made[] = [];
  for (let attempt = 0; kept.length < sizes.length; attempt += 1) {
    const [w, h] = sizes[kept.length]!;
    const spec: PuzzleSpec = { formatKey: MAZE.key, corpusId: 'common-english-v1', seed: `etsy-2026-${prefix}-${attempt}`, parameters: { width: w, height: h } };
    const artifact = MAZE.render!(spec);
    const verdict = MAZE.validate(artifact);
    if (verdict.state !== 'VALID' || SEEN.has(verdict.canonicalHash)) continue;
    SEEN.add(verdict.canonicalHash);
    kept.push({ spec, artifact, verdict });
  }
  return kept;
}

/* -------------------------------------------------------------- rendering */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function mazeSvg(grid: readonly string[], solution: readonly string[] | null, unit: number): string {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const H = ((rows - 1) / 2) * unit;
  const W = ((cols - 1) / 2) * unit;
  const lines: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (grid[r]![c] !== '#') continue;
      if (r % 2 === 0 && c % 2 === 1) {
        // Leave the entrance (top of the first cell) and the exit (bottom of the last) open.
        if (r === 0 && c === 1) continue;
        if (r === rows - 1 && c === cols - 2) continue;
        lines.push(`M${((c - 1) / 2) * unit} ${(r / 2) * unit}H${((c + 1) / 2) * unit}`);
      } else if (r % 2 === 1 && c % 2 === 0) {
        lines.push(`M${(c / 2) * unit} ${((r - 1) / 2) * unit}V${((r + 1) / 2) * unit}`);
      }
    }
  }
  let route = '';
  if (solution) {
    // Walk S -> E through '*' squares; the maze is a tree so the walk is the route.
    const on = (r: number, c: number) => ['S', 'E', '*'].includes(solution[r]?.[c] ?? '');
    let at: [number, number] = [1, 1];
    let prev: [number, number] | null = null;
    const pts: string[] = [];
    for (let guard = 0; guard < rows * cols; guard += 1) {
      if (at[0] % 2 === 1 && at[1] % 2 === 1) pts.push(`${((at[1] - 1) / 2 + 0.5) * unit},${((at[0] - 1) / 2 + 0.5) * unit}`);
      if (solution[at[0]]![at[1]] === 'E') break;
      const next: [number, number] | undefined = ([[0, 1], [1, 0], [0, -1], [-1, 0]] as const)
        .map(([dr, dc]) => [at[0] + dr, at[1] + dc] as [number, number])
        .find(([r, c]) => on(r, c) && !(prev && prev[0] === r && prev[1] === c));
      if (!next) break;
      prev = at;
      at = next;
    }
    pts.unshift(`${0.5 * unit},${-0.6 * unit}`);
    pts.push(`${W - 0.5 * unit},${H + 0.6 * unit}`);
    route = `<polyline points="${pts.join(' ')}" fill="none" stroke="#C0392B" stroke-width="${Math.max(2, unit * 0.28)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const sw = Math.max(1.6, unit * 0.12);
  const pad = unit * 1.1;
  return `<svg viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" xmlns="http://www.w3.org/2000/svg">
<path d="${lines.join('')}" stroke="#111" stroke-width="${sw}" stroke-linecap="square" fill="none"/>
${route}
<text x="${0.5 * unit}" y="${-0.35 * unit}" font-size="${Math.max(9, unit * 0.62)}" text-anchor="middle" font-family="DejaVu Sans" font-weight="800" fill="#1F6F43">START ↓</text>
<text x="${W - 0.5 * unit}" y="${H + 0.95 * unit}" font-size="${Math.max(9, unit * 0.62)}" text-anchor="middle" font-family="DejaVu Sans" font-weight="800" fill="#B3263E">FINISH ↓</text>
</svg>`;
}

function wordSearchTable(grid: readonly string[], highlight: readonly string[] | null, cellIn: number): string {
  return `<table class="ws" style="--cell:${cellIn}in">${grid
    .map((row, r) => `<tr>${[...row].map((ch, c) => {
      const on = highlight ? highlight[r]![c] !== '.' : false;
      return `<td class="${highlight ? (on ? 'hit' : 'dim') : ''}">${ch}</td>`;
    }).join('')}</tr>`)
    .join('')}</table>`;
}

function sudokuGridHtml(grid: readonly string[], cellIn: number): string {
  return `<table class="sd" style="--cell:${cellIn}in">${grid
    .map((row, r) => `<tr>${[...row].map((ch, c) => `<td class="${c % 3 === 2 && c < 8 ? 'br' : ''} ${r % 3 === 2 && r < 8 ? 'bb' : ''}">${ch === '.' ? '' : ch}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}

function sudokuSolutionHtml(grid: readonly string[], key: readonly string[], cellIn: number): string {
  return `<table class="sd" style="--cell:${cellIn}in">${key
    .map((row, r) => `<tr>${[...row].map((ch, c) => `<td class="${c % 3 === 2 && c < 8 ? 'br' : ''} ${r % 3 === 2 && r < 8 ? 'bb' : ''} ${grid[r]![c] === '.' ? 'found' : ''}">${ch}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}

const PAGE_CSS = `
@page { size: 8.5in 11in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'DejaVu Sans', sans-serif; color: #111; }
.page { width: 8.5in; height: 11in; padding: 0.6in 0.65in 0.55in; position: relative; page-break-after: always; overflow: hidden; }
.page:last-child { page-break-after: auto; }
.folio { position: absolute; bottom: 0.3in; left: 0; right: 0; text-align: center; font-size: 10pt; color: #666; }
h1.pt { font-family: Caladea, 'DejaVu Serif', serif; font-size: 30pt; margin: 0 0 0.05in; color: #1F4D3A; }
.sub { font-size: 14pt; color: #555; margin-bottom: 0.18in; font-weight: 600; }
table.ws { border-collapse: collapse; margin: 0 auto; }
table.ws td { width: var(--cell); height: var(--cell); text-align: center; vertical-align: middle; font-family: 'DejaVu Sans Mono', monospace; font-weight: 700; font-size: calc(var(--cell) * 0.62); padding: 0; }
table.ws td.dim { color: #c4c4c4; font-weight: 400; }
table.ws td.hit { color: #B3263E; background: #FBE3E7; }
.ws-frame { border: 3px solid #1F4D3A; border-radius: 12px; padding: 0.12in; display: inline-block; }
.wordlist { columns: 3; column-gap: 0.3in; font-size: 17pt; font-weight: 700; margin-top: 0.25in; line-height: 1.5; letter-spacing: 0.04em; }
.wordlist.kid { columns: 3; font-size: 18pt; }
.wordlist div::before { content: '☐ '; font-weight: 400; color: #888; }
.center { text-align: center; }
table.sd { border-collapse: collapse; border: 3px solid #111; margin: 0 auto; }
table.sd td { width: var(--cell); height: var(--cell); border: 1px solid #777; text-align: center; vertical-align: middle; font-size: calc(var(--cell) * 0.6); font-weight: 600; padding: 0; }
table.sd td.br { border-right: 3px solid #111; }
table.sd td.bb { border-bottom: 3px solid #111; }
table.sd td.found { color: #B3263E; font-weight: 400; }
.maze svg { width: 100%; height: 8.3in; display: block; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.25in 0.35in; }
.grid2 .cap { font-weight: 700; font-size: 11pt; margin-bottom: 4px; }
.solmaze svg { width: 100%; height: 4.1in; }
.intro p { font-size: 15pt; line-height: 1.55; }
.intro h2 { font-family: Caladea, serif; font-size: 24pt; color: #1F4D3A; margin: 0.25in 0 0.08in; }
.notice { font-size: 10.5pt; line-height: 1.5; color: #333; }
`;

async function htmlToPdf(browser: import('playwright').Browser, html: string): Promise<Uint8Array> {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const bytes = await page.pdf({ width: '8.5in', height: '11in', printBackground: true, preferCSSPageSize: true });
  await page.close();
  return bytes;
}

/* ------------------------------------------------------------------ covers */

interface Cover {
  title: string;
  kicker: string;
  sub: string;
  theme: 'holiday' | 'classic' | 'kids';
  badge: string;
}

const SNOW = (n: number, seed: string) => {
  const rng = new Rng(seed);
  let s = '';
  for (let i = 0; i < n; i += 1) {
    const x = rng.int(850);
    const y = rng.int(1100);
    const r = 6 + rng.int(18);
    const o = (0.12 + rng.next() * 0.35).toFixed(2);
    s += `<g transform="translate(${x} ${y})" opacity="${o}" stroke="#fff" stroke-width="${(r / 7).toFixed(1)}" stroke-linecap="round">` +
      [0, 60, 120].map((a) => `<line x1="${-r}" y1="0" x2="${r}" y2="0" transform="rotate(${a})"/>`).join('') + '</g>';
  }
  return s;
};

export function coverHtml(c: Cover): string {
  const pal = c.theme === 'holiday'
    ? { bg: '#1F4D3A', bg2: '#173B2C', ink: '#FBF6EC', accent: '#E8C25A', band: '#B3263E' }
    : c.theme === 'kids'
      ? { bg: '#B3263E', bg2: '#8E1C30', ink: '#FFFFFF', accent: '#FFD866', band: '#1F4D3A' }
      : { bg: '#1E3A5F', bg2: '#152B47', ink: '#F7F4EC', accent: '#F2B544', band: '#2E7D6B' };
  const deco = c.theme === 'classic'
    ? `<g opacity="0.10" stroke="#fff" stroke-width="3" fill="none">${Array.from({ length: 10 }, (_u, i) => `<line x1="${i * 95}" y1="0" x2="${i * 95}" y2="1100"/><line x1="0" y1="${i * 115}" x2="850" y2="${i * 115}"/>`).join('')}</g>`
    : SNOW(70, c.title);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
.cover { width: 8.5in; height: 11in; position: relative; overflow: hidden; background: radial-gradient(circle at 50% 35%, ${pal.bg} 0%, ${pal.bg2} 100%); color: ${pal.ink}; }
.cover svg.deco { position: absolute; inset: 0; width: 100%; height: 100%; }
.inner { position: absolute; inset: 0.7in; border: 3px solid ${pal.accent}; border-radius: 22px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0.6in; }
.kick { font-weight: 800; letter-spacing: 0.32em; font-size: 17pt; color: ${pal.accent}; text-transform: uppercase; }
.t { font-family: Caladea, 'DejaVu Serif', serif; font-weight: 700; font-size: 62pt; line-height: 1.02; margin: 0.25in 0; }
.s { font-size: 20pt; font-weight: 500; line-height: 1.35; max-width: 5.6in; }
.badge { margin-top: 0.45in; background: ${pal.band}; color: #fff; font-weight: 800; font-size: 16pt; padding: 0.14in 0.32in; border-radius: 999px; letter-spacing: 0.06em; white-space: nowrap; border: 2px solid ${pal.accent}; }
.foot { position: absolute; bottom: 0.32in; font-size: 12pt; letter-spacing: 0.2em; color: ${pal.accent}; text-transform: uppercase; font-weight: 700; }
</style></head><body><div class="cover"><svg class="deco" viewBox="0 0 850 1100" preserveAspectRatio="none">${deco}</svg>
<div class="inner"><div class="kick">${esc(c.kicker)}</div><div class="t">${esc(c.title)}</div><div class="s">${esc(c.sub)}</div><div class="badge">${esc(c.badge)}</div>
<div class="foot">Print at home · Solutions included</div></div></div></body></html>`;
}

/* ---------------------------------------------------------- book builders */

async function sudokuBook(browser: import('playwright').Browser, made: Made[], cover: Cover, title: string, subtitle: string): Promise<{ bytes: Uint8Array; pages: number }> {
  const book = await typesetSudokuBook({ title, subtitle, rightsNotice: NOTICE, puzzles: made, layout: 'LARGE_PRINT' });
  const coverPdf = await PDFDocument.load(await htmlToPdf(browser, coverHtml(cover)));
  const inner = await PDFDocument.load(book.bytes);
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setSubject(subtitle);
  out.setCreationDate(new Date('2026-11-11T00:00:00Z'));
  out.setModificationDate(new Date('2026-11-11T00:00:00Z'));
  const [c] = await out.copyPages(coverPdf, [0]);
  out.addPage(c!);
  // Drop Brain's plain title page (index 0); the cover replaces it.
  const rest = await out.copyPages(inner, inner.getPageIndices().slice(1));
  for (const p of rest) out.addPage(p);
  return { bytes: await out.save(), pages: out.getPageCount() };
}

function introPage(title: string, paragraphs: string[]): string {
  return `<div class="page intro"><h1 class="pt">${esc(title)}</h1>${paragraphs.map((p) => (p.startsWith('## ') ? `<h2>${esc(p.slice(3))}</h2>` : `<p>${esc(p)}</p>`)).join('')}</div>`;
}

function noticePage(): string {
  return `<div class="page"><div class="notice" style="margin-top:0.4in">${esc(NOTICE.replace(' Set in DejaVu Sans (Bitstream Vera licence).', ''))}</div></div>`;
}

async function htmlBook(browser: import('playwright').Browser, cover: Cover, body: string, title: string): Promise<{ bytes: Uint8Array; pages: number }> {
  const coverPdf = await PDFDocument.load(await htmlToPdf(browser, coverHtml(cover)));
  const bodyPdf = await PDFDocument.load(await htmlToPdf(browser, `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>${body}</body></html>`));
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreationDate(new Date('2026-11-11T00:00:00Z'));
  out.setModificationDate(new Date('2026-11-11T00:00:00Z'));
  const [c] = await out.copyPages(coverPdf, [0]);
  out.addPage(c!);
  for (const p of await out.copyPages(bodyPdf, bodyPdf.getPageIndices())) out.addPage(p);
  return { bytes: await out.save(), pages: out.getPageCount() };
}

function wsPages(list: Made[], startNo: number, cellIn: number, kid: boolean): { pages: string[]; solutions: string[] } {
  const pages = list.map((m, i) => `<div class="page center"><h1 class="pt">Puzzle ${startNo + i}</h1><div class="sub">${esc(m.theme ?? '')} · ${m.artifact.prompts.length} words</div>
<div class="ws-frame">${wordSearchTable(m.artifact.grid, null, cellIn)}</div>
<div class="wordlist ${kid ? 'kid' : ''}" style="text-align:left">${m.artifact.prompts.map((w) => `<div>${w}</div>`).join('')}</div><div class="folio"></div></div>`);
  const solutions: string[] = [];
  for (let i = 0; i < list.length; i += 4) {
    const chunk = list.slice(i, i + 4);
    solutions.push(`<div class="page"><h1 class="pt" style="font-size:22pt">Word Search Solutions</h1><div class="grid2">${chunk
      .map((m, j) => `<div class="center"><div class="cap">Puzzle ${startNo + i + j} · ${esc(m.theme ?? '')}</div>${wordSearchTable(m.artifact.grid, m.artifact.solution, kid ? 0.3 : 0.235)}</div>`)
      .join('')}</div></div>`);
  }
  return { pages, solutions };
}

function mazePages(list: Made[], startNo: number, heading = 'Maze'): { pages: string[]; solutions: string[] } {
  const pages = list.map((m, i) => {
    const w = (m.artifact.grid[0]!.length - 1) / 2;
    const unit = Math.min(500 / w, 40);
    return `<div class="page center"><h1 class="pt">${heading} ${startNo + i}</h1><div class="sub">${LABEL[m.verdict.measuredDifficulty ?? ''] ?? ''} · ${esc(m.artifact.prompts[0] ?? '')} · one way through</div><div class="maze">${mazeSvg(m.artifact.grid, null, unit)}</div></div>`;
  });
  const solutions: string[] = [];
  for (let i = 0; i < list.length; i += 4) {
    const chunk = list.slice(i, i + 4);
    solutions.push(`<div class="page"><h1 class="pt" style="font-size:22pt">Maze Solutions</h1><div class="grid2">${chunk
      .map((m, j) => `<div class="center solmaze"><div class="cap">${heading} ${startNo + i + j}</div>${mazeSvg(m.artifact.grid, m.artifact.solution, 20)}</div>`)
      .join('')}</div></div>`);
  }
  return { pages, solutions };
}

function sudokuHtmlPages(list: Made[], startNo: number, cellIn: number): { pages: string[]; solutions: string[] } {
  const pages = list.map((m, i) => `<div class="page center"><h1 class="pt">Sudoku ${startNo + i}</h1><div class="sub">${LABEL[m.verdict.measuredDifficulty ?? ''] ?? ''} · fill every row, column and 3×3 box with 1–9</div>${sudokuGridHtml(m.artifact.grid, cellIn)}</div>`);
  const solutions: string[] = [];
  for (let i = 0; i < list.length; i += 4) {
    const chunk = list.slice(i, i + 4);
    solutions.push(`<div class="page"><h1 class="pt" style="font-size:22pt">Sudoku Solutions</h1><div class="grid2">${chunk
      .map((m, j) => `<div class="center"><div class="cap">Sudoku ${startNo + i + j}</div>${sudokuSolutionHtml(m.artifact.grid, m.artifact.answerKey, 0.36)}</div>`)
      .join('')}</div></div>`);
  }
  return { pages, solutions };
}

/* ------------------------------------------------------------------- main */

interface Product {
  slug: string;
  file: string;
  title: string;
  made: Made[];
  bytes: Uint8Array;
  pages: number;
}

function write(p: Product) {
  const dir = path.join(PRODUCTS, p.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, p.file), p.bytes);
  const sha = createHash('sha256').update(p.bytes).digest('hex');
  const by: Record<string, number> = {};
  const fmt: Record<string, number> = {};
  for (const m of p.made) {
    const k = m.verdict.measuredDifficulty ?? 'UNRATED';
    by[k] = (by[k] ?? 0) + 1;
    fmt[m.spec.formatKey] = (fmt[m.spec.formatKey] ?? 0) + 1;
  }
  const manifest = {
    product: p.slug,
    title: p.title,
    pdf: p.file,
    sha256: sha,
    bytes: p.bytes.length,
    pages: p.pages,
    trim: '8.5x11in US Letter',
    puzzles: p.made.length,
    byFormat: fmt,
    byDifficulty: by,
    allValid: p.made.every((m) => m.verdict.state === 'VALID'),
    entries: p.made.map((m, i) => ({
      n: i + 1,
      format: m.spec.formatKey,
      seed: m.spec.seed,
      theme: m.theme,
      measured: m.verdict.measuredDifficulty,
      canonicalHash: m.verdict.canonicalHash,
      checks: m.verdict.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`),
    })),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`OK ${p.slug}: ${p.made.length} puzzles, ${p.pages} pages, ${(p.bytes.length / 1024).toFixed(0)} KB, ${JSON.stringify(by)}`);
  return manifest;
}

async function main() {
  const browser = await chromium.launch();
  const summary: unknown[] = [];
  const t0 = Date.now();

  // 1. Large Print Christmas Sudoku — 50, Easy to Expert.
  {
    const made = sudokus('xmas', 50, ['EASY', 'MEDIUM', 'HARD', 'HARD'], () => true);
    const book = await sudokuBook(browser, made,
      { title: 'Christmas Sudoku', kicker: 'Large Print', sub: '50 holiday puzzles, one big grid per page, Easy to Expert', theme: 'holiday', badge: '50 PUZZLES · SOLUTIONS INCLUDED' },
      'Large Print Christmas Sudoku', '50 puzzles, one per page. Easy to Expert, solutions included.');
    summary.push(write({ slug: 'large-print-christmas-sudoku', file: 'Large-Print-Christmas-Sudoku-50-Puzzles.pdf', title: 'Large Print Christmas Sudoku', made, ...book }));
  }
  // 2. Large Print Sudoku 100 — Easy to Expert.
  {
    const made = sudokus('lp100', 100, ['EASY', 'MEDIUM', 'HARD', 'HARD'], () => true);
    const book = await sudokuBook(browser, made,
      { title: '100 Sudoku Puzzles', kicker: 'Large Print', sub: 'One big, easy-to-read grid per page. Easy to Expert, in order of difficulty.', theme: 'classic', badge: '100 PUZZLES · SOLUTIONS INCLUDED' },
      'Large Print Sudoku: 100 Puzzles', 'One puzzle per page. Easy to Expert, solutions included.');
    summary.push(write({ slug: 'large-print-sudoku-100', file: 'Large-Print-Sudoku-100-Puzzles-Easy-to-Expert.pdf', title: 'Large Print Sudoku 100', made, ...book }));
  }
  // 3. Sudoku for Beginners — 60 Easy.
  {
    const made = sudokus('easy', 60, ['EASY'], (d) => d === 'EASY');
    const book = await sudokuBook(browser, made,
      { title: 'Easy Sudoku for Beginners', kicker: 'Large Print', sub: '60 gentle puzzles to learn on, one big grid per page', theme: 'classic', badge: '60 EASY PUZZLES · SOLUTIONS INCLUDED' },
      'Large Print Easy Sudoku for Beginners', '60 Easy puzzles, one per page, solutions included.');
    summary.push(write({ slug: 'easy-sudoku-for-beginners', file: 'Large-Print-Easy-Sudoku-for-Beginners-60-Puzzles.pdf', title: 'Easy Sudoku for Beginners', made, ...book }));
  }
  // 4. Hard & Expert Sudoku — 60.
  {
    const made = sudokus('expert', 60, ['HARD'], (d) => d === 'EXPERT');
    const book = await sudokuBook(browser, made,
      { title: 'Expert Sudoku', kicker: 'Large Print', sub: '60 tough puzzles for experienced solvers, one big grid per page', theme: 'classic', badge: '60 PUZZLES · SOLUTIONS INCLUDED' },
      'Large Print Expert Sudoku', '60 Expert puzzles, one per page, solutions included.');
    summary.push(write({ slug: 'expert-sudoku', file: 'Large-Print-Expert-Sudoku-60-Puzzles.pdf', title: 'Expert Sudoku', made, ...book }));
  }
  // 5. Large Print Christmas Word Search — 40.
  {
    const made = wordSearches('xws', 40, THEMES, 15, 14, DIRS);
    const { pages, solutions } = wsPages(made, 1, 0.44, false);
    const body = introPage('How to play', [
      'Each puzzle hides 14 words from its holiday theme. Words can run forwards, backwards, up, down or diagonally, and a letter can belong to more than one word.',
      'Tick each word in the list as you find it. Solutions are at the back, with the hidden words shown in red.',
      'Every grid was checked by software that searched the printed letters and found each listed word exactly once — so there are no missing words and no double answers.',
      '## Themes',
      THEMES.map((t) => t.name).join(' · '),
    ]) + noticePage() + pages.join('') + solutions.join('');
    const book = await htmlBook(browser, { title: 'Christmas Word Search', kicker: 'Large Print', sub: '40 festive puzzles with big, bold letters — one per page', theme: 'holiday', badge: '40 PUZZLES · SOLUTIONS INCLUDED' }, body, 'Large Print Christmas Word Search');
    summary.push(write({ slug: 'large-print-christmas-word-search', file: 'Large-Print-Christmas-Word-Search-40-Puzzles.pdf', title: 'Large Print Christmas Word Search', made, ...book }));
  }
  // 6. Christmas Activity Pack (kids & family): 12 word searches, 12 mazes, 8 easy sudoku.
  {
    const ws = wordSearches('kidws', 12, KID_THEMES, 11, 8, KID_DIRS);
    const mz = mazes('kidmaze', [[6, 6], [7, 7], [8, 8], [8, 8], [9, 9], [10, 10], [10, 10], [11, 11], [12, 12], [12, 12], [13, 13], [14, 14]]);
    const sd = sudokus('kidsudoku', 8, ['EASY'], (d) => d === 'EASY');
    const w = wsPages(ws, 1, 0.56, true);
    const m = mazePages(mz, 1);
    const s = sudokuHtmlPages(sd, 1, 0.72);
    const body = introPage('Merry Christmas!', [
      'Inside: 12 Christmas word searches, 12 holiday mazes and 8 easy sudoku puzzles — 32 activities for quiet afternoons, long car rides and the countdown to Christmas.',
      'Word searches run only forwards, downwards and diagonally downward, so younger solvers can find every word. Mazes start easy and grow bigger, and every maze has exactly one way through. Every sudoku has exactly one solution.',
      'Answers for everything are at the back. Print as many copies as your family needs.',
    ]) + noticePage() + w.pages.join('') + m.pages.join('') + s.pages.join('') + w.solutions.join('') + m.solutions.join('') + s.solutions.join('');
    const book = await htmlBook(browser, { title: 'Christmas Activity Pack', kicker: 'Printable', sub: 'Word searches, mazes & easy sudoku for kids and families', theme: 'kids', badge: '32 ACTIVITIES · ANSWERS INCLUDED' }, body, 'Christmas Activity Pack');
    summary.push(write({ slug: 'christmas-activity-pack', file: 'Christmas-Activity-Pack-32-Puzzles.pdf', title: 'Christmas Activity Pack', made: [...ws, ...mz, ...sd], ...book }));
  }
  // 7. Large Print Mazes for Adults — 40, growing.
  {
    const sizes: [number, number][] = Array.from({ length: 40 }, (_u, i) => {
      const n = 10 + Math.floor(i / 2);
      return [n, Math.round(n * 1.25)] as [number, number];
    });
    const mz = mazes('adultmaze', sizes);
    const m = mazePages(mz, 1);
    const body = introPage('How to play', [
      'Start at the top-left opening and find your way to the exit at the bottom right. Every maze in this book is a "perfect" maze: it has no loops, so there is exactly one route through, and software walked each printed maze to prove it.',
      'The mazes start gently and grow larger and more winding as you go. Solutions are at the back, with the route drawn in red.',
      'Tip: a pencil and a soft eraser are your best friends. Lines are thick and dark so they print clearly on any home printer.',
    ]) + noticePage() + m.pages.join('') + m.solutions.join('');
    const book = await htmlBook(browser, { title: 'Mazes for Adults', kicker: 'Large Print', sub: '40 relaxing mazes with bold lines, from gentle to challenging', theme: 'classic', badge: '40 MAZES · SOLUTIONS INCLUDED' }, body, 'Large Print Mazes for Adults');
    summary.push(write({ slug: 'large-print-mazes-for-adults', file: 'Large-Print-Mazes-for-Adults-40-Mazes.pdf', title: 'Large Print Mazes for Adults', made: mz, ...book }));
  }

  await browser.close();
  fs.writeFileSync(path.join(PRODUCTS, 'build-summary.json'), `${JSON.stringify(summary.map((m: any) => ({ product: m.product, pdf: m.pdf, pages: m.pages, bytes: m.bytes, puzzles: m.puzzles, byDifficulty: m.byDifficulty, byFormat: m.byFormat, allValid: m.allValid, sha256: m.sha256 })), null, 1)}\n`);
  console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s; distinct puzzles across all products: ${SEEN.size}`);
}

main().catch((e) => {
  console.error('BUILD FAILED', e);
  process.exitCode = 1;
});
