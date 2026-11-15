/**
 * META-18-1, review finding repair-unknown-outranks-adverse-evidence.
 *
 * `marketCriteria` gave an unknown capital a fixed factor of 0.25 and an
 * unknown failure rate a fixed 0.25. Ran at 0ad8e07c: two markets identical
 * but for capital 100000 against none ranked [unknown, known] (165.98 vs
 * 456.44), and failure rate 0.5 against none ranked [unknown, known]. Not
 * having researched a cost beat having found one (invariant 39).
 *
 * Pinned here: within a comparison an unknown reads as no better than the
 * least favourable known reading, never better than its default, and a tie
 * goes to the market resting on evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_CAPITAL_FACTOR,
  UNKNOWN_FAILURE_RATE,
  marketCriteria,
  rankMarkets,
  unknownReadingAmong,
  type MarketCandidate,
} from '../server/services/industry/construction/origins.ts';

const base: MarketCandidate = { key: 'k', geography: null, marginUsd: 100, monthlyVolume: 100, daysToCash: 30, remoteControl: 1, capitalUsd: 0, feasibility: 1, failureModes: 0, failureRate: 0 };

describe('an unknown never outranks adverse evidence (invariant 39)', () => {
  it('a market with unknown capital does not outrank an identical one whose capital is known and large', () => {
    const known: MarketCandidate = { ...base, key: 'a-known', capitalUsd: 100_000 };
    const unknown: MarketCandidate = { ...base, key: 'b-unknown', capitalUsd: null };
    expect(rankMarkets([unknown, known]).map((m) => m.key)).toEqual(['a-known', 'b-unknown']);
    expect(rankMarkets([known, unknown]).map((m) => m.key)).toEqual(['a-known', 'b-unknown']);
    // The finding's own keys, where the key order would favour the unknown.
    const k2: MarketCandidate = { ...known, key: 'z-known' };
    const u2: MarketCandidate = { ...unknown, key: 'a-unknown' };
    expect(rankMarkets([u2, k2]).map((m) => m.key)).toEqual(['z-known', 'a-unknown']);
  });

  it('a market with an unmeasured failure rate does not outrank an identical one measured at 0.5', () => {
    const known: MarketCandidate = { ...base, key: 'z-known', failureRate: 0.5 };
    const unknown: MarketCandidate = { ...base, key: 'a-unknown', failureRate: null };
    expect(rankMarkets([unknown, known]).map((m) => m.key)).toEqual(['z-known', 'a-unknown']);
  });

  it('reads an unknown at the least favourable known reading, never better than the default', () => {
    const adverse = unknownReadingAmong([{ ...base, capitalUsd: 100_000, failureRate: 0.5 }, { ...base, capitalUsd: null, failureRate: null }]);
    expect(adverse.capitalFactor).toBeCloseTo(10_000 / 110_000, 10);
    expect(adverse.failureRate).toBe(0.5);
    // Favourable known readings do not lift an unknown above its default.
    const favourable = unknownReadingAmong([{ ...base, capitalUsd: 0, failureRate: 0 }]);
    expect(favourable).toEqual({ capitalFactor: UNKNOWN_CAPITAL_FACTOR, failureRate: UNKNOWN_FAILURE_RATE });
    const c = marketCriteria({ ...base, capitalUsd: null, failureRate: null }, adverse);
    expect(c.capitalFactor).toBeCloseTo(10_000 / 110_000, 10);
    expect(c.failureRate).toBe(0.5);
    expect(c.unknown).toEqual(expect.arrayContaining(['capital', 'failure rate']));
  });

  it('evidence still decides between known readings, and a favourable measurement beats an unknown', () => {
    const cheap: MarketCandidate = { ...base, key: 'z-cheap', capitalUsd: 1_000, failureRate: 0.1 };
    const dear: MarketCandidate = { ...base, key: 'y-dear', capitalUsd: 100_000, failureRate: 0.5 };
    const blank: MarketCandidate = { ...base, key: 'a-blank', capitalUsd: null, failureRate: null };
    expect(rankMarkets([blank, dear, cheap]).map((m) => m.key)).toEqual(['z-cheap', 'y-dear', 'a-blank']);
  });

  it('an unknown that carries better economics can still win: the reading is a floor, not a veto', () => {
    const known: MarketCandidate = { ...base, key: 'known', capitalUsd: 100_000 };
    const bigger: MarketCandidate = { ...base, key: 'bigger', capitalUsd: null, monthlyVolume: 10_000 };
    expect(rankMarkets([known, bigger])[0]!.key).toBe('bigger');
  });
});
