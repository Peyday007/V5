/**
 * Finding the local OCR runtime (section 3).
 *
 * OCR needs two executables — a recogniser and something to turn a PDF page into
 * a picture — and the whole point of this module is that Brain finds them
 * itself. Asking a user to edit their global PATH before the application will
 * read a scan is exactly the kind of manual step this platform exists to remove.
 *
 * Discovery is deterministic and in a fixed order, so two runs on the same
 * machine always resolve the same binary:
 *
 *   1. an explicit path in the environment  (BRAIN_TESSERACT_PATH / BRAIN_PDF_RENDERER_PATH)
 *   2. the PATH, if the name resolves there
 *   3. the default install locations for this platform
 *
 * Everything runs locally. There is no cloud OCR fallback and no upload of any
 * document to a third party — a scan that cannot be read here is reported
 * unreadable, never sent somewhere else to be read.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ProbeSource = 'env' | 'path' | 'install-location';

export interface ExecutableProbe {
  /** The logical tool: 'tesseract' or the page renderer. */
  tool: string;
  /** Absolute path, or the bare name when the PATH resolved it. */
  command: string | null;
  version: string | null;
  source: ProbeSource | null;
  /** Everything that was tried, so a failure can say where it looked. */
  searched: string[];
}

const WINDOWS = process.platform === 'win32';
const EXE = WINDOWS ? '.exe' : '';

/** Directories a package manager or installer would have used, per platform. */
function installDirectories(): string[] {
  if (WINDOWS) {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return [
      path.join(programFiles, 'Tesseract-OCR'),
      path.join(programFilesX86, 'Tesseract-OCR'),
      localAppData ? path.join(localAppData, 'Programs', 'Tesseract-OCR') : '',
      path.join(programFiles, 'poppler', 'Library', 'bin'),
      path.join(programFiles, 'poppler', 'bin'),
      'C:\\poppler\\Library\\bin',
      localAppData ? path.join(localAppData, 'Programs', 'poppler', 'Library', 'bin') : '',
      // Poppler for Windows ships as poppler-<version>; take them newest first.
      ...versionedPopplerDirectories([programFiles, 'C:\\']),
    ].filter((entry) => entry.length > 0);
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  }
  return ['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin'];
}

/**
 * `C:\Program Files\poppler-24.08.0\Library\bin` and friends.
 *
 * Sorted descending so a newer release wins, and the sort is what makes the
 * choice deterministic rather than dependent on directory order.
 */
function versionedPopplerDirectories(roots: string[]): string[] {
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    const candidates = entries
      .filter((entry) => /^poppler[-_]/i.test(entry))
      .sort()
      .reverse();
    for (const candidate of candidates) {
      found.push(path.join(root, candidate, 'Library', 'bin'));
      found.push(path.join(root, candidate, 'bin'));
    }
  }
  return found;
}

/** Ask a candidate for its version. Success here is the capability check. */
function versionOf(command: string, args: string[] = ['--version']): string | null {
  try {
    const probe = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
    // Some tools answer --version on stderr and exit 1; the output is the signal.
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
    if (probe.error || output.length === 0) return null;
    return output.split(/\r?\n/)[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate one executable, trying each source in order and recording every place
 * it looked so a missing dependency can be reported precisely.
 */
export function findExecutable(input: {
  tool: string;
  names: string[];
  envVar: string;
  versionArgs?: string[];
}): ExecutableProbe {
  const searched: string[] = [];
  const versionArgs = input.versionArgs ?? ['--version'];

  const configured = (process.env[input.envVar] ?? '').trim();
  if (configured.length > 0) {
    searched.push(`${input.envVar}=${configured}`);
    const version = versionOf(configured, versionArgs);
    if (version) {
      return { tool: input.tool, command: configured, version, source: 'env', searched };
    }
    // An explicit setting is authoritative, including when it is wrong. Falling
    // back to some other binary on the PATH would mean the user configured one
    // engine and Brain quietly used another — and the version it reported would
    // not be the version that read their documents.
    searched.push(`${input.envVar} is set but did not answer ${versionArgs.join(' ')}; not falling back`);
    return { tool: input.tool, command: null, version: null, source: null, searched };
  }

  for (const name of input.names) {
    const bare = `${name}${EXE}`;
    searched.push(`PATH: ${bare}`);
    const version = versionOf(bare, versionArgs);
    if (version) {
      return { tool: input.tool, command: bare, version, source: 'path', searched };
    }
  }

  for (const directory of installDirectories()) {
    for (const name of input.names) {
      const candidate = path.join(directory, `${name}${EXE}`);
      searched.push(candidate);
      if (!fs.existsSync(candidate)) continue;
      const version = versionOf(candidate, versionArgs);
      if (version) {
        return { tool: input.tool, command: candidate, version, source: 'install-location', searched };
      }
    }
  }

  return { tool: input.tool, command: null, version: null, source: null, searched };
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
  });
  // pdftoppm is the primary; pdftocairo is the same package and an equally good
  // rasteriser, so a poppler build missing one still works.
  const renderer = findExecutable({
    tool: 'pdf-renderer',
    names: ['pdftoppm', 'pdftocairo'],
    envVar: 'BRAIN_PDF_RENDERER_PATH',
    versionArgs: ['-v'],
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
