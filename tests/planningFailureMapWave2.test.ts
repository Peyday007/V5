/**
 * Wave 2 of the planning failure map: the mechanisms the root-cause challenge
 * (2026-11-26) found the first map missed — a fall-through with no competence
 * floor, output budgets a reasoning model spends on hidden reasoning, and an
 * owner's labour offer that never reached the prompts actually sent.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_TOKENS, ROUTE_UNFIT_MODEL_LABELS, routeContext } from '../server/services/goals/routeProposal.ts';
import { ownerLabourOffer, ownerLabourWithHours, operatingModelSentenceFor, OPERATING_MODEL_SENTENCE } from '../server/domain/operatingModel.ts';

describe('no route ask is answered by a model measured unfit for it', () => {
  it('names the production fallback combo (model exam: 1 of 30, 0 of 11 on planning) as unfit', () => {
    expect(ROUTE_UNFIT_MODEL_LABELS).toContain('free:auto/best-coding');
  });
  it('gives a reasoning model room to reason and answer (exam at 16,000 tokens: 0 of 47 empty)', () => {
    expect(ROUTE_TOKENS.route).toBeGreaterThanOrEqual(12_000);
    expect(ROUTE_TOKENS.critique).toBeGreaterThanOrEqual(8_000);
    expect(ROUTE_TOKENS.direction).toBeGreaterThanOrEqual(10_000);
  });
  it('routeContext is exported for the probe that measures the production ask', () => {
    expect(typeof routeContext).toBe('function');
  });
});

describe("an owner who gives the goal hours has offered their work, and the prompt says so", () => {
  const cases: [string, { perWeek?: number | null; total?: number | null }][] = [
    ['I live in Manchester and need £1,000 within 30 days. I can work full time, 40 hours a week.', { perWeek: 40 }],
    ["I'd like $800 a month starting in January, working no more than 10 hours a week from home.", { perWeek: 10 }],
    ['I need $5,000 in the next 60 days and can work 40 hours a week.', { perWeek: 40 }],
  ];
  for (const [words, hours] of cases) {
    it(`"${words.slice(0, 60)}…" lifts the standing no-physical-work rule`, () => {
      const labour = ownerLabourWithHours(ownerLabourOffer(words), hours, words);
      expect(labour.offered).toBe(true);
      expect(operatingModelSentenceFor(labour)).not.toBe(OPERATING_MODEL_SENTENCE);
    });
  }
  it("an hours limit on the owner's own oversight time lifts nothing (§91: the owner does no physical work)", () => {
    const words = 'Earn 5,000 dollars a month in recurring revenue within 60 days, with no more than 10 hours a week of owner time.';
    expect(ownerLabourWithHours(ownerLabourOffer(words), { perWeek: 10 }, words).offered).toBe(false);
  });
  it('hours a target carries that the words never state lift nothing', () => {
    expect(ownerLabourWithHours(ownerLabourOffer('Collect settled cash'), { total: 200 }, 'Collect settled cash').offered).toBe(false);
  });
  it('an explicit refusal outranks stated hours', () => {
    const labour = ownerLabourWithHours(ownerLabourOffer("I'm not going to do any of the work myself."), { perWeek: 2 });
    expect(labour.offered).toBe(false);
  });
  it('no stated hours and no offer leaves the standing rule in place', () => {
    expect(operatingModelSentenceFor(ownerLabourWithHours(ownerLabourOffer('I want $20,000 in 90 days with $5,000.'), { perWeek: null, total: null }))).toBe(OPERATING_MODEL_SENTENCE);
  });
});

describe('C02-F: the owner profile holds only what the owner said', () => {
  it('drops a skill and an asset the model invented, and keeps what the words state', async () => {
    const { ownerProfileOf, groundedInWords } = await import('../server/services/goals/routeProposal.ts');
    const words = "I'm in Tulsa with a pickup truck and my weekends free, maybe 16 hours a week. I need to make $1,200 by the end of December and I only have about $200.";
    const reply = JSON.stringify({ owner: { skills: ['Professional photography', 'Driving'], assets: ['Pickup truck', 'An Etsy shop with 2,000 followers'], location: 'Tulsa', hours: '16 per week', capital: '$200', refusals: 'not stated' }, routes: [] });
    const profile = ownerProfileOf(reply, words)!;
    expect(profile.assets).toEqual(['Pickup truck']);
    expect(profile.skills).toEqual([]);
    expect(profile.location).toBe('Tulsa');
    // Inflected and lower-cased forms still count as the owner's words.
    expect(groundedInWords('trucks', words)).toBe(true);
    // Without the owner's words the reader is unchanged.
    expect(ownerProfileOf(reply)!.skills).toEqual(['Professional photography', 'Driving']);
  });
});
