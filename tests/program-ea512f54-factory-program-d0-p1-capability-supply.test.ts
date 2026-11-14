/**
 * GOV-22-1 repair: the supplier link has a producer.
 *
 * Production program maps are decomposed from the source and name the files a requirement changes,
 * never a cash capability id in `outputs`, so promotion saw no supplier at all. A requirement now
 * supplies a cash capability when a file it changes or cites lies inside the code that answers that
 * capability, read from the requirement's own rows. These tests use maps shaped as production writes
 * them (outputs: []), and keep the owner table in step with the vocabulary and the files on disk.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementReading } from '../server/domain/factoryProgram.ts';
import type { CashNeed, CashOpportunity } from '../server/domain/types.ts';
import { CAPABILITIES, DELIVERABLE_CAPABILITIES } from '../server/services/cash/capabilities.ts';
import {
  CAPABILITY_EVENT_KINDS,
  CAPABILITY_OWNER_PATHS,
  capabilitySupply,
  pathWithin,
  reconcilePreparedCapabilities,
  suppliedCapabilities,
  type CapabilityPorts,
} from '../server/services/goals/capabilityPromotion.ts';

/** A requirement as the decomposer writes it: no capability ids anywhere, only paths. */
function decomposed(key: string, over: Partial<ProgramRequirement> = {}): ProgramRequirement {
  return { key, outputs: [], dependsOn: [], interactsWith: [], paths: [], existing: null, ...over } as unknown as ProgramRequirement;
}

const need = (opportunityId: string, capability: string) =>
  ({ id: `need-${opportunityId}`, projectId: 'prj', opportunityId, requestKey: `capability:${opportunityId}:${capability}`, state: 'OPEN' }) as unknown as CashNeed;
const opportunity = (id: string, priceCents: number | null, projectId = 'prj') => ({ id, projectId, priceCents }) as unknown as CashOpportunity;
const reading = (key: string, status: RequirementReading['status']) => ({ key, status }) as RequirementReading;

describe('a requirement supplies the capabilities its own paths answer', () => {
  it('reads the link from paths and existing paths, with no capability id in outputs', () => {
    expect([...suppliedCapabilities(decomposed('a', { paths: ['server/services/cash/providers/payments.ts'] }))]).toEqual(['TAKE_A_PAYMENT']);
    expect([...suppliedCapabilities(decomposed('b', { existing: { paths: ['server/services/cash/providers/stripe.ts'], evidence: 'e' } }))].sort()).toEqual(['ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT']);
    expect([...suppliedCapabilities(decomposed('c', { paths: ['server/services/fleet/capacity.ts'] }))]).toEqual(['RESEARCH_A_QUESTION']);
    expect(suppliedCapabilities(decomposed('d', { paths: ['server/services/cash/deliverables/render.ts'] })).has('PRODUCE_SPREADSHEET')).toBe(true);
  });

  it('a broad path is not the supplier of everything under it, and shared plumbing supplies nothing', () => {
    expect(suppliedCapabilities(decomposed('wide', { paths: ['server/services/cash/**'] })).size).toBe(0);
    expect(suppliedCapabilities(decomposed('wide2', { paths: ['server/**'] })).size).toBe(0);
    expect(suppliedCapabilities(decomposed('plumbing', { paths: ['server/services/cash/effects.ts'] })).size).toBe(0);
    expect(suppliedCapabilities(decomposed('prose', { behavior: 'Take a payment from the buyer', paths: [] } as never)).size).toBe(0);
  });

  it('matches a path inside an owner, never a sibling that shares a prefix', () => {
    expect(pathWithin('server/services/fleet/capacity.ts', 'server/services/fleet/**')).toBe(true);
    expect(pathWithin('server/services/fleet/**', 'server/services/fleet/**')).toBe(true);
    expect(pathWithin('server/services/fleetView.ts', 'server/services/fleet/**')).toBe(false);
    expect(pathWithin('server/services/cash/**', 'server/services/cash/invoicing.ts')).toBe(false);
    expect(pathWithin('./server/services/cash/invoicing.ts', 'server/services/cash/invoicing.ts')).toBe(true);
  });

  it('still honours an explicit output', () => {
    expect([...suppliedCapabilities(decomposed('o', { outputs: ['capability:SEND_A_MESSAGE'] }))]).toEqual(['SEND_A_MESSAGE']);
  });

  it('reports how many requirements of a map supply which capability', () => {
    const supply = capabilitySupply({
      requirements: [
        decomposed('pay', { paths: ['server/services/cash/providers/payments.ts'] }),
        decomposed('fleet', { paths: ['server/services/fleet/capacity.ts'] }),
        decomposed('none', { paths: ['server/services/goals/priority.ts'] }),
      ],
    });
    expect(supply.requirementsSupplying).toBe(2);
    expect(supply.byCapability).toEqual({ TAKE_A_PAYMENT: ['pay'], RESEARCH_A_QUESTION: ['fleet'] });
  });
});

