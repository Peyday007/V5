/**
 * Finding out what Antigravity can actually do on this machine (section 1).
 *
 * The whole point of this module is that it assumes nothing. Having the desktop
 * IDE installed does not mean the automation executable is present; having the
 * executable does not mean the user is signed in; being signed in does not mean
 * a non-interactive run is supported, and none of that means there is quota left
 * to do the work. Those are four separate facts and Brain reports them
 * separately, because "it doesn't work" is not an actionable thing to tell
 * somebody.
 *
 * Everything here is a short, read-only probe with a hard timeout. It never
 * starts a research job, never opens the IDE, and never asks for a password:
 * signing in is something the user does in Google's own flow, not something
 * Brain brokers.
 *
 * If the probe cannot establish a supported non-interactive interface, that is a
 * reported blocker — not a reason to quietly use a different provider.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findExecutable,
  platformInstallDirectories,
  versionedDirectories,
  WINDOWS,
  type ExecutableProbe,
} from '../../services/exec/discovery.ts';
import type { ProviderQuota, QuotaScope, QuotaState as QuotaStateName } from '../../domain/types.ts';

/** How much of the user's allowance is left, as far as the CLI will say. */
export type QuotaState = 'available' | 'limited' | 'exhausted' | 'unknown';

/**
 * The status contract the UI and `GET /api/providers/status` are built on.
 *
 * Deliberately four booleans rather than one: each maps to a different thing the
 * user would have to do next, and collapsing them would lose exactly the
 * information that makes the setup card useful.
 */
export interface AntigravityStatus {
  provider: 'antigravity';
  /** The automation executable was found and answered a version probe. */
  installed: boolean;
  /** A Google account is connected. */
  authenticated: boolean;
  /** A non-interactive run is supported by this build. */
  automationReady: boolean;
  version: string | null;
  model: string | null;
  quotaState: QuotaState;
  lastCheckedAt: string;
  /** The single next action, phrased for someone who is not a developer. */
  message: string;
}

/** Everything the probe learned, including what must not reach the browser. */
export interface AntigravityProbe {
  status: AntigravityStatus;
  /** Local paths and raw CLI output. Server-side diagnostics only. */
  diagnostics: {
    executable: ExecutableProbe;
    /** Which sub-command answered, so a CLI change is visible in the logs. */
    automationCheck: string | null;
    rawExcerpt: string | null;
  };
}

/**
 * Command names to try, in preference order.
 *
 * `agy` is the documented one. The others are the names the same tool has
 * shipped under; trying them costs one failed spawn each and saves a user whose
 * install differs from the documentation.
 */
const COMMAND_NAMES = ['agy', 'antigravity'];

/** Ceiling for any single probe command. */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * Ceiling for the whole probe.
 *
 * Per-command timeouts alone are not enough: five sub-commands that each hang
 * for eight seconds is a forty-second wait behind a status chip, which is not a
 * "short health probe" by any reading. Once the budget is gone the probe stops
 * asking and reports what it already knows.
 */
const PROBE_BUDGET_MS = 12_000;

/** Where the desktop IDE puts its command-line companion, beyond the defaults. */
function installDirectories(): string[] {
  if (WINDOWS) {
    const roots = platformInstallDirectories();
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return [
      ...roots.map((root) => path.join(root, 'Antigravity')),
      ...roots.map((root) => path.join(root, 'Antigravity', 'bin')),
      ...roots.map((root) => path.join(root, 'Google', 'Antigravity', 'bin')),
      localAppData ? path.join(localAppData, 'Programs', 'Antigravity', 'bin') : '',
      ...versionedDirectories(
        [process.env['ProgramFiles'] ?? 'C:\\Program Files'],
        /^Antigravity[-_ ]/i,
        ['bin', '.'],
      ),
    ].filter((entry) => entry.length > 0);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Antigravity.app/Contents/Resources/app/bin',
      path.join(process.env['HOME'] ?? '', '.antigravity', 'bin'),
    ];
  }
  return [
    '/opt/antigravity/bin',
    '/usr/share/antigravity/bin',
    path.join(process.env['HOME'] ?? '', '.antigravity', 'bin'),
  ];
}

interface RunResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
  /** Set when the overall budget ran out before this command was attempted. */
  skipped: boolean;
}

/** Tracks what is left of the overall probe budget. */
class Budget {
  #deadline: number;

  constructor(ms: number) {
    this.#deadline = Date.now() + ms;
  }

  get remaining(): number {
    return this.#deadline - Date.now();
  }

  /** How long the next command may take, or 0 when there is no time left. */
  slice(): number {
    return Math.max(0, Math.min(PROBE_TIMEOUT_MS, this.remaining));
  }
}

/**
 * Run one read-only probe command.
 *
 * Argument arrays with no shell, always: a command assembled by string
 * interpolation is an injection waiting for a filename with a quote in it.
 */
