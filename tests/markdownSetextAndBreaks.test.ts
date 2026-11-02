import { describe, expect, it } from 'vitest';
import { textToBlocks } from '../server/services/documents/text.ts';

const shape = (source: string, markdown = true) =>
  textToBlocks(source, markdown).map((b) => [b.blockType, b.text]);

describe('markdown setext headings and thematic breaks', () => {
  it('turns a multi-line paragraph over a dash underline into one heading', () => {
    expect(shape('Line A\nLine B\n---\n\nBody')).toEqual([
      ['HEADING', 'Line A Line B'],
      ['PARAGRAPH', 'Body'],
    ]);
  });

  it('accepts an equals underline of any length over several lines', () => {
    expect(shape('One\nTwo\n=\n\nBody')).toEqual([
      ['HEADING', 'One Two'],
      ['PARAGRAPH', 'Body'],
    ]);
  });

  it('still handles a single-line setext heading', () => {
    expect(shape('Title\n-----\n\nBody')).toEqual([
      ['HEADING', 'Title'],
      ['PARAGRAPH', 'Body'],
    ]);
    expect(shape('Title\n=====\nBody')).toEqual([
      ['HEADING', 'Title'],
      ['PARAGRAPH', 'Body'],
    ]);
  });

  it.each(['---', '***', '___'])('drops a standalone %s after a blank line', (rule) => {
    expect(shape(`Before\n\n${rule}\n\nAfter`)).toEqual([
      ['PARAGRAPH', 'Before'],
      ['PARAGRAPH', 'After'],
    ]);
  });

  it('leaves non-markdown extraction unchanged', () => {
    expect(shape('Line A\nLine B\n---\n\nBody', false)).toEqual([
      ['PARAGRAPH', 'Line A Line B ---'],
      ['PARAGRAPH', 'Body'],
    ]);
  });
});
