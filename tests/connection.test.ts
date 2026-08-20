/**
 * Settings → Research Providers → Antigravity.
 *
 * The page has one job: tell the truth about a tool Brain does not control, in
 * terms a person can act on. "Installed" is not "signed in", "signed in" is not
 * "can be driven by another program", and none of those is "has ever actually
 * done the work here" — which is the question the user is really asking.
 *
 * The other job is spending nothing. Paid overages are off until the user turns
 * them on, here, explicitly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { writeFakeExecutable } from './fixtures/fake-exec.ts';
import { setAntigravityProbe } from '../server/providers/antigravity/runtime.ts';
import { ptyState, wrapInPty } from '../server/providers/antigravity/pty.ts';
import {
  connectionView,
  detectConnection,
  disconnect,
  modelDefaults,
  testConnection,
  updateModelDefaults,
  updatePaidOverage,
} from '../server/services/providers/connection.ts';
import { getConnection } from '../server/repos/jobs.ts';
import { getProvider } from '../server/providers/index.ts';
import type {
  AIProvider,
  ChatResponse,
  ProviderStatus,
  ResearchResponse,
} from '../server/providers/types.ts';

let workDir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  setAntigravityProbe(null);
}

/** A stand-in CLI whose answers this test chooses. */
function fakeAgy(script: string): string {
  const stub = writeFakeExecutable({
    directory: workDir,
    name: 'agy',
    tool: 'agy',
    behaviour: 'ok',
    version: 'antigravity 1.0.6',
  });
  fs.writeFileSync(path.join(workDir, 'agy.js'), script);
  return stub.command;
}

function agyScript(options: { help: string; auth: string }): string {
  return `
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('antigravity 1.0.6\\n'); process.exit(0); }
if (args[0] === '--help' || args[0] === 'help') { process.stdout.write(${JSON.stringify(options.help)}); process.exit(0); }
if (args[0] === 'auth' || args[0] === 'account' || args[0] === 'whoami') {
  process.stdout.write(${JSON.stringify(options.auth)});
  process.exit(0);
}
process.exit(1);
`;
}

const AUTOMATABLE = 'Usage: agy -p <prompt> --non-interactive\n';

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-conn-'));
  freshProject();
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
  teardown();
});

describe('the connection page', () => {
  it('says the tool is not there, and what to do about it', () => {
    setEnv('BRAIN_ANTIGRAVITY_PATH', path.join(workDir, 'no-such-binary'));

    const view = detectConnection();
    expect(view.installed).toBe(false);
    expect(view.version).toBeNull();
    expect(view.remediation[0]).toMatch(/install antigravity/i);
    // A connection that never worked never claims it did.
    expect(view.verifiedRunAt).toBeNull();
    expect(view.lastSuccessAt).toBeNull();
    // And the state is stored, so the page renders without re-probing.
    expect(getConnection('antigravity')!.installed).toBe(false);
  });

  it('reports the executable and its version once it is found', () => {
    setEnv(
      'BRAIN_ANTIGRAVITY_PATH',
      fakeAgy(agyScript({ help: AUTOMATABLE, auth: 'Signed in as researcher@example.com\n' })),
    );

    const view = detectConnection();
    expect(view.installed).toBe(true);
    expect(view.version).toBe('antigravity 1.0.6');
    expect(view.executablePath).toContain('agy');
    expect(view.authenticated).toBe(true);
    expect(view.automationReady).toBe(true);
    expect(view.remediation.join(' ')).toMatch(/test connection/i);
  });

  it('asks the user to sign in inside the tool, never in Brain', () => {
    setEnv(
      'BRAIN_ANTIGRAVITY_PATH',
      fakeAgy(agyScript({ help: AUTOMATABLE, auth: 'not logged in\n' })),
    );

    const view = detectConnection();
    expect(view.installed).toBe(true);
    expect(view.authenticated).toBe(false);
    expect(view.remediation.join(' ')).toMatch(/sign in to antigravity in the app itself/i);
    expect(view.remediation.join(' ')).toMatch(/never asks for your password/i);
  });

  it('keeps credentials, environment and raw output out of what it shows', () => {
    setEnv(
      'BRAIN_ANTIGRAVITY_PATH',
      fakeAgy(agyScript({ help: AUTOMATABLE, auth: 'Signed in as researcher@example.com\n' })),
    );

    const view = detectConnection();
    const rendered = JSON.stringify(view);
    // The diagnostic trail is a list of stages and results, not a CLI dump.
    expect(view.diagnostics.map((entry) => entry.stage)).toContain('Authentication');
    expect(rendered).not.toContain('researcher@example.com');
    expect(rendered).not.toMatch(/PATH=|HOME=|APPDATA/);
    for (const entry of view.diagnostics) expect(entry.result.length).toBeLessThan(400);
  });
});

/** A worker that answers a connection test however this test wants. */
class TestWorker implements AIProvider {
  readonly name = 'antigravity';
  #reply: string | null;
  #error: string | null;

  constructor(reply: string | null, error: string | null = null) {
    this.#reply = reply;
    this.#error = error;
  }

