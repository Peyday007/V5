/**
 * Whether the files Brain rendered are the deliverable the spec asked for.
 *
 * It reads the produced bytes back, never the renderer's working: a workbook is
 * unzipped and every formula's stored value checked, a Word file is read with
 * mammoth and a PDF with pdf.js — readers Brain did not write — and the text
 * the spec promised is looked for in what came out. A picture that is all one
 * colour is a blank deliverable, whatever its markup said.
 *
 * Every check is recorded with its result, so a delivered file carries the
 * evidence it was checked and a refused one says exactly why.
 */
import type { DeliverableSpec } from './spec.ts';
import type { DeliverableFile, Rendered } from './render.ts';
import { readXlsx } from './xlsx.ts';
import { isError } from './formula.ts';
import { unzip } from './zip.ts';
import { textOf, wellFormedProblem } from './xml.ts';
import { cssProblem, localReferences, parseCsv, parseJavaScript, parsePython, svgProblems } from './assets.ts';
import { pngSize, svgToPng } from './raster.ts';
import { plain } from './docx.ts';
import { extractPdf } from '../../documents/pdf.ts';
import { extractDocx } from '../../documents/docx.ts';
import { resolveDataset, type FileContext } from './pipeline.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Verification {
  passed: boolean;
  checks: Check[];
}

const norm = (s: string) => plain(s).replace(/\s+/g, ' ').trim().toLowerCase();

function file(rendered: Rendered, ext: string): DeliverableFile | undefined {
  return rendered.files.find((f) => f.name.toLowerCase().endsWith(`.${ext}`));
}