function probe(command: string, args: string[], budget: Budget): RunResult {
  const timeout = budget.slice();
  if (timeout <= 0) return { ok: false, output: '', timedOut: false, skipped: true };
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    shell: false,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return {
    ok: !result.error && result.status === 0,
    output,
    timedOut: result.error !== undefined && /ETIMEDOUT|timed? ?out/i.test(String(result.error)),
    skipped: false,
  };
}

/** Sub-commands that would report sign-in state, tried in order. */
const AUTH_PROBES: string[][] = [
  ['auth', 'status'],
  ['account', 'status'],
  ['whoami'],
];

/** Sub-commands that prove a non-interactive run is supported. */
const AUTOMATION_PROBES: string[][] = [
  ['--help'],
  ['help'],
];

/** Wording that means "signed out" wherever it appears in CLI output. */
const SIGNED_OUT = /\b(not (logged|signed) ?in|unauthenticated|no (active )?account|please (log|sign) ?in|login required)\b/i;
const SIGNED_IN = /\b(logged ?in|signed ?in|authenticated|active account|account:)\b/i;

/** Flags whose presence in help output means a prompt can be run head-less. */
const NON_INTERACTIVE_FLAGS = /(--non-?interactive|--headless|--prompt\b|--input\b|--stdin\b|\brun\b|\bexec\b)/i;

const QUOTA_EXHAUSTED = /\b(quota (exceeded|exhausted)|out of quota|limit reached|rate ?limit)\b/i;
const QUOTA_LIMITED = /\b(quota (low|limited)|approaching (the )?limit|remaining: ?[0-9]+)\b/i;

function readQuota(text: string): QuotaState {
  if (QUOTA_EXHAUSTED.test(text)) return 'exhausted';
  if (QUOTA_LIMITED.test(text)) return 'limited';
  return 'unknown';
}

/** Whose allowance ran out: the tool's own models, or a third party's. */
const THIRD_PARTY_MODEL = /\b(claude|anthropic|gpt-?[0-9]|openai|byok|third[- ]party)\b/i;
const GEMINI_MODEL = /\bgemini\b/i;
/** "resets at 14:00 UTC", "try again in 3 hours", "resets tomorrow". */
const QUOTA_RESET = /\b(?:resets?|available again|try again)\s+(?:at|in|on)?\s*([^\n.;]{3,40})/i;

/**
 * The quota, phrased for a person.
 *
 * The CLI's own wording is not shown: it is unstable across versions and often
 * a raw API error. What the user needs is which allowance is gone and whether
 * waiting will fix it.
 */
export function readQuotaDetail(text: string): ProviderQuota {
  const state = readQuota(text);
  const scope: QuotaScope = THIRD_PARTY_MODEL.test(text)
    ? 'THIRD_PARTY'
    : GEMINI_MODEL.test(text)
      ? 'GEMINI'
      : 'UNKNOWN';
  const reset = QUOTA_RESET.exec(text)?.[1]?.trim() ?? null;

  const mapped: QuotaStateName =
    state === 'exhausted' ? 'EXHAUSTED' : state === 'limited' ? 'LIMITED' : 'UNKNOWN';

  const detail =
    mapped === 'EXHAUSTED'
      ? scope === 'THIRD_PARTY'
        ? 'The third-party model allowance is used up for now.'
        : scope === 'GEMINI'
          ? 'The Gemini allowance is used up for now.'
          : 'The model allowance is used up for now.'
      : mapped === 'LIMITED'
        ? 'The allowance is running low, so long runs may not finish in one sitting.'
        : 'This build does not report how much allowance is left.';

  return { state: mapped, scope, detail, resetsAt: reset };
}

