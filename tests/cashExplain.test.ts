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

describe('the explanation reads the decision record', () => {
  const decision = {
    id: 'cdc_1', projectId: 'p', opportunityId: 'o', goalId: 'g', verdict: 'REJECT' as const,
    reason: 'CAPITAL_TOO_HIGH', detail: 'it needs 9000 against a limit of 100', bindingConstraint: 'capitalCeilingCents',
    missingFacts: [], evidenceIds: ['clm_1'], reopenCondition: "the goal's capital limit changes, or a route needing no capital is named",
    changeRef: 'x', isCurrent: true, recomputeChangeRef: null, recomputeRequestedAt: null, decidedAt: 't', supersededAt: null,
  };

  it('takes stance, reason, limit, missing facts and reopen condition from the decision, not from standing', () => {
    const e = explainStanding({ kind: 'ADVANCING', cause: null, keys: [], hasSourceClaim: true, decision, privateDetail: true });
    expect(e.stance).toBe('REJECTED');
    expect(e.reason).toMatch(/capital/);
    expect(e.bindingLimit).toContain('capitalCeilingCents');
    expect(e.reopenWhen).toEqual([decision.reopenCondition]);
    const held = explainStanding({
      kind: 'ADVANCING', cause: null, keys: [], hasSourceClaim: true,
      decision: { ...decision, verdict: 'HOLD', reason: 'MISSING_FACTS', bindingConstraint: null, missingFacts: ['a payer'] },
    });
    expect(held.stance).toBe('HELD');
    expect(held.missing).toEqual(['a payer']);
  });

  it('shows a member no figure from the decision detail', () => {
    const e = explainStanding({ kind: 'ADVANCING', cause: null, keys: [], hasSourceClaim: true, decision, privateDetail: false });
    expect([e.reason, e.bindingLimit].join(' ')).not.toMatch(/\d|capitalCeilingCents/);
  });

  it("never overrides a person's decline or finished money, and falls back to standing without a record", () => {
    const declined = explainStanding({ kind: 'NOT_WORTH_PURSUING', cause: 'DECLINED', keys: [], hasSourceClaim: true, decision: { ...decision, verdict: 'PRIORITIZE', reason: 'CLEAR' } });
    expect(declined.reason).toMatch(/passed on it/);
    expect(explainStanding({ kind: 'DONE', cause: null, keys: [], hasSourceClaim: true, decision }).stance).toBe('DONE');
    expect(explainStanding({ kind: 'ADVANCING', cause: null, keys: [], hasSourceClaim: true, decision: null }).stance).toBe('PRIORITIZED');
  });
});
