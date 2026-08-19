/**
 * Chunking for retrieval and model budgets (section 11).
 *
 * Chunk boundaries follow document structure: a chunk starts at a heading where
 * one is available, and never splits a block. Every chunk keeps its page range,
 * block range and heading path, so a finding can always be traced back to the
 * page it came from. A small overlap keeps a claim that straddles a boundary
 * readable in both chunks.
 */
import { createHash } from 'node:crypto';
import type { DocumentBlock } from '../../domain/types.ts';

export const DEFAULT_CHUNK_CHARS = 6_000;
export const DEFAULT_OVERLAP_CHARS = 400;

export interface PlannedChunk {
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  blockStart: number;
  blockEnd: number;
  headingPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
  overlapPrev: number;
  hasOcr: boolean;
  contentHash: string;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Blocks that are page furniture add noise to retrieval without adding evidence. */
function isContent(block: DocumentBlock): boolean {
  return block.blockType !== 'PAGE_HEADER' && block.blockType !== 'PAGE_FOOTER';
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/**
 * Group blocks into chunks. Blocks are never split, so a chunk may exceed the
 * target when a single block is larger than it — losing the block boundary would
 * cost more than the oversize does.
 */
export function planChunks(blocks: DocumentBlock[], options: ChunkOptions = {}): PlannedChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const content = blocks.filter(isContent);
  if (content.length === 0) return [];

  const chunks: PlannedChunk[] = [];
  let current: DocumentBlock[] = [];
  let headingPath: string[] = [];
  let pendingHeadingPath: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current.at(-1)!;
    const body = current.map((block) => block.normalizedText).join('\n\n');

    // Carry the tail of the previous chunk so a claim spanning the boundary is
    // legible in both.
    const previous = chunks.at(-1);
    const overlapText =
      previous && overlapChars > 0 ? previous.text.slice(-overlapChars) : '';
    const text = overlapText ? `${overlapText}\n\n${body}` : body;

    chunks.push({
      chunkIndex: chunks.length,
      pageStart: first.pageNumber,
      pageEnd: last.pageNumber,
      blockStart: first.blockIndex,
      blockEnd: last.blockIndex,
      headingPath: [...headingPath],
      text,
      charStart: first.charStart,
      charEnd: last.charEnd,
      overlapPrev: overlapText.length,
      hasOcr: current.some((block) => block.extractionMethod === 'OCR'),
      contentHash: hash(body),
    });
    current = [];
    headingPath = pendingHeadingPath;
  };

  for (const block of content) {
    if (block.blockType === 'HEADING') {
      // A heading is a natural boundary, but only once the chunk has substance —
      // otherwise a run of subheadings produces a chunk each.
      const size = current.reduce((total, entry) => total + entry.normalizedText.length, 0);
      pendingHeadingPath = [block.normalizedText];
      if (size >= maxChars * 0.5) {
        flush();
      }
      if (current.length === 0) headingPath = [block.normalizedText];
    }

    current.push(block);
    const size = current.reduce((total, entry) => total + entry.normalizedText.length, 0);
    if (size >= maxChars) {
      pendingHeadingPath = headingPath;
      flush();
    }
  }
  pendingHeadingPath = headingPath;
  flush();

  return chunks;
}
