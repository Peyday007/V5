import { describe, expect, it } from 'vitest';
import { groupOfBin } from '../server/services/russell/work.ts';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const leased = (leaseExpiresAt?: string | null) =>
  ({ state: 'LEASED', kind: 'RESEARCH_PACKET', leaseExpiresAt }) as never;

describe('groupOfBin and expired leases', () => {
  it('groups a bin whose lease has expired as UP_NEXT', () => {
    expect(groupOfBin(leased('2026-10-03T11:59:59.000Z'), NOW)).toBe('UP_NEXT');
    expect(groupOfBin(leased('2026-10-03T12:00:00.000Z'), NOW)).toBe('UP_NEXT');
  });

  it('keeps a live lease in WORKING_NOW', () => {
    expect(groupOfBin(leased('2026-10-03T12:00:01.000Z'), NOW)).toBe('WORKING_NOW');
  });

  it('keeps a missing, null or unparseable expiry in WORKING_NOW', () => {
    expect(groupOfBin(leased(undefined), NOW)).toBe('WORKING_NOW');
    expect(groupOfBin(leased(null), NOW)).toBe('WORKING_NOW');
    expect(groupOfBin(leased('not a date'), NOW)).toBe('WORKING_NOW');
  });
});
