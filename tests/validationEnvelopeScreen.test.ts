import { describe, expect, it } from 'vitest';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';
import { validationQuestion } from '../server/services/cash/validation.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

/*
 * Brain's own compiled deep-dive question must pass Brain's own envelope.
 *
 * Production, 2026-10-07: `orc_0029a3b7251a49b1971a` was refused for
 * "instructs the researcher to telephone call". The text was the question
 * `validationQuestion` writes for every opening — "…and whether the only
 * published route to the buyer is a telephone call" — whose governor sits more
 * than forty characters back. Every Cash deep dive therefore parked for a
 * person on a decision nobody needed to make.
 */
describe('a Cash deep dive is not refused by its own envelope', () => {
  const pattern = APPROVAL_ENVELOPES['RUSSELL_CASH_VALIDATION_V1']!.forbiddenActions;

  it('admits the question the compiler writes for an ordinary opening', () => {
    const question = validationQuestion({
      title: 'RFP',
      buyingSignal:
        'The RFP states a firm, stated closing date of September 25, 2026, 5:00 PM Central time.',
      source: 'https://example.gov/rfp',
      signalObservedAt: '2026-09-20',
    } as unknown as CashOpportunity);
    expect(ownActionMatches(question, pattern)).toEqual([]);
  });

  it('still refuses an instruction to make the call, however it is phrased', () => {
    for (const text of [
      'Telephone call the buyer and ask for their price.',
      'The next step is to call the buyer directly.',
      'Find the procurement officer and then email the buyer.',
      'We will then contact the seller about terms.',
    ]) {
      expect(ownActionMatches(text, pattern).length, text).toBeGreaterThan(0);
    }
  });

  it('reads a phrase that completes "is a" as the thing described', () => {
    for (const text of [
      'Record whether the only route to the buyer is a telephone call.',
      'Say plainly if the published route was a phone call rather than a portal.',
    ]) {
      expect(ownActionMatches(text, pattern), text).toEqual([]);
    }
  });
});
