/**
 * Normalisation for collected public information: dates, money, units, URLs,
 * text and content hashes. Everything here is pure and never throws — a value
 * that cannot be read is null, which callers record as missing rather than
 * guess.
 */
import { createHash } from 'node:crypto';

const MAX_TEXT = 2_000;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Markup to plain words, bounded. Null when nothing readable remains. */
export function plainText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const stripped = decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return stripped ? stripped.slice(0, max) : null;
}

/** ISO-8601 UTC, or null. Accepts ISO, RFC 822, epoch seconds/ms, and YYYYMMDDTHHMMSSZ. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.000Z`;
  if (/^\d{9,13}$/.test(raw)) return normalizeDate(Number(raw));
  // A bare date has no zone; read it as UTC so the same page gives the same instant everywhere.
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  if (!Number.isFinite(parsed)) return null;
  const d = new Date(parsed);
  const year = d.getUTCFullYear();
  return year < 1990 || year > 2100 ? null : d.toISOString();
}

export interface Amount {
  value: number;
  currency: string | null;
  /** 'hour', 'year', 'unit', ... when the text stated a basis. */
  unit: string | null;
}

const SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
const CODE = /\b(USD|EUR|GBP|CAD|AUD|JPY|INR|CNY|MXN|CHF)\b/i;
const UNIT_WORDS: Record<string, string> = {
  hr: 'hour', hour: 'hour', hourly: 'hour', h: 'hour',
  day: 'day', daily: 'day', wk: 'week', week: 'week', weekly: 'week',
  mo: 'month', month: 'month', monthly: 'month',
  yr: 'year', year: 'year', annual: 'year', annually: 'year', pa: 'year',
  unit: 'unit', each: 'unit', ea: 'unit', piece: 'unit', pc: 'unit',
  kg: 'kg', lb: 'lb', ton: 'ton', tonne: 'ton', sqft: 'sqft', sf: 'sqft', sqm: 'sqm', m2: 'sqm',
};
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9 };

/**
 * One amount from free text: "$1,200.50", "EUR 3.5k per hour", "£40/hr".
 * A bare number with no currency mark is NOT an amount — currency stays null
 * only when a mark is present but unknown; no mark at all returns null.
 * A range returns the low end (the figure the text commits to).
 */
export function parseAmount(value: unknown): Amount | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/ /g, ' ');
  const symbol = /([$€£¥₹])\s*(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|b)?\b/i.exec(text);
  const coded = /\b(USD|EUR|GBP|CAD|AUD|JPY|INR|CNY|MXN|CHF)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|b)?\b/i.exec(text);
  const trailing = /(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|b)?\s*(USD|EUR|GBP|CAD|AUD|JPY|INR|CNY|MXN|CHF)\b/i.exec(text);
  let numeric: string | undefined;
  let scale: string | undefined;
  let currency: string | null = null;
  let end = 0;
  if (symbol) {
    numeric = symbol[2]; scale = symbol[3]; currency = SYMBOLS[symbol[1]!] ?? null; end = symbol.index + symbol[0].length;
    // "CA$" / "A$" / "HK$" belong to another currency: refuse rather than call it dollars.
    if (symbol[1] === '$' && symbol.index > 0 && /[A-Za-z]/.test(text[symbol.index - 1]!)) return null;
  } else if (coded) {
    numeric = coded[2]; scale = coded[3]; currency = coded[1]!.toUpperCase(); end = coded.index + coded[0].length;
  } else if (trailing) {
    numeric = trailing[1]; scale = trailing[2]; currency = trailing[3]!.toUpperCase(); end = trailing.index + trailing[0].length;
  }
  if (!numeric) return null;
  let amount = Number(numeric.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const mult = scale ? SCALE[scale.toLowerCase()] : undefined;
  if (mult) amount *= mult;
  const unit = /(?:\/|\bper\b|\ba\b)\s*([a-z0-9]+)/i.exec(text.slice(end)) ?? /^\s*(hourly|daily|weekly|monthly|annually)\b/i.exec(text.slice(end));
  const unitWord = unit?.[1] ? UNIT_WORDS[unit[1].toLowerCase()] ?? null : null;
  return { value: Math.round(amount * 100) / 100, currency, unit: unitWord };
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|_hsenc|_hsmi)$/i;

/** A URL reduced to the form two copies of one page share. Null when not http(s). */
export function canonicalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of params) url.searchParams.append(k, v);
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path;
  return url.toString();
}

/** Lower-case words only, so spacing and punctuation never make two copies differ. */
export function normalizeKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The key two reports of one thing share: organisation + title + day. */
export function dedupeKey(input: { organization: string | null; title: string; publishedAt: string | null }): string {
  return sha256([normalizeKey(input.organization), normalizeKey(input.title), (input.publishedAt ?? '').slice(0, 10)].join('|'));
}
