/**
 * GOV-22-1 and GOV-11 must be demonstrated on production records. Review finding
 * (2026-11-13): nothing on production showed the capability comparison running,
 * no registered probe read `capabilitySupply`, and the newest-event reads behind
 * both passes took the oldest row, because `listFactoryEvents` answers oldest first.
 *
 * This pins: the comparison records a review of what it read whenever that changes;
 * `r01.gov-22-1` is registered and judges those production rows; and the "latest"
 * reads return the newest event.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementReading } from '../server/domain/factoryProgram.ts';
import type { CashNeed } from '../server/domain/types.ts';
import { getProbe, probeNames } from '../server/services/factory/program/probes.ts';
import {
  CAPABILITY_EVENT_KINDS,
  checkCapabilityComparison,
  productionCapabilityPorts,
  reconcilePreparedCapabilities,
  type CapabilityPorts,
} from '../server/services/goals/capabilityPromotion.ts';
import { REGISTER_EVENT_KINDS, productionRegisterPorts } from '../server/services/goals/openQuestions.ts';
import { recordFactoryEvent } from '../server/repos/factoryFleet.ts';
import { freshProject } from './helpers.ts';

const requirement = (key: string, over: Partial<ProgramRequirement> = {}) =>
  ({ key, outputs: [], dependsOn: [], interactsWith: [], ...over }) as unknown as ProgramRequirement;

const supplier = requirement('pay', { prepared: true, paths: ['server/services/cash/providers/stripe.ts'] });
const unrelated = requirement('gov-22-1', { existing: { paths: ['server/services/factory/program/**'] } as ProgramRequirement['existing'] });
const map: RequirementMap = { requirements: [supplier, unrelated], context: [] };

const review = (over: Record<string, unknown> = {}) => ({
  kind: CAPABILITY_EVENT_KINDS.reviewed,
  detail: { programId: 'fpg', mapVersion: 3, openNeedsBlocked: {}, unsupplied: {}, prepared: ['pay'], ...over },
});

describe('probe r01.gov-22-1 judges production records', () => {
  it('is registered by the module the goals tick loads', () => {
    expect(probeNames()).toContain('r01.gov-22-1');
    expect(getProbe('r01.gov-22-1')).not.toBeNull();
    expect(readFileSync('server/services/goals/tick.ts', 'utf8')).toMatch(/from '\.\/capabilityPromotion\.ts'/);
  });

  it('fails when no program is installed', () => {
    expect(checkCapabilityComparison({ program: null, events: [] }).ok).toBe(false);
  });

  it('fails when no requirement of the installed map supplies a capability', () => {
    const out = checkCapabilityComparison({ program: { id: 'fpg', map: { requirements: [unrelated], context: [] }, mapVersion: 3 }, events: [review()] });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/no requirement supplies/);
  });

  it('fails until the running Brain has recorded a comparison of the installed map', () => {
    expect(checkCapabilityComparison({ program: { id: 'fpg', map, mapVersion: 3 }, events: [] }).detail).toMatch(/no comparison is recorded/);
    expect(checkCapabilityComparison({ program: { id: 'fpg', map, mapVersion: 3 }, events: [review({ mapVersion: 2 })] }).ok).toBe(false);
    expect(checkCapabilityComparison({ program: { id: 'fpg', map, mapVersion: 3 }, events: [review({ programId: 'other' })] }).ok).toBe(false);
  });

  it('fails when a demotion removed the requirement or a promotion carries no evidence', () => {
    const program = { id: 'fpg', map, mapVersion: 3 };
    expect(checkCapabilityComparison({ program, events: [{ kind: CAPABILITY_EVENT_KINDS.demoted, detail: { programId: 'fpg', requirement: 'gone', requirementRetained: true } }, review()] }).ok).toBe(false);
    expect(checkCapabilityComparison({ program, events: [{ kind: CAPABILITY_EVENT_KINDS.promoted, detail: { programId: 'fpg', requirement: 'pay', evidence: [] } }, review()] }).ok).toBe(false);
  });

  it('passes with a supplier, a current comparison and retained transitions', () => {
    const out = checkCapabilityComparison({
      program: { id: 'fpg', map, mapVersion: 3 },
      events: [
        { kind: CAPABILITY_EVENT_KINDS.promoted, detail: { programId: 'fpg', requirement: 'pay', evidence: ['2 blocked transactions'] } },
        { kind: CAPABILITY_EVENT_KINDS.demoted, detail: { programId: 'fpg', requirement: 'pay', requirementRetained: true } },
        review({ openNeedsBlocked: { TAKE_A_PAYMENT: 1 } }),
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.detail).toMatch(/TAKE_A_PAYMENT/);
  });
});

describe('the pass records what it compared, on a change only', () => {
  function ports(needs: CashNeed[]) {
    const recorded: { kind: string; detail: Record<string, unknown> }[] = [];
    const p: CapabilityPorts = {
      async programs() {
        return [{ id: 'fpg', map, mapVersion: 3, readings: [{ key: 'pay', status: 'MAPPED' }, { key: 'gov-22-1', status: 'MAPPED' }] as RequirementReading[], edgesOf: () => [] }];
      },
      async openNeeds() { return needs; },
      async opportunity() { return null; },
      async promotedHere() { return new Set(); },
      async proposeMap() { return { version: 4 }; },
      async record(kind, detail) { recorded.push({ kind, detail }); },
      async parallelWorkers() { return null; },
      async latestReview() {
        const last = recorded.filter((r) => r.kind === CAPABILITY_EVENT_KINDS.reviewed).at(-1);
        return last ? String(last.detail.fingerprint) : null;
      },
    };
    return { p, recorded };
  }

  it('records a review on a pass that moves nothing, and nothing when it repeats', async () => {
    const unsupplied = { id: 'n', projectId: 'prj', opportunityId: null, requestKey: 'capability:prj:PUBLISH_A_LISTING', state: 'OPEN' } as unknown as CashNeed;
    const { p, recorded } = ports([unsupplied]);
    await reconcilePreparedCapabilities(p);
    await reconcilePreparedCapabilities(p);
    expect(recorded.map((r) => r.kind)).toEqual([CAPABILITY_EVENT_KINDS.reviewed]);
    expect(recorded[0]?.detail).toMatchObject({
      programId: 'fpg',
      mapVersion: 3,
      requirementsSupplying: 1,
      supply: { TAKE_A_PAYMENT: ['pay'] },
      unsupplied: { PUBLISH_A_LISTING: 1 },
      prepared: ['pay'],
      promoted: [],
    });
  });
});

describe('newest-event reads on the real store', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('a later demotion overrides the promotion it follows', async () => {
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.promoted, evidenceClass: 'MEASURED', detail: { programId: 'fpg', requirement: 'pay' } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.demoted, evidenceClass: 'MEASURED', detail: { programId: 'fpg', requirement: 'pay' } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.promoted, evidenceClass: 'MEASURED', detail: { programId: 'fpg', requirement: 'other' } });
    const ports = await productionCapabilityPorts();
    expect([...(await ports.promotedHere('fpg'))]).toEqual(['other']);
  });

  it('the newest review and the newest register outcome are the ones read', async () => {
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'fpg', fingerprint: 'old' } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'fpg', fingerprint: 'new' } });
    expect(await (await productionCapabilityPorts()).latestReview?.('fpg')).toBe('new');
    await recordFactoryEvent({ kind: REGISTER_EVENT_KINDS.behind, evidenceClass: 'MEASURED', detail: { fingerprint: 'first' } });
    await recordFactoryEvent({ kind: REGISTER_EVENT_KINDS.current, evidenceClass: 'MEASURED', detail: { fingerprint: 'second' } });
    expect((await (await productionRegisterPorts()).latest())?.detail.fingerprint).toBe('second');
  });
});
