/**
 * A decision explained in words: every standing kind has a reason, the limit
 * that binds, what is missing and what would reopen it — and none of it is a
 * number, a score or a percentage, or a figure from a private row.
 */
import { describe, expect, it } from 'vitest';
import { STANDING_KINDS } from '../server/domain/types.ts';
import { explainStanding, keyInWords } from '../server/services/cash/standingSurface.ts';
import { decisionLines } from '../client/src/lib/cashDecision.ts';

const SAMPLES = [
  { kind: 'ADVANCING', cause: null, keys: [] },
  { kind: 'WAITING', cause: null, keys: ['FIELD:payer', 'CAPABILITY:SEND_A_MESSAGE', 'SLOT', 'CASH'] },
  { kind: 'DORMANT', cause: 'ROUNDS_SPENT', keys: ['EVIDENCE:payer'], reconsiderationRequested: true },
  { kind: 'NOT_WORTH_PURSUING', cause: 'DUPLICATE', keys: [] },
  { kind: 'DONE', cause: null, keys: [] },
] as const;

describe('explaining a decision', () => {
  it('covers every standing kind, in words, with no score or percentage', () => {
    expect(new Set(SAMPLES.map((s) => s.kind))).toEqual(new Set(STANDING_KINDS));
    for (const sample of SAMPLES) {
      const e = explainStanding({ ...sample, hasSourceClaim: true });
      const text = [e.headline, ...decisionLines(e).map((l) => l.text)].join(' ');
      expect(text).not.toMatch(/%|\bscore\b|\bprobabilit/i);
      expect(text).not.toMatch(/\d/);
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.bindingLimit.length).toBeGreaterThan(0);
    }
  });

  it('names what a held piece is missing, and what would release it', () => {
    const e = explainStanding({ kind: 'WAITING', cause: null, keys: ['FIELD:payer'], hasSourceClaim: true });
    expect(e.stance).toBe('HELD');
    expect(e.missing).toEqual(['the missing fact "payer" on its card']);
    expect(e.reopenWhen[0]).toContain('payer');
    expect(e.furtherResearch).toMatch(/narrow factual question/);
  });

  it('says a rejected piece has nothing that would reopen it and needs no research', () => {
    const e = explainStanding({ kind: 'NOT_WORTH_PURSUING', cause: 'EXPIRED', keys: [], hasSourceClaim: false });
    expect(e.stance).toBe('REJECTED');
    expect(e.reason).toMatch(/closing date/);
    expect(e.reopenWhen).toEqual([]);
    expect(e.evidence.join(' ')).toMatch(/No sourced claim/);
    expect(decisionLines(e).find((l) => l.label === 'What would reopen it')!.text).toMatch(/Nothing is named/);
  });

  it('a dormant piece reopens on its named conditions, and says when one has changed', () => {
    const e = explainStanding({ kind: 'DORMANT', cause: 'ROUNDS_SPENT', keys: ['EVIDENCE:payer'], hasSourceClaim: true, reconsiderationRequested: true });
    expect(e.reopenWhen).toEqual(['evidence about payer changes']);
    expect(e.furtherResearch).toMatch(/has changed/);
  });

  it('writes keys as a person would say them', () => {
    expect(keyInWords('CASH')).toBe('cash that can be deployed');
    expect(keyInWords('CAPABILITY:SEND_A_MESSAGE')).toContain('send a message');
    expect(keyInWords('PERSON')).toMatch(/only a person/);
  });
});
