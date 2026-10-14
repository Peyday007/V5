/**
 * Decklist text and CSV parsing. Game-agnostic: it reads quantities, names, optional set and
 * collector number, and which section a line belongs to. It never guesses a name — that is the
 * game adapter's card resolution, which can ask the person.
 */
export type Section = 'commander' | 'main' | 'sideboard' | 'maybeboard' | 'companion';

export interface ParsedLine {
  lineNo: number;
  raw: string;
  quantity: number;
  name: string;
  set: string | null;
  number: string | null;
  section: Section;
  /** True when the section came from a header or marker in the file, not a default. */
  sectionStated: boolean;
}

export interface ParseProblem { lineNo: number; raw: string; problem: string }

export interface ParsedDeck {
  name: string | null;
  lines: ParsedLine[];
  problems: ParseProblem[];
  /** True when the file named a commander section or marked a commander line. */
  commanderStated: boolean;
}

const HEADERS: Array<[RegExp, Section]> = [
  [/^(commanders?|command zone|cmdr)$/i, 'commander'],
  [/^(deck|main ?deck|mainboard|main|library|the 99|99)$/i, 'main'],
  [/^(sideboard|side board|sb)$/i, 'sideboard'],
  [/^(maybe ?board|maybe|considering)$/i, 'maybeboard'],
  [/^(companion)$/i, 'companion'],
];

function headerOf(line: string): Section | null {
  const t = line.replace(/^\/\/\s*/, '').replace(/^#+\s*/, '').replace(/[:\s]*(\(\d+\))?\s*$/, '').trim();
  for (const [re, s] of HEADERS) if (re.test(t)) return s;
  return null;
}

/** "1x Name (SET) 123 *F*", "1 Name [SET] 123", "Name", "SB: 2 Name", "1 Name *CMDR*" ... */
export function parseLine(raw: string): Omit<ParsedLine, 'lineNo' | 'section' | 'sectionStated'> & { marker: Section | null } | null {
  let s = raw.trim();
  let marker: Section | null = null;
  if (/^sb:\s*/i.test(s)) { marker = 'sideboard'; s = s.replace(/^sb:\s*/i, ''); }
  if (/\*cmdr\*|\[commander[^\]]*\]|\(commander\)\s*$/i.test(s)) { marker = 'commander'; s = s.replace(/\*cmdr\*|\[commander[^\]]*\]|\(commander\)\s*$/ig, ''); }
  s = s.replace(/\s\*[A-Z]+\*\s*$/g, '').replace(/\s\^[^^]*\^\s*$/, '').replace(/\s\[[^\]]*\]\s*$/, (m) => (/^\s\[[A-Z0-9]{2,6}\]$/.test(m) ? m : '')).trim();
  if (!s) return null;
  let quantity = 1;
  const q = s.match(/^(\d+)\s*x?\s+(.*)$/i);
  if (q) { quantity = Number(q[1]); s = q[2]!.trim(); }
  let set: string | null = null, number: string | null = null;
  const withNum = s.match(/^(.*?)\s+[([]([A-Za-z0-9]{2,6})[)\]]\s+([A-Za-z0-9★-]+)\s*$/);
  const setOnly = s.match(/^(.*?)\s+[([]([A-Za-z0-9]{2,6})[)\]]\s*$/);
  if (withNum) { s = withNum[1]!; set = withNum[2]!.toUpperCase(); number = withNum[3]!; }
  else if (setOnly) { s = setOnly[1]!; set = setOnly[2]!.toUpperCase(); }
  const name = s.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return { raw, quantity, name, set, number, marker };
}

