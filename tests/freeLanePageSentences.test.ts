/**
 * The page sentences a free-lane model is shown (`pageSentences`).
 *
 * Production, 2026-11-17 01:02–01:49Z: 42 of gpt-oss-120b's 50 refused jobs
 * were fragments whose answer did not survive Brain's checks, and the recorded
 * replies were `{"claims":[]}` "from 2 / 4 / 6 source(s)" — after the re-ask.
 * Each page was shown as its first 7 000 characters, which on a commercial
 * page is its menus. The page below has that measured shape: a header of
 * menu lines, then the prose and the prices past the 7 000th character.
 */
import { describe, expect, it } from 'vitest';
import { citationFailure, citedExcerpt, focusTerms, pageSentences, quotedIn, sentencesOf } from '../server/services/freeLane/worker.ts';

const MENU = Array.from({ length: 220 }, (_, i) => `Products Back Build your website ${i}`).join('\n');
const SALES = [
  'The Basic plan costs $39 USD per month when billed annually for small online stores.',
  'Bookkeeping firms in the United States charge small businesses between $300 and $2,500 per month.',
  'Most buyers of outsourced bookkeeping are owner-managed firms with fewer than twenty employees.',
].join(' ');
const PAGE = `${MENU}\n\n${SALES}\n\nCookie settings\nPrivacy policy and terms of service apply to every visitor of this site.`;
const BRIEF = 'What do small businesses pay for outsourced bookkeeping per month, and who buys it?';

describe('pageSentences', () => {
  it('shows the page sentences that bear on the brief, not the menus ahead of them', () => {
    expect(PAGE.indexOf('$39')).toBeGreaterThan(7_000);
    // What the lane showed until now: the first 7 000 characters held none of it.
    expect(sentencesOf(PAGE.slice(0, 7_000)).some((one) => one.includes('bookkeeping'))).toBe(false);
    const shown = pageSentences(PAGE, BRIEF);
    expect(shown).toContain('Bookkeeping firms in the United States charge small businesses between $300 and $2,500 per month.');
    expect(shown).toContain('Most buyers of outsourced bookkeeping are owner-managed firms with fewer than twenty employees.');
    expect(shown.join(' ').length).toBeLessThanOrEqual(7_000 + shown.length);
    // In the page's own order, and every one of them is the page's own text.
    const at = shown.map((one) => PAGE.indexOf(one));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('keeps a short page whole, exactly as before', () => {
    const short = 'A short page about one thing only, stated plainly here. It has a second sentence that is also prose.';
    expect(pageSentences(short, BRIEF)).toEqual(sentencesOf(short));
  });

  it('leaves the evidence bar where it was: a citation still resolves to the page, word for word', () => {
    const numbered = [{ url: 'https://example.com/pricing', sentences: pageSentences(PAGE, BRIEF) }];
    const n = numbered[0]!.sentences.findIndex((one) => one.startsWith('Bookkeeping firms')) + 1;
    const cited = citedExcerpt({ claim: 'US bookkeeping costs $300–$2,500/month', source: 1, sentences: [n] }, numbered);
    expect(cited?.excerpt).toBe('Bookkeeping firms in the United States charge small businesses between $300 and $2,500 per month.');
    expect(quotedIn(cited!.excerpt, PAGE)).toBe(true);
    // A number past what was shown is still refused.
    expect(citedExcerpt({ source: 1, sentences: [numbered[0]!.sentences.length + 1] }, numbered)).toBeNull();
  });

  it('reads the brief for its subject words, not its function words', () => {
    const terms = focusTerms(BRIEF);
    expect(terms.has('bookkeeping')).toBe(true);
    expect(terms.has('business')).toBe(true);
    expect(terms.has('what')).toBe(false);
  });
});

describe('citationFailure', () => {
  it('records what the model wrote where the citation goes (2 of the 8 recorded drops said only "not readable")', () => {
    const one = [{ url: 'https://a', sentences: ['A sentence that is long enough to count.'] }];
    expect(citationFailure({ claim: 'x', sentences: ['the first one'] }, one)).toBe(
      'citation not readable as sentence numbers (sentences=["the first one"])',
    );
  });
});
