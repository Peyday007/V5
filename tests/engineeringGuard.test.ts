/**
 * The engineering hook's two hard edges, driven through the hook process
 * itself and through the matcher Claude Code actually reads (FAC-8, FAC-9).
 *
 * A correct handler that is never invoked is not a fix, so the matcher in
 * `.claude/settings.json` is held against the tool name this execution surface
 * really uses, and the handler is run as the process Claude Code spawns.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, '.claude/hooks/engineering-guard.mjs');

function run(event: object): { status: number | null; stderr: string } {
  const out = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8' });
  return { status: out.status, stderr: out.stderr };
}
const bash = (command: string) => run({ tool_name: 'Bash', tool_input: { command } });

/** Every PreToolUse matcher whose command is the engineering guard. */
function guardMatchers(): string[] {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const entries = settings.hooks?.PreToolUse ?? [];
  return entries
    .filter((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes('engineering-guard.mjs')))
    .map((e: { matcher: string }) => e.matcher);
}

describe('the hook is registered for the tools it judges', () => {
  // Claude Code treats a matcher as a regex anchored to the whole tool name.
  const matches = (tool: string) => guardMatchers().some((m) => new RegExp(`^(?:${m})$`).test(tool));

  it('matches Bash and the send_later tool as this surface names it', () => {
    expect(guardMatchers().length).toBeGreaterThan(0);
    expect(matches('Bash')).toBe(true);
    expect(matches('mcp__claude-code-remote__send_later')).toBe(true);
  });

  it('does not run on unrelated tools', () => {
    expect(matches('Read')).toBe(false);
    expect(matches('mcp__claude-code-remote__send_message')).toBe(false);
  });
});

describe('send_later under 45 minutes is refused under the real tool name', () => {
  it('refuses the observed spelling, and still the old one', () => {
    for (const tool of ['mcp__claude-code-remote__send_later', 'mcp__Claude_Code_Remote__send_later']) {
      const out = run({ tool_name: tool, tool_input: { delay_minutes: 15, message: 'check CI' } });
      expect(out.status).toBe(2);
      expect(out.stderr).toMatch(/rule 4/);
    }
  });

  it('allows a long delay, an unobservable one, and an absolute time', () => {
    const tool = 'mcp__claude-code-remote__send_later';
    expect(run({ tool_name: tool, tool_input: { delay_minutes: 50, message: 'x' } }).status).toBe(0);
    expect(run({ tool_name: tool, tool_input: { delay_minutes: 10, message: 'NOT_OBSERVABLE: x' } }).status).toBe(0);
    expect(run({ tool_name: tool, tool_input: { at: '2026-10-14T00:00:00Z', message: 'x' } }).status).toBe(0);
  });
});

describe('a full suite on an intermediate commit is refused in its ordinary forms', () => {
  const full = [
    'npx vitest run',
    'npx vitest run --reporter dot',
    'npx vitest run --reporter=dot',
    'vitest run',
    'npx vitest',
    'node_modules/.bin/vitest run --reporter verbose',
    'scripts/test-postgres.sh run -- npx vitest run',
    'sh scripts/test-postgres.sh run -- npx vitest run --reporter dot',
    'BRAIN_TEST_DATABASE_URL=postgres://x npx vitest run',
    'npm test',
    'npm run test',
    'npm test -- --reporter dot',
    'npm t',
    'cd /home/user/V5 && npx vitest run 2>&1 | tail -20',
    'timeout 3000 npx vitest run',
    'npx vitest run --maxWorkers 4',
  ];
  for (const command of full) {
    it(`refuses: ${command}`, () => {
      const out = bash(command);
      expect(out.status).toBe(2);
      expect(out.stderr).toMatch(/rule 3/);
    });
  }
});

describe('focused work and the authorized gate still run', () => {
  const allowed = [
    'npm run test:impacted',
    'npm run test:impacted -- --list',
    'npm run test:pg',
    'scripts/test-postgres.sh run -- node scripts/test-impacted.mjs',
    'npx vitest run tests/engineeringGuard.test.ts',
    'npx vitest run tests/a.test.ts tests/b.test.ts --reporter dot',
    'npx vitest run --reporter dot tests/a.test.ts',
    'scripts/test-postgres.sh run -- npx vitest run tests/goals.test.ts',
    'npx vitest run goals',
    'npx vitest run -t "release plan"',
    'npx vitest run --shard 1/4',
    'npm test -- tests/a.test.ts',
    'npm run typecheck',
    'grep -n "vitest run" CLAUDE.md',
    'echo npx vitest run',
    'BRAIN_FULL_GATE=1 npx vitest run',
    'npx vitest list',
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      expect(bash(command).status).toBe(0);
    });
  }

  it('ignores an event it cannot parse rather than blocking', () => {
    const out = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    expect(out.status).toBe(0);
  });
});
