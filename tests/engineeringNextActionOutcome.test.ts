/**
 * brain_next_engineering_action reads a campaign from its objective outcome:
 * LIVE is production working, a person's blocker is NEEDS_HUMAN, and a campaign
 * still building keeps the stage mapping.
 */
import { describe, expect, it, vi } from 'vitest';
import { campaignReading, reachedForCampaign } from '../server/mcp/engineeringTools.ts';
import { nextEngineeringAction } from '../server/domain/engineering.ts';
import type { FactoryCampaign } from '../server/domain/factory.ts';
import type { ObjectiveOutcome } from '../server/domain/factoryRelease.ts';

type C = Pick<FactoryCampaign, 'state' | 'prRef' | 'prUrl'>;
type O = Pick<ObjectiveOutcome, 'status' | 'needsPerson' | 'release'>;
const campaign = (state: C['state'], pr = false): C => ({ state, prRef: pr ? 'pr' : null, prUrl: null }) as C;
const outcome = (status: O['status'], needsPerson = false, release: O['release'] = null): O => ({ status, needsPerson, release });
const release = (state: 'DEPLOYING' | 'VERIFYING' | 'GATING') =>
  ({ runId: 'r', state, mergeSha: 'abc', deployRunId: null, attempt: 1 }) as O['release'];

describe('campaignReading', () => {
  it('A01: a LIVE campaign reached PRODUCTION_WORKING and the decision is DONE', () => {
    const r = campaignReading(campaign('COMPLETE', true), outcome('LIVE'));
    expect(r.reached).toBe('PRODUCTION_WORKING');
    const d = nextEngineeringAction({ intendedOutcome: 'PRODUCTION_WORKING', reached: r.reached, humanBlockerOpen: r.humanBlockerOpen });
    expect(d.action).toBe('DONE');
  });

  it('A02: needsPerson is a human blocker even when the caller says false', () => {
    const r = campaignReading(campaign('BLOCKED'), outcome('BLOCKED', true));
    expect(r.humanBlockerOpen).toBe(true);
    const d = nextEngineeringAction({ intendedOutcome: 'PRODUCTION_WORKING', reached: r.reached, humanBlockerOpen: false || r.humanBlockerOpen });
    expect(d.action).toBe('NEEDS_HUMAN');
  });

  it('a release deploying or verifying has merged', () => {
    for (const s of ['DEPLOYING', 'VERIFYING'] as const) {
      expect(campaignReading(campaign('COMPLETE', true), outcome('RELEASING', false, release(s))).reached).toBe('MERGED');
    }
    expect(campaignReading(campaign('COMPLETE', true), outcome('RELEASING', false, release('GATING'))).reached).toBe('PR_OPEN');
  });

  it('A03: a campaign still building keeps the stage mapping', () => {
    for (const state of ['PLANNING', 'EXECUTING', 'REVIEWING', 'AWAITING_RELEASE', 'CANCELLED'] as const) {
      const r = campaignReading(campaign(state, true), outcome('BUILDING'));
      expect(r.reached).toBe(reachedForCampaign(state, true));
      expect(r.humanBlockerOpen).toBe(false);
    }
  });
});

/**
 * The handler itself, not the helper: the tool is called with the caller's
 * human_blocker_open false and the campaign's outcome decides.
 */
describe('brain_next_engineering_action handler', () => {
  const handler = async (outcomeValue: O, args: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('../server/repos/factory.ts', () => ({
      getCampaign: async () => ({ id: 'fcp_x', projectId: 'prj_x', state: 'BLOCKED', prRef: null, prUrl: null }),
    }));
    vi.doMock('../server/services/factory/release/outcome.ts', () => ({ objectiveOutcome: async () => outcomeValue }));
    vi.doMock('../server/repos/engineering.ts', () => ({ recordIntervention: async () => undefined }));
    vi.doMock('../server/mcp/toolkit.ts', async (orig) => ({
      ...(await orig<typeof import('../server/mcp/toolkit.ts')>()),
      authorize: async () => undefined,
    }));
    const mod = await import('../server/mcp/engineeringTools.ts');
    const tool = mod.ENGINEERING_TOOLS.find((t) => t.name === 'brain_next_engineering_action')!;
    const result = await tool.run(args, { principal: { type: 'USER', id: 'u' } } as never);
    return (result as { value: Record<string, unknown> }).value;
  };

  it('A02: a campaign stopped on a person is NEEDS_HUMAN though the caller passes false', async () => {
    const value = await handler(outcome('BLOCKED', true), {
      task_ref: 'fcp_x',
      intended_outcome: 'PRODUCTION_WORKING',
      human_blocker_open: false,
    });
    expect(value.action).toBe('NEEDS_HUMAN');
  });

  it('A01: a LIVE campaign is DONE for PRODUCTION_WORKING', async () => {
    const value = await handler(outcome('LIVE'), { task_ref: 'fcp_x', intended_outcome: 'PRODUCTION_WORKING' });
    expect(value.reached).toBe('PRODUCTION_WORKING');
    expect(value.action).toBe('DONE');
  });
});
