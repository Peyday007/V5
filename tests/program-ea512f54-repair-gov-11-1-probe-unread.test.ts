/**
 * GOV-11 repair, episode 1: probe r01.gov-11 reported FAIL because the forge's
 * unauthenticated read budget was spent. A read the forge did not answer is not
 * evidence about the register (ProbeResult: "null: nothing answered ... UNKNOWN,
 * never a failure"). It is answered from the outcome the register pass recorded
 * from a definite read of the same revision, or it is UNKNOWN. Definite answers
 * are judged exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerVerdict, registerHoldsOnProduction, type RecordedRegisterOutcome } from '../server/services/factory/program/release01/governanceProbe.ts';

const AT = 'docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md@e678e798786f';
const OTHER = 'docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md@000000000000';
const unread = { ok: false, unread: true, registerAt: AT, programId: 'p', releases: 0, detail: "the register was not read this pass: The forge's read rate limit is spent until 2026-11-15T05:33:16.000Z" };
const event = (kind: string, register: string, appendedReleases = 0, programId = 'p'): RecordedRegisterOutcome => ({ kind, at: '2026-11-15T04:00:00.000Z', detail: { register, programId, appendedReleases, detail: `${register} against program ${programId}: 7 decisions verbatim` } });

const check = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('../server/services/goals/openQuestions.ts', () => ({ checkRegisterOnProduction: async () => check.next }));

describe('registerVerdict (pure)', () => {
  it('unread with no recorded outcome is UNKNOWN, naming the reason', () => {
    const r = registerVerdict(unread, null);
    expect(r.ok).toBeNull();
    expect(r.detail).toMatch(/rate limit is spent/);
  });

  it('unread with a CURRENT outcome recorded for the same revision passes from that record', () => {
    const r = registerVerdict(unread, event('PROGRAM_REGISTER_CURRENT', AT));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/recorded at 2026-11-15T04:00:00.000Z/);
  });

  it('unread with an outcome recorded for a different revision is UNKNOWN', () => {
    expect(registerVerdict(unread, event('PROGRAM_REGISTER_CURRENT', OTHER)).ok).toBeNull();
  });

  it('unread with a BEHIND outcome recorded for the same revision fails from that record', () => {
    expect(registerVerdict(unread, event('PROGRAM_REGISTER_BEHIND', AT)).ok).toBe(false);
  });

  it('unread with a CURRENT outcome recorded before a release was appended is UNKNOWN, not PASS', () => {
    // The owner answered: a release was appended (§97), so the unchanged register may now be BEHIND.
    const r = registerVerdict({ ...unread, releases: 1 }, event('PROGRAM_REGISTER_CURRENT', AT, 0));
    expect(r.ok).toBeNull();
    expect(r.detail).toMatch(/1 appended release/);
  });

  it('unread with an outcome recorded against a different program is UNKNOWN', () => {
    expect(registerVerdict(unread, event('PROGRAM_REGISTER_CURRENT', AT, 0, 'other')).ok).toBeNull();
  });

  it('unread with an outcome recorded at the same revision, program and releases still answers from it', () => {
    expect(registerVerdict({ ...unread, releases: 2 }, event('PROGRAM_REGISTER_CURRENT', AT, 2)).ok).toBe(true);
    expect(registerVerdict({ ...unread, releases: 2 }, event('PROGRAM_REGISTER_BEHIND', AT, 2)).ok).toBe(false);
  });

  it('unread with an unrelated event kind is UNKNOWN', () => {
    expect(registerVerdict(unread, event('SOMETHING_ELSE', AT)).ok).toBeNull();
  });

  it('a definite mismatch still fails, and a recorded outcome cannot override it', () => {
    const mismatch = { ok: false, registerAt: AT, detail: `${AT} against program p: S-0098 clause missing` };
    expect(registerVerdict(mismatch, event('PROGRAM_REGISTER_CURRENT', AT))).toEqual({ ok: false, detail: mismatch.detail });
  });

  it('an unreadable (404) register still fails', () => {
    expect(registerVerdict({ ok: false, registerAt: AT, detail: `the register is not readable: ${AT}` }, null).ok).toBe(false);
  });

  it('a register that holds passes', () => {
    expect(registerVerdict({ ok: true, registerAt: AT, detail: 'holds' }, null)).toEqual({ ok: true, detail: 'holds' });
  });

  it('no program filed is UNKNOWN', () => {
    expect(registerVerdict({ ok: false, detail: 'no architecture program is filed on production' }, null).ok).toBeNull();
  });
});

describe('registerHoldsOnProduction', () => {
  it('reads the recorded outcome only when the forge did not answer', async () => {
    const recorded = vi.fn(async () => event('PROGRAM_REGISTER_CURRENT', AT));
    check.next = unread;
    expect((await registerHoldsOnProduction({ recorded })).ok).toBe(true);
    expect(recorded).toHaveBeenCalledTimes(1);

    recorded.mockClear();
    check.next = { ok: false, registerAt: AT, detail: 'definite mismatch' };
    expect((await registerHoldsOnProduction({ recorded })).ok).toBe(false);
    expect(recorded).not.toHaveBeenCalled();
  });

  it('a spent read budget with nothing recorded is UNKNOWN, never FAIL', async () => {
    check.next = unread;
    expect((await registerHoldsOnProduction({ recorded: async () => null })).ok).toBeNull();
  });
});