describe('the owner table is in step with the vocabulary and the repository', () => {
  it('names only capabilities Brain has a word for, and only files that exist', () => {
    const known = new Set([...CAPABILITIES, ...DELIVERABLE_CAPABILITIES].map((c) => c.id));
    for (const [id, owners] of Object.entries(CAPABILITY_OWNER_PATHS)) {
      expect(known.has(id), id).toBe(true);
      expect(owners.length, id).toBeGreaterThan(0);
      for (const owner of owners) {
        const root = owner.includes('*') ? owner.slice(0, owner.indexOf('*')).replace(/\/+$/, '') : owner;
        expect(existsSync(root), `${id}: ${owner}`).toBe(true);
      }
    }
  });

  it('every capability with a reader has an owner', () => {
    for (const c of [...CAPABILITIES, ...DELIVERABLE_CAPABILITIES]) {
      if (c.read === null) continue;
      if (c.id === 'ISSUE_A_REFUND') continue; // answered only by the shared effect registry, which is plumbing
      expect(CAPABILITY_OWNER_PATHS[c.id], c.id).toBeDefined();
    }
  });
});

describe('promotion fires on a production-shaped map', () => {
  it('promotes a prepared requirement whose path answers the capability two valued transactions are blocked on', async () => {
    const map: RequirementMap = {
      requirements: [
        decomposed('PAY-1', { prepared: true, paths: ['server/services/cash/providers/payments.ts'] }),
        decomposed('OTHER-1', { prepared: true, paths: ['server/services/goals/priority.ts'] }),
      ],
      context: [],
    };
    const proposed: RequirementMap[] = [];
    const recorded: { kind: string; detail: Record<string, unknown> }[] = [];
    const ports: CapabilityPorts = {
      async programs() {
        return [{ id: 'fpg', map, readings: [reading('PAY-1', 'MAPPED'), reading('OTHER-1', 'MAPPED')], edgesOf: (r) => r.dependsOn }];
      },
      async openNeeds() {
        return [need('o1', 'TAKE_A_PAYMENT'), need('o2', 'TAKE_A_PAYMENT')];
      },
      async opportunity(id) {
        return [opportunity('o1', 5000), opportunity('o2', 7000, 'prj2')].find((o) => o.id === id) ?? null;
      },
      async promotedHere() {
        return new Set();
      },
      async proposeMap(input) {
        proposed.push(input.map);
        return { version: 3 };
      },
      async record(kind, detail) {
        recorded.push({ kind, detail });
      },
      async parallelWorkers() {
        return null;
      },
    };
    const report = await reconcilePreparedCapabilities(ports);
    expect(report).toEqual([{ programId: 'fpg', promoted: ['PAY-1'], demoted: [], refused: false }]);
    expect(proposed[0]!.requirements.find((r) => r.key === 'PAY-1')!.prepared).toBeUndefined();
    expect(proposed[0]!.requirements.find((r) => r.key === 'OTHER-1')!.prepared).toBe(true);
    expect(recorded).toEqual([expect.objectContaining({ kind: CAPABILITY_EVENT_KINDS.promoted, detail: expect.objectContaining({ requirement: 'PAY-1' }) })]);
  });
});
