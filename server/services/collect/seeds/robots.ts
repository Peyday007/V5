/**
 * What a publisher's robots.txt says about a path, read by code and recorded.
 *
 * Pure parsing plus one recording step. A body that cannot be read, a fetch
 * that fails or a robots.txt that disallows the path is recorded as exactly
 * that; nothing is worked around, and an unreadable answer never becomes
 * ALLOWED. A missing robots.txt (404) imposes no restriction, so it is
 * ALLOWED with the note saying so.
 */
import { listCollectSources, setRobotsStatus } from '../../../repos/collectSources.ts';
import type { RobotsStatus } from '../../../domain/collect.ts';
import type { SourceRow } from '../../feeds/sources.ts';

function pathMatches(rule: string, path: string): boolean {
  const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
  return new RegExp(`^${pattern}`).test(path);
}

/** Whether robots.txt allows this path for this agent. Longest matching rule wins; allow wins a tie. */
export function robotsAllows(robots: string, path: string, agent: string): boolean {
  const lower = agent.toLowerCase();
  const groups: { agents: string[]; rules: { allow: boolean; rule: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*/, '').trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastAgent = true;
      continue;
    }
    lastAgent = false;
    if (current && (key === 'allow' || key === 'disallow') && value) current.rules.push({ allow: key === 'allow', rule: value });
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && lower.includes(a)));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!pathMatches(r.rule, path)) continue;
      if (!best || r.rule.length > best.len || (r.rule.length === best.len && r.allow)) best = { allow: r.allow, len: r.rule.length };
    }
  }
  return best ? best.allow : true;
}

export type RobotsFetcher = (url: string) => Promise<{ status: number; body: string }>;

export interface RobotsCheck {
  slug: string;
  status: RobotsStatus;
  note: string;
}

/** Decide one source's status from a robots.txt answer. Pure. */
export function judgeRobots(input: { status: number | null; body: string; path: string; agent: string; error?: string }): { status: RobotsStatus; note: string } {
  if (input.error) return { status: 'UNCHECKED', note: `robots.txt could not be read: ${input.error}` };
  if (input.status === 404 || input.status === 410) return { status: 'ALLOWED', note: `no robots.txt (HTTP ${input.status}); no restriction stated` };
  if (input.status === null || input.status < 200 || input.status >= 300) return { status: 'UNCHECKED', note: `robots.txt answered HTTP ${input.status}; not treated as permission` };
  return robotsAllows(input.body, input.path, input.agent)
    ? { status: 'ALLOWED', note: `robots.txt allows ${input.path} for ${input.agent}` }
    : { status: 'DISALLOWED', note: `robots.txt disallows ${input.path} for ${input.agent}` };
}

export const COLLECT_AGENT = 'brain-feed';

/** Read each unchecked/stale public source's robots.txt and record the answer with the time. */
export async function recordRobotsChecks(fetcher: RobotsFetcher, slugs?: readonly string[]): Promise<RobotsCheck[]> {
  const out: RobotsCheck[] = [];
  for (const source of await listCollectSources(null)) {
    if (slugs && !slugs.includes(source.slug)) continue;
    let url: URL;
    try { url = new URL(source.urlTemplate); } catch { continue; }
    let verdict: { status: RobotsStatus; note: string };
    try {
      const r = await fetcher(`${url.origin}/robots.txt`);
      verdict = judgeRobots({ status: r.status, body: r.body, path: url.pathname, agent: COLLECT_AGENT });
    } catch (error) {
      verdict = judgeRobots({ status: null, body: '', path: url.pathname, agent: COLLECT_AGENT, error: error instanceof Error ? error.message : String(error) });
    }
    await setRobotsStatus(source.id, verdict.status, verdict.note.slice(0, 300));
    out.push({ slug: source.slug, ...verdict });
  }
  return out;
}

/** How long a recorded robots answer stands before the pull reads robots.txt again. */
export const ROBOTS_RECHECK_MS = 7 * 86_400_000;

export type RobotsGateDecision =
  | { allowed: true; status: 'ALLOWED'; note: string; checkedNow: boolean }
  | { allowed: false; status: Exclude<RobotsStatus, 'ALLOWED'>; note: string; checkedNow: boolean };

/** The real answer from a publisher, by plain code, with the agent the pull uses. */
export const httpRobotsFetcher: RobotsFetcher = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': `${COLLECT_AGENT}/1.0`, accept: 'text/plain,*/*' }, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.text() };
};

/**
 * Whether the pull may ask this source now, from what its publisher's
 * robots.txt says, read by the pull itself and recorded on the registry row
 * with the time.
 *
 * A recorded ALLOWED or DISALLOWED stands for `ROBOTS_RECHECK_MS`, then is read
 * again so a publisher's change is noticed. An answer that could not be read
 * is recorded UNCHECKED and read again on the next pull; it is never treated
 * as permission. TERMS_FORBID is set by a person reading the terms and is not
 * overturned by a robots.txt that happens to allow the path.
 */
export interface GateSource {
  id: string;
  label: string;
  url: string;
  intervalMs: number;
  format?: 'json' | 'text';
  row?: SourceRow;
}

export async function robotsGate(input: {
  source: GateSource;
  fetcher: RobotsFetcher;
  now: Date;
  /** Finds or writes the source's registry row; the answer is recorded on it. */
  ensure: (source: GateSource) => Promise<{ id: string; robotsStatus: RobotsStatus; robotsCheckedAt: string | null; robotsNote: string | null }>;
}): Promise<RobotsGateDecision> {
  const registered = await input.ensure(input.source);
  if (registered.robotsStatus === 'TERMS_FORBID') {
    return { allowed: false, status: 'TERMS_FORBID', note: registered.robotsNote ?? 'the publisher\'s terms forbid collection', checkedNow: false };
  }
  const checkedAt = registered.robotsCheckedAt ? Date.parse(registered.robotsCheckedAt) : NaN;
  const fresh = Number.isFinite(checkedAt) && input.now.getTime() - checkedAt < ROBOTS_RECHECK_MS;
  if (fresh && registered.robotsStatus === 'ALLOWED') {
    return { allowed: true, status: 'ALLOWED', note: registered.robotsNote ?? '', checkedNow: false };
  }
  if (fresh && registered.robotsStatus === 'DISALLOWED') {
    return { allowed: false, status: 'DISALLOWED', note: registered.robotsNote ?? 'robots.txt disallows this path', checkedNow: false };
  }
  let url: URL;
  try {
    url = new URL(input.source.url);
  } catch {
    const note = 'the source URL does not parse, so its robots.txt cannot be located';
    await setRobotsStatus(registered.id, 'UNCHECKED', note);
    return { allowed: false, status: 'UNCHECKED', note, checkedNow: true };
  }
  const path = `${url.pathname}${url.search}`;
  let verdict: { status: RobotsStatus; note: string };
  try {
    const r = await input.fetcher(`${url.origin}/robots.txt`);
    verdict = judgeRobots({ status: r.status, body: r.body, path, agent: COLLECT_AGENT });
  } catch (error) {
    verdict = judgeRobots({ status: null, body: '', path, agent: COLLECT_AGENT, error: error instanceof Error ? error.message : String(error) });
  }
  const note = verdict.note.slice(0, 300);
  await setRobotsStatus(registered.id, verdict.status, note);
  return verdict.status === 'ALLOWED'
    ? { allowed: true, status: 'ALLOWED', note, checkedNow: true }
    : { allowed: false, status: verdict.status as Exclude<RobotsStatus, 'ALLOWED'>, note, checkedNow: true };
}
