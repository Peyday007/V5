import { describe, expect, it } from 'vitest';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import {
  APPROVAL_ENVELOPES,
  fillAssignmentTemplate,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import { profileFor, validationScreenProfile } from '../server/services/russell/compilerProfiles.ts';
import { validationQuestion } from '../server/services/cash/validation.ts';
import type { CashOpportunity, ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

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

/*
 * The stage-one screen (OPPORTUNITY-INTELLIGENCE §3.3(a)) runs under the same
 * envelope, the same gate and the same per-lane floors as the full dive. Only
 * the order of asking changed.
 */
describe('the stage-one screen passes the same envelope', () => {
  const envelope = APPROVAL_ENVELOPES['RUSSELL_CASH_VALIDATION_V1']!;
  const opening = {
    title: 'RFP',
    buyingSignal: 'The county published request 2026-441 for ownership research, closing 30 October 2026.',
    source: 'https://example.gov/rfp',
    signalObservedAt: '2026-09-20',
  } as unknown as CashOpportunity;

  it('admits the screen question the compiler writes', () => {
    expect(ownActionMatches(validationQuestion(opening, 'SCREEN'), envelope.forbiddenActions)).toEqual([]);
  });

  it('asks only the kill lanes, each the full profile’s own lane object', () => {
    const full = profileFor('RUSSELL_CASH_VALIDATION_V1')!;
    const screen = validationScreenProfile('RUSSELL_CASH_VALIDATION_V1')!;
    expect(screen.id).toBe('COMMERCIAL_VALIDATION_SCREEN');
    expect(screen.lanes.map((lane) => lane.id).sort()).toEqual(['disqualifier', 'payer', 'ruled_out']);
    for (const lane of screen.lanes) {
      // Identical, so the evidence kind, necessity and per-lane floor cannot differ.
      expect(full.lanes.find((one) => one.id === lane.id)).toBe(lane);
    }
    expect(screen.proposedSources).toBe(full.proposedSources);
    expect(screen.excludedSources).toBe(full.excludedSources);
    // Nothing else can be narrowed by it.
    expect(validationScreenProfile('RUSSELL_CASH_DISCOVERY_V1')).toBeNull();
  });

  it('a compiled screen plan fits the envelope', () => {
    const screen = validationScreenProfile('RUSSELL_CASH_VALIDATION_V1')!;
    const question = validationQuestion(opening, 'SCREEN');
    const geography = 'Westfield County, Ohio';
    const assignment = fillAssignmentTemplate(envelope.assignmentTemplate!, {
      QUESTION: question,
      JURISDICTION: geography,
    });
    const verdict = planFitsEnvelope({
      envelope,
      orchestration: { assignment, fixture: false, unresolvedGapPolicy: null } as unknown as ResearchOrchestration,
      fragments: [
        {
          fragmentKey: screen.fragmentKey,
          question,
          definitions: null,
          population: null,
          geography,
          completionCriteria: screen.completionCriteria(geography),
          acceptableSourceTypes: screen.proposedSources.filter((one) => envelope.allowedSourceTypes.test(one)),
          excludedSourceTypes: screen.excludedSources,
          requiredEvidence: screen.lanes,
          minIndependentSources: Math.max(1, envelope.minIndependentSourcesFloor),
        } as unknown as ResearchFragment,
      ],
    });
    expect(verdict.reasons).toEqual([]);
    expect(verdict.fits).toBe(true);
  });
});
