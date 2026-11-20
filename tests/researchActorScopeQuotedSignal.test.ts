import { describe, expect, it } from 'vitest';
import { describesOwnAction, ownActionMatches } from '../server/services/research/actorScope.ts';
import {
  APPROVAL_ENVELOPES,
  fillAssignmentTemplate,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import { validationScreenProfile } from '../server/services/russell/compilerProfiles.ts';
import { validationQuestion } from '../server/services/cash/validation.ts';
import type { CashOpportunity, ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

/*
 * OWNER:AUTHORIZING_RESEARCH_BRAIN_WAS_NOT_PREAUTHORIZED_TO_START_BR.
 *
 * Production, seven days to 2026-11-19: 17 of 152 Needs-You requests parked a
 * Cash screen as "Authorizing research Brain was not preauthorized to start".
 * The plan was Brain's own compiled question, which quotes the opening's
 * buying signal verbatim — and KashKick's signal says "Sign up for free". The
 * full stop before it made the listing's marketing copy read as an imperative
 * to the researcher, so Brain's envelope refused Brain's own plan.
 */
const KASHKICK =
  'KashKick is one of the fastest ways to start earning money online. Sign up for free, and ' +
  'within minutes you can begin completing paid surveys, playing mobile games, trying new apps ' +
  'and services and earning cashback online.';

const envelope = APPROVAL_ENVELOPES['RUSSELL_CASH_VALIDATION_V1']!;
const forbidden = envelope.forbiddenActions;

describe('a quoted source passage is the source speaking, not Brain acting', () => {
  it('admits the compiled screen plan for the KashKick opening', () => {
    const opening = {
      title: 'KashKick',
      buyingSignal: KASHKICK,
      source: 'https://kashkick.com/',
      signalObservedAt: '2026-11-12',
    } as unknown as CashOpportunity;
    const screen = validationScreenProfile('RUSSELL_CASH_VALIDATION_V1')!;
    const question = validationQuestion(opening, 'SCREEN');
    expect(question).toContain('Before anything else is asked about this specific opening');
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

  it.each([
    `Before anything else is asked about this specific opening — "${KASHKICK}" — settle the three questions that can each end it.`,
    `For this specific opening — "${KASHKICK}" — establish one thing from published sources.`,
    `For this specific opening — “${KASHKICK}” — establish one thing from published sources.`,
  ])('does not read the quoted signal as an instruction: %s', (prose) => {
    expect(ownActionMatches(prose, forbidden)).toEqual([]);
  });

  it.each([
    // Outside the quotes, after them.
    'For this opening — "Great deal" — sign up for the account and record the price.',
    // Outside the quotes, before them.
    'Sign up for the trial, then record what the page says: "Free for 30 days".',
    // An unmatched quote exempts nothing.
    '"Sign up for the trial and record the price.',
    // Quotation that is the whole prose cannot launder an instruction.
    '"Sign up for the trial and record the price."',
    '“Purchase the supplier list and record its price.”',
    // Between two quoted spans.
    'Compare "plan A" with "plan B". Purchase the cheaper one.',
  ])('still refuses Brain’s own action: %s', (prose) => {
    expect(describesOwnAction(prose, forbidden)).toBe(true);
  });
});
