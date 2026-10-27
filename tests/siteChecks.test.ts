/**
 * Broken money paths: code finds named businesses, code proves the site is
 * broken, and only a problem seen twice becomes a lead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  checkDueSites,
  classify,
  CONFIRM_AFTER_MS,
  mapNextMetro,
  METROS,
  normaliseWebsite,
  OVERPASS_SPACING_MS,
  parseOverpass,
  probeSite,
  siteReading,
  type SiteFetch,
} from '../server/services/feeds/sites.ts';
import { shortlistFunnel } from '../server/services/feeds/run.ts';
import { statesNamedIn } from '../server/domain/jurisdiction.ts';

const now = new Date();

let projectId = '';
let userId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({ email: `site-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
  ).id;
});

describe('what code may call a problem', () => {
  it('names only what it can show, and counts nothing it cannot tell from our own network', () => {
    expect(classify({ errorCode: 'CERT_HAS_EXPIRED' }).problem).toBe('CERT_INVALID');
    expect(classify({ errorCode: 'ENOTFOUND' }).problem).toBe('NO_DNS');
    expect(classify({ errorCode: 'ECONNREFUSED' }).problem).toBe('REFUSED');
    expect(classify({ status: 503 }).problem).toBe('SERVER_ERROR');
    expect(classify({ status: 404 }).problem).toBe('NOT_FOUND');
    expect(classify({ status: 200, body: '<h1>This domain is for sale!</h1>' }).problem).toBe('PARKED');
    expect(classify({ status: 200, body: '<h1>Welcome to Joe’s Diner</h1>' }).problem).toBeNull();
    // Not counted: a timeout, a bot block, an unknown network error.
    expect(classify({ errorName: 'TimeoutError' }).problem).toBeNull();
    expect(classify({ status: 403 }).problem).toBeNull();
    expect(classify({ errorCode: 'ECONNRESET' }).problem).toBeNull();
  });

  it('reads a thrown fetch error by its cause', async () => {
    const throwing: SiteFetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
    };
    expect((await probeSite('https://x.test', throwing)).problem).toBe('CERT_INVALID');
  });

  it('reads mapped businesses and refuses a website that is not one', () => {
    expect(normaliseWebsite('joesdiner.com')).toBe('https://joesdiner.com/');
    expect(normaliseWebsite('localhost')).toBeNull();
    const parsed = parseOverpass({
      elements: [
        { type: 'node', id: 1, tags: { name: "Joe's Diner", website: 'joesdiner.com', amenity: 'restaurant', phone: '+1 555' } },
        { type: 'node', id: 2, tags: { website: 'noname.com' } },
        { type: 'way', id: 3, tags: { name: 'No site' } },
      ],
    });
    expect(parsed).toEqual([{ key: 'osm:node:1', name: "Joe's Diner", category: 'amenity=restaurant', website: 'https://joesdiner.com/', phone: '+1 555' }]);
  });

  it('names no state in any metro', () => {
    for (const metro of METROS) expect(statesNamedIn(`in ${metro.city}`), metro.city).toEqual([]);
  });
});

describe('a problem becomes a lead', () => {
  async function mapped(): Promise<void> {
    const body = {
      elements: [
        { type: 'node', id: 11, tags: { name: 'Broken Bakery', website: 'broken.test', shop: 'bakery' } },
        { type: 'node', id: 12, tags: { name: 'Fine Florist', website: 'fine.test', shop: 'florist' } },
        { type: 'node', id: 13, tags: { name: 'Flaky Cafe', website: 'flaky.test', amenity: 'cafe' } },
      ],
    };
    expect((await mapNextMetro({ now, fetcher: async () => body }))?.added).toBe(3);
  }

  it('only after it is seen twice, an hour apart, and only once', async () => {
    await mapped();
    // Not asked again inside the spacing.
    expect(await mapNextMetro({ now: new Date(now.getTime() + 60_000), fetcher: async () => ({ elements: [] }) })).toBeNull();
    expect(await mapNextMetro({ now: new Date(now.getTime() + OVERPASS_SPACING_MS + 1), fetcher: async () => ({ elements: [] }) })).not.toBeNull();

    let flaky = true;
    const fetcher: SiteFetch = async (url) => {
      if (url.includes('broken')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
      if (url.includes('flaky')) {
        if (flaky) return { status: 502, body: '', finalUrl: url };
        return { status: 200, body: 'menu', finalUrl: url };
      }
      return { status: 200, body: 'flowers', finalUrl: url };
    };
    expect(await checkDueSites({ now, fetcher })).toMatchObject({ checked: 3, problems: 2, filed: 0 });
    // Too soon: nothing rechecked.
    expect((await checkDueSites({ now: new Date(now.getTime() + 10 * 60_000), fetcher })).checked).toBe(0);
    flaky = false;
    const later = new Date(now.getTime() + CONFIRM_AFTER_MS + 60_000);
    expect(await checkDueSites({ now: later, fetcher })).toMatchObject({ checked: 2, problems: 1, filed: 1 });
    expect(await checkDueSites({ now: new Date(later.getTime() + CONFIRM_AFTER_MS + 60_000), fetcher })).toMatchObject({ filed: 0 });

    const leads = await getDb().all<{ title: string; organization: string }>("SELECT title, organization FROM feed_items WHERE source = 'broken-site'");
    expect(leads).toHaveLength(1);
    expect(leads[0]!.title).toContain('Broken Bakery in ');
    expect(leads[0]!.title).toContain('security warning');
    expect(await siteReading()).toMatchObject({ businesses: 3, confirmed: 1, pending: 0, byProblem: { CERT_INVALID: 1 } });

    // And it reaches the shortlist with no free model asked.
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const funnel = await shortlistFunnel(projectId, later);
    expect(funnel.chosen.map(({ item }) => item.organization)).toContain('Broken Bakery');
  });
});
