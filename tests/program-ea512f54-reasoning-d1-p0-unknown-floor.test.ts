/**
 * Repair (repair-unknown-outranks-adverse-evidence), META-18-1 and invariant 39:
 * an unknown capital requirement or failure rate was scored at a fixed 0.25,
 * so a market whose capital exceeded 3x its monthly contribution, or whose
 * measured failure rate was above 0.25, ranked below an identical market with
 * no reading at all. Among compared markets an unknown is now scored no better
 * than the worst known reading it could hide, and a tie goes to the measured one.
 */
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_CAPITAL_FACTOR,
  UNKNOWN_FAILURE_RATE,
  marketCriteria,
  rankMarkets,
  unknownFloor,
  type MarketCandidate,
} from '../server/services/industry/construction/origins.ts';

const base: MarketCandidate = { key: 'b', geography: null, marginUsd: 100, monthlyVolume: 100, daysToCash: 30, remoteControl: 1, capitalUsd: 0, feasibility: 1, failureModes: 0, failureRate: 0 };

describe('an unknown never outranks adverse evidence', () => {
  it('heavy known capital is not beaten by unknown capital (the reviewer\'s case)', () => {
    const known = { ...base, key: 'known', capitalUsd: 100_000 };
    const unknown = { ...base, key: 'unknown', capitalUsd: null };
    expect(rankMarkets([unknown, known]).map((m) => m.key)).toEqual(['known', 'unknown']);
    expect(rankMarkets([known, unknown]).map((m) => m.key)).toEqual(['known', 'unknown']);
  });

  it('a high measured failure rate is not beaten by an unmeasured one', () => {
    const known = { ...base, key: 'known', failureRate: 0.5 };
    const unknown = { ...base, key: 'unknown', failureRate: null };
    expect(rankMarkets([unknown, known]).map((m) => m.key)).toEqual(['known', 'unknown']);
  });

  it('holds across many adverse readings, whatever the key order', () => {
    for (const capitalUsd of [10_000, 40_000, 1_000_000, 1e9]) {
      for (const failureRate of [0.3, 0.6, 0.99, 1]) {
        const known = { ...base, key: 'z-known', capitalUsd, failureRate };
        const unknown = { ...base, key: 'a-unknown', capitalUsd: null, failureRate: null };
        expect(rankMarkets([unknown, known])[0]!.key, `${capitalUsd}/${failureRate}`).toBe('z-known');
      }
    }
  });

  it('favourable known readings still beat an unknown, and the floor is never better than the defaults', () => {
    const cheap = { ...base, key: 'cheap', capitalUsd: 100 };
    const unknown = { ...base, key: 'unknown', capitalUsd: null, failureRate: null };
    expect(rankMarkets([unknown, cheap])[0]!.key).toBe('cheap');
    const floor = unknownFloor([cheap, unknown]);
    expect(floor.capitalFactor).toBe(UNKNOWN_CAPITAL_FACTOR);
    expect(floor.failureRate).toBe(UNKNOWN_FAILURE_RATE);
    const adverse = unknownFloor([{ ...base, capitalUsd: 100_000, failureRate: 0.7 }]);
    expect(adverse.capitalFactor).toBeLessThan(UNKNOWN_CAPITAL_FACTOR);
    expect(adverse.failureRate).toBe(0.7);
    expect(marketCriteria(unknown, adverse).capitalFactor).toBe(adverse.capitalFactor);
    expect(marketCriteria(unknown, adverse).failureRate).toBe(0.7);
  });
});
