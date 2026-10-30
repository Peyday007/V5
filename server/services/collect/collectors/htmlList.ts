import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { attr, recordFrom, run } from './shared.ts';

/**
 * HTML list page. mapping.itemClass names the repeating element's class
 * (default: <li> and <article>); links inside are the record URLs; a <time
 * datetime> is the date; rel="next" is the next page. Deterministic and
 * regex-bounded: no script is run and nothing is fetched.
 */
export function collectHtmlList(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  const itemClass = options.mapping?.itemClass;
  return run(fetched, options.previous, () => {
    const html = fetched.body.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, '');
    const blocks = [...html.matchAll(/<(li|article|tr)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
      .filter((m) => !itemClass || (attr(`<x ${m[2] ?? ''}>`, 'class') ?? '').split(/\s+/).includes(itemClass))
      .map((m) => m[3] ?? '');
    const records = blocks
      .map((block) => {
        const a = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        const href = a ? attr(a[0], 'href') : null;
        const time = /<time\b[^>]*>/i.exec(block);
        const org = /<[a-z]+\b[^>]*class\s*=\s*["'][^"']*(?:org|company|employer)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(block);
        const loc = /<[a-z]+\b[^>]*class\s*=\s*["'][^"']*(?:location|city)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(block);
        const price = /<[a-z]+\b[^>]*class\s*=\s*["'][^"']*(?:price|amount|salary)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(block);
        return recordFrom(
          {
            url: href,
            title: a ? a[1] : null,
            publishedAt: time ? (attr(time[0], 'datetime') ?? null) : null,
            organization: org?.[1],
            location: loc?.[1],
            amount: price?.[1],
            body: block,
          },
          options.url,
        );
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.url !== null);
    const nextTag = [...html.matchAll(/<(?:a|link)\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'rel') === 'next');
    return { records, nextPage: nextTag ? attr(nextTag, 'href') : null };
  }, options.maxRecords);
}