  async runResearch(): Promise<ResearchResponse> {
    if (this.#error) throw new Error(this.#error);
    return { text: this.#reply ?? '', externalResponseId: 'job_1', model: 'gemini-test' };
  }
  async chat(): Promise<ChatResponse> {
    throw new Error('not used');
  }
  async audit(): Promise<{ text: string; externalResponseId: string | null }> {
    throw new Error('not used');
  }
  getStatus(): ProviderStatus {
    return {
      name: this.name,
      available: true,
      reason: 'test worker',
      model: 'gemini-test',
      capabilities: { chat: false, research: true, audit: false },
      placeholder: false,
    };
  }
}

describe('testing the connection', () => {
  it('marks the connection verified only after a real job actually ran', async () => {
    const before = connectionView();
    expect(before.verifiedRunAt).toBeNull();

    const result = await testConnection({
      worker: new TestWorker('{"ok": true, "check": "brain-connection-test"}'),
    });
    expect(result.ok).toBe(true);
    expect(result.connection.verifiedRunAt).not.toBeNull();
    expect(result.connection.verifiedRunDetail).toMatch(/ran a real job/i);
    expect(result.connection.lastSuccessAt).not.toBeNull();
  });

  it('treats a silent tool as a failure rather than a pass', async () => {
    const result = await testConnection({ worker: new TestWorker('   ') });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/without producing any output/i);
    expect(result.connection.verifiedRunAt).toBeNull();
    expect(result.connection.lastFailureReason).toMatch(/without producing any output/i);
  });

  it('records a timeout as a failure a person can act on', async () => {
    const result = await testConnection({
      worker: new TestWorker(null, 'The research tool did not respond within 900 seconds and was stopped.'),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not respond/i);
    expect(result.connection.verifiedRunAt).toBeNull();
  });

  it('refuses to let the placeholder provider pass a connection test', async () => {
    // The mock is always available, which is what lets Brain boot with no
    // credentials. A test it "passed" would be the most misleading thing this
    // page could say.
    const result = await testConnection({ worker: getProvider('mock') });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/placeholder content/i);
    expect(result.connection.verifiedRunAt).toBeNull();
  });
});

describe('what the connection is allowed to spend', () => {
  it('has paid overages off until the user turns them on', () => {
    expect(connectionView().paidOverage.enabled).toBe(false);

    const on = updatePaidOverage('antigravity', true, 'Approved for the custody research.');
    expect(on.paidOverage.enabled).toBe(true);
    expect(on.paidOverage.note).toMatch(/custody research/i);
    // When it was turned on is recorded, because that is the first question
    // anybody asks about a charge.
    expect(on.paidOverage.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(updatePaidOverage('antigravity', false, null).paidOverage.enabled).toBe(false);
  });

  it('keeps the overage setting through a disconnect', () => {
    updatePaidOverage('antigravity', true, 'Approved.');
    const after = disconnect();
    expect(after.installed).toBe(false);
    // Disconnecting forgets the connection, not the user's spending decision.
    expect(after.paidOverage.enabled).toBe(true);
    expect(after.message).toMatch(/nothing was changed in the tool itself/i);
  });

  it('lets the user choose which model does which kind of work', () => {
    const view = updateModelDefaults('antigravity', { light: 'flash', strong: 'pro' });
    expect(view.models).toEqual({ light: 'flash', strong: 'pro' });
    expect(modelDefaults('antigravity')).toEqual({ light: 'flash', strong: 'pro' });
  });
});

describe('the pseudo-terminal path', () => {
  it('is off unless it is switched on', () => {
    setEnv('BRAIN_ANTIGRAVITY_PTY', undefined);
    expect(ptyState().enabled).toBe(false);
    expect(wrapInPty('agy', ['-p'])).toBeNull();
    expect(ptyState().detail).toMatch(/off\./i);
  });

  it('wraps the command without putting anything on a shell command line', () => {
    setEnv('BRAIN_ANTIGRAVITY_PTY', '1');
    setEnv('BRAIN_ANTIGRAVITY_PTY_COMMAND', '/usr/local/bin/pty-helper');

    const plan = wrapInPty('agy', ['-p', '--model', 'gemini-pro']);
    expect(plan).not.toBeNull();
    expect(plan!.command).toBe('/usr/local/bin/pty-helper');
    // The wrapped arguments are still an array, and the prompt is not in them.
    expect(plan!.args).toEqual(['agy', '-p', '--model', 'gemini-pro']);
    expect(ptyState().enabled).toBe(true);
    expect(ptyState().available).toBe(true);
    // The safety properties are unchanged, and the page says so.
    expect(ptyState().detail).toMatch(/timeout, cancellation and output limits are unchanged/i);
  });

  it('says so plainly when it is on but the machine has no helper', () => {
    setEnv('BRAIN_ANTIGRAVITY_PTY', 'true');
    setEnv('BRAIN_ANTIGRAVITY_PTY_COMMAND', '');
    setEnv('PATH', workDir);

    const state = ptyState();
    if (!state.available) {
      expect(state.enabled).toBe(true);
      expect(state.detail).toMatch(/no pseudo-terminal helper was found/i);
      // Falling back to the ordinary path is stated, never silent.
      expect(state.detail).toMatch(/jobs run\s+the ordinary way|run the ordinary way/i);
      expect(wrapInPty('agy', ['-p'])).toBeNull();
    } else {
      // The machine running the tests has one; then it must be used safely.
      const plan = wrapInPty('agy', ['-p'])!;
      expect(plan.args[plan.args.length - 1]).not.toContain('rm -rf');
    }
  });
});
