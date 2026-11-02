import { describe, expect, it } from 'vitest';
import { intermediateRoundCommands } from '../server/services/factory/remote.ts';
import { NO_SHOW_WINDOW_MS, IN_FLIGHT_WINDOW_MS } from '../server/services/dispatch/candidates.ts';
import { ABANDONED_REVIVE_AFTER_MS } from '../server/repos/bins.ts';

const BASE = 'a'.repeat(40);

describe('an intermediate Factory round does not re-run the full suite', () => {
  it('replaces the full test command with the impacted selection against the round base', () => {
    const round = intermediateRoundCommands(['npm run typecheck', 'npm test'], BASE);
    expect(round.commands).toEqual(['npm run typecheck', `npm run test:impacted -- --base ${BASE}`]);
    expect(round.note).toMatch(/CI runs the whole suite once, on the commit that is released/);
    expect(round.note).toMatch(/no `test:impacted` script/);
  });

  it('keeps every other command, in order, and never duplicates the stand-in', () => {
    const round = intermediateRoundCommands(['npm run lint', 'npm test', 'npx vitest run', 'npm run build'], BASE);
    expect(round.commands).toEqual([
      'npm run lint',
      `npm run test:impacted -- --base ${BASE}`,
      'npm run build',
    ]);
  });

  it('changes nothing for a contract with no full-suite command', () => {
    const round = intermediateRoundCommands(['cargo test', 'npm run typecheck'], BASE);
    expect(round.commands).toEqual(['cargo test', 'npm run typecheck']);
    expect(round.note).toBeNull();
  });
});

describe('a fire nobody answered stops holding the fleet after minutes, not half an hour', () => {
  it('is shorter than the window for a session that did arrive, and longer than a cold start', () => {
    expect(NO_SHOW_WINDOW_MS).toBeLessThan(IN_FLIGHT_WINDOW_MS);
    expect(NO_SHOW_WINDOW_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('asks an abandoned intent again within the hour', () => {
    expect(ABANDONED_REVIVE_AFTER_MS).toBeLessThanOrEqual(30 * 60_000);
  });
});

describe('the integrate stage promises nothing the code does not enforce', () => {
  it('never tells a unit worker its integrator will be a different session, and lets the implementer integrate', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../server/services/factory/remote.ts', import.meta.url), 'utf8');
    // fcp_8cd968ad: a worker believed this, refused the integrate bin twice and parked it for a person.
    expect(source).not.toMatch(/judged by a session that did not implement any of this/);
    expect(source).toMatch(/any session, including this one, may take afterwards/);
    expect(source).toMatch(/integration is not a review/);
  });
});
