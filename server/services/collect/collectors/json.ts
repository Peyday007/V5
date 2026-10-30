/** A JSON API described by data: where the rows are, which field fills which slot, and how it paginates. */
import { buildRecord } from './record.ts';
import type { CollectedRecord } from './types.ts';

export interface JsonMapping {
  /** Dotted path to the array of rows; empty means the body itself. */
  rows: string;
  externalId?: string;
  url: string;
  title: string;
  body?: string;
  organization?: string;
  publishedAt?: string;
  location?: string;
  amount?: string;
  /** Pagination: follow a cursor path or a page number, never more than maxPages. */
  next?: { kind: 'cursor'; path: string; param: string } | { kind: 'page'; param: string; start?: number } | { kind: 'link'; path: string };
}

export function at(value: unknown, path: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A path may join several fields with '+', e.g. "city+state"; absent parts are skipped. */
function pick(row: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  if (!path.includes('+')) return at(row, path);
  const parts = path.split('+').map((p) => at(row, p.trim())).filter((v) => typeof v === 'string' || typeof v === 'number');
  return parts.length ? parts.join(', ') : undefined;
}

export function parseJson(body: unknown, mapping: JsonMapping, baseUrl?: string, currentPage = 1): { records: CollectedRecord[]; next: string | null } {
  const rowsValue = at(body, mapping.rows);
  const rows = Array.isArray(rowsValue) ? rowsValue : [];
  const records: CollectedRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = buildRecord({
      externalId: pick(row, mapping.externalId),
      url: pick(row, mapping.url),
      title: pick(row, mapping.title),
      body: pick(row, mapping.body),
      organization: pick(row, mapping.organization),
      publishedAt: pick(row, mapping.publishedAt),
      location: pick(row, mapping.location),
      amount: pick(row, mapping.amount),
    }, baseUrl);
    if (r) records.push(r);
  }
  return { records, next: records.length ? nextPage(body, mapping, baseUrl, currentPage) : null };
}

function nextPage(body: unknown, mapping: JsonMapping, baseUrl: string | undefined, currentPage: number): string | null {
  const rule = mapping.next;
  if (!rule || !baseUrl) return null;
  try {
    if (rule.kind === 'link') {
      const link = at(body, rule.path);
      return typeof link === 'string' && link ? new URL(link, baseUrl).toString() : null;
    }
    const url = new URL(baseUrl);
    if (rule.kind === 'cursor') {
      const cursor = at(body, rule.path);
      if (typeof cursor !== 'string' && typeof cursor !== 'number') return null;
      url.searchParams.set(rule.param, String(cursor));
      return url.toString();
    }
    url.searchParams.set(rule.param, String(currentPage + 1));
    return url.toString();
  } catch {
    return null;
  }
}
