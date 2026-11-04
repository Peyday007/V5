import { describe, expect, it } from 'vitest';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import { APPROVAL_ENVELOPES, planFitsEnvelope } from '../server/services/research/approvalEnvelope.ts';

const pattern = APPROVAL_ENVELOPES['RUSSELL_CASH_DISCOVERY_V1']!.forbiddenActions;

describe('own-action screen: third parties and nouns are subject matter', () => {
  it.each([
    'a buyer cannot purchase directly and must instead go through a licensed broker',
    'In states restricted to Public Buyers, bidders may not purchase directly',
    'Is there a published price for a new ARFF vehicle, or a Canadian purchase of one',
    'whether they can purchase without a licence',
  ])('admits: %s', (text) => {
    expect(ownActionMatches(text, pattern)).toEqual([]);
  });

  it.each([
    'Purchase the list',
    'find the listing and purchase it',
    'we will purchase the data',
    'you must purchase access',
    'then hire a contractor',
    'make a purchase of the data',
    'a buyer cannot purchase directly, so we will purchase the list',
    'the buyers like it; Brain should purchase the report',
    'it should purchase the report',
    'they should purchase the data',
    // A causative makes the act Brain's whatever third-party shape follows it (merged with #491).
    'make buyers purchase the report',
    'have customers purchase the plan',
    'get bidders to purchase it, then make users subscribe',
  ])('still refuses: %s', (text) => {
    expect(ownActionMatches(text, pattern).length).toBeGreaterThan(0);
  });

  it('fits a discovery plan carrying the IAAI public-buyer sentence', () => {
    const envelope = APPROVAL_ENVELOPES['RUSSELL_CASH_DISCOVERY_V1']!;
    const verdict = planFitsEnvelope({
      envelope,
      assignmentAlreadyApproved: true,
      orchestration: { fixture: false, unresolvedGapPolicy: null, assignment: '' } as never,
      fragments: [{
        fragmentKey: 'f1',
        question: 'IAAI publishes that in states restricted to Public Buyers, a buyer cannot purchase directly and must instead go through a broker.',
        geography: 'US',
        acceptableSourceTypes: ['company website'],
        minIndependentSources: 1,
        requiredEvidence: [{ id: 'x' }],
        completionCriteria: [],
        definitions: null,
        population: null,
      }] as never,
    });
    expect(verdict.reasons.filter((r) => /instructs the researcher/.test(r))).toEqual([]);
  });
});
