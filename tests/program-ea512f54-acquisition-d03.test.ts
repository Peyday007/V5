import { describe, expect, it } from 'vitest';
import { recordAcquisitionJudgment } from '../server/services/sources/acquisition.ts';
import { selectAccessMethod } from '../server/services/sources/accessMethods.ts';

type Ev = { eventType: string; outcome?: string | null; measures?: Record<string, unknown> };
const harness = (seen = false) => {
  const events: Ev[] = [];
  return {
    events,
    deps: {
      record: (async (e: Ev) => void events.push(e)) as never,
      proposalOnRecord: async () => seen,
      repeatedUse: async () => ({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 }),
      handoffOnRecord: async () => false,
    },
  };
};

describe('a justified connector or script is acted on, not just computed', () => {
  it('repeated operation of an interface records a CONNECTOR_PROPOSED row and the judgment carries convertToScript', async () => {
    const h = harness();
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'recurring workflow', host: 'Example.org' },
      { authorizedAccountOnRecord: true, repeatedUses: 4 },
      h.deps,
    );
    expect(j.reusableConnectorJustified).toBe(true);
    expect(h.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'CONNECTOR_PROPOSED']);
    expect(h.events[1]!.outcome).toBe('CONNECTOR');
    expect(h.events[1]!.measures).toMatchObject({ host: 'example.org', kind: 'CONNECTOR', repeatedUses: 4 });
    expect(h.events[0]!.measures).toHaveProperty('convertToScript', false);
  });

  it('no proposal is written when repetition does not justify one, or one is already on record', async () => {
    const few = harness();
    await recordAcquisitionJudgment({ kind: 'OPERATE', purpose: 'x', host: 'example.org' }, { authorizedAccountOnRecord: true, repeatedUses: 1 }, few.deps);
    expect(few.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT']);
    const dup = harness(true);
    await recordAcquisitionJudgment({ kind: 'OPERATE', purpose: 'x', host: 'example.org' }, { authorizedAccountOnRecord: true, repeatedUses: 5 }, dup.deps);
    expect(dup.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT']);
  });

  it('a stable unfamiliar-interface routine is proposed as a script; a handoff never is', async () => {
    expect(selectAccessMethod({ interfaceOnly: true, authorizedSession: true, interfaceUnfamiliar: true, reliability: { MODEL_ASSISTED: 0.9, BROWSER: 0.1 }, recurrence: { runs: 3, stable: 3 } }).convertToScript).toBe(true);
    const h = harness();
    const j = await recordAcquisitionJudgment(
      { kind: 'ACQUIRE', purpose: 'x', host: 'example.org' },
      { blockedAtBoundary: true, repeatedUses: 9, repeatedUsesNeedingFallback: 9 },
      h.deps,
    );
    expect(j.route).toBe('HUMAN_HANDOFF');
    // A handoff is raised to a person, and never proposed as a connector or script.
    expect(h.events.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'ACCESS_HANDOFF']);
    expect(h.events.map((e) => e.eventType)).not.toContain('CONNECTOR_PROPOSED');
  });
});
