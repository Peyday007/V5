/**
 * brain_submit_claims refuses a field its schema does not declare, so a source
 * sent under the wrong name is a refusal rather than a claim stored without one.
 */
import { describe, expect, it } from 'vitest';
import { claimFieldNames } from '../server/mcp/researchTools.ts';

describe('claimFieldNames', () => {
  it('is read from the tool schema and holds the source fields', () => {
    const names = claimFieldNames();
    for (const field of ['claim', 'source_url', 'source_title', 'evidence_lane', 'evidence_excerpt']) {
      expect(names.has(field)).toBe(true);
    }
    expect(names.has('url')).toBe(false);
    expect(names.has('sourceUrl')).toBe(false);
  });
});
