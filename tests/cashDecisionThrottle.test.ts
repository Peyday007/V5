import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/*
 * The decision pass re-screened every opening under every goal on every Cash
 * tick. The production tick calls `operate(projectId)` with no clock, and that
 * is the call that must be throttled; a caller driving time itself is not.
 */
describe('the Cash decision pass is throttled on the production tick', () => {
  const source = readFileSync('server/services/cash/operate.ts', 'utf8');

  it('skips the pass when it ran inside the interval and no clock was supplied', () => {
    expect(source).toMatch(/if \(!now && !decisionPassDue\(projectId\)\)/);
    expect(source).toMatch(/DECISION_PASS_INTERVAL_MS = 5 \* 60_000/);
  });

  it('is the only call site of decideOpenings, so nothing else runs it per tick', () => {
    expect(source.match(/[^A-Za-z]decideOpenings\(projectId/g)?.length).toBe(1);
  });

  it('the production loop calls operate with no clock, which is the throttled path', () => {
    const loop = readFileSync('server/services/russell/loop.ts', 'utf8');
    expect(loop).toMatch(/operate\(project\.id\)/);
    expect(loop).not.toMatch(/operate\(project\.id, *\{/);
  });
});
