/**
 * A free-lane request fits the smallest free window when its prompt allows.
 *
 * Groq's free tier counts prompt plus max_tokens and refuses a request larger
 * than its 8 000-token minute (production 2026-11-06: "Requested 8027"), and
 * every research call asked for 8 000 answer tokens on top of its prompt.
 */
import { describe, expect, it } from 'vitest';
import { FREE_WINDOW_TOKENS, MIN_ANSWER_TOKENS, fitMaxTokens } from '../server/services/cheap/lane.ts';

const chars = (n: number): string => 'x'.repeat(n);

describe('fitMaxTokens', () => {
  it('shrinks the answer budget so prompt and answer fit the window', () => {
    const prompt = chars(9_000); // about 3 000 tokens
    const fitted = fitMaxTokens('', prompt, 8_000);
    expect(fitted).toBeLessThan(8_000);
    expect(fitted).toBeGreaterThanOrEqual(MIN_ANSWER_TOKENS);
    expect(Math.ceil(prompt.length / 3) + 64 + fitted).toBeLessThanOrEqual(FREE_WINDOW_TOKENS);
  });

  it('leaves a request that already fits alone', () => {
    expect(fitMaxTokens('sys', 'short prompt', 2_000)).toBe(2_000);
  });

  it('keeps the asked budget when the prompt is too long for any useful answer in the window', () => {
    expect(fitMaxTokens('', chars(21_000), 8_000)).toBe(8_000);
  });

  it('honours a configured window', () => {
    expect(fitMaxTokens('', chars(9_000), 8_000, 32_000)).toBe(8_000);
  });
});
