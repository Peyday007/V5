/**
 * PowerPoint decks from a presentation spec, and a picture of every slide.
 *
 * One layout pass decides where every box goes and what size its text is, and
 * both outputs read it: the .pptx shapes and an SVG of each slide. The SVG is
 * rasterised for the client's preview and for verification — a slide whose
 * text cannot fit its box at 14pt is refused rather than delivered overflowing,
 * because the text size is chosen here rather than left to PowerPoint.
 *
 * Coordinates are points on a 960 x 540 canvas (13.333in x 7.5in, 16:9), and a
 * point is 12 700 EMU.
 */
import type { ChartSpec, Slide, TableSpec } from './spec.ts';
import { chartSvg } from './chart.ts';
import { FONT_FAMILY, svgToPng } from './raster.ts';
import { esc, XML_HEAD } from './xml.ts';
import { coreProps } from './xlsx.ts';
import { zip } from './zip.ts';
import { plain } from './docx.ts';

const EMU = 12_700;
const W = 960;
const H = 540;
const SIZES = [24, 22, 20, 18, 16, 14];

interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
  paragraphs: string[];
  size: number;
  bold: boolean;
  colour: string;
  bullets: boolean;
  align: 'l' | 'ctr';
}

interface SlideLayout {
  background: string;
  boxes: TextBox[];
  chart?: { spec: ChartSpec; x: number; y: number; w: number; h: number };
  table?: { spec: TableSpec; x: number; y: number; w: number; rowH: number; size: number };
  number: number;
}

/** Glyph advance relative to font size, close enough to plan a wrap. */
const ADVANCE = 0.56;

