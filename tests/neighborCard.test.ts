import { describe, expect, it } from 'vitest';
import {
  STEPS, PUBLISHER_ADDRESS, bestEmail, hasMailServer, campaignDefinition, extractEmails, isLocationSubpage, isPlausibleEmail,
  shapeProblems, syncCampaign, OSM_TILES, committedElsewhere, type Deps,
} from '../server/services/cash/neighborCard.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function deps(route: (method: string, path: string, body: unknown) => Response): Deps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: { INSTANTLY_API_KEY: 'k'.repeat(40) },
    sleep: async () => {},
    resolveMx: async () => true,
    log: () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.instantly.ai/api/v2', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      return route(method, path, init?.body ? JSON.parse(String(init.body)) : undefined);
    }) as typeof fetch,
  };
}

describe('finding a published address (V2 lookup, fixed)', () => {
  it('refuses the vendor, agency and platform addresses that leaked into the first pull', () => {
    for (const leaked of ['sam.clark@level.agency', 'support@moxiworks.com', 'bugreport@moatable.com', 'x@sentry.wixpress.com', 'noreply@realdentist.com']) {
      expect(isPlausibleEmail(leaked)).toBe(false);
    }
    expect(isPlausibleEmail('office@mccrackenfamilydentistry.com')).toBe(true);
  });

  it('takes only what the page publishes, and prefers a named person to a role account', () => {
    const html = '<a href="mailto:info@acme-hvac.com">x</a> <a href="mailto:maria@acme-hvac.com">Maria</a> logo@2x.png support@wix.com';
    const found = extractEmails(html, 'https://acme-hvac.com/contact', 'acme-hvac.com');
    expect(found.map((f) => f.email).sort()).toEqual(['info@acme-hvac.com', 'maria@acme-hvac.com']);
    expect(bestEmail(found)?.email).toBe('maria@acme-hvac.com');
  });

  it('keeps an off-domain address only when it was published as a mailto link', () => {
    expect(bestEmail(extractEmails('write to owner@gmail.com', 'https://x.com', 'x.com'))).toBeNull();
    expect(bestEmail(extractEmails('<a href="mailto:owner@gmail.com">mail</a>', 'https://x.com', 'x.com'))?.email).toBe('owner@gmail.com');
  });

  it('treats a location page on a multi-location site as the head office for role addresses', () => {
    expect(isLocationSubpage('https://assistinghands.com/137/pennsylvania/mechanicsburg')).toBe(true);
    expect(isLocationSubpage('https://rotherdental.com/')).toBe(false);
  });
});

describe('the campaign as written is the campaign as read back', () => {
  const senders = ['a@one.com', 'b@two.com'];

  it('carries the mailing address and separate paragraphs in every step', () => {
    for (const step of STEPS) {
      expect(step.body).toContain(PUBLISHER_ADDRESS);
      expect(step.body).toContain('no thanks');
    }
    const written = campaignDefinition(senders, 105);
    expect(shapeProblems(written, senders, 105)).toEqual([]);
  });

  it('names a blank body, a missing address and a throttling cap', () => {
    const written = campaignDefinition(senders, 105) as { sequences: { steps: { variants: { body: string }[] }[] }[] };
    written.sequences[0]!.steps[1]!.variants[0]!.body = '';
    written.sequences[0]!.steps[2]!.variants[0]!.body = '<p>a</p><p>b</p>';
    const problems = shapeProblems({ ...written, daily_limit: 60 }, senders, 105);
    expect(problems.join(' | ')).toMatch(/step 2 body is blank/);
    expect(problems.join(' | ')).toMatch(/step 3 lacks the mailing address/);
    expect(problems.join(' | ')).toMatch(/daily limit reads 60, expected 105/);
  });
});

