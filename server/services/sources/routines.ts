/**
 * The consumer of `CONNECTOR_PROPOSED` (ACQ-21-1): a justified connector or
 * script becomes a reusable routine that the read path actually runs.
 *
 * `acquisition.ts` writes a proposal when recorded repetition justifies a
 * reusable connector, or when a stable model-assisted pattern should become a
 * script. This module turns each proposal into a routine: for that host, the
 * read path leads with the route the proposal named instead of rediscovering
 * it on every read. A browser routine is the deterministic render
 * (`browserMcp.ts`) rather than model-per-click work, and a bulk routine is the
 * sitemap or archive route that has actually read the host before.
 *
 * A routine is reliable or it stops. Each read it leads is recorded on its
 * `SOURCE_ACCESS` row (`measures.routine`) with the read path's own explicit
 * success checks (readable, not a challenge, not an empty shell), and a routine
 * whose host has a recorded browser workflow (`browserWorkflow.ts`: steps over
 * locators, form entry, downloads and explicit success checks, under a granted
 * account or none) runs that workflow rather than a bare render — so a
 * model-assisted pattern that became stable is a tested script, and a person who
 * records a workflow once never clicks through it again. A routine
 * whose led attempts fail more often than they work, at least
 * `ROUTINE_RETIRE_FAILURES` times, is retired. Nothing is retired by a clock.
 *
 * This extends the existing owner. It reads the same `bin_events` rows
 * `access.ts` and `acquisition.ts` write, adds no table, scheduler, queue or
 * authority path, and names no host, category or industry: every routine comes
 * from a proposal row, and every proposal came from measured repetition. A
 * routine is never authorization to sign in, solve a challenge or ignore
 * robots.txt. The read path still checks the destination and robots before it
 * runs a routine, exactly as it does for any other route.
 */
import type { AccessAttempt, AccessMethod } from './access.ts';
import type { MethodClass } from './accessMethods.ts';
import { readsAddress, type BrowserWorkflow, type RecordedWorkflow } from './browserWorkflow.ts';

/** Failed led attempts after which a routine that fails more than it works is retired. */
export const ROUTINE_RETIRE_FAILURES = 2;

export interface Routine {
  host: string;
  /** The method class the proposal named. */
  route: MethodClass;
  kind: 'CONNECTOR' | 'SCRIPT';
  /** The read route the routine leads with, or null when the proposal names a route the read path already takes first. */
  lead: AccessMethod | null;
  /** When the proposal was recorded (the `bin_events.at` of the CONNECTOR_PROPOSED row). */
  proposedAt: string;
  /** Reads the routine led since it was proposed, and how many of those read the source. */
  runs: number;
  ok: number;
  retired: boolean;
  why: string;
  /** The recorded workflow a browser routine runs on this host, or null when it runs the plain render. */
  workflow?: BrowserWorkflow | null;
}

/** What a read records about the routine that led it. */
export interface RoutineUse {
  route: MethodClass;
  kind: 'CONNECTOR' | 'SCRIPT';
  lead: AccessMethod;
  proposedAt: string;
  /** The recorded workflow the routine ran, by name and session; absent for a plain render. */
  workflow?: { name: string; session: BrowserWorkflow['session'] };
}

interface ProposalRow {
  measures: string | null;
  at: string | null;
}

interface AccessRow {
  measures: string | null;
  at?: string | null;
}

