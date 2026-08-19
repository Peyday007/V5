/**
 * Normalization without evidence loss (section 9).
 *
 * Only artifacts of extraction are cleaned up: soft-hyphenation across line
 * breaks, collapsed whitespace, stray control characters. Raw text is kept
 * beside the normalized text on every block, so nothing here can destroy
 * evidence — and claims are never rewritten, uncertainty never compressed, and
 * distant passages never merged.
 */

/** Words split across a line break by a hyphen, e.g. "intermedi- ation". */
const SOFT_HYPHEN_BREAK = /([A-Za-z])[-\u00ad]\s+([a-z])/g;
/** Control characters that carry no meaning in extracted prose. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Zero-width and formatting characters some PDF producers emit between glyphs. */
const INVISIBLES = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff]/g;
/**
 * A soft hyphen left inside a word, once line-break rejoining has had its turn.
 * It is invisible on the page but splits the word for anything that searches the
 * text, so "interme<shy>diation" would never match a query for "intermediation".
 */
const STRAY_SOFT_HYPHEN = /\u00ad/g;

export interface NormalizationResult {
  text: string;
  /** What was changed, so the user can see the cleanup was not a rewrite. */
  notes: string[];
}

const LIGATURES: [RegExp, string][] = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
];

export function normalizeBlockText(raw: string): NormalizationResult {
  const notes: string[] = [];
  let text = raw;

  if (CONTROL_CHARS.test(text)) {
    text = text.replace(CONTROL_CHARS, '');
    notes.push('removed control characters');
  }
  if (INVISIBLES.test(text)) {
    text = text.replace(INVISIBLES, '');
    notes.push('removed zero-width characters');
  }

  const dehyphenated = text.replace(SOFT_HYPHEN_BREAK, '$1$2');
  if (dehyphenated !== text) {
    text = dehyphenated;
    notes.push('rejoined hyphenated line breaks');
  }
  // Only after the line-break rule, which needs the character to decide where a
  // word was split.
  if (STRAY_SOFT_HYPHEN.test(text)) {
    text = text.replace(STRAY_SOFT_HYPHEN, '');
    notes.push('removed soft hyphens');
  }

  for (const [pattern, replacement] of LIGATURES) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement);
      if (!notes.includes('expanded ligatures')) notes.push('expanded ligatures');
    }
  }

  const collapsed = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  if (collapsed !== text) notes.push('collapsed whitespace');

  return { text: collapsed, notes };
}
