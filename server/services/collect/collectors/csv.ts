import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { recordFrom, run } from './shared.ts';

/** RFC 4180 parse: quotes, doubled quotes, CRLF, embedded newlines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = input.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

/** CSV / dataset download. mapping names columns by header: { title, organization, ... }. */
export function collectCsv(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  const map = options.mapping ?? {};
  return run(fetched, options.previous, () => {
    const [header, ...rows] = parseCsv(fetched.body);
    if (!header) return { records: [] };
    const col = new Map(header.map((name, i) => [name.trim().toLowerCase(), i]));
    const get = (row: string[], key: string, fallback: string): string | undefined => {
      const i = col.get((map[key] ?? fallback).toLowerCase());
      return i === undefined ? undefined : row[i];
    };
    const records = rows
      .map((row) =>
        recordFrom(
          {
            externalId: get(row, 'id', 'id') ?? null,
            url: get(row, 'url', 'url'),
            title: get(row, 'title', 'title'),
            organization: get(row, 'organization', 'organization'),
            publishedAt: get(row, 'publishedAt', 'date'),
            location: get(row, 'location', 'location'),
            amount: get(row, 'amount', 'amount'),
            body: get(row, 'body', 'description'),
          },
          options.url,
        ),
      )
      .filter((r): r is NonNullable<typeof r> => r !== null);
    return { records };
  }, options.maxRecords);
}
