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

  // Production, 2026-11-02: orc_d083edfc645c47e6b99d's judge follow-up was
  // refused for "instructs the researcher to purchase". A hyphenated compound
  // names a kind of business; the verb on its own is still refused.
  it('reads a hyphenated compound as a name, and still refuses the verb', () => {
    const discovery = APPROVAL_ENVELOPES['RUSSELL_CASH_DISCOVERY_V1']!.forbiddenActions;
    const judge =
      'Which published group-purchase operators (for example heating-oil or freight co-ops and ' +
      'bulk-buy clubs) publish an arranger fee or commission, a minimum run size and two dated runs?';
    expect(ownActionMatches(judge, discovery)).toEqual([]);
    expect(ownActionMatches('Record the purchase-order terms each buyer publishes.', discovery)).toEqual([]);
    expect(ownActionMatches('Purchase the supplier list and record its price.', discovery).length).toBeGreaterThan(0);
  });

  // Production, 2026-11-02: orc_eefa0aa5fb194685b079's judge follow-up asked
  // for buyers' "purchase frequency" and was refused, so the buyer-economics
  // question was cancelled unresearched.
  it('reads a modifier or a third party’s verb as subject matter, and still refuses Brain’s own', () => {
    const discovery = APPROVAL_ENVELOPES['RUSSELL_CASH_DISCOVERY_V1']!.forbiddenActions;
    for (const text of [
      'Which kinds of buyers repeatedly pay for spreadsheet or website work, each with a published directory count, purchase frequency and the price they pay?',
      'Which small firms that hire freelancers for presentation work publish what they paid?',
      'Record the purchase price and purchase volume each listing states.',
    ]) {
      expect(ownActionMatches(text, discovery), text).toEqual([]);
    }
    for (const text of [
      'Purchase the directory and count its members.',
      'Purchase data from the directory.',
      'Purchase records from the county.',
      'Purchase order forms from the supplier.',
      'Find the cheapest supplier, then we will purchase the list.',
      'Hire a contractor to build the sample.',
      'Find the vendor that we purchase from and purchase it.',
    ]) {
      expect(ownActionMatches(text, discovery).length, text).toBeGreaterThan(0);
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

  it('asks a recurring arrangement for a named buyer who paid, not for the one payer it does not have', () => {
    const recurring = {
      ...opening,
      title: 'Shared EDDM postcards',
      buyingSignal: 'Local businesses repeatedly buy shared Every Door Direct Mail postcard campaigns.',
      opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
    } as unknown as CashOpportunity;
    const question = validationQuestion(recurring, 'SCREEN');
    expect(ownActionMatches(question, envelope.forbiddenActions)).toEqual([]);
    expect(question).toMatch(/names as having paid for this kind of work/);
    expect(question).toMatch(/reaches more buyers of that kind/);
    expect(question).not.toMatch(/this specific opening/);
    // A one-off opening keeps its own question.
    expect(validationQuestion(opening, 'SCREEN')).toMatch(/this specific opening/);
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

/*
 * Recommended-approach change #5 (2026-10-15): the Artisanal Sudoku opening's
 * second dive re-asked the whole qualification and left `directCosts` blank —
 * nothing is bought to make a puzzle, so no source publishes that cost. A
 * second full round now asks the open lanes by name, says a documented absence
 * is an answer, and still restates the payer the gate requires.
 */
describe('a second full dive asks what the first left open, by lane', () => {
  const envelope = APPROVAL_ENVELOPES['RUSSELL_CASH_VALIDATION_V1']!;
  const opening = {
    title: 'Puzzle submissions',
    buyingSignal: 'Artisanal Sudoku pays $50 per accepted original puzzle.',
    source: 'https://artisanalsudoku.substack.com/p/submissions',
    signalObservedAt: '2026-10-14',
  } as unknown as CashOpportunity;

  it('names cost_evidence, invites a NEGATIVE_EXISTENCE answer, and keeps the payer', () => {
    const question = validationQuestion(opening, 'FULL', [
      'delivery',
      'directCosts',
      'requiredCapital',
      'recommendation',
    ]);
    expect(question).toContain('cost_evidence (directCosts)');
    expect(question).toContain('NEGATIVE_EXISTENCE');
    expect(question).toMatch(/restated in the payer lane/);
    // Not the whole qualification again, and nothing composed is asked as a lane.
    expect(question).not.toContain('what comparable work is published at');
    expect(question).not.toMatch(/\(delivery\)|\(recommendation\)/);
    expect(ownActionMatches(question, envelope.forbiddenActions)).toEqual([]);
  });

  it('asks the whole qualification on a first round, or when nothing open has a lane', () => {
    const whole = validationQuestion(opening, 'FULL');
    expect(whole).toContain('what comparable work is published at');
    expect(validationQuestion(opening, 'FULL', ['recommendation'])).toBe(whole);
  });
});
