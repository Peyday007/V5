/**
 * Running the CLI behind a terminal, when nothing else works.
 *
 * `agy -p` stalls on the user's Windows installation when its stdout is a pipe
 * rather than a terminal (antigravity-cli issue #318). The tool is waiting for a
 * console that is not there, and no amount of flags makes it stop — so the only
 * remaining option is to give it one.
 *
 * This is deliberately not the default and never becomes the default on its own.
 * A pseudo-terminal is a second way to start an external program, and a second
 * way to start a program is a second thing to get wrong; it is switched on by an
 * explicit configuration flag, by someone who has seen the stall.
 *
 * What it does not change: arguments are still an array, the prompt still goes
 * over stdin and never onto a command line, the timeout still applies, the
 * cancellation still applies, the process tree is still killed as a tree, and
 * the workspace is still the job's own directory. The terminal is the only
 * difference.
 *
 * No native module is involved. Brain drives a PTY helper the machine already
 * has — `winpty` on Windows, `script` elsewhere — or one the user names.
 */
import { spawnSync } from 'node:child_process';
import { WINDOWS } from '../../services/exec/discovery.ts';

export type PtyHelperKind = 'custom' | 'winpty' | 'script-linux' | 'script-bsd';

export interface PtyHelper {
  kind: PtyHelperKind;
  command: string;
  /** What the user would see on the settings page. */
  description: string;
}

export interface PtyPlan {
  command: string;
  args: string[];
  helper: PtyHelper;
}

/** The explicit switch. Nothing else turns this on. */
export function ptyEnabled(): boolean {
  const raw = (process.env['BRAIN_ANTIGRAVITY_PTY'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Does this command exist on this machine? A one-shot, bounded probe. */
function present(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      timeout: 4_000,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
    });
    return !result.error;
  } catch {
    return false;
  }
}

/**
 * Which PTY helper this machine can offer.
 *
 * A helper the user named explicitly wins, because they know their machine
 * better than a probe does.
 */
export function ptyHelper(): PtyHelper | null {
  const named = (process.env['BRAIN_ANTIGRAVITY_PTY_COMMAND'] ?? '').trim();
  if (named.length > 0) {
    return {
      kind: 'custom',
      command: named,
      description: `The pseudo-terminal helper you configured (${named}).`,
    };
  }

  if (WINDOWS) {
    if (present('winpty', ['--version'])) {
      return {
        kind: 'winpty',
        command: 'winpty',
        description: 'winpty, which gives the tool a console so it does not wait for one.',
      };
    }
    return null;
  }

  if (present('script', ['--version'])) {
    return process.platform === 'darwin'
      ? { kind: 'script-bsd', command: 'script', description: 'script(1), running the tool under a terminal.' }
      : { kind: 'script-linux', command: 'script', description: 'script(1), running the tool under a terminal.' };
  }
  return null;
}

/**
 * Quote one argument for the single helper that needs a command string.
 *
 * util-linux `script` takes `--command "…"` rather than an argument array, so
 * exactly one code path has to build a string. Only values Brain itself chose
 * are ever quoted here — the executable it discovered and the flags it decided
 * on. The prompt is not among them: it goes over stdin, as it does on every
 * other path.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a command so it runs attached to a terminal.
 *
 * Returns null when the PTY path is off or no helper exists, and the caller
 * runs the ordinary way — a missing helper is a reason to report a blocker,
 * never a reason to fail silently.
 */
export function wrapInPty(command: string, args: string[]): PtyPlan | null {
  if (!ptyEnabled()) return null;
  const helper = ptyHelper();
  if (!helper) return null;

  switch (helper.kind) {
    case 'winpty':
      // -Xallow-non-tty: Brain's own stdio is a pipe, which is the whole point.
      return { command: helper.command, args: ['-Xallow-non-tty', '-Xplain', command, ...args], helper };
    case 'script-bsd':
      return { command: helper.command, args: ['-q', '/dev/null', command, ...args], helper };
    case 'script-linux':
      return {
        command: helper.command,
        args: [
          '--quiet',
          // Return the child's exit status rather than script's own.
          '--return',
          '--command',
          [command, ...args].map(quote).join(' '),
          '/dev/null',
        ],
        helper,
      };
    default:
      return { command: helper.command, args: [command, ...args], helper };
  }
}

/** What to tell the user about this path on the settings page. */
export function ptyState(): {
  enabled: boolean;
  available: boolean;
  helper: string | null;
  detail: string;
} {
  const enabled = ptyEnabled();
  const helper = enabled ? ptyHelper() : null;
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      helper: null,
      detail:
        'Off. Brain runs the tool the ordinary way. Turn this on only if research jobs hang with ' +
        'no output — some builds wait for a terminal that is not there.',
    };
  }
  if (!helper) {
    return {
      enabled: true,
      available: false,
      helper: null,
      detail:
        'On, but no pseudo-terminal helper was found on this machine. Install winpty (Windows) or ' +
        'name one in BRAIN_ANTIGRAVITY_PTY_COMMAND, or switch this off — as it stands, jobs run ' +
        'the ordinary way.',
    };
  }
  return {
    enabled: true,
    available: true,
    helper: helper.command,
    detail: `On, using ${helper.description} The timeout, cancellation and output limits are unchanged.`,
  };
}
