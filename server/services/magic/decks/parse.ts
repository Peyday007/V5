/**
 * Plaintext deck lists: `count name` lines under commander / main / sideboard
 * sections. Pure. A line it cannot read is reported, never skipped silently.
 *
 * Accepted forms: `4 Lightning Bolt`, `4x Lightning Bolt`, `1 Sol Ring (C21) 263`,
 * `SB: 2 Negate`. Section headers: Commander, Deck / Main / Mainboard,
 * Sideboard. With no header at all, a blank line after the main list starts the
 * sideboard (the MTGO convention) when `blankLineSideboard` is set.
 */
import type { MagicZone } from '../../../domain/magicTypes.ts';

export interface ParsedLine {
  zone: MagicZone;
  quantity: number;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  line: number;
}

export interface ParseProblem {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedDeck {
  lines: ParsedLine[];
  problems: ParseProblem[];
}

const HEADERS: Record<string, MagicZone> = {
  commander: 'commander', commanders: 'commander', companion: 'sideboard',
  deck: 'main', main: 'main', mainboard: 'main', 'main deck': 'main',
  sideboard: 'sideboard', side: 'sideboard',
};

const CARD_LINE = /^(\d+)\s*x?\s+(.+?)\s*$/i;
const PRINTING = /^(.*?)\s*\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9★\-]+)?\s*$/;

export function parseDeckList(text: string, options: { blankLineSideboard?: boolean } = {}): ParsedDeck {
  const lines: ParsedLine[] = [];
  const problems: ParseProblem[] = [];
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  const hasHeaders = rows.some((r) => HEADERS[r.trim().replace(/:$/, '').toLowerCase()] !== undefined);
  let zone: MagicZone = 'main';
  let sawMain = false;
  rows.forEach((raw, index) => {
    const lineNo = index + 1;
    let row = raw.trim();
    if (row === '') {
      if (!hasHeaders && options.blankLineSideboard && sawMain && zone === 'main') zone = 'sideboard';
      return;
    }
    if (row.startsWith('//') || row.startsWith('#')) return;
    const header = HEADERS[row.replace(/:$/, '').toLowerCase()];
    if (header) {
      zone = header;
      return;
    }
    let lineZone = zone;
    if (/^SB:\s*/i.test(row)) {
      lineZone = 'sideboard';
      row = row.replace(/^SB:\s*/i, '');
    }
    const m = CARD_LINE.exec(row);
    if (!m) {
      problems.push({ line: lineNo, text: raw, reason: 'Expected a count followed by a card name.' });
      return;
    }
    const quantity = Number(m[1]);
    let name = (m[2] ?? '').trim();
    let setCode: string | null = null;
    let collectorNumber: string | null = null;
    const p = PRINTING.exec(name);
    if (p && p[1]) {
      name = p[1].trim();
      setCode = (p[2] ?? '').toLowerCase();
      collectorNumber = p[3] ?? null;
    }
    if (quantity < 1) {
      problems.push({ line: lineNo, text: raw, reason: 'A count must be at least 1.' });
      return;
    }
    if (!name) {
      problems.push({ line: lineNo, text: raw, reason: 'Missing card name.' });
      return;
    }
    if (lineZone === 'main') sawMain = true;
    lines.push({ zone: lineZone, quantity, name, setCode, collectorNumber, line: lineNo });
  });
  return { lines, problems };
}

export interface ExportCard {
  zone: MagicZone;
  cardName: string;
  quantity: number;
}

export function exportDeckList(cards: ExportCard[]): string {
  const section = (title: string, zone: MagicZone): string => {
    const rows = cards
      .filter((c) => c.zone === zone)
      .sort((a, b) => a.cardName.localeCompare(b.cardName))
      .map((c) => `${c.quantity} ${c.cardName}`);
    return rows.length ? `${title}\n${rows.join('\n')}` : '';
  };
  return [section('Commander', 'commander'), section('Deck', 'main'), section('Sideboard', 'sideboard')]
    .filter(Boolean)
    .join('\n\n') + '\n';
}
