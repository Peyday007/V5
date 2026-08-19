/**
 * Generate the scanned-PDF fixtures, once, into tests/fixtures/scanned/.
 *
 * A scanned page is a picture of text, and there is no honest way to fake one:
 * OCR has to be given real glyphs with real rasterisation artifacts or the test
 * proves nothing. So this renders the synthetic text pages the other fixtures
 * use, at a chosen DPI, and embeds the resulting JPEGs as image XObjects with no
 * text layer at all.
 *
 * It needs poppler (`pdftoppm`) and ImageMagick or `cjpeg` only at generation
 * time; the committed PDFs are what the tests read, so the suite itself has no
 * such dependency. Re-run with:
 *
 *   npx tsx tests/fixtures/make-scans.ts
 *
 * The content is invented Deal-Dispatch-shaped prose. Nothing here is sensitive.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf, prosePage, type FixtureImage, type FixturePage } from './pdf.ts';

const OUT = fileURLToPath(new URL('./scanned/', import.meta.url));

const BODY = [
  'Custody of a distressed asset transfers at the point of assignment rather than at',
  'the point of notice, and claim priority is fixed by the earlier of those two events.',
  'Every downstream consumer reads priority off the artefact instead of recomputing it,',
  'so a routing change must never be able to alter it.',
];

const SECOND = [
  'An originator, a servicer, a custodian and a claimant are the four participants.',
  'Each holds rights against a specific object rather than against another participant,',
  'which is what allows an obligation to be discharged without renegotiating the chain.',
];

/** Rasterise one page of a PDF to a JPEG at the given resolution and quality. */
function rasterise(pdf: Buffer, pageNumber: number, dpi: number, quality = 80): FixtureImage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scan-'));
  try {
    const source = path.join(dir, 'source.pdf');
    fs.writeFileSync(source, pdf);
    const prefix = path.join(dir, 'page');
    execFileSync('pdftoppm', [
      '-f', String(pageNumber), '-l', String(pageNumber),
      '-r', String(dpi), '-jpeg', '-jpegopt', `quality=${quality}`,
      source, prefix,
    ]);
    const produced = fs.readdirSync(dir).find((name) => name.startsWith('page') && name.endsWith('.jpg'));
    if (!produced) throw new Error(`pdftoppm produced no image for page ${pageNumber}`);
    const jpeg = fs.readFileSync(path.join(dir, produced));
    const { width, height } = jpegSize(jpeg);
    return { jpeg, width, height };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the dimensions out of a JPEG's start-of-frame marker. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < jpeg.byteLength) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpeg[offset + 1] ?? 0;
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  throw new Error('Could not find the JPEG frame header.');
}

/**
 * A page of speckle: a scan of something with no glyphs on it at all.
 *
 * Drawn as marks in a PDF and then photographed like the others, so it goes
 * through exactly the same rasterisation path as a real scan — the difference is
 * only that there is nothing on it to read.
 */
function noiseImage(): FixtureImage {
  const marks: string[] = ['0 g'];
  for (let index = 0; index < 4_000; index += 1) {
    // Deterministic speckle: no font, no glyph shapes, nothing OCR can latch on to.
    const x = (index * 137) % 590;
    const y = ((index * 251) % 770) + 10;
    marks.push(`${x} ${y} ${2 + (index % 3)} ${2 + (index % 2)} re f`);
  }
  const noisePdf = buildPdf([{ items: [], raw: marks.join('\n') }]);
  return rasterise(noisePdf, 1, 100, 60);
}

const scannedPage = (image: FixtureImage, rotate?: FixturePage['rotate']): FixturePage => ({
  items: [],
  image,
  ...(rotate ? { rotate } : {}),
});

function write(name: string, pdf: Buffer): void {
  fs.writeFileSync(path.join(OUT, name), pdf);
  console.log(`${name.padEnd(28)} ${pdf.byteLength} bytes`);
}

fs.mkdirSync(OUT, { recursive: true });

// The source pages, rendered as ordinary text PDFs and then photographed.
const sourceThree = buildPdf([
  prosePage('Custody and priority', [BODY, SECOND]),
  prosePage('Participants', [SECOND, BODY]),
  prosePage('Boundaries', [BODY, SECOND]),
]);
const structured = buildPdf([
  {
    items: [
      { text: 'Qualification Logic', x: 72, y: 700, size: 18 },
      { text: 'A deal qualifies when custody is established and priority is', x: 72, y: 660, size: 12 },
      { text: 'recorded on the artefact. Neither condition is sufficient alone.', x: 72, y: 642, size: 12 },
      { text: 'Conditions', x: 72, y: 600, size: 15 },
      { text: '- Custody is established by assignment.', x: 72, y: 570, size: 12 },
      { text: '- Priority is recorded, not inferred.', x: 72, y: 552, size: 12 },
      { text: 'Anything the rule does not admit is an open question for the', x: 72, y: 510, size: 12 },
      { text: 'routing layer, and is recorded there rather than here.', x: 72, y: 492, size: 12 },
    ],
  },
]);

const scans = [1, 2, 3].map((page) => rasterise(sourceThree, page, 150));

// 1. A fully scanned multi-page PDF.
write('scanned-multipage.pdf', buildPdf(scans.map((image) => scannedPage(image))));

// 2. A mixed PDF: native text pages either side of a scanned one.
write(
  'mixed-native-scanned.pdf',
  buildPdf([
    prosePage('Custody and priority', [BODY, SECOND]),
    scannedPage(scans[1]!),
    prosePage('Boundaries', [BODY, SECOND]),
  ]),
);

// 3. A poor scan: a low resolution and a heavy JPEG quantiser, the way a fax or a
// phone photo of a printout arrives. Readable, but visibly less certain.
write('low-resolution.pdf', buildPdf([scannedPage(rasterise(sourceThree, 1, 60, 8))]));

// 4. A page the scanner fed in sideways.
write('rotated.pdf', buildPdf([scannedPage(scans[0]!, 90)]));

// 5. A scan with a heading, paragraphs and a list.
write('structured-scan.pdf', buildPdf([scannedPage(rasterise(structured, 1, 150))]));

// 6. A scan with no text in it at all.
const noise = noiseImage();
write('unreadable-scan.pdf', buildPdf([scannedPage(noise), scannedPage(noise)]));

console.log('\nRegenerate with: npx tsx tests/fixtures/make-scans.ts');
