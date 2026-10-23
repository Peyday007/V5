/**
 * Triggers: jobs nobody posted. Built, and off until switched on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TRIGGER_BUCKETS, triggersEnabled } from '../server/services/cash/triggers.ts';
import { SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';

afterEach(() => {
  delete process.env['BRAIN_TRIGGERS'];
});

describe('trigger buckets', () => {
  it('start when the free-model lane is connected, and can be forced either way', () => {
    expect(triggersEnabled({})).toBe(false);
    expect(triggersEnabled({ BRAIN_CHEAP_LLM_URL: 'https://cheap.example/v1' })).toBe(true);
    expect(triggersEnabled({ BRAIN_CHEAP_LLM_URL: 'https://cheap.example/v1', BRAIN_TRIGGERS: 'off' })).toBe(false);
    expect(triggersEnabled({ BRAIN_TRIGGERS: 'ON' })).toBe(true);
    expect(triggersEnabled({ BRAIN_TRIGGERS: 'yes' })).toBe(false);
  });

  it('are eight distinct questions about named businesses, kept apart from the standing buckets', () => {
    expect(TRIGGER_BUCKETS).toHaveLength(8);
    const ids = new Set([...SEARCH_BUCKETS, ...TRIGGER_BUCKETS].map((one) => one.id));
    expect(ids.size).toBe(SEARCH_BUCKETS.length + TRIGGER_BUCKETS.length);
    for (const bucket of TRIGGER_BUCKETS) {
      expect(SEARCH_BUCKETS.some((one) => one.id === bucket.id)).toBe(false);
      expect(bucket.question.trimEnd().endsWith('?')).toBe(true);
      expect(bucket.question).toMatch(/specific/);
      expect(bucket.question).toMatch(/last 30 days/);
      expect(bucket.deliverable).toBeDefined();
    }
  });

  it('ask nothing the cash envelope forbids Brain to do', () => {
    const forbidden =
      /\b(purchase|paid api|api key|subscribe to|buy (?:the |a |an )?(?:list|data|access|leads)|phone call|call the|cold call|email the|write to the|contact the|reach out to|message the|submit a (?:request|bid|proposal|application) to|register with|apply for a|sign up (?:for|with)|post to|publish (?:a|our|the report|this report|a listing)|negotiate with|hire|engage a contractor)\b/i;
    for (const bucket of TRIGGER_BUCKETS) expect(bucket.question, bucket.id).not.toMatch(forbidden);
  });
});
