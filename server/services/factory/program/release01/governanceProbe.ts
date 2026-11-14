/**
 * Production probes for GOV-11 (owner decisions recorded, open design
 * questions kept open) and GOV-22-1 (a prepared requirement promoted from a
 * measured blocker and demoted when its need vanished), for the
 * factory-program-d0-p1 campaign. A campaign does not register its own judge;
 * these are defined in the protected `probes.ts` and read what that campaign's
 * code reads or writes.
 *
 * Until that code is deployed its module is not there to load, and the answer
 * is UNKNOWN, never a FAIL that reopens the requirement into a repair nobody
 * can make.
 */
import type { ProbeResult } from '../probes.ts';

/** GOV-11: the open-questions register, checked against the program's stored source on production. */
export async function registerHoldsOnProduction(): Promise<ProbeResult> {
  let check: (() => Promise<{ ok: boolean; detail: string }>) | undefined;
  try {
    // A variable specifier: the module ships with the campaign, so it may not exist in this revision.
    const specifier = '../../../goals/openQuestions.ts';
    const mod = (await import(specifier)) as Record<string, unknown>;
    check = mod.checkRegisterOnProduction as typeof check;
  } catch {
    check = undefined;
  }
  if (!check) return { ok: null, detail: 'the open-questions register is not deployed in this Brain yet' };
  const r = await check();
  // No program filed is an absence, not a register that contradicts it (§39).
  if (!r.ok && /no architecture program is filed/.test(r.detail)) return { ok: null, detail: r.detail };
  return { ok: r.ok, detail: r.detail };
}

export interface CapabilityEvent {
  kind: string;
  detail: Record<string, unknown>;
  at: string;
}

const PROMOTED = 'PROGRAM_CAPABILITY_PROMOTED';
const DEMOTED = 'PROGRAM_CAPABILITY_DEMOTED';

/** GOV-22-1 on given events. Pure. */
export function promotionHolds(events: readonly CapabilityEvent[]): ProbeResult {
  const promoted = events.filter((e) => e.kind === PROMOTED);
  const demoted = events.filter((e) => e.kind === DEMOTED);
  for (const e of promoted) {
    const evidence = Array.isArray(e.detail.evidence) ? e.detail.evidence : [];
    const reasons = Array.isArray(e.detail.reasons) ? e.detail.reasons : [];
    if (typeof e.detail.requirement !== 'string' || evidence.length === 0 || reasons.length === 0) {
      return { ok: false, detail: `a promotion at ${e.at} names no requirement, reason or measured evidence` };
    }
    if (typeof e.detail.mapVersion !== 'number') return { ok: false, detail: `the promotion of ${String(e.detail.requirement)} at ${e.at} was not applied to a map version` };
  }
  for (const e of demoted) {
    if (e.detail.requirementRetained !== true) return { ok: false, detail: `the demotion of ${String(e.detail.requirement)} at ${e.at} did not retain the requirement` };
  }
  if (promoted.length === 0) {
    return { ok: null, detail: `no prepared requirement promoted from a measured blocker yet (${demoted.length} demotion(s) on record)` };
  }
  return {
    ok: true,
    detail: `${promoted.length} prepared requirement(s) promoted from measured blockers, each with its reasons and evidence and applied to a map version; ${demoted.length} demoted with the requirement retained`,
  };
}

export async function promotionOnRows(): Promise<ProbeResult> {
  const { listFactoryEvents } = await import('../../../../repos/factoryFleet.ts');
  const events = await listFactoryEvents(null, { kinds: [PROMOTED, DEMOTED], limit: 500 });
  return promotionHolds(events.map((e) => ({ kind: e.kind, detail: (e.detail ?? {}) as Record<string, unknown>, at: e.at })));
}
