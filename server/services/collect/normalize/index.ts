/**
 * Normalisation for collected records. Pure, deterministic, never throws.
 * A value that cannot be read is null and the field is recorded as missing by
 * the collector; nothing here guesses.
 */
import { createHash } from 'node:crypto';

export function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

const text = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};
export { text as cleanText };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Markup to plain words, bounded. */
export function plainText(value: unknown, max = 2000): string | null {
  const raw = text(value);
  if (!raw) return null;
  const out = decodeEntities(raw.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return out ? out.slice(0, max) : null;
}

/** ISO-8601 UTC, or null. Numbers below 1e12 are seconds. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const raw = text(value);
  if (!raw) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  // An ambiguous day/month pair is not guessed.
  if (us) {
    const a = Number(us[1]);
    const b = Number(us[2]);
    if (a > 12 && b <= 12) return new Date(Date.UTC(Number(us[3]), b - 1, a)).toISOString();
    if (b > 12 && a <= 12) return new Date(Date.UTC(Number(us[3]), a - 1, b)).toISOString();
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const CODES = /\b(USD|EUR|GBP|CAD|AUD|JPY|CNY|INR|CHF|MXN)\b/i;

export interface Amount {
  value: number;
  currency: string | null;
  unit: string | null;
}

const UNIT_WORDS: Record<string, string> = {
  hr: 'hour', hour: 'hour', hours: 'hour', hourly: 'hour',
  day: 'day', daily: 'day', week: 'week', weekly: 'week',
  mo: 'month', month: 'month', monthly: 'month', yr: 'year', year: 'year', annual: 'year', annually: 'year',
  kg: 'kg', lb: 'lb', lbs: 'lb', ton: 'ton', tons: 'ton', unit: 'unit', piece: 'unit', pcs: 'unit', each: 'unit',
  sqft: 'sqft', 'sq ft': 'sqft', m2: 'm2', 'm²': 'm2',
};

export function normalizeUnit(value: unknown): string | null {
  const raw = text(value)?.toLowerCase().replace(/^per\s+|^\/\s*/, '').replace(/\.$/, '');
  return raw ? (UNIT_WORDS[raw] ?? null) : null;
}

/**
 * "$1,200.50 per hour", "EUR 3.000,00", "12k USD" -> value, currency, unit.
 * A bare number has no currency; one is never assumed.
 */
export function normalizeAmount(value: unknown): Amount | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, currency: null, unit: null };
  const raw = text(value);
  if (!raw) return null;
  const match = /(\d[\d.,\s]*\d|\d)\s*([kKmM](?![a-z]))?/.exec(raw);
  if (!match) return null;
  let digits = (match[1] ?? '').replace(/\s/g, '');
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma > lastDot) digits = digits.replace(/\./g, '').replace(',', '.');
  else digits = digits.replace(/,/g, '');
  let number = Number(digits);
  if (!Number.isFinite(number)) return null;
  const scale = match[2]?.toLowerCase();
  if (scale === 'k') number *= 1_000;
  if (scale === 'm') number *= 1_000_000;
  const symbol = Object.keys(SYMBOLS).find((one) => raw.includes(one));
  const code = CODES.exec(raw)?.[1]?.toUpperCase();
  const unitMatch = /(?:per|\/)\s*([a-z²0-9]+(?:\s?ft)?)/i.exec(raw);
  return {
    value: number,
    currency: code ?? (symbol ? (SYMBOLS[symbol] ?? null) : null),
    unit: unitMatch ? normalizeUnit(unitMatch[1]) : null,
  };
}

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$)/i;

/** Canonical form of a URL for dedupe: no fragment, tracking, default port; sorted query. */
export function canonicalUrl(value: unknown, base?: string): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(decodeEntities(raw), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [k, v] of kept) url.searchParams.append(k, v);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return null;
  }
}
