/**
 * The source-access layer: direct first, then only the legitimate route the
 * failure calls for, never around an access control, and a bot challenge is
 * never a source.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  isChallenge,
  isFinalRefusal,
  learnFrom,
  listedUrls,
  pathSimilarity,
  readSource,
  robotsAllows,
  robotsRules,
  wantsBrowser,
  wantsReplacement,
  type AccessDeps,
} from '../server/services/sources/access.ts';
import { evaluateResult, renderInBrowser, rpcPayload } from '../server/services/sources/browserMcp.ts';
import { fetchForWorker, type HttpFetch, type Resolver, type SourceFetch } from '../server/services/sources/fetchForWorker.ts';
import { summarizeAccess } from '../server/services/sources/accessReport.ts';

const publicResolver: Resolver = async () => ['93.184.216.34'];
const LONG = 'Official statistics say the median wage was 41,000 dollars in 2025. '.repeat(10);

function ok(url: string, text = LONG, contentType = 'text/html'): SourceFetch {
  return { readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType, retrievedAt: 'now', sha256: 'x', text, truncated: false, totalChars: text.length };
}
function no(url: string, reason: string, status: number | null = null): SourceFetch {
  return { readable: false, requestedUrl: url, finalUrl: url, status, retrievedAt: 'now', reason: reason as never, detail: reason };
}

function deps(over: Partial<AccessDeps>): AccessDeps {
  return {
    resolve: publicResolver,
    robotsAllow: async () => true,
    learned: async () => null,
    record: async () => undefined,
    archive: async () => null,
    sitemap: async () => null,
    browser: null,
    ...over,
  };
}

describe('which failures send a read to which route', () => {
  it('sends blocks, thin pages and challenges to the browser, and gone pages to a replacement', () => {
    expect(wantsBrowser(no('u', 'HTTP_ERROR', 403))).toBe(true);
    expect(wantsBrowser(no('u', 'EMPTY'))).toBe(true);
    expect(wantsBrowser(ok('u', 'tiny'))).toBe(true);
    expect(wantsBrowser(ok('u', 'Just a moment... Enable JavaScript and cookies to continue'))).toBe(true);
    expect(wantsBrowser(ok('u'))).toBe(false);
    expect(wantsBrowser(no('u', 'HTTP_ERROR', 404))).toBe(false);
    expect(wantsReplacement(no('u', 'HTTP_ERROR', 404))).toBe(true);
    expect(wantsReplacement(no('u', 'DNS_FAILED'))).toBe(true);
    expect(wantsReplacement(no('u', 'HTTP_ERROR', 403))).toBe(false);
  });

  it('treats an access control as final', () => {
    for (const status of [401, 402, 451]) expect(isFinalRefusal(no('u', 'HTTP_ERROR', status))).toBe(true);
    expect(isFinalRefusal(no('u', 'ADDRESS_NOT_PUBLIC'))).toBe(true);
    expect(isFinalRefusal(no('u', 'HTTP_ERROR', 403))).toBe(false);
  });

  it('recognises a bot challenge as no source', () => {
    expect(isChallenge(ok('u', 'It needs a human touch. Loading challenge. ERRCODE PXCR10002539'))).toBe(true);
    expect(isChallenge(ok('u'))).toBe(false);
  });
});

describe('readSource', () => {
  it('returns the direct read when it works, and never asks another route', async () => {
    let browserCalls = 0;
    const read = await readSource('https://example.com/a', deps({ direct: async (u) => ok(u), browser: async (u) => (browserCalls++, ok(u)) }));
    expect(read).toMatchObject({ readable: true, method: 'DIRECT' });
    expect(browserCalls).toBe(0);
  });

  it('renders a 403 page in the browser when robots.txt allows it', async () => {
    const read = await readSource('https://example.com/a', deps({ direct: async (u) => no(u, 'HTTP_ERROR', 403), browser: async (u) => ok(u) }));
    expect(read).toMatchObject({ readable: true, method: 'BROWSER', finalUrl: 'https://example.com/a' });
    expect(read.attempts.map((a) => a.method)).toEqual(['DIRECT', 'BROWSER']);
  });

  it('does not render a path robots.txt disallows', async () => {
    let browserCalls = 0;
    const read = await readSource(
      'https://example.com/a',
      deps({ direct: async (u) => no(u, 'HTTP_ERROR', 403), browser: async (u) => (browserCalls++, ok(u)), robotsAllow: async () => false }),
    );
    expect(browserCalls).toBe(0);
    expect(read.readable).toBe(false);
  });

  it('never routes around a private address or a 401', async () => {
    let other = 0;
    const count = async () => (other++, null);
    const privateRead = await readSource(
      'http://10.0.0.5/x',
      deps({ resolve: async () => ['10.0.0.5'], direct: async (u) => ok(u), archive: count, sitemap: count, browser: async (u) => (other++, ok(u)) }),
    );
    expect(privateRead).toMatchObject({ readable: false, reason: 'ADDRESS_NOT_PUBLIC' });
    const login = await readSource('https://example.com/x', deps({ direct: async (u) => no(u, 'HTTP_ERROR', 401), archive: count, sitemap: count, browser: async (u) => (other++, ok(u)) }));
    expect(login).toMatchObject({ readable: false, status: 401 });
    expect(other).toBe(0);
  });

  it('finds a moved page through the sitemap, then the archive, citing what was read', async () => {
    const moved = await readSource('https://example.com/old', deps({ direct: async (u) => no(u, 'HTTP_ERROR', 404), sitemap: async () => ok('https://example.com/new') }));
    expect(moved).toMatchObject({ readable: true, method: 'SITEMAP', finalUrl: 'https://example.com/new' });
    const archived = await readSource(
      'https://example.com/old',
      deps({ direct: async (u) => no(u, 'HTTP_ERROR', 404), archive: async (u) => ({ ...ok(u), finalUrl: `https://web.archive.org/web/2024/${u}` }) }),
    );
    expect(archived).toMatchObject({ readable: true, method: 'ARCHIVE', finalUrl: 'https://web.archive.org/web/2024/https://example.com/old' });
  });

  it('reports a challenge page as unreadable even when it came back as text', async () => {
    const read = await readSource(
      'https://example.com/a',
      deps({ direct: async (u) => no(u, 'HTTP_ERROR', 403), browser: async (u) => ok(u, 'It needs a human touch. Loading challenge.') }),
    );
    expect(read.readable).toBe(false);
    expect(read.attempts.find((a) => a.method === 'BROWSER')).toMatchObject({ readable: false, reason: 'CHALLENGE' });
  });

  it('leads with the browser on a host whose record says direct never works there', async () => {
    let directCalls = 0;
    const read = await readSource(
      'https://blocked.example/a',
      deps({ learned: async () => 'BROWSER', direct: async (u) => (directCalls++, no(u, 'HTTP_ERROR', 403)), browser: async (u) => ok(u) }),
    );
    expect(read).toMatchObject({ readable: true, method: 'BROWSER' });
    expect(directCalls).toBe(0);
  });

  it('records one event per read with every attempt', async () => {
    const seen: string[] = [];
    await readSource('https://example.com/a', deps({ direct: async (u) => no(u, 'HTTP_ERROR', 403), browser: async (u) => ok(u), record: async (r) => void seen.push(`${r.method}:${r.attempts.length}`) }));
    expect(seen).toEqual(['BROWSER:2']);
  });
});

describe('what is learned from the record', () => {
  const row = (host: string, attempts: { method: string; readable: boolean }[]) => ({
    provider: attempts.at(-1)!.method,
    outcome: attempts.at(-1)!.readable ? 'READ' : 'UNREADABLE',
    measures: JSON.stringify({ host, attempts }),
  });
  it('leads with the browser only where direct failed repeatedly and never worked', () => {
    const learned = learnFrom([
      row('a.example', [{ method: 'DIRECT', readable: false }, { method: 'BROWSER', readable: true }]),
      row('a.example', [{ method: 'DIRECT', readable: false }, { method: 'BROWSER', readable: true }]),
      row('b.example', [{ method: 'DIRECT', readable: false }, { method: 'BROWSER', readable: true }]),
      row('b.example', [{ method: 'DIRECT', readable: true }]),
      row('b.example', [{ method: 'DIRECT', readable: false }]),
    ]);
    expect(Object.fromEntries(learned)).toEqual({ 'a.example': 'BROWSER' });
  });

  it('summarises what DIRECT alone would have read beside what the layer read', () => {
    const summary = summarizeAccess([
      { ...row('a.example', [{ method: 'DIRECT', readable: false }, { method: 'BROWSER', readable: true }]), duration_ms: 4000 },
      { ...row('c.example', [{ method: 'DIRECT', readable: true }]), duration_ms: 300 },
      { ...row('d.example', [{ method: 'DIRECT', readable: false }]), duration_ms: 200 },
    ]);
    expect(summary).toMatchObject({ reads: 3, readable: 2, directReadable: 1, byMethod: { BROWSER: 1, DIRECT: 1 }, msPerReadDirect: 300, msPerReadFallback: 4000 });
    expect(summary.failingHosts[0]!.host).toBe('d.example');
  });
});

describe('robots.txt, sitemaps and feeds', () => {
  it('reads the rules for a general reader, longest match winning', () => {
    const rules = robotsRules('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/open\n');
    expect(robotsAllows(rules, '/public')).toBe(true);
    expect(robotsAllows(rules, '/private/x')).toBe(false);
    expect(robotsAllows(rules, '/private/open/y')).toBe(true);
    expect(robotsAllows(robotsRules('User-agent: *\nDisallow: /*.pdf$\n'), '/a/b.pdf')).toBe(false);
  });

  it('lists a sitemap and a feed, and scores paths by shared words', () => {
    expect(listedUrls('<urlset><url><loc>https://e.com/a</loc></url></urlset>').pages).toEqual(['https://e.com/a']);
    expect(listedUrls('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>').sitemaps).toEqual(['https://e.com/s1.xml']);
    expect(listedUrls('<rss><item><link>https://e.com/p</link></item></rss>').pages).toContain('https://e.com/p');
    expect(pathSimilarity('https://e.com/pricing/plans-2024', 'https://e.com/pricing/plans')).toBeGreaterThanOrEqual(0.5);
    expect(pathSimilarity('https://e.com/pricing/plans-2024', 'https://e.com/about/team')).toBe(0);
  });
});

describe('the direct reader reads PDFs', () => {
  it('extracts a PDF text layer instead of refusing it as not text', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText('Median hourly wage for data entry keyers was 19.20 dollars.', { x: 50, y: 700, size: 12, font });
    const bytes = Buffer.from(await doc.save());
    const fetch: HttpFetch = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
    const read = await fetchForWorker('https://example.com/report.pdf', { resolve: publicResolver, fetch });
    expect(read).toMatchObject({ readable: true, contentType: 'application/pdf' });
    expect(read.readable && read.text).toContain('Median hourly wage for data entry keyers was 19.20 dollars.');
  });
});

describe('the Playwright MCP client', () => {
  it('parses a streamable-HTTP reply and the evaluate result', () => {
    const payload = rpcPayload('event: message\ndata: {"result":{"content":[{"type":"text","text":"### Result\\n\\"{\\\\\\"url\\\\\\":\\\\\\"https://e.com/\\\\\\",\\\\\\"text\\\\\\":\\\\\\"hello\\\\\\"}\\"\\n### Ran Playwright code"}]},"jsonrpc":"2.0","id":4}\n\n');
    expect(payload).not.toBeNull();
    expect(evaluateResult(payload!)).toEqual({ url: 'https://e.com/', text: 'hello' });
  });

  it('renders through the server and refuses a page that ended somewhere private', async () => {
    const replies = (finalUrl: string) => {
      let n = 0;
      return (async (_url: string, init: RequestInit) => {
        if (init.method === 'DELETE') return new Response(null, { status: 200 });
        const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string } };
        n += 1;
        const headers = { 'content-type': 'application/json', 'mcp-session-id': 's1' };
        if (body.id === undefined) return new Response(null, { status: 202, headers });
        const text = body.params?.name === 'browser_evaluate' ? `### Result\n${JSON.stringify(JSON.stringify({ url: finalUrl, title: 't', text: LONG }))}` : 'ok';
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }), { status: 200, headers });
      }) as (url: string, init: RequestInit) => Promise<Response>;
    };
    const resolve: Resolver = async (host) => (host === 'internal.example' ? ['10.0.0.9'] : ['93.184.216.34']);
    const good = await renderInBrowser('https://e.com/', { endpoint: 'http://browser/mcp', http: replies('https://e.com/'), resolve });
    expect(good).toMatchObject({ readable: true, finalUrl: 'https://e.com/' });
    const bad = await renderInBrowser('https://e.com/', { endpoint: 'http://browser/mcp', http: replies('http://internal.example/admin'), resolve });
    expect(bad).toMatchObject({ readable: false, reason: 'ADDRESS_NOT_PUBLIC' });
    const none = await renderInBrowser('https://e.com/', { endpoint: null, resolve });
    expect(none).toMatchObject({ readable: false });
  });
});
