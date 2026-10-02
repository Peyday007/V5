import { describe, expect, it } from 'vitest';
import { planChunks } from '../server/services/documents/chunker.ts';
import type { DocumentBlock } from '../server/domain/types.ts';

function block(index: number, type: 'HEADING' | 'PARAGRAPH', text: string): DocumentBlock {
  return {
    id: `blk-${index}`,
    extractionRunId: 'run',
    documentId: 'doc',
    pageNumber: 1,
    blockIndex: index,
    blockType: type,
    rawText: '',
    normalizedText: text,
    charStart: 0,
    charEnd: 0,
    extractionMethod: 'NATIVE',
    confidence: null,
    warnings: [],
    contentHash: '',
    bbox: null,
    createdAt: '',
  };
}

describe('chunk heading carry', () => {
  it('labels the chunk after a size flush with the heading that arrived mid-chunk', () => {
    const blocks = [
      block(0, 'HEADING', 'A'),
      block(1, 'PARAGRAPH', 'x'.repeat(1_000)),
      block(2, 'HEADING', 'B'),
      block(3, 'PARAGRAPH', 'y'.repeat(2_500)),
      block(4, 'PARAGRAPH', 'z'.repeat(500)),
    ];
    const chunks = planChunks(blocks, { maxChars: 3_000, overlapChars: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.headingPath).toEqual(['A']);
    expect(chunks[1]!.headingPath).toEqual(['B']);
  });

  it('keeps the heading when no new one arrives', () => {
    const blocks = [
      block(0, 'HEADING', 'A'),
      block(1, 'PARAGRAPH', 'x'.repeat(2_000)),
      block(2, 'PARAGRAPH', 'y'.repeat(2_000)),
      block(3, 'PARAGRAPH', 'z'.repeat(500)),
    ];
    const chunks = planChunks(blocks, { maxChars: 3_000, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.headingPath.join() === 'A')).toBe(true);
  });
});
