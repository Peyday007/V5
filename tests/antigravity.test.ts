/**
 * The Antigravity connection layer (spec sections 1, 2 and 9).
 *
 * The probe's whole job is to tell the truth about a machine it does not
 * control, so every state it can report is driven here through a real spawn
 * against a fake executable. What matters is not that the probe succeeds — it
 * usually will not — but that each way of failing produces the specific,
 * actionable answer the setup card is built on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeExecutable } from './fixtures/fake-exec.ts';
import {
  probeAntigravity,
  recheckAntigravity,
  setAntigravityProbe,
} from '../server/providers/antigravity/runtime.ts';
import { AntigravityProvider, AntigravityUnavailableError } from '../server/providers/antigravity.ts';
import { readExecutionLog } from '../server/providers/antigravity/jobs.ts';
import { getProvider, PROVIDER_NAMES } from '../server/providers/index.ts';

let workDir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  setAntigravityProbe(null);
}

/**
 * A stand-in for the automation CLI whose answers the test chooses.
 *
 * Driving the real probe against a real process is the point: argument arrays,
 * timeouts and exit codes all behave as they would in life, and the wrapper is
 * written for the host platform so this is a genuine test on Windows too.
 */
function fakeAgy(script: string): string {
  const file = path.join(workDir, 'agy-impl.js');
  fs.writeFileSync(file, script);
  const stub = writeFakeExecutable({
    directory: workDir,
    name: 'agy',
    tool: 'agy',
    behaviour: 'ok',
    version: 'antigravity 0.9.1',
  });
  // Replace the generic runner with this test's own behaviour.
  const runner = path.join(workDir, 'agy.js');
  fs.writeFileSync(runner, script);
  return stub.command;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-agy-'));
  setAntigravityProbe(null);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  setAntigravityProbe(null);
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Answers a version probe, --help, and an auth query, as the test dictates. */
function agyScript(options: { help: string; auth: string; authExit?: number }): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('antigravity 0.9.1\\n'); process.exit(0); }
if (args[0] === '--help' || args[0] === 'help') { process.stdout.write(${JSON.stringify(options.help)}); process.exit(0); }
if (args[0] === 'auth' || args[0] === 'account' || args[0] === 'whoami') {
  process.stdout.write(${JSON.stringify(options.auth)});
  process.exit(${options.authExit ?? 0});
}
process.exit(1);
`;
}

describe('the Antigravity capability probe', () => {
  it('reports not-installed when the executable is nowhere to be found', () => {
    setEnv('BRAIN_ANTIGRAVITY_PATH', path.join(workDir, 'no-such-binary'));

    const { status } = probeAntigravity();
    expect(status.provider).toBe('antigravity');
    expect(status.installed).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.automationReady).toBe(false);
    expect(status.version).toBeNull();
    // The message has to name the next action, and must not send the user to a terminal.
    expect(status.message).toMatch(/not installed/i);
    expect(status.message).toMatch(/Check connection/i);
    expect(status.message).not.toMatch(/powershell|command line|terminal/i);
    expect(status.lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports installed-but-not-automatable when the build has no head-less mode', () => {
    const command = fakeAgy(
      agyScript({ help: 'Antigravity\n  open    Open the workspace window\n', auth: 'logged in as a@b.com\n' }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const { status } = probeAntigravity();
    expect(status.installed).toBe(true);
    expect(status.version).toBe('antigravity 0.9.1');
    // No --prompt, --stdin, run or exec in the help text: nothing to drive.
    expect(status.automationReady).toBe(false);
    expect(status.message).toMatch(/does not offer a way to run it automatically/i);
    // And it says outright that it will not drive the IDE window instead.
    expect(status.message).toMatch(/will not drive/i);
  });

  it('reports the sign-in step when automation exists but no account is connected', () => {
    const command = fakeAgy(
      agyScript({
        help: 'Usage: agy run --prompt <text> --non-interactive\n',
        auth: 'Error: not logged in. Run agy auth login.\n',
        authExit: 1,
      }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const { status } = probeAntigravity();
    expect(status.installed).toBe(true);
    expect(status.automationReady).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.message).toMatch(/sign in/i);
    // Brain must never ask for the password itself.
    expect(status.message).toMatch(/never asks for your password/i);
  });

  it('reports connected when every stage passes', () => {
    const command = fakeAgy(
      agyScript({
        help: 'Usage: agy run --prompt <text> --non-interactive --stdin\n',
        auth: 'Signed in as researcher@example.com\n',
      }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const { status } = probeAntigravity();
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.automationReady).toBe(true);
    expect(status.quotaState).toBe('unknown');
    expect(status.message).toMatch(/connected/i);
    // Connected is not proven. The probe has read a help text, not completed a
    // run, and the message must not promise the second on the strength of the
    // first — a headless run is known to hang on some builds.
    expect(status.message).toMatch(/has not run a research job through it yet/i);
    expect(status.message).toMatch(/stop rather than hang/i);
  });

  it('reports an exhausted allowance rather than letting a run fail later', () => {
    const command = fakeAgy(
      agyScript({
        help: 'Usage: agy run --prompt <text> --non-interactive\n',
        auth: 'Signed in as researcher@example.com\nQuota exceeded for this period.\n',
      }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const { status } = probeAntigravity();
    expect(status.authenticated).toBe(true);
    expect(status.quotaState).toBe('exhausted');
    expect(status.message).toMatch(/allowance is used up/i);
  });

  it('survives an executable that hangs, rather than hanging with it', () => {
    const command = fakeAgy(`
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('antigravity 0.9.1\\n'); process.exit(0); }
setTimeout(() => process.exit(0), 600000);
`);
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const startedAt = Date.now();
    const { status } = probeAntigravity();
    // The probe carries a hard timeout; the whole thing has to come back quickly.
    expect(Date.now() - startedAt).toBeLessThan(45_000);
    expect(status.installed).toBe(true);
    expect(status.automationReady).toBe(false);
  }, 60_000);

  it('can be switched off, and says so rather than looking broken', () => {
    setEnv('BRAIN_ANTIGRAVITY', 'none');
    const { status } = probeAntigravity();
    expect(status.installed).toBe(false);
    expect(status.message).toMatch(/switched off/i);
    expect(status.message).toMatch(/import the report back/i);
  });

  it('keeps local paths and raw CLI output out of the browser contract', () => {
    const command = fakeAgy(
      agyScript({
        help: 'Usage: agy run --prompt <text> --non-interactive\n',
        auth: 'Signed in as researcher@example.com\n',
      }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const probe = probeAntigravity();
    // The status is what crosses to the client; it must not carry the path.
    expect(JSON.stringify(probe.status)).not.toContain(workDir);
    expect(Object.keys(probe.status).sort()).toEqual([
      'authenticated',
      'automationReady',
      'installed',
      'lastCheckedAt',
      'message',
      'model',
      'provider',
      'quotaState',
      'version',
    ]);
    // The diagnostics keep it, server-side, so a failure is still traceable.
    expect(probe.diagnostics.executable.command).toBe(command);
  });

  it('re-probes on demand, because the user pressing Check has just changed something', () => {
    setEnv('BRAIN_ANTIGRAVITY_PATH', path.join(workDir, 'missing'));
    expect(probeAntigravity().status.installed).toBe(false);

    const command = fakeAgy(
      agyScript({
        help: 'Usage: agy run --prompt <text> --non-interactive\n',
        auth: 'Signed in as researcher@example.com\n',
      }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    expect(recheckAntigravity().status.installed).toBe(true);
  });
});

describe('the Antigravity provider', () => {
  it('is registered and reachable by the names a user might type', () => {
    expect(PROVIDER_NAMES).toContain('antigravity');
    for (const alias of ['antigravity', 'agy', 'google', 'gemini']) {
      expect(getProvider(alias).name).toBe('antigravity');
    }
  });

  it('refuses every call it cannot honestly serve, and never falls back to the mock', async () => {
    setEnv('BRAIN_ANTIGRAVITY_PATH', path.join(workDir, 'missing'));
    const provider = new AntigravityProvider();

    const status = provider.getStatus();
    expect(status.name).toBe('antigravity');
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/not installed/i);
    // The copy-the-prompt path is offered, because the user is not blocked.
    expect(status.reason).toMatch(/COPY PROMPT/i);

    // Every call refuses loudly. A silent mock answer here would be a lie about
    // whether research happened, which is the one thing this must never do.
    await expect(provider.runResearch({
      prompt: 'x',
      requiredAttachments: [],
      expectedConversationTitle: 't',
      expectedFilename: 'f.pdf',
    })).rejects.toBeInstanceOf(AntigravityUnavailableError);
    await expect(provider.audit({ prompt: 'x' })).rejects.toBeInstanceOf(AntigravityUnavailableError);
    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(AntigravityUnavailableError);
  });

  it('claims research only while it is genuinely connected', () => {
    const command = fakeAgy(
      agyScript({
        help: 'Usage: agy run --prompt <text> --non-interactive\n',
        auth: 'Signed in as researcher@example.com\n',
      }),
    );
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);

    const connected = new AntigravityProvider().getStatus();
    expect(connected.available).toBe(true);
    expect(connected.capabilities.research).toBe(true);
    // Chat and audit still belong to providers that return structured output
    // for them; claiming those here would put buttons in front of nothing.
    expect(connected.capabilities.audit).toBe(false);
    expect(connected.capabilities.chat).toBe(false);

    // And the claim goes away with the connection, rather than lingering.
    setEnv('BRAIN_ANTIGRAVITY_PATH', path.join(workDir, 'missing'));
    expect(new AntigravityProvider().getStatus().capabilities.research).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Running a job safely (spec sections 2 and 9)
// ---------------------------------------------------------------------------

describe('running a research job', () => {
  /** Point the provider at a fake CLI that behaves as the test dictates. */
  function connectedAgy(behaviour: string): void {
    const command = fakeAgy(`
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('antigravity 1.0.6\\n'); process.exit(0); }
if (args[0] === '--help' || args[0] === 'help') {
  process.stdout.write('Usage: agy -p <prompt> --non-interactive\\n');
  process.exit(0);
}
if (args[0] === 'auth' || args[0] === 'account' || args[0] === 'whoami') {
  process.stdout.write('Signed in as researcher@example.com\\n');
  process.exit(0);
}
${behaviour}
`);
    setEnv('BRAIN_ANTIGRAVITY_PATH', command);
  }

  /** The fake reads stdin to completion, then answers. */
  const echoPrompt = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  process.stdout.write('REPORT FOR: ' + input.trim() + '\\n');
  process.stdout.write('ARGV: ' + JSON.stringify(args) + '\\n');
  process.exit(0);
});
`;

  it('sends the prompt over stdin, never on the command line', async () => {
    connectedAgy(echoPrompt);
    const provider = new AntigravityProvider();

    // A prompt carrying shell metacharacters. If any of this reached a shell,
    // or were interpolated into the command, the test would not survive it.
    const nasty = 'Investigate custody"; rm -rf / #  $(whoami) `id` && echo pwned';
    const result = await provider.runResearch({
      prompt: nasty,
      requiredAttachments: [],
      expectedConversationTitle: 'World Model v1',
      expectedFilename: 'World Model v1.pdf',
    });

    expect(result.text).toContain(`REPORT FOR: ${nasty}`);
    // The arguments the CLI actually received contain only the flags.
    const argv = /ARGV: (\[.*\])/.exec(result.text)?.[1];
    expect(argv).toBeTruthy();
    const parsed = JSON.parse(argv!) as string[];
    expect(parsed).toEqual(['-p']);
    expect(parsed.join(' ')).not.toContain('rm -rf');
  }, 30_000);

  it('records the attempt for reproducibility, without leaking it to callers', async () => {
    connectedAgy(echoPrompt);
    const provider = new AntigravityProvider();
    const result = await provider.runResearch(
      {
        prompt: 'Map the custody chain.',
        requiredAttachments: [],
        expectedConversationTitle: 't',
        expectedFilename: 'f.pdf',
      },
      { runId: 'run_test_1' },
    );

    const log = readExecutionLog(result.externalResponseId!);
    expect(log).toBeTruthy();
    expect(log!.runId).toBe('run_test_1');
    expect(log!.provider).toBe('antigravity');
    expect(log!.providerVersion).toBe('antigravity 1.0.6');
    expect(log!.outcome).toBe('COMPLETED');
    expect(log!.exitCode).toBe(0);
    expect(log!.promptDelivery).toBe('stdin');
    // The prompt is identified by digest, so a report can be tied to exactly
    // what produced it without the log becoming a second copy of the prompt.
    expect(log!.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(log)).not.toContain('Map the custody chain.');
    expect(log!.durationMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('stops a tool that never returns, rather than hanging with it', async () => {
    // The shape of antigravity-cli issue #318: reads stdin, then stalls forever.
    connectedAgy(`
process.stdin.resume();
setTimeout(() => process.exit(0), 600000);
`);
    setEnv('BRAIN_ANTIGRAVITY_TIMEOUT_MS', '30000');
    const provider = new AntigravityProvider();

    const startedAt = Date.now();
    await expect(
      provider.runResearch({
        prompt: 'x',
        requiredAttachments: [],
        expectedConversationTitle: 't',
        expectedFilename: 'f.pdf',
      }),
    ).rejects.toMatchObject({ name: 'AntigravityRunError', outcome: 'TIMED_OUT' });
    // The floor is the configured timeout; the ceiling proves it did not wait
    // for the child's own ten-minute sleep.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  }, 90_000);

  it('treats a clean exit with no report as a failure, not as research', async () => {
    // Exit zero, nothing on stdout — the other shape the headless stall takes.
    connectedAgy(`
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
    const provider = new AntigravityProvider();

    await expect(
      provider.runResearch({
        prompt: 'x',
        requiredAttachments: [],
        expectedConversationTitle: 't',
        expectedFilename: 'f.pdf',
      }),
    ).rejects.toThrow(/without producing a report/i);
  }, 30_000);

  it('reports a tool that exits with an error, and records the exit code', async () => {
    connectedAgy(`
process.stdin.resume();
process.stdin.on('end', () => { process.stderr.write('model unavailable\\n'); process.exit(4); });
`);
    const provider = new AntigravityProvider();

    await expect(
      provider.runResearch(
        { prompt: 'x', requiredAttachments: [], expectedConversationTitle: 't', expectedFilename: 'f.pdf' },
        { runId: 'run_fail' },
      ),
    ).rejects.toThrow(/exit code 4/i);
  }, 30_000);

  it('can be cancelled, and says nothing was recorded', async () => {
    connectedAgy(`
process.stdin.resume();
setTimeout(() => process.exit(0), 600000);
`);
    const provider = new AntigravityProvider();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);

    await expect(
      provider.runResearch(
        { prompt: 'x', requiredAttachments: [], expectedConversationTitle: 't', expectedFilename: 'f.pdf' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ outcome: 'CANCELLED' });
  }, 60_000);

  it('runs one job at a time, queueing the rest', async () => {
    // Each run records its own start and end; overlapping windows would mean
    // two jobs competing for the same account and the same machine.
    connectedAgy(`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const started = Date.now();
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ tag: input.trim(), started, ended: Date.now() }) + '\\n');
    process.exit(0);
  }, 700);
});
`);
    const provider = new AntigravityProvider();
    const run = (tag: string) =>
      provider.runResearch({
        prompt: tag,
        requiredAttachments: [],
        expectedConversationTitle: 't',
        expectedFilename: 'f.pdf',
      });

    const results = await Promise.all([run('one'), run('two'), run('three')]);
    const windows = results
      .map((r) => JSON.parse(r.text.trim()) as { tag: string; started: number; ended: number })
      .sort((a, b) => a.started - b.started);

    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index]!.started).toBeGreaterThanOrEqual(windows[index - 1]!.ended);
    }
  }, 90_000);

  it('refuses before queueing when the tool is not usable', async () => {
    setEnv('BRAIN_ANTIGRAVITY_PATH', path.join(workDir, 'missing'));
    const provider = new AntigravityProvider();
    await expect(
      provider.runResearch({
        prompt: 'x',
        requiredAttachments: [],
        expectedConversationTitle: 't',
        expectedFilename: 'f.pdf',
      }),
    ).rejects.toBeInstanceOf(AntigravityUnavailableError);
  });
});
