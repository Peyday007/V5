/** Release 01 acceptance probes answer FAIL with the reason while their behavior is not deployed, never PASS. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';

beforeEach(async () => {
  await freshProject();
});
afterEach(async () => {
  await teardown();
});

describe('Release 01 probes before their behavior ships', () => {
  it('COM-13-3 and GOV-22-2 do not pass on a Brain without the code', async () => {
    for (const name of ['r01.com-13-3', 'r01.gov-22-2']) {
      const result = await getProbe(name)!({});
      expect(result.ok, `${name}: ${result.detail}`).toBe(false);
      expect(result.detail.length).toBeGreaterThan(10);
    }
  });
});
