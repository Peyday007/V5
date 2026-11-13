/**
 * GOV-11's fixed check is `probe r01.gov-11({}) passes`. A probe nobody
 * registered answers "no such probe is registered in this Brain" and can never
 * pass; this pins that the open-questions module registers it, and that the
 * module is one the goals tick (and so the running server) loads.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runRequirementChecks } from '../server/services/factory/program/ports.ts';
import { getProbe, probeNames } from '../server/services/factory/program/probes.ts';
import '../server/services/goals/openQuestions.ts';

describe('probe r01.gov-11', () => {
  it('is registered by the open-questions module', () => {
    expect(probeNames()).toContain('r01.gov-11');
    expect(getProbe('r01.gov-11')).not.toBeNull();
  });

  it('is no longer reported as unregistered by the requirement check runner', async () => {
    const [result] = await runRequirementChecks([{ kind: 'PROBE', probe: 'r01.gov-11', args: {} }] as never, { baseUrl: 'http://127.0.0.1:1', fetch: (async () => { throw new Error('no network'); }) as typeof fetch });
    expect(result?.detail).not.toBe('no such probe is registered in this Brain');
  });

  it('delegates to the production register check, and the goals tick loads that module', () => {
    const source = readFileSync('server/services/goals/openQuestions.ts', 'utf8');
    expect(source).toMatch(/registerProbe\('r01\.gov-11', async \(\) => \{\s*const outcome = await checkRegisterOnProduction\(\);/);
    expect(readFileSync('server/services/goals/tick.ts', 'utf8')).toMatch(/from '\.\/openQuestions\.ts'/);
  });
});
