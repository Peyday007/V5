/** CSV/TSV datasets: RFC 4180 quoting, header-mapped columns. Never throws. */
import { buildRecord } from './record.ts';
import type { CollectedRecord } from './types.ts';

export interface CsvMapping {
  /** Column header (case-insensitive) for each slot; '+' joins several. */
  externalId?: string;
  url?: string;
  title: string;
  body?: string;
  organization?: string;
  publishedAt?: string;
  location?: string;
  amount?: string;
  /** Used to build a url when the dataset has none: template with {externalId}. */
  urlTemplate?: string;
}

export function parseCsvRows(input: string, delimiter?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const d = delimiter ?? (((text.split('\n', 1)[0] ?? '').match(/\t/g) ?? []).length > ((text.split('\n', 1)[0] ?? '').match(/,/g) ?? []).length ? '\t' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
    if (rows.length > 200_000) break;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export function parseCsv(body: string, mapping: CsvMapping, baseUrl?: string): CollectedRecord[] {
  const rows = parseCsvRows(body);
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header) return [];
  const col = (spec: string | undefined, row: string[]): string | undefined => {
    if (!spec) return undefined;
    const parts = spec.split('+').map((s) => header.indexOf(s.trim().toLowerCase())).filter((i) => i >= 0).map((i) => row[i]?.trim()).filter((v): v is string => !!v);
    return parts.length ? parts.join(', ') : undefined;
  };
  const out: CollectedRecord[] = [];
  for (const row of rows.slice(1)) {
    const externalId = col(mapping.externalId, row);
    const url = col(mapping.url, row) ?? (mapping.urlTemplate && externalId ? mapping.urlTemplate.replace('{externalId}', encodeURIComponent(externalId)) : undefined);
    const r = buildRecord({ externalId, url, title: col(mapping.title, row), body: col(mapping.body, row), organization: col(mapping.organization, row), publishedAt: col(mapping.publishedAt, row), location: col(mapping.location, row), amount: col(mapping.amount, row) }, baseUrl);
    if (r) out.push(r);
  }
  return out;
}
