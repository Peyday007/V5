/**
 * The Antigravity connection, as a person would ask about it.
 *
 * Four separate facts sit behind "is it connected": the tool is installed, an
 * account is signed in, this build supports being driven by another program,
 * and there is allowance left to do the work. Collapsing them into one green
 * dot loses exactly the information that tells someone what to do next, so each
 * is reported on its own with the one action that would fix it.
 *
 * The question the page is really answering is the last one: has a real job
 * ever run here? A probe answering a version flag is not that, and this module
 * is careful never to let one look like the other.
 *
 * Nothing here brokers credentials. Signing in happens in the tool's own flow;
 * Brain observes the result and never asks for a password, stores a token, or
 * puts a local path in front of the browser beyond the executable the user
 * chose to install.
 */
import type { AIProvider } from '../../providers/types.ts';
import { getProvider } from '../../providers/index.ts';
import { antigravityStatus, recheckAntigravity } from '../../providers/antigravity/runtime.ts';
import { ptyState } from '../../providers/antigravity/pty.ts';
import {
  clearConnection,
  getConnection,
  recordVerifiedRun,
  saveConnection,
  setModelDefaults,
  setPaidOverage,
} from '../../repos/jobs.ts';
import type { ProviderQuota } from '../../domain/types.ts';

export const ANTIGRAVITY = 'antigravity';

export interface ConnectionView {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  automationReady: boolean;
  quota: ProviderQuota;
  executablePath: string | null;
  version: string | null;
  message: string;
  remediation: string[];
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  /** When a real research job last ran here, which is what "working" means. */
  verifiedRunAt: string | null;
  verifiedRunDetail: string | null;
  models: { light: string | null; strong: string | null };
  paidOverage: { enabled: boolean; note: string | null; setAt: string | null };
  pty: ReturnType<typeof ptyState>;
  /** Sanitized: no credentials, no environment, no raw CLI dump. */
  diagnostics: { stage: string; result: string }[];
}

/**
 * The one thing standing between the user and a working connection.
 *
 * In the order they hit them, so the first unmet condition is the advice.
 */
function remediationFor(input: {
  installed: boolean;
  authenticated: boolean;
  automationReady: boolean;
  quota: ProviderQuota;
  paidOverageEnabled: boolean;
}): string[] {
  if (!input.installed) {
    return [
      'Install Antigravity and make sure its command-line tool is on your PATH.',
      'Then press Detect Antigravity.',
      'Until then research stays manual: copy the prompt, run it wherever you like, and import ' +
        'the report back.',
    ];
  }
  if (!input.authenticated) {
    return [
      'Sign in to Antigravity in the app itself. Brain never asks for your password and never ' +
        'holds your credentials.',
      'Then press Check Authentication.',
    ];
  }
  if (!input.automationReady) {
    return [
      'This build of Antigravity offers no way for another program to run a prompt.',
      "Brain will not drive the app's window on your behalf, so research stays manual until a " +
        'supported command-line mode is available.',
    ];
  }
  if (input.quota.state === 'EXHAUSTED') {
    return input.paidOverageEnabled
      ? ['The allowance is used up. Paid overages are on, so jobs continue and may be charged.']
      : [
          'The allowance is used up. Research pauses and keeps everything it has done.',
          'It resumes when the allowance refreshes. Paid overages are off, and Brain will not ' +
            'spend money unless you turn them on.',
        ];
  }
  return ['Connected. Press Test Connection to run one real job end to end.'];
}

function quotaOf(): ProviderQuota {
  const unknown: ProviderQuota = {
    state: 'UNKNOWN',
    scope: 'UNKNOWN',
    detail: 'This build does not report how much allowance is left.',
    resetsAt: null,
  };
  try {
    return getProvider(ANTIGRAVITY).getStatus().quota ?? unknown;
  } catch {
    return unknown;
  }
}

