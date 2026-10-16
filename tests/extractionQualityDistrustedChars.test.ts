import { describe, expect, it } from 'vitest';
import { assessExtraction } from '../server/services/documents/quality.ts';
import type { OcrPageRecord } from '../server/domain/types.ts';
import type { ExtractedPage } from '../server/services/documents/pdf.ts';

function page(pageNumber: number, characterCount: number): ExtractedPage {
  return {
    pageNumber,
    blocks: [],
    characterCount,
    itemCount: 1,
    width: 600,
    height: 800,
    signals: { characterDensity: 1, columnCount: 1, hasReplacementGlyphs: false, nearlyEmpty: false },
  };
}

function ocr(pageNumber: number, confidence: number): OcrPageRecord {
  return {
    page: pageNumber,
    ok: true,
    imageHash: null,
    width: null,
    height: null,
    dpi: null,
    confidence,
    durationMs: null,
    blocks: 1,
    characters: 0,
    warnings: [],
  };
}

describe('minimum-document check and distrusted OCR pages', () => {
  const readable = [1, 2, 3, 4].map((n) => page(n, 45));

  it('blocks four readable 45-character pages', () => {
    const q = assessExtraction({ pages: readable, ocrPages: [], warnings: [] });
    expect(q.status).toBe('BLOCKED');
  });

  it('does not let a 3000-character page at confidence 0.1 rescue them', () => {
    const q = assessExtraction({
      pages: [...readable, page(5, 3000)],
      ocrPages: [5],
      ocrRecords: [ocr(5, 0.1)],
      warnings: [],
    });
    expect(q.status).toBe('BLOCKED');
    expect(q.blockedReason).toContain('Only 180 characters');
    expect(q.characterCount).toBe(3180);
  });
});
