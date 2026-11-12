/**
 * CONT-35, repair F-REASON-SATURATES: an UNCERTAIN operation that is re-asked
 * over and over (the tick re-asks every UNCERTAIN_REASK_AFTER_MS) keeps saying
 * when and why reconciliation was last applied or skipped (S-0484 approved
 * reading). Before the repair each re-ask appended its note to the stored
 * reason and the 2000-character cap kept the oldest text, so after roughly
 * fifteen re-asks every newer note was cut off while updated_at kept moving.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { clearAdapters, type EffectAdapter } from '../server/services/effects/adapter.ts';
import {
  RECONCILABLE,
  reconcilableAdapter,
  registerSyntheticAdapters,
  resetSynthetic,
  sendCount,
  setFault,
} from '../server/services/effects/synthetic.ts';
import { getOperation } from '../server/repos/idempotency.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';

const ns = (adapter: EffectAdapter): OperationNamespace => ({
  name: adapter.namespace,
  version: 1,
  principalScope: 'PRINCIPAL',
  retention: 'PERMANENT',
});

let projectId = '';

/** A provider that cannot be reached, and says which ask it refused. */
function unreachableOnAsk(ask: number): EffectAdapter {
  return {
    ...reconcilableAdapter,
    reconcile: async () => {
      throw new Error(`the provider is unreachable on ask ${ask}`);
    },
  };
}

const run = (runAs: EffectAdapter, key: string) =>
  runExternalEffect({
    adapter: runAs,
    namespace: ns(reconcilableAdapter),
    projectId,
    key,
    businessId: 'pay-reason-1',
    payload: { note: 'charge' },
    principalType: 'HUMAN',
    principalId: 'usr_cont35_reason',
  });

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

describe('CONT-35: the reason on a repeatedly re-asked unknown', () => {
  it('always carries the original cause and the latest reconciliation decision, within the cap', async () => {
    const key = 'cont35-reason-key-0001';
    setFault(RECONCILABLE, 'ACCEPT_THEN_LOSE_RESPONSE');
    const first = await run(unreachableOnAsk(0), key);
    setFault(RECONCILABLE, 'NONE');
    expect(first.status).toBe('UNCERTAIN');
    const firstReason = (await getOperation(first.operation.id))!.uncertaintyReason!;
    const cause = firstReason.slice(0, firstReason.indexOf(' — reconciliation '));
    expect(cause.length).toBeGreaterThan(0);

    // Far past the point (about 15-18 notes) where the old join saturated.
    const asks = 40;
    for (let ask = 1; ask <= asks; ask++) {
      const again = await run(unreachableOnAsk(ask), key);
      expect(again.status).toBe('UNCERTAIN');
      const reason = (await getOperation(first.operation.id))!.uncertaintyReason!;
      expect(reason.length).toBeLessThanOrEqual(2000);
      expect(reason.startsWith(cause)).toBe(true);
      expect(reason).toMatch(
        new RegExp(`reconciliation skipped at \\d{4}-\\d\\d-\\d\\dT\\S+: asking the provider failed \\(the provider is unreachable on ask ${ask}\\).*nothing was resent$`),
      );
      // Only the latest decision: earlier notes are not accumulated.
      expect(reason.split(' — reconciliation ').length).toBe(2);
    }
    expect(sendCount(RECONCILABLE)).toBe(1);
  });
});