/** The diagnostic trail, with everything sensitive already gone. */
function diagnosticsFor(): { stage: string; result: string }[] {
  const probe = antigravityStatus();
  return [
    {
      stage: 'Executable',
      result: probe.status.installed
        ? `Found${probe.status.version ? `, version ${probe.status.version}` : ''}.`
        : 'Not found on this machine.',
    },
    {
      stage: 'Authentication',
      result: probe.status.authenticated ? 'An account is signed in.' : 'No account is signed in.',
    },
    {
      stage: 'Automation',
      result: probe.status.automationReady
        ? `Supported${probe.diagnostics.automationCheck ? ` (${probe.diagnostics.automationCheck})` : ''}.`
        : 'This build offers no way for another program to run a prompt.',
    },
    { stage: 'Allowance', result: quotaOf().detail },
    { stage: 'Terminal path', result: ptyState().detail },
  ];
}

/** Read the connection without re-probing. What the page renders on load. */
export async function connectionView(provider = ANTIGRAVITY): Promise<ConnectionView> {
  const probe = antigravityStatus();
  const stored = await getConnection(provider);
  const quota = quotaOf();
  const paidOverageEnabled = stored?.paidOverageEnabled ?? false;

  return {
    provider,
    installed: probe.status.installed,
    authenticated: probe.status.authenticated,
    automationReady: probe.status.automationReady,
    quota,
    // The executable the user chose to install is the one local path worth
    // showing: it is how they tell Brain found the right one.
    executablePath: probe.diagnostics.executable.command,
    version: probe.status.version,
    // Brain's own record wins when it is the more recent of the two: after a
    // disconnect the page should say the connection was forgotten, not repeat
    // what a probe from before it found.
    message:
      stored && stored.message && (stored.lastCheckedAt ?? '') >= probe.status.lastCheckedAt
        ? stored.message
        : probe.status.message,
    remediation: remediationFor({
      installed: probe.status.installed,
      authenticated: probe.status.authenticated,
      automationReady: probe.status.automationReady,
      quota,
      paidOverageEnabled,
    }),
    lastCheckedAt: stored?.lastCheckedAt ?? probe.status.lastCheckedAt,
    lastSuccessAt: stored?.lastSuccessAt ?? null,
    lastFailureAt: stored?.lastFailureAt ?? null,
    lastFailureReason: stored?.lastFailureReason ?? null,
    verifiedRunAt: stored?.verifiedRunAt ?? null,
    verifiedRunDetail: stored?.verifiedRunDetail ?? null,
    models: { light: stored?.lightModel ?? null, strong: stored?.model ?? probe.status.model },
    paidOverage: {
      enabled: paidOverageEnabled,
      note: stored?.paidOverageNote ?? null,
      setAt: stored?.paidOverageSetAt ?? null,
    },
    pty: ptyState(),
    diagnostics: diagnosticsFor(),
  };
}

/** Re-probe and store what was found. Behind Detect and Check Authentication. */
export async function detectConnection(provider = ANTIGRAVITY): Promise<ConnectionView> {
  const probe = recheckAntigravity();
  await saveConnection({
    provider,
    installed: probe.status.installed,
    authenticated: probe.status.authenticated,
    automationReady: probe.status.automationReady,
    executablePath: probe.diagnostics.executable.command,
    version: probe.status.version,
    model: (await getConnection(provider))?.model ?? probe.status.model,
    quotaState: probe.status.quotaState,
    message: probe.status.message,
    diagnostics: diagnosticsFor(),
  });
  return connectionView(provider);
}

export interface TestConnectionResult {
  ok: boolean;
  detail: string;
  durationMs: number;
  connection: ConnectionView;
}

/**
 * Run one real job end to end.
 *
 * Deliberately trivial: the point is not what the tool says but that it
 * started, produced output and exited — the three things a probe cannot tell
 * you. A passing test is the only thing that makes this connection verified,
 * and a placeholder provider can never pass it.
 */