describe('sync', () => {
  const accounts = { items: [
    { email: 'a@one.com', status: 1, warmup_status: 1, daily_limit: 90 },
    { email: 'b@two.com', status: 1, warmup_status: 1, daily_limit: 15 },
    { email: 'banned@three.com', status: 1, warmup_status: -1, daily_limit: 15 },
    { email: 'off@four.com', status: -1, warmup_status: 1, daily_limit: 90 },
  ] };

  function workspace(status: number, failFirstAccounts = 0) {
    let stored: Record<string, unknown> = {};
    let accountTries = 0;
    return deps((method, path, body) => {
      if (path.startsWith('/accounts')) {
        accountTries += 1;
        return accountTries <= failFirstAccounts ? json({ error: 'slow down' }, 429, { 'retry-after': '1' }) : json(accounts);
      }
      if (path.startsWith('/campaigns?')) return json({ items: [{ id: 'c1', name: 'Neighbor Card · Camp Hill Jan 2027', status }] });
      if (method === 'PATCH') { stored = body as Record<string, unknown>; return json({}); }
      if (path === '/campaigns/c1') return json({ ...stored, status });
      return json({});
    });
  }

  it('sends from every healthy account with their combined limit, after retrying a rate limit', async () => {
    const d = workspace(1, 2);
    const result = await syncCampaign(d);
    expect(result.senders).toBe(2);
    expect(result.dailyCapacity).toBe(105);
    expect(d.calls.filter((c) => c.startsWith('GET /accounts')).length).toBe(3);
  });

  it('never resumes a campaign Instantly paused for bounces', async () => {
    const d = workspace(-2);
    const result = await syncCampaign(d);
    expect(result.status).toBe(-2);
    expect(result.line).toMatch(/not resumed automatically/);
    expect(d.calls.some((c) => c.includes('/activate'))).toBe(false);
  });
});

describe('mail-server check', () => {
  const doh = (body: unknown) => (async () => json(body)) as unknown as typeof fetch;
  it('accepts a domain with an MX answer and refuses NXDOMAIN or a null MX', async () => {
    expect(await hasMailServer('rotherdental.com', doh({ Status: 0, Answer: [{ type: 15, data: '0 rotherdental-com.mail.protection.outlook.com.' }] }))).toBe(true);
    expect(await hasMailServer('gone.example', doh({ Status: 3 }))).toBe(false);
    expect(await hasMailServer('nomail.example', doh({ Status: 0, Answer: [{ type: 15, data: '0 .' }] }))).toBe(false);
  });
});

describe('the area searched and the capacity used', () => {
  it('covers the whole Harrisburg and West Shore area, Camp Hill first', () => {
    const boxes = OSM_TILES.map((t) => t.split(',').map(Number) as [number, number, number, number]);
    const inside = (lat: number, lon: number) => boxes.some(([s, w, n, e]) => lat >= s && lat < n && lon >= w && lon < e);
    expect(new Set(OSM_TILES).size).toBe(OSM_TILES.length);
    const [s, w, n, e] = boxes[0]!;
    expect(40.239 >= s && 40.239 < n && -76.92 >= w && -76.92 < e, 'Camp Hill is in the first tile').toBe(true);
    for (const [lat, lon, town] of [[40.214, -77.008, 'Mechanicsburg'], [40.263, -76.884, 'Harrisburg'], [40.201, -77.189, 'Carlisle'], [40.272, -76.684, 'Hummelstown'], [40.108, -77.035, 'Dillsburg']] as const) {
      expect(inside(lat, lon), town).toBe(true);
    }
  });

  it('subtracts what other active campaigns on the same senders send a day', async () => {
    const d = deps((_m, path) => {
      if (path.startsWith('/campaigns?')) {
        return json({ items: [
          { id: 'mine', status: 1, name: 'Neighbor Card', email_list: ['a@x.com'] },
          { id: 'other', status: 1, name: 'AI Dispatch', email_list: ['a@x.com', 'z@y.com'] },
          { id: 'paused', status: 2, name: 'Old', email_list: ['a@x.com'] },
          { id: 'apart', status: 1, name: 'Elsewhere', email_list: ['q@q.com'] },
        ] });
      }
      if (path.startsWith('/campaigns/analytics/daily?campaign_id=other')) return json([{ sent: 2 }, { sent: 7 }, { sent: 3 }]);
      return json({}, 404);
    });
    const r = await committedElsewhere(d, 'mine', ['a@x.com']);
    expect(r.committed).toBe(7);
    expect(r.line).toBe('shared senders also carry: AI Dispatch 7/day');
  });
});

