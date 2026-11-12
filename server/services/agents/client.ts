/**
 * Brain's open-source agents (§104): Sellbird and Browser Use, reached through
 * one narrow private interface, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * What each one is for, and what it is not
 * ---------------------------------------------------------------------------
 *
 *  - **Sellbird** (`agents/brain_agents/contacts.py`) answers "who decides at
 *    this business, and which address does it publish?" from the business's own
 *    pages: named owners and managers, their published addresses, the general
 *    inbox (decoding the usual hiding tricks). No model, no sending.
 *  - **Browser Use** (`agents/brain_agents/browse.py`) answers the same
 *    question for a site plain HTTP cannot read (a JavaScript shell), with an
 *    LLM driving a real Chromium whose tools can only read — and the answer is
 *    checked against the page it cites before Brain sees it as verified.
 *
 * Neither holds state, sends a message, buys or commits to anything. Brain
 * owns the prospect, the decision to contact (the Neighbor Card campaign, the
 * CONTACT_BUYER grant) and the record: every call here is one
 * `integration_events` USAGE row under `open-source-agents`.
 *
 * The service is the `northline-agents` Fly app on a Flycast (private)
 * address, written to the Brain by `.github/workflows/agents.yml` with the key
 * both sides hold. Unset, every function here is a no-op and the callers
 * behave exactly as before.
 */
import { recordIntegrationEvent } from '../../repos/integrationEvents.ts';
import { laneConfig } from '../cheap/lane.ts';
import { runpodConfig } from '../cheap/runpod.ts';

export const AGENTS_INTEGRATION = 'open-source-agents';

export interface AgentsConfig {
  url: string;
  key: string;
}

export function agentsConfig(env: NodeJS.ProcessEnv = process.env): AgentsConfig | null {
  const url = env['BRAIN_AGENTS_URL']?.trim().replace(/\/+$/, '');
  const key = env['BRAIN_AGENTS_KEY']?.trim();
  return url && key ? { url, key } : null;
}

export interface SellbirdPerson {
  firstName: string;
  lastName: string;
  title: string;
  owner: boolean;
  email: string | null;
  status: string;
  published: boolean;
  evidenceUrl: string;
}

export interface SellbirdContacts {
  domain: string;
  reachable: boolean;
  challenged: boolean;
  siteName: string;
  pagesRead: number;
  people: SellbirdPerson[];
  inbox: { email: string; published: boolean } | null;
  publishedAddresses: string[];
  error?: string;
}

export interface BrowserContact {
  domain: string;
  status: 'VERIFIED' | 'UNVERIFIED' | 'NONE_PUBLISHED' | 'NO_ANSWER' | 'TIMEOUT' | 'ERROR';
  email: string | null;
  sourceUrl: string | null;
  verified: boolean;
  steps: number;
  seconds: number;
  error: string | null;
}

/** What Brain accepts from either agent: an address the business itself published, and who it reaches. */
export interface AgentFinding {
  email: string;
  sourceUrl: string;
  /** A named person's first name when the address is theirs; null for a general inbox. */
  firstName: string | null;
  via: 'sellbird' | 'browser-use';
}

export type Fetch = typeof fetch;

/** A safe one-line form of an address for a record: the domain only. */
export function maskEmail(email: string): string {
  return email.replace(/^[^@]+/, '…');
}