export function parseDecklistText(text: string): ParsedDeck {
  const lines: ParsedLine[] = [];
  const problems: ParseProblem[] = [];
  let section: Section = 'main';
  let stated = false;
  let commanderStated = false;
  let deckName: string | null = null;
  let blankAfterContent = false;
  const rows = text.replace(/\r/g, '').split('\n');
  rows.forEach((raw, i) => {
    const lineNo = i + 1;
    const t = raw.trim();
    if (!t) { if (lines.length) blankAfterContent = true; return; }
    if (/^name\s*[:=]/i.test(t)) { deckName = t.replace(/^name\s*[:=]\s*/i, ''); return; }
    if (t.startsWith('#')) return;
    const h = headerOf(t);
    if (h && !/^\d/.test(t)) {
      section = h; stated = true; blankAfterContent = false;
      if (h === 'commander') commanderStated = true;
      return;
    }
    if (t.startsWith('//')) return;
    const p = parseLine(t);
    if (!p) { problems.push({ lineNo, raw, problem: 'This line has no card name.' }); return; }
    if (p.quantity < 1) { problems.push({ lineNo, raw, problem: 'A quantity must be at least 1.' }); return; }
    // MTG Arena exports put the sideboard after a blank line with no header.
    let sec = section;
    if (p.marker) { sec = p.marker; if (p.marker === 'commander') commanderStated = true; }
    else if (blankAfterContent && !stated && section === 'main') { sec = 'sideboard'; }
    lines.push({ lineNo, raw, quantity: p.quantity, name: p.name, set: p.set, number: p.number, section: sec, sectionStated: stated || p.marker !== null });
  });
  return { name: deckName, lines, problems, commanderStated };
}

/** CSV with a header row naming its columns, as Moxfield, Archidekt, Deckbox and spreadsheets export. */
export function parseDecklistCsv(text: string): ParsedDeck {
  const rows = parseCsv(text);
  const problems: ParseProblem[] = [];
  const lines: ParsedLine[] = [];
  if (rows.length === 0) return { name: null, lines, problems: [{ lineNo: 1, raw: '', problem: 'The file is empty.' }], commanderStated: false };
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iq = col('count', 'quantity', 'qty', 'amount');
  const iname = col('name', 'card', 'card name');
  const iset = col('set', 'edition', 'set code', 'edition code');
  const inum = col('collector number', 'collector_number', 'number', 'card number', 'cn');
  const isec = col('section', 'board', 'category', 'categories', 'zone');
  const icmd = col('commander', 'is commander');
  if (iname < 0) {
    return { name: null, lines, problems: [{ lineNo: 1, raw: rows[0]!.join(','), problem: 'The CSV needs a header row with a "Name" column.' }], commanderStated: false };
  }
  let commanderStated = false;
  rows.slice(1).forEach((r, i) => {
    const lineNo = i + 2;
    const raw = r.join(',');
    const name = (r[iname] ?? '').trim();
    if (!name) { if (r.some((c) => c.trim())) problems.push({ lineNo, raw, problem: 'This row has no card name.' }); return; }
    const qty = iq >= 0 ? Number((r[iq] ?? '1').trim() || '1') : 1;
    if (!Number.isInteger(qty) || qty < 1) { problems.push({ lineNo, raw, problem: `"${r[iq]}" is not a quantity.` }); return; }
    const secText = isec >= 0 ? (r[isec] ?? '').trim() : '';
    let section: Section = 'main';
    let stated = false;
    if (secText) { const h = headerOf(secText.split(/[,;]/)[0]!.trim()); if (h) { section = h; stated = true; } }
    if (icmd >= 0 && /^(true|yes|1|x)$/i.test((r[icmd] ?? '').trim())) { section = 'commander'; stated = true; }
    if (section === 'commander') commanderStated = true;
    const set = iset >= 0 && r[iset]?.trim() ? r[iset]!.trim().toUpperCase() : null;
    const number = inum >= 0 && r[inum]?.trim() ? r[inum]!.trim() : null;
    lines.push({ lineNo, raw, quantity: qty, name, set, number, section, sectionStated: stated });
  });
  return { name: null, lines, problems, commanderStated };
}

export function looksLikeCsv(text: string, filename?: string): boolean {
  if (filename && /\.csv$/i.test(filename)) return true;
  const first = text.split('\n')[0] ?? '';
  return /(^|,)\s*"?(name|card name)"?\s*(,|$)/i.test(first) && first.includes(',');
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim()));
}
