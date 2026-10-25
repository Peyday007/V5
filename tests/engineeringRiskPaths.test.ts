import { describe, expect, it } from 'vitest';
import { riskForPaths, testPolicy } from '../server/domain/engineering.ts';

describe('riskForPaths normalises before matching', () => {
  it.each([
    ['./server/db/migrations/x.sql'],
    ['/home/user/V5/server/repos/x.ts'],
    ['server\\repos\\x.ts'],
    ['././server/repos/x.ts'],
  ])('%s is TIER_3', (path) => {
    expect(riskForPaths([path]).tier).toBe('TIER_3');
  });

  it('requires focused Postgres for a persistence change however it is spelled', () => {
    expect(testPolicy({ changedPaths: ['./server/db/migrations/x.sql'] }).focusedPostgres).toBe(true);
    expect(testPolicy({ changedPaths: ['server\\repos\\x.ts'] }).focusedPostgres).toBe(true);
  });

  it('never rates a path outside the repository or climbing with .. below TIER_2', () => {
    expect(['TIER_2', 'TIER_3']).toContain(riskForPaths(['../x.ts']).tier);
    expect(['TIER_2', 'TIER_3']).toContain(riskForPaths(['server/../../x.ts']).tier);
    expect(['TIER_2', 'TIER_3']).toContain(riskForPaths(['/etc/elsewhere/x.ts']).tier);
  });

  it('leaves documentation at TIER_0', () => {
    expect(riskForPaths(['docs/a.md']).tier).toBe('TIER_0');
    expect(riskForPaths(['./docs/a.md']).tier).toBe('TIER_0');
  });

  it('reports the normalised path in the reasons', () => {
    const { reasons } = riskForPaths(['./server/db/migrations/x.sql']);
    expect(reasons.some((r) => r.startsWith('server/db/migrations/x.sql '))).toBe(true);
    expect(reasons.some((r) => r.includes('./server'))).toBe(false);
  });
});
