/**
 * Datasets, websites, code and graphics: the deliverables that are text, or
 * that start as text.
 *
 * None of it is executed on the production server. JavaScript is parsed, not
 * run; Python is handed to the local interpreter's `ast.parse`, which parses
 * without executing; an SVG is refused outright for anything that could run or
 * reach the network (a script, an event handler, a foreign object, an external
 * reference), never "cleaned", because a cleaned file is one nobody checked.
 */
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { PDFDocument } from 'pdf-lib';
import { svgToPng } from './raster.ts';
import { wellFormedProblem } from './xml.ts';

/* -------------------------------------------------------------------------
 * Datasets
 * ---------------------------------------------------------------------- */

export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | boolean | null)[][]): string {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* -------------------------------------------------------------------------
 * SVG
 * ---------------------------------------------------------------------- */

export function svgProblems(svg: string): string[] {
  const problems: string[] = [];
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg\b/.test(svg)) problems.push('The SVG must start with an <svg> element.');
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) problems.push('The <svg> element needs xmlns="http://www.w3.org/2000/svg".');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) problems.push('The SVG declares a DOCTYPE or an entity.');
  if (/<script\b/i.test(svg)) problems.push('The SVG contains a script.');
  if (/<foreignObject\b/i.test(svg)) problems.push('The SVG contains a foreignObject.');
  if (/\son[a-z]+\s*=/i.test(svg)) problems.push('The SVG carries an event handler attribute.');
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!m[1]!.startsWith('#') && !/^data:image\/(png|jpeg);base64,/i.test(m[1]!)) problems.push(`The SVG references ${m[1]!.slice(0, 60)}; only #fragments and embedded PNG/JPEG data are allowed.`);
  }
  if (/url\(\s*['"]?(?!#)/i.test(svg)) problems.push('The SVG uses url() to something other than a #fragment.');
  if (/@import/i.test(svg)) problems.push('The SVG imports a stylesheet.');
  const formed = wellFormedProblem(svg.replace(/^\s*<\?xml[^>]*\?>/, ''));
  if (formed) problems.push(`The SVG is not well formed: ${formed}.`);
  return problems;
}

export async function pngToPdf(png: Buffer, width: number, height: number, title: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Brain');
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const scale = Math.min(1, 1440 / Math.max(width, height));
  const page = pdf.addPage([width * scale * 0.75, height * scale * 0.75]);
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

export function renderGraphic(svg: string, width: number): { png: Buffer; inkShare: number; colours: number; width: number; height: number } {
  const raster = svgToPng(svg, Math.min(width, 4000));
  return { png: raster.png, inkShare: raster.inkShare, colours: raster.colours, width: raster.width, height: raster.height };
}

/* -------------------------------------------------------------------------
 * Code
 * ---------------------------------------------------------------------- */

export type ParseVerdict = { ok: true } | { ok: false; problem: string } | { ok: 'UNAVAILABLE'; problem: string };

type EsbuildLike = { transformSync(code: string, options: Record<string, unknown>): unknown };
let esbuild: EsbuildLike | null | undefined;

async function loadEsbuild(): Promise<EsbuildLike | null> {
  if (esbuild !== undefined) return esbuild;
  try {
    // esbuild ships with tsx, which the production image already runs on.
    esbuild = (await import('esbuild')) as unknown as EsbuildLike;
  } catch {
    esbuild = null;
  }
  return esbuild;
}

/** Parse JavaScript without running it. ES modules and scripts both accepted. */
export async function parseJavaScript(code: string, filename: string): Promise<ParseVerdict> {
  const eb = await loadEsbuild();
  if (eb) {
    try {
      eb.transformSync(code, { loader: 'js', format: 'esm', sourcefile: filename, logLevel: 'silent' });
      return { ok: true };
    } catch (error) {
      const first = (error as { errors?: { text: string; location?: { line: number } }[] }).errors?.[0];
      return { ok: false, problem: first ? `${filename}:${first.location?.line ?? '?'} ${first.text}` : `${filename}: ${(error as Error).message.slice(0, 200)}` };
    }
  }
  try {
    // A Script compiles without running; module syntax is not accepted here.
    new Script(code, { filename });
    return { ok: true };
  } catch (error) {
    return { ok: false, problem: `${filename}: ${(error as Error).message.slice(0, 200)}` };
  }
}

let pythonAvailable: boolean | undefined;

/** Parse Python with the local interpreter's ast module. Parsing executes nothing. */
export function parsePython(code: string, filename: string): ParseVerdict {
  if (pythonAvailable === false) return { ok: 'UNAVAILABLE', problem: 'No python3 on this machine to parse Python with.' };
  const result = spawnSync(
    'python3',
    ['-I', '-c', 'import ast,sys\nsrc=sys.stdin.read()\ntry:\n ast.parse(src, sys.argv[1])\nexcept SyntaxError as e:\n print(f"{sys.argv[1]}:{e.lineno} {e.msg}"); sys.exit(3)', filename],
    { input: code, encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
  );
  if (result.error) {
    pythonAvailable = false;
    return { ok: 'UNAVAILABLE', problem: 'No python3 on this machine to parse Python with.' };
  }
  pythonAvailable = true;
  if (result.status === 0) return { ok: true };
  if (result.status === 3) return { ok: false, problem: result.stdout.trim().slice(0, 300) };
  return { ok: false, problem: `${filename}: the parser exited ${result.status}` };
}

export function pythonParserAvailable(): boolean {
  if (pythonAvailable === undefined) parsePython('x = 1\n', 'probe.py');
  return pythonAvailable === true;
}

/* -------------------------------------------------------------------------
 * Websites
 * ---------------------------------------------------------------------- */

export function cssProblem(css: string, filename: string): string | null {
  let depth = 0;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  for (const ch of stripped) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) return `${filename}: a "}" with no "{" before it.`;
  }
  return depth ? `${filename}: ${depth} block(s) never closed.` : null;
}

/** Local references in an HTML or CSS file, resolved relative to it. */
export function localReferences(content: string, from: string): string[] {
  const out: string[] = [];
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const refs = [
    ...[...content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!),
    ...[...content.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]!),
  ];
  for (const ref of refs) {
    if (/^(https?:|mailto:|tel:|data:|#|javascript:|\/\/)/i.test(ref) || ref.startsWith('{')) continue;
    const clean = ref.split(/[?#]/)[0]!;
    if (!clean) continue;
    const parts = (clean.startsWith('/') ? clean.slice(1) : dir + clean).split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part && part !== '.') resolved.push(part);
    }
    out.push(resolved.join('/') || 'index.html');
  }
  return out;
}