export async function call<T>(cfg: AgentsConfig, path: string, body: unknown, timeoutMs: number, fetcher: Fetch): Promise<T> {
  const res = await fetcher(`${cfg.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agents service answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The model the browser agent thinks with: the RunPod GPU Brain already runs
 * (§85), else the cheap lane's own address. Null when Brain has neither, and
 * then no browser task is sent. The key travels only inside Fly's private
 * network to the agents app and is never recorded.
 */
export function browserModel(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; model: string; apiKey: string | null } | null {
  const pod = runpodConfig(env);
  if (pod) return { baseUrl: pod.url, model: pod.model, apiKey: pod.key };
  const lane = laneConfig(env);
  if (lane && lane.models[0] && lane.models[0] !== 'auto') return { baseUrl: lane.url, model: lane.models[0], apiKey: lane.key };
  return null;
}

/** Sellbird's reading of one business: who decides and what it publishes. One USAGE row. */
export async function sellbirdContacts(
  website: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: Fetch; source?: string } = {},
): Promise<SellbirdContacts | null> {
  const cfg = agentsConfig(options.env);
  if (!cfg) return null;
  const source = options.source ?? 'neighbor card';
  try {
    const out = await call<SellbirdContacts>(cfg, '/v1/sellbird/contacts', { website }, 100_000, options.fetch ?? fetch);
    const found = pickSellbird(out);
    await recordIntegrationEvent({
      integrationId: AGENTS_INTEGRATION,
      kind: 'USAGE',
      state: found ? 'SELLBIRD_FOUND' : out.error ? 'SELLBIRD_FAILED' : 'SELLBIRD_NONE',
      detail:
        `sellbird ${out.domain}: ${out.pagesRead} page(s), ${out.people.length} decision maker(s)` +
        `${out.people[0] ? ` (${out.people[0].title || 'named'})` : ''}, inbox ${out.inbox ? maskEmail(out.inbox.email) : 'none'}` +
        `${found ? `; using ${maskEmail(found.email)}${found.firstName ? ' (named owner/manager)' : ''}` : ''}` +
        `${out.challenged ? '; bot challenge' : ''}${out.reachable ? '' : '; site unreachable'}${out.error ? `; ${out.error}` : ''}`,
      source,
    });
    return out;
  } catch (error) {
    await recordIntegrationEvent({
      integrationId: AGENTS_INTEGRATION,
      kind: 'USAGE',
      state: 'SELLBIRD_FAILED',
      detail: `sellbird ${website}: ${error instanceof Error ? error.message : String(error)}`,
      source,
    });
    return null;
  }
}

/** The browser agent's verified answer for one site. One USAGE row. */
export async function browserContact(
  website: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: Fetch; source?: string; maxSteps?: number } = {},
): Promise<BrowserContact | null> {
  const env = options.env ?? process.env;
  const cfg = agentsConfig(env);
  const llm = browserModel(env);
  if (!cfg || !llm) return null;
  const source = options.source ?? 'neighbor card';
  try {
    const out = await call<BrowserContact>(cfg, '/v1/browser/contact', { website, llm, maxSteps: options.maxSteps ?? 8 }, 300_000, options.fetch ?? fetch);
    await recordIntegrationEvent({
      integrationId: AGENTS_INTEGRATION,
      kind: 'USAGE',
      state: `BROWSER_${out.status}`,
      detail:
        `browser-use ${out.domain} on ${llm.model}: ${out.status} in ${out.steps} step(s), ${out.seconds}s` +
        `${out.email ? `; ${maskEmail(out.email)}${out.verified ? ` on ${out.sourceUrl}` : ' not on the cited page'}` : ''}` +
        `${out.error ? `; ${out.error}` : ''}`,
      source,
    });
    return out;
  } catch (error) {
    await recordIntegrationEvent({
      integrationId: AGENTS_INTEGRATION,
      kind: 'USAGE',
      state: 'BROWSER_FAILED',
      detail: `browser-use ${website}: ${error instanceof Error ? error.message : String(error)}`,
      source,
    });
    return null;
  }
}

/**
 * The address Brain takes from Sellbird's reading, best first: a named owner's
 * or manager's own address *published on the site* (so a greeting can use the
 * first name), else the business's published general inbox. A pattern guess
 * is never taken (Sellbird calls it a guess too; without a verifier it is one).
 */
export function pickSellbird(out: SellbirdContacts): AgentFinding | null {
  const ranked = [...out.people].sort((a, b) => Number(b.owner) - Number(a.owner));
  const person = ranked.find((p) => p.email && p.published && p.status !== 'invalid');
  if (person?.email) return { email: person.email.toLowerCase(), sourceUrl: person.evidenceUrl, firstName: person.firstName, via: 'sellbird' };
  if (out.inbox?.published) return { email: out.inbox.email.toLowerCase(), sourceUrl: `https://${out.domain}`, firstName: null, via: 'sellbird' };
  return null;
}

export function pickBrowser(out: BrowserContact | null): AgentFinding | null {
  if (!out || out.status !== 'VERIFIED' || !out.verified || !out.email) return null;
  return { email: out.email.toLowerCase(), sourceUrl: out.sourceUrl ?? `https://${out.domain}`, firstName: null, via: 'browser-use' };
}

/** The live probe (sends nothing): the service answers and holds the key Brain holds. */
export async function probeAgents(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = fetch): Promise<{ ok: boolean | null | 'repairing'; detail: string }> {
  const cfg = agentsConfig(env);
  if (!cfg) return { ok: null, detail: 'BRAIN_AGENTS_URL / BRAIN_AGENTS_KEY are not set; the Agents workflow writes them.' };
  try {
    const health = await fetcher(`${cfg.url}/healthz`, { signal: AbortSignal.timeout(60_000) });
    if (!health.ok) return { ok: null, detail: `The agents service answered HTTP ${health.status}.` };
    const body = (await health.json()) as { agents?: Record<string, string> };
    // An authorized call that does no work: an empty website is refused with 422/400, a wrong key with 401.
    const auth = await fetcher(`${cfg.url}/v1/sellbird/contacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ website: '' }),
      signal: AbortSignal.timeout(30_000),
    });
    // The key is Brain's own (the workflow writes both halves), so a mismatch is Brain's repair, not the owner's.
    if (auth.status === 401) return { ok: 'repairing', detail: 'The agents service refused Brain\'s key; the Agents workflow\'s "deploy" rewrites both halves.' };
    const versions = Object.entries(body.agents ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    return { ok: true, detail: `The agents service answered and accepted Brain's key (${versions}).` };
  } catch (error) {
    return { ok: null, detail: `The agents service did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}
