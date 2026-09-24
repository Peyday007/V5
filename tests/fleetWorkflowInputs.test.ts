import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The fleet workflow is the only surface that can run `scripts/fleet.ts`
 * against production, so a value the script parses and the workflow refuses is
 * a command form nobody can use. That is this repository's most-recorded
 * defect — a rule applied by one of two readers — with the two readers a
 * workflow and the script it wraps, and it cost a real reading: a
 * `check-secret` naming eight variables was refused by the workflow with
 * `values are letters, digits, dot, colon, dash and underscore`, while
 * `scripts/fleet.ts` splits `--secret` on commas and answers present or
 * absent per name.
 *
 * These read the two files and hold them against each other. They assert the
 * property rather than the wording, so rephrasing either is free and dropping
 * the agreement is not.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/fleet.yml'), 'utf8');
const script = fs.readFileSync(path.join(REPO, 'scripts/fleet.ts'), 'utf8');

/**
 * The shell character classes the workflow refuses a value outside of, by the
 * variable each one guards. A `case` pattern here is `*[!<class>]*`, so the
 * class is what sits between `[!` and `]`.
 */
function classFor(variable: string): string | null {
  const block = workflow.split(`"$${variable}"`).slice(1).join(`"$${variable}"`);
  const match = /\*\[!([^\]]+)\]\*/.exec(block);
  return match?.[1] ?? null;
}

describe('the fleet workflow admits every value the command it wraps parses', () => {
  it('lets a comma through on --secret, because check-secret takes a list', () => {
    // The script's side of the contract, read rather than assumed.
    expect(script).toMatch(/option\('secret'\)[^\n]*\n?[^\n]*\.split\(','\)/);

    const cls = classFor('FLEET_SECRET');
    expect(cls, 'FLEET_SECRET must be guarded by its own character class').not.toBeNull();
    expect(cls).toContain(',');
  });

  it('lets a comma through on --capabilities, which is the precedent for it', () => {
    const cls = classFor('FLEET_CAPABILITIES');
    expect(cls).not.toBeNull();
    expect(cls).toContain(',');
  });

  /*
   * The widening is one character on one field. A guard that admitted
   * everything would be a removed check, so the things a shell could act on
   * are asserted absent rather than left to a reader's confidence.
   */
  it('still refuses everything a shell could act on', () => {
    for (const variable of ['FLEET_SECRET', 'FLEET_CAPABILITIES', 'FLEET_COMMAND']) {
      const cls = classFor(variable);
      expect(cls, variable).not.toBeNull();
      for (const dangerous of [';', '&', '|', '$', '`', '(', ')', '<', '>', "'", '"', '\\', '*', '?']) {
        expect(cls, `${variable} must not admit ${dangerous}`).not.toContain(dangerous);
      }
    }
  });

  /*
   * A value carrying a space would split into two arguments where the command
   * line is assembled, so only `extra` — which is a sequence of flag/value
   * pairs by construction — may hold one.
   */
  it('admits a space only where the input is a sequence of flags', () => {
    expect(classFor('FLEET_SECRET')).not.toMatch(/\\? /);
    expect(classFor('FLEET_EXTRA')).toMatch(/\\? /);
  });
});
