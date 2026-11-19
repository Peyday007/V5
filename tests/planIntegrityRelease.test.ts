/**
 * Every release has its live plans checked, and the check cannot quietly fall
 * out of the release (owner, 2026-11-19: "add end-to-end acceptance checks to
 * the existing release process, using real planning outputs and evidence …
 * preserve these checks across future releases so previously corrected
 * failures cannot silently return").
 *
 * The check itself is `goals.sh check` (scripts/goals.ts), which reads every
 * active cash goal's plan on production and refuses on any plan-integrity
 * violation (server/domain/planIntegrity.ts). This file holds the wiring: both
 * kinds of Deploy reach it, and it stays read-only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the release checks the plans it released', () => {
  it('runs the check after a Deploy a person dispatched (workflow_run)', () => {
    const goals = read('.github/workflows/goals.yml');
    expect(goals).toMatch(/^  workflow_run:\n    workflows: \[Deploy\]\n    types: \[completed\]/m);
    // Only a successful release on the canonical branch has plans to check.
    expect(goals).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(goals).toContain(`github.event.workflow_run.head_branch == '${read('.github/CANONICAL_BRANCH').trim()}'`);
    // With no dispatch inputs the command is the check, never anything that changes state.
    expect(goals).toContain("G_COMMAND: ${{ inputs.command || 'check' }}");
  });

  it('runs the check after a Deploy the bot dispatched (hand-off)', () => {
    const deploy = read('.github/workflows/deploy.yml');
    const handOff = deploy.slice(deploy.indexOf('\n  hand-off:'));
    expect(handOff).toMatch(/gh workflow run goals\.yml [^\n]*-f command=check/);
    expect(handOff).toContain("if: ${{ needs.deploy.result == 'success' }}");
  });

  it('keeps the check read-only: no administrator, and its verdict is a printed line', () => {
    const goals = read('.github/workflows/goals.yml');
    expect(goals).toMatch(/\|plan\|check\|/);
    expect(goals).toContain('[ "$G_COMMAND" != check ]');
    expect(goals).toContain("grep -q '^GOALS: OK' goals.txt");
  });
});
