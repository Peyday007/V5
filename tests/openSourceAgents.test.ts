/**
 * The open-source agents (§104): Brain takes only what a business published,
 * asks the agents only where its own reader found nothing, and records each call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { listIntegrationEvents } from '../server/repos/integrationEvents.ts';
import {
  agentsConfig, browserModel, pickBrowser, pickSellbird, probeAgents, sellbirdContacts,
  type BrowserContact, type SellbirdContacts,
} from '../server/services/agents/client.ts';
import { refill, type Deps } from '../server/services/cash/neighborCard.ts';
import { integration } from '../server/services/integrations/registry.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

const ENV = { BRAIN_AGENTS_URL: 'http://northline-agents.flycast', BRAIN_AGENTS_KEY: 'a'.repeat(64) };

function reading(over: Partial<SellbirdContacts> = {}): SellbirdContacts {
  return { domain: 'harborplumbing.com', reachable: true, challenged: false, siteName: 'Harbor Plumbing', pagesRead: 3, people: [], inbox: null, publishedAddresses: [], ...over };
}

beforeAll(async () => {
  await freshProject();
});
afterAll(async () => {
  await teardown();
});

describe('what Brain takes from an agent', () => {
  it("takes a named owner's address only when the site published it, with the first name for the greeting", () => {
    const guessed = reading({ people: [{ firstName: 'Gary', lastName: 'Pruitt', title: 'Owner', owner: true, email: 'gary.pruitt@harborplumbing.com', status: 'guess', published: false, evidenceUrl: 'https://harborplumbing.com/about' }] });
    expect(pickSellbird(guessed)).toBeNull();
    const published = reading({ people: [{ ...guessed.people[0]!, email: 'Gary@harborplumbing.com', published: true }], inbox: { email: 'office@harborplumbing.com', published: true } });
    expect(pickSellbird(published)).toEqual({ email: 'gary@harborplumbing.com', sourceUrl: 'https://harborplumbing.com/about', firstName: 'Gary', via: 'sellbird' });
  });

  it("falls back to the business's published inbox, with no name", () => {
    expect(pickSellbird(reading({ inbox: { email: 'office@harborplumbing.com', published: true } }))?.firstName).toBeNull();
  });

  it('takes a browser answer only when it was found on the page it cites', () => {
    const base: BrowserContact = { domain: 'x.com', status: 'UNVERIFIED', email: 'info@x.com', sourceUrl: 'https://x.com/c', verified: false, steps: 4, seconds: 30, error: null };
    expect(pickBrowser(base)).toBeNull();
    expect(pickBrowser({ ...base, status: 'VERIFIED', verified: true })?.email).toBe('info@x.com');
  });

  it('thinks with the RunPod model Brain already runs, and sends no browser task without one', () => {
    expect(browserModel({})).toBeNull();
    expect(browserModel({ BRAIN_RUNPOD_URL: 'https://pod-8000.proxy.runpod.net', BRAIN_RUNPOD_MODE: 'primary', BRAIN_RUNPOD_MODEL: 'Qwen/Qwen3-4B', BRAIN_RUNPOD_KEY: 'k' }))
      .toEqual({ baseUrl: 'https://pod-8000.proxy.runpod.net/v1', model: 'Qwen/Qwen3-4B', apiKey: 'k' });
  });
});

describe('the interface and its record', () => {
  it('is off, and calls nothing, until both settings are present', async () => {
    expect(agentsConfig({ BRAIN_AGENTS_URL: ENV.BRAIN_AGENTS_URL })).toBeNull();
    let called = false;
    const out = await sellbirdContacts('harborplumbing.com', { env: {}, fetch: (async () => { called = true; return json({}); }) as typeof fetch });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it('sends the key, and records each call as a USAGE row with the address masked', async () => {
    let auth = '';
    const answer = reading({ inbox: { email: 'office@harborplumbing.com', published: true } });
    const out = await sellbirdContacts('harborplumbing.com', {
      env: ENV,
      source: 'test',
      fetch: (async (_url: string, init?: RequestInit) => { auth = String((init?.headers as Record<string, string>).authorization); return json(answer); }) as typeof fetch,
    });
    expect(out?.inbox?.email).toBe('office@harborplumbing.com');
    expect(auth).toBe(`Bearer ${ENV.BRAIN_AGENTS_KEY}`);
    const rows = (await listIntegrationEvents('USAGE')).filter((e) => e.integrationId === 'open-source-agents');
    expect(rows[0]?.state).toBe('SELLBIRD_FOUND');
    expect(rows[0]?.detail).toContain('…@harborplumbing.com');
    expect(rows[0]?.detail).not.toContain('office@');
  });

  it('records a failed call and returns nothing rather than throwing', async () => {
    const out = await sellbirdContacts('harborplumbing.com', { env: ENV, source: 'test', fetch: (async () => json({ detail: 'unauthorized' }, 401)) as typeof fetch });
    expect(out).toBeNull();
    const rows = (await listIntegrationEvents('USAGE')).filter((e) => e.integrationId === 'open-source-agents');
    expect(rows[0]?.state).toBe('SELLBIRD_FAILED');
  });

  it("reads a refused key as Brain's own repair, never the owner's", async () => {
    const fetcher = (async (url: string) => (String(url).endsWith('/healthz') ? json({ ok: true, agents: { sellbird: '0.4.0' } }) : json({ detail: 'unauthorized' }, 401))) as typeof fetch;
    expect((await probeAgents(ENV, fetcher)).ok).toBe('repairing');
    const accepted = (async (url: string) => (String(url).endsWith('/healthz') ? json({ ok: true, agents: { sellbird: '0.4.0' } }) : json({ detail: 'bad' }, 400))) as typeof fetch;
    expect((await probeAgents(ENV, accepted)).ok).toBe(true);
  });

  it('is declared in the integration registry, with both settings written by its workflow', () => {
    const def = integration('open-source-agents');
    expect(def.credentials.map((c) => [c.name, c.delivery])).toEqual([['BRAIN_AGENTS_URL', ['WORKFLOW']], ['BRAIN_AGENTS_KEY', ['WORKFLOW']]]);
    expect(def.probe).toBe('agents');
  });
});

describe('the Neighbor Card refill with the agents connected', () => {
  function world(sitePage: string) {
    const leads: Record<string, unknown>[] = [];
    const deps: Deps = {
      env: { INSTANTLY_API_KEY: 'k'.repeat(40) },
      sleep: async () => {},
      resolveMx: async () => true,
      log: () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith('https://api.instantly.ai/api/v2/leads/list')) return json({ items: [] });
        if (u.startsWith('https://api.instantly.ai/api/v2/leads')) { leads.push(JSON.parse(String(init?.body))); return json({}); }
        if (u.includes('overpass')) {
          return u.includes('overpass-api.de')
            ? json({ elements: [{ tags: { name: 'Harbor Plumbing', website: 'https://harborplumbing.com', craft: 'plumber', 'addr:city': 'Camp Hill' } }] })
            : json({ elements: [] });
        }
        if (u.startsWith('https://harborplumbing.com')) return html(sitePage);
        return new Response('', { status: 404 });
      }) as typeof fetch,
    };
    return { deps, leads };
  }

  it('asks Sellbird only about a site with no address the plain reader found, and greets the owner by name', async () => {
    const { deps, leads } = world('<html><body>Call us</body></html>');
    const asked: string[] = [];
    deps.agents = {
      sellbird: async (w) => {
        asked.push(w);
        return reading({ people: [{ firstName: 'Gary', lastName: 'Pruitt', title: 'Owner', owner: true, email: 'gary@harborplumbing.com', status: 'guess', published: true, evidenceUrl: 'https://harborplumbing.com/about' }] });
      },
      browser: null,
      sellbirdPerPass: 5,
      browserPerPass: 0,
    };
    const result = await refill(deps, 'c1', { slot: 0, maxSites: 5 });
    expect(asked).toEqual(['https://harborplumbing.com']);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ email: 'gary@harborplumbing.com', campaign: 'c1', skip_if_in_workspace: true });
    expect((leads[0]!.custom_variables as Record<string, string>).greeting).toBe('Gary');
    expect(result.viaAgents).toEqual({ sellbirdAsked: 1, sellbirdFound: 1, browserAsked: 0, browserFound: 0 });
    expect(result.line).toContain('agents: Sellbird 1/1 found');
  });

  it('does not ask an agent when the plain reader already found an address', async () => {
    const { deps, leads } = world('<html><body><a href="mailto:office@harborplumbing.com">office@harborplumbing.com</a></body></html>');
    let asked = 0;
    deps.agents = { sellbird: async () => { asked += 1; return null; }, browser: null, sellbirdPerPass: 5, browserPerPass: 0 };
    await refill(deps, 'c1', { slot: 0, maxSites: 5 });
    expect(asked).toBe(0);
    expect((leads[0]!.custom_variables as Record<string, string>).greeting).toBe('there');
  });

  it('sends a shell to the browser agent, and takes only a verified address on the business’s own domain', async () => {
    for (const [answer, expected] of [
      [{ status: 'VERIFIED', verified: true, email: 'hello@harborplumbing.com' }, 1],
      [{ status: 'UNVERIFIED', verified: false, email: 'owner@harborplumbing.com' }, 0],
      [{ status: 'VERIFIED', verified: true, email: 'someone@gmail.com' }, 0],
    ] as const) {
      const { deps, leads } = world('<html><body><div id="root"></div></body></html>');
      deps.agents = {
        sellbird: async () => reading({ pagesRead: 1 }),
        browser: async () => ({ domain: 'harborplumbing.com', sourceUrl: 'https://harborplumbing.com/contact', steps: 3, seconds: 40, error: null, ...answer }),
        sellbirdPerPass: 5,
        browserPerPass: 1,
      };
      await refill(deps, 'c1', { slot: 0, maxSites: 5 });
      expect(leads).toHaveLength(expected);
    }
  });
});
