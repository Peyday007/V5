import { describe, expect, it } from 'vitest';
import { isTransientRefusal, openPatiently } from '../scripts/hostedOpen.ts';
import { DatabaseConfigurationError } from '../server/db/types.ts';
import { StorageConfigurationError } from '../server/services/storage/types.ts';

// The exact refusals four released-and-working deploys went red on.
const pooler = new DatabaseConfigurationError(
  'Brain is configured for Postgres but could not reach aws-0-us-east-2.pooler.supabase.com:5432/postgres.',
  '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15',
);
const storage = new StorageConfigurationError(
  'The document store could not be checked (HTTP 429).',
  '{"statusCode":"429","error":"too_many_connections","message":"Too many connections issued to the database","code":"SlowDown"}',
);

describe('the hosted verifier waits out a capacity refusal', () => {
  it('recognises the pooler and storage refusals by their own words', () => {
    expect(isTransientRefusal(pooler)).toBe(true);
    expect(isTransientRefusal(storage)).toBe(true);
  });

  it('does not wait out an answer that is not "not now"', () => {
    expect(isTransientRefusal(new DatabaseConfigurationError('password authentication failed for user "x"'))).toBe(false);
    expect(isTransientRefusal(new StorageConfigurationError('The bucket "brain" does not exist.'))).toBe(false);
    expect(isTransientRefusal('EMAXCONNSESSION')).toBe(false);
  });

  it('retries a transient refusal and returns the first success', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await openPatiently(
      'the database',
      async () => {
        calls += 1;
        if (calls < 3) throw pooler;
        return 'open';
      },
      { sleep: async (ms) => void waits.push(ms), log: () => {} },
    );
    expect(value).toBe('open');
    expect(calls).toBe(3);
    expect(waits).toEqual([15_000, 30_000]);
  });

  it('throws a permanent refusal at once', async () => {
    let calls = 0;
    const permanent = new DatabaseConfigurationError('password authentication failed');
    await expect(
      openPatiently('the database', async () => {
        calls += 1;
        throw permanent;
      }, { sleep: async () => {}, log: () => {} }),
    ).rejects.toBe(permanent);
    expect(calls).toBe(1);
  });

  it('is bounded: the last transient refusal is thrown, not waited on forever', async () => {
    let calls = 0;
    await expect(
      openPatiently('the store', async () => {
        calls += 1;
        throw storage;
      }, { attempts: 5, sleep: async () => {}, log: () => {} }),
    ).rejects.toBe(storage);
    expect(calls).toBe(5);
  });
});
