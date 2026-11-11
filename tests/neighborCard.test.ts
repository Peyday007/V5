import { describe, expect, it } from 'vitest';
import {
  STEPS, PUBLISHER_ADDRESS, bestEmail, campaignDefinition, extractEmails, isLocationSubpage, isPlausibleEmail,
  shapeProblems, syncCampaign, type Deps,
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
