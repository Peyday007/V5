/**
 * Reuse before research: a current answer is reused, a stale one is not, and
 * only the missing or old part is left to investigate.
 */
import { describe, expect, it } from 'vitest';
import { decideReuse, DEFAULT_FRESHNESS_DAYS, whyNotCurrent } from '../server/services/routing/reuse/reuse.ts';
import type { ExistingClaim } from '../server/domain/types.ts';

const NOW = '2026-10-30T00:00:00.000Z';

function claim(id: string, patch: Partial<ExistingClaim> = {}): ExistingClaim {
  return {
    id,
    projectId: 'p',
    documentId: 'd',
    extractionRunId: null,
    layerId: null,
    claim: 'x',
    claimType: 'FACT',
    page: null,
    blockIndex: null,
    charStart: null,
    charEnd: null,
    locator: null,
    sourceUrl: 'https://example.com',
    sourceTitle: null,
    sourcePublisher: null,
    sourceDate: '2026-08-01',
    retrievedAt: null,
    supportingPassage: null,
    geography: null,
    timeframe: null,
    population: null,
    definition: null,
    extractionConfidence: 1,
    evidenceConfidence: 1,
    contradictionState: 'UNCHALLENGED',
    verificationState: 'VERIFIED',
    verificationDetail: null,
    priorAuditId: null,
    documentVersion: null,
    superseded: false,
    contentHash: 'h',
    createdAt: NOW,
    ...patch,
  } as ExistingClaim;
}

const base = { status: 'SATISFIED' as const, needsResearch: false, now: NOW };

describe('reuse before research', () => {
  it('reuses a current answer', () => {
    const d = decideReuse({ ...base, claimIds: ['a'], claims: [claim('a')] });
    expect(d.verdict).toBe('REUSE');
    expect(d.windowDays).toBe(DEFAULT_FRESHNESS_DAYS);
  });

  it('does not reuse a stale answer as current', () => {
    const d = decideReuse({ ...base, claimIds: ['a'], claims: [claim('a', { sourceDate: '2022-01-01' })] });
    expect(d.verdict).toBe('STALE');
    expect(d.notCurrent[0]?.reason).toMatch(/older than/);
  });

  it('honours a per-question freshness window', () => {
    const c = claim('a', { sourceDate: '2026-08-01' });
    expect(decideReuse({ ...base, claimIds: ['a'], claims: [c], freshnessDays: 30 }).verdict).toBe('STALE');
    expect(decideReuse({ ...base, claimIds: ['a'], claims: [c], freshnessDays: 120 }).verdict).toBe('REUSE');
  });

  it('investigates only the part that is not current', () => {
    const d = decideReuse({
      ...base,
      claimIds: ['a', 'b'],
      claims: [claim('a'), claim('b', { sourceDate: '2020-01-01' })],
    });
    expect(d.verdict).toBe('PARTIAL');
    expect(d.currentClaimIds).toEqual(['a']);
    expect(d.notCurrent.map((n) => n.claimId)).toEqual(['b']);
  });

  it('never reuses an undated, contested, rejected or unreadable claim', () => {
    expect(whyNotCurrent(claim('a', { sourceDate: null }), 365, NOW)).toBe('no source date');
    expect(whyNotCurrent(claim('a', { contradictionState: 'CONTESTED' }), 365, NOW)).toMatch(/contradiction/);
    expect(whyNotCurrent(claim('a', { verificationState: 'REJECTED' }), 365, NOW)).toMatch(/verification/);
    expect(decideReuse({ ...base, claimIds: ['gone'], claims: [] }).verdict).toBe('STALE');
  });

  it('reuses nothing unless coverage already called it satisfied', () => {
    for (const status of ['MISSING', 'PARTIALLY_SATISFIED', 'STALE', 'PRESENT_BUT_UNVERIFIED'] as const) {
      expect(decideReuse({ ...base, status, claimIds: ['a'], claims: [claim('a')] }).verdict).toBe('INVESTIGATE');
    }
    expect(decideReuse({ ...base, needsResearch: true, claimIds: ['a'], claims: [claim('a')] }).verdict).toBe('INVESTIGATE');
  });
});