/** Keep raw CLI output out of the browser, but keep enough to diagnose. */
function excerpt(text: string | null): string | null {
  if (!text) return null;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function status(
  partial: Omit<AntigravityStatus, 'provider' | 'lastCheckedAt'>,
): AntigravityStatus {
  return { provider: 'antigravity', lastCheckedAt: new Date().toISOString(), ...partial };
}

/**
 * Probe the machine and describe what Antigravity can do here.
 *
 * Never throws. A probe that blows up is a provider that is unavailable, and
 * saying so is more useful than a stack trace reaching the import screen.
 */
export function probeAntigravity(): AntigravityProbe {
  const disabled = (process.env['BRAIN_ANTIGRAVITY'] ?? '').toLowerCase() === 'none';
  const empty: ExecutableProbe = {
    tool: 'antigravity',
    command: null,
    version: null,
    source: null,
    searched: [],
  };

  if (disabled) {
    return {
      status: status({
        installed: false,
        authenticated: false,
        automationReady: false,
        version: null,
        model: null,
        quotaState: 'unknown',
        message:
          'Antigravity is switched off for this instance (BRAIN_ANTIGRAVITY=none). Research runs ' +
          'stay manual: copy the prompt, run it wherever you like, and import the report back.',
      }),
      diagnostics: { executable: empty, automationCheck: null, rawExcerpt: null },
    };
  }

  const budget = new Budget(PROBE_BUDGET_MS);
  let executable: ExecutableProbe;
  try {
    executable = findExecutable({
      tool: 'antigravity',
      names: COMMAND_NAMES,
      envVar: 'BRAIN_ANTIGRAVITY_PATH',
      versionArgs: ['--version'],
      extraDirectories: installDirectories(),
      timeoutMs: budget.slice(),
    });
  } catch {
    executable = empty;
  }

  if (!executable.command) {
    return {
      status: status({
        installed: false,
        authenticated: false,
        automationReady: false,
        version: null,
        model: null,
        quotaState: 'unknown',
        message:
          'Antigravity is not installed on this computer, so Brain cannot run research for you ' +
          'yet. Install it, then use Check connection. Until then, research stays manual: copy ' +
          'the prompt, run it wherever you like, and import the report back.',
      }),
      diagnostics: { executable, automationCheck: null, rawExcerpt: null },
    };
  }

  // Installed. Can it be driven without a person clicking in the IDE?
  let automationReady = false;
  let automationCheck: string | null = null;
  let helpText = '';
  for (const args of AUTOMATION_PROBES) {
    const result = probe(executable.command, args, budget);
    if (result.skipped) break;
    if (!result.ok || result.output.length === 0) continue;
    helpText = result.output;
    automationCheck = args.join(' ');
    automationReady = NON_INTERACTIVE_FLAGS.test(result.output);
    break;
  }

  // Signed in? Absence of evidence is not evidence of absence: a CLI with no
  // auth sub-command leaves this unknown, and unknown is reported as not yet
  // confirmed rather than guessed either way.
  let authenticated = false;
  let authText = '';
  for (const args of AUTH_PROBES) {
    const result = probe(executable.command, args, budget);
    if (result.skipped) break;
    if (result.output.length === 0) continue;
    authText = result.output;
    if (SIGNED_OUT.test(result.output)) {
      authenticated = false;
      break;
    }
    if (result.ok && SIGNED_IN.test(result.output)) {
      authenticated = true;
      break;
    }
  }

  const quotaState = readQuota(`${authText}\n${helpText}`);
  const rawExcerpt = excerpt([authText, helpText].filter(Boolean).join('\n---\n') || null);

  if (!automationReady) {
    return {
      status: status({
        installed: true,
        authenticated,
        automationReady: false,
        version: executable.version,
        model: null,
        quotaState,
        message:
          'Antigravity is installed, but this build does not offer a way to run it automatically ' +
          'from another program. Brain will not drive the app’s window on your behalf, so research ' +
          'stays manual until a supported command-line mode is available.',
      }),
      diagnostics: { executable, automationCheck, rawExcerpt },
    };
  }

  if (!authenticated) {
    return {
      status: status({
        installed: true,
        authenticated: false,
        automationReady: true,
        version: executable.version,
        model: null,
        quotaState,
        message:
          'Antigravity is installed but no Google account is connected. Open Antigravity, sign in ' +
          'there, then come back and use Check connection. Brain never asks for your password.',
      }),
      diagnostics: { executable, automationCheck, rawExcerpt },
    };
  }

  if (quotaState === 'exhausted') {
    return {
      status: status({
        installed: true,
        authenticated: true,
        automationReady: true,
        version: executable.version,
        model: null,
        quotaState,
        message:
          'Antigravity is connected but its allowance is used up for now. Research runs will fail ' +
          'until it resets — Brain will say so rather than quietly producing a weaker answer.',
      }),
      diagnostics: { executable, automationCheck, rawExcerpt },
    };
  }

  // Connected is not the same as proven. The CLI declaring a non-interactive
  // mode in its help text is what has been established here; whether a run
  // actually returns when it is spawned with a pipe on stdout is a separate
  // fact, and one known to fail on some builds. Claiming "ready" would be
  // promising something this probe has not checked.
  return {
    status: status({
      installed: true,
      authenticated: true,
      automationReady: true,
      version: executable.version,
      model: null,
      quotaState,
      message:
        `Antigravity is connected (${executable.version ?? 'version unknown'}) and offers an ` +
        'automatic mode. Brain has not run a research job through it yet — the first Run Research ' +
        'will confirm it works end to end, and will stop rather than hang if it does not.',
    }),
    diagnostics: { executable, automationCheck, rawExcerpt },
  };
}

let cached: AntigravityProbe | null = null;

/** The probe result, kept until someone asks for a fresh one. */
export function antigravityStatus(): AntigravityProbe {
  if (!cached) cached = probeAntigravity();
  return cached;
}

/** What the Check connection button does. */
export function recheckAntigravity(): AntigravityProbe {
  cached = probeAntigravity();
  return cached;
}

/** Test seam: drop the cached probe, or install a specific result. */
export function setAntigravityProbe(value: AntigravityProbe | null): void {
  cached = value;
}