export function wrap(text: string, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length * size * ADVANCE <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fit(paragraphs: string[], w: number, h: number, sizes: number[], bullets: boolean): number | null {
  for (const size of sizes) {
    const inner = w - (bullets ? 26 : 8);
    const lines = paragraphs.reduce((n, p) => n + wrap(plain(p), size, inner).length, 0);
    const height = lines * size * 1.2 + paragraphs.length * size * 0.45 + 10;
    if (height <= h && paragraphs.every((p) => wrap(plain(p), size, inner).every((l) => l.length * size * ADVANCE <= inner + size))) return size;
  }
  return null;
}

export function layoutDeck(slides: readonly Slide[], accent: string): { layouts: SlideLayout[]; problems: string[] } {
  const problems: string[] = [];
  const layouts = slides.map((slide, i): SlideLayout => {
    const n = i + 1;
    const box = (x: number, y: number, w: number, h: number, paragraphs: string[], sizes: number[], opts: Partial<TextBox> = {}): TextBox => {
      const size = fit(paragraphs, w, h, sizes, opts.bullets ?? false);
      if (size === null) problems.push(`Slide ${n} (“${slide.title}”): the text does not fit at ${sizes[sizes.length - 1]}pt — shorten it or split the slide.`);
      return { x, y, w, h, paragraphs, size: size ?? sizes[sizes.length - 1]!, bold: false, colour: '1F2A44', bullets: false, align: 'l', ...opts };
    };
    const title = (y = 34) => box(56, y, 848, 70, [slide.title], [32, 28, 24, 22], { bold: true, colour: '1F2A44' });
    switch (slide.layout) {
      case 'title':
        return {
          background: 'FFFFFF',
          number: n,
          boxes: [
            box(80, 170, 800, 120, [slide.title], [44, 40, 36, 32, 28], { bold: true, align: 'ctr' }),
            ...(slide.subtitle ? [box(120, 300, 720, 70, [slide.subtitle], [24, 22, 20, 18], { colour: '5A6578', align: 'ctr' })] : []),
          ],
        };
      case 'section':
        return {
          background: accent.slice(1),
          number: n,
          boxes: [
            box(80, 200, 800, 100, [slide.title], [40, 36, 32, 28], { bold: true, colour: 'FFFFFF', align: 'ctr' }),
            ...(slide.subtitle ? [box(120, 310, 720, 60, [slide.subtitle], [22, 20, 18], { colour: 'FFFFFF', align: 'ctr' })] : []),
          ],
        };
      case 'bullets':
        return { background: 'FFFFFF', number: n, boxes: [title(), box(64, 128, 832, 360, slide.bullets ?? [], SIZES, { bullets: true })] };
      case 'two-column':
        return {
          background: 'FFFFFF',
          number: n,
          boxes: [title(), box(64, 128, 404, 360, slide.left ?? [], SIZES, { bullets: true }), box(492, 128, 404, 360, slide.right ?? [], SIZES, { bullets: true })],
        };
      case 'chart':
        return { background: 'FFFFFF', number: n, boxes: [title()], chart: { spec: slide.chart!, x: 168, y: 118, w: 624, h: 351 } };
      case 'table': {
        const t = slide.table!;
        const rows = t.rows.length + 1;
        const rowH = Math.min(36, 370 / rows);
        const size = Math.max(9, Math.min(16, Math.floor(rowH * 0.45)));
        const colW = 848 / t.header.length;
        const longest = Math.max(...[t.header, ...t.rows].flat().map((c) => c.length));
        if (rows * rowH > 380 || longest * size * ADVANCE > colW * 2.2) problems.push(`Slide ${n} (“${slide.title}”): the table is too large for one slide — split it.`);
        return { background: 'FFFFFF', number: n, boxes: [title()], table: { spec: t, x: 56, y: 120, w: 848, rowH, size } };
      }
    }
  });
  return { layouts, problems };
}

/* -------------------------------------------------------------------------
 * The .pptx
 * ---------------------------------------------------------------------- */

function rPr(size: number, bold: boolean, colour: string): string {
  return `<a:rPr lang="en-US" sz="${size * 100}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr>`;
}

function shapeXml(id: number, b: TextBox): string {
  const paras = b.paragraphs
    .map((p) => {
      const ppr = b.bullets
        ? `<a:pPr marL="285750" indent="-285750" algn="${b.align}"><a:spcBef><a:spcPts val="${Math.round(b.size * 45)}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>`
        : `<a:pPr algn="${b.align}"><a:buNone/></a:pPr>`;
      return `<a:p>${ppr}<a:r>${rPr(b.size, b.bold, b.colour)}<a:t>${esc(plain(p))}</a:t></a:r></a:p>`;
    })
    .join('');
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${b.x * EMU}" y="${b.y * EMU}"/><a:ext cx="${b.w * EMU}" cy="${b.h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="45720" tIns="45720" rIns="45720" bIns="45720" anchor="${b.bullets ? 't' : 'ctr'}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
  );
}

function tableXml(id: number, t: NonNullable<SlideLayout['table']>, accent: string): string {
  const cols = t.spec.header.length;
  const colW = Math.floor((t.w * EMU) / cols);
  const cell = (text: string, header: boolean) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${rPr(t.size, header, header ? 'FFFFFF' : '1F2A44')}<a:t>${esc(text)}</a:t></a:r></a:p></a:txBody>` +
    `<a:tcPr marL="68580" marR="68580" marT="22860" marB="22860"><a:solidFill><a:srgbClr val="${header ? accent : 'F4F6FA'}"/></a:solidFill></a:tcPr></a:tc>`;
  const rowH = Math.round(t.rowH * EMU);
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${t.x * EMU}" y="${t.y * EMU}"/><a:ext cx="${colW * cols}" cy="${rowH * (t.spec.rows.length + 1)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${`<a:gridCol w="${colW}"/>`.repeat(cols)}</a:tblGrid>` +
    `<a:tr h="${rowH}">${t.spec.header.map((h) => cell(h, true)).join('')}</a:tr>` +
    t.spec.rows.map((r) => `<a:tr h="${rowH}">${r.map((c) => cell(c, false)).join('')}</a:tr>`).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

function pictureXml(id: number, rid: string, c: NonNullable<SlideLayout['chart']>): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Chart ${id}" descr="${esc(c.spec.title ?? 'Chart')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${c.x * EMU}" y="${c.y * EMU}"/><a:ext cx="${c.w * EMU}" cy="${c.h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const THEME =
  `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Brain"><a:themeElements>` +
  '<a:clrScheme name="Brain"><a:dk1><a:srgbClr val="1F2A44"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="2E5AAC"/></a:accent1><a:accent2><a:srgbClr val="E07B39"/></a:accent2><a:accent3><a:srgbClr val="3A9D5D"/></a:accent3><a:accent4><a:srgbClr val="C0392B"/></a:accent4><a:accent5><a:srgbClr val="8E5EA2"/></a:accent5><a:accent6><a:srgbClr val="4AA3B5"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Brain"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Brain"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

export interface RenderedDeck {
  bytes: Buffer;
  previews: { png: Buffer; inkShare: number }[];
  problems: string[];
}

export function renderPptx(title: string, slides: readonly Slide[], accentHex = '#2E5AAC'): RenderedDeck {
  const accent = accentHex.slice(1).toUpperCase();
  const { layouts, problems } = layoutDeck(slides, accentHex);
  const entries: { name: string; data: Buffer }[] = [];
  const previews: RenderedDeck['previews'] = [];
  layouts.forEach((layout, i) => {
    const n = i + 1;
    const rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'];
    const shapes: string[] = [];
    let id = 2;
    if (layout.background === 'FFFFFF') {
      shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W * EMU}" cy="${8 * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
    }
    for (const b of layout.boxes) shapes.push(shapeXml(id++, b));
    if (layout.chart) {
      const png = svgToPng(chartSvg(layout.chart.spec, 960, 540), 1280).png;
      entries.push({ name: `ppt/media/chart${n}.png`, data: png });
      rels.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart${n}.png"/>`);
      shapes.push(pictureXml(id++, 'rId2', layout.chart));
    }
    if (layout.table) shapes.push(tableXml(id++, layout.table, accent));
    shapes.push(shapeXml(id++, { x: 860, y: 506, w: 80, h: 24, paragraphs: [String(n)], size: 11, bold: false, colour: layout.background === 'FFFFFF' ? '8A94A6' : 'FFFFFF', bullets: false, align: 'ctr' }));
    const bg = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${layout.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
    entries.push({
      name: `ppt/slides/slide${n}.xml`,
      data: Buffer.from(`${XML_HEAD}<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GROUP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`),
    });
    entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`) });
    const raster = svgToPng(slideSvg(layout, accent), 960);
    previews.push({ png: raster.png, inkShare: raster.inkShare });
  });

  const presentation =
    `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${layouts.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${W * EMU}" cy="${H * EMU}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`;
  const presRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    layouts.map((_, i) => `<Relationship Id="rId${i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('') +
    '</Relationships>';
  const master =
    `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>';
  const masterRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>';
  const layoutXml = `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const layoutRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    layouts.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rootRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const bytes = zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(coreProps(title)) },
    { name: 'ppt/presentation.xml', data: Buffer.from(presentation) },
    { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: Buffer.from(master) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: Buffer.from(masterRels) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: Buffer.from(layoutXml) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: Buffer.from(layoutRels) },
    { name: 'ppt/theme/theme1.xml', data: Buffer.from(THEME) },
    ...entries,
  ]);
  return { bytes, previews, problems };
}

/** The same slide as an SVG, from the same layout. */
export function slideSvg(layout: SlideLayout, accent: string): string {
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#${layout.background}"/>`];
  if (layout.background === 'FFFFFF') parts.push(`<rect width="${W}" height="8" fill="#${accent}"/>`);
  for (const b of layout.boxes) {
    const inner = b.w - (b.bullets ? 26 : 8);
    const lines: { text: string; bullet: boolean }[] = [];
    for (const p of b.paragraphs) wrap(plain(p), b.size, inner).forEach((l, i) => lines.push({ text: l, bullet: b.bullets && i === 0 }));
    const lineH = b.size * 1.2;
    const total = lines.length * lineH + (b.bullets ? b.paragraphs.length * b.size * 0.45 : 0);
    let y = b.bullets ? b.y + 6 : b.y + (b.h - total) / 2;
    let para = -1;
    for (const line of lines) {
      if (line.bullet) {
        para += 1;
        if (para > 0 || b.bullets) y += b.size * 0.45;
      }
      y += lineH;
      const x = b.align === 'ctr' ? b.x + b.w / 2 : b.x + (b.bullets ? 26 : 4);
      if (line.bullet) parts.push(`<circle cx="${b.x + 10}" cy="${(y - b.size * 0.35).toFixed(1)}" r="${(b.size * 0.16).toFixed(1)}" fill="#${b.colour}"/>`);
      parts.push(`<text x="${x}" y="${(y - b.size * 0.15).toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${b.size * 0.93}" ${b.bold ? 'font-weight="bold"' : ''} fill="#${b.colour}" ${b.align === 'ctr' ? 'text-anchor="middle"' : ''}>${esc(line.text)}</text>`);
    }
  }
  if (layout.chart) {
    const c = layout.chart;
    const inner = chartSvg(c.spec, 960, 540).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    parts.push(`<svg x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" viewBox="0 0 960 540">${inner}</svg>`);
  }
  if (layout.table) {
    const t = layout.table;
    const colW = t.w / t.spec.header.length;
    [t.spec.header, ...t.spec.rows].forEach((row, r) => {
      row.forEach((cell, ci) => {
        const x = t.x + ci * colW;
        const y = t.y + r * t.rowH;
        parts.push(`<rect x="${x}" y="${y}" width="${colW}" height="${t.rowH}" fill="#${r === 0 ? accent : 'F4F6FA'}" stroke="#FFFFFF"/>`);
        parts.push(`<text x="${x + 6}" y="${y + t.rowH * 0.65}" font-family="${FONT_FAMILY}" font-size="${t.size * 0.93}" ${r === 0 ? 'font-weight="bold" fill="#FFFFFF"' : 'fill="#1F2A44"'}>${esc(cell)}</text>`);
      });
    });
  }
  parts.push(`<text x="900" y="524" font-family="${FONT_FAMILY}" font-size="10" fill="#${layout.background === 'FFFFFF' ? '8A94A6' : 'FFFFFF'}" text-anchor="middle">${layout.number}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}
