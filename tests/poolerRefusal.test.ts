/**
 * A pooler refusing a new client is a third condition, and it had no sentence.
 *
 * ---------------------------------------------------------------------------
 * What was observed, and why a driver object is not a diagnosis
 * ---------------------------------------------------------------------------
 *
 * Production, 2026-09-20. `release: success` on `41f8741`, the app perfectly
 * healthy — `/api/auth/login` answered 401 in 1.1s after a real lookup — and
 * four consecutive operator reads in a row died like this:
 *
 *     LABOR-REPORT: FAILED error: (EMAXCONNSESSION) max clients reached in
 *     session mode - max clients are limited to pool_size: 15
 *       length: 117, severity: 'FATAL', code: 'XX000', detail: undefined,
 *       hint: undefined, position: undefined, internalPosition: undefined,
 *       … eighteen more undefined fields …
 *
 * Another workstream's `Manufacturing programme` read failed identically in
 * the same minutes, which is the tell: it is not about the caller.
 *
 * §27 built `describePoolExhaustion` for the two conditions `pg-pool`
 * collapses — every connection checked out, against a server that would not
 * hand one over — *because their remedies are opposite*. This is neither. The
 * pooler refused the connection **before any pool of this process's own
 * existed to be exhausted**, so no reading of `total`, `idle` or `waiting`
 * describes it, and `describePoolExhaustion` is never reached.
 *
 * The remedy is opposite again, which is the whole reason it needs its own
 * sentence: raising `BRAIN_DATABASE_POOL_SIZE` makes this *worse*, because the
 * binding number is the pooler's and it is shared.
 *
 * ---------------------------------------------------------------------------
 * What this pins
 * ---------------------------------------------------------------------------
 *
 * The matcher is narrow on purpose — the code **and** the marker — because the
 * failure mode that matters is naming a condition that is not this one. A
 * diagnosis that fires on an unrelated `XX000` would be §29's warning that
 * cries wolf, at a connection string.
 */
import { describe, it, expect } from 'vitest';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';

/** The error exactly as `pg` raised it in production. */
function productionRefusal(): Error & { code: string } {
  const error = new Error(
    '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15',
  ) as Error & { code: string };
  error.code = 'XX000';
  return error;
}

describe('a pooler refusing a new client says so, and says whose limit it is', () => {
  it('recognises the refusal production actually raised', () => {
    const said = describePoolerRefusal(productionRefusal());
    expect(said).not.toBeNull();
    expect(said).toContain('refused a new client');
  });

  it('carries the pooler’s own words, including the number that was binding', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).toContain('EMAXCONNSESSION');
    expect(said).toContain('pool_size: 15');
  });

  /*
   * The half that matters most. Somebody reading this while the app is
   * healthy will reach for the one knob they know about, and it is the wrong
   * way round: the binding limit is not this application's.
   */
  it('says the limit is the pooler’s and not this application’s', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).toMatch(/pooler's rather than this application's/);
    expect(said).toMatch(/shared with every other client/);
  });

  it('names the remedy, and names raising the ceiling as the wrong one', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).toMatch(/BRAIN_DATABASE_POOL_SIZE would make this worse/);
    expect(said).toMatch(/fewer concurrent clients/);
  });

  it('is silent about anything that is not this condition', () => {
    const wrongCode = new Error('(EMAXCONNSESSION) max clients reached') as Error & {
      code: string;
    };
    wrongCode.code = '53300';
    expect(describePoolerRefusal(wrongCode)).toBeNull();

    const wrongMessage = new Error('relation "labor_tasks" does not exist') as Error & {
      code: string;
    };
    wrongMessage.code = 'XX000';
    expect(describePoolerRefusal(wrongMessage)).toBeNull();

    expect(describePoolerRefusal(null)).toBeNull();
    expect(describePoolerRefusal(undefined)).toBeNull();
    expect(describePoolerRefusal('a string')).toBeNull();
    expect(describePoolerRefusal({ code: 'XX000' })).toBeNull();
  });

  /*
   * And it stays apart from its neighbour. The two answer different questions
   * and prescribe opposite remedies, so a reader must never see one while the
   * other is what happened.
   */
  it('does not repeat the checkout-timeout diagnosis, which has the opposite remedy', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).not.toContain('had no free connection within');
    expect(said).not.toContain('caller(s) waiting');
  });
});
