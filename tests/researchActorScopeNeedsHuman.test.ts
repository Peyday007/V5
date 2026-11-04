import { describe, expect, it } from 'vitest';
import { describesOwnAction } from '../server/services/research/actorScope.ts';

const FORBIDDEN = /\b(hire|purchase|subscribe to|call the|email the)\b/i;

describe('own-action screen: third parties doing the forbidden verb (PACKETS:NEEDS_HUMAN)', () => {
  it.each([
    'Which employers post roles and hire for this work, and at what published rate?',
    'How many subscribers purchase at the regional price, per the published pricing page?',
    'Record which agencies typically hire contractors for this delivery.',
    'Which buyers also purchase a bundle, according to the listing?',
  ])('does not read %s as Brain acting', (prose) => {
    expect(describesOwnAction(prose, FORBIDDEN)).toBe(false);
  });

  it.each([
    'Hire a contractor to translate the document.',
    'Find the listing and purchase the subscription.',
    'We will hire a translator and record the quote.',
    'Employers post roles; you should hire one and report the cost.',
    'Call the buyer and ask the price.',
  ])('still refuses the instruction %s', (prose) => {
    expect(describesOwnAction(prose, FORBIDDEN)).toBe(true);
  });
});
