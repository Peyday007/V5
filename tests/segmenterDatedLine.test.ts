/**
 * A short line containing a date is content, not a timestamp marker
 * (CLAUDE.md §11: every claim about a transcript resolves to a passage in it).
 */
import { describe, expect, it } from 'vitest';
import { segmentBlocks } from '../server/services/sources/segmenter.ts';
import type { DocumentBlock } from '../server/domain/types.ts';

function blocksOf(texts: string[]): DocumentBlock[] {
  let offset = 0;
  return texts.map((text, index) => {
    const block = {
      id: `blk_${index}`,
      extractionRunId: 'run_1',
      documentId: 'doc_1',
      pageNumber: 1,
      blockIndex: index,
      blockType: 'PARAGRAPH',
      rawText: text,
      normalizedText: text,
      charStart: offset,
      charEnd: offset + text.length,
      extractionMethod: 'TEXT_LAYER',
      confidence: null,
      warnings: [],
      contentHash: `h${index}`,
      bbox: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    } as unknown as DocumentBlock;
    offset += text.length + 2;
    return block;
  });
}

describe('segmenter dated lines', () => {
  it('keeps a short sentence containing a date inside the assistant segment', () => {
    const segments = segmentBlocks(
      blocksOf([
        'You: when do we launch?',
        'Assistant: We settled it.',
        'Launch is 2026-10-01, final.',
        'Anything else?',
      ]),
    );
    const assistant = segments.find((one) => one.speaker?.toLowerCase() === 'assistant')!;
    expect(assistant.text).toContain('Launch is 2026-10-01, final.');
    expect(assistant.text).toContain('Anything else?');
    expect(assistant.timestampText).toBe('2026-10-01');
  });

  it.each(['2026-10-01', '[10:32 AM]'])('still consumes %s as a marker', (marker) => {
    const segments = segmentBlocks(blocksOf(['Assistant: first.', marker, 'Assistant: second.']));
    expect(segments.map((one) => one.text).join('\n')).not.toContain(marker);
    const second = segments.find((one) => one.text.includes('second'))!;
    expect(second.timestampText).toBe(marker);
  });
});
