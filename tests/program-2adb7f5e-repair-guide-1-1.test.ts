/**
 * GUIDE-1 regression: docs/FACTORY-PROGRAMS.md must explain how to submit a program
 * (`program-submit`), approve it (`program-approve`) and read its status
 * (`program-status`), and each name must be a real command of scripts/factory.ts so the
 * guide cannot teach a command that does not exist.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMANDS = ['program-submit', 'program-approve', 'program-status'] as const;

/** The commands a guide text names, in the form `program-…`, that this CLI could be asked for. Pure. */
export function missingCommands(guide: string, commands: readonly string[] = COMMANDS): string[] {
  return commands.filter((command) => !guide.includes(command));
}

/** Whether the CLI source dispatches `command` as a case of its command switch. Pure. */
export function isCliCase(source: string, command: string): boolean {
  return new RegExp(`case\\s+'${command}'\\s*:`).test(source);
}

const guide = readFileSync(resolve(__dirname, '../docs/FACTORY-PROGRAMS.md'), 'utf8');
const cli = readFileSync(resolve(__dirname, '../scripts/factory.ts'), 'utf8');

describe('docs/FACTORY-PROGRAMS.md (GUIDE-1)', () => {
  it('names program-submit, program-approve and program-status', () => {
    expect(missingCommands(guide)).toEqual([]);
  });

  it('shows each command as an invocation, not only a mention', () => {
    for (const command of COMMANDS) expect(guide).toMatch(new RegExp(`factory\\s+--\\s+${command}\\b`));
  });

  it('names only commands that are real cases in scripts/factory.ts', () => {
    for (const command of COMMANDS) expect(isCliCase(cli, command), `${command} is not a case in scripts/factory.ts`).toBe(true);
    // Every `factory -- program-…` the guide shows must exist too.
    const shown = [...guide.matchAll(/factory\s+--\s+(program-[a-z-]+)/g)].map((m) => m[1]!);
    expect(shown.length).toBeGreaterThanOrEqual(COMMANDS.length);
    for (const command of new Set(shown)) expect(isCliCase(cli, command), `guide shows ${command}, which scripts/factory.ts lacks`).toBe(true);
  });

  it('fails a guide that omits any of the three commands (the acceptance condition)', () => {
    for (const dropped of COMMANDS) {
      const without = guide.split(dropped).join('removed');
      expect(missingCommands(without)).toEqual([dropped]);
    }
    expect(missingCommands('')).toEqual([...COMMANDS]);
  });

  it('fails a command that the CLI does not dispatch', () => {
    expect(isCliCase(cli, 'program-teleport')).toBe(false);
    expect(isCliCase("case 'program-submit' :", 'program-submit')).toBe(true);
  });
});
