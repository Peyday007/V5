/**
 * Normalization without evidence loss (section 9).
 *
 * Only artifacts of extraction are cleaned up: soft-hyphenation across line
 * breaks, collapsed whitespace, stray control characters. Raw text is kept
 * beside the normalized text on every block, so nothing here can destroy
 * evidence — and claims are never rewritten, uncertainty never compressed, and
 * distant passages never merged.
 */

/**
 * A word split across a line break by a hard hyphen, e.g. "intermedi-\nation".
 * Only a newline marks a break: a hyphen before an ordinary space is real text
 * ("pre- and post-closing", "short- or long-term") and must survive.
 */
const HARD_HYPHEN_LINE_BREAK = /([A-Za-z])-[ \t]*\r?\n[ \t]*([a-z])/g;
/**
 * A soft hyphen is never content, so a word it splits rejoins across any
 * whitespace, e.g. "intermedi\u00ad ation".
 */
const SOFT_HYPHEN_BREAK = /([A-Za-z])\u00ad\s+([a-z])/g;
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
/** A line that ends a word with a hard hyphen, and a line that continues it. */
const ENDS_IN_HYPHENATED_WORD = /[A-Za-z]-$/;
const STARTS_LOWERCASE = /^[a-z]/;

/**
 * Join the lines of one block for its raw text, keeping the one line boundary
 * normalization needs: where a line ends in a letter and a hard hyphen and the
 * next begins in lowercase, the break stays a newline so
 * `HARD_HYPHEN_LINE_BREAK` can tell a word split by layout ("recog-\nnition")
 * from a real hyphen before a space ("pre- and post-closing"). Every other
 * boundary becomes a single space, as before. Each line has `whitespace`
 * collapsed to one space and is trimmed; empty lines are dropped.
 */
export function joinExtractedLines(lines: readonly string[], whitespace: RegExp = /\s+/g): string {
  let joined = '';
  for (const raw of lines) {
    const line = raw.replace(whitespace, ' ').trim();
    if (line.length === 0) continue;
    if (joined.length === 0) joined = line;
    else if (ENDS_IN_HYPHENATED_WORD.test(joined) && STARTS_LOWERCASE.test(line)) joined += `\n${line}`;
    else joined += ` ${line}`;
  }
  return joined;
}

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

  const dehyphenated = text
    .replace(HARD_HYPHEN_LINE_BREAK, '$1$2')
    .replace(SOFT_HYPHEN_BREAK, '$1$2');
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