export async function testConnection(
  input: { provider?: string; worker?: AIProvider } = {},
): Promise<TestConnectionResult> {
  const provider = input.provider ?? ANTIGRAVITY;
  const startedAt = Date.now();

  let worker: AIProvider;
  try {
    worker = input.worker ?? getProvider(provider);
  } catch (error) {
    return failed(provider, error instanceof Error ? error.message : String(error), startedAt);
  }

  const status = worker.getStatus();
  if (status.placeholder === true) {
    // The mock is always available, which is what lets Brain boot with no
    // credentials. It is not a research worker, and a test it "passed" would be
    // the most misleading thing this page could say.
    return failed(
      provider,
      'This provider returns placeholder content rather than research, so a connection test would ' +
        'prove nothing. Connect the real tool first.',
      startedAt,
    );
  }

  try {
    const response = await worker.runResearch(
      {
        prompt:
          'Reply with exactly this JSON and nothing else: {"ok": true, "check": "brain-connection-test"}',
        requiredAttachments: [],
        expectedConversationTitle: 'Brain connection test',
        expectedFilename: 'connection-test.json',
      },
      { runId: 'connection-test' },
    );

    const text = (response.text ?? '').trim();
    if (text.length === 0) {
      throw new Error(
        'The tool exited without producing any output, which is what a stalled run looks like.',
      );
    }

    const detail =
      `The tool ran a real job and returned ${Buffer.byteLength(text)} bytes in ` +
      `${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s.`;
    await saveConnection({
      provider,
      installed: true,
      authenticated: true,
      automationReady: true,
      version: antigravityStatus().status.version,
      model: response.model ?? (await getConnection(provider))?.model ?? null,
      message: detail,
      diagnostics: diagnosticsFor(),
      succeeded: true,
    });
    await recordVerifiedRun(provider, detail);
    return { ok: true, detail, durationMs: Date.now() - startedAt, connection: await connectionView(provider) };
  } catch (error) {
    return failed(provider, error instanceof Error ? error.message : String(error), startedAt);
  }
}

/** A failed test is recorded as carefully as a successful one. */
async function failed(provider: string, detail: string, startedAt: number): Promise<TestConnectionResult> {
  const probe = antigravityStatus();
  await saveConnection({
    provider,
    installed: probe.status.installed,
    authenticated: probe.status.authenticated,
    automationReady: probe.status.automationReady,
    diagnostics: diagnosticsFor(),
    succeeded: false,
    failureReason: detail,
  });
  return { ok: false, detail, durationMs: Date.now() - startedAt, connection: await connectionView(provider) };
}

/** Forget the connection. The tool itself is untouched. */
export async function disconnect(provider = ANTIGRAVITY): Promise<ConnectionView> {
  await clearConnection(provider);
  return connectionView(provider);
}

export async function updateModelDefaults(
  provider: string,
  models: { light: string | null; strong: string | null },
): Promise<ConnectionView> {
  await setModelDefaults(provider, models);
  return connectionView(provider);
}

/**
 * Turn paid overages on or off.
 *
 * Always the user's own act, always recorded with when and why. Nothing in the
 * platform sets this on their behalf, and it is the only thing that lets a run
 * continue past an exhausted allowance.
 */
export async function updatePaidOverage(
  provider: string,
  enabled: boolean,
  note: string | null,
): Promise<ConnectionView> {
  await setPaidOverage(provider, enabled, note);
  return connectionView(provider);
}

/** The model defaults the orchestration should use for this provider. */
export async function modelDefaults(provider = ANTIGRAVITY): Promise<{ light: string | null; strong: string | null }> {
  const stored = await getConnection(provider);
  return {
    light: stored?.lightModel ?? process.env['BRAIN_ANTIGRAVITY_LIGHT_MODEL'] ?? null,
    strong: stored?.model ?? null,
  };
}
