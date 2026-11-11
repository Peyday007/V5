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
  it('COM-13-3 does not pass on a Brain without the code', async () => {
    const result = await getProbe('r01.com-13-3')!({});
    expect(result.ok, `r01.com-13-3: ${result.detail}`).toBe(false);
    expect(result.detail.length).toBeGreaterThan(10);
  });

  it('GOV-22-2 passes once the prepared-option code ships (factory-program-d0)', async () => {
    const result = await getProbe('r01.gov-22-2')!({});
    expect(result.ok, `r01.gov-22-2: ${result.detail}`).toBe(true);
  });
});

describe('a campaign may not define its own judge', () => {
  it('refuses a release probe registered outside the protected module and keeps the protected one', async () => {
    const { registerProbe } = await import('../server/services/factory/program/probes.ts');
    const before = getProbe('r01.com-13-5');
    expect(before).not.toBeNull();
    registerProbe('r01.com-13-5', async () => ({ ok: true, detail: 'self-graded' }));
    registerProbe('r02.anything', async () => ({ ok: true, detail: 'self-graded' }));
    expect(getProbe('r01.com-13-5')).toBe(before);
    expect(getProbe('r02.anything')).toBeNull();
    // Ordinary named probes are still registered.
    registerProbe('test.ordinary', async () => ({ ok: true, detail: 'fine' }));
    expect(getProbe('test.ordinary')).not.toBeNull();
  });
});
