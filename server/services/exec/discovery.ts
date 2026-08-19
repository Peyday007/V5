/**
 * Finding a local executable, deterministically.
 *
 * Brain depends on tools that live on the user's machine rather than in its own
 * dependency tree — an OCR engine, an automation CLI — and the rule for all of
 * them is the same: Brain finds them itself. Asking someone to edit their global
 * PATH before the application will work is exactly the manual step this platform
 * exists to remove.
 *
 * The search order is fixed, so two runs on one machine always resolve the same
 * binary:
 *
 *   1. an explicit path in the environment
 *   2. the PATH, if the bare name resolves there
 *   3. the default install locations for this platform, plus any extra
 *      directories the caller knows about
 *
 * Answering a version probe IS the capability check. A file that exists but
 * cannot run is not a usable tool, and reporting it as one would move the
 * failure to a worse moment.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ProbeSource = 'env' | 'path' | 'install-location';

export interface ExecutableProbe {
  /** The logical tool being looked for, e.g. 'tesseract' or 'antigravity'. */
  tool: string;
  /** Absolute path, or the bare name when the PATH resolved it. */
  command: string | null;
  version: string | null;
  source: ProbeSource | null;
  /** Everything that was tried, so a failure can say where it looked. */
  searched: string[];
}

export const WINDOWS = process.platform === 'win32';
export const EXE_SUFFIX = WINDOWS ? '.exe' : '';

/** Directories a package manager or installer would have used, per platform. */
export function platformInstallDirectories(): string[] {
  if (WINDOWS) {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return [programFiles, programFilesX86, localAppData ? path.join(localAppData, 'Programs') : '']
      .filter((entry) => entry.length > 0);
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  }
  return ['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin'];
}

/**
 * Sub-directories of `roots` whose name matches `pattern`, newest first.
 *
 * Windows tools are routinely installed as `<name>-<version>`, and sorting
 * descending is what makes "pick the newest" a decision rather than a
 * consequence of directory order.
 */
export function versionedDirectories(
  roots: string[],
  pattern: RegExp,
  subPaths: string[],
): string[] {
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const candidate of entries.filter((entry) => pattern.test(entry)).sort().reverse()) {
      for (const sub of subPaths) found.push(path.join(root, candidate, sub));
    }
  }
  return found;
}

/**
 * Ask a candidate for its version.
 *
 * Deliberately tolerant about where the answer appears: plenty of tools print
 * their version to stderr, or exit non-zero while doing it. Output is the
 * signal, not the exit code.
 */
export function versionOf(
  command: string,
  args: string[] = ['--version'],
  timeoutMs = 10_000,
): string | null {
  try {
    const probe = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
    if (probe.error || output.length === 0) return null;
    return output.split(/\r?\n/)[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

export interface FindExecutableInput {
  tool: string;
  /** Executable names to try, in preference order. */
  names: string[];
  /** Environment variable holding an explicit path, checked first. */
  envVar: string;
  versionArgs?: string[];
  /** Directories to search after the platform defaults. */
  extraDirectories?: string[];
  timeoutMs?: number;
}

/**
 * Locate one executable, recording every place it looked so a missing
 * dependency can be reported precisely rather than as a shrug.
 */
export function findExecutable(input: FindExecutableInput): ExecutableProbe {
  const searched: string[] = [];
  const versionArgs = input.versionArgs ?? ['--version'];
  const timeoutMs = input.timeoutMs ?? 10_000;

  const configured = (process.env[input.envVar] ?? '').trim();
  if (configured.length > 0) {
    searched.push(`${input.envVar}=${configured}`);
    const version = versionOf(configured, versionArgs, timeoutMs);
    if (version) {
      return { tool: input.tool, command: configured, version, source: 'env', searched };
    }
    // An explicit setting is authoritative, including when it is wrong. Falling
    // back to some other binary on the PATH would mean the user configured one
    // tool and Brain quietly used another — and the version it reported would
    // not be the version that did the work.
    searched.push(`${input.envVar} is set but did not answer ${versionArgs.join(' ')}; not falling back`);
    return { tool: input.tool, command: null, version: null, source: null, searched };
  }

  for (const name of input.names) {
    const bare = `${name}${EXE_SUFFIX}`;
    searched.push(`PATH: ${bare}`);
    const version = versionOf(bare, versionArgs, timeoutMs);
    if (version) {
      return { tool: input.tool, command: bare, version, source: 'path', searched };
    }
  }

  const directories = [...platformInstallDirectories(), ...(input.extraDirectories ?? [])];
  for (const directory of directories) {
    for (const name of input.names) {
      const candidate = path.join(directory, `${name}${EXE_SUFFIX}`);
      searched.push(candidate);
      if (!fs.existsSync(candidate)) continue;
      const version = versionOf(candidate, versionArgs, timeoutMs);
      if (version) {
        return { tool: input.tool, command: candidate, version, source: 'install-location', searched };
      }
    }
  }

  return { tool: input.tool, command: null, version: null, source: null, searched };
}
