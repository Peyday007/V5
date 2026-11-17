import { describe, expect, it } from 'vitest';
import { FUNNEL_STAGES, funnelGain, readFunnel, readStage, type FunnelInput, type FunnelRecord } from '../server/services/knowledge/funnel.ts';

const now = new Date('2026-11-17T00:00:00Z');
const rec = (id: string, extra: Partial<FunnelRecord> = {}): FunnelRecord => ({ id, fingerprint: `fp-${id}`, observedAt: '2026-11-16T00:00:00Z', ...extra });

describe('intelligence funnel (KNOW-25-1, no false speed)', () => {
  it('counts each of the six stages from its own records, never inferred from another', () => {
    const input: FunnelInput = {
      RAW_INTAKE: [rec('a'), rec('b'), rec('c')],
      PARSED: [rec('a')],
      // NORMALIZED_FACTS deliberately absent
      EVIDENCE_ACCEPTED: [rec('e1'), rec('e2')],
      RELATIONSHIPS_UPDATED: [rec('r1')],
      GOAL_DECISIONS: [],
    };
    const reading = readFunnel(input, { now });
    expect(reading.stages.map((s) => s.stage)).toEqual([...FUNNEL_STAGES]);
    expect(reading.stages.map((s) => s.raw)).toEqual([3, 1, 0, 2, 1, 0]);
    expect(reading.stages.map((s) => s.usable)).toEqual([3, 1, 0, 2, 1, 0]);
    // raw intake is not intelligence
    expect(reading.usableIntelligence).toBe(4);
  });

  it('excludes duplicates, stale, contested and unverified records and counts each reason', () => {
    const stage = readStage(
      'NORMALIZED_FACTS',
      [
        rec('ok'),
        rec('dup', { fingerprint: 'fp-ok' }),
        rec('old', { observedAt: '2026-01-01T00:00:00Z' }),
        rec('marked', { status: 'STALE' }),
        rec('fight', { status: 'CONTESTED' }),
        rec('unchecked', { verified: false }),
      ],
      { now, staleAfterMs: 30 * 86_400_000 },
    );
    expect(stage.raw).toBe(6);
    expect(stage.usable).toBe(1);
    expect(stage.excluded).toEqual({ DUPLICATE: 1, STALE: 2, CONTESTED: 1, UNVERIFIED: 1 });
  });

  it('a record with no observation date is stale only when its own status says so', () => {
    const stage = readStage('PARSED', [rec('x', { observedAt: null }), rec('y', { observedAt: null, status: 'STALE' })], { now, staleAfterMs: 1 });
    expect(stage.usable).toBe(1);
    expect(stage.excluded.STALE).toBe(1);
  });

  it('doubling intake of duplicates leaves usable intelligence unchanged and is flagged as false speed', () => {
    const base: FunnelInput = {
      RAW_INTAKE: [rec('a'), rec('b')],
      PARSED: [rec('a'), rec('b')],
      NORMALIZED_FACTS: [rec('fa'), rec('fb')],
      EVIDENCE_ACCEPTED: [rec('fa')],
    };
    const doubled: FunnelInput = {
      RAW_INTAKE: [...base.RAW_INTAKE!, rec('a2', { fingerprint: 'fp-a' }), rec('b2', { fingerprint: 'fp-b' })],
      PARSED: [...base.PARSED!, rec('a2', { fingerprint: 'fp-a' }), rec('b2', { fingerprint: 'fp-b' })],
      NORMALIZED_FACTS: [...base.NORMALIZED_FACTS!, rec('fa2', { fingerprint: 'fp-fa' }), rec('fb2', { fingerprint: 'fp-fb' })],
      EVIDENCE_ACCEPTED: base.EVIDENCE_ACCEPTED,
    };
    const before = readFunnel(base, { now });
    const after = readFunnel(doubled, { now });
    expect(after.raw).toBeGreaterThan(before.raw);
    expect(after.usableIntelligence).toBe(before.usableIntelligence);
    expect(after.excluded.DUPLICATE).toBe(6);
    expect(funnelGain(before, after)).toEqual({ raw: 6, usableIntelligence: 0, falseSpeed: true });
  });

  it('a faster import of stale records adds no usable intelligence', () => {
    const before = readFunnel({ NORMALIZED_FACTS: [rec('n')] }, { now, staleAfterMs: 86_400_000 * 7 });
    const after = readFunnel(
      { NORMALIZED_FACTS: [rec('n'), rec('s1', { observedAt: '2025-01-01T00:00:00Z' }), rec('s2', { observedAt: '2025-02-01T00:00:00Z' })] },
      { now, staleAfterMs: 86_400_000 * 7 },
    );
    expect(funnelGain(before, after)).toEqual({ raw: 2, usableIntelligence: 0, falseSpeed: true });
  });

  it('genuinely new usable records are a real gain', () => {
    const before = readFunnel({ NORMALIZED_FACTS: [rec('n')] }, { now });
    const after = readFunnel({ NORMALIZED_FACTS: [rec('n'), rec('m')] }, { now });
    expect(funnelGain(before, after)).toEqual({ raw: 1, usableIntelligence: 1, falseSpeed: false });
  });
});
