/**
 * FEED_CONNECTOR_REPAIR:hn-seeking-freelancer — 18 consecutive successful pulls
 * read no records where the same parser had read 112 (SCHEMA_CHANGED).
 *
 * Fixture provenance: the live endpoint
 * https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=5&query=%22seeking%20freelancer%22
 * could not be read by the worker that wrote this test — the sandbox egress
 * proxy refused it (`curl: (56) CONNECT tunnel failed, response 403`) and
 * brain_fetch_source refused it under a factory-unit lease ("No such resource,
 * or it is not available to you."). The bodies below therefore follow the
 * documented Algolia HN Search API hit fields (objectID, comment_text, author,
 * created_at, created_at_i; multi-query `results[n].hits`) and HN's comment HTML
 * (paragraphs as `<p>`, numeric entities such as `&#x2F;`). They are not a
 * captured production body; the shape that reproduces the failure is a
 * comment whose first paragraph is itself wrapped in `<p>…</p>`, which the old
 * `split(/<p>|\n/)[0]` read as an empty heading, dropping every hit.
 */
import { describe, expect, it } from 'vitest';
import { parseHnFreelance } from '../server/services/feeds/sources.ts';

const buyers = parseHnFreelance('SEEKING FREELANCER');
const sellers = parseHnFreelance('SEEKING WORK');

/** The old parser, verbatim, so the test shows this body read as zero before the change. */
function oldHeading(raw: string): string {
  return raw.split(/<p>|\n/i)[0]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const wrapped = {
  hits: [
    {
      objectID: '42123456',
      author: 'acme_ops',
      created_at: '2026-11-03T15:04:05.000Z',
      created_at_i: 1793718245,
      comment_text:
        '<p>SEEKING FREELANCER | Shopify theme developer | Remote (US)</p><p>We need a developer to rebuild our product page templates. Budget $4k, 3 weeks. Contact ops&#x40;acme.example &#x2F; see acme.example&#x2F;jobs</p>',
      story_id: 42000000,
      parent_id: 42000000,
      _tags: ['comment', 'author_acme_ops', 'story_42000000'],
    },
    {
      objectID: '42123457',
      author: 'dataco',
      created_at_i: 1793721845,
      comment_text: '<p>Seeking freelancer: Data pipeline engineer (Airflow, dbt)<br>Two months, part time.</p>',
    },
  ],
  nbHits: 2,
  page: 0,
  hitsPerPage: 5,
};

describe('parseHnFreelance reads the current Algolia HN comment shape', () => {
  it('reproduces the zero-record failure for the old heading rule and reads the records now', () => {
    // Before: the first paragraph of a wrapped comment was empty, so the tag never matched.
    expect(oldHeading(wrapped.hits[0]!.comment_text)).toBe('');

    const items = buyers(wrapped);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      externalId: '42123456',
      url: 'https://news.ycombinator.com/item?id=42123456',
      title: 'Shopify theme developer',
      body: expect.stringContaining('ops@acme.example / see acme.example/jobs'),
      organization: 'acme_ops',
      publishedAt: '2026-11-03T15:04:05.000Z',
    });
    expect(items[1]).toMatchObject({
      externalId: '42123457',
      title: 'Data pipeline engineer (Airflow, dbt)',
      organization: 'dataco',
      publishedAt: new Date(1793721845 * 1000).toISOString(),
    });
  });

  it('still reads the earlier unwrapped shape, and hits from a multi-query response', () => {
    const unwrapped = { hits: [{ objectID: '1', author: 'a', created_at: '2026-10-01T00:00:00Z', comment_text: 'SEEKING FREELANCER | React Native app<p>Details here.' }] };
    expect(buyers(unwrapped).map((one) => one.title)).toEqual(['React Native app']);
    const multi = { results: [{ hits: unwrapped.hits }, { hits: wrapped.hits }] };
    expect(buyers(multi)).toHaveLength(3);
  });

  it('preserves the SEEKING WORK side through the same parser', () => {
    const body = { hits: [{ objectID: '9', author: 'dev', created_at: '2026-11-02T00:00:00Z', comment_text: '<p>SEEKING WORK | Remote | Go, Postgres backend contractor</p><p>Rate $120/h.</p>' }] };
    expect(sellers(body)).toEqual([
      expect.objectContaining({ externalId: '9', title: 'Go, Postgres backend contractor', organization: 'dev' }),
    ]);
    expect(buyers(body)).toEqual([]);
  });

  it('never throws on a strange body and returns nothing for it', () => {
    const strange: unknown[] = [
      null,
      undefined,
      '',
      'not json',
      42,
      [],
      [null, 1, 'x'],
      { hits: 'x' },
      { hits: [null, 1, 'x', [], {}] },
      { results: 'x' },
      { results: [null, { hits: 'x' }] },
      { hits: [{ objectID: {}, comment_text: 5, author: [], created_at: {} }] },
      { hits: [{ objectID: '3', comment_text: '&#xFFFFFFFF; &#0; <p></p>' }] },
    ];
    for (const body of strange) {
      expect(() => buyers(body)).not.toThrow();
      expect(buyers(body)).toEqual([]);
    }
  });

  it('does not loosen what counts as a request', () => {
    const body = {
      hits: [
        // A reply that quotes the tag later is not a request.
        { objectID: '5', author: 'r', comment_text: '<p>Did anyone answer the SEEKING FREELANCER | Shopify post?</p>' },
        // A heading that names only a place says where, never what.
        { objectID: '6', author: 'p', comment_text: '<p>SEEKING FREELANCER | Remote | Germany</p><p>More soon.</p>' },
        // An encoded angle bracket never becomes markup that hides the tag.
        { objectID: '7', author: 'q', comment_text: '&#60;p&#62;SEEKING FREELANCER | Logo design' },
      ],
    };
    expect(buyers(body)).toEqual([]);
  });
});
