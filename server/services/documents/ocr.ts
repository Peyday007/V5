/**
 * OCR fallback (section 6, completed in the final OCR pass).
 *
 * OCR is a local capability Brain may or may not have, so it stays a pluggable
 * adapter rather than an assumption. What changed is that the adapter is now
 * wired to a real local runtime it discovers for itself (see `ocrRuntime.ts`),
 * and that a recognised page carries its provenance: which engine read it, at
 * what resolution, from which rendered image, with what confidence.
 *
 * Two disciplines hold throughout:
 *
 *   - Only pages that need it are processed. A fifty-page report with one
 *     scanned page costs one OCR call, not fifty.
 *   - A page that could not be rendered, timed out, or came back empty is
 *     reported as unreadable. It is never handed to an auditor as blank
 *     content, and it never makes a document look complete.
 *
 * Recognition is entirely local. There is no cloud fallback, and no document
 * ever leaves the machine to be read.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BlockType } from '../../domain/types.ts';
import { probeOcrRuntime, type OcrRuntime } from './ocrRuntime.ts';

/** One recognised passage, with the geometry and certainty behind it. */
export interface OcrBlock {
  text: string;
  blockType: BlockType;
  /** PDF user space, converted from image pixels; null when the engine gives none. */
  bbox: [number, number, number, number] | null;
  /** 0..1, or null when the engine does not report one. */
  confidence: number | null;
}

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  /** 0..1 when the engine reports it. */
  confidence: number | null;
  warnings: string[];
  /** Structured output, when the engine can provide it. */
  blocks?: OcrBlock[];
  /** Identity of the exact image that was read, so the reading is reproducible. */
  imageHash?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  dpi?: number | null;
  durationMs?: number | null;
}

export interface OcrEngine {
  readonly name: string;
  readonly available: boolean;
  /** Why it is (or is not) usable, phrased for the user. */
  readonly reason: string;
  readonly version: string | null;
  readonly rendererVersion: string | null;
  /** The exact one-time steps to enable OCR, when it is unavailable. */
  readonly install: string[];
  recognizePages(pdf: Buffer, pageNumbers: number[]): Promise<OcrPageResult[]>;
}

/** Confidence below this is reported as a low-confidence reading, not hidden. */
export const LOW_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Reading tesseract's TSV
// ---------------------------------------------------------------------------

interface TsvRow {
  level: number;
  block: number;
  paragraph: number;
  line: number;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  text: string;
}

function parseTsv(tsv: string): TsvRow[] {
  const lines = tsv.split(/\r?\n/);
  const rows: TsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    if (cells.length < 12) continue;
    const level = Number(cells[0]);
    if (!Number.isFinite(level)) continue;
    rows.push({
      level,
      block: Number(cells[2]) || 0,
      paragraph: Number(cells[3]) || 0,
      line: Number(cells[4]) || 0,
      left: Number(cells[6]) || 0,
      top: Number(cells[7]) || 0,
      width: Number(cells[8]) || 0,
      height: Number(cells[9]) || 0,
      confidence: Number(cells[10]),
      text: cells[11] ?? '',
    });
  }
  return rows;
}

const LIST_RE = /^\s*(?:[-*•‣◦·]|\(?\d{1,3}[.)]|[a-z][.)])\s+/i;

function classify(text: string, lineHeight: number, medianHeight: number): BlockType {
  if (LIST_RE.test(text)) return 'LIST_ITEM';
  if (lineHeight >= medianHeight * 1.15 && text.length <= 120) return 'HEADING';
  return 'PARAGRAPH';
}

/**
 * Group tesseract's word rows into paragraph blocks.
 *
 * Paragraph is the right grain: it matches what the native PDF reader produces,
 * so a mixed document's blocks are comparable page to page, and it keeps a
 * bounding box tight enough to be worth storing.
 */
