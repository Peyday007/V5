/**
 * Dependency-free PDF fixtures.
 *
 * The document-understanding tests need PDFs with known geometry — text at
 * chosen coordinates, pages with no text layer at all, a repeated header, a
 * two-column body, a corrupt file, an encrypted one. Generating them here keeps
 * the assertions exact (we know precisely what should come back out) and keeps
 * the repository free of opaque binary fixtures nobody can inspect or amend.
 *
 * The output is deliberately plain: uncompressed content streams, Helvetica,
 * one xref table. It is a real PDF, not a mock — pdfjs parses it the same way it
 * parses anything else.
 */

export interface FixtureTextItem {
  text: string;
  /** PDF user space: origin bottom-left, y increasing upwards. */
  x: number;
  y: number;
  /** Font size in points; larger text is what makes a line read as a heading. */
  size?: number;
}

export interface FixturePage {
  items: FixtureTextItem[];
  width?: number;
  height?: number;
}

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(page: FixturePage): string {
  return page.items
    .map(
      (item) =>
        `BT /F1 ${item.size ?? 11} Tf 1 0 0 1 ${item.x} ${item.y} Tm (${escapeText(item.text)}) Tj ET`,
    )
    .join('\n');
}

export interface BuildPdfOptions {
  /**
   * Attach a standard-security /Encrypt dictionary whose password check cannot
   * succeed, which is what a password-protected export looks like to a reader.
   */
  encrypted?: boolean;
  producer?: string;
}

/** Assemble the objects, the xref table and the trailer into a real PDF file. */
export function buildPdf(pages: FixturePage[], options: BuildPdfOptions = {}): Buffer {
  if (pages.length === 0) throw new Error('A PDF fixture needs at least one page.');

  const pageCount = pages.length;
  const firstPageObj = 3;
  const firstContentObj = firstPageObj + pageCount;
  const fontObj = firstContentObj + pageCount;
  const infoObj = fontObj + 1;
  const encryptObj = infoObj + 1;
  const objectCount = options.encrypted ? encryptObj : infoObj;

  const bodies: string[] = [];
  const push = (n: number, body: string): void => {
    bodies[n - 1] = `${n} 0 obj\n${body}\nendobj\n`;
  };

  push(1, '<< /Type /Catalog /Pages 2 0 R >>');
  push(
    2,
    `<< /Type /Pages /Count ${pageCount} /Kids [${pages
      .map((_page, index) => `${firstPageObj + index} 0 R`)
      .join(' ')}] >>`,
  );

  pages.forEach((page, index) => {
    const width = page.width ?? PAGE_WIDTH;
    const height = page.height ?? PAGE_HEIGHT;
    push(
      firstPageObj + index,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${firstContentObj + index} 0 R >>`,
    );
    const stream = contentStream(page);
    push(
      firstContentObj + index,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  });

  push(fontObj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  push(infoObj, `<< /Producer (${escapeText(options.producer ?? 'Brain test fixtures')}) >>`);
  if (options.encrypted) {
    // Deliberately unsatisfiable: the /U check cannot pass with an empty user
    // password, which is exactly how a reader learns it needs one.
    const owner = 'A'.repeat(32);
    const user = 'B'.repeat(32);
    push(
      encryptObj,
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 ` +
        `/O <${Buffer.from(owner, 'latin1').toString('hex')}> ` +
        `/U <${Buffer.from(user, 'latin1').toString('hex')}> >>`,
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 0; index < objectCount; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += bodies[index] ?? '';
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }

  const fileId = '<0123456789ABCDEF0123456789ABCDEF>';
  pdf +=
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoObj} 0 R ` +
    `/ID [${fileId} ${fileId}]` +
    (options.encrypted ? ` /Encrypt ${encryptObj} 0 R` : '') +
    ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** A page of body prose with an optional heading, laid out as a single column. */
export function prosePage(
  heading: string | null,
  paragraphs: string[][],
  options: { header?: string; footer?: string; startY?: number } = {},
): FixturePage {
  const items: FixtureTextItem[] = [];
  if (options.header) items.push({ text: options.header, x: 72, y: 750, size: 9 });
  if (options.footer) items.push({ text: options.footer, x: 72, y: 40, size: 9 });

  let y = options.startY ?? 700;
  if (heading) {
    items.push({ text: heading, x: 72, y, size: 16 });
    y -= 30;
  }
  for (const paragraph of paragraphs) {
    for (const line of paragraph) {
      items.push({ text: line, x: 72, y, size: 11 });
      y -= 14;
    }
    // A wider gap is what makes the next paragraph a separate block.
    y -= 16;
  }
  return { items };
}

/** A two-column page: a gutter wide enough to be detectable, header repeated. */
export function twoColumnPage(
  header: string,
  left: string[],
  right: string[],
): FixturePage {
  const items: FixtureTextItem[] = [{ text: header, x: 72, y: 750, size: 9 }];
  let y = 700;
  for (const line of left) {
    items.push({ text: line, x: 60, y, size: 11 });
    y -= 14;
  }
  y = 700;
  for (const line of right) {
    items.push({ text: line, x: 330, y, size: 11 });
    y -= 14;
  }
  return { items };
}

/** A page with no text layer at all — what a scan looks like to an extractor. */
export function imageOnlyPage(): FixturePage {
  return { items: [] };
}
