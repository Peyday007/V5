/**
 * A validated spec becomes the files a client receives.
 *
 * Deterministic: the same spec renders the same bytes, so a revision that
 * changed nothing is visible as a repeated hash rather than as new work.
 * Rendering refuses (returns problems) rather than delivering something it
 * knows is wrong — an error in a formula, text that does not fit a slide, an
 * SVG that could run code.
 */
import type { DeliverableKind, DeliverableSpec } from './spec.ts';
import { renderXlsx } from './xlsx.ts';
import { renderDocx, renderMarkdown, renderPdf } from './docx.ts';
import { renderPptx } from './pptx.ts';
import { pngToPdf, renderGraphic, svgProblems, toCsv } from './assets.ts';
import { meshOf, previewPng, toGltf, toObj, toStl } from './model3d.ts';
import { zip } from './zip.ts';
import { PipelineError, resolveDataset, type FileContext } from './pipeline.ts';

export interface DeliverableFile {
  name: string;
  mime: string;
  bytes: Buffer;
}

export interface Rendered {
  kind: DeliverableKind;
  files: DeliverableFile[];
  /** Pictures of the deliverable, for the verifier and for a person reading the record. */
  previews: { name: string; png: Buffer }[];
  problems: string[];
}

export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  svg: 'image/svg+xml',
  png: 'image/png',
  obj: 'model/obj',
  mtl: 'model/mtl',
  stl: 'model/stl',
  gltf: 'model/gltf+json',
} as const;

/** The largest single file Brain will attach: Freelancer's message attachments are bounded too. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function renderDeliverable(spec: DeliverableSpec, context?: FileContext): Promise<Rendered> {
  const name = spec.filename.trim();
  const files: DeliverableFile[] = [];
  const previews: Rendered['previews'] = [];
  const problems: string[] = [];
  switch (spec.kind) {
    case 'SPREADSHEET': {
      const book = renderXlsx(spec.sheets);
      problems.push(...book.problems);
      files.push({ name: `${name}.xlsx`, mime: MIME.xlsx, bytes: book.bytes });
      break;
    }
    case 'DOCUMENT': {
      const doc = { title: spec.title, subtitle: spec.subtitle, blocks: spec.blocks };
      if (spec.formats.includes('docx')) files.push({ name: `${name}.docx`, mime: MIME.docx, bytes: renderDocx(doc).bytes });
      if (spec.formats.includes('pdf')) files.push({ name: `${name}.pdf`, mime: MIME.pdf, bytes: (await renderPdf(doc)).bytes });
      if (spec.formats.includes('md')) files.push({ name: `${name}.md`, mime: MIME.md, bytes: Buffer.from(renderMarkdown(doc)) });
      break;
    }
    case 'PRESENTATION': {
      const deck = renderPptx(spec.title, spec.slides, spec.accent);
      problems.push(...deck.problems);
      files.push({ name: `${name}.pptx`, mime: MIME.pptx, bytes: deck.bytes });
      deck.previews.forEach((p, i) => previews.push({ name: `slide-${i + 1}.png`, png: p.png }));
      break;
    }
    case 'DATASET': {
      let data;
      try {
        data = resolveDataset(spec, context);
      } catch (error) {
        if (!(error instanceof PipelineError)) throw error;
        problems.push(error.message);
        break;
      }
      const header = data.columns.map((c) => c.name);
      if (spec.formats.includes('csv')) files.push({ name: `${name}.csv`, mime: MIME.csv, bytes: Buffer.from(`\uFEFF${toCsv(header, data.rows)}`) });
      if (spec.formats.includes('json')) {
        const records = data.rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
        files.push({ name: `${name}.json`, mime: MIME.json, bytes: Buffer.from(`${JSON.stringify(records, null, 2)}\n`) });
      }
      if (spec.formats.includes('xlsx')) {
        const book = renderXlsx([
          {
            name: 'Data',
            freezeRows: 1,
            rows: [
              header.map((h) => ({ v: h, bold: true, fill: '#DCE4F2' })),
              ...data.rows.map((r) => r.map((v, i) => (data.columns[i]!.type === 'date' && typeof v === 'string' ? { v, fmt: 'date' as const } : v))),
            ],
          },
        ]);
        problems.push(...book.problems);
        files.push({ name: `${name}.xlsx`, mime: MIME.xlsx, bytes: book.bytes });
      }
      if (data.log) files.push({ name: `${name} - change log.md`, mime: MIME.md, bytes: Buffer.from(`# Change log: ${name}\n\n${data.log.map((l) => `- ${l}`).join('\n')}\n`) });
      if (data.rows.length === 0) problems.push('The data has no rows after the steps ran; nothing would be delivered.');
      break;
    }
    case 'WEBSITE':
    case 'CODE': {
      files.push({ name: `${name}.zip`, mime: MIME.zip, bytes: zip(spec.files.map((f) => ({ name: f.path, data: Buffer.from(f.content) }))) });
      break;
    }
    case 'GRAPHIC': {
      const svgIssues = svgProblems(spec.svg);
      if (svgIssues.length) {
        problems.push(...svgIssues);
        break;
      }
      let raster;
      try {
        raster = renderGraphic(spec.svg, spec.width);
      } catch (error) {
        problems.push(`The SVG could not be rendered: ${(error as Error).message.slice(0, 200)}`);
        break;
      }
      if (spec.formats.includes('svg')) files.push({ name: `${name}.svg`, mime: MIME.svg, bytes: Buffer.from(spec.svg) });
      if (spec.formats.includes('png')) files.push({ name: `${name}.png`, mime: MIME.png, bytes: raster.png });
      if (spec.formats.includes('pdf')) files.push({ name: `${name}.pdf`, mime: MIME.pdf, bytes: await pngToPdf(raster.png, raster.width, raster.height, name) });
      previews.push({ name: 'graphic.png', png: raster.png });
      break;
    }
    case 'MODEL_3D': {
      const meshes = spec.parts.map(meshOf);
      if (spec.formats.includes('obj')) {
        const { obj, mtl } = toObj(meshes, `${name}.mtl`);
        files.push({ name: `${name}.obj`, mime: MIME.obj, bytes: Buffer.from(obj) }, { name: `${name}.mtl`, mime: MIME.mtl, bytes: Buffer.from(mtl) });
      }
      if (spec.formats.includes('stl')) files.push({ name: `${name}.stl`, mime: MIME.stl, bytes: toStl(meshes) });
      if (spec.formats.includes('gltf')) files.push({ name: `${name}.gltf`, mime: MIME.gltf, bytes: Buffer.from(toGltf(meshes)) });
      const preview = previewPng(meshes);
      files.push({ name: `${name}-render.png`, mime: MIME.png, bytes: preview.png });
      previews.push({ name: 'render.png', png: preview.png });
      break;
    }
  }
  for (const file of files) {
    if (file.bytes.length > MAX_FILE_BYTES) problems.push(`${file.name} is ${file.bytes.length} bytes, more than the ${MAX_FILE_BYTES}-byte attachment bound.`);
  }
  return { kind: spec.kind, files, previews, problems };
}
