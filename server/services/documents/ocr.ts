/**
 * OCR fallback (section 6).
 *
 * OCR is a local capability Brain may or may not have, so it is a pluggable
 * adapter rather than an assumption. If no engine is available, pages that need
 * OCR are recorded as failed with the reason — they are never quietly passed to
 * the auditor as empty content, and they never make a document look readable.
 *
 * Only pages that need it are processed: a fifty-page report with one scanned
 * page costs one OCR call, not fifty.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  /** 0..1 when the engine reports it. */
  confidence: number | null;
  warnings: string[];
}

export interface OcrEngine {
  readonly name: string;
  readonly available: boolean;
  /** Why it is (or is not) usable, phrased for the user. */
  readonly reason: string;
  recognizePages(pdf: Buffer, pageNumbers: number[]): Promise<OcrPageResult[]>;
}

/** Rasterise one PDF page to PNG. Requires poppler's pdftoppm. */
function renderPage(pdfPath: string, pageNumber: number, outPrefix: string, dpi: number): string | null {
  const result = spawnSync(
    'pdftoppm',
    ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(dpi), '-png', pdfPath, outPrefix],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  const dir = path.dirname(outPrefix);
  const base = path.basename(outPrefix);
  const produced = fs.readdirSync(dir).find((name) => name.startsWith(base) && name.endsWith('.png'));
  return produced ? path.join(dir, produced) : null;
}

function binaryExists(command: string): boolean {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 || probe.status === 1;
}

/**
 * The tesseract command-line engine, used when it is installed locally.
 * Deliberately shells out rather than bundling a WASM build: OCR is optional,
 * and a 30 MB dependency that most imports never touch is not worth carrying.
 */
class TesseractCliEngine implements OcrEngine {
  readonly name = 'tesseract-cli';
  readonly available: boolean;
  readonly reason: string;

  constructor() {
    const tesseract = binaryExists('tesseract');
    const poppler = binaryExists('pdftoppm');
    this.available = tesseract && poppler;
    if (this.available) {
      this.reason = 'Local tesseract and pdftoppm are installed.';
    } else if (!tesseract) {
      this.reason =
        'The tesseract binary is not installed, so scanned pages cannot be read. ' +
        'Install tesseract-ocr to enable OCR; until then such pages are reported as unreadable.';
    } else {
      this.reason =
        'pdftoppm (poppler-utils) is not installed, so PDF pages cannot be rasterised for OCR.';
    }
  }

  async recognizePages(pdf: Buffer, pageNumbers: number[]): Promise<OcrPageResult[]> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ocr-'));
    const pdfPath = path.join(workDir, 'source.pdf');
    fs.writeFileSync(pdfPath, pdf);
    const results: OcrPageResult[] = [];

    try {
      for (const pageNumber of pageNumbers) {
        const imagePath = renderPage(pdfPath, pageNumber, path.join(workDir, `p${pageNumber}`), 300);
        if (!imagePath) {
          results.push({
            pageNumber,
            text: '',
            confidence: null,
            warnings: [`Page ${pageNumber} could not be rasterised for OCR.`],
          });
          continue;
        }
        const out = path.join(workDir, `p${pageNumber}-out`);
        const run = spawnSync('tesseract', [imagePath, out, '--psm', '1'], { encoding: 'utf8' });
        const textPath = `${out}.txt`;
        if (run.status !== 0 || !fs.existsSync(textPath)) {
          results.push({
            pageNumber,
            text: '',
            confidence: null,
            warnings: [`OCR failed on page ${pageNumber}: ${(run.stderr ?? '').trim() || 'unknown error'}`],
          });
          continue;
        }
        const text = fs.readFileSync(textPath, 'utf8').trim();
        results.push({
          pageNumber,
          text,
          // The CLI does not report a per-page confidence without extra passes;
          // an absent number is honest, a fabricated one is not.
          confidence: null,
          warnings: text.length === 0 ? [`OCR produced no text for page ${pageNumber}.`] : [],
        });
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    return results;
  }
}

/** The honest default: no engine, and pages that need one are said to be unreadable. */
class UnavailableOcrEngine implements OcrEngine {
  readonly name = 'none';
  readonly available = false;
  readonly reason =
    'No local OCR engine is available, so scanned or image-only pages cannot be read. ' +
    'Install tesseract-ocr (and poppler-utils) to enable OCR.';

  async recognizePages(_pdf: Buffer, pageNumbers: number[]): Promise<OcrPageResult[]> {
    return pageNumbers.map((pageNumber) => ({
      pageNumber,
      text: '',
      confidence: null,
      warnings: [`Page ${pageNumber} needs OCR but no OCR engine is available.`],
    }));
  }
}

let cached: OcrEngine | null = null;

/**
 * The configured OCR engine. `BRAIN_OCR=none` disables OCR explicitly, which is
 * useful when a deterministic result matters more than coverage.
 */
export function getOcrEngine(): OcrEngine {
  if (cached) return cached;
  if ((process.env.BRAIN_OCR ?? '').toLowerCase() === 'none') {
    cached = new UnavailableOcrEngine();
    return cached;
  }
  const tesseract = new TesseractCliEngine();
  cached = tesseract.available ? tesseract : new UnavailableOcrEngine();
  return cached;
}

/** Test seam: swap the engine, or reset to auto-detection with null. */
export function setOcrEngine(engine: OcrEngine | null): void {
  cached = engine;
}
