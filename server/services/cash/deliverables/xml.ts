/** XML helpers shared by the Office writers and readers. */

/** Characters XML 1.0 cannot carry at all; removed rather than escaped. */
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function esc(value: string): string {
  return value
    .replace(INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function unesc(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Whether a document is well formed: every tag closed in order. A small
 * checker rather than a parser, used on Brain's own output and on client files
 * before their text is read.
 */
export function wellFormedProblem(xml: string): string | null {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(xml))) {
    const between = xml.slice(last, match.index);
    if (between.includes('<')) return `stray "<" near offset ${last}`;
    last = match.index + match[0].length;
    if (!match[2]) continue;
    if (match[1]) {
      const open = stack.pop();
      if (open !== match[2]) return `</${match[2]}> closes <${open ?? 'nothing'}>`;
    } else if (!match[4]) stack.push(match[2]);
  }
  if (xml.slice(last).includes('<')) return 'a tag that never ends';
  return stack.length ? `<${stack[stack.length - 1]}> is never closed` : null;
}

/** All text inside <tagName ...>…</tagName>, unescaped, in document order. */
export function textOf(xml: string, tagName: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(unesc(m[1]!.replace(/<[^>]+>/g, '')));
  return out;
}
