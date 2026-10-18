/**
 * Preparing a decision a person makes outside Brain.
 *
 * A prepared decision is Brain's draft of everything a person needs to act on
 * a preliminary opening — the buyer's request as published, a scope, a price
 * and its basis, a fulfilment route, when cash would arrive, what is still
 * open, a finished proposal, and what stands in the way of submitting it. It
 * moves no state: the opening's tier, the card gate, the commercial authority
 * and every capability reading are untouched, and nothing here submits,
 * registers, bids or spends. A person reads it and decides.
 *
 * Validation is strict for §8's reason: an unknown field refuses the whole
 * input, so nothing can arrive dressed as an approval or a sent proposal.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import {
  latestPreparedForProject,
  recordPreparedDecision,
  type PreparedContent,
  type PreparedDecision,
} from '../../repos/cashPrepared.ts';

const STRING_FIELDS = [
  'buyerRequest',
  'buyerRequestUrl',
  'observedAt',
  'observedStatus',
  'scope',
  'priceProposal',
  'priceBasis',
  'fulfillment',
  'cashTiming',
  'proposalText',
  'decisionNeeded',
] as const;
const LIST_FIELDS = ['openQuestions', 'submissionBlockers'] as const;
const ALLOWED = new Set<string>(['opportunityId', ...STRING_FIELDS, ...LIST_FIELDS]);
const MAX_TEXT = 8000;

export class PreparedDecisionError extends Error {}

export function validatePrepared(input: unknown): { opportunityId: string; content: PreparedContent } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PreparedDecisionError('A prepared decision is a JSON object.');
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ALLOWED.has(key));
  if (unknown.length > 0) {
    throw new PreparedDecisionError(`Unknown field(s): ${unknown.join(', ')}. Nothing was recorded.`);
  }
  const text = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new PreparedDecisionError(`"${key}" is required and must be a non-empty string.`);
    }
    if (value.length > MAX_TEXT) throw new PreparedDecisionError(`"${key}" is longer than ${MAX_TEXT} characters.`);
    return value.trim();
  };
  const sentences = (key: string): string[] => {
    const value = record[key];
    if (!Array.isArray(value) || value.some((one) => typeof one !== 'string' || one.trim() === '')) {
      throw new PreparedDecisionError(`"${key}" must be a list of non-empty sentences.`);
    }
    return value.map((one) => (one as string).trim());
  };
  const opportunityId = text('opportunityId');
  const url = text('buyerRequestUrl');
  if (!/^https?:\/\//i.test(url)) throw new PreparedDecisionError('"buyerRequestUrl" must be an http(s) URL.');
  const observedAt = text('observedAt');
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new PreparedDecisionError('"observedAt" must be an ISO-8601 time.');
  }
  return {
    opportunityId,
    content: {
      buyerRequest: text('buyerRequest'),
      buyerRequestUrl: url,
      observedAt: new Date(observedAt).toISOString(),
      observedStatus: text('observedStatus'),
      scope: text('scope'),
      priceProposal: text('priceProposal'),
      priceBasis: text('priceBasis'),
      fulfillment: text('fulfillment'),
      cashTiming: text('cashTiming'),
      openQuestions: sentences('openQuestions'),
      proposalText: text('proposalText'),
      submissionBlockers: sentences('submissionBlockers'),
      decisionNeeded: text('decisionNeeded'),
    },
  };
}

/** Validate and record; refuses an opportunity outside the project. */
export async function prepareDecision(input: {
  projectId: string;
  body: unknown;
}): Promise<{ decision: PreparedDecision; written: boolean }> {
  const { opportunityId, content } = validatePrepared(input.body);
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) {
    throw new PreparedDecisionError(`No opportunity ${opportunityId} in this project.`);
  }
  return recordPreparedDecision({ projectId: input.projectId, opportunityId, content });
}

export async function preparedDecisions(projectId: string): Promise<PreparedDecision[]> {
  return latestPreparedForProject(projectId);
}
