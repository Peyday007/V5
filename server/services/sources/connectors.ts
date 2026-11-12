/**
 * Website-specific readers, through a site's own public API.
 *
 * Only for a site that matters to research and whose pages neither the direct
 * reader nor the browser can read — added from what `SOURCE_ACCESS` events show
 * still failing, never speculatively. Each connector reads a public, keyless
 * endpoint the site publishes for exactly this, and returns the text under the
 * page's own address when the API's content is that page's content, or under the
 * API's address when it is not, so a citation always names what was read.
 */
import { createHash } from 'node:crypto';
import { MAX_TEXT_CHARS, type SourceFetch } from './fetchForWorker.ts';

export type Connector = (url: string, direct: (url: string) => Promise<SourceFetch>) => Promise<SourceFetch | null>;

interface Registered {
  name: string;
  matches: (url: URL) => boolean;
  read: Connector;
}

/**
 * A JSON document as labelled lines, values verbatim, so a claim can quote a value
 * and the verifier finds the same words on the next read. Pure.
 */
export function jsonAsText(value: unknown, skip: (path: string) => boolean = () => false): string {
  const lines: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (lines.length > 4000 || skip(path)) return;
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i + 1}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key);
      return;
    }
    const text = String(node).trim();
    if (text) lines.push(`${path}: ${text}`);
  };
  walk(value, '');
  return lines.join('\n');
}

function asRead(pageUrl: string, text: string, contentType: string): SourceFetch | null {
  const whole = text.trim();
  if (!whole) return null;
  const clipped = whole.slice(0, MAX_TEXT_CHARS);
  return {
    readable: true,
    requestedUrl: pageUrl,
    finalUrl: pageUrl,
    status: 200,
    contentType,
    retrievedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(whole).digest('hex'),
    text: clipped,
    truncated: clipped.length < whole.length,
    totalChars: whole.length,
  };
}

/**
 * UK Find a Tender: notice pages answer 403 to any reader that is not a browser and
 * render nothing in a headless one (production, 2026-11-04), and every notice is
 * published as open data through the service's OCDS API. The API's release package
 * IS the notice, so the text is cited under the notice's own address.
 */
const findTender: Connector = async (raw, direct) => {
  const id = new URL(raw).pathname.match(/^\/Notice\/(\d{6}-\d{4})/i)?.[1];
  if (!id) return null;
  const api = await direct(`https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages/${id}`);
  if (!api.readable) return null;
  let parsed: { releases?: unknown[] };
  try {
    parsed = JSON.parse(api.text) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.releases) || parsed.releases.length === 0) return null;
  return asRead(raw, jsonAsText(parsed.releases, (path) => /\.(extensions|links)$/.test(path)), 'application/json; ocds');
};

const REGISTRY: Registered[] = [
  { name: 'find-tender.service.gov.uk (OCDS API)', matches: (url) => url.hostname === 'www.find-tender.service.gov.uk' && /^\/Notice\//i.test(url.pathname), read: findTender },
];

/** The connector for a URL, or null when no site-specific reader applies. */
export function connectorFor(raw: string): Connector | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return REGISTRY.find((one) => one.matches(url))?.read ?? null;
}

export function connectorNames(): string[] {
  return REGISTRY.map((one) => one.name);
}
