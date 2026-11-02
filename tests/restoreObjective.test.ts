/**
 * After a compaction the owner's own words come back verbatim.
 *
 * Measured 2026-11-01: a compaction summary recorded the original assignment as
 * "(Earlier truncated task message … — not visible.)", and the session went on
 * without its completion standard. The hook is run as the process Claude Code
 * spawns, against a transcript shaped like the real one, and its registration
 * in `.claude/settings.json` is held too — a handler nothing invokes is not a fix.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, '.claude/hooks/restore-objective.mjs');

const ORIGINAL =
  'BRAIN V5 — FULL AI THROUGHPUT EXPANSION\nDo not stop after fixing the first one. ' +
  'Repeat until the system is operating near its sustainable effective capacity.';

function line(entry: object): string {
  return JSON.stringify(entry);
}

function transcript(extra: object[] = []): string {
  const entries = [
    { type: 'ai-title' },
    { type: 'user', origin: { kind: 'human' }, timestamp: '2026-10-31T21:40:28Z', message: { role: 'user', content: ORIGINAL } },
    { type: 'user', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'user', origin: { kind: 'task-notification' }, timestamp: 't', message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    { type: 'user', isMeta: true, timestamp: 't', message: { role: 'user', content: 'meta' } },
    {
      type: 'user',
      isCompactSummary: true,
      timestamp: 't',
      message: { role: 'user', content: 'This session is being continued from a previous conversation… (Earlier truncated task message — not visible.)' },
    },
    { type: 'user', origin: { kind: 'human' }, timestamp: '2026-11-01T05:30:13Z', message: { role: 'user', content: "Continue improving the system. Don't stop at this report." } },
    // The same prompt retried after "Prompt is too long".
    { type: 'user', origin: { kind: 'human' }, timestamp: '2026-11-01T05:31:13Z', message: { role: 'user', content: "Continue improving the system. Don't stop at this report." } },
    ...extra,
  ];
  return entries.map(line).join('\n') + '\n';
}

function runHook(source: string, body: string): { status: number | null; context: string | null; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-objective-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, body);
  const out = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, transcript_path: file }),
    encoding: 'utf8',
  });
  const context = out.stdout ? JSON.parse(out.stdout).hookSpecificOutput.additionalContext : null;
  return { status: out.status, context, dir };
}

describe('restore-objective hook', () => {
  it('re-injects the original assignment verbatim after a compaction, and nothing the harness wrote', () => {
    const { status, context } = runHook('compact', transcript());
    expect(status).toBe(0);
    expect(context).toContain(ORIGINAL);
    expect(context).toContain('ORIGINAL ASSIGNMENT (2026-10-31T21:40:28Z)');
    expect(context).toContain("Don't stop at this report.");
    // One later message: the retry is the same instruction.
    expect(context!.match(/LATER MESSAGE FROM THE OWNER/g)).toHaveLength(1);
    expect(context).not.toContain('task-notification');
    expect(context).not.toContain('not visible');
    expect(context).not.toContain('meta');
  });

  it('stays under the 10,000-character cap and points at the whole text when it had to cut', () => {
    const huge = 'requirement. '.repeat(3000);
    const body = transcript([
      { type: 'user', origin: { kind: 'human' }, timestamp: 'later', message: { role: 'user', content: huge } },
    ]).replace(JSON.stringify(ORIGINAL), JSON.stringify(ORIGINAL + huge));
    const { context, dir } = runHook('compact', body);
    expect(context!.length).toBeLessThanOrEqual(10_000);
    const full = path.join(dir, 'session', 'owner-words.md');
    expect(context).toContain(full);
    expect(fs.readFileSync(full, 'utf8')).toContain((ORIGINAL + huge).trim());
  });

  it('says nothing on a fresh start, and never fails the session on a bad transcript', () => {
    expect(runHook('startup', transcript()).context).toBeNull();
    const broken = runHook('compact', '{not json\n');
    expect(broken.status).toBe(0);
    expect(broken.context).toBeNull();
  });

  it('is registered for compaction and resume in the settings Claude Code reads', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
    const matchers = (settings.hooks?.SessionStart ?? [])
      .filter((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes('restore-objective.mjs')))
      .map((e: { matcher: string }) => e.matcher);
    expect(matchers).toEqual(expect.arrayContaining(['compact', 'resume']));
  });
});
