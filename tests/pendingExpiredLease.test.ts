/**
 * A LEASED bin whose lease has lapsed has nobody working on it (CLAUDE.md §19),
 * so the pending sentence must not say a worker is working on it now.
 */
import { describe, expect, it } from 'vitest';
import { explain } from '../server/services/russell/pending.ts';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function leased(leaseExpiresAt: string | null | undefined) {
  return {
    messageId: 'rmsg_test',
    binState: 'LEASED',
    terminalReason: null,
    dispatchState: 'SENT',
    dispatchError: null,
    leaseExpiresAt,
    createdAt: '2026-06-01T11:59:30.000Z',
  };
}

describe('pending turn on a leased bin', () => {
  it('says the worker stopped when the lease has expired', () => {
    const text = explain(leased('2026-06-01T11:00:00.000Z'), NOW);
    expect(text).toMatch(/stopped/);
    expect(text).toMatch(/another worker/);
    expect(text).not.toMatch(/working on this now/);
  });

  it('says a worker is working while the lease is live', () => {
    expect(explain(leased('2099-01-01T00:00:00.000Z'), NOW)).toMatch(/working on this now/);
  });

  it('reads a null, missing or unparseable expiry as live', () => {
    expect(explain(leased(null), NOW)).toMatch(/working on this now/);
    expect(explain(leased(undefined), NOW)).toMatch(/working on this now/);
    expect(explain(leased('not a date'), NOW)).toMatch(/working on this now/);
  });
});