describe('chamber member pages', () => {
  it('reads both GrowthZone layouts', async () => {
    const { chamberMember } = await import('../server/services/cash/neighborCard.ts');
    const older = '<h1 itemprop="name">Smile Dental</h1><a itemprop="url" href="http://smile.example">x</a><span class="mn-cityspan">Camp Hill</span>';
    expect(chamberMember(older)).toEqual({ website: 'http://smile.example', town: 'Camp Hill', name: 'Smile Dental' });
    const newer = '<a href="/" target="_self" itemprop="url"><img></a><meta itemprop="name" content="Neslund DMD" /><a href="http://www.neslund.example" onclick="MNI.Hit.MemberWebsite(5002925)" itemprop="url" class="card-link"><span class="gz-address-city" itemprop="addressLocality">Carlisle</span>';
    expect(chamberMember(newer)).toEqual({ website: 'http://www.neslund.example', town: 'Carlisle', name: 'Neslund DMD' });
  });
});

describe('who is a neighborhood advertiser', () => {
  it('refuses national brands, institutions and network location pages', async () => {
    const { isChainOrInstitution, isNetworkPage } = await import('../server/services/cash/neighborCard.ts');
    expect(isChainOrInstitution('www.geico.com')).toBe(true);
    expect(isChainOrInstitution('agent@aflac.com')).toBe(true);
    expect(isChainOrInstitution('wellness@dickinson.edu')).toBe(true);
    expect(isChainOrInstitution('smiledentalcamphill.com')).toBe(false);
    expect(isNetworkPage('https://www.athletico.com/locations/mechanicsburg-pa/')).toBe(true);
    expect(isNetworkPage('https://www.geico.com/insurance-agents/pennsylvania/harrisburg/')).toBe(true);
    expect(isNetworkPage('https://smile.example/contact-us/')).toBe(false);
  });
});

describe('Places in one pass', () => {
  it('stops sending searches once Google refuses one', async () => {
    const { discoverPlaces } = await import('../server/services/cash/neighborCard.ts');
    let calls = 0;
    const deps = { places: async () => { calls += 1; throw new Error('V2 Places answered 502 places_error'); } } as unknown as Parameters<typeof discoverPlaces>[0];
    const { line } = await discoverPlaces(deps, 0, 3);
    expect(calls).toBe(1);
    expect(line).toContain('not read');
  });
});

describe('West Shore Chamber listings', () => {
  it('maps a local member with its published address, and refuses off-category, out-of-area and foreign-domain rows', async () => {
    const { westShoreCandidate, directoryEmail } = await import('../server/services/cash/neighborCard.ts');
    const row = { ListingId: 1432, DisplayName: 'Daflure Heating and Cooling', ListingCategory: 'Plumbing/HVAC', CategoryUrlName: 'plumbing-hvac', ListingUrlName: 'Daflure-1432', City: 'Camp Hill', Website: 'www.daflure.com', Email: 'BCrossley@Daflure.com', Member: true };
    const c = westShoreCandidate(row)!;
    expect(c).toMatchObject({ category: 'contractor', website: 'http://www.daflure.com', email: 'bcrossley@daflure.com', town: 'Camp Hill' });
    expect(directoryEmail(c)).toMatchObject({ email: 'bcrossley@daflure.com', confidence: 0.9 });
    expect(westShoreCandidate({ ...row, ListingCategory: 'Non-Profit' })).toBeNull();
    expect(westShoreCandidate({ ...row, City: 'Pittsburgh' })).toBeNull();
    expect(directoryEmail({ ...c, email: 'sales@agency-elsewhere.com' })).toBeNull();
    expect(directoryEmail({ ...c, email: 'bob.daflure@gmail.com' })).not.toBeNull();
  });
});