function blocksFromTsv(rows: TsvRow[], pageHeightPx: number, dpi: number): OcrBlock[] {
  const scale = 72 / dpi;
  const lineHeights = rows.filter((row) => row.level === 4).map((row) => row.height).sort((a, b) => a - b);
  const medianHeight = lineHeights[Math.floor(lineHeights.length / 2)] ?? 0;

  const paragraphs = new Map<string, { rows: TsvRow[]; frame: TsvRow | null; lineHeight: number }>();
  for (const row of rows) {
    if (row.level !== 3 && row.level !== 4 && row.level !== 5) continue;
    const key = `${row.block}/${row.paragraph}`;
    const entry = paragraphs.get(key) ?? { rows: [], frame: null, lineHeight: 0 };
    if (row.level === 3) entry.frame = row;
    else if (row.level === 4) entry.lineHeight = Math.max(entry.lineHeight, row.height);
    else entry.rows.push(row);
    paragraphs.set(key, entry);
  }

  const blocks: OcrBlock[] = [];
  for (const entry of paragraphs.values()) {
    const words = entry.rows.filter((row) => row.text.trim().length > 0);
    if (words.length === 0) continue;
    const text = words.map((row) => row.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;

    const scored = words.filter((row) => row.confidence >= 0);
    const confidence =
      scored.length === 0
        ? null
        : Number((scored.reduce((total, row) => total + row.confidence, 0) / scored.length / 100).toFixed(4));

    // Pixels have their origin top-left; PDF user space has it bottom-left, and
    // native blocks are stored in PDF space, so convert rather than mix the two.
    const frame = entry.frame;
    const bbox: OcrBlock['bbox'] = frame
      ? [
          Number((frame.left * scale).toFixed(2)),
          Number(((pageHeightPx - frame.top - frame.height) * scale).toFixed(2)),
          Number(((frame.left + frame.width) * scale).toFixed(2)),
          Number(((pageHeightPx - frame.top) * scale).toFixed(2)),
        ]
      : null;

    blocks.push({
      text,
      blockType: classify(text, entry.lineHeight, medianHeight),
      bbox,
      confidence,
    });
  }
  return blocks;
}

/** Width and height out of a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.byteLength < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// The local engine
// ---------------------------------------------------------------------------

interface RunOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  message: string;
}

function run(command: string, args: string[], timeoutMs: number): RunOutcome {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = result.error !== undefined && /ETIMEDOUT|timed? ?out/i.test(String(result.error));
  const killedBySignal = result.signal !== null && result.signal !== undefined;
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
    timedOut: timedOut || (killedBySignal && result.status === null),
    message: result.error
      ? String((result.error as Error).message ?? result.error)
      : result.status === 0
        ? ''
        : `exited with status ${result.status}${result.stderr ? `: ${String(result.stderr).trim()}` : ''}`,
  };
}

/**
 * Tesseract driven through its command line, with poppler rendering the pages.
 *
 * Shelling out rather than bundling a WASM build is deliberate: the native
 * binaries are an order of magnitude faster on a fifty-page scan, they are what
 * a user already has if they have ever done OCR, and the alternative is
 * carrying a thirty-megabyte dependency that most imports never touch.
 */
export class LocalOcrEngine implements OcrEngine {
  readonly name = 'tesseract-cli';
  readonly available: boolean;
  readonly reason: string;
  readonly version: string | null;
  readonly rendererVersion: string | null;
  readonly install: string[];
  readonly #runtime: OcrRuntime;

  constructor(runtime: OcrRuntime) {
    this.#runtime = runtime;
    this.available = runtime.available;
    this.reason = runtime.reason;
    this.version = runtime.recognizer.version;
    this.rendererVersion = runtime.renderer.version;
    this.install = runtime.install;
  }

  get runtime(): OcrRuntime {
    return this.#runtime;
  }

  /** Rasterise one page. Returns null with a reason when the renderer fails. */
  #render(
    pdfPath: string,
    pageNumber: number,
    workDir: string,
  ): { png: Buffer; path: string } | { error: string; timedOut: boolean } {
    const renderer = this.#runtime.renderer.command!;
    const prefix = path.join(workDir, `p${pageNumber}`);
    const outcome = run(
      renderer,
      [
        '-f', String(pageNumber),
        '-l', String(pageNumber),
        '-r', String(this.#runtime.dpi),
        '-png',
        pdfPath,
        prefix,
      ],
      this.#runtime.timeoutMs,
    );
    if (!outcome.ok) {
      return {
        error: outcome.timedOut
          ? `rendering page ${pageNumber} timed out after ${this.#runtime.timeoutMs}ms`
          : `page ${pageNumber} could not be rendered (${outcome.message || 'unknown error'})`,
        timedOut: outcome.timedOut,
      };
    }
    const base = path.basename(prefix);
    const produced = fs
      .readdirSync(workDir)
      .filter((name) => name.startsWith(base) && name.endsWith('.png'))
      .sort();
    const first = produced[0];
    if (!first) {
      return { error: `the renderer produced no image for page ${pageNumber}`, timedOut: false };
    }
    const file = path.join(workDir, first);
    return { png: fs.readFileSync(file), path: file };
  }

  async recognizePages(pdf: Buffer, pageNumbers: number[]): Promise<OcrPageResult[]> {
    if (!this.available) {
      return pageNumbers.map((pageNumber) => ({
        pageNumber,
        text: '',
        confidence: null,
        warnings: [`Page ${pageNumber} needs OCR but no OCR engine is available. ${this.reason}`],
      }));
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ocr-'));
    const pdfPath = path.join(workDir, 'source.pdf');
    fs.writeFileSync(pdfPath, pdf);
    const results: OcrPageResult[] = [];

    try {
      for (const pageNumber of pageNumbers) {
        const startedAt = Date.now();
        const rendered = this.#render(pdfPath, pageNumber, workDir);
        if ('error' in rendered) {
          results.push({
            pageNumber,
            text: '',
            confidence: null,
            warnings: [`OCR failed: ${rendered.error}.`],
            durationMs: Date.now() - startedAt,
          });
          continue;
        }

        // The identity of what was actually read, so a reading is reproducible
        // and a citation can be traced to the exact image behind it.
        const imageHash = createHash('sha256').update(rendered.png).digest('hex');
        const size = pngSize(rendered.png);

        const out = path.join(workDir, `p${pageNumber}-out`);
        const outcome = run(
          this.#runtime.recognizer.command!,
          [rendered.path, out, '-l', this.#runtime.language, '--psm', '1', 'tsv'],
          this.#runtime.timeoutMs,
        );
        const durationMs = Date.now() - startedAt;

        if (!outcome.ok) {
          results.push({
            pageNumber,
            text: '',
            confidence: null,
            warnings: [
              outcome.timedOut
                ? `OCR of page ${pageNumber} timed out after ${this.#runtime.timeoutMs}ms.`
                : `OCR failed on page ${pageNumber}: ${outcome.message || 'unknown error'}.`,
            ],
            imageHash,
            imageWidth: size?.width ?? null,
            imageHeight: size?.height ?? null,
            dpi: this.#runtime.dpi,
            durationMs,
          });
          continue;
        }

        const tsvPath = `${out}.tsv`;
        if (!fs.existsSync(tsvPath)) {
          results.push({
            pageNumber,
            text: '',
            confidence: null,
            warnings: [`OCR of page ${pageNumber} produced no output file.`],
            imageHash,
            dpi: this.#runtime.dpi,
            durationMs,
          });
          continue;
        }

        const rows = parseTsv(fs.readFileSync(tsvPath, 'utf8'));
        const heightPx = size?.height ?? rows.find((row) => row.level === 1)?.height ?? 0;
        const blocks = blocksFromTsv(rows, heightPx, this.#runtime.dpi);
        const text = blocks.map((block) => block.text).join('\n\n');
        const scored = blocks.filter((block) => block.confidence !== null);
        const confidence =
          scored.length === 0
            ? null
            : Number(
                (scored.reduce((total, block) => total + (block.confidence ?? 0), 0) / scored.length).toFixed(4),
              );

        const warnings: string[] = [];
        if (text.trim().length === 0) {
          warnings.push(`OCR found no text on page ${pageNumber}; the page may be blank or unreadable.`);
        } else if (confidence !== null && confidence < LOW_CONFIDENCE) {
          warnings.push(
            `OCR read page ${pageNumber} with low confidence (${Math.round(confidence * 100)}%); ` +
              'check the wording against the original before relying on it.',
          );
        }

        results.push({
          pageNumber,
          text,
          confidence,
          warnings,
          blocks,
          imageHash,
          imageWidth: size?.width ?? null,
          imageHeight: heightPx || null,
          dpi: this.#runtime.dpi,
          durationMs,
        });
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    return results;
  }
}

/** The honest default: no engine, and pages that need one are said to be unreadable. */
export class UnavailableOcrEngine implements OcrEngine {
  readonly name = 'none';
  readonly available = false;
  readonly reason: string;
  readonly version = null;
  readonly rendererVersion = null;
  readonly install: string[];

  constructor(runtime: OcrRuntime) {
    this.reason = runtime.reason;
    this.install = runtime.install;
  }

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
let cachedRuntime: OcrRuntime | null = null;

/** The discovered runtime, probed once per process. */
export function ocrRuntime(): OcrRuntime {
  if (!cachedRuntime) cachedRuntime = probeOcrRuntime();
  return cachedRuntime;
}

/**
 * The configured OCR engine.
 *
 * `BRAIN_OCR=none` disables OCR explicitly, which is useful when a deterministic
 * result matters more than coverage.
 */
export function getOcrEngine(): OcrEngine {
  if (cached) return cached;
  const runtime = ocrRuntime();
  cached = runtime.available ? new LocalOcrEngine(runtime) : new UnavailableOcrEngine(runtime);
  return cached;
}

/** Test seam: swap the engine, or reset to auto-detection with null. */
export function setOcrEngine(engine: OcrEngine | null): void {
  cached = engine;
  if (engine === null) cachedRuntime = null;
}

/**
 * What the UI and `/api/health` need to say about OCR, in one shape.
 *
 * Reported whether or not OCR is available, because "we cannot read scans, and
 * here is the one command that fixes it" is a far more useful answer than
 * silence followed by a blocked document.
 */
export interface OcrStatus {
  available: boolean;
  engine: string;
  engineVersion: string | null;
  recognizerPath: string | null;
  recognizerSource: string | null;
  renderer: string | null;
  rendererVersion: string | null;
  rendererPath: string | null;
  reason: string;
  install: string[];
  dpi: number;
  language: string;
  timeoutMs: number;
  /** Set when OCR was switched off deliberately rather than found missing. */
  disabled: boolean;
}

export function ocrStatus(): OcrStatus {
  const engine = getOcrEngine();
  const runtime = ocrRuntime();
  return {
    available: engine.available,
    engine: engine.name,
    engineVersion: engine.version,
    recognizerPath: runtime.recognizer.command,
    recognizerSource: runtime.recognizer.source,
    renderer: runtime.renderer.tool,
    rendererVersion: engine.rendererVersion,
    rendererPath: runtime.renderer.command,
    reason: engine.reason,
    install: engine.install,
    dpi: runtime.dpi,
    language: runtime.language,
    timeoutMs: runtime.timeoutMs,
    disabled: runtime.disabled,
  };
}