const parse = <T>(raw: string | null): T | null => {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

/** Which bulk route has read the host most often, from its SOURCE_ACCESS rows. Pure. */
function bulkRouteOf(host: string, access: readonly AccessRow[]): AccessMethod | null {
  const ok = new Map<AccessMethod, number>();
  for (const row of access) {
    const m = parse<{ host?: string; attempts?: AccessAttempt[] }>(row.measures);
    if (m?.host?.toLowerCase() !== host) continue;
    for (const a of m.attempts ?? []) {
      if ((a.method === 'SITEMAP' || a.method === 'ARCHIVE') && a.readable) ok.set(a.method, (ok.get(a.method) ?? 0) + 1);
    }
  }
  const best = [...ok].sort((x, y) => y[1] - x[1])[0];
  return best ? best[0] : null;
}

/** The read route a proposal's method class leads with on a host. Pure. */
export function leadOfRoute(route: MethodClass, host: string, access: readonly AccessRow[]): AccessMethod | null {
  switch (route) {
    case 'BROWSER':
    case 'MODEL_ASSISTED':
      return 'BROWSER';
    case 'BULK':
      return bulkRouteOf(host, access);
    default:
      // NATIVE: a registered connector already leads; HTTP: DIRECT already leads; a handoff is never automated.
      return null;
  }
}

/**
 * Routines from CONNECTOR_PROPOSED rows and the SOURCE_ACCESS rows that record
 * their use. Pure over rows. The newest proposal for a host decides its route.
 */
export function routinesFrom(
  proposals: readonly ProposalRow[],
  access: readonly AccessRow[],
  workflows: ReadonlyMap<string, readonly RecordedWorkflow[]> = new Map(),
): Map<string, Routine> {
  const newest = new Map<string, { route: MethodClass; kind: 'CONNECTOR' | 'SCRIPT'; at: string; t: number }>();
  for (const row of proposals) {
    const t = row.at ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(t)) continue;
    const m = parse<{ host?: unknown; route?: unknown; kind?: unknown }>(row.measures);
    if (!m || typeof m.host !== 'string' || typeof m.route !== 'string') continue;
    const host = m.host.toLowerCase();
    const prior = newest.get(host);
    if (prior && prior.t >= t) continue;
    newest.set(host, { route: m.route as MethodClass, kind: m.kind === 'SCRIPT' ? 'SCRIPT' : 'CONNECTOR', at: row.at!, t });
  }
  // A workflow a person recorded for reading a host's pages is itself a reusable browser routine:
  // the decision to build it was made by recording it, so it needs no separate proposal.
  const readWorkflow = new Map<string, RecordedWorkflow>();
  for (const [host, list] of workflows) {
    const reads = list.find((r) => readsAddress(r.workflow));
    if (reads) readWorkflow.set(host.toLowerCase(), reads);
  }
  for (const [host, r] of readWorkflow) {
    const t = Date.parse(r.recordedAt);
    const prior = newest.get(host);
    if (!Number.isFinite(t)) continue;
    if (!prior) newest.set(host, { route: 'BROWSER', kind: 'SCRIPT', at: r.recordedAt, t });
  }
  const out = new Map<string, Routine>();
  for (const [host, p] of newest) {
    const lead = leadOfRoute(p.route, host, access);
    const workflow = lead === 'BROWSER' ? (readWorkflow.get(host)?.workflow ?? null) : null;
    let runs = 0;
    let ok = 0;
    if (lead) {
      for (const row of access) {
        const m = parse<{ host?: string; attempts?: AccessAttempt[]; routine?: { lead?: string; proposedAt?: string } }>(row.measures);
        if (m?.host?.toLowerCase() !== host || m.routine?.lead !== lead || m.routine.proposedAt !== p.at) continue;
        if ((m.routine as { workflow?: { name?: string } }).workflow?.name !== (workflow?.name ?? undefined)) continue;
        const led = (m.attempts ?? []).find((a) => a.method === lead);
        if (!led) continue;
        runs += 1;
        if (led.readable) ok += 1;
      }
    }
    const failures = runs - ok;
    const retired = lead !== null && failures >= ROUTINE_RETIRE_FAILURES && failures > ok;
    out.set(host, {
      host,
      route: p.route,
      kind: p.kind,
      lead,
      proposedAt: p.at,
      runs,
      ok,
      retired,
      workflow,
      why: lead === null
        ? `${p.route} is already the route the read path takes first on ${host}; nothing further to build`
        : retired
          ? `the ${lead} routine on ${host} failed ${failures} of ${runs} led reads; retired until a new proposal`
          : `${p.kind === 'SCRIPT' ? 'scripted' : 'reusable'} ${lead} routine on ${host} from ${p.at}${workflow ? ` running the recorded workflow "${workflow.name}" (${workflow.session === 'ACCOUNT' ? 'under the granted account' : 'no account'})` : ''} (${ok}/${runs} led reads worked)`,
    });
  }
  return out;
}

/** The routine a read on this host should run, or null when there is none, it leads nowhere new, or it was retired. */
export function activeRoutine(routine: Routine | null | undefined): RoutineUse | null {
  if (!routine || routine.retired || !routine.lead) return null;
  return {
    route: routine.route, kind: routine.kind, lead: routine.lead, proposedAt: routine.proposedAt,
    ...(routine.workflow ? { workflow: { name: routine.workflow.name, session: routine.workflow.session } } : {}),
  };
}
