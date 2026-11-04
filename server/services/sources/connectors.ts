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
import type { SourceFetch } from './fetchForWorker.ts';

export type Connector = (url: string, direct: (url: string) => Promise<SourceFetch>) => Promise<SourceFetch | null>;

interface Registered {
  name: string;
  matches: (url: URL) => boolean;
  read: Connector;
}

const REGISTRY: Registered[] = [];

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
