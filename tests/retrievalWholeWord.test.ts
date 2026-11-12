import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { retrieveEvidence, scoreChunk } from '../server/services/documents/retrieval.ts';
import type { DocumentChunk } from '../server/domain/types.ts';

function chunk(text: string, headingPath: string[] = []): DocumentChunk {
  return { text, headingPath } as DocumentChunk;
}

describe('whole-word retrieval', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(teardown);

  it('does not match a term inside another word', () => {
    expect(scoreChunk(chunk('the current parent'), ['rent'])).toBe(0);
  });

  it('matches the term as a whole token', () => {
    expect(scoreChunk(chunk('The rent is due.'), ['rent'])).toBeGreaterThan(0);
    expect(scoreChunk(chunk('x', ['Rent schedule']), ['rent'])).toBe(0);
    expect(scoreChunk(chunk('rent, paid'), ['rent'])).toBeGreaterThan(0);
  });

  it('reports an unregistered document as unreadable rather than dropping it', async () => {
    const result = await retrieveEvidence({ documentIds: ['doc_missing'], query: 'rent payment' });
    expect(result.searched).toEqual([]);
    expect(result.unreadable).toEqual([
      {
        documentId: 'doc_missing',
        documentLabel: 'doc_missing',
        reason: 'No document with that id is registered.',
      },
    ]);
  });
});
