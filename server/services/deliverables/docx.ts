/**
 * A written deliverable, rendered as a Word document Brain wrote itself.
 *
 * Every factual sentence carries bracketed reference numbers, and the document
 * ends with a Sources section that resolves each number to the claim, its
 * publisher, its date, a live link and the passage it rests on. The claim id is
 * printed beside each source, so a reader can walk from any sentence back to
 * the row in Brain — the same property the research filing's evidence ledger
 * gives a report, in a file somebody can forward.
 *
 * The bytes are deterministic for a given content, version and claim set.
 */
import type { DeliverableSpec } from '../../domain/deliverables.ts';
import type { EvidenceClaim, WrittenContent } from './content.ts';
import { writeZip, xml } from './zip.ts';

export interface RenderMeta {
  versionNumber: number;
  generatedAt: string;
  projectName: string;
  spec: DeliverableSpec;
  /** Needs the request depends on that Brain could not meet. */
  unmetNeeds: string[];
}

export interface RenderedFile {
  bytes: Buffer;
  filename: string;
  contentType: string;
  /** The order sources were numbered in, so a check can confirm it. */
  referenceOrder: string[];
}

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function run(text: string, opts: { bold?: boolean; italic?: boolean; size?: number } = {}): string {
  const props = [
    opts.bold ? '<w:b/>' : '',
    opts.italic ? '<w:i/>' : '',
    opts.size ? `<w:sz w:val="${opts.size}"/>` : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function para(inner: string, style?: string, extraPPr = ''): string {
  const ppr = style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraPPr}</w:pPr>` : '';
  return `<w:p>${ppr}${inner}</w:p>`;
}

export function safeFilename(title: string, versionNumber: number, ext: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'Deliverable';
  return `${base} v${versionNumber}.${ext}`;
}

export function renderDocx(content: WrittenContent, claims: Map<string, EvidenceClaim>, meta: RenderMeta): RenderedFile {
  const order: string[] = [];
  const numberOf = (id: string): number => {
    let at = order.indexOf(id);
    if (at === -1) {
      order.push(id);
      at = order.length - 1;
    }
    return at + 1;
  };
  const marks = (cites: readonly string[]): string =>
    cites.length === 0 ? '' : ' ' + cites.map((id) => `[${numberOf(id)}]`).join('');

  const body: string[] = [];
  body.push(para(run(content.title), 'Title'));
  if (content.subtitle) body.push(para(run(content.subtitle), 'Subtitle'));
  body.push(
    para(
      run(`Prepared for: ${meta.spec.audience}. Purpose: ${meta.spec.intendedUse}`, { italic: true }),
    ),
  );
  body.push(
    para(
      run(
        `${meta.projectName} · version ${meta.versionNumber} · generated ${meta.generatedAt.slice(0, 10)} by Brain from the project's accepted research claims`,
        { italic: true, size: 18 },
      ),
    ),
  );

  body.push(para(run('Summary'), 'Heading1'));
  for (const one of content.summary) body.push(para(run(one.text + marks(one.cites))));

  for (const section of content.sections) {
    body.push(para(run(section.heading), 'Heading1'));
    for (const block of section.blocks) {
      if (block.type === 'paragraph') {
        body.push(para(run(block.text + marks(block.cites))));
      } else if (block.type === 'bullets') {
        for (const item of block.items) {
          body.push(para(run(item.text + marks(item.cites)), 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'));
        }
      } else {
        const cell = (text: string, bold: boolean): string =>
          `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(run(text, { bold }))}</w:tc>`;
        const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.columns.map((c) => cell(c, true)).join('')}</w:tr>`;
        const rows = block.rows.map((row) => `<w:tr>${row.map((c) => cell(c, false)).join('')}</w:tr>`).join('');
        body.push(
          `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>` +
            `<w:tblGrid>${block.columns.map(() => '<w:gridCol/>').join('')}</w:tblGrid>${header}${rows}</w:tbl>`,
        );
        body.push(para(run(`Table sources:${marks(block.cites)}`, { italic: true, size: 18 })));
      }
    }
  }

  const gapLines = content.gaps.map(
    (gap) => `Not settled by the evidence — "${meta.spec.requiredContents[gap.requiredContent] ?? ''}": ${gap.reason}`,
  );
  const limitations = [...gapLines, ...content.limitations, ...meta.unmetNeeds];
  if (limitations.length > 0) {
    body.push(para(run('Limitations and gaps'), 'Heading1'));
    for (const line of limitations) {
      body.push(para(run(line), 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'));
    }
  }

  const rels: string[] = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ];
  body.push(para(run('Sources'), 'Heading1'));
  order.forEach((id, index) => {
    const claim = claims.get(id);
    if (!claim) return;
    const relId = `rIdSrc${index + 1}`;
    rels.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(claim.sourceUrl)}" TargetMode="External"/>`,
    );
    const who = [claim.sourcePublisher, claim.sourceTitle].filter(Boolean).join(' — ');
    const parts: string[] = [
      run(`[${index + 1}] `, { bold: true }),
      run(`${claim.claim} `),
      who ? run(`${who}${claim.sourceDate ? ` (${claim.sourceDate})` : ''}. `, { italic: true }) : '',
      `<w:hyperlink r:id="${relId}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">${xml(claim.sourceUrl)}</w:t></w:r></w:hyperlink>`,
      claim.excerpt ? run(` Passage: “${claim.excerpt.slice(0, 500)}”${claim.locator ? ` (${claim.locator})` : ''}.`) : '',
      run(` Claim ${claim.id}.`, { size: 16 }),
    ];
    body.push(para(parts.join(''), 'Source'));
  });

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="28"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Source"><w:name w:val="Source"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
    '</w:tblBorders></w:tblPr></w:style>' +
    '</w:styles>';

  const numbering =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
    '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(content.title)}</dc:title><dc:creator>Brain</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${xml(meta.generatedAt.replace(/\.\d+Z$/, 'Z'))}</dcterms:created>` +
    '</cp:coreProperties>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;

  const bytes = writeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(core) },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/styles.xml', data: Buffer.from(styles) },
    { name: 'word/numbering.xml', data: Buffer.from(numbering) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels) },
  ]);

  return {
    bytes,
    filename: safeFilename(content.title, meta.versionNumber, 'docx'),
    contentType: DOCX_CONTENT_TYPE,
    referenceOrder: order,
  };
}