export async function verifyDeliverable(spec: DeliverableSpec, rendered: Rendered, context?: FileContext): Promise<Verification> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  if (rendered.problems.length) check('render', false, rendered.problems.slice(0, 10).join(' '));
  if (rendered.files.length === 0) check('files', false, 'Nothing was produced.');

  const expectExt = (ext: string): DeliverableFile | undefined => {
    const f = file(rendered, ext);
    check(`${ext} present`, Boolean(f && f.bytes.length > 0), f ? `${f.name}, ${f.bytes.length} bytes` : `no .${ext} file`);
    return f;
  };

  try {
    switch (spec.kind) {
      case 'SPREADSHEET':
      case 'DATASET': {
        // The dataset's expected shape is computed again from the spec and the
        // client's file, independently of the bytes the renderer wrote.
        const dataset = spec.kind === 'DATASET' ? resolveDataset(spec, context) : null;
        const wantsXlsx = spec.kind === 'SPREADSHEET' || spec.formats.includes('xlsx');
        if (wantsXlsx) {
          const f = expectExt('xlsx');
          if (f) {
            const sheets = readXlsx(f.bytes);
            const expected = spec.kind === 'SPREADSHEET' ? spec.sheets.map((s) => s.name) : ['Data'];
            check('sheets', expected.every((n, i) => sheets[i]?.name === n), `read back ${sheets.map((s) => s.name).join(', ')}`);
            let formulas = 0;
            const bad: string[] = [];
            for (const s of sheets) {
              for (const [key, cell] of s.cells) {
                if (cell.formula === undefined) continue;
                formulas += 1;
                if (cell.value === null || isError(cell.value)) bad.push(`${s.name}!${key}`);
              }
            }
            check('formulas computed', bad.length === 0, bad.length ? `no value or an error at ${bad.slice(0, 8).join(', ')}` : `${formulas} formula(s), every one with a computed value`);
            if (spec.kind === 'SPREADSHEET') {
              const wanted = spec.sheets.reduce((n, s) => n + s.rows.flat().filter((c) => c !== null && c !== undefined && c !== '').length, 0);
              const got = sheets.reduce((n, s) => n + s.cells.size, 0);
              check('cells', got >= wanted, `${got} cell(s) read back of ${wanted} specified`);
            } else {
              check('rows', sheets[0]?.maxRow === dataset!.rows.length, `${(sheets[0]?.maxRow ?? -1)} data row(s) of ${dataset!.rows.length}`);
            }
          }
        }
        if (spec.kind === 'DATASET') {
          if (spec.formats.includes('csv')) {
            const f = expectExt('csv');
            if (f) {
              const rows = parseCsv(f.bytes.toString('utf8').replace(/^﻿/, ''));
              const width = dataset!.columns.length;
              check('csv shape', rows.length === dataset!.rows.length + 1 && rows.every((r) => r.length === width), `${rows.length - 1} row(s) of ${dataset!.rows.length}, ${width} column(s) each`);
              check('csv header', rows[0]?.join('|') === dataset!.columns.map((c) => c.name).join('|'), rows[0]?.join(', ') ?? '');
            }
          }
          if (dataset!.log) {
            const log = file(rendered, 'md');
            check('change log', Boolean(log && log.bytes.toString('utf8').includes('Result:')), log ? log.name : 'no change log');
          }
          if (spec.formats.includes('json')) {
            const f = expectExt('json');
            if (f) {
              const parsed = JSON.parse(f.bytes.toString('utf8')) as unknown[];
              check('json records', Array.isArray(parsed) && parsed.length === dataset!.rows.length, `${Array.isArray(parsed) ? parsed.length : 0} record(s)`);
            }
          }
        }
        break;
      }
      case 'DOCUMENT': {
        const headings = spec.blocks.filter((b) => b.type === 'heading').map((b) => norm((b as { text: string }).text));
        const lookFor = (text: string, label: string) => {
          const t = norm(text);
          const missing = [norm(spec.title), ...headings].filter((h) => !t.includes(h));
          check(`${label} content`, missing.length === 0, missing.length ? `missing: ${missing.slice(0, 5).join('; ')}` : `title and ${headings.length} heading(s) found`);
        };
        if (spec.formats.includes('docx')) {
          const f = expectExt('docx');
          if (f) {
            const doc = await extractDocx(f.bytes);
            lookFor(doc.pages.flatMap((p) => p.blocks.map((b) => b.text)).join(' '), 'docx');
            const tables = spec.blocks.filter((b) => b.type === 'table').length;
            const xml = unzip(f.bytes).get('word/document.xml')!.toString('utf8');
            check('docx tables', (xml.match(/<w:tbl>/g) ?? []).length === tables, `${tables} table(s) specified`);
            check('docx xml', wellFormedProblem(xml) === null, wellFormedProblem(xml) ?? 'well formed');
          }
        }
        if (spec.formats.includes('pdf')) {
          const f = expectExt('pdf');
          if (f) {
            const pdf = await extractPdf(f.bytes);
            lookFor(pdf.pages.flatMap((p) => p.blocks.map((b) => b.text)).join(' '), 'pdf');
            check('pdf pages', pdf.pageCount >= 1, `${pdf.pageCount} page(s)`);
          }
        }
        if (spec.formats.includes('md')) {
          const f = expectExt('md');
          if (f) lookFor(f.bytes.toString('utf8'), 'markdown');
        }
        break;
      }
      case 'PRESENTATION': {
        const f = expectExt('pptx');
        if (f) {
          const parts = unzip(f.bytes);
          const slides = [...parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
          check('slide count', slides.length === spec.slides.length, `${slides.length} slide(s) of ${spec.slides.length}`);
          const missing: string[] = [];
          const malformed: string[] = [];
          spec.slides.forEach((s, i) => {
            const xml = parts.get(`ppt/slides/slide${i + 1}.xml`)?.toString('utf8') ?? '';
            if (wellFormedProblem(xml)) malformed.push(`slide ${i + 1}`);
            if (!norm(textOf(xml, 'a:t').join(' ')).includes(norm(s.title))) missing.push(`slide ${i + 1} title`);
          });
          check('slide titles', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'every title is on its slide');
          check('slide xml', malformed.length === 0, malformed.length ? `malformed: ${malformed.join(', ')}` : 'well formed');
          const blank = rendered.previews.filter((p) => inkOf(p.png) === 0);
          check('slide pictures', rendered.previews.length === spec.slides.length && blank.length === 0, `${rendered.previews.length} slide(s) drawn, ${blank.length} blank`);
        }
        break;
      }
      case 'WEBSITE': {
        const f = expectExt('zip');
        if (f) {
          const entries = unzip(f.bytes);
          const html = entries.get('index.html')?.toString('utf8') ?? '';
          check('index.html', /<html[\s>]/i.test(html) && /<\/html>/i.test(html) && /<body[\s>]/i.test(html), html ? 'has html and body' : 'missing');
          check('title', /<title>[^<]{2,}<\/title>/i.test(html), (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? 'no <title>').slice(0, 80));
          check('viewport', /<meta[^>]+name=["']viewport["']/i.test(html), 'mobile viewport meta tag');
          const broken: string[] = [];
          const scriptProblems: string[] = [];
          for (const [path, data] of entries) {
            const text = data.toString('utf8');
            if (/\.(html|css)$/i.test(path)) for (const ref of localReferences(text, path)) if (!entries.has(ref)) broken.push(`${path} → ${ref}`);
            if (/\.css$/i.test(path)) {
              const p = cssProblem(text, path);
              if (p) scriptProblems.push(p);
            }
            if (/\.js$/i.test(path)) {
              const v = await parseJavaScript(text, path);
              if (v.ok !== true) scriptProblems.push(v.problem);
            }
            if (/\.html$/i.test(path)) {
              for (const m of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\//gi)) scriptProblems.push(`${path} loads a script from another site (${m[0].slice(0, 60)})`);
              for (const m of text.matchAll(/<script\b(?![^>]*\bsrc)[^>]*>([\s\S]*?)<\/script>/gi)) {
                const v = await parseJavaScript(m[1]!, `${path} inline script`);
                if (v.ok !== true) scriptProblems.push(v.problem);
              }
            }
          }
          check('links resolve', broken.length === 0, broken.length ? broken.slice(0, 8).join('; ') : 'every local link and asset is in the bundle');
          check('scripts and styles', scriptProblems.length === 0, scriptProblems.length ? scriptProblems.slice(0, 6).join('; ') : 'every script parses and every stylesheet is balanced');
        }
        break;
      }
      case 'CODE': {
        const f = expectExt('zip');
        if (f) {
          const entries = unzip(f.bytes);
          check('entry', entries.has(spec.entry), spec.entry);
          const parseProblems: string[] = [];
          let unavailable = '';
          let parsed = 0;
          for (const [path, data] of entries) {
            const text = data.toString('utf8');
            let v;
            if (/\.(js|mjs|cjs)$/i.test(path)) v = await parseJavaScript(text, path);
            else if (/\.py$/i.test(path)) v = parsePython(text, path);
            else if (/\.json$/i.test(path)) {
              try {
                JSON.parse(text);
                v = { ok: true as const };
              } catch (e) {
                v = { ok: false as const, problem: `${path}: ${(e as Error).message}` };
              }
            } else continue;
            if (v.ok === true) parsed += 1;
            else if (v.ok === 'UNAVAILABLE') unavailable = v.problem;
            else parseProblems.push(v.problem);
          }
          check('parses', parseProblems.length === 0 && !unavailable, unavailable || (parseProblems.length ? parseProblems.slice(0, 6).join('; ') : `${parsed} source file(s) parse`));
          const readme = [...entries.entries()].find(([p]) => /^readme\.md$/i.test(p))?.[1].toString('utf8') ?? '';
          check('readme says how to run', /\b(run|usage|install|python|node)\b/i.test(readme) && readme.length > 80, `${readme.length} characters`);
          const secrets = [...entries.values()].some((d) => /(sk_live_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,})/.test(d.toString('utf8')));
          check('no credentials', !secrets, secrets ? 'a credential-shaped string is in the code' : 'none found');
        }
        break;
      }
      case 'GRAPHIC': {
        if (spec.formats.includes('svg')) {
          const f = expectExt('svg');
          if (f) {
            const problems = svgProblems(f.bytes.toString('utf8'));
            check('svg safe', problems.length === 0, problems.join(' ') || 'no script, handler or external reference');
          }
        }
        if (spec.formats.includes('png')) {
          const f = expectExt('png');
          if (f) {
            const size = pngSize(f.bytes);
            check('png size', Boolean(size && Math.abs(size.width - Math.min(spec.width, 4000)) <= 1), size ? `${size.width}x${size.height}` : 'not a PNG');
          }
        }
        if (spec.formats.includes('pdf')) {
          const f = expectExt('pdf');
          if (f) check('pdf opens', (await extractPdf(f.bytes)).pageCount === 1, 'one page');
        }
        const ink = rendered.previews[0] ? inkOf(rendered.previews[0].png) : 0;
        check('not blank', ink > 0.01, `${(ink * 100).toFixed(1)}% of the picture is drawn`);
        break;
      }
      case 'MODEL_3D': {
        const triangles = spec.parts.length;
        if (spec.formats.includes('obj')) {
          const f = expectExt('obj');
          expectExt('mtl');
          if (f) {
            const text = f.bytes.toString('utf8');
            const v = (text.match(/^v /gm) ?? []).length;
            const faces = [...text.matchAll(/^f (\d+) (\d+) (\d+)$/gm)];
            const valid = faces.every((m) => [m[1], m[2], m[3]].every((i) => Number(i) >= 1 && Number(i) <= v));
            check('obj geometry', v > 0 && faces.length > 0 && valid, `${v} vertices, ${faces.length} faces, ${(text.match(/^o /gm) ?? []).length} object(s) of ${triangles}`);
          }
        }
        if (spec.formats.includes('stl')) {
          const f = expectExt('stl');
          if (f) {
            const count = f.bytes.readUInt32LE(80);
            let finite = true;
            for (let at = 84; at < f.bytes.length - 1; at += 4) if (!Number.isFinite(f.bytes.readFloatLE(at))) finite = false;
            check('stl geometry', f.bytes.length === 84 + count * 50 && count > 0 && finite, `${count} triangles, every coordinate finite`);
          }
        }
        if (spec.formats.includes('gltf')) {
          const f = expectExt('gltf');
          if (f) {
            const g = JSON.parse(f.bytes.toString('utf8')) as { asset?: { version?: string }; meshes?: unknown[]; buffers?: { byteLength: number; uri: string }[] };
            const data = Buffer.from(g.buffers?.[0]?.uri.split(',')[1] ?? '', 'base64');
            check('gltf', g.asset?.version === '2.0' && g.meshes?.length === triangles && data.length === g.buffers?.[0]?.byteLength, `${g.meshes?.length ?? 0} mesh(es), buffer ${data.length} bytes`);
          }
        }
        const render = file(rendered, 'png');
        const ink = render ? inkOf(render.bytes) : 0;
        check('render drawn', ink > 0.02, `${(ink * 100).toFixed(1)}% of the render shows the model`);
        break;
      }
    }
  } catch (error) {
    check('readable', false, `the produced file could not be read back: ${(error as Error).message.slice(0, 200)}`);
  }
  return { passed: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/**
 * How much of a PNG is drawn, computed by re-rendering it as an image in an
 * SVG: the rasteriser's own sampler reports the share that differs from the
 * corner pixel.
 */
export function inkOf(png: Buffer): number {
  const size = pngSize(png);
  if (!size) return 0;
  const w = Math.min(size.width, 400);
  const h = Math.round((size.height * w) / size.width);
  return svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}"><image width="${w}" height="${h}" xlink:href="data:image/png;base64,${png.toString('base64')}"/></svg>`).inkShare;
}
