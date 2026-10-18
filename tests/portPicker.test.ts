/**
 * A suite's server never takes a port the environment already holds.
 *
 * The defect: `api.test.ts` drew 5432 on the Postgres runner and could not boot.
 */
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_RESERVED_PORTS, FETCH_BLOCKED_PORTS, pickPort } from './helpers/ports.ts';

describe('pickPort', () => {
  it('never returns the Postgres port, however often it is asked', () => {
    for (let i = 0; i < 5_000; i += 1) {
      const port = pickPort(5400, 100);
      expect(ENVIRONMENT_RESERVED_PORTS.has(port)).toBe(false);
      expect(FETCH_BLOCKED_PORTS.has(port)).toBe(false);
      expect(port).toBeGreaterThanOrEqual(5400);
      expect(port).toBeLessThan(5500);
    }
  });

  it('refuses a range in which nothing is usable', () => {
    expect(() => pickPort(5432, 1)).toThrow(/Choose a different range/);
  });
});
