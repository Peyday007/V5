import { describe, expect, it } from 'vitest';
import {
  FAILURE_CLASSES, MAX_ATTEMPTS, backoffMs, BACKOFF_CAP_MS, classifyFailure, decideFailure,
} from '../server/services/routing/failures/index.ts';

describe('classifyFailure', () => {
  it('reads declared and structural facts before message text', () => {
    expect(classifyFailure({ httpStatus: 429 })).toBe('RATE_LIMITED');
    expect(classifyFailure({ httpStatus: 503 })).toBe('TRANSIENT_PROVIDER');
    expect(classifyFailure({ error: 'ECONNRESET' })).toBe('TRANSIENT_PROVIDER');
    expect(classifyFailure({ outputInvalid: true })).toBe('MALFORMED_OUTPUT');
    expect(classifyFailure({ missingInputs: ['price'] })).toBe('MISSING_INPUT');
    expect(classifyFailure({ sourceFailed: true, outputInvalid: true })).toBe('SOURCE_UNAVAILABLE');
    expect(classifyFailure({ providerDown: true })).toBe('PROVIDER_DOWN');
    expect(classifyFailure({ reasoningInsufficient: true })).toBe('CAPABILITY_GAP');
    expect(classifyFailure({ unsolvable: true })).toBe('UNSOLVABLE');
    expect(classifyFailure({ declared: 'UNSOLVABLE', httpStatus: 429 })).toBe('UNSOLVABLE');
  });
  it('never reads an unknown failure as a capability gap', () => {
    expect(classifyFailure({ error: 'weird' })).not.toBe('CAPABILITY_GAP');
  });
});

describe('backoff', () => {
  it('doubles, is capped, and honours a provider retry-after', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(30)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(1, 200_000)).toBe(200_000);
    expect(backoffMs(1, 10 * BACKOFF_CAP_MS)).toBe(BACKOFF_CAP_MS);
  });
});

describe('decideFailure', () => {
  it('backs off transient failures, then stops at the cap and releases capacity', () => {
    const a = decideFailure({ evidence: { httpStatus: 503 }, lane: 'CHEAP', attempts: 1 });
    expect(a.response).toBe('BACKOFF_RETRY_SAME');
    expect(a.retryAfterMs).toBe(30_000);
    expect(a.releaseCapacity).toBe(true);
    const b = decideFailure({ evidence: { httpStatus: 503 }, lane: 'CHEAP', attempts: MAX_ATTEMPTS.TRANSIENT_PROVIDER });
    expect(b.response).toBe('STOP');
    expect(b.nextLane).toBeNull();
    expect(b.releaseCapacity).toBe(true);
  });
  it('never escalates source outages or missing input', () => {
    for (const lane of ['CODE', 'CHEAP', 'STRONG'] as const) {
      for (const attempts of [1, 2, 5]) {
        const s = decideFailure({ evidence: { sourceFailed: true }, lane, attempts });
        const m = decideFailure({ evidence: { missingInputs: ['x'] }, lane, attempts });
        expect(s.response).not.toBe('ESCALATE');
        expect(m.response).toBe('ASK_FOR_INPUT');
        expect(m.nextLane).toBeNull();
      }
    }
    expect(decideFailure({ evidence: { sourceFailed: true }, lane: 'CHEAP', attempts: 1, alternativeSource: true }).response).toBe('OTHER_SOURCE');
  });
  it('retries malformed cheap output on the cheap lane before escalating', () => {
    const first = decideFailure({ evidence: { outputInvalid: true }, lane: 'CHEAP', attempts: 1 });
    expect(first.response).toBe('BACKOFF_RETRY_SAME');
    expect(first.nextLane).toBe('CHEAP');
    const repaired = decideFailure({ evidence: { outputInvalid: true }, lane: 'CHEAP', attempts: 1, repairAvailable: true });
    expect(repaired.response).toBe('KNOWN_REPAIR');
    expect(repaired.nextLane).toBe('CHEAP');
    const spent = decideFailure({ evidence: { outputInvalid: true }, lane: 'CHEAP', attempts: MAX_ATTEMPTS.MALFORMED_OUTPUT });
    expect(spent.response).toBe('ESCALATE');
    expect(spent.nextLane).toBe('STRONG');
  });
  it('escalates only a capability gap', () => {
    const escalating = FAILURE_CLASSES.filter((c) =>
      (['CODE', 'CHEAP', 'STRONG'] as const).some((lane) =>
        decideFailure({ evidence: { declared: c }, lane, attempts: 1 }).response === 'ESCALATE'));
    expect(escalating).toEqual(['CAPABILITY_GAP']);
    // malformed escalates only after its cap
    expect(decideFailure({ evidence: { reasoningInsufficient: true }, lane: 'CODE', attempts: 1 }).nextLane).toBe('CHEAP');
    expect(decideFailure({ evidence: { reasoningInsufficient: true }, lane: 'STRONG', attempts: 1 }).response).toBe('STOP');
  });
  it('hands a downed provider to another capable worker and stops UNSOLVABLE', () => {
    expect(decideFailure({ evidence: { providerDown: true }, lane: 'CHEAP', attempts: 1, alternativeWorker: true }).response).toBe('OTHER_CAPABLE_WORKER');
    expect(decideFailure({ evidence: { unsolvable: true }, lane: 'STRONG', attempts: 1 }).response).toBe('STOP');
  });
});
