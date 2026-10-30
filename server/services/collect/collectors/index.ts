import { collectCsv } from './csv.ts';
import { collectHtmlList } from './htmlList.ts';
import { collectJsonApi } from './jsonApi.ts';
import { collectOverpass } from './overpass.ts';
import { collectPageWatch } from './pageWatch.ts';
import { collectRss } from './rss.ts';
import { collectSitemap } from './sitemap.ts';
import type { CollectOptions, CollectOutcome, CollectorKind, FetchedBody } from './types.ts';

export * from './types.ts';
export { refusalFor } from './shared.ts';

const COLLECTORS: Record<CollectorKind, (fetched: FetchedBody, options: CollectOptions) => CollectOutcome> = {
  RSS_ATOM: collectRss,
  JSON_API: collectJsonApi,
  CSV: collectCsv,
  SITEMAP: collectSitemap,
  HTML_LIST: collectHtmlList,
  OVERPASS: collectOverpass,
  PAGE_WATCH: collectPageWatch,
};

/** One entrance: a fetched body in, a recorded outcome out. Never throws. */
export function collect(kind: CollectorKind, fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  return COLLECTORS[kind](fetched, options);
}
