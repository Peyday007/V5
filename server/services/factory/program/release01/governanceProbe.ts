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

/** What the register check answered, as far as the probe reads it. */
export interface RegisterCheckOutcome {
  ok: boolean;
  detail: string;
  /** The forge did not answer this pass (a spent read budget, a timeout, a 5xx): nothing was learned about the register. */
  unread?: boolean;
  /** The register revision the check tried to read (`<path>@<revision>`). */
  registerAt?: string | null;
  /** The program the register is checked against, read from Brain's own rows even when the forge did not answer. */
  programId?: string | null;
  /** How many releases are appended to that program now (§97 amendments): the owner's answers arrive as releases. */
  releases?: number | null;
}

/** A recorded register outcome: the register pass writes one only from a definite read. */
export interface RecordedRegisterOutcome {
  kind: string;
  detail: Record<string, unknown>;
  at: string;
}

const REGISTER_CURRENT = 'PROGRAM_REGISTER_CURRENT';
const REGISTER_BEHIND = 'PROGRAM_REGISTER_BEHIND';

/**
 * GOV-11 on a check's outcome. Pure.
 *
 * A read the forge did not answer is not evidence about the register
 * (ProbeResult: "null: nothing answered (the forge's read budget, a timeout).
 * UNKNOWN, never a failure"). It is answered from the outcome the register pass
 * recorded from a definite read of the same revision, when there is one, and is
 * otherwise UNKNOWN, so the next pass asks again. Every definite answer is
 * judged exactly as the check gives it.
 */
export function registerVerdict(r: RegisterCheckOutcome, recorded: RecordedRegisterOutcome | null): ProbeResult {
  // No program filed is an absence, not a register that contradicts it (§39).
  if (!r.ok && /no architecture program is filed/.test(r.detail)) return { ok: null, detail: r.detail };
  if (!r.unread) return { ok: r.ok, detail: r.detail };
  const revision = r.registerAt ?? null;
  /*
   * The same outcome the register pass would fingerprint: the same register
   * revision, against the same program, with the same appended releases. A
   * release appended since the record (the owner answering, §97) can put an
   * unchanged register BEHIND, so a record made before it answers nothing now.
   */
  const sameSubject =
    recorded !== null &&
    revision !== null &&
    recorded.detail.register === revision &&
    (recorded.detail.programId ?? null) === (r.programId ?? null) &&
    (recorded.detail.appendedReleases ?? null) === (r.releases ?? null);
  if (recorded && sameSubject && (recorded.kind === REGISTER_CURRENT || recorded.kind === REGISTER_BEHIND)) {
    const said = typeof recorded.detail.detail === 'string' ? recorded.detail.detail : recorded.kind;
    return {
      ok: recorded.kind === REGISTER_CURRENT,
      detail: `${r.detail}; answered from the register outcome recorded at ${recorded.at} from a definite read of ${revision}: ${said}`,
    };
  }
  return {
    ok: null,
    detail: `${r.detail} (no definite read of ${revision ?? 'this revision'} against program ${r.programId ?? '-'} with ${r.releases ?? '-'} appended release(s) is recorded, so this pass answers nothing)`,
  };
}

/** GOV-11: the open-questions register, checked against the program's stored source on production. */
export async function registerHoldsOnProduction(
  ports: { recorded?: () => Promise<RecordedRegisterOutcome | null> } = {},
): Promise<ProbeResult> {
  let check: (() => Promise<RegisterCheckOutcome>) | undefined;
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
  if (!r.unread) return registerVerdict(r, null);
  const recorded = await (ports.recorded ?? newestRecordedRegisterOutcome)();
  return registerVerdict(r, recorded);
}

/** The newest outcome the register pass recorded, read newest first from the factory event ledger. */
async function newestRecordedRegisterOutcome(): Promise<RecordedRegisterOutcome | null> {
  try {
    const { newestFactoryEvent } = await import('../../../goals/newestEvents.ts');
    const e = await newestFactoryEvent([REGISTER_CURRENT, REGISTER_BEHIND]);
    return e ? { kind: e.kind, detail: (e.detail ?? {}) as Record<string, unknown>, at: e.at } : null;
  } catch {
    return null;
  }
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
