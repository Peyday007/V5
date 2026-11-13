/**
 * GOV-22-1's fixed check is `probe r01.gov-22-1({}) passes`. A probe nobody
 * registered answers UNKNOWN, so the check could never pass; this pins that the
 * probe is registered by the module the production goals tick loads, and that it
 * reads the pass's own rows without applying anything.
 */
import { describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementReading } from '../server/domain/factoryProgram.ts';
import type { CashNeed, CashOpportunity } from '../server/domain/types.ts';
import { getProbe, probeNames } from '../server/services/factory/program/probes.ts';
import { capabilityPromotionHolds, type CapabilityPorts } from '../server/services/goals/capabilityPromotion.ts';

const requirement = (key: string, over: Partial<ProgramRequirement> = {}) =>
  ({ key, outputs: [], dependsOn: [], interactsWith: [], ...over }) as unknown as ProgramRequirement;
const reading = (key: string, status: RequirementReading['status']) => ({ key, status }) as RequirementReading;

function ports(map: RequirementMap | null, over: { promotedHere?: string[]; needs?: CashNeed[]; opportunities?: CashOpportunity[] } = {}) {
  const writes: string[] = [];
  const p: CapabilityPorts = {
    async programs() {
      return map ? [{ id: 'fpg', map, readings: map.requirements.map((r) => reading(r.key, 'MAPPED')), edgesOf: (r: ProgramRequirement) => r.dependsOn }] : [];
    },
    async openNeeds() { return over.needs ?? []; },
    async opportunity(id) { return (over.opportunities ?? []).find((o) => o.id === id) ?? null; },
    async promotedHere() { return new Set(over.promotedHere ?? []); },
    async proposeMap() { writes.push('proposeMap'); return { version: 2 }; },
    async record(kind) { writes.push(kind); },
    async parallelWorkers() { return null; },
  };
  return { p, writes };
}

describe('probe r01.gov-22-1', () => {
  it('is registered in the probe registry by the capability-promotion module', () => {
    expect(probeNames()).toContain('r01.gov-22-1');
    expect(getProbe('r01.gov-22-1')).not.toBeNull();
  });

  it('passes on production-shaped rows and reports the pending decision without applying it', async () => {
    const map = { requirements: [requirement('A', { prepared: true, outputs: ['capability:RESEARCH_A_QUESTION'] })] } as unknown as RequirementMap;
    const needs = ['o1', 'o2'].map((id) => ({ id: `n-${id}`, projectId: 'prj', opportunityId: id, requestKey: `capability:${id}:RESEARCH_A_QUESTION`, state: 'OPEN' }) as unknown as CashNeed);
    const opportunities = ['o1', 'o2'].map((id) => ({ id, projectId: 'prj', priceCents: 50_000 }) as unknown as CashOpportunity);
    const { p, writes } = ports(map, { needs, opportunities });
    const result = await capabilityPromotionHolds(p);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('1 prepared');
    expect(result.detail).toMatch(/pending 1 promotion/);
    expect(writes).toEqual([]);
  });

  it('fails when there is no approved program to read', async () => {
    const result = await capabilityPromotionHolds(ports(null).p);
    expect(result.ok).toBe(false);
  });

  it('fails when a promoted requirement has vanished from the map', async () => {
    const map = { requirements: [requirement('A')] } as unknown as RequirementMap;
    const result = await capabilityPromotionHolds(ports(map, { promotedHere: ['GONE'] }).p);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('GONE');
  });
});
