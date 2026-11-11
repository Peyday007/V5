/**
 * GOV-22-2: the requirement's fixed check is `probe r01.gov-22-2({})`.
 *
 * That probe is registered in the protected verification module
 * (`server/services/factory/program/probes.ts`), which no implementing campaign
 * may write. It reads only two functions of the released
 * `server/services/capability/prepared.ts`: `countsAsIntegration` and
 * `validatePreparedOption`, with one fixed sample. This test replays the
 * probe's exact reading against this module, so a change here that would make
 * the released probe answer FAIL — a renamed export, a sample it starts
 * refusing, an empty option it starts accepting, an option counted as an
 * integration — fails the suite before it can reach production.
 */
import { describe, expect, it } from 'vitest';
import * as preparedModule from '../server/services/capability/prepared.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';

/** The probe body as released, reading the module through the same untyped door. */
function probeReading(prepared: Record<string, unknown>): { ok: boolean; detail: string } {
  const counts = prepared.countsAsIntegration as ((o: unknown) => boolean) | undefined;
  const validate = prepared.validatePreparedOption as ((o: unknown) => unknown) | undefined;
  if (!counts || !validate) return { ok: false, detail: 'prepared options are not deployed in this Brain' };
  const sample = { requirementId: 'probe', feasibility: { verdict: 'FEASIBLE', note: 'probe' }, methods: [{ name: 'x', kind: 'API', gates: [], effort: 1, sources: ['probe'] }], sourceInventory: ['probe'] };
  let refusedEmpty = false;
  try {
    validate({ ...sample, sourceInventory: undefined });
  } catch {
    refusedEmpty = true;
  }
  const ok = counts(validate(sample)) === false && refusedEmpty;
  return { ok, detail: ok ? 'a prepared option never counts as an integration; an option without sketch or inventory is refused' : 'a prepared option was counted as an integration or an empty one was accepted' };
}

describe('GOV-22-2: the r01.gov-22-2 probe reads a passing module', () => {
  it('the released probe body passes against this prepared.ts', () => {
    const result = probeReading(preparedModule as unknown as Record<string, unknown>);
    expect(result).toEqual({ ok: true, detail: 'a prepared option never counts as an integration; an option without sketch or inventory is refused' });
  });

  it('the probe body is not vacuous: it fails a module that counts an option as an integration or accepts an empty one', () => {
    const real = preparedModule as unknown as Record<string, unknown>;
    expect(probeReading({}).ok).toBe(false);
    expect(probeReading({ ...real, countsAsIntegration: () => true }).ok).toBe(false);
    expect(probeReading({ ...real, validatePreparedOption: (o: unknown) => o }).ok).toBe(false);
  });

  it('wherever the protected module registers r01.gov-22-2, it passes', async () => {
    const probe = getProbe('r01.gov-22-2');
    // The registration itself lives in the protected verification path, which
    // this unit cannot write; at a SHA that carries it, it must answer PASS.
    if (probe) expect((await probe({})).ok).toBe(true);
    else expect(probeReading(preparedModule as unknown as Record<string, unknown>).ok).toBe(true);
  });
});
