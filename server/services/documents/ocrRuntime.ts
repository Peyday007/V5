/**
 * Finding the local OCR runtime (section 3).
 *
 * OCR needs two executables — a recogniser and something to turn a PDF page into
 * a picture — and Brain finds them itself rather than asking anyone to edit a
 * PATH. The search order and the version-probe-as-capability-check live in
 * `services/exec/discovery.ts`, shared with every other local tool Brain looks
 * for; what belongs here is which names to try, where else to look, and what to
 * tell the user when they are absent.
 *
 * Everything runs locally. There is no cloud OCR fallback and no upload of any
 * document to a third party — a scan that cannot be read here is reported
 * unreadable, never sent somewhere else to be read.
 */
import path from 'node:path';
import {
  findExecutable,
  platformInstallDirectories,
  versionedDirectories,
  WINDOWS,
  type ExecutableProbe,
} from '../exec/discovery.ts';

export type { ExecutableProbe, ProbeSource } from '../exec/discovery.ts';
export { findExecutable } from '../exec/discovery.ts';

/** Where poppler and tesseract put themselves, beyond the platform defaults. */
function ocrInstallDirectories(): string[] {
  if (!WINDOWS) return [];
  const roots = platformInstallDirectories();
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  return [
    ...roots.map((root) => path.join(root, 'Tesseract-OCR')),
    path.join(programFiles, 'poppler', 'Library', 'bin'),
    path.join(programFiles, 'poppler', 'bin'),
    'C:\\poppler\\Library\\bin',
    localAppData ? path.join(localAppData, 'Programs', 'poppler', 'Library', 'bin') : '',
    // Poppler for Windows ships as poppler-<version>; take them newest first.
    ...versionedDirectories([programFiles, 'C:\\'], /^poppler[-_]/i, [
      path.join('Library', 'bin'),
      'bin',
    ]),
  ].filter((entry) => entry.length > 0);
}

export interface OcrRuntime {
  available: boolean;
  recognizer: ExecutableProbe;
  renderer: ExecutableProbe;
  /** Why it is (or is not) usable, phrased for someone who is not a developer. */
  reason: string;
  /** The exact one-time steps to make it work, when something is missing. */
  install: string[];
  /** Recognition language(s) passed to the recogniser. */
  language: string;
  dpi: number;
  timeoutMs: number;
  disabled: boolean;
}

function positiveInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = (value ?? '').trim();
  // An unset variable means "use the default", not "use zero" — which would
  // clamp to the minimum and quietly rasterise every scan at the worst
  // resolution the setting allows.
  if (raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const INSTALL_STEPS: Record<string, { tesseract: string[]; poppler: string[] }> = {
  win32: {
    tesseract: [
      'Install Tesseract OCR (one time): winget install --id UB-Mannheim.TesseractOCR',
      '  or download the installer from https://github.com/UB-Mannheim/tesseract/wiki',
      '  Brain looks in "C:\\Program Files\\Tesseract-OCR" automatically; no PATH edit is needed.',
    ],
    poppler: [
      'Install Poppler for the page renderer (one time): download the latest release from',
      '  https://github.com/oschwartz10612/poppler-windows/releases and unzip it to',
      '  "C:\\Program Files\\poppler". Brain finds "Library\\bin" inside it automatically.',
    ],
  },
  darwin: {
    tesseract: ['Install Tesseract OCR (one time): brew install tesseract'],
    poppler: ['Install Poppler for the page renderer (one time): brew install poppler'],
  },
  linux: {
    tesseract: ['Install Tesseract OCR (one time): sudo apt-get install -y tesseract-ocr'],
    poppler: ['Install Poppler for the page renderer (one time): sudo apt-get install -y poppler-utils'],
  },
};

function stepsFor(missing: { tesseract: boolean; poppler: boolean }): string[] {
  const steps = INSTALL_STEPS[process.platform] ?? INSTALL_STEPS['linux']!;
  const out: string[] = [];
  if (missing.tesseract) out.push(...steps.tesseract);
  if (missing.poppler) out.push(...steps.poppler);
  out.push(
    'Already installed somewhere else? Point Brain at it with BRAIN_TESSERACT_PATH and ' +
      'BRAIN_PDF_RENDERER_PATH, then restart.',
  );
  return out;
}

/**
 * Probe the machine once and describe what OCR can do here.
 *
 * Called at startup so the answer is known before the first scan arrives, rather
 * than discovered halfway through reading a fifty-page document.
 */
export function probeOcrRuntime(): OcrRuntime {
  const language = (process.env['BRAIN_OCR_LANG'] ?? 'eng').trim() || 'eng';
  const dpi = positiveInteger(process.env['BRAIN_OCR_DPI'], 300, 72, 600);
  const timeoutMs = positiveInteger(process.env['BRAIN_OCR_TIMEOUT_MS'], 120_000, 5_000, 900_000);
  const empty = (tool: string): ExecutableProbe => ({
    tool,
    command: null,
    version: null,
    source: null,
    searched: [],
  });

  if ((process.env['BRAIN_OCR'] ?? '').toLowerCase() === 'none') {
    return {
      available: false,
      recognizer: empty('tesseract'),
      renderer: empty('pdf-renderer'),
      reason:
        'OCR is switched off for this instance (BRAIN_OCR=none), so scanned pages are reported ' +
        'unreadable rather than guessed at.',
      install: ['Remove BRAIN_OCR=none from the environment and restart to enable OCR.'],
      language,
      dpi,
      timeoutMs,
      disabled: true,
    };
  }

  const recognizer = findExecutable({
    tool: 'tesseract',
    names: ['tesseract'],
    envVar: 'BRAIN_TESSERACT_PATH',
    extraDirectories: ocrInstallDirectories(),
  });
  // pdftoppm is the primary; pdftocairo is the same package and an equally good
  // rasteriser, so a poppler build missing one still works.
  const renderer = findExecutable({
    tool: 'pdf-renderer',
    names: ['pdftoppm', 'pdftocairo'],
    envVar: 'BRAIN_PDF_RENDERER_PATH',
    versionArgs: ['-v'],
    extraDirectories: ocrInstallDirectories(),
  });

  const missing = { tesseract: !recognizer.command, poppler: !renderer.command };
  if (!missing.tesseract && !missing.poppler) {
    return {
      available: true,
      recognizer,
      renderer,
      reason: `Local OCR is ready: ${recognizer.version} with ${renderer.version}.`,
      install: [],
      language,
      dpi,
      timeoutMs,
      disabled: false,
    };
  }

  const absent = [missing.tesseract ? 'Tesseract OCR' : null, missing.poppler ? 'Poppler' : null]
    .filter(Boolean)
    .join(' and ');
  return {
    available: false,
    recognizer,
    renderer,
    reason:
      `Scanned pages cannot be read on this machine: ${absent} ${missing.tesseract && missing.poppler ? 'are' : 'is'} ` +
      'not installed. Until it is, such pages are reported unreadable — never passed to an ' +
      'audit as empty content.',
    install: stepsFor(missing),
    language,
    dpi,
    timeoutMs,
    disabled: false,
  };
}
