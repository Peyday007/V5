import { canonicalUrl, normalizeDate, parseAmount, plainText, sha256, type Amount } from '../normalize/index.ts';
import { OPTIONAL_FIELDS, type CollectedRecord } from './types.ts';

export interface RawFields {
  externalId?: unknown;
  url?: unknown;
  title?: unknown;
  body?: unknown;
  organization?: unknown;
  publishedAt?: unknown;
  location?: unknown;
  amount?: unknown;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** Build one record from raw fields, or null when it has no title or URL (nothing to point at). */
export function buildRecord(raw: RawFields, baseUrl?: string): CollectedRecord | null {
  const title = plainText(raw.title, 500);
  let urlInput = text(raw.url);
  if (urlInput && baseUrl) {
    try { urlInput = new URL(urlInput, baseUrl).toString(); } catch { urlInput = null; }
  }
  const url = canonicalUrl(urlInput);
  if (!title || !url) return null;
  const amount: Amount | null = raw.amount && typeof raw.amount === 'object' ? (raw.amount as Amount) : parseAmount(text(raw.amount) ?? '');
  const record: CollectedRecord = {
    externalId: text(raw.externalId) ?? url,
    url,
    title,
    body: plainText(raw.body),
    organization: plainText(raw.organization, 300),
    publishedAt: normalizeDate(raw.publishedAt),
    location: plainText(raw.location, 300),
    amount,
    missing: [],
    contentHash: '',
  };
  record.missing = OPTIONAL_FIELDS.filter((f) => record[f] === null);
  record.contentHash = sha256(JSON.stringify([record.title, record.body, record.organization, record.publishedAt, record.location, record.amount]));
  return record;
}
